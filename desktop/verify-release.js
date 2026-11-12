'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = (process.argv[2] || process.platform).toLowerCase();
const desktopDir = __dirname;
const distDir = path.join(desktopDir, 'dist');

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  fail(`dist folder is missing: ${distDir}`);
}

const files = walkFiles(distDir);
if (files.length === 0) {
  fail(`dist is empty: ${distDir}`);
}

const apps = files.filter((f) => f.endsWith('.app/Contents/Info.plist') || f.includes('.app' + path.sep));
const exes = files.filter((f) => f.toLowerCase().endsWith('.exe'));
const blockmaps = files.filter((f) => f.toLowerCase().endsWith('.blockmap'));
const yml = files.filter((f) => f.toLowerCase().endsWith('.yml'));

// The packaged backend runs from resources/backend and needs its own node_modules.
// Nothing else checks this, and without them the app opens with a dead backend.
const backendDeps = files.filter((f) =>
  f.includes(`backend${path.sep}node_modules${path.sep}`)
);
if (backendDeps.length === 0) {
  fail(
    'the packaged backend has no node_modules, so it cannot start.\n' +
    '     The app would install and open a window with a dead backend.\n' +
    '     electron-builder 26 skips a node_modules folder at the top of an\n' +
    '     extraResources source, so backend/node_modules needs its own entry\n' +
    '     in build.extraResources in desktop/package.json.'
  );
}

// The frontend's node_modules sits at standalone/frontend/node_modules. It ships
// only because it is nested; Next moving it to the standalone root would drop it.
const nextPkg = path.join('standalone', 'frontend', 'node_modules', 'next', 'package.json');
if (!files.some((f) => f.endsWith(nextPkg))) {
  fail('the packaged frontend has no node_modules/next, so it cannot start.');
}

/** True when the app.asar at `asarPath` holds the entry at `parts`. Reads the asar header. */
function asarHas(asarPath, parts) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const pickle = Buffer.alloc(head.readUInt32LE(4));
    fs.readSync(fd, pickle, 0, pickle.length, 8);
    const start = pickle.length - pickle.readUInt32LE(0);
    let node = JSON.parse(pickle.toString('utf8', start + 4, start + 4 + pickle.readInt32LE(start)));
    for (const part of parts) node = node && node.files ? node.files[part] : undefined;
    return Boolean(node);
  } finally {
    fs.closeSync(fd);
  }
}

// updater.js loads electron-updater lazily, so an app.asar without it still
// starts and then never finds an update.
const asars = files.filter((f) => path.basename(f) === 'app.asar');
if (asars.length === 0) {
  fail('no app.asar in dist, but build.asar is true in desktop/package.json.');
}
for (const asar of asars) {
  for (const parts of [['updater.js'], ['updatePolicy.js'], ['node_modules', 'electron-updater', 'package.json']]) {
    if (!asarHas(asar, parts)) {
      fail(`${parts.join('/')} is missing from ${asar}, so the app cannot update.`);
    }
  }
}

// Each file an update feed names must ship under exactly that name. GitHub turns
// a space in an asset name into a dot, so such a feed sends the updater to a 404.
const feeds = files.filter((f) => path.dirname(f) === distDir && /^latest.*\.yml$/i.test(path.basename(f)));
for (const feed of feeds) {
  const names = [...fs.readFileSync(feed, 'utf8').matchAll(/^\s*-?\s*(?:url|path):\s*(.+?)\s*$/gm)]
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''));
  if (names.length === 0) fail(`${path.basename(feed)} names no file.`);
  for (const name of new Set(names)) {
    if (/\s/.test(name) || !fs.existsSync(path.join(distDir, name))) {
      fail(`${path.basename(feed)} points at "${name}", which dist does not have under that name.`);
    }
  }
}

console.log(`Release verify target: ${target}`);
console.log(`OK  packaged backend dependencies: ${backendDeps.length} files`);
console.log('OK  packaged frontend has node_modules/next');
console.log(`OK  app.asar has the updater: ${asars.length} checked`);
console.log(`OK  update feeds match dist: ${feeds.length} checked`);
console.log(`dist: ${distDir}`);
console.log(`files scanned: ${files.length}`);

