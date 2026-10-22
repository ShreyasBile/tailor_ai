<#
.SYNOPSIS
    Downloads model weights for the reconstruction service.

.DESCRIPTION
    Weights are never committed. They land in $env:WEIGHTS_DIR (default
    <repo>\.data\weights) — deliberately on D:, because C: has limited
    free space and the full set is several GB.

    Only commercially-licensed models are downloaded. Research-tier models
    (PSHuman, LHM, SIFU) are intentionally absent: they are SMPL-derived and
    blocked in production builds by the licence gate, and they need 24-40 GB
    of VRAM regardless. See docs/01-ai-pipeline.md.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\download-weights.ps1
#>

param(
    [string]$WeightsDir = $(if ($env:WEIGHTS_DIR) { $env:WEIGHTS_DIR } else { "$(Split-Path -Parent $PSScriptRoot)\.data\weights" }),
    [switch]$SkipBody,
    [switch]$SkipSegmentation
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  TailorAI weight download" -ForegroundColor Cyan
Write-Host "  ------------------------"
Write-Host "  target: $WeightsDir"
Write-Host ""

New-Item -ItemType Directory -Force -Path $WeightsDir | Out-Null

$drive = (Get-Item $WeightsDir).PSDrive
$freeGb = [math]::Round($drive.Free / 1GB, 1)
Write-Host "  free space on $($drive.Name): $freeGb GB"
if ($freeGb -lt 12) {
    Write-Warning "Less than 12 GB free. The full weight set needs roughly 8 GB."
}

# huggingface-cli ships with the `huggingface_hub` package and handles resume,
# which matters for multi-GB downloads on a home connection.
$venvPython = "$(Split-Path -Parent $PSScriptRoot)\services\reconstruction\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Python venv not found. Run: cd services\reconstruction; python3 -m venv .venv"
}

Write-Host ""
Write-Host "  ensuring huggingface_hub is installed..." -ForegroundColor DarkGray
& $venvPython -m pip install --quiet --upgrade "huggingface_hub[cli]"

function Get-Model {
    param([string]$RepoId, [string]$LocalName, [string]$Licence)

    $target = Join-Path $WeightsDir $LocalName
    if (Test-Path (Join-Path $target "config.json")) {
        Write-Host "  [skip] $LocalName already present" -ForegroundColor DarkGray
        return
    }

    Write-Host ""
    Write-Host "  downloading $RepoId" -ForegroundColor Yellow
    Write-Host "  licence: $Licence"

    & $venvPython -m huggingface_hub.commands.huggingface_cli download `
        $RepoId --local-dir $target

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Download failed for $RepoId. Some repos require accepting terms on huggingface.co first."
    } else {
        Write-Host "  [ok] $LocalName" -ForegroundColor Green
    }
}

if (-not $SkipSegmentation) {
    Get-Model -RepoId "ZhengPeng7/BiRefNet" -LocalName "birefnet" -Licence "MIT (commercial OK)"
}

if (-not $SkipBody) {
    Get-Model -RepoId "facebook/sam-3d-body-vith" -LocalName "sam-3d-body-vith" `
        -Licence "SAM License (commercial OK)"
}

Write-Host ""
Write-Host "  Done." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next:"
Write-Host "    1. Install the model extras (~2.5 GB):"
Write-Host "       cd services\reconstruction"
Write-Host "       .\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121"
Write-Host "       .\.venv\Scripts\python.exe -m pip install -r requirements-models.txt"
Write-Host ""
Write-Host "    2. Switch adapters in .env:"
Write-Host "       RECONSTRUCTION_ADAPTER=sam3dbody"
Write-Host "       SEGMENTATION_ADAPTER=birefnet"
Write-Host ""
Write-Host "    3. Wire Sam3DBodyAdapter._load_checkpoint and ._forward against the" -ForegroundColor Yellow
Write-Host "       facebookresearch/sam-3d-body inference API. Everything around those" -ForegroundColor Yellow
Write-Host "       two methods (fp16, VRAM guard, MHR extraction) is already complete." -ForegroundColor Yellow
Write-Host ""
