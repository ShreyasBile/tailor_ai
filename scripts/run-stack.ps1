<#
.SYNOPSIS
    Starts the four application processes with the shared environment loaded.

.DESCRIPTION
    Reads the repo-root .env and launches the reconstruction service, the API
    gateway, the orchestrator worker and the web app (if built), each with logs
    written to .data\logs\. Infrastructure (Postgres/Redis/MinIO) must already
    be running - either via `npm run infra:up` (Docker) or scripts\wsl-infra.sh
    (WSL). scripts\start-tailorai.ps1 does all of it in one go.

    Idempotent: a service that is already healthy is left alone, so running
    `start` twice never launches duplicates. Ports come from .env
    (RECON_PORT, API_PORT), not from constants.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-stack.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts\run-stack.ps1 stop
#>

param([ValidateSet("start", "stop", "status")][string]$Action = "start")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = "$Root\.data\logs"
$PidDir = "$Root\.data\pids"

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir | Out-Null

function Import-DotEnv {
    param([string]$Path)
    if (-not (Test-Path $Path)) { throw ".env not found at $Path" }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $idx = $line.IndexOf("=")
            if ($idx -gt 0) {
                $key = $line.Substring(0, $idx).Trim()
                $value = $line.Substring($idx + 1).Trim()
                [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
            }
        }
    }
}

Import-DotEnv "$Root\.env"

$ReconPort = if ($env:RECON_PORT) { $env:RECON_PORT } else { "8000" }
$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { "3000" }
$WebPort = "3001"

# name -> health URL, in start order.
$Health = [ordered]@{
    "reconstruction" = "http://127.0.0.1:$ReconPort/health"
    "api"            = "http://127.0.0.1:$ApiPort/v1/health"
    "orchestrator"   = $null   # no HTTP surface; judged by its process
    "web"            = "http://127.0.0.1:$WebPort/"
}

