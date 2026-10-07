# Audiator: a copy of the server's database backup on this PC (AUD-22).
# Task Scheduler runs it every day (task "Audiator backup copy"; installed by
# deploy/install-pull-backup.ps1). By hand: powershell -File pull-backup.ps1
# Needs the ssh alias "audiator" (%USERPROFILE%\.ssh\config) and its key.
# ASCII only: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
$ErrorActionPreference = 'Stop'
$keep = 60   # copies of each database kept here
$dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Audiator-backups'
$log = Join-Path $dest 'pull.log'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

function Log($text) {
    Add-Content -Path $log -Encoding UTF8 -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text)
}

try {
    $newest = & ssh -o BatchMode=yes -o ConnectTimeout=20 audiator 'cd /var/backups/audiator && ls -1t accounts-*.db.gz | head -1'
    if ($LASTEXITCODE -ne 0 -or -not $newest) { throw "no backup on the server (ssh exit $LASTEXITCODE)" }
    $stamp = ($newest | Select-Object -First 1).Trim() -replace '^accounts-(.+)\.db\.gz$', '$1'
    # No trailing backslash on the folder: before a closing quote it would
    # escape the quote on the native command line.
    & scp -q -o BatchMode=yes "audiator:/var/backups/audiator/*-$stamp.db.gz" $dest
    if ($LASTEXITCODE -ne 0) { throw "scp exit $LASTEXITCODE" }
    foreach ($db in 'accounts', 'audiator') {
        Get-ChildItem -Path $dest -Filter "$db-*.db.gz" | Sort-Object Name -Descending |
            Select-Object -Skip $keep | Remove-Item -Force
    }
    Log "ok $stamp"
} catch {
    Log "FAILED: $_"
    exit 1
}
