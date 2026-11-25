# Applies a verified RemoteIQ agent update. Written by the agent to its data folder and run as
# SYSTEM, outside the service, because it has to stop that service. Also runs at boot while an
# update is unfinished, so an interrupted swap gets repaired. Keep this ASCII and Windows
# PowerShell 5.1 compatible. It never touches the data folder's config, so the device keeps its
# identity and enrollment.
param([string]$ParamsPath = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $ParamsPath) { $ParamsPath = Join-Path $PSScriptRoot 'apply-params.json' }

$p = Get-Content -LiteralPath $ParamsPath -Raw | ConvertFrom-Json
$InstallDir = [string]$p.installDir
$StateDir = [string]$p.stateDir
$Target = [string]$p.targetVersion
$ServiceName = [string]$p.serviceName
$TaskName = [string]$p.taskName
$ExeName = [string]$p.exeName
$HealthSeconds = [int]$p.healthSeconds

$StagingDir = $InstallDir + '.update'
$NewDir = Join-Path $StagingDir 'new'
$PrevDir = $InstallDir + '.prev'
$FailedDir = $InstallDir + '.failed'
$StartedPath = Join-Path $StateDir 'apply.started'
$OkPath = Join-Path $StateDir 'ok.txt'
$PendingPath = Join-Path $StateDir 'pending.txt'
$ResultPath = Join-Path $StateDir 'result.json'
$LogPath = Join-Path $StateDir 'apply.log'

function Write-Log([string]$Message) {
    $line = '[' + (Get-Date).ToUniversalTime().ToString('o') + '] ' + $Message
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch {}
}

function Write-Result([string]$Outcome, [string]$Detail) {
    $json = @{ version = $Target; outcome = $Outcome; detail = $Detail; atUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    $tmp = $ResultPath + '.tmp'
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $ResultPath -Force
    Write-Log ('Result: ' + $Outcome + ' ' + $Detail)
}

function Remove-Quietly([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force } catch { Write-Log ('Could not remove ' + $Path + ': ' + $_.Exception.Message) }
    }
}

function Remove-ApplyTask {
    # Removing the task does not end this running copy of it.
    try { & schtasks.exe /Delete /F /TN $TaskName 2>&1 | Out-Null } catch {}
}

function Stop-InstallProcesses {
    # Remote console helpers run from the install folder and would keep it locked.
    $prefix = $InstallDir.TrimEnd('\') + '\'
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | ForEach-Object {
        try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
    }
}

function Stop-Agent {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction Stop } catch { Write-Log ('Stop-Service: ' + $_.Exception.Message) }

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { break }
        Start-Sleep -Seconds 1
    }

    if ((Get-Service -Name $ServiceName).Status -ne 'Stopped') {
        Write-Log 'The service did not stop; ending its process.'
        try {
            $svc = Get-CimInstance Win32_Service -Filter ("Name='" + $ServiceName + "'")
            if ($svc -and $svc.ProcessId) { Stop-Process -Id $svc.ProcessId -Force -ErrorAction Stop }
        } catch { Write-Log ('Could not end the process: ' + $_.Exception.Message) }
    }

    Stop-InstallProcesses
}

function Move-Folder([string]$From, [string]$To) {
    # Antivirus or an exiting process can hold a file for a moment, so this retries.
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Move-Item -LiteralPath $From -Destination $To -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq 29) { throw }
            Stop-InstallProcesses
            Start-Sleep -Seconds 2
        }
    }
}

function Start-Agent {
    # After three crashes Windows stops restarting the service, so this asks explicitly.
    try { Start-Service -Name $ServiceName -ErrorAction Stop } catch { Write-Log ('Start-Service: ' + $_.Exception.Message) }
}

function Set-BundleExtractDir {
    # The agent is a single-file app that unpacks its native DLLs at start. Without this it unpacks them under SYSTEM's temp
    # folder, which can be C:\Windows\Temp; here it gets a folder only SYSTEM and Administrators can write to. The service
    # reads its Environment value at its next start. Never fails the update.
    # (Continue, so that icacls writing to stderr is not turned into an exception by Windows PowerShell 5.1.)
    $ErrorActionPreference = 'Continue'
    try {
        $dataDir = Split-Path -Parent $StateDir
        $bundleDir = Join-Path $dataDir 'dotnet-bundle'
        if (-not (Test-Path -LiteralPath $bundleDir)) { New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null }
        & icacls.exe $bundleDir /setowner '*S-1-5-32-544' /T /C 2>&1 | Out-Null
        & icacls.exe $bundleDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Log 'Could not restrict the bundle folder; leaving the service environment alone.'; return }
        $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $ServiceName
        $current = @()
        try { $current = @((Get-ItemProperty -LiteralPath $key -Name Environment -ErrorAction Stop).Environment) } catch {}
        $vars = @($current | Where-Object { $_ -and -not $_.StartsWith('DOTNET_BUNDLE_EXTRACT_BASE_DIR=', [StringComparison]::OrdinalIgnoreCase) })
        $vars += ('DOTNET_BUNDLE_EXTRACT_BASE_DIR=' + $bundleDir)
        New-ItemProperty -LiteralPath $key -Name Environment -PropertyType MultiString -Value ([string[]]$vars) -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-Log ('Could not set the bundle folder: ' + $_.Exception.Message)
    }
}

