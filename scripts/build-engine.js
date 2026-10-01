// Builds the speech engine into a stand-alone program for the installer.
//
//   npm run build:engine          build build/engine/whisper-server/whisper-server.exe
//   node scripts/build-engine.js --check   only check that it has been built
//
// Freezes auth-server/local_whisper.py (faster-whisper behind a small web
// service) together with Python and its libraries with PyInstaller, so the
// user needs no Python. electron-builder then copies the folder into the
// installer (package.json → build.extraResources) and src/engine.js starts it.
// The model is not included: it is downloaded on the user's computer.
//
// Needs PyInstaller in the project's .venv:  .venv\Scripts\python.exe -m pip install pyinstaller
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'engine', 'whisper-server', 'whisper-server.exe');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error(`Speech engine not built (${path.relative(ROOT, OUT)}). Run: npm run build:engine`);
    process.exit(1);
  }
  console.log(`Speech engine present: ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

const pyinstaller = path.join(ROOT, '.venv', 'Scripts', 'pyinstaller.exe');
if (!fs.existsSync(pyinstaller)) {
  console.error('PyInstaller is not installed in .venv. Run: .venv\\Scripts\\python.exe -m pip install pyinstaller');
  process.exit(1);
}

const args = [
  '--noconfirm', '--clean', '--onedir', '--console',
  '--name', 'whisper-server',
  '--distpath', 'build/engine', '--workpath', 'build/pyi', '--specpath', 'build/pyi',
  '--collect-data', 'faster_whisper',     // the voice-activity model (silero VAD)
  '--collect-binaries', 'ctranslate2',    // the inference DLLs
  '--collect-submodules', 'uvicorn',      // uvicorn picks its parts at run time
  'auth-server/local_whisper.py',
];
console.log('Building the speech engine (takes a few minutes)…');
const r = spawnSync(pyinstaller, args, { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0 || !fs.existsSync(OUT)) {
  console.error(`PyInstaller failed (exit ${r.status})`);
  process.exit(1);
}
console.log(`Built: ${path.relative(ROOT, OUT)}`);
