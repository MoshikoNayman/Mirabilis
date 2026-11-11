import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSystemTools, tailTextFile, formatDuration, scrub, COMMAND_TIMEOUT_MS } from './systemTools.js';

// Fixtures: real command output, trimmed.

const DARWIN = {
  'sw_vers': 'ProductName:\t\tmacOS\nProductVersion:\t\t26.6.2\nBuildVersion:\t\t25G83\n',
  'sysctl vm.swapusage kern.memorystatus_vm_pressure_level':
    'vm.swapusage: total = 3072.00M  used = 1866.56M  free = 1205.44M  (encrypted)\nkern.memorystatus_vm_pressure_level: 1\n',
  'sysctl hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu':
    'hw.perflevel0.physicalcpu: 4\nhw.perflevel1.physicalcpu: 6\n',
  'vm_stat': [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                    67742.',
    'Pages active:                                 376132.',
    'Pages inactive:                               365697.',
    'Pages speculative:                             10217.',
    'Pages wired down:                             137902.',
    'Pages purgeable:                               28884.',
    'File-backed pages:                            234250.',
    'Anonymous pages:                              517796.',
    'Pages occupied by compressor:                  51539.',
    ''
  ].join('\n'),
  'df -kP': [
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1   239362496  12341400  81244320    14%    /',
    'devfs                  201       201         0   100%    /dev',
    '/dev/disk3s6     239362496   3145856  81244320     4%    /System/Volumes/VM',
    '/dev/disk3s2     239362496   8826336  81244320    10%    /System/Volumes/Preboot',
    '/dev/disk1s2        512000      6164    493288     2%    /System/Volumes/xarts',
    '/dev/disk1s3        512000      1572    493288     1%    /System/Volumes/Hardware',
    '/dev/disk3s5     239362496 132395908  81244320    62%    /System/Volumes/Data',
    'map auto_home            0         0         0   100%    /System/Volumes/Data/home',
    '/dev/disk5s1     976762584 500000000 476762584    52%    /Volumes/Backup Drive',
    ''
  ].join('\n'),
  'ps -A -o pid=,user=,%cpu=,%mem=,rss=,etime=,comm=': [
    '    1 root               0.1  0.1  22976 12-00:03:52 /sbin/launchd',
    '  406 _windowserver     39.5  0.9 146464 12-00:01:45 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
    '  981 alice             12.0  6.1 999424 01:02:03 /Applications/Big App.app/Contents/MacOS/Big App Helper (Renderer)',
    ' 4242 alice             88.8  2.0 327680    05:01 node',
    ' 5000 alice              0.0  0.5  81920    00:10 /usr/bin/python3',
    ''
  ].join('\n'),
  'ps -A -ww -o pid=,args=': [
    '    1 /sbin/launchd',
    '  406 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon',
    '  981 /Applications/Big App.app/Contents/MacOS/Big App Helper (Renderer) --type=renderer --lang=en-US',
    ' 4242 node server.js --api-key=sk-abcdefghijklmnopqrstuvwxyz123456',
    ' 5000 /usr/bin/python3 -m http.server 8000',
    ''
  ].join('\n'),
  'route -n get default': '   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n',
  'scutil --dns': [
    'DNS configuration', '', 'resolver #1', '  nameserver[0] : 9.9.9.9', '  nameserver[1] : 1.1.1.1',
    '  if_index : 11 (en0)', 'resolver #2', '  domain   : local', 'resolver #1', '  nameserver[0] : 9.9.9.9', ''
  ].join('\n'),
  'lsof -nP +c 0 -iTCP -sTCP:LISTEN -FpcLn': [
    'p689', 'cControlCenter', 'Lalice', 'f10', 'n*:7000', 'f11', 'n*:7000',
    'p1087', 'cpostgres', 'Lalice', 'f7', 'n[::1]:5432', 'f8', 'n127.0.0.1:5432',
    'p4242', 'cnode', 'Lalice', 'f20', 'n127.0.0.1:4000', ''
  ].join('\n'),
  'netstat -an -p tcp': [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  192.168.1.76.63614     192.168.1.101.80       ESTABLISHED',
    'tcp4       0      0  192.168.1.76.63539     142.250.217.14.443     ESTABLISHED',
    'tcp4       0      0  127.0.0.1.4000         127.0.0.1.63540        ESTABLISHED',
    'tcp46      0      0  *.7000                 *.*                    LISTEN',
    'tcp4       0      0  *.22                   *.*                    LISTEN',
    'tcp6       0      0  ::1.5432               *.*                    LISTEN',
    'tcp4       0      0  127.0.0.1.631          *.*                    LISTEN',
    ''
  ].join('\n')
};

