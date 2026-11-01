// Runs each installed provider binary, since a copied executable can still lack its shared libs.
// A missing binary fails unless upstream publishes no build for this platform and arch.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = path.join(ROOT, 'providers');
const isWindows = process.platform === 'win32';

const { platform, arch } = process;

// Mirrors the asset availability in run.js. Keep them in step.
const llamaExpected = ['darwin', 'linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch);
const koboldExpected = (platform === 'darwin' && arch === 'arm64')
  || (platform === 'linux' && arch === 'x64')
  || (platform === 'win32' && arch === 'x64');

const targets = [
  { name: 'llama-server', file: isWindows ? 'llama-server.exe' : 'llama-server', args: ['--version'], expected: llamaExpected },
  { name: 'koboldcpp', file: isWindows ? 'koboldcpp.exe' : 'koboldcpp', args: ['--help'], expected: koboldExpected }
];

let failures = 0;
let ran = 0;

for (const t of targets) {
  const bin = path.join(PROVIDERS, t.file);
  if (!existsSync(bin)) {
    if (t.expected) {
      console.error(
        `FAIL ${t.name}: upstream publishes a build for ${platform}/${arch}, but the installer produced nothing.\n` +
        '     Check the install log above for a download or rate-limit error.'
      );
      failures += 1;
    } else {
      console.log(`SKIP ${t.name}: upstream publishes no build for ${platform}/${arch}`);
    }
    continue;
  }
  const result = spawnSync(bin, t.args, { encoding: 'utf8', timeout: 120000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim();
  if (result.error) {
    console.error(`FAIL ${t.name}: could not execute - ${result.error.message}`);
    failures += 1;
    continue;
  }
  // Some print help and exit 1, so a usage or version banner counts as success.
  // A dynamic-linker failure prints neither.
  const looksAlive = result.status === 0 || /usage|version|llama|kobold/i.test(output);
  if (!looksAlive) {
    console.error(`FAIL ${t.name}: exited ${result.status} with no recognisable output: ${output || '(nothing)'}`);
    failures += 1;
    continue;
  }
  console.log(`OK   ${t.name}: ${output || `exit ${result.status}`}`);
  ran += 1;
}

console.log(`\n${ran} provider binary/binaries verified, ${failures} broken.`);
process.exit(failures > 0 ? 1 : 0);
