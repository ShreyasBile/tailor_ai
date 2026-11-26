<#
.SYNOPSIS
    One-time setup of the on-device AI try-on engine (FASHN VTON v1.5).

.DESCRIPTION
    Needs an NVIDIA GPU with ~8 GB of VRAM. Downloads ~5 GB in total
    (CUDA PyTorch, the model code, ~2 GB of weights) into .data\vendor\,
    which git ignores. Re-running is safe: finished steps are skipped.

    FASHN VTON v1.5 — https://github.com/fashn-AI/fashn-vton-1.5
    Apache-2.0 code and weights.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-tryon-ai.ps1
#>

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = "$Root\.data\vendor"
$Venv = "$Vendor\venv-ai"
$Py = "$Venv\Scripts\python.exe"
$Repo = "$Vendor\fashn-vton-1.5"
$Weights = "$Vendor\fashn-weights"
New-Item -ItemType Directory -Force -Path $Vendor | Out-Null

function Step([string]$m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Run([string]$what, [string]$cmd) {
    cmd /c "$cmd 2>&1" | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { Write-Host "  $what failed." -ForegroundColor Red; exit 1 }
}

Step "Python environment (CUDA PyTorch)"
if (-not (Test-Path $Py)) { Run "venv" "py -3.11 -m venv `"$Venv`"" }
cmd /c "`"$Py`" -c `"import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)`" >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Run "PyTorch" "`"$Py`" -m pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu124"
}

Step "FASHN VTON v1.5 code"
if (-not (Test-Path "$Repo\pyproject.toml")) {
    Run "git clone" "git clone -q --depth 1 https://github.com/fashn-AI/fashn-vton-1.5.git `"$Repo`""
}
Run "install" "`"$Py`" -m pip install -q -e `"$Repo`" fastapi `"uvicorn[standard]`""

Step "Weights (~2 GB, from Hugging Face)"
if (-not (Test-Path "$Weights\model.safetensors")) {
    Run "download" "`"$Py`" `"$Repo\scripts\download_weights.py`" --weights-dir `"$Weights`""
}

Step "Check"
Run "check" "`"$Py`" -c `"import torch, fashn_vton; print('GPU:', torch.cuda.get_device_name(0))`""
Write-Host "`n  On-device AI try-on is installed. The launcher starts it automatically.`n" -ForegroundColor Green