const LINUX = {
  'df -kP': [
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    'udev               8123456         0   8123456       0% /dev',
    'tmpfs              1634000      2000   1632000       1% /run',
    '/dev/nvme0n1p2   102687672  45000000  52438472      47% /',
    'tmpfs              8170000         0   8170000       0% /dev/shm',
    '/dev/loop0           56832     56832         0     100% /snap/core18/2128',
    '/dev/nvme0n1p1      524252      6188    518064       2% /boot/efi',
    '/dev/sdb1        961302560 400000000 512431840      44% /data',
    ''
  ].join('\n'),
  'free -k': [
    '               total        used        free      shared  buff/cache   available',
    'Mem:        16318436     4567890     8000000      123456     3750546    11000000',
    'Swap:        2097148      524288     1572860',
    ''
  ].join('\n'),
  'ps -A -o pid=,user=,%cpu=,%mem=,rss=,etime=,comm=': [
    '    1 root      0.0  0.1  12345 10-01:02:03 systemd',
    '  812 www-data  1.5  0.4  65536 02:03:04 nginx',
    ' 2001 bob      97.0  3.0 491520    10:00 node',
    '    2 root      0.0  0.0      0 10-01:02:03 kthreadd',
    ''
  ].join('\n'),
  'ps -A -ww -o pid=,args=': [
    '    1 /sbin/init splash',
    '  812 nginx: worker process',
    ' 2001 /usr/bin/node /srv/app/server.js --port 3000',
    '    2 [kthreadd]',
    ''
  ].join('\n'),
  'ip route show default': 'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100\n',
  'resolvectl dns': 'Global:\nLink 2 (eth0): 192.168.1.1 fd00::1 fe80::1%eth0\nLink 3 (wlan0): 1.1.1.1#cloudflare-dns.com\n',
  'ss -ltnp': [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
    'LISTEN 0      511                *:80               *:*     users:(("nginx",pid=1200,fd=7),("nginx",pid=1199,fd=7))',
    'LISTEN 0      128             [::]:22            [::]:*',
    'LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*     users:(("node",pid=2001,fd=20))',
    ''
  ].join('\n'),
  'ss -s': 'Total: 180\nTCP:   12 (estab 4, closed 2, orphaned 0, timewait 2)\n'
};

const LINUX_FILES = {
  '/etc/os-release': 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\n',
  '/etc/resolv.conf': '# managed by systemd-resolved\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch lan\n'
};

const WINDOWS = {
  'tasklist /fo csv /nh': [
    '"System Idle Process","0","Services","0","8 K"',
    '"svchost.exe","1012","Services","0","12,345 K"',
    '"node.exe","5555","Console","1","98,304 K"',
    '"chrome.exe","7777","Console","1","204,800 K"',
    ''
  ].join('\r\n'),
  'route print -4 0.0.0.0': [
    'IPv4 Route Table',
    '===========================================================================',
    'Active Routes:',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.50     25',
    ''
  ].join('\r\n'),
  'netstat -ano': [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    '  TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       5555',
    '  TCP    192.168.1.50:50000     140.82.112.4:443       ESTABLISHED     7777',
    '  TCP    [::]:135               [::]:0                 LISTENING       1012',
    '  TCP    [::1]:4000             [::]:0                 LISTENING       5555',
    '  UDP    0.0.0.0:5353           *:*                                    2222',
    ''
  ].join('\r\n')
};

const IFACES = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' },
    { address: '::1', family: 'IPv6', internal: true, cidr: '::1/128' }
  ],
  en0: [
    { address: 'fe80::1c', family: 'IPv6', internal: false, cidr: 'fe80::1c/64' },
    { address: '192.168.1.76', family: 'IPv4', internal: false, cidr: '192.168.1.76/24' },
    { address: '2601:1::5', family: 'IPv6', internal: false, cidr: '2601:1::5/64' }
  ],
  utun0: [{ address: 'fe80::af9e', family: 'IPv6', internal: false, cidr: 'fe80::af9e/64' }]
};

