<#
.SYNOPSIS
    One-click launcher for the whole TailorAI project (the desktop shortcut runs this).

.DESCRIPTION
    1. Checks prerequisites and repairs the two things that break when the repo
       is copied between machines: the Python venv (it hard-links its base
       interpreter) and the npm workspace links.
    2. Starts Postgres, Redis and MinIO inside WSL2 (scripts/wsl-infra.sh).
    3. Rebuilds any package whose sources are newer than its build output.
    4. Applies database migrations; seeds the garment catalogue if it is empty.
    5. Starts reconstruction, API, orchestrator and web (scripts/run-stack.ps1),
       waiting for each to report healthy.
    6. Opens http://localhost:3001 and waits: Enter stops everything. Closing
       the window instead leaves TailorAI running in the background; run the
       shortcut again to get the stop prompt back.

.PARAMETER NoBrowser
    Don't open the browser.
.PARAMETER NoWait
    Return as soon as the stack is up (for scripts and tests); nothing is stopped.
.PARAMETER Stop
    Stop the app processes and the WSL infrastructure, then exit.
#>

param([switch]$NoBrowser, [switch]$NoWait, [switch]$Stop)

# Continue, not Stop: Windows PowerShell 5.1 turns any stderr line from a native
# tool (npm, prisma, wsl) into a terminating error under Stop. Every native call
# below checks $LASTEXITCODE explicitly instead.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
try { $Host.UI.RawUI.WindowTitle = "TailorAI" } catch { }

$AppUrl = "http://localhost:3001"
$Venv = "$Root\services\reconstruction\.venv"
$Py = "$Venv\Scripts\python.exe"

function Write-Step([string]$Msg) { Write-Host "`n> $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Green }
function Write-Info([string]$Msg) { Write-Host "  $Msg" -ForegroundColor Gray }

function Exit-Failed([string]$Msg) {
    Write-Host "`n  $Msg`n" -ForegroundColor Red
    Write-Host "  Logs: $Root\.data\logs" -ForegroundColor Gray
    if (-not $NoWait) { Read-Host "  Press Enter to close" | Out-Null }
    exit 1
}

function Invoke-Quiet {
    # Run a native command line via cmd so its output is captured (shown only
    # on failure) and stderr can't trip PowerShell's error handling.
    param([string]$What, [string]$CommandLine, [string]$WorkDir = $Root)
    Push-Location $WorkDir
    $out = cmd /c "$CommandLine 2>&1"
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) {
        Write-Host ($out | Select-Object -Last 25 | Out-String) -ForegroundColor DarkGray
        Exit-Failed "$What failed (exit $code)."
    }
}

function Import-DotEnv([string]$Path) {
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $idx = $line.IndexOf("=")
            if ($idx -gt 0) {
                [Environment]::SetEnvironmentVariable($line.Substring(0, $idx).Trim(), $line.Substring($idx + 1).Trim(), "Process")
            }
        }
    }
}

function Get-Newest([string[]]$Paths) {
    # Newest LastWriteTime among the files under $Paths (dirs or files).
    $newest = [datetime]::MinValue
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        $items = if ((Get-Item $p).PSIsContainer) { Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue } else { Get-Item $p }
        foreach ($i in $items) { if ($i.LastWriteTime -gt $newest) { $newest = $i.LastWriteTime } }
    }
    return $newest
}

$StampDir = "$Root\.data\build"
New-Item -ItemType Directory -Force -Path $StampDir | Out-Null

function Test-Stale([string]$Name, [string[]]$Sources, [string]$Output) {
    # Judged against a stamp written only after a *successful* build: a failed
    # `next build` still leaves a fresh .next\BUILD_ID behind, and trusting
    # that output's timestamp skipped the rebuild and started a broken site.
    $stamp = "$StampDir\$Name.ok"
    if (-not (Test-Path $Output) -or -not (Test-Path $stamp)) { return $true }
    return (Get-Newest $Sources) -gt (Get-Item $stamp).LastWriteTime
}

function Set-Stamp([string]$Name) { Get-Date -Format o | Out-File "$StampDir\$Name.ok" -Encoding ascii }

function Stop-All {
    Write-Step "Stopping TailorAI"
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\run-stack.ps1" stop
    & wsl.exe -u root -- bash scripts/wsl-infra.sh down | Out-Null
    Write-Ok "Stopped. Your data is kept in .data and the WSL database."
}

Write-Host ""
Write-Host "  TailorAI - Body Intelligence" -ForegroundColor White
Write-Host "  ----------------------------" -ForegroundColor DarkGray

if ($Stop) { Stop-All; exit 0 }

# -- 1. prerequisites ---------------------------------------------------------

Write-Step "Checking prerequisites"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Exit-Failed "Node.js was not found. Install Node 20+ and try again." }
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Exit-Failed "WSL was not found. The database, queue and storage run inside WSL2 (see RUNBOOK.md section 3)." }
if (-not (Test-Path "$Root\.env")) {
    Copy-Item "$Root\.env.example" "$Root\.env"
    Write-Info "Created .env from .env.example - review it later."
}
Import-DotEnv "$Root\.env"

if (-not (Test-Path "$Root\node_modules\@tailorai\contracts")) {
    Write-Info "Installing npm dependencies (first run)..."
    Invoke-Quiet "npm install" "npm install --no-audit --no-fund"
}

