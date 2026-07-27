# Local dev backend for Audiator (no Docker, no server).
# Starts the three backend services on localhost, each in its own window:
#   whisper shim  -> 127.0.0.1:8000   (transcription, faster-whisper)
#   libretranslate-> 127.0.0.1:5000   (translation, optional)
#   auth-server   -> 127.0.0.1:3000   (auth + gateway the app talks to)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1
# Stop:   close the three windows (or Ctrl+C in each).

$root = Split-Path -Parent $PSScriptRoot
$py   = Join-Path $root ".venv\Scripts\python.exe"
$auth = Join-Path $root "auth-server"

if (-not (Test-Path $py)) {
    Write-Host "venv not found at $py. Create it: python -m venv .venv" -ForegroundColor Red
    exit 1
}

Write-Host "Starting whisper shim (127.0.0.1:8000)..." -ForegroundColor Cyan
Start-Process -FilePath $py -ArgumentList "local_whisper.py" -WorkingDirectory $auth

Write-Host "Starting auth-server + gateway (127.0.0.1:3000)..." -ForegroundColor Cyan
Start-Process -FilePath $py -ArgumentList "main.py" -WorkingDirectory $auth

$lt = Join-Path $root ".venv\Scripts\libretranslate.exe"
if (Test-Path $lt) {
    # Loads whatever language models are installed. Add more with:
    #   .venv\Scripts\python.exe scripts\install-lang.py <code> <code>
    Write-Host "Starting LibreTranslate (127.0.0.1:5000)..." -ForegroundColor Cyan
    Start-Process -FilePath $lt -ArgumentList "--host","127.0.0.1","--port","5000"
} else {
    Write-Host "LibreTranslate not installed - translation disabled (transcription still works)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Backend starting. Give whisper ~15s to load its model, then run the app:" -ForegroundColor Green
Write-Host "  cd $root ; npm start"