/** Answers from a table keyed by the full command line; anything else is "not installed". */
function stubRunner(table, calls = []) {
  return async (command, args, opts) => {
    const key = [command, ...args].join(' ');
    calls.push({ key, opts });
    const entry = table[key];
    if (entry === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    }
    if (entry instanceof Error) throw entry;
    return { stdout: entry, stderr: '' };
  };
}

function stubHost(overrides = {}) {
  const files = overrides.files || {};
  return {
    cpus: () => Array.from({ length: 10 }, () => ({ model: 'Apple M4', speed: 0, times: {} })),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 1024 ** 3,
    loadavg: () => [1.234, 2, 3.456],
    uptime: () => 90_061,
    hostname: () => 'testhost',
    release: () => '25.6.0',
    version: () => 'Darwin Kernel Version 25.6.0',
    arch: () => 'arm64',
    homedir: () => overrides.home || os.tmpdir(),
    networkInterfaces: () => overrides.interfaces || IFACES,
    dnsServers: () => ['10.0.0.53'],
    nodeVersion: () => 'v22.0.0',
    uid: () => 501,
    shell: () => '/bin/zsh',
    readText: async (file) => {
      if (files[file] != null) return files[file];
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
    statfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 250_000, bfree: 300_000 }),
    ...overrides.host
  };
}

const size = (value) => JSON.stringify(value).length;

// system_overview

test('system_overview on macOS reads version, memory as Activity Monitor does, and APFS containers', async () => {
  const calls = [];
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(DARWIN, calls), host: stubHost() });
  const out = await tools.system_overview.execute({});

  assert.equal(out.os, 'macOS 26.6.2 (25G83)');
  assert.equal(out.kernel, 'Darwin 25.6.0');
  assert.equal(out.uptime, '1d 1h 1m');
  assert.deepEqual(out.cpu, { model: 'Apple M4', cores: 10, performanceCores: 4, efficiencyCores: 6 });
  assert.deepEqual(out.loadAverage, { '1m': 1.23, '5m': 2, '15m': 3.46 });
  // used = (anonymous - purgeable + wired + compressed) pages; os.freemem() alone would say 1 GB free.
  assert.deepEqual(out.memory, { totalGB: 16, freeGB: 5.6, usedPercent: 65, swapUsedGB: 1.8, pressure: 'normal' });
  // One row per container with its real usage; boot-only containers and pseudo mounts are gone.
  assert.deepEqual(out.disks, [
    { mount: '/', sizeGB: 245.1, usedGB: 161.9, freeGB: 83.2, usedPercent: 66 },
    { mount: '/Volumes/Backup Drive', sizeGB: 1000.2, usedGB: 512, freeGB: 488.2, usedPercent: 51 }
  ]);
  assert.deepEqual(out.topCpu.map((p) => p.pid), [4242, 406, 981, 1, 5000]);
  assert.deepEqual(out.topMemory.map((p) => p.pid), [981, 4242, 406, 5000, 1]);
  assert.equal(out.topMemory[0].rssMB, 976);
  assert.equal(out.processCount, 5);
  assert.equal(out.node, 'v22.0.0');
  assert.equal(out.shell, '/bin/zsh');
  assert.equal(out.notes, undefined, 'nothing failed, so no notes');

  // Install paths are dropped, arguments kept, secrets redacted.
  const commands = Object.fromEntries(out.topCpu.map((p) => [p.pid, p.command]));
  assert.equal(commands[406], 'WindowServer -daemon');
  assert.equal(commands[981], 'Big App Helper (Renderer) --type=renderer --lang=en-US');
  assert.equal(commands[4242], 'node server.js --api-key=[redacted]');
  assert.equal(commands[5000], 'python3 -m http.server 8000');
  assert.doesNotMatch(JSON.stringify(out), /sk-abcdef/);

  assert.ok(size(out) < 4000, `overview is ${size(out)} chars`);
  for (const call of calls) {
    assert.equal(call.opts.timeoutMs, COMMAND_TIMEOUT_MS, `${call.key} must be bounded`);
    assert.equal(call.opts.env.LC_ALL, 'C', 'numbers must parse in any locale');
    assert.match(call.opts.env.PATH, /\/usr\/sbin/, 'GUI launches lack sbin on PATH');
  }
});

