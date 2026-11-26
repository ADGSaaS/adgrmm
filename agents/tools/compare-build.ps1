# Publishes the Windows agent without bundling and lists a hash for every file, so two machines can be compared.
param([string]$Repo, [string]$Out)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $Out 'unbundled'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $dest
& dotnet publish (Join-Path $Repo 'agents/windows/AdgRmm.Agent/AdgRmm.Agent.csproj') -c Release -r win-x64 --self-contained true `
    -p:Version=1.3.28 -p:PublishSingleFile=false -p:IncludeNativeLibrariesForSelfExtract=false -p:IncludeAllContentForSelfExtract=false -o $dest | Select-Object -Last 2
Get-ChildItem $dest -Recurse -File | Where-Object { $_.Extension -ne '.pdb' -and $_.FullName -notmatch 'capture-helper' } | ForEach-Object {
    '{0} {1} {2}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.Length, [IO.Path]::GetRelativePath((Resolve-Path $dest).Path, $_.FullName).Replace('\', '/')
} | Sort-Object { $_.Split(' ', 3)[2] } | Set-Content -Encoding utf8 (Join-Path $Out 'unbundled-hashes.txt')
& dotnet --version | Set-Content -Encoding utf8 (Join-Path $Out 'sdk.txt')
Get-ChildItem "$env:USERPROFILE/.nuget/packages/microsoft.netcore.app.runtime.win-x64" -ErrorAction SilentlyContinue | ForEach-Object { "runtime pack $($_.Name)" } | Add-Content (Join-Path $Out 'sdk.txt')
