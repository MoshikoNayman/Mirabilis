// Classifier is a security boundary; test the rejection and acceptance lists plus
// attempts to smuggle a write past it.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCommand, matchesAllowRules, ruleForCommand, READ_ONLY_PROGRAMS
} from './commandPolicy.js';

const ro = (cmd, platform = 'darwin') => classifyCommand(cmd, { platform }).readOnly;

// commands that must never be classified read-only

test('writes, deletes and compound tricks are not read-only', () => {
  const reject = [
    'ls; rm -rf ~',
    'cat a && rm b',
    'ls || rm b',
    'ls $(rm x)',
    'ls `rm x`',
    'echo hi > f',
    'echo hi >> f',
    'cat < f',
    'find . -delete',
    'find / -exec rm {} ;',
    'git branch -D x',
    'git branch -d x',
    'git tag v1',
    'git config user.name "me"',
    'git push',
    'sysctl -w a=1',
    'sysctl kern.maxfiles=1',
    'ifconfig en0 down',
    'ip link set x down',
    'tail -f log',
    'tail -F log',
    'FOO=1 rm x',
    'sudo ls',
    'doas ls',
    'exec ls',
    'rm file.txt',
    '/bin/rm -rf x',
    'mv a b',
    'cp a b',
    'touch f',
    'ls &',
    'ls |& cat',
    'cat a > /dev/null',
    'dd if=/dev/zero of=f',
    'npm install',
    'npm run build',
    'brew install wget',
    'docker run alpine',
    'docker logs -f web',
    'kill -9 123',
    '(cd / && ls)',
    'ls > out.txt 2>&1',
    'echo x >| f',
    ': > f',
    'node -e "process.exit()"',
    'python3 -c "import os"'
  ];
  for (const cmd of reject) assert.equal(ro(cmd), false, `must reject: ${cmd}`);
});

test('quoting and escaping cannot hide a separator or a redirection', () => {
  // A quoted separator does not split, but the leftover fragment is not a program.
  assert.equal(ro('echo "a; rm b"'), true, 'quoted ; is literal to echo, which is read-only');
  assert.equal(ro('grep ";" file'), true, 'quoted ; is an argument to grep');
  // An escaped redirection char is literal, so echo stays read-only, but a real one is not.
  assert.equal(ro('echo \\> f'), true, 'escaped > is a literal argument');
  assert.equal(ro('cat f > g'), false, 'a real redirection disqualifies');
  // Smuggling rm inside a double-quoted command substitution still runs it.
  assert.equal(ro('echo "$(rm x)"'), false, 'command substitution fires inside double quotes');
  assert.equal(ro('cat "`rm x`"'), false, 'backtick substitution fires inside double quotes');
});

test('a unicode lookalike program name is not the real program', () => {
  // U+0441 is Cyrillic es; it renders like c but is not the program cat. Build
  // it at runtime so this source file stays ASCII.
  const sneaky = `${String.fromCharCode(0x0441)}at /etc/passwd`;
  assert.equal(ro(sneaky), false, 'a homoglyph of cat is not cat');
});

test('long option forms and env prefixes are handled', () => {
  assert.equal(ro('date --set=2020'), false);
  assert.equal(ro('A=1 B=2 node -v'), false, 'an env assignment prefix disqualifies');
  assert.equal(ro('git --no-pager status'), true, 'a benign global flag is fine');
});

// commands that must be classified read-only

test('the acceptance list is read-only', () => {
  const accept = [
    'ps aux | grep node | head -5',
    'ls -la ~/Library 2>/dev/null',
    'git status',
    'git log --oneline -20',
    'git diff HEAD~1',
    'git branch',
    'git branch -a',
    'git remote -v',
    'git config --get user.name',
    'brew services list',
    'brew list',
    'df -h',
    'du -sh .',
    'lsof -nP -iTCP -sTCP:LISTEN',
    'cat /etc/hosts',
    'grep -r TODO src',
    'find . -name "*.js"',
    'npm ls',
    'npm outdated',
    'node --version',
    'python3 --version',
    'pip list',
    'docker ps',
    'docker stats --no-stream',
    'ollama list',
    'sysctl hw.ncpu',
    'ifconfig',
    'ifconfig en0',
    'ifconfig -a',
    'ip addr',
    'ip addr show',
    'ping -c 3 8.8.8.8',
    'tail -n 100 log.txt',
    'systemctl status nginx',
    'defaults read com.apple.finder',
    'echo hello 2>&1',
    'cat a 2>/dev/null | grep x'
  ];
  for (const cmd of accept) assert.equal(ro(cmd), true, `must accept: ${cmd}`);
});