test('system_overview on Linux uses os-release, df capacity, free for swap, and drops pseudo filesystems', async () => {
  const tools = createSystemTools({
    platform: 'linux', runCommand: stubRunner(LINUX), host: stubHost({ files: LINUX_FILES, host: { release: () => '6.8.0-45-generic' } })
  });
  const out = await tools.system_overview.execute({});
  assert.equal(out.os, 'Ubuntu 24.04.1 LTS');
  assert.equal(out.kernel, 'Linux 6.8.0-45-generic');
  assert.deepEqual(out.disks.map((d) => d.mount), ['/', '/data', '/boot/efi']);
  assert.deepEqual(out.disks[0], { mount: '/', sizeGB: 105.2, usedGB: 46.1, freeGB: 53.7, usedPercent: 47 });
  assert.equal(out.memory.swapUsedGB, 0.5);
  assert.equal(out.memory.freeGB, 1, 'Linux free memory is MemAvailable, straight from os.freemem()');
  const commands = Object.fromEntries(out.topCpu.map((p) => [p.pid, p.command]));
  assert.equal(commands[1], 'init splash');
  assert.equal(commands[812], 'nginx: worker process');
  assert.equal(commands[2001], 'node /srv/app/server.js --port 3000');
  assert.equal(commands[2], '[kthreadd]', 'kernel threads keep their bracketed name');
  assert.ok(out.notes.some((n) => /lifetime/.test(n)), 'Linux ps cpu% is a lifetime average and says so');
});

test('system_overview on Windows degrades: memory-only processes, statfs disks, no load average', async () => {
  const tools = createSystemTools({
    platform: 'win32',
    runCommand: stubRunner(WINDOWS),
    host: stubHost({ host: { version: () => 'Windows 11 Pro', release: () => '10.0.22631', shell: () => 'C:\\Windows\\system32\\cmd.exe' } })
  });
  const out = await tools.system_overview.execute({});
  assert.equal(out.os, 'Windows 11 Pro (build 10.0.22631)');
  assert.equal(out.loadAverage, null);
  assert.equal(out.topCpu, null);
  assert.deepEqual(out.topMemory.map((p) => p.command), ['chrome.exe', 'node.exe', 'svchost.exe', 'System Idle Process']);
  assert.equal(out.topMemory[0].rssMB, 200);
  assert.equal(out.topMemory[0].cpu, null);
  assert.equal(out.disks.length, 1);
  assert.deepEqual(
    { size: out.disks[0].sizeGB, free: out.disks[0].freeGB, pct: out.disks[0].usedPercent },
    { size: 4.1, free: 1, pct: 75 }
  );
  assert.equal(out.memory.usedPercent, 94);
  assert.ok(out.notes.some((n) => /Windows/.test(n)));
});

test('a missing or hung utility becomes a note, never a throw', async () => {
  const hung = Object.assign(new Error('ps timed out after 10000ms'), { code: null });
  const table = { ...DARWIN, 'ps -A -o pid=,user=,%cpu=,%mem=,rss=,etime=,comm=': hung };
  delete table['df -kP'];
  delete table.vm_stat;
  delete table.sw_vers;
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(table), host: stubHost() });
  const out = await tools.system_overview.execute({});
  assert.equal(out.os, 'macOS');
  assert.deepEqual(out.disks, []);
  assert.deepEqual(out.topMemory, []);
  const notes = out.notes.join('\n');
  assert.match(notes, /df is not available/);
  assert.match(notes, /vm_stat is not available/);
  assert.match(notes, /ps did not finish within 10s/);
  assert.match(notes, /sw_vers is not available/);
});

test('every tool survives a machine with none of the utilities', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const tools = createSystemTools({ platform, runCommand: stubRunner({}), host: stubHost() });
    const overview = await tools.system_overview.execute({});
    assert.equal(typeof overview.os, 'string', platform);
    const procs = await tools.list_processes.execute({});
    assert.match(procs.error, /Could not list processes/, platform);
    const net = await tools.network_overview.execute({});
    assert.ok(Array.isArray(net.interfaces), platform);
    assert.ok(Array.isArray(net.listening), platform);
    assert.equal(net.gateway, null, platform);
  }
});

// list_processes