function Test-Healthy {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        return $r.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Get-RunningPid {
    # The pid from .data\pids if that process is still alive, else $null.
    param([string]$Name)
    $file = "$PidDir\$Name.pid"
    if (-not (Test-Path $file)) { return $null }
    $id = (Get-Content $file -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($id -and (Get-Process -Id $id.Trim() -ErrorAction SilentlyContinue)) { return [int]$id.Trim() }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
    return $null
}

function Test-PortBusy {
    param([string]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-Service2 {
    # NB: not `$Args` - that collides with PowerShell's automatic $args.
    param([string]$Name, [string]$Exe, [string[]]$ArgList, [string]$WorkDir)

    $out = "$LogDir\$Name.out.log"
    $err = "$LogDir\$Name.err.log"

    # cmd does the log redirection, and Start-Process runs it via shell-execute
    # (no -Redirect* switches). With -Redirect*, Start-Process creates the
    # child with handle inheritance on, so every service inherited this
    # script's stdout: anyone piping our output (`... | Out-String`, CI) then
    # waited forever, because the pipe never closed while the services ran.
    $line = "`"$Exe`" $($ArgList -join ' ') > `"$out`" 2> `"$err`""
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", "`"$line`"") `
        -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden

    # This pid is the cmd wrapper; Stop-Services kills its whole tree.
    $proc.Id | Out-File "$PidDir\$Name.pid" -Encoding ascii
    return $proc
}

function Wait-Healthy {
    # Poll until healthy, the process dies, or the timeout passes.
    param([string]$Name, [string]$Url, [System.Diagnostics.Process]$Proc, [int]$TimeoutS = 90)
    if (-not $Url) {
        # No HTTP surface: healthy means it is still alive after a grace period
        # (the orchestrator exits at once if it can't reach its dependencies).
        Start-Sleep -Seconds $TimeoutS
        return -not $Proc.HasExited
    }
    $deadline = (Get-Date).AddSeconds($TimeoutS)
    while ((Get-Date) -lt $deadline) {
        if ($Proc.HasExited) { return $false }
        if (Test-Healthy $Url) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Start-One {
    param([string]$Name, [string]$Exe, [string[]]$ArgList, [string]$WorkDir, [int]$TimeoutS = 90)
    $url = $Health[$Name]

    $existing = Get-RunningPid $Name
    if ($existing -and (-not $url -or (Test-Healthy $url))) {
        Write-Host ("  {0,-16} already running (pid {1})" -f $Name, $existing) -ForegroundColor DarkGreen
        return $true
    }
    if ($url) {
        $port = ([uri]$url).Port
        if (Test-PortBusy $port) {
            if (Test-Healthy $url) {
                Write-Host ("  {0,-16} already answering on port {1}" -f $Name, $port) -ForegroundColor DarkGreen
                return $true
            }
            Write-Host ("  {0,-16} FAILED - port {1} is used by another program" -f $Name, $port) -ForegroundColor Red
            return $false
        }
    }

    $proc = Start-Service2 -Name $Name -Exe $Exe -ArgList $ArgList -WorkDir $WorkDir
    Write-Host ("  {0,-16} starting (pid {1}) ..." -f $Name, $proc.Id) -NoNewline
    if (Wait-Healthy -Name $Name -Url $url -Proc $proc -TimeoutS $TimeoutS) {
        Write-Host " ready" -ForegroundColor Green
        return $true
    }
    Write-Host " FAILED - see .data\logs\$Name.err.log" -ForegroundColor Red
    return $false
}

function Stop-Services {
    Get-ChildItem "$PidDir\*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.BaseName
        $processId = "$(Get-Content $_.FullName -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
        if ($processId -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            # /T: the pid is a cmd wrapper; the service is its child.
            cmd /c "taskkill /PID $processId /T /F >nul 2>&1"
            Write-Host "  stopped $name (pid $processId)" -ForegroundColor Yellow
        } else {
            Write-Host "  $name was not running"
        }
        Remove-Item $_.FullName -Force
    }
}

function Show-Status {
    $allUp = $true
    foreach ($name in $Health.Keys) {
        $url = $Health[$name]
        $up = if ($url) { Test-Healthy $url } else { [bool](Get-RunningPid $name) }
        if ($up) {
            Write-Host ("  {0,-16} up" -f $name) -ForegroundColor Green
        } else {
            Write-Host ("  {0,-16} down" -f $name) -ForegroundColor Red
            $allUp = $false
        }
    }
    return $allUp
}

switch ($Action) {
    "stop" {
        Write-Host "`n  Stopping stack`n" -ForegroundColor Cyan
        Stop-Services
        Write-Host ""
    }

    "status" {
        Write-Host "`n  Stack status`n" -ForegroundColor Cyan
        $ok = Show-Status
        Write-Host ""
        if (-not $ok) { exit 1 }
    }

    "start" {
        Write-Host "`n  Starting TailorAI stack`n" -ForegroundColor Cyan

        # The worker needs its own concurrency setting; everything else comes
        # from the shared .env so all processes agree on adapters, tier and
        # storage.
        $env:WORKER_CONCURRENCY = "1"

        $ok = $true
        # Reconstruction first: the orchestrator refuses to start without it,
        # and its first boot loads the pose model (allow extra time).
        $ok = (Start-One -Name "reconstruction" `
            -Exe "$Root\services\reconstruction\.venv\Scripts\python.exe" `
            -ArgList @("-m", "app.main") `
            -WorkDir "$Root\services\reconstruction" -TimeoutS 180) -and $ok

        $ok = (Start-One -Name "api" -Exe "node" -ArgList @("dist/main.js") `
            -WorkDir "$Root\apps\api") -and $ok

        $ok = (Start-One -Name "orchestrator" -Exe "node" -ArgList @("dist/index.js") `
            -WorkDir "$Root\services\orchestrator" -TimeoutS 5) -and $ok

        # Web app (production build). Run `npm run web:build` after changes.
        if (Test-Path "$Root\apps\web\.next\BUILD_ID") {
            # `next start` serves a production build; .env's NODE_ENV=development
            # is for the API's dev sign-in and must not leak into the web server.
            $apiNodeEnv = $env:NODE_ENV
            $env:NODE_ENV = "production"
            $ok = (Start-One -Name "web" -Exe "node" `
                -ArgList @("`"$Root\node_modules\next\dist\bin\next`"", "start", "-p", $WebPort) `
                -WorkDir "$Root\apps\web") -and $ok
            $env:NODE_ENV = $apiNodeEnv
        } else {
            Write-Host "  web              not built - run: npm run web:build" -ForegroundColor Yellow
            $ok = $false
        }

        Write-Host "`n  Logs: $LogDir`n"
        if (-not $ok) { exit 1 }
    }
}