test('top and iostat require their capture flags', () => {
  assert.equal(ro('top -l 1', 'darwin'), true);
  assert.equal(ro('top', 'darwin'), false, 'interactive top is not capturable');
  assert.equal(ro('top -b -n 1', 'linux'), true);
  assert.equal(ro('top -l 1', 'linux'), false);
  assert.equal(ro('iostat 1', 'darwin'), true);
  assert.equal(ro('iostat', 'darwin'), false);
});

test('ping is bounded to a small count', () => {
  assert.equal(ro('ping -c 3 host'), true);
  assert.equal(ro('ping -c 1000 host'), false, 'a flood count is refused');
  assert.equal(ro('ping host'), false, 'an unbounded ping is refused');
});

test('windows programs classify on win32 only', () => {
  assert.equal(ro('dir', 'win32'), true);
  assert.equal(ro('tasklist', 'win32'), true);
  assert.equal(ro('ipconfig /all', 'win32'), true);
  assert.equal(ro('ping -n 2 host', 'win32'), true);
  assert.equal(ro('ping -n 99 host', 'win32'), false);
  assert.equal(ro('del f', 'win32'), false);
  assert.equal(ro('dir', 'darwin'), false, 'dir is not a posix read-only program');
});

// network flag

test('network is detected across programs and subcommands', () => {
  assert.equal(classifyCommand('ping -c 1 host', { platform: 'darwin' }).network, true);
  assert.equal(classifyCommand('git fetch', { platform: 'darwin' }).network, true);
  assert.equal(classifyCommand('npm outdated', { platform: 'darwin' }).network, true);
  assert.equal(classifyCommand('brew outdated', { platform: 'darwin' }).network, true);
  assert.equal(classifyCommand('curl http://x', { platform: 'darwin' }).network, true);
  assert.equal(classifyCommand('git status', { platform: 'darwin' }).network, false);
  assert.equal(classifyCommand('ls', { platform: 'darwin' }).network, false);
});

// programs and prefix

test('classify reports the programs and the first-segment rule', () => {
  const r = classifyCommand('ps aux | grep node | head -5', { platform: 'darwin' });
  assert.deepEqual(r.programs, ['ps', 'grep', 'head']);
  assert.equal(r.prefix, 'ps');
});

// ruleForCommand

test('ruleForCommand saves program plus subcommand where it matters', () => {
  assert.equal(ruleForCommand('git status', { platform: 'darwin' }), 'git status');
  assert.equal(ruleForCommand('npm test', { platform: 'darwin' }), 'npm test');
  assert.equal(ruleForCommand('brew services list', { platform: 'darwin' }), 'brew services');
  assert.equal(ruleForCommand('make', { platform: 'darwin' }), 'make');
  assert.equal(ruleForCommand('make build', { platform: 'darwin' }), 'make build');
  assert.equal(ruleForCommand('ls -la', { platform: 'darwin' }), 'ls');
  assert.equal(ruleForCommand('python3 -m pytest', { platform: 'darwin' }), 'python3 -m pytest');
});

// matchesAllowRules

test('matchesAllowRules accepts read-only commands and matching rules only', () => {
  const rules = ['git status', 'npm test', 'make'];
  assert.equal(matchesAllowRules('ls -la', rules, { platform: 'darwin' }), true, 'read-only passes with no rule');
  assert.equal(matchesAllowRules('git status --short', rules, { platform: 'darwin' }), true, 'rule prefix matches');
  assert.equal(matchesAllowRules('npm test -- --watch', rules, { platform: 'darwin' }), true);
  assert.equal(matchesAllowRules('make build', rules, { platform: 'darwin' }), true, 'bare make rule matches any target');
  assert.equal(matchesAllowRules('git push', rules, { platform: 'darwin' }), false, 'a non-matching write fails');
  assert.equal(matchesAllowRules('npm install', rules, { platform: 'darwin' }), false);
});

test('matchesAllowRules fails on any redirection or subshell even with a rule', () => {
  assert.equal(matchesAllowRules('git status > f', ['git status'], { platform: 'darwin' }), false);
  assert.equal(matchesAllowRules('git status; rm x', ['git status'], { platform: 'darwin' }), false, 'the rm segment has no rule');
  assert.equal(matchesAllowRules('sudo git status', ['git status'], { platform: 'darwin' }), false, 'a rule does not cover a sudo prefix');
});

test('a pipeline passes allow rules only when every segment does', () => {
  assert.equal(matchesAllowRules('git status | grep foo', ['git status'], { platform: 'darwin' }), true, 'grep is read-only');
  assert.equal(matchesAllowRules('git status | xargs rm', ['git status'], { platform: 'darwin' }), false, 'xargs rm is not read-only or ruled');
});

// write-capable argument forms of otherwise read-only filters