test('list_processes sorts, filters, clamps the limit and keeps owner and run time', async () => {
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(DARWIN), host: stubHost() });

  const byMem = await tools.list_processes.execute({ sortBy: 'memory', limit: 2 });
  assert.equal(byMem.sortBy, 'memory');
  assert.equal(byMem.totalProcesses, 5);
  assert.deepEqual(byMem.processes.map((p) => p.pid), [981, 4242]);
  assert.deepEqual(Object.keys(byMem.processes[0]), ['pid', 'user', 'cpu', 'mem', 'rssMB', 'elapsed', 'command']);
  assert.equal(byMem.processes[0].elapsed, '01:02:03');

  const filtered = await tools.list_processes.execute({ filter: 'PYTHON' });
  assert.equal(filtered.matched, 1);
  assert.equal(filtered.processes[0].pid, 5000);

  const byUser = await tools.list_processes.execute({ filter: '_windowserver' });
  assert.deepEqual(byUser.processes.map((p) => p.pid), [406]);

  assert.equal((await tools.list_processes.execute({ limit: 500 })).processes.length, 5);
  assert.equal((await tools.list_processes.execute({ limit: 0 })).processes.length, 1);
  assert.equal((await tools.list_processes.execute({ limit: 'many' })).processes.length, 5);
  assert.equal((await tools.list_processes.execute({ sortBy: 'nonsense' })).sortBy, 'cpu');
});

test('list_processes truncates long command lines and stays small at the maximum limit', async () => {
  const stats = [];
  const argv = [];
  for (let pid = 100; pid < 160; pid += 1) {
    stats.push(`${pid} alice 1.0 0.1 1024 00:01 /opt/tool/bin/worker`);
    argv.push(`${pid} /opt/tool/bin/worker ${'--flag=value '.repeat(40)}`);
  }
  const table = {
    'ps -A -o pid=,user=,%cpu=,%mem=,rss=,etime=,comm=': stats.join('\n'),
    'ps -A -ww -o pid=,args=': argv.join('\n')
  };
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(table), host: stubHost() });
  const out = await tools.list_processes.execute({ limit: 50 });
  assert.equal(out.processes.length, 50);
  assert.ok(out.processes.every((p) => p.command.length <= 40 && p.command.endsWith('...')));
  assert.ok(size(out) < 6500, `50 rows is ${size(out)} chars`);
  const small = await tools.list_processes.execute({});
  assert.ok(size(small) < 3000, `default listing is ${size(small)} chars`);
});

test('list_processes on Windows falls back to memory order and says why', async () => {
  const tools = createSystemTools({ platform: 'win32', runCommand: stubRunner(WINDOWS), host: stubHost() });
  const out = await tools.list_processes.execute({ sortBy: 'cpu' });
  assert.equal(out.sortBy, 'memory');
  assert.match(out.notes[0], /CPU percent is not available/);
  assert.equal(out.processes[0].command, 'chrome.exe');
  assert.equal(out.processes[0].pid, 7777);
});

// network_overview

test('network_overview on macOS merges lsof and netstat and marks what is reachable', async () => {
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(DARWIN), host: stubHost() });
  const out = await tools.network_overview.execute({});
  assert.deepEqual(out.interfaces, [{ name: 'en0', ipv4: ['192.168.1.76/24'], ipv6: ['2601:1::5/64'] }]);
  assert.deepEqual(out.linkLocalOnly, ['utun0']);
  assert.deepEqual(out.gateway, { address: '192.168.1.1', interface: 'en0' });
  assert.deepEqual(out.dns, ['9.9.9.9', '1.1.1.1']);
  assert.deepEqual(out.listening, [
    { port: 22, address: '*', process: null, pid: null, exposure: 'network' },
    { port: 631, address: '127.0.0.1', process: null, pid: null, exposure: 'local' },
    { port: 4000, address: '127.0.0.1', process: 'node', pid: 4242, exposure: 'local' },
    { port: 5432, address: '127.0.0.1, ::1', process: 'postgres', pid: 1087, exposure: 'local' },
    { port: 7000, address: '*', process: 'ControlCenter', pid: 689, exposure: 'network' }
  ]);
  assert.equal(out.establishedConnections, 3);
  assert.match(out.notes[0], /sudo/);
});

test('network_overview on macOS reports a missing lsof and still lists netstat listeners', async () => {
  const table = { ...DARWIN };
  delete table['lsof -nP +c 0 -iTCP -sTCP:LISTEN -FpcLn'];
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(table), host: stubHost() });
  const out = await tools.network_overview.execute({});
  assert.deepEqual(out.listening.map((l) => l.port), [22, 631, 5432, 7000]);
  assert.ok(out.listening.every((l) => l.process === null), 'netstat knows ports, not owners');
  assert.ok(out.notes.some((n) => /lsof is not available/.test(n)));
});

