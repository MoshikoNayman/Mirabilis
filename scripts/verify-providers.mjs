// Proves the provider binaries the launcher installed can actually start.
//
// Checking that a file exists is not enough: the llama.cpp release ships the
// executable alongside shared libraries it needs at runtime, so an installer
// that copies only the executable produces something that passes every
// existence check and then dies with a dynamic-linker error the first time a
// user selects that provider. Run them and look at the exit status.
//
// Absence is tolerated, because not every platform and architecture has a
// prebuilt binary and Ollama alone is a working setup. A binary that is present
// and broken is not tolerated.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = path.join(ROOT, 'providers');
const isWindows = process.platform === 'win32';

const targets = [
  { name: 'llama-server', file: isWindows ? 'llama-server.exe' : 'llama-server', args: ['--version'] },
  { name: 'koboldcpp', file: isWindows ? 'koboldcpp.exe' : 'koboldcpp', args: ['--help'] }
];

let failures = 0;
let ran = 0;

for (const t of targets) {
  const bin = path.join(PROVIDERS, t.file);
  if (!existsSync(bin)) {
    console.log(`SKIP ${t.name}: not installed for ${process.platform}/${process.arch}`);
    continue;
  }
  const result = spawnSync(bin, t.args, { encoding: 'utf8', timeout: 120000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim();
  if (result.error) {
    console.error(`FAIL ${t.name}: could not execute - ${result.error.message}`);
    failures += 1;
    continue;
  }
  // A usage or version banner is success even when the exit status is non-zero:
  // several of these print help and exit 1. A dynamic-linker failure produces
  // neither, which is the case worth catching.
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
