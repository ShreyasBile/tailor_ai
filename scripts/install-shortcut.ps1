<#
.SYNOPSIS
    Creates the "TailorAI" desktop shortcut that starts the whole project.

.DESCRIPTION
    The shortcut runs scripts\start-tailorai.ps1 from wherever this repo lives,
    so re-run this after moving or copying the repo:

        powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = [Environment]::GetFolderPath("Desktop")   # follows OneDrive redirection
$Path = Join-Path $Desktop "TailorAI.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Path)
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\scripts\start-tailorai.ps1`""
$lnk.WorkingDirectory = $Root
$lnk.IconLocation = "$Root\scripts\tailorai.ico,0"
$lnk.Description = "Start TailorAI: database, services and the web app (opens http://localhost:3001)"
$lnk.WindowStyle = 1
$lnk.Save()

Write-Host "Created $Path" -ForegroundColor Green