test('network_overview on Linux reads ss, ip route and the systemd-resolved upstream servers', async () => {
  const tools = createSystemTools({ platform: 'linux', runCommand: stubRunner(LINUX), host: stubHost({ files: LINUX_FILES }) });
  const out = await tools.network_overview.execute({});
  assert.deepEqual(out.gateway, { address: '192.168.1.1', interface: 'eth0' });
  assert.deepEqual(out.dns, ['192.168.1.1', 'fd00::1', '1.1.1.1']);
  assert.equal(out.dnsVia, 'systemd-resolved');
  assert.deepEqual(out.listening, [
    { port: 22, address: '*', process: null, pid: null, exposure: 'network' },
    { port: 53, address: '127.0.0.53', process: null, pid: null, exposure: 'local' },
    { port: 80, address: '*', process: 'nginx', pid: 1200, exposure: 'network' },
    { port: 3000, address: '127.0.0.1', process: 'node', pid: 2001, exposure: 'local' }
  ]);
  assert.equal(out.establishedConnections, 4);
});

test('network_overview on Linux falls back to route -n and netstat when ip and ss are missing', async () => {
  const table = {
    'route -n': [
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface',
      '0.0.0.0         10.0.0.1        0.0.0.0         UG    100    0        0 ens3',
      ''
    ].join('\n'),
    'netstat -ltnp': [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      -',
      'tcp6       0      0 :::8080                 :::*                    LISTEN      3100/java',
      ''
    ].join('\n'),
    'netstat -tn': 'tcp 0 0 10.0.0.5:22 10.0.0.9:51000 ESTABLISHED\ntcp 0 0 10.0.0.5:22 10.0.0.9:51001 TIME_WAIT\n'
  };
  const files = { '/etc/resolv.conf': 'nameserver 10.0.0.2\nnameserver 10.0.0.3\n' };
  const tools = createSystemTools({ platform: 'linux', runCommand: stubRunner(table), host: stubHost({ files }) });
  const out = await tools.network_overview.execute({});
  assert.deepEqual(out.gateway, { address: '10.0.0.1', interface: 'ens3' });
  assert.deepEqual(out.dns, ['10.0.0.2', '10.0.0.3']);
  assert.equal(out.dnsVia, undefined);
  assert.deepEqual(out.listening.map((l) => [l.port, l.address, l.process]), [[22, '*', null], [8080, '*', 'java']]);
  assert.equal(out.establishedConnections, 1);
});

test('network_overview on Windows finds listeners by their port-0 peer and names them from tasklist', async () => {
  const tools = createSystemTools({ platform: 'win32', runCommand: stubRunner(WINDOWS), host: stubHost() });
  const out = await tools.network_overview.execute({});
  assert.deepEqual(out.gateway, { address: '192.168.1.1', interface: '192.168.1.50' });
  assert.deepEqual(out.dns, ['10.0.0.53'], 'Windows DNS comes from the resolver config');
  assert.deepEqual(out.listening, [
    { port: 135, address: '*', process: 'svchost.exe', pid: 1012, exposure: 'network' },
    { port: 4000, address: '*', process: 'node.exe', pid: 5555, exposure: 'network' }
  ]);
  assert.equal(out.establishedConnections, 1);
  assert.equal(out.notes, undefined, 'Windows shows every owner without elevation here');
});

test('network_overview caps the listener list and shows loopback when it is all there is', async () => {
  const lsof = [];
  for (let i = 0; i < 40; i += 1) lsof.push(`p${1000 + i}`, `csvc${i}`, `n127.0.0.1:${9000 + i}`);
  const table = { ...DARWIN, 'lsof -nP +c 0 -iTCP -sTCP:LISTEN -FpcLn': lsof.join('\n'), 'netstat -an -p tcp': '' };
  const host = stubHost({ interfaces: { lo0: IFACES.lo0 } });
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner(table), host });
  const out = await tools.network_overview.execute({});
  assert.equal(out.listening.length, 30);
  assert.equal(out.listeningNotShown, 10);
  assert.deepEqual(out.interfaces, [{ name: 'lo0', ipv4: ['127.0.0.1/8'], ipv6: ['::1/128'] }]);
  assert.ok(size(out) < 4000, `capped network overview is ${size(out)} chars`);
});

// read_log and tailTextFile

const made = [];
after(() => Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-systools-'));
  made.push(dir);
  return dir;
}