test('sort, uniq and tree write forms are not read-only', () => {
  const reject = [
    'sort -o /tmp/victim /dev/null',
    'sort --output=/tmp/victim f',
    'sort -o/tmp/victim f',
    'sort -uo /tmp/victim f',
    'uniq /etc/hosts /tmp/victim',
    'uniq -f 2 in out',
    'tree -o /tmp/out .',
    'tree --output=/tmp/out .'
  ];
  for (const cmd of reject) assert.equal(ro(cmd), false, `must reject: ${cmd}`);
  // Plain filter and listing forms stay read-only.
  for (const cmd of ['sort file', 'sort -rn file', 'sort -k2 -t, data', 'uniq file', 'uniq -c in', 'tree .', 'tree -L 2 ~/x']) {
    assert.equal(ro(cmd), true, `must accept: ${cmd}`);
  }
});

test('rg --pre and file -C run or write and are not read-only', () => {
  for (const cmd of ['rg --pre touch foo .', 'rg --pre=touch foo .', 'rg --pre-glob *.gz foo .', 'rg --hostname-bin cmd foo .', 'file -C -m /tmp/magic', 'file -bC x']) {
    assert.equal(ro(cmd), false, `must reject: ${cmd}`);
  }
  for (const cmd of ['rg TODO .', 'rg -n --hidden foo', 'rg -f patterns.txt src', 'file /etc/hosts', 'file -i x']) {
    assert.equal(ro(cmd), true, `must accept: ${cmd}`);
  }
});

test('date clock-set forms are not read-only', () => {
  for (const cmd of ['date -s 2020', 'date --set=2020', 'date 1130', 'date 010112002025', 'date 09301200']) {
    assert.equal(ro(cmd), false, `must reject: ${cmd}`);
  }
  for (const cmd of ['date', 'date +%s', 'date -u', 'date -R', 'date -r 1700000000']) {
    assert.equal(ro(cmd), true, `must accept: ${cmd}`);
  }
});

test('git global options and write subcommands are not read-only', () => {
  const reject = [
    'git -c core.fsmonitor=touch status',
    'git -c a=b status',
    'git --exec-path=/tmp status',
    'git -p log',
    'git --paginate log',
    'git diff --output=/tmp/x',
    'git diff --output /tmp/x',
    'git log --output=/tmp/x',
    'git show --output=/tmp/x HEAD',
    'git diff --ext-diff',
    'git log --textconv',
    'git branch newbranch',
    'git branch -m old new',
    'git branch --edit-description',
    'git remote prune origin',
    'git remote update',
    'git remote add x y'
  ];
  for (const cmd of reject) assert.equal(ro(cmd), false, `must reject: ${cmd}`);
  const accept = [
    'git status',
    'git --no-pager status',
    'git log --oneline -20',
    'git diff HEAD~1',
    'git branch',
    'git branch -a',
    'git branch --contains HEAD',
    'git remote',
    'git remote -v',
    'git remote show origin',
    'git remote get-url origin'
  ];
  for (const cmd of accept) assert.equal(ro(cmd), true, `must accept: ${cmd}`);
});

test('a path-qualified program is read-only only from a system bin dir', () => {
  for (const cmd of ['./ls', '/tmp/evil/cat x', 'scripts/ps aux', '~/Downloads/tree', '../bin/cat f']) {
    assert.equal(ro(cmd), false, `must reject: ${cmd}`);
  }
  for (const cmd of ['/bin/ls', '/usr/bin/ps aux', '/opt/homebrew/bin/rg foo', '/usr/local/bin/tree .']) {
    assert.equal(ro(cmd), true, `must accept: ${cmd}`);
  }
});

test('an allow rule matches commands with global value options', () => {
  const pairs = [
    ['git -C ~/repo pull', 'git pull'],
    ['npm --prefix ~/app install', 'npm install'],
    ['make -C ~/proj build', 'make build'],
    ['docker -H host run x', 'docker run']
  ];
  for (const [cmd, expectedRule] of pairs) {
    const rule = ruleForCommand(cmd, { platform: 'darwin' });
    assert.equal(rule, expectedRule, `rule for ${cmd}`);
    assert.equal(matchesAllowRules(cmd, [rule], { platform: 'darwin' }), true, `saved rule must match ${cmd}`);
  }
});

// exported program list

test('READ_ONLY_PROGRAMS lists the common inspection tools', () => {
  for (const p of ['ls', 'cat', 'git', 'ps', 'df', 'lsof', 'grep', 'sort', 'uniq', 'tree', 'file', 'rg']) {
    assert.ok(READ_ONLY_PROGRAMS.includes(p), `expected ${p} in the list`);
  }
  assert.ok(!READ_ONLY_PROGRAMS.includes('rm'), 'rm must never be listed');
  assert.ok(!READ_ONLY_PROGRAMS.includes('sudo'));
});
