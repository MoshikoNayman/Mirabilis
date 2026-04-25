'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

console.log(`Release verify target: ${target}`);
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
  const setupExe = exes.find((f) => /setup/i.test(path.basename(f)));
  if (!setupExe) {
    fail('No Setup .exe found in dist (expected from build.bat).');
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

console.log('INFO Unknown target; running generic checks only.');
console.log(`INFO exe count: ${exes.length}, app marker count: ${apps.length}`);
process.exit(0);