test('read_log returns the newest lines in order, filters any case, and redacts secrets', async () => {
  const dir = await tempDir();
  const lines = [];
  for (let i = 1; i <= 500; i += 1) lines.push(i % 100 === 0 ? `${i} ERROR disk full` : `${i} ok`);
  lines.push('501 Authorization: Bearer abcdefghijklmnop0123');
  await fs.writeFile(path.join(dir, 'app.log'), `${lines.join('\n')}\n`);
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });

  const tail = await tools.read_log.execute({ path: path.join(dir, 'app.log'), lines: 3 });
  assert.equal(tail.text, '499 ok\n500 ERROR disk full\n501 Authorization: [redacted]');
  assert.equal(tail.shown, 3);
  assert.equal(tail.scope, 'last 3 lines');
  assert.equal(tail.path, path.join(dir, 'app.log'));

  const errors = await tools.read_log.execute({ path: path.join(dir, 'app.log'), lines: 2000, filter: 'error' });
  assert.equal(errors.matched, 5);
  assert.equal(errors.text.split('\n')[0], '100 ERROR disk full');
  assert.match(errors.scope, /filtered by "error"/);
});

test('read_log resolves relative paths against the work folder and expands ~', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'rel.log'), 'hello\n');
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost(), workDir: dir });
  assert.equal((await tools.read_log.execute({ path: 'rel.log' })).text, 'hello');
  await assert.rejects(
    tools.read_log.execute({ path: '~/mirabilis-no-such-log-7f3a.log' }),
    (err) => err.message === `No such file: ${path.join(os.homedir(), 'mirabilis-no-such-log-7f3a.log')}`
  );
});

test('read_log refuses binaries, folders and missing files with plain reasons', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x0a, 0x41]));
  const tools = createSystemTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() });
  await assert.rejects(tools.read_log.execute({ path: path.join(dir, 'blob.bin') }), /binary file/);
  await assert.rejects(tools.read_log.execute({ path: dir }), /not a regular file/);
  await assert.rejects(tools.read_log.execute({ path: path.join(dir, 'gone.log') }), /No such file/);
  await assert.rejects(tools.read_log.execute({}), /path is required/);
});

const canDropPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;
test('read_log names the exact command when a log needs more rights', { skip: !canDropPermissions }, async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'locked.log');
  await fs.writeFile(file, 'private\n');
  await fs.chmod(file, 0o000);
  try {
    const tools = createSystemTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() });
    await assert.rejects(
      tools.read_log.execute({ path: file, lines: 50 }),
      (err) => err.message === `Permission denied reading ${file}. The user can run: sudo tail -n 50 "${file}"`
    );
  } finally {
    await fs.chmod(file, 0o600);
  }
});

test('read_log honours the operator jail', async () => {
  const dir = await tempDir();
  const inside = path.join(dir, 'jail');
  await fs.mkdir(inside);
  await fs.writeFile(path.join(dir, 'outside.log'), 'secret\n');
  await fs.writeFile(path.join(inside, 'ok.log'), 'fine\n');
  const prev = process.env.MIRABILIS_MCP_FS_ROOT;
  process.env.MIRABILIS_MCP_FS_ROOT = inside;
  try {
    const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
    assert.equal((await tools.read_log.execute({ path: path.join(inside, 'ok.log') })).text, 'fine');
    await assert.rejects(tools.read_log.execute({ path: path.join(dir, 'outside.log') }), /escapes the permitted filesystem root/);
  } finally {
    if (prev === undefined) delete process.env.MIRABILIS_MCP_FS_ROOT;
    else process.env.MIRABILIS_MCP_FS_ROOT = prev;
  }
});

test('read_log keeps its output under the observation limit and says what it left out', async () => {
  const dir = await tempDir();
  const long = Array.from({ length: 300 }, (_, i) => `${i} ${'x'.repeat(500)}`).join('\n');
  await fs.writeFile(path.join(dir, 'wide.log'), long);
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  const out = await tools.read_log.execute({ path: path.join(dir, 'wide.log') });
  assert.equal(out.linesRead, 200);
  assert.ok(out.shown > 0 && out.shown < 200);
  assert.equal(out.truncated, true);
  assert.match(out.note, /Showing the newest \d+ of 200 lines/);
  assert.ok(out.text.split('\n').every((l) => l.length <= 400), 'each line is clipped');
  assert.ok(out.text.endsWith('...'), 'the newest line is the one kept');
  assert.ok(out.text.split('\n').pop().startsWith('299 '));
  assert.ok(size(out) < 4000, `read_log is ${size(out)} chars`);
});

