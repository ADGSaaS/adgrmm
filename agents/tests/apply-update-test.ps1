# Runs the real apply-update.ps1 against temporary folders. Service and task commands are replaced
# by functions of the same name, which PowerShell prefers over cmdlets, so nothing on this machine
# changes. It proves the file swap and every rollback path, not Windows service behaviour.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File agents/tests/apply-update-test.ps1
param([string]$Scenario = '', [string]$Root = '')

$script = Join-Path $PSScriptRoot '..\windows\RemoteIQ.Agent\scripts\apply-update.ps1'

function New-Sandbox {
    $dir = Join-Path $env:TEMP ('riq-apply-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'Agent'), (Join-Path $dir 'Agent.update\new'), (Join-Path $dir 'state') | Out-Null
    Set-Content (Join-Path $dir 'Agent\RemoteIQ.Agent.exe') 'old'
    Set-Content (Join-Path $dir 'Agent.update\new\RemoteIQ.Agent.exe') 'new'
    Set-Content (Join-Path $dir 'state\config-like.json') 'identity'
    Set-Content (Join-Path $dir 'state\pending.txt') '1.3.0'
    @{ installDir = (Join-Path $dir 'Agent'); stateDir = (Join-Path $dir 'state'); targetVersion = '1.3.0';
       serviceName = 'Fake'; taskName = 'Fake'; exeName = 'RemoteIQ.Agent.exe'; healthSeconds = 4 } |
        ConvertTo-Json | Set-Content (Join-Path $dir 'params.json')
    return $dir
}

if ($Scenario) {
    # Child mode: stubs first, then the real script, which exits this process when it is done.
    $global:running = $false
    $Sandbox = $Root

    function schtasks.exe { Add-Content (Join-Path $Sandbox 'calls.txt') ('schtasks ' + ($args -join ' ')) }
    function Get-Service { param($Name) [pscustomobject]@{ Status = $(if ($global:running) { 'Running' } else { 'Stopped' }) } }
    function Stop-Service { param($Name, [switch]$Force)
        Add-Content (Join-Path $Sandbox 'calls.txt') 'stop'
        $global:running = $false
    }
    function Start-Service { param($Name)
        Add-Content (Join-Path $Sandbox 'calls.txt') 'start'
        $exe = (Get-Content (Join-Path $Sandbox 'Agent\RemoteIQ.Agent.exe') -ErrorAction SilentlyContinue | Select-Object -First 1)
        switch ($Scenario) {
            'good' { $global:running = $true; if ($exe -eq 'new') { Set-Content (Join-Path $Sandbox 'state\ok.txt') '1.3.0' } }
            'neverconfirms' { $global:running = ($exe -ne 'new') }
            'wrongversion' { $global:running = $true; if ($exe -eq 'new') { Set-Content (Join-Path $Sandbox 'state\ok.txt') '9.9.9' } }
            'diesafterconfirm' {
                if ($exe -eq 'new') {
                    Set-Content (Join-Path $Sandbox 'state\ok.txt') '1.3.0'
                    $global:running = $false
                } else { $global:running = $true }
            }
            'rollbackwontstart' { $global:running = $false }
            default { $global:running = $true }
        }
    }

    . $script -ParamsPath (Join-Path $Root 'params.json')
    exit 0
}

$failures = 0
function Assert-That([string]$Name, [bool]$Ok) {
    Write-Host (($(if ($Ok) { 'pass  ' } else { 'FAIL  ' })) + $Name)
    if (-not $Ok) { $script:failures++ }
}
function Run-Scenario([string]$Name, [string]$Dir) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Scenario $Name -Root $Dir *>&1 | Out-Null
}
function Installed([string]$Dir) { (Get-Content (Join-Path $Dir 'Agent\RemoteIQ.Agent.exe') -ErrorAction SilentlyContinue | Select-Object -First 1) }
function Outcome([string]$Dir) {
    $file = Join-Path $Dir 'state\result.json'
    if (Test-Path $file) { (Get-Content $file -Raw | ConvertFrom-Json).outcome } else { '' }
}
function Identity-Kept([string]$Dir) { (Get-Content (Join-Path $Dir 'state\config-like.json') | Select-Object -First 1) -eq 'identity' }

Write-Host ("PowerShell " + $PSVersionTable.PSVersion)

# A good update.
$d = New-Sandbox; Run-Scenario 'good' $d
Assert-That 'good: new version installed' ((Installed $d) -eq 'new')
Assert-That 'good: outcome succeeded' ((Outcome $d) -eq 'succeeded')
Assert-That 'good: previous version removed' (-not (Test-Path (Join-Path $d 'Agent.prev')))
Assert-That 'good: staging removed' (-not (Test-Path (Join-Path $d 'Agent.update')))
Assert-That 'good: markers removed' (-not (Test-Path (Join-Path $d 'state\apply.started')) -and -not (Test-Path (Join-Path $d 'state\pending.txt')) -and -not (Test-Path (Join-Path $d 'state\ok.txt')))
Assert-That 'good: identity kept' (Identity-Kept $d)
Assert-That 'good: boot task removed' ([bool]((Get-Content (Join-Path $d 'calls.txt')) -match 'schtasks /Delete'))
Remove-Item -Recurse -Force $d

