# Removes the RemoteIQ agent from this machine, including its identity and logs.
# Run from an elevated PowerShell prompt.
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this from an elevated PowerShell prompt.'
}

$service = Get-Service -Name 'RemoteIQAgent' -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name 'RemoteIQAgent' -Force }
    & sc.exe delete RemoteIQAgent | Out-Null
}

# An unfinished update's boot task must not outlive the agent. Usually there is none to delete.
$ErrorActionPreference = 'Continue'
& schtasks.exe /Delete /F /TN 'RemoteIQ Agent Update' 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'

# This script lives in the install folder, so it moves out of it before deleting.
Set-Location $env:SystemRoot
$installDir = Join-Path $env:ProgramFiles 'RemoteIQ'
$dataDir = Join-Path $env:ProgramData 'RemoteIQ'
foreach ($dir in @($installDir, $dataDir)) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}

Write-Host 'RemoteIQ agent removed.'