function Test-Confirmed {
    if (-not (Test-Path -LiteralPath $OkPath)) { return $false }
    try { return ((Get-Content -LiteralPath $OkPath -Raw).Trim() -eq $Target) } catch { return $false }
}

function Wait-Healthy {
    # The new agent writes the marker once it has reached the server with its token.
    $deadline = (Get-Date).AddSeconds($HealthSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Confirmed) {
            # A build that dies right after confirming is not healthy either.
            Start-Sleep -Seconds ([Math]::Min(30, [Math]::Max(1, [int]($HealthSeconds / 10))))
            if ((Get-Service -Name $ServiceName).Status -eq 'Running') { return $true }
            Write-Log 'The new version stopped after confirming.'
            return $false
        }
        if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { Start-Agent }
        Start-Sleep -Seconds 2
    }
    Write-Log 'The new version did not confirm in time.'
    return $false
}

function Finish {
    Remove-Quietly $StagingDir
    Remove-Quietly $PrevDir
    Remove-Quietly $FailedDir
    Remove-Quietly $PendingPath
    Remove-Quietly $OkPath
    Remove-Quietly $StartedPath
    Remove-ApplyTask
}

function Restore-Previous([string]$Why) {
    Write-Log ('Rolling back: ' + $Why)
    Stop-Agent

    try {
        if (Test-Path -LiteralPath $PrevDir) {
            Remove-Quietly $FailedDir
            if (Test-Path -LiteralPath $InstallDir) { Move-Folder $InstallDir $FailedDir }
            Move-Folder $PrevDir $InstallDir
        }
    } catch {
        # The boot task and the started marker stay, so the next restart tries this again.
        Write-Result 'rollback_failed' ('Could not restore the previous version: ' + $_.Exception.Message)
        Start-Agent
        return
    }

    # The service may need a moment after being stopped, so this tries a few times.
    for ($i = 0; $i -lt 10; $i++) {
        Start-Agent
        Start-Sleep -Seconds 3
        if ((Get-Service -Name $ServiceName).Status -eq 'Running') {
            Write-Result 'rolled_back' $Why
            Finish
            return
        }
    }
    Write-Result 'rollback_failed' 'The previous version was restored but the service did not start.'
}

try {
    Set-Location -LiteralPath $env:SystemRoot

    if (Test-Path -LiteralPath $StartedPath) {
        # This run was started at boot, and the one before it never finished.
        Write-Log 'Found an unfinished update.'
        if ((Test-Confirmed) -and (Test-Path -LiteralPath (Join-Path $InstallDir $ExeName))) {
            Start-Agent
            Write-Result 'succeeded' 'Finished after a restart.'
            Finish
        } elseif (Test-Path -LiteralPath $PrevDir) {
            Restore-Previous 'The update was interrupted by a restart.'
        } else {
            Start-Agent
            Write-Result 'failed' 'The update was interrupted before anything changed.'
            Finish
        }
        exit 0
    }

    if (-not (Test-Path -LiteralPath (Join-Path $NewDir $ExeName))) {
        # Nothing to apply: a boot run after a finished update whose task could not be removed.
        Remove-ApplyTask
        exit 0
    }

    # The running install is known good, so a previous version left behind is no longer needed.
    Remove-Quietly $PrevDir
    Remove-Quietly $FailedDir
    Remove-Quietly $OkPath

    Set-Content -LiteralPath $StartedPath -Value $Target -Encoding Ascii
    Write-Log ('Applying version ' + $Target)

    Stop-Agent
    Set-BundleExtractDir

    try {
        Move-Folder $InstallDir $PrevDir
    } catch {
        # Nothing has changed yet, except that the service was stopped.
        Start-Agent
        Write-Result 'failed' ('The install folder is in use: ' + $_.Exception.Message)
        Finish
        exit 0
    }

    try {
        Move-Folder $NewDir $InstallDir
    } catch {
        Restore-Previous ('Could not put the new version in place: ' + $_.Exception.Message)
        exit 0
    }

    Start-Agent

    if (Wait-Healthy) {
        Write-Result 'succeeded' ''
        Finish
    } else {
        Restore-Previous 'The new version did not come up.'
    }
    exit 0
} catch {
    Write-Log ('Unexpected error: ' + $_.Exception.Message)
    try {
        if (Test-Path -LiteralPath $PrevDir) { Restore-Previous ('Unexpected error: ' + $_.Exception.Message) } else { Start-Agent }
    } catch {
        Start-Agent
    }
    exit 1
}
