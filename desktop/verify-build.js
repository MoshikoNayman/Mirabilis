'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = __dirname;
const ROOT_DIR = path.resolve(DESKTOP_DIR, '..');

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function readText(targetPath) {
  return fs.readFileSync(targetPath, 'utf8');
}

const checks = [
  {
    name: 'Desktop entrypoint',
    ok: exists(path.join(DESKTOP_DIR, 'main.js')),
    hint: 'desktop/main.js is missing.'
  },
  {
    name: 'Desktop preload',
    ok: exists(path.join(DESKTOP_DIR, 'preload.js')),
    hint: 'desktop/preload.js is missing.'
  },
  {
    name: 'Updater sources',
    ok: exists(path.join(DESKTOP_DIR, 'updater.js')) && exists(path.join(DESKTOP_DIR, 'updatePolicy.js')),
    hint: 'desktop/updater.js or updatePolicy.js is missing; the app could not check for updates.'
  },
  {
    // electron-builder ships exactly what `files` lists. A file left out of
    // that array is missing only in the packaged app, which is the worst place
    // to find out: main.js requires it at startup, so the release would launch
    // to a blank window while `npm run dev` stayed perfectly fine.
    name: 'Updater sources are packaged',
    ok: (() => {
      try {
        const files = require(path.join(DESKTOP_DIR, 'package.json')).build.files || [];
        const shipped = (f) => files.some((p) => p === f || p.endsWith('**/*') && f.startsWith(p.replace('/**/*', '')));
        return shipped('updater.js') && shipped('updatePolicy.js') && files.some((f) => f.startsWith('node_modules'));
      } catch { return false; }
    })(),
    hint: 'Add updater.js, updatePolicy.js and node_modules/**/* to build.files in desktop/package.json.'
  },
  {
    name: 'Update feed configured',
    ok: (() => {
      try {
        const publish = require(path.join(DESKTOP_DIR, 'package.json')).build.publish;
        return !!(publish && publish.provider && publish.owner && publish.repo);
      } catch { return false; }
    })(),
    hint: 'build.publish is missing; electron-builder emits no latest*.yml and updates cannot be found.'
  },
  {
    // Squirrel.Mac installs from a zip. A dmg-only mac target means macOS can
    // never self update, however well signed it is.
    name: 'macOS update artifact',
    ok: (() => {
      try {
        const targets = require(path.join(DESKTOP_DIR, 'package.json')).build.mac.target || [];
        return targets.some((t) => (typeof t === 'string' ? t : t.target) === 'zip');
      } catch { return false; }
    })(),
    hint: 'Add a zip target to build.mac.target: Squirrel.Mac cannot install from a dmg.'
  },
  {
    name: 'Windows icon',
    ok: exists(path.join(DESKTOP_DIR, 'icons', 'Mirabilis.ico')),
    hint: 'desktop/icons/Mirabilis.ico is missing.'
  },
  {
    name: 'macOS icon',
    ok: exists(path.join(DESKTOP_DIR, 'icons', 'icon.icns')),
    hint: 'desktop/icons/icon.icns is missing.'
  },
  {
    name: 'Linux icon',
    ok: exists(path.join(DESKTOP_DIR, 'icons', 'icon.png')),
    hint: 'desktop/icons/icon.png is missing.'
  },
  {
    name: 'Backend server source',
    ok: exists(path.join(ROOT_DIR, 'backend', 'src', 'server.js')),
    hint: 'backend/src/server.js is missing.'
  },
  {
    name: 'Frontend Next config',
    ok: exists(path.join(ROOT_DIR, 'frontend', 'next.config.js')),
    hint: 'frontend/next.config.js is missing.'
  },
  {
    name: 'Frontend standalone output',
    ok:
      exists(path.join(ROOT_DIR, 'frontend', '.next', 'standalone', 'frontend', 'server.js')) ||
      exists(path.join(ROOT_DIR, 'frontend', '.next', 'standalone', 'server.js')),
    hint: 'Run frontend build first: cd frontend && npm run build'
  },
  {
    name: 'Frontend static output',
    ok:
      exists(path.join(ROOT_DIR, 'frontend', '.next', 'static')) ||
      exists(path.join(ROOT_DIR, 'frontend', '.next', 'standalone', '.next', 'static')) ||
      exists(path.join(ROOT_DIR, 'frontend', '.next', 'standalone', 'frontend', '.next', 'static')),
    hint: 'Missing frontend/.next/static. Run frontend build first.'
  }
];

const nextConfigPath = path.join(ROOT_DIR, 'frontend', 'next.config.js');
if (exists(nextConfigPath)) {
  const nextConfig = readText(nextConfigPath);
  checks.push({
    name: 'Next standalone mode enabled',
    ok: /output\s*:\s*['\"]standalone['\"]/.test(nextConfig),
    hint: 'next.config.js must include output: \'standalone\''
  });
  checks.push({
    name: 'Next outputFileTracingRoot enabled',
    ok: /outputFileTracingRoot\s*:/.test(nextConfig),
    hint: 'next.config.js should include outputFileTracingRoot for desktop packaging.'
  });
}

const failed = checks.filter((c) => !c.ok);
const passed = checks.length - failed.length;

console.log(`Desktop build verify: ${passed}/${checks.length} checks passed`);
for (const check of checks) {
  console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}`);
}

if (failed.length > 0) {
  console.error('\nAction items:');
  for (const f of failed) {
    console.error(`- ${f.hint}`);
  }
  process.exit(1);
}

console.log('\nAll checks passed. Safe to run desktop/build.sh or desktop/build.bat.');
