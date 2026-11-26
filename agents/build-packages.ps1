# Builds the agent packages the backend serves to the installer scripts.
#
#   pwsh agents/build-packages.ps1 [-OutDir <folder>] [-Version 1.0.0]
#
# Output, matching the backend's expected layout:
#   <OutDir>/windows/adgrmm-agent-windows.zip
#   <OutDir>/windows/version.json
#   <OutDir>/linux/adgrmm-agent-linux-x64.tar.gz
#   <OutDir>/linux/version.json
#
# version.json is how the backend knows what it can offer agents for self-update. It holds the
# package's hash, so a package and version file that do not belong together are never offered.
param(
    [string]$OutDir = (Join-Path $PSScriptRoot 'dist/agent-packages'),
    [string]$Version = '1.3.61'
)

$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

# The updater compares this numerically, so anything else could never be offered.
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3, not '$Version'." }

$work = Join-Path $PSScriptRoot 'dist/work'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
New-Item -ItemType Directory -Force -Path $work, (Join-Path $OutDir 'windows'), (Join-Path $OutDir 'linux') | Out-Null

function Publish-Agent([string]$Project, [string]$Runtime, [string]$Target) {
    & dotnet publish $Project -c Release -r $Runtime --self-contained true "-p:Version=$Version" -o $Target
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed for $Project" }
}

# The same version the package was built with, written last and in one step.
function Write-VersionFile([string]$Package) {
    $hash = (Get-FileHash $Package -Algorithm SHA256).Hash.ToLowerInvariant()
    $target = Join-Path (Split-Path $Package) 'version.json'
    $json = @{ version = $Version; sha256 = $hash } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$target.tmp", $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -Force "$target.tmp" $target
}

# Windows
$win = Join-Path $work 'windows'
Publish-Agent (Join-Path $PSScriptRoot 'windows/AdgRmm.Agent/AdgRmm.Agent.csproj') 'win-x64' $win
Copy-Item (Join-Path $PSScriptRoot 'windows/AdgRmm.Agent/scripts/uninstall.ps1') $win
Get-ChildItem $win -Filter *.pdb | Remove-Item
Get-ChildItem $win -Filter 'appsettings*.json' | Remove-Item
$winZip = Join-Path $OutDir 'windows/adgrmm-agent-windows.zip'
Remove-Item -ErrorAction SilentlyContinue $winZip
Compress-Archive -Path (Join-Path $win '*') -DestinationPath $winZip
Write-VersionFile $winZip

# Linux
$linux = Join-Path $work 'linux'
Publish-Agent (Join-Path $PSScriptRoot 'linux/AdgRmm.Agent.Linux/AdgRmm.Agent.Linux.csproj') 'linux-x64' $linux
Copy-Item (Join-Path $PSScriptRoot 'linux/scripts/uninstall.sh') $linux
# The same package carries a second program built for musl (Alpine and others). The installer, and the agent when it updates itself,
# keep the one that runs on that machine under the name the service starts, so the package, its hash and the release slots stay one.
$linuxMusl = Join-Path $work 'linux-musl'
Publish-Agent (Join-Path $PSScriptRoot 'linux/AdgRmm.Agent.Linux/AdgRmm.Agent.Linux.csproj') 'linux-musl-x64' $linuxMusl
Copy-Item (Join-Path $linuxMusl 'adgrmm-agent') (Join-Path $linux 'adgrmm-agent-musl')
Get-ChildItem $linux -Filter *.pdb | Remove-Item
$linuxTar = Join-Path $OutDir 'linux/adgrmm-agent-linux-x64.tar.gz'
Push-Location $linux
& tar -czf package.tar.gz adgrmm-agent adgrmm-agent-musl uninstall.sh
$tarExit = $LASTEXITCODE
Pop-Location
if ($tarExit -ne 0) { throw "tar failed" }
Move-Item -Force (Join-Path $linux "package.tar.gz") $linuxTar
Write-VersionFile $linuxTar

Get-ChildItem -Recurse -File $OutDir | ForEach-Object {
    '{0}  {1:N0} bytes  sha256={2}' -f $_.Name, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