test('tailTextFile decodes multibyte text across chunk edges and strips color codes', async () => {
  const dir = await tempDir();
  const expected = [];
  for (let i = 0; i < 4000; i += 1) expected.push(`${i} caf\u00e9 \u4e2d\u6587 \u{1F600} end`);
  const file = path.join(dir, 'utf8.log');
  await fs.writeFile(file, `${expected.join('\r\n')}\r\n\x1b[31mlast\x1b[0m`);
  const out = await tailTextFile(file, { lines: 2000, budget: 10_000_000 });
  const got = out.text.split('\n');
  assert.equal(got.length, 2000);
  assert.deepEqual(got.slice(0, -1), expected.slice(-1999));
  assert.equal(got[got.length - 1], 'last');
  assert.doesNotMatch(out.text, /\uFFFD/);
});

test('tailTextFile handles empty files and refuses non-regular files before opening them', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'empty.log'), '');
  const empty = await tailTextFile(path.join(dir, 'empty.log'));
  assert.equal(empty.text, '');
  assert.equal(empty.shown, 0);
  await assert.rejects(tailTextFile(dir), /not a regular file/);
});

test('scrub removes the credential shapes plain redact misses, and leaves counts alone', () => {
  const cases = [
    ['Authorization: Bearer abcdefghijklmnop0123', 'Authorization: [redacted]'],
    ['{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}', '{"authorization":"[redacted]"}'],
    ['curl -H "X: 1" Bearer abcdefghijklmnop0123', 'curl -H "X: 1" Bearer [redacted]'],
    ['GET /cb?access_token=abcdef123456&x=1', 'GET /cb?access_token=[redacted]&x=1'],
    ['{"client_secret":"s3cr3tvalue99"}', '{"client_secret":"[redacted]"}'],
    ['https://bob:hunter2pass@git.example.com/repo.git', 'https://bob:[redacted]@git.example.com/repo.git'],
    ['key sk-abcdefghijklmnopqrstuvwx in a sentence', 'key [redacted] in a sentence'],
    ['promptTokens 123456 maxTokens=4000 tokenizer=bpe', 'promptTokens 123456 maxTokens=4000 tokenizer=bpe']
  ];
  for (const [input, expected] of cases) assert.equal(scrub(input), expected, input);
});

test('formatDuration reads like a person wrote it', () => {
  assert.equal(formatDuration(42), '0m 42s');
  assert.equal(formatDuration(3_725), '1h 2m');
  assert.equal(formatDuration(90_061), '1d 1h 1m');
  assert.equal(formatDuration(-5), '0m 0s');
});

test('tools are read-only with descriptions and parameter docs', () => {
  const tools = createSystemTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  assert.deepEqual(Object.keys(tools).sort(), ['list_processes', 'network_overview', 'read_log', 'system_overview']);
  for (const [name, tool] of Object.entries(tools)) {
    assert.equal(tool.kind, 'read', name);
    assert.equal(tool.mutating, false, name);
    assert.equal(typeof tool.description, 'string', name);
    assert.equal(typeof tool.execute, 'function', name);
    for (const doc of Object.values(tool.parameters)) assert.equal(typeof doc, 'string', name);
  }
  assert.match(tools.read_log.description, /log show/, 'macOS points at the unified log');
  assert.match(createSystemTools({ platform: 'linux' }).read_log.description, /journalctl/);
});

// The real thing, on the machine running the tests. Shape and size only.
test('the tools run for real on this machine within their size budget', { skip: process.platform === 'win32' }, async () => {
  const tools = createSystemTools();
  const overview = await tools.system_overview.execute({});
  assert.equal(typeof overview.os, 'string');
  assert.ok(overview.memory.totalGB > 0);
  assert.ok(size(overview) < 6000, `overview is ${size(overview)} chars`);
  const procs = await tools.list_processes.execute({ limit: 5 });
  assert.ok(procs.processes.length > 0, 'at least this test process is running');
  assert.ok(procs.processes.length <= 5);
  const net = await tools.network_overview.execute({});
  assert.ok(Array.isArray(net.interfaces) && Array.isArray(net.listening));
  assert.ok(size(net) < 6000, `network overview is ${size(net)} chars`);
});
