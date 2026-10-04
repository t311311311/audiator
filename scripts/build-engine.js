// Builds the speech engine into a stand-alone program for the installer.
//
//   npm run build:engine          build "build/engine/Audiator Engine/Audiator Engine.exe"
//   node scripts/build-engine.js --check   only check that it has been built
//
// Freezes auth-server/local_whisper.py (faster-whisper behind a small web
// service) together with Python and its libraries with PyInstaller, so the
// user needs no Python. electron-builder then copies the folder into the
// installer (package.json → build.extraResources) and src/engine.js starts it.
// The model is not included: it is downloaded on the user's computer.
//
// Named "Audiator Engine", with the app's icon and version details, so in
// Task Manager it is plainly part of Audiator (which shows the description).
//
// Needs PyInstaller in the project's .venv:  .venv\Scripts\python.exe -m pip install pyinstaller
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'Audiator Engine';
const OUT = path.join(ROOT, 'build', 'engine', NAME, `${NAME}.exe`);

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error(`Speech engine not built (${path.relative(ROOT, OUT)}). Run: npm run build:engine`);
    process.exit(1);
  }
  console.log(`Speech engine present: ${path.relative(ROOT, OUT)}`);
  if (!fs.existsSync(path.join(ROOT, 'build', 'THIRD-PARTY-NOTICES.txt'))) {
    console.error('build/THIRD-PARTY-NOTICES.txt is missing. Run: npm run build:engine');
    process.exit(1);
  }
  process.exit(0);
}

const pyinstaller = path.join(ROOT, '.venv', 'Scripts', 'pyinstaller.exe');
if (!fs.existsSync(pyinstaller)) {
  console.error('PyInstaller is not installed in .venv. Run: .venv\\Scripts\\python.exe -m pip install pyinstaller');
  process.exit(1);
}

// Windows version details: Task Manager lists the process by its description.
const version = require(path.join(ROOT, 'package.json')).version;
const v = [...version.split('.').map(Number), 0, 0, 0].slice(0, 4).join(', ');
const versionFile = path.join(ROOT, 'build', 'pyi', 'engine-version.txt');
fs.mkdirSync(path.dirname(versionFile), { recursive: true });
fs.writeFileSync(versionFile, `VSVersionInfo(
  ffi=FixedFileInfo(filevers=(${v}), prodvers=(${v}), mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Audiator'),
      StringStruct('FileDescription', '${NAME}'),
      StringStruct('FileVersion', '${version}'),
      StringStruct('InternalName', '${NAME}'),
      StringStruct('OriginalFilename', '${NAME}.exe'),
      StringStruct('ProductName', 'Audiator'),
      StringStruct('ProductVersion', '${version}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
`);

const args = [
  '--noconfirm', '--clean', '--onedir', '--console',
  '--name', NAME,
  '--icon', path.join(ROOT, 'src', 'icon.ico'),
  '--version-file', versionFile,
  '--distpath', 'build/engine', '--workpath', 'build/pyi', '--specpath', 'build/pyi',
  '--collect-data', 'faster_whisper',     // the voice-activity model (silero VAD)
  '--collect-binaries', 'ctranslate2',    // the inference DLLs
  '--collect-submodules', 'uvicorn',      // uvicorn picks its parts at run time
  // Translation (translator.py): Argos Translate and the language catalog.
  '--collect-submodules', 'argostranslate',
  '--collect-data', 'sacremoses',         // per-language tokenizer rules
  '--collect-all', 'sentencepiece',       // the tokenizer library and its tables
  // Left out for their licences (GPL / AGPL — a closed program could not ship
  // them): PyAV with FFmpeg and x264 (the app sends plain WAV, read with
  // Python's own wave module) and MiniSBD (translator.py splits sentences
  // itself). Both modules get stand-ins at run time.
  '--exclude-module', 'av',
  '--exclude-module', 'minisbd',
  '--add-data', `${path.join(ROOT, 'auth-server', 'translate_catalog.json')}${path.delimiter}.`,
  '--paths', 'auth-server',               // translator.py sits beside the script
  'auth-server/local_whisper.py',
];
console.log('Building the speech engine (takes a few minutes)…');
const r = spawnSync(pyinstaller, args, { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0 || !fs.existsSync(OUT)) {
  console.error(`PyInstaller failed (exit ${r.status})`);
  process.exit(1);
}
// What the installer ships of others, with licences, read from this build
// (build/THIRD-PARTY-NOTICES.txt, put in the program folder by electron-builder).
const n = spawnSync(path.join(ROOT, '.venv', 'Scripts', 'python.exe'), ['scripts/third_party_notices.py'],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
if (n.status !== 0) {
  console.error('Could not write THIRD-PARTY-NOTICES.txt');
  process.exit(1);
}
console.log(`Built: ${path.relative(ROOT, OUT)}`);
