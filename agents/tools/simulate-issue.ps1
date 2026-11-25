<#
  Makes a REAL, harmless, reversible problem on THIS computer so the automatic repair has something to find and fix. Run it in an
  administrator PowerShell on a test computer (your pilot PC), then submit a ticket from the tray app with the matching category.

    .\simulate-issue.ps1 -Problem spooler-stopped      # stops the Print Spooler           -> tray category: Printing
    .\simulate-issue.ps1 -Problem stuck-jobs           # leaves old files in the print queue -> tray category: Printing
    .\simulate-issue.ps1 -Problem teams-crashing       # writes two fake "Teams closed" events -> category: Software Issue, program: Microsoft Teams
    .\simulate-issue.ps1 -Problem spooler-stopped -Revert   # puts it back (the repair normally does this for you)

  What it changes, exactly:
    spooler-stopped  stops the Print Spooler service (the repair starts it again; -Revert starts it too).
    stuck-jobs       puts two dummy files (FP99901.SPL and FP99901.SHD, a few bytes each, dated two hours ago) in the print queue folder.
                     The repair deletes them; -Revert deletes them too. Windows may delete them itself when the spooler starts; the script says so.
    teams-crashing   adds two entries to the Application event log that look like Teams closing unexpectedly. Event log entries cannot be
                     removed, so they stay for the seven days the check looks back: another Teams ticket in that time would also find them.
                     (The repair closes Teams if it is running and clears Teams' cache folders, which Teams rebuilds. Save your work first.)
#>
#requires -RunAsAdministrator
param(
    [Parameter(Mandatory = $true)][ValidateSet('spooler-stopped', 'stuck-jobs', 'teams-crashing')][string]$Problem,
    [switch]$Revert
)
$ErrorActionPreference = 'Stop'
$queue = Join-Path $env:windir 'System32\spool\PRINTERS'
$files = @('FP99901.SPL', 'FP99901.SHD')

switch ($Problem) {
    'spooler-stopped' {
        if ($Revert) { Set-Service Spooler -StartupType Automatic; Start-Service Spooler; Write-Host 'The Print Spooler is running.'; break }
        Stop-Service Spooler -Force
        Write-Host ('The Print Spooler is now: ' + (Get-Service Spooler).Status + '. Submit a ticket from the tray: category Printing.')
    }
    'stuck-jobs' {
        if ($Revert) {
            Stop-Service Spooler -Force; foreach ($f in $files) { Remove-Item -LiteralPath (Join-Path $queue $f) -Force -ErrorAction SilentlyContinue }
            Start-Service Spooler; Write-Host 'The dummy files are gone and the Print Spooler is running.'; break
        }
        Stop-Service Spooler -Force
        foreach ($f in $files) {
            $p = Join-Path $queue $f
            [IO.File]::WriteAllBytes($p, [byte[]](1..16))
            (Get-Item -LiteralPath $p).LastWriteTime = (Get-Date).AddHours(-2)
        }
        Start-Service Spooler
        Start-Sleep -Seconds 3
        $left = @($files | Where-Object { Test-Path -LiteralPath (Join-Path $queue $_) })
        if ($left.Count -eq $files.Count) { Write-Host 'Two old files are waiting in the print queue. Submit a ticket from the tray: category Printing.' }
        else { Write-Host 'Windows removed the dummy files when the spooler started, so there is nothing stuck. Use -Problem spooler-stopped instead.' }
    }
    'teams-crashing' {
        if ($Revert) { Write-Host 'Event log entries cannot be removed. They stop counting after seven days.'; break }
        if (-not [System.Diagnostics.EventLog]::SourceExists('Application Error')) { throw 'This Windows has no Application Error event source.' }
        1..2 | ForEach-Object { Write-EventLog -LogName Application -Source 'Application Error' -EventId 1000 -EntryType Error -Message 'ms-teams.exe' }
        Write-Host 'Two fake "ms-teams.exe closed unexpectedly" events were written. Submit a ticket from the tray: category Software Issue, program Microsoft Teams.'
    }
}
