<#
.SYNOPSIS
    Starts TailorAI on Windows without Docker or WSL.
.DESCRIPTION
    Infrastructure runs natively:
      Postgres  - project-local cluster in .data\pg (installed PG17 binaries)
      Redis     - portable build under .data\bin (redis-server.exe)
      SeaweedFS - .data\bin\weed.exe, S3 API on :9000 (MinIO's free binaries
                  are no longer published)
    Then the four app processes start via scripts\run-stack.ps1 and the browser
    opens http://localhost:3001.
.PARAMETER Stop
    Stop the app processes, Redis, SeaweedFS and the project Postgres.
#>
param([switch]$Stop)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Bin = "$Root\.data\bin"
$PgBin = "C:\Program Files\PostgreSQL\17\bin"
$LogDir = "$Root\.data\logs"
New-Item -ItemType Directory -Force -Path $LogDir, "$Root\.data\redis", "$Root\.data\seaweed" | Out-Null

function Write-Step([string]$Msg) { Write-Host "`n> $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Green }
function Exit-Failed([string]$Msg) { Write-Host "`n  $Msg`n  Logs: $LogDir`n" -ForegroundColor Red; exit 1 }

function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$Port, [int]$TimeoutS = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutS)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

Get-Content "$Root\.env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#")) {
        $idx = $line.IndexOf("=")
        if ($idx -gt 0) {
            [Environment]::SetEnvironmentVariable($line.Substring(0, $idx).Trim(), $line.Substring($idx + 1).Trim(), "Process")
        }
    }
}

if ($Stop) {
    Write-Step "Stopping TailorAI"
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\run-stack.ps1" stop
    Get-Process redis-server, weed -ErrorAction SilentlyContinue | Stop-Process -Force
    & "$PgBin\pg_ctl.exe" -D "$Root\.data\pg" stop -m fast | Out-Null
    Write-Ok "Stopped. Data is kept in .data."
    exit 0
}

Write-Host "`n  TailorAI - Body Intelligence (Windows)`n" -ForegroundColor White

# -- Postgres (project-local cluster in .data\pg) -------------------------------
Write-Step "Postgres"
$PgPort = [int]$env:POSTGRES_PORT
if (-not (Test-Port $PgPort)) {
    # Start-Process, not a direct call: pg_ctl's server inherits our stdout and
    # a piped caller would otherwise wait forever.
    Start-Process -FilePath "$PgBin\pg_ctl.exe" -WindowStyle Hidden `
        -ArgumentList "-D `"$Root\.data\pg`" -o `"-p $PgPort`" -l `"$LogDir\postgres.log`" start"
    if (-not (Wait-Port $PgPort 30)) { Exit-Failed "Postgres did not start - see .data\logs\postgres.log" }
}
Write-Ok "up on $PgPort"

# -- Redis ---------------------------------------------------------------------
Write-Step "Redis"
if (-not (Test-Port 6379)) {
    $redis = Get-ChildItem $Bin -Recurse -Filter redis-server.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $redis) { Exit-Failed "redis-server.exe not found under $Bin" }
    Start-Process -FilePath $redis.FullName -WorkingDirectory "$Root\.data\redis" -WindowStyle Hidden `
        -ArgumentList "--port 6379 --bind 127.0.0.1 --dir . --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction --logfile redis.log"
    if (-not (Wait-Port 6379 20)) { Exit-Failed "Redis did not start - see .data\redis\redis.log" }
}
Write-Ok "up on 6379"

# -- SeaweedFS (S3 on :9000) ---------------------------------------------------
Write-Step "Object storage (SeaweedFS S3)"
if (-not (Test-Port 9000)) {
    $weed = "$Bin\weed.exe"
    if (-not (Test-Path $weed)) { Exit-Failed "weed.exe not found at $weed" }
    $s3conf = "$Bin\s3.json"
    @{ identities = @(@{
        name = "tailorai"
        credentials = @(@{ accessKey = $env:S3_ACCESS_KEY_ID; secretKey = $env:S3_SECRET_ACCESS_KEY })
        actions = @("Admin", "Read", "Write", "List", "Tagging")
    }) } | ConvertTo-Json -Depth 5 | Out-File $s3conf -Encoding ascii
    # cmd does the log redirection (see run-stack.ps1: -Redirect* makes the
    # child inherit our stdout, so a piped caller would never return).
    # Storage listens on this PC only, unless PHONE_MODE=true in .env: a phone
    # on the same Wi-Fi then loads the 3D body straight from it (S3_ENDPOINT
    # must then be this PC's Wi-Fi address too — see RUNBOOK).
    $bind = if ($env:PHONE_MODE -eq "true") { "0.0.0.0" } else { "127.0.0.1" }
    $line = "`"$weed`" server -dir=. -ip=127.0.0.1 -ip.bind=$bind -master.port=9333 -volume.port=8085 -filer.port=8888 -s3 -s3.port=9000 -s3.config=`"$s3conf`" > `"$LogDir\seaweed.out.log`" 2> `"$LogDir\seaweed.err.log`""
    Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", "`"$line`"") `
        -WorkingDirectory "$Root\.data\seaweed" -WindowStyle Hidden
    if (-not (Wait-Port 9000 60)) { Exit-Failed "SeaweedFS S3 did not start - see .data\logs\seaweed.err.log" }
}
& node "$Root\scripts\ensure-bucket.mjs"
if ($LASTEXITCODE -ne 0) { Exit-Failed "Could not create the storage bucket." }
Write-Ok "up on 9000"

# -- App services ----------------------------------------------------------------
Write-Step "App services"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\run-stack.ps1" start
if ($LASTEXITCODE -ne 0) { Exit-Failed "A service failed to start." }

Start-Process "http://localhost:3001"
Write-Ok "TailorAI is running at http://localhost:3001"
Write-Host "  Stop with: powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 -Stop`n" -ForegroundColor Gray
