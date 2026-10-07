# Audiator: install the daily copy of the server's backup on this PC (AUD-22).
# Copies pull-backup.ps1 to %USERPROFILE%\.audiator\ (outside the repository,
# so switching branches never removes it) and registers the Task Scheduler task
# "Audiator backup copy": every day at 12:00, or as soon as the PC is on if it
# was off then. Runs as the current user, only while signed in (it needs the ssh
# key). Run again to update. ASCII only (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$home_dir = Join-Path $env:USERPROFILE '.audiator'
New-Item -ItemType Directory -Force -Path $home_dir | Out-Null
$script = Join-Path $home_dir 'pull-backup.ps1'
Copy-Item -Force (Join-Path $PSScriptRoot 'pull-backup.ps1') $script

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At '12:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Audiator backup copy' -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description 'Audiator: daily copy of the server database backup into Documents\Audiator-backups' | Out-Null
Get-ScheduledTask -TaskName 'Audiator backup copy' | Select-Object TaskName, State