# A build that never confirms.
$d = New-Sandbox; Run-Scenario 'neverconfirms' $d
Assert-That 'never confirms: previous version restored' ((Installed $d) -eq 'old')
Assert-That 'never confirms: outcome rolled_back' ((Outcome $d) -eq 'rolled_back')
Assert-That 'never confirms: failed build cleaned up' (-not (Test-Path (Join-Path $d 'Agent.failed')))
Assert-That 'never confirms: identity kept' (Identity-Kept $d)
Remove-Item -Recurse -Force $d

# A marker from another version does not count.
$d = New-Sandbox; Run-Scenario 'wrongversion' $d
Assert-That 'wrong marker: previous version restored' ((Installed $d) -eq 'old')
Assert-That 'wrong marker: outcome rolled_back' ((Outcome $d) -eq 'rolled_back')
Remove-Item -Recurse -Force $d

# A build that confirms and then dies.
$d = New-Sandbox; Run-Scenario 'diesafterconfirm' $d
Assert-That 'dies after confirming: previous version restored' ((Installed $d) -eq 'old')
Assert-That 'dies after confirming: outcome rolled_back' ((Outcome $d) -eq 'rolled_back')
Remove-Item -Recurse -Force $d

# Interrupted by a restart between the two moves, leaving no install folder at all.
$d = New-Sandbox
Rename-Item (Join-Path $d 'Agent') 'Agent.prev'
Set-Content (Join-Path $d 'state\apply.started') '1.3.0'
Run-Scenario 'boot' $d
Assert-That 'power cut mid swap: previous version restored' ((Installed $d) -eq 'old')
Assert-That 'power cut mid swap: outcome rolled_back' ((Outcome $d) -eq 'rolled_back')
Remove-Item -Recurse -Force $d

# Interrupted while the new version was still unconfirmed.
$d = New-Sandbox
Rename-Item (Join-Path $d 'Agent') 'Agent.prev'
Rename-Item (Join-Path $d 'Agent.update\new') 'x'; Move-Item (Join-Path $d 'Agent.update\x') (Join-Path $d 'Agent')
Set-Content (Join-Path $d 'state\apply.started') '1.3.0'
Run-Scenario 'boot' $d
Assert-That 'power cut while verifying: previous version restored' ((Installed $d) -eq 'old')
Remove-Item -Recurse -Force $d

# Interrupted after the new version had already confirmed.
$d = New-Sandbox
Rename-Item (Join-Path $d 'Agent') 'Agent.prev'
Rename-Item (Join-Path $d 'Agent.update\new') 'x'; Move-Item (Join-Path $d 'Agent.update\x') (Join-Path $d 'Agent')
Set-Content (Join-Path $d 'state\apply.started') '1.3.0'
Set-Content (Join-Path $d 'state\ok.txt') '1.3.0'
Run-Scenario 'boot' $d
Assert-That 'power cut after confirming: new version kept' ((Installed $d) -eq 'new')
Assert-That 'power cut after confirming: outcome succeeded' ((Outcome $d) -eq 'succeeded')
Remove-Item -Recurse -Force $d

# Interrupted before anything moved.
$d = New-Sandbox
Set-Content (Join-Path $d 'state\apply.started') '1.3.0'
Run-Scenario 'boot' $d
Assert-That 'power cut before moving: install untouched' ((Installed $d) -eq 'old')
Assert-That 'power cut before moving: outcome failed' ((Outcome $d) -eq 'failed')
Remove-Item -Recurse -Force $d

# A boot run with nothing to do.
$d = New-Sandbox
Remove-Item -Recurse -Force (Join-Path $d 'Agent.update')
Run-Scenario 'boot' $d
Assert-That 'nothing to do: install untouched' ((Installed $d) -eq 'old')
Assert-That 'nothing to do: no result written' ((Outcome $d) -eq '')
Assert-That 'nothing to do: leftover task removed' ([bool]((Get-Content (Join-Path $d 'calls.txt')) -match 'schtasks /Delete'))
Remove-Item -Recurse -Force $d

# A previous version that will not start either.
$d = New-Sandbox; Run-Scenario 'rollbackwontstart' $d
Assert-That 'rollback will not start: previous files restored' ((Installed $d) -eq 'old')
Assert-That 'rollback will not start: outcome rollback_failed' ((Outcome $d) -eq 'rollback_failed')
Assert-That 'rollback will not start: boot repair stays armed' (Test-Path (Join-Path $d 'state\apply.started'))
Remove-Item -Recurse -Force $d

if ($failures -eq 0) { Write-Host 'ALL PASSED'; exit 0 }
Write-Host ("$failures FAILED"); exit 1
