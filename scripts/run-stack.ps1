<#
.SYNOPSIS
    Starts the three application processes with the shared environment loaded.

.DESCRIPTION
    Reads D:\tailorai\.env and launches the reconstruction service, the API
    gateway and the orchestrator worker, each with logs written to
    .data\logs\. Infrastructure (Postgres/Redis/MinIO) must already be running
    — either via `npm run infra:up` (Docker) or scripts\wsl-infra.sh (WSL).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-stack.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts\run-stack.ps1 stop
#>

param([ValidateSet("start", "stop", "status")][string]$Action = "start")

$ErrorActionPreference = "Stop"
$Root = "D:\tailorai"
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

function Start-Service2 {
    # NB: not `$Args` — that collides with PowerShell's automatic $args.
    param([string]$Name, [string]$Exe, [string[]]$ArgList, [string]$WorkDir)

    $out = "$LogDir\$Name.out.log"
    $err = "$LogDir\$Name.err.log"

    $proc = Start-Process -FilePath $Exe -ArgumentList $ArgList `
        -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err

    $proc.Id | Out-File "$PidDir\$Name.pid" -Encoding ascii
    Write-Host ("  {0,-16} started (pid {1})" -f $Name, $proc.Id) -ForegroundColor Green
    return $proc
}

function Stop-Services {
    Get-ChildItem "$PidDir\*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.BaseName
        $processId = (Get-Content $_).Trim()
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "  stopped $name (pid $processId)" -ForegroundColor Yellow
        } catch {
            Write-Host "  $name (pid $processId) not running"
        }
        Remove-Item $_ -Force
    }
}

function Get-Status {
    param([string]$Name, [string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
        Write-Host ("  {0,-16} HTTP {1}" -f $Name, $r.StatusCode) -ForegroundColor Green
        return $true
    } catch {
        Write-Host ("  {0,-16} down" -f $Name) -ForegroundColor Red
        return $false
    }
}

switch ($Action) {
    "stop" {
        Write-Host "`n  Stopping stack`n" -ForegroundColor Cyan
        Stop-Services
        Write-Host ""
    }

    "status" {
        Write-Host "`n  Stack status`n" -ForegroundColor Cyan
        Get-Status "reconstruction" "http://127.0.0.1:8000/health" | Out-Null
        Get-Status "api" "http://127.0.0.1:3000/v1/health" | Out-Null
        Get-Status "api-ready" "http://127.0.0.1:3000/v1/health/ready" | Out-Null
        Write-Host ""
    }

    "start" {
        Write-Host "`n  Starting TailorAI stack`n" -ForegroundColor Cyan
        Import-DotEnv "$Root\.env"

        # The worker needs its own concurrency setting; everything else comes
        # from the shared .env so all three processes agree on adapters, tier
        # and storage.
        $env:WORKER_CONCURRENCY = "1"

        Start-Service2 -Name "reconstruction" `
            -Exe "$Root\services\reconstruction\.venv\Scripts\python.exe" `
            -ArgList @("-m", "app.main") `
            -WorkDir "$Root\services\reconstruction" | Out-Null

        Start-Sleep -Seconds 6

        Start-Service2 -Name "api" `
            -Exe "node" -ArgList @("dist/main.js") `
            -WorkDir "$Root\apps\api" | Out-Null

        Start-Sleep -Seconds 6

        Start-Service2 -Name "orchestrator" `
            -Exe "node" -ArgList @("dist/index.js") `
            -WorkDir "$Root\services\orchestrator" | Out-Null

        Start-Sleep -Seconds 5

        Write-Host "`n  Health`n" -ForegroundColor Cyan
        Get-Status "reconstruction" "http://127.0.0.1:8000/health" | Out-Null
        Get-Status "api" "http://127.0.0.1:3000/v1/health" | Out-Null

        Write-Host "`n  Logs: $LogDir`n"
    }
}