if (target === 'mac' || target === 'darwin') {
  const appDirs = new Set();
  for (const f of files) {
    const idx = f.indexOf('.app' + path.sep);
    if (idx !== -1) {
      appDirs.add(f.slice(0, idx + 4));
    }
  }
  if (appDirs.size === 0) {
    fail('No .app bundle found in dist (expected from build.sh).');
  }

  let largestApp = null;
  let largestSize = -1;
  for (const appPath of appDirs) {
    let total = 0;
    for (const f of files) {
      if (f.startsWith(appPath + path.sep)) total += fs.statSync(f).size;
    }
    if (total > largestSize) {
      largestSize = total;
      largestApp = appPath;
    }
  }

  console.log(`OK  app bundles: ${appDirs.size}`);
  console.log(`OK  primary app: ${largestApp}`);
  console.log(`OK  primary app size: ${formatBytes(largestSize)}`);
  process.exit(0);
}

if (target === 'win' || target === 'windows' || target === 'win32') {
  // The installer is the top-level dist\*.exe named by artifactName, so do not
  // require "Setup". Skip the uninstaller stub and anything under win-unpacked\.
  const installerExes = exes.filter((f) => {
    const base = path.basename(f).toLowerCase();
    if (base.includes('uninstall')) return false;
    if (f.toLowerCase().includes('win-unpacked' + path.sep)) return false;
    return true;
  });
  const setupExe = installerExes.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (!setupExe) {
    fail('No installer .exe found in dist (expected from electron-builder NSIS target).');
  }

  const setupSize = fs.statSync(setupExe).size;
  if (setupSize < 20 * 1024 * 1024) {
    fail(`Setup .exe is unexpectedly small (${formatBytes(setupSize)}): ${setupExe}`);
  }

  console.log(`OK  setup exe: ${setupExe}`);
  console.log(`OK  setup size: ${formatBytes(setupSize)}`);
  console.log(`INFO blockmap files: ${blockmaps.length}`);
  console.log(`INFO yml files: ${yml.length}`);
  process.exit(0);
}

if (target === 'linux' || target === 'appimage') {
  const appImages = files.filter((f) => f.toLowerCase().endsWith('.appimage'));
  const primary = appImages.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (!primary) {
    fail('No .AppImage found in dist (expected from electron-builder AppImage target).');
  }
  const size = fs.statSync(primary).size;
  if (size < 20 * 1024 * 1024) {
    fail(`AppImage is unexpectedly small (${formatBytes(size)}): ${primary}`);
  }
  console.log(`OK  appimage: ${primary}`);
  console.log(`OK  appimage size: ${formatBytes(size)}`);

  // GHSA-7g7r-gx96-252g: an AppRun that can leave an empty LD_LIBRARY_PATH entry
  // makes the loader search the folder the AppImage was started from.
  if (process.platform === 'linux') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apprun-'));
    try {
      const run = spawnSync(primary, ['--appimage-extract', 'AppRun'], { cwd: tmp, encoding: 'utf8' });
      const appRun = path.join(tmp, 'squashfs-root', 'AppRun');
      if (run.status !== 0 || !fs.existsSync(appRun)) {
        fail(`could not extract AppRun from ${primary}: ${run.stderr || run.error || run.status}`);
      }
      const unsafe = fs.readFileSync(appRun, 'utf8').split('\n').filter((line) => {
        const at = line.indexOf('LD_LIBRARY_PATH=');
        if (at === -1) return false;
        const value = line.slice(at + 'LD_LIBRARY_PATH='.length);
        return /\$\{?LD_LIBRARY_PATH\b/.test(value) && !value.includes('${LD_LIBRARY_PATH:+');
      });
      if (unsafe.length > 0) {
        fail(`AppRun can leave an empty LD_LIBRARY_PATH entry: ${unsafe[0].trim()}`);
      }
      console.log('OK  AppRun keeps the launch folder off LD_LIBRARY_PATH');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    console.log('INFO AppRun check needs Linux; skipped');
  }
  process.exit(0);
}

console.log('INFO Unknown target; running generic checks only.');
console.log(`INFO exe count: ${exes.length}, app marker count: ${apps.length}`);
process.exit(0);