# A venv copied from another machine points at an interpreter that isn't here.
cmd /c "`"$Py`" -c `"import fastapi, mediapipe`" >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Info "Setting up the Python environment (first run, a few minutes)..."
    if (Test-Path $Venv) { Rename-Item $Venv "$Venv.broken-$(Get-Date -Format yyyyMMddHHmmss)" }
    # mediapipe 0.10.21 ships wheels up to Python 3.12.
    $base = $null
    foreach ($v in "3.12", "3.11", "3.10") {
        cmd /c "py -$v -c `"import sys`" >nul 2>&1"
        if ($LASTEXITCODE -eq 0) { $base = $v; break }
    }
    if (-not $base) { Exit-Failed "Python 3.10-3.12 is required (mediapipe has no wheels for newer versions)." }
    Invoke-Quiet "Creating the venv" "py -$base -m venv `"$Venv`""
    Invoke-Quiet "Installing Python packages" "`"$Py`" -m pip install -q -r requirements.txt pytest pytest-asyncio ruff" "$Root\services\reconstruction"
    Invoke-Quiet "Installing mediapipe" "`"$Py`" -m pip install -q --no-deps -r requirements-scan.txt" "$Root\services\reconstruction"
}
Write-Ok "Node, WSL and Python environment ready"

# -- 2. infrastructure --------------------------------------------------------

Write-Step "Starting database, queue and storage (WSL)"
$infra = & wsl.exe -u root -- bash scripts/wsl-infra.sh up
$infraCode = $LASTEXITCODE
$infra | Where-Object { $_ -match "UP|DOWN|failed" } | ForEach-Object { Write-Info $_.Trim() }
if ($infraCode -ne 0 -or ($infra -match "DOWN")) {
    Exit-Failed "Infrastructure didn't start. Check that Ubuntu in WSL has Postgres, Redis and MinIO installed (RUNBOOK.md section 3)."
}

# -- 3. builds ----------------------------------------------------------------

Write-Step "Checking builds"
$contractsStale = (Test-Stale "contracts" @("packages\contracts\src", "packages\model-registry\src", "packages\model-registry\licenses.json") "packages\model-registry\dist\index.js") -or
                  (-not (Test-Path "packages\contracts\dist\index.js"))
$apiStale = $contractsStale -or (Test-Stale "api" @("apps\api\src", "apps\api\prisma\schema.prisma") "apps\api\dist\main.js")
$orchStale = $contractsStale -or (Test-Stale "orchestrator" @("services\orchestrator\src") "services\orchestrator\dist\index.js")
$webSources = @("apps\web\src", "apps\web\public", "apps\web\next.config.mjs", "apps\web\tailwind.config.ts")
$webStale = $contractsStale -or (Test-Stale "web" $webSources "apps\web\.next\BUILD_ID")

if ($contractsStale -or $apiStale -or $orchStale -or $webStale) {
    # Running services lock their build output on Windows (prisma's query
    # engine DLL, .next): stop them before rebuilding; step 5 restarts them.
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\run-stack.ps1" stop | Out-Null
}
if ($contractsStale) {
    Write-Info "Building shared contracts..."
    Invoke-Quiet "Contracts build" "npm run build -w @tailorai/contracts -w @tailorai/model-registry"
    Set-Stamp "contracts"
}
if ($apiStale) {
    Write-Info "Building API..."
    Invoke-Quiet "API build" "npm run build -w @tailorai/api"
    Set-Stamp "api"
}
if ($orchStale) {
    Write-Info "Building orchestrator..."
    Invoke-Quiet "Orchestrator build" "npm run build -w @tailorai/orchestrator"
    Set-Stamp "orchestrator"
}
if ($webStale) {
    Write-Info "Building web app (about a minute)..."
    # .env says NODE_ENV=development (the API's dev sign-in needs it), but
    # `next build` under that NODE_ENV bundles React's dev renderer and fails
    # prerendering /404. The web build is always a production build.
    Invoke-Quiet "Web build" "set `"NODE_ENV=production`" && npm run web:build"
    Set-Stamp "web"
}
Write-Ok "Builds up to date"

# -- 4. database --------------------------------------------------------------

Write-Step "Applying database migrations"
Invoke-Quiet "Database migration" "npx prisma migrate deploy" "$Root\apps\api"
Write-Ok "Database schema up to date"

# -- 5. services --------------------------------------------------------------

& powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\run-stack.ps1" start
if ($LASTEXITCODE -ne 0) { Exit-Failed "Some services didn't start (see above)." }

# First run on a fresh database: load the sample garment catalogue.
try {
    $garments = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:API_PORT)/v1/garments" -TimeoutSec 10
    if (@($garments).Count -eq 0) {
        Write-Info "Loading the sample garment catalogue..."
        Invoke-Quiet "Catalogue seed" "node prisma/seed.mjs" "$Root\apps\api"
    }
} catch {
    Write-Info "Couldn't check the garment catalogue: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "  TailorAI is running at $AppUrl" -ForegroundColor Green
Write-Host ""

if (-not $NoBrowser) { Start-Process $AppUrl }
if ($NoWait) { exit 0 }

Write-Host "  Press Enter to stop TailorAI." -ForegroundColor White
Write-Host "  (Or close this window to keep it running in the background.)" -ForegroundColor Gray
Read-Host | Out-Null
Stop-All
Start-Sleep -Seconds 2
