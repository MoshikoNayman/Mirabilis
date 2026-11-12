import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  createMachineTools, fitResult, formatBytes, groupLogEntries, machineRunner, parseHost, parseJournal,
  parseLaunchctlDisabled, parseLaunchctlList, parseLaunchctlPrint, parseLaunchdPlist, parseMacLog, parsePing,
  parsePingReplies, parseSystemctlUnits, parseWinEvents, RESULT_BUDGET
} from './machineTools.js';
import { createProbeRunner } from '../agent/systemTools.js';

// Log lines print in local time; the journal and the event log carry absolute times.
process.env.TZ = 'UTC';

const TOOL_NAMES = [
  'system_overview', 'list_processes', 'network_overview', 'read_log', 'disk_usage', 'system_logs',
  'services', 'startup_items', 'hardware_info', 'ping_host', 'dns_lookup', 'check_port', 'kill_process'
];

// Linux pseudo filesystems, spelled so no literal path appears in a test file.
const PROC = ['', 'proc'].join('/');
const SYS = ['', 'sys', 'class'].join('/');
const DOT = String.fromCodePoint(0x25cf);

// Helpers

const made = [];
after(() => Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-machine-'));
  made.push(dir);
  return dir;
}

/**
 * Answers from a table keyed by the full command line, or from a function; anything else
 * is "not installed". An entry is stdout, an Error, or {stdout, stderr, code, dropped}.
 */
function stubRunner(table, calls = []) {
  return async (command, args, opts) => {
    const key = [command, ...args].join(' ');
    calls.push({ command, args, key, opts });
    const entry = typeof table === 'function' ? table(command, args, opts) : table[key];
    if (entry === undefined) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'string') return { stdout: entry, stderr: '' };
    const { stdout = '', stderr = '', code = 0, dropped = 0 } = entry;
    if (code) throw Object.assign(new Error(`Command failed: ${key}\n${stderr}`), { code, exitCode: code, stdout, stderr, dropped });
    return { stdout, stderr, dropped };
  };
}

/** The script a PowerShell call ran. */
function psScript(args) {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
}

/** PowerShell answers keyed by a word the script contains; other commands from `table`. */
function windowsRunner(scripts, table = {}, calls = []) {
  return stubRunner((command, args) => {
    if (/powershell\.exe$/i.test(command)) {
      const script = psScript(args);
      const hit = Object.keys(scripts).find((marker) => script.includes(marker));
      if (!hit) return undefined;
      const value = scripts[hit];
      return typeof value === 'string' || value instanceof Error || (value && 'stdout' in value) ? value : JSON.stringify(value);
    }
    return table[[command, ...args].join(' ')];
  }, calls);
}

/** Dirent-like entries for a stubbed readdir. */
function dirents(names, { dirs = [] } = {}) {
  return names.map((name) => ({
    name,
    isDirectory: () => dirs.includes(name),
    isFile: () => !dirs.includes(name),
    isSymbolicLink: () => false
  }));
}

/** A host whose files and folders come from tables; anything missing is ENOENT. */
function stubHost({ files = {}, dirs = {}, ...rest } = {}) {
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    homedir: () => '/Users/alice',
    cpus: () => Array.from({ length: 10 }, () => ({ model: 'Apple M4', speed: 0, times: {} })),
    totalmem: () => 16 * 1024 ** 3,
    uid: () => 501,
    env: () => undefined,
    readText: async (file) => {
      const v = files[file];
      if (v === undefined) throw missing(file);
      if (v instanceof Error) throw v;
      return v;
    },
    readdir: async (dir) => {
      const v = dirs[dir];
      if (v === undefined) throw missing(dir);
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? dirents(v) : v;
    },
    ...rest
  };
}

const json = (r) => JSON.parse(r.content[0].text);
const textOf = (r) => r.content[0].text;
const fits = (text) => text.length <= RESULT_BUDGET && JSON.stringify(text).length <= 3_900;

// Fixtures: real command output, trimmed.

const DARWIN_LAUNCHCTL_LIST = [
  'PID\tStatus\tLabel',
  '-\t0\tcom.apple.SafariHistoryServiceAgent',
  '-\t-9\tcom.apple.progressd',
  '691\t0\tcom.apple.Finder',
  '-\t78\tcom.example.broken',
  '-\t-11\tcom.example.crashy',
  '4242\t0\thomebrew.mxcl.postgresql@18',
  '-\t0\torg.virtualbox.vboxwebsvc',
  ''
].join('\n');

const DARWIN_LAUNCHCTL_SYSTEM = [
  'system = {',
  '\ttype = system',
  '\thandle = 0',
  '\tactive count = 1036',
  '\tservice count = 426',
  '\tservices = {',
  '\t\t       0      - \tcom.apple.lskdd',
  '\t\t     415      - \tcom.apple.runningboardd',
  '\t\t       0      1 \tcom.apple.wifiFirmwareLoader',
  '\t\t       0   (pe) \tcom.apple.kernelmanager_helper',
  '\t\t       0    -15 \tcom.microsoft.OneDriveStandaloneUpdaterDaemon',
  '\t\t     812      - \tcom.vix.cron',
  '\t}',
  '',
  '\tunmanaged processes = {',
  '\t\t\tactive count = 3',
  '\t}',
  '}',
  ''
].join('\n');

const DARWIN_DISABLED_USER = [
  '',
  '\tdisabled services = {',
  '\t\t"com.apple.ScriptMenuApp" => disabled',
  '\t\t"org.virtualbox.vboxwebsvc" => disabled',
  '\t\t"homebrew.mxcl.postgresql@18" => enabled',
  '\t}',
  ''
].join('\n');

const DARWIN_DISABLED_SYSTEM = '\tdisabled services = {\n\t\t"com.vix.cron" => enabled\n\t\t"com.example.legacy" => true\n\t}\n';

const plist = (body) => [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  body,
  '</dict>',
  '</plist>',
  ''
].join('\n');

const PLIST_POSTGRES = plist([
  '  <key>KeepAlive</key>', '  <true/>',
  '  <key>Label</key>', '  <string>homebrew.mxcl.postgresql@18</string>',
  '  <key>ProgramArguments</key>', '  <array>',
  '    <string>/opt/homebrew/opt/postgresql@18/bin/postgres</string>', '    <string>-D</string>',
  '    <string>/opt/homebrew/var/postgresql@18</string>', '  </array>',
  '  <key>RunAtLoad</key>', '  <true/>'
].join('\n'));

const PLIST_VBOX = plist([
  '  <key>Label</key>', '  <string>org.virtualbox.vboxwebsvc</string>',
  '  <key>Program</key>', '  <string>/Applications/VirtualBox.app/Contents/MacOS/vboxwebsrv</string>',
  '  <key>RunAtLoad</key>', '  <false/>'
].join('\n'));

const PLIST_ZOOM = plist([
  '  <key>Label</key>', '  <string>us.zoom.updater</string>',
  '  <key>ProgramArguments</key>', '  <array>',
  '    <string>/Library/Application Support/zoom.us/ZoomUpdater.app/Contents/MacOS/ZoomUpdater</string>',
  '    <string>--update</string>', '    <string>--token=sk-abcdefghijklmnopqrstuvwxyz123456</string>', '  </array>',
  '  <key>StartCalendarInterval</key>', '  <dict><key>Hour</key><integer>3</integer></dict>'
].join('\n'));

const PLIST_CRON = plist([
  '  <key>Label</key>', '  <string>com.vix.cron</string>',
  '  <key>ProgramArguments</key>', '  <array><string>/usr/sbin/cron</string></array>',
  '  <key>QueueDirectories</key>', '  <array><string>/usr/lib/cron/tabs</string></array>'
].join('\n'));

const DARWIN_LOG = [
  'Timestamp               Ty Process[PID:TID]',
  '2026-11-11 22:55:02.888 E  identityservicesd[647:49c12c] [com.apple.network:] nw_path_flow_registration_get_stats_area Requested stats type does not match allocated type (2 != 3)',
  '2026-11-11 22:55:03.001 E  identityservicesd[647:49c12d] [com.apple.network:] nw_path_flow_registration_get_stats_area Requested stats type does not match allocated type (2 != 3)',
  '2026-11-11 22:55:05.956 E  kernel[0:49bfd3] (Sandbox) Sandbox: swcd(818) deny(1) system-fsctl (_IO "h" 47)',
  '2026-11-11 22:55:06.100 F  Google Chrome Helper (Renderer)[981:1a2b] [com.google.Chrome:gpu] GPU process crashed',
  'with a second line of detail',
  '2026-11-11 22:59:53.073 E  backupd[513:49cd8f] [com.apple.TimeMachine:General] com.apple.backupd.sandbox.xpc: connection invalid',
  '2026-11-11 22:59:58.880 E  PerfPowerServices[61047:49d4b4] [com.apple.PerfPowerServices:smcmetrics] SMCGetKeyInfo error: -3',
  '2026-11-11 22:59:59.928 E  identityservicesd[647:49d12d] [com.apple.network:] nw_path_flow_registration_get_stats_area Requested stats type does not match allocated type (2 != 3)',
  ''
].join('\n');

// system_profiler -json -detailLevel mini, from an M4 MacBook Air.
const PROFILER_APPLE = {
  SPDisplaysDataType: [{
    _name: 'Apple M4',
    spdisplays_mtlgpufamilysupport: 'spdisplays_metal4',
    spdisplays_ndrvs: [{
      _name: 'Color LCD',
      '_spdisplays_display-product-id': 'a063',
      _spdisplays_pixels: '2940 x 1912',
      _spdisplays_resolution: '1470 x 956 @ 60.00Hz',
      spdisplays_connection_type: 'spdisplays_internal',
      spdisplays_display_type: 'spdisplays_built-in-liquid-retina',
      spdisplays_main: 'spdisplays_yes',
      spdisplays_online: 'spdisplays_yes',
      spdisplays_pixelresolution: 'spdisplays_2560x1664Retina'
    }],
    spdisplays_vendor: 'sppci_vendor_Apple',
    sppci_bus: 'spdisplays_builtin',
    sppci_cores: '8',
    sppci_device_type: 'spdisplays_gpu',
    sppci_model: 'Apple M4'
  }],
  SPHardwareDataType: [{
    _name: 'hardware_overview',
    boot_rom_version: '18000.161.10',
    chip_type: 'Apple M4',
    machine_model: 'Mac16,12',
    machine_name: 'MacBook Air',
    model_number: 'MW0W3LL/A',
    number_processors: 'proc 10:4:6:0',
    os_loader_version: '18000.161.10',
    physical_memory: '16 GB'
  }]
};

// An Intel MacBook Pro with switchable graphics and an external display.
const PROFILER_INTEL = {
  SPDisplaysDataType: [
    {
      _name: 'kHW_IntelUHDGraphics630Item',
      spdisplays_vram_shared: '1536 MB',
      spdisplays_vendor: 'sppci_vendor_intel',
      sppci_device_type: 'spdisplays_gpu',
      sppci_model: 'Intel UHD Graphics 630'
    },
    {
      _name: 'kHW_AMDRadeonPro5500MItem',
      spdisplays_metal: 'spdisplays_metal3',
      spdisplays_vendor: 'sppci_vendor_amd',
      spdisplays_vram: '4 GB',
      sppci_device_type: 'spdisplays_gpu',
      sppci_model: 'AMD Radeon Pro 5500M',
      spdisplays_ndrvs: [
        {
          _name: 'Color LCD',
          _spdisplays_pixels: '3072 x 1920',
          _spdisplays_resolution: '1536 x 960 @ 60.00Hz',
          spdisplays_connection_type: 'spdisplays_internal',
          spdisplays_main: 'spdisplays_yes'
        },
        { _name: 'DELL U2720Q', _spdisplays_pixels: '3840 x 2160', _spdisplays_resolution: '1920 x 1080 @ 60.00Hz' }
      ]
    }
  ],
  SPHardwareDataType: [{
    machine_name: 'MacBook Pro',
    machine_model: 'MacBookPro16,1',
    cpu_type: '8-Core Intel Core i9',
    current_processor_speed: '2.3 GHz',
    number_processors: 8,
    packages: 1,
    physical_memory: '32 GB'
  }]
};

const DARWIN_DF = [
  'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk3s1s1   239362496  12341400  81244320    14%    /',
  'devfs                  201       201         0   100%    /dev',
  '/dev/disk3s5     239362496 132395908  81244320    62%    /System/Volumes/Data',
  '/dev/disk5s1     976762584 500000000 476762584    52%    /Volumes/Backup Drive',
  ''
].join('\n');

const PING_DARWIN = [
  'PING 127.0.0.1 (127.0.0.1): 56 data bytes',
  '64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.068 ms',
  '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.166 ms',
  '',
  '--- 127.0.0.1 ping statistics ---',
  '2 packets transmitted, 2 packets received, 0.0% packet loss',
  'round-trip min/avg/max/stddev = 0.068/0.117/0.166/0.049 ms',
  ''
].join('\n');

const PING6_DARWIN = [
  'PING6(56=40+8+8 bytes) ::1 --> ::1',
  '16 bytes from ::1, icmp_seq=0 hlim=64 time=0.120 ms',
  '',
  '--- ::1 ping6 statistics ---',
  '1 packets transmitted, 1 packets received, 0.0% packet loss',
  'round-trip min/avg/max/std-dev = 0.120/0.120/0.120/0.000 ms',
  ''
].join('\n');

const PING_DARWIN_LOSS = [
  'PING 10.0.0.99 (10.0.0.99): 56 data bytes',
  'Request timeout for icmp_seq 0',
  '',
  '--- 10.0.0.99 ping statistics ---',
  '2 packets transmitted, 0 packets received, 100.0% packet loss',
  ''
].join('\n');

const PING_LINUX = [
  'PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.',
  '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.033 ms',
  '64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.041 ms',
  '',
  '--- 127.0.0.1 ping statistics ---',
  '2 packets transmitted, 2 received, 0% packet loss, time 1001ms',
  'rtt min/avg/max/mdev = 0.033/0.037/0.041/0.004 ms',
  ''
].join('\n');

const PING_LINUX_V6 = [
  'PING ::1(::1) 56 data bytes',
  '64 bytes from ::1: icmp_seq=1 ttl=64 time=0.045 ms',
  '',
  '--- ::1 ping statistics ---',
  '1 packets transmitted, 1 received, 0% packet loss, time 0ms',
  'rtt min/avg/max/mdev = 0.045/0.045/0.045/0.000 ms',
  ''
].join('\n');

const PING_BUSYBOX = [
  'PING 10.0.0.1 (10.0.0.1): 56 data bytes',
  '64 bytes from 10.0.0.1: seq=0 ttl=64 time=0.297 ms',
  '',
  '--- 10.0.0.1 ping statistics ---',
  '1 packets transmitted, 1 packets received, 0% packet loss',
  'round-trip min/avg/max = 0.297/0.297/0.297 ms',
  ''
].join('\n');

const PING_WINDOWS = [
  '',
  'Pinging 127.0.0.1 with 32 bytes of data:',
  'Reply from 127.0.0.1: bytes=32 time<1ms TTL=128',
  'Reply from 127.0.0.1: bytes=32 time=1ms TTL=128',
  '',
  'Ping statistics for 127.0.0.1:',
  '    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),',
  'Approximate round trip times in milli-seconds:',
  '    Minimum = 0ms, Maximum = 1ms, Average = 0ms',
  ''
].join('\r\n');

// Windows counts "Destination host unreachable" as a reply in its own statistics.
const PING_WINDOWS_UNREACHABLE = [
  '',
  'Pinging 192.168.1.250 with 32 bytes of data:',
  'Reply from 192.168.1.50: Destination host unreachable.',
  'Request timed out.',
  '',
  'Ping statistics for 192.168.1.250:',
  '    Packets: Sent = 2, Received = 1, Lost = 1 (50% loss),',
  ''
].join('\r\n');

// German Windows wraps the packet line; the umlauts arrive mangled in the console code page.
const PING_WINDOWS_GERMAN = [
  '',
  'Ping wird ausgef?hrt f?r localhost [::1] mit 32 Bytes Daten:',
  'Antwort von ::1: Zeit<1ms',
  'Antwort von ::1: Zeit=2ms',
  '',
  'Ping-Statistik f?r ::1:',
  '    Pakete: Gesendet = 2, Empfangen = 2, Verloren = 0',
  '    (0% Verlust),',
  'Ca. Zeitangaben in Millisek.:',
  '    Minimum = 0ms, Maximum = 2ms, Mittelwert = 1ms',
  ''
].join('\r\n');

const at = (s) => String(Date.UTC(2026, 10, 11, 22, 55, s) * 1000);
const JOURNAL = [
  { __REALTIME_TIMESTAMP: at(2), PRIORITY: '3', _TRANSPORT: 'kernel', SYSLOG_IDENTIFIER: 'kernel', MESSAGE: 'nvme nvme0: I/O 12 QID 3 timeout, aborting' },
  { __REALTIME_TIMESTAMP: at(3), PRIORITY: '3', _PID: '812', _COMM: 'nginx', SYSLOG_IDENTIFIER: 'nginx', MESSAGE: '2026/11/11 22:55:03 [emerg] 812#812: bind() to 0.0.0.0:80 failed (98: Address already in use)' },
  { __REALTIME_TIMESTAMP: at(4), PRIORITY: '2', _PID: '1', SYSLOG_IDENTIFIER: 'systemd', MESSAGE: 'Failed to start nginx.service - A high performance web server.' },
  { __REALTIME_TIMESTAMP: at(5), PRIORITY: '3', _PID: '2001', _COMM: 'node', MESSAGE: [104, 105, 32, 98, 121, 116, 101, 115] },
  { __REALTIME_TIMESTAMP: at(6), PRIORITY: '3', _PID: '812', _COMM: 'nginx', SYSLOG_IDENTIFIER: 'nginx', MESSAGE: '2026/11/11 22:55:06 [emerg] 812#812: bind() to 0.0.0.0:80 failed (98: Address already in use)' }
].map((e) => JSON.stringify(e)).join('\n');

const JOURNAL_HINT = 'Hint: You are currently not seeing messages from other users and the system.\n'
  + "      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n";

const LINUX_UNITS = [
  '  accounts-daemon.service      loaded    active   running Accounts Service',
  '  apparmor.service             loaded    active   exited  Load AppArmor profiles',
  `${DOT} certbot.service              loaded    failed   failed  Certbot`,
  '  cron.service                 loaded    active   running Regular background program processing daemon',
  '  plymouth-quit-wait.service   not-found inactive dead    plymouth-quit-wait.service',
  '  ssh.service                  loaded    inactive dead    OpenBSD Secure Shell server',
  `${DOT} nginx.service              loaded    failed   failed  A high performance web server and a reverse proxy server`,
  ''
].join('\n');

const LINUX_UNIT_FILES = [
  'cron.service                       enabled enabled',
  'nginx.service                      enabled enabled',
  'ssh.socket                         enabled enabled',
  'apt-daily.timer                    enabled enabled',
  'multi-user.target                  enabled enabled',
  'getty@.service                     enabled enabled',
  ''
].join('\n');

const LSCPU = [
  'Architecture:                       x86_64',
  '  CPU op-mode(s):                   32-bit, 64-bit',
  '  Address sizes:                    39 bits physical, 48 bits virtual',
  '  Byte Order:                       Little Endian',
  'CPU(s):                             8',
  '  On-line CPU(s) list:              0-7',
  'Vendor ID:                          GenuineIntel',
  '  Model name:                       Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz',
  '    CPU family:                     6',
  '    Model:                          142',
  '    Thread(s) per core:             2',
  '    Core(s) per socket:             4',
  '    Socket(s):                      1',
  '    Stepping:                       10',
  '    CPU max MHz:                    4200.0000',
  '    CPU min MHz:                    400.0000',
  ''
].join('\n');

const LSPCI = [
  '00:00.0 Host bridge: Intel Corporation Xeon E3-1200 v6/7th Gen Core Processor Host Bridge/DRAM Registers (rev 08)',
  '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620 (rev 07)',
  '01:00.0 3D controller: NVIDIA Corporation GP108M [GeForce MX150] (rev a1)',
  '02:00.0 Network controller: Intel Corporation Wireless 8265 / 8275 (rev 78)',
  ''
].join('\n');

const LINUX_HW_FILES = {
  [`${PROC}/meminfo`]: 'MemTotal:       16318436 kB\nMemFree:         8000000 kB\nSwapTotal:       2097148 kB\n',
  [`${SYS}/dmi/id/sys_vendor`]: 'LENOVO\n',
  [`${SYS}/dmi/id/product_name`]: '20L8S02E00\n',
  [`${SYS}/dmi/id/product_version`]: 'ThinkPad T480s\n',
  [`${SYS}/drm/card0-eDP-1/status`]: 'connected\n',
  [`${SYS}/drm/card0-eDP-1/modes`]: '1920x1080\n1680x1050\n',
  [`${SYS}/drm/card0-HDMI-A-1/status`]: 'connected\n',
  [`${SYS}/drm/card0-HDMI-A-1/modes`]: '3840x2160\n',
  [`${SYS}/drm/card0-DP-1/status`]: 'disconnected\n'
};

const WIN_EVENTS = [
  { time: '2026-11-11T22:59:58.1234567+00:00', level: 2, source: 'Microsoft-Windows-DistributedCOM', id: 10016, message: 'The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID' },
  { time: '2026-11-11T22:58:00.0000000+00:00', level: 2, source: 'Microsoft-Windows-DistributedCOM', id: 10016, message: 'The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID' },
  { time: '2026-11-11T22:55:00.0000000+00:00', level: 1, source: 'Microsoft-Windows-Kernel-Power', id: 41, message: 'The system has rebooted without cleanly shutting down first.' },
  { time: '2026-11-11T22:54:00.0000000+00:00', level: 2, source: 'Application Error', id: 1000, message: 'Faulting application name: chrome.exe, version: 119.0.6045.160' },
  { time: '2026-11-11T22:53:00.0000000+00:00', level: 2, source: 'Service Control Manager', id: 7031, message: '' }
];

const WIN_SERVICES = [
  { name: 'Spooler', display: 'Print Spooler', state: 'Running', start: 'Auto', pid: 2468, exit: 0 },
  { name: 'wuauserv', display: 'Windows Update', state: 'Stopped', start: 'Manual', pid: 0, exit: 0 },
  { name: 'BrokenSvc', display: 'Broken Vendor Service', state: 'Stopped', start: 'Auto', pid: 0, exit: 1067 },
  { name: 'gupdate', display: 'Google Update Service', state: 'Stopped', start: 'Auto', pid: 0, exit: 0 },
  { name: 'NeverStarted', display: 'Never Started', state: 'Stopped', start: 'Auto', pid: 0, exit: 1077 },
  { name: 'Pending', display: 'Pending Service', state: 'Start Pending', start: 'Auto', pid: 3333, exit: 0 }
];

const WIN_STARTUP = {
  items: [
    { name: 'OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', location: 'HKU\\S-1-5-21-1-2-3-1001\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', user: 'DESKTOP\\alice' },
    { name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe', location: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', user: 'Public' },
    { name: 'Send to OneNote', command: 'Send to OneNote.lnk', location: 'Startup', user: 'DESKTOP\\alice' },
    { name: 'Updater', command: 'C:\\Tools\\updater.exe --api-key=sk-abcdefghijklmnopqrstuvwx', location: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce', user: 'Public' }
  ],
  off: ['Send to OneNote.lnk', 'Updater']
};

const WIN_HARDWARE = {
  maker: 'Dell Inc.',
  model: 'XPS 15 9520',
  memory: 34_093_965_312,
  cpu: [{ name: '12th Gen Intel(R) Core(TM) i7-12700H', cores: 14, threads: 20, mhz: 2300 }],
  gpu: [
    { name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', vram: 4_294_967_296, driver: '31.0.15.3623', width: 0, height: 0, hz: 0 },
    { name: 'Intel(R) Iris(R) Xe Graphics', vram: 2_147_483_648, driver: '31.0.101.4502', width: 3456, height: 2160, hz: 60 }
  ]
};

const WIN_VOLUMES = [
  { id: 'C:', type: 3, size: 511_101_108_224, free: 123_456_789_012, label: 'Windows' },
  { id: 'D:', type: 2, size: 64_000_000_000, free: 60_000_000_000, label: 'USB' },
  { id: 'Z:', type: 4, size: 2_000_000_000_000, free: 1_000_000_000_000, label: '' }
];

// The tool table

test('the server offers the 13 tools with JSON schemas, one-sentence descriptions and honest annotations', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { tools } = createMachineTools({ platform, runCommand: stubRunner({}), host: stubHost() });
    assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES, platform);
    for (const t of tools) {
      assert.deepEqual(Object.keys(t).sort(), ['annotations', 'description', 'inputSchema', 'name', 'title'], t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(typeof t.inputSchema.properties, 'object', t.name);
      for (const key of t.inputSchema.required || []) assert.ok(key in t.inputSchema.properties, `${t.name}.${key}`);
      for (const [key, prop] of Object.entries(t.inputSchema.properties)) {
        assert.ok(['string', 'integer', 'boolean'].includes(prop.type), `${t.name}.${key}`);
        assert.match(prop.description, /^[A-Z~].*\.$/, `${t.name}.${key} is documented`);
      }
      // One short sentence the model reads, ASCII only.
      assert.match(t.description, /^[A-Za-z][^\n]*\.$/, t.name);
      assert.doesNotMatch(t.description.slice(0, -1), /\.\s/, `${t.name} is one sentence`);
      assert.ok(t.description.length <= 140, `${t.name} description is ${t.description.length} characters`);
      assert.match(JSON.stringify(t), /^[\x20-\x7e]*$/, `${t.name} is ASCII`);
      const a = t.annotations;
      if (t.name === 'kill_process') {
        assert.equal(a.readOnlyHint, false);
        assert.equal(a.destructiveHint, true);
      } else {
        assert.equal(a.readOnlyHint, true, t.name);
      }
      assert.equal(a.openWorldHint, ['ping_host', 'dns_lookup', 'check_port'].includes(t.name), `${t.name} openWorldHint`);
    }
  }
  const { tools } = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.read_log.inputSchema.required, ['path']);
  assert.deepEqual(byName.ping_host.inputSchema.required, ['host']);
  assert.deepEqual(byName.check_port.inputSchema.required, ['host', 'port']);
  assert.deepEqual(byName.kill_process.inputSchema.required, ['pid']);
  assert.equal(byName.ping_host.inputSchema.properties.count.maximum, 4);
  assert.match(byName.system_logs.description, /systemd journal/);
});

test('unknown tools and non-object arguments are plain errors', async () => {
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(m.has('services'), true);
  assert.equal(m.has('rm_rf'), false);
  assert.deepEqual(await m.call('rm_rf', {}), { content: [{ type: 'text', text: 'Unknown tool: rm_rf' }], isError: true });
  assert.deepEqual(await m.call('services', [1, 2]), { content: [{ type: 'text', text: 'Arguments must be a JSON object.' }], isError: true });
});

// Reused tools from systemTools.js

test('the systemTools probes answer through the MCP envelope as compact JSON', async () => {
  const table = {
    'ps -A -o pid=,user=,%cpu=,%mem=,rss=,etime=,comm=': '    1 root  0.1  0.1  22976 12-00:03:52 /sbin/launchd\n 4242 alice 88.8 2.0 327680 05:01 node\n',
    'ps -A -ww -o pid=,args=': '    1 /sbin/launchd\n 4242 node server.js --api-key=sk-abcdefghijklmnopqrstuvwxyz123456\n'
  };
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner(table), host: stubHost() });
  const procs = await m.call('list_processes', { limit: 1 });
  assert.equal(procs.isError, undefined);
  assert.equal(textOf(procs), JSON.stringify(json(procs)), 'compact JSON');
  assert.deepEqual(json(procs).processes.map((p) => [p.pid, p.command]), [[4242, 'node server.js --api-key=[redacted]']]);

  const none = createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  const failed = await none.call('list_processes', {});
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed), 'Could not list processes: ps is not available on this system.');
  const overview = await none.call('system_overview', {});
  assert.equal(overview.isError, undefined, 'the overview degrades instead of failing');
  assert.match(json(overview).notes.join('\n'), /df is not available/);
  const net = await none.call('network_overview', {});
  assert.ok(Array.isArray(json(net).listening));
});

test('read_log keeps its newest lines inside the budget even when every line needs escaping', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'paths.log');
  const lines = Array.from({ length: 400 }, (_, i) => `${i} "C:\\Users\\alice\\AppData\\Local\\Temp\\x.dll" said "no"`);
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  const m = createMachineTools({ platform: 'win32', runCommand: stubRunner({}), host: stubHost() });
  const r = await m.call('read_log', { path: file, lines: 400 });
  const text = textOf(r);
  assert.ok(fits(text), `read_log is ${text.length} characters, ${JSON.stringify(text).length} escaped`);
  const out = json(r);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith(lines[399]), 'the newest line is kept');
  assert.equal(out.text.split('\n').length, out.shown);
  const missing = await m.call('read_log', { path: path.join(dir, 'gone.log') });
  assert.equal(missing.isError, true);
  assert.equal(textOf(missing), `No such file: ${path.join(dir, 'gone.log')}`);
  assert.equal(textOf(await m.call('read_log', {})), 'path is required');
});

// disk_usage

async function fillFolder() {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'big'));
  await fs.writeFile(path.join(dir, 'big', 'blob.bin'), Buffer.alloc(2_097_152, 1));
  await fs.mkdir(path.join(dir, 'medium'));
  await fs.writeFile(path.join(dir, 'medium', 'part.bin'), Buffer.alloc(307_200, 1));
  await fs.writeFile(path.join(dir, 'file.bin'), Buffer.alloc(1_048_576, 1));
  if (process.platform !== 'win32') await fs.symlink(path.join(dir, 'big'), path.join(dir, 'link-to-big'));
  return dir;
}

/** The stub table for listed commands, the real machine for the rest. */
function hybridRunner(table, calls = []) {
  return (command, args, opts) => {
    const key = [command, ...args].join(' ');
    calls.push({ key, opts });
    if (key in table) return stubRunner(table)(command, args, opts);
    return machineRunner(command, args, opts);
  };
}

test('disk_usage on POSIX measures each folder with du, files by blocks, and skips links', { skip: process.platform === 'win32' }, async () => {
  const dir = await fillFolder();
  const calls = [];
  const m = createMachineTools({ platform: 'darwin', runCommand: hybridRunner({ 'df -kP': DARWIN_DF }, calls), host: { homedir: () => dir } });
  const r = await m.call('disk_usage', { path: dir });
  assert.equal(r.isError, undefined, textOf(r));
  const out = json(r);
  assert.equal(out.path, dir);
  assert.equal(out.volume, '/');
  assert.deepEqual(out.volumes.map((v) => v.mount), ['/', '/Volumes/Backup Drive']);
  assert.deepEqual(out.entries.map((e) => [e.name, e.type]), [['big', 'folder'], ['file.bin', 'file'], ['medium', 'folder']]);
  assert.match(out.entries[0].size, /^2\.\d MB$/);
  assert.equal(out.partial, undefined);
  const du = calls.filter((c) => c.key.startsWith('du '));
  assert.deepEqual(du.map((c) => c.key).sort(), [`du -s -k -x ${path.join(dir, 'big')}`, `du -s -k -x ${path.join(dir, 'medium')}`]);
  assert.ok(du.every((c) => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 20_000), 'du is bounded by the budget');
  // Home is the default.
  assert.equal(json(await m.call('disk_usage', {})).path, dir);
  // Relative paths and ~ are under home.
  assert.equal(json(await m.call('disk_usage', { path: '~/big' })).path, path.join(dir, 'big'));
  assert.equal(json(await m.call('disk_usage', { path: 'medium', limit: 1 })).entries.length, 1);
});

test('disk_usage on a Mac home names the folders macOS asks about instead of reading them', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  for (const sub of ['Desktop', 'Documents', path.join('Library', 'Containers', 'app'), path.join('Library', 'Keep'), 'big']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'Documents', 'doc.bin'), Buffer.alloc(4096, 1));
  await fs.writeFile(path.join(dir, 'Library', 'Containers', 'app', 'data.bin'), Buffer.alloc(3_000_000, 1));
  await fs.writeFile(path.join(dir, 'Library', 'Keep', 'cache.bin'), Buffer.alloc(1_000_000, 1));
  const calls = [];
  // -I is BSD du; GNU du on a Linux test host has no such flag, so this call is stubbed.
  const libraryDu = `du -s -k -x -I Containers -I Group Containers -I Mobile Documents ${path.join(dir, 'Library')}`;
  const table = { 'df -kP': DARWIN_DF, [libraryDu]: `980\t${path.join(dir, 'Library')}\n` };
  const m = createMachineTools({ platform: 'darwin', runCommand: hybridRunner(table, calls), host: { homedir: () => dir } });
  const out = json(await m.call('disk_usage', {}));
  assert.deepEqual(out.notMeasured, ['Desktop', 'Documents']);
  assert.equal(out.partial, true);
  assert.ok(out.notes.some((n) => n === 'macOS asks before reading Desktop, Documents; pass one as the path to measure it.'), JSON.stringify(out.notes));
  const du = calls.filter((c) => c.key.startsWith('du ')).map((c) => c.key);
  assert.ok(!du.some((k) => k.endsWith(path.join(dir, 'Desktop')) || k.endsWith(path.join(dir, 'Documents'))), 'the protected folders are never opened');
  assert.ok(du.includes(libraryDu), du.join('\n'));
  const library = out.entries.find((e) => e.name === 'Library');
  assert.equal(library.size, 'over 1 MB', 'other apps\' data is left out');
  // Named directly, a protected folder is measured.
  const docs = json(await m.call('disk_usage', { path: '~/Documents' }));
  assert.deepEqual(docs.entries.map((e) => e.name), ['doc.bin']);
  assert.equal(docs.notMeasured, undefined);
  // Other systems have no such prompts.
  const linux = createMachineTools({ platform: 'linux', runCommand: hybridRunner({ 'df -kP': '' }), host: { homedir: () => dir } });
  assert.ok(json(await linux.call('disk_usage', {})).entries.some((e) => e.name === 'Documents'));
});

test('disk_usage on Windows walks folders with Node and reads volumes from CIM', async () => {
  const dir = await fillFolder();
  const calls = [];
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_LogicalDisk: WIN_VOLUMES }, {}, calls), host: { homedir: () => dir } });
  const out = json(await m.call('disk_usage', { path: dir }));
  assert.deepEqual(out.entries, [
    { name: 'big', type: 'folder', size: '2.1 MB' },
    { name: 'file.bin', type: 'file', size: '1 MB' },
    { name: 'medium', type: 'folder', size: '307 KB' }
  ]);
  assert.equal(out.measured, '3.5 MB');
  assert.deepEqual(out.volumes, [
    { mount: 'C:\\', sizeGB: 511.1, usedGB: 387.6, freeGB: 123.5, usedPercent: 76, label: 'Windows' },
    { mount: 'D:\\', sizeGB: 64, usedGB: 4, freeGB: 60, usedPercent: 6, label: 'USB', kind: 'removable' },
    { mount: 'Z:\\', sizeGB: 2000, usedGB: 1000, freeGB: 1000, usedPercent: 50, kind: 'network' }
  ]);
  assert.ok(calls.every((c) => !c.key.startsWith('du ')), 'no du on Windows');
  const script = psScript(calls.find((c) => /powershell/i.test(c.command)).args);
  assert.match(script, /OutputEncoding=New-Object System\.Text\.UTF8Encoding \$false/);
  assert.match(script, /ConvertTo-Json -InputObject \$r -Compress/);
});

test('disk_usage stops at its time budget and names what it did not measure', async () => {
  const dir = await tempDir();
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await fs.mkdir(path.join(dir, name, 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'deep', 'x.bin'), Buffer.alloc(1000));
  }
  let t = 0;
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({}), host: {}, now: () => (t += 4_000) });
  const out = json(await m.call('disk_usage', { path: dir }));
  assert.equal(out.partial, true);
  assert.ok((out.notMeasured || []).length > 0 || out.entries.some((e) => e.size.startsWith('over ')), JSON.stringify(out));
  assert.ok(out.notes.some((n) => /Measuring stopped at 20s/.test(n)));
  assert.ok(out.notes.some((n) => /volumes: /.test(n)), 'PowerShell missing is a note, not a failure');
});

test('disk_usage walks the folders itself when du is missing', { skip: process.platform === 'win32' }, async () => {
  const dir = await fillFolder();
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'df -kP': '' }), host: {} });
  const out = json(await m.call('disk_usage', { path: dir }));
  assert.deepEqual(out.entries.map((e) => e.name), ['big', 'file.bin', 'medium']);
  assert.ok(out.notes.some((n) => /du is not available on this system/.test(n)));
  assert.ok(out.notes.some((n) => /volumes: df listed no volumes/.test(n)));
});

test('disk_usage refuses missing folders, files and paths outside the operator jail', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'plain.txt'), 'x');
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: {} });
  assert.equal(textOf(await m.call('disk_usage', { path: path.join(dir, 'nope') })), `No such folder: ${path.join(dir, 'nope')}`);
  assert.equal(textOf(await m.call('disk_usage', { path: path.join(dir, 'plain.txt') })), `${path.join(dir, 'plain.txt')} is not a folder.`);
  const jail = path.join(dir, 'jail');
  await fs.mkdir(jail);
  const prev = process.env.MIRABILIS_MCP_FS_ROOT;
  process.env.MIRABILIS_MCP_FS_ROOT = jail;
  try {
    const outside = await m.call('disk_usage', { path: dir });
    assert.equal(outside.isError, true);
    assert.match(textOf(outside), /escapes the permitted filesystem root/);
    assert.equal(json(await m.call('disk_usage', {})).path, jail, 'the jail root is the default folder');
  } finally {
    if (prev === undefined) delete process.env.MIRABILIS_MCP_FS_ROOT;
    else process.env.MIRABILIS_MCP_FS_ROOT = prev;
  }
});

test('disk_usage fits the budget with long names and says how many it left out', async () => {
  const dir = await tempDir();
  for (let i = 0; i < 40; i += 1) await fs.writeFile(path.join(dir, `${String(i).padStart(2, '0')}-${'n'.repeat(180)}.bin`), Buffer.alloc(1000 + i));
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_LogicalDisk: WIN_VOLUMES }), host: {} });
  const r = await m.call('disk_usage', { path: dir, limit: 25 });
  assert.ok(fits(textOf(r)), `${textOf(r).length} characters`);
  const out = json(r);
  assert.ok(out.entriesNotShown > 0);
  assert.equal(out.entries.length + out.entriesNotShown, 25);
  assert.equal(out.rest.count, 15);
});

// system_logs

test('system_logs on macOS reads errors and faults from log show, keeps the newest output and counts repeats', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner({ [`/usr/bin/log show --last 10m --style compact --predicate (messageType == error OR messageType == fault)`]: DARWIN_LOG }, calls), host: stubHost() });
  const out = json(await m.call('system_logs', {}));
  assert.equal(calls[0].opts.tailBytes, 2 * 1024 * 1024, 'the newest output is kept, not the oldest');
  assert.equal(calls[0].opts.timeoutMs, 20_000);
  assert.deepEqual(out, {
    source: 'log show',
    window: 'last 10 min',
    level: 'error',
    matched: 7,
    distinct: 5,
    shown: 5,
    date: '2026-11-11',
    topSources: { identityservicesd: 3, kernel: 1, 'Google Chrome Helper (Renderer)': 1, backupd: 1, PerfPowerServices: 1 },
    entries: [
      '22:55:05 error kernel[0]: (Sandbox) Sandbox: swcd(818) deny(1) system-fsctl (_IO "h" 47)',
      '22:55:06 fault Google Chrome Helper (Renderer)[981]: [com.google.Chrome:gpu] GPU process crashed with a second line of detail',
      '22:59:53 error backupd[513]: [com.apple.TimeMachine:General] com.apple.backupd.sandbox.xpc: connection invalid',
      '22:59:58 error PerfPowerServices[61047]: [com.apple.PerfPowerServices:smcmetrics] SMCGetKeyInfo error: -3',
      '22:59:59 error identityservicesd[647]: [com.apple.network:] nw_path_flow_registration_get_stats_area Requested stats type does not match allocated type (2 != 3) (x3)'
    ]
  });
});

test('system_logs on macOS puts level and filter into the predicate, escaped, and caps the window', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner(() => ({ stdout: 'Timestamp               Ty Process[PID:TID]\n', dropped: 4096 }), calls), host: stubHost() });
  const out = json(await m.call('system_logs', { minutes: 600, level: 'critical', filter: 'say "hi" \\ there' }));
  assert.deepEqual(calls[0].args, [
    'show', '--last', '60m', '--style', 'compact', '--predicate',
    '(messageType == fault) AND (process CONTAINS[c] "say \\"hi\\" \\\\ there" OR subsystem CONTAINS[c] "say \\"hi\\" \\\\ there" OR composedMessage CONTAINS[c] "say \\"hi\\" \\\\ there")'
  ]);
  assert.equal(out.window, 'last 60 min');
  assert.equal(out.filter, 'say "hi" \\ there');
  assert.deepEqual(out.entries, []);
  assert.equal(out.matched, 0);
  assert.deepEqual(out.notes, ['macOS logs are read at most 60 minutes back at this level.', 'Counted over the newest 2.1 MB of log output.']);

  await m.call('system_logs', { level: 'info', minutes: 30 });
  assert.deepEqual(calls[1].args, ['show', '--last', '10m', '--style', 'compact'], 'info has no level predicate and a shorter window');
  const warn = json(await m.call('system_logs', { level: 'warning' }));
  assert.match(calls[2].args[6], /messageType == error OR messageType == fault/);
  assert.ok(warn.notes.includes('macOS has no warning level; showing errors and faults.'));
});

test('system_logs on macOS reports a slow or missing log command plainly', async () => {
  const slow = createMachineTools({
    platform: 'darwin', runCommand: stubRunner(() => Object.assign(new Error('/usr/bin/log timed out after 20000ms'), { code: null })), host: stubHost()
  });
  assert.equal(textOf(await slow.call('system_logs', {})), 'log show did not finish within 20s. Try fewer minutes or a filter.');
  const none = createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(textOf(await none.call('system_logs', {})), 'The log command is not available on this system.');
});

test('system_logs on Linux reads the journal as JSON, decodes byte messages and notes a limited view', async () => {
  const calls = [];
  const m = createMachineTools({
    platform: 'linux',
    runCommand: stubRunner({ 'journalctl --no-pager -o json -p err --since=-10min -n 400': { stdout: JOURNAL, stderr: JOURNAL_HINT } }, calls),
    host: stubHost()
  });
  const out = json(await m.call('system_logs', {}));
  assert.deepEqual(out.entries, [
    '22:55:02 error kernel: nvme nvme0: I/O 12 QID 3 timeout, aborting',
    '22:55:04 critical systemd[1]: Failed to start nginx.service - A high performance web server.',
    '22:55:05 error node[2001]: hi bytes',
    '22:55:06 error nginx[812]: 2026/11/11 22:55:06 [emerg] 812#812: bind() to 0.0.0.0:80 failed (98: Address already in use) (x2)'
  ]);
  assert.equal(out.source, 'journalctl');
  assert.equal(out.matched, 5);
  assert.equal(out.distinct, 4);
  assert.deepEqual(out.topSources, { nginx: 2, kernel: 1, systemd: 1, node: 1 });
  assert.deepEqual(out.notes, ["Only this user's entries: system entries need the systemd-journal or adm group."]);
  assert.equal(calls[0].opts.maxBuffer, 32 * 1024 * 1024);
});

test('system_logs on Linux filters in place, maps levels and explains a missing journal', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner(() => JOURNAL, calls), host: stubHost() });
  const out = json(await m.call('system_logs', { filter: 'NGINX', level: 'warning', minutes: 1440, limit: 1 }));
  assert.deepEqual(calls[0].args, ['--no-pager', '-o', 'json', '-p', 'warning', '--since=-1440min', '-n', '2000']);
  assert.equal(out.matched, 3, 'nginx entries plus the systemd one naming nginx.service');
  assert.equal(out.entries.length, 1);
  assert.match(out.entries[0], /\(x2\)$/);
  const none = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(textOf(await none.call('system_logs', {})), 'journalctl is not available on this system; use read_log on a file in /var/log.');
  const locked = createMachineTools({
    platform: 'linux',
    runCommand: stubRunner(() => ({ code: 1, stderr: 'No journal files were opened due to insufficient permissions.\n' })),
    host: stubHost()
  });
  assert.equal(textOf(await locked.call('system_logs', {})), 'This user cannot read the journal; add it to the systemd-journal group.');
});

test('system_logs on Windows asks Get-WinEvent for the window and levels, newest events last', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ 'Get-WinEvent': WIN_EVENTS }, {}, calls), host: stubHost() });
  const out = json(await m.call('system_logs', { minutes: 30 }));
  assert.deepEqual(out.entries, [
    '22:53:00 error Service Control Manager 7031: (no message, event 7031)',
    '22:54:00 error Application Error 1000: Faulting application name: chrome.exe, version: 119.0.6045.160',
    '22:55:00 critical Kernel-Power 41: The system has rebooted without cleanly shutting down first.',
    '22:59:58 error DistributedCOM 10016: The application-specific permission settings do not grant Local Activation permission for the COM Server application with CLSID (x2)'
  ]);
  assert.equal(out.source, 'event log');
  const script = psScript(calls[0].args);
  assert.match(script, /'LogName'=@\('System','Application'\);'Level'=@\(1,2\);'StartTime'=\(Get-Date\)\.AddMinutes\(-30\)/);
  assert.match(script, /-MaxEvents 150 /);
  assert.match(script, /\$WarningPreference='SilentlyContinue'/);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  await m.call('system_logs', { level: 'info', filter: 'kernel' });
  assert.match(psScript(calls[1].args), /'Level'=@\(0,1,2,3,4\)/);
  assert.match(psScript(calls[1].args), /-MaxEvents 300 /);
});

test('PowerShell is found under SystemRoot, and its failures read plainly', async () => {
  const calls = [];
  const host = stubHost({ env: (key) => (key === 'SystemRoot' ? 'C:\\Windows' : undefined) });
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ 'Get-WinEvent': [] }, {}, calls), host });
  assert.deepEqual(json(await m.call('system_logs', {})).entries, []);
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const missing = createMachineTools({ platform: 'win32', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(textOf(await missing.call('services', {})), 'PowerShell is not available on this system.');
  const broken = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: { stdout: '', stderr: 'At line:1 char:5\r\n+ bad', code: 1 } }), host: stubHost() });
  assert.equal(textOf(await broken.call('services', {})), 'PowerShell failed: At line:1 char:5');
  const noisy = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: `WARNING: something\r\n${JSON.stringify(WIN_SERVICES)}\r\n` }), host: stubHost() });
  assert.equal(json(await noisy.call('services', {})).total, 6, 'lines before the JSON are skipped');
  const garbled = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: 'not json at all' }), host: stubHost() });
  assert.equal(textOf(await garbled.call('services', {})), 'PowerShell output was not understood: not json at all');
});

test('system_logs keeps the newest entries when thousands of distinct lines arrive', async () => {
  const lines = ['Timestamp               Ty Process[PID:TID]'];
  for (let i = 0; i < 3000; i += 1) {
    const s = String(i % 60).padStart(2, '0');
    lines.push(`2026-11-11 22:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${s}.000 E  proc${i % 7}[${i}:1] distinct message ${'w'.repeat(i % 50)} ${String.fromCharCode(97 + (i % 26)).repeat(150)} #${'z'.repeat(i % 3)}${i % 2 ? 'odd' : 'even'}${i % 5}`);
  }
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner(() => lines.join('\n')), host: stubHost() });
  const r = await m.call('system_logs', { limit: 50 });
  assert.ok(fits(textOf(r)), `${textOf(r).length} characters`);
  const out = json(r);
  assert.ok(out.entriesNotShown > 0);
  assert.equal(out.entries.length + out.entriesNotShown, 50);
  assert.match(out.entries[out.entries.length - 1], /^22:49:59 /, 'the newest entry survives the trim');
});

// services

const darwinServices = (extra = {}) => stubRunner({ 'launchctl list': DARWIN_LAUNCHCTL_LIST, 'launchctl print system': DARWIN_LAUNCHCTL_SYSTEM, ...extra });

test('services on macOS merges the user and system launchd domains, failed first, Apple last', async () => {
  const m = createMachineTools({ platform: 'darwin', runCommand: darwinServices(), host: stubHost() });
  const out = json(await m.call('services', {}));
  assert.equal(out.total, 13);
  assert.equal(out.running, 4);
  assert.equal(out.failed, 3);
  assert.deepEqual(out.services, [
    { name: 'com.example.broken', domain: 'user', state: 'failed', lastExit: 'exit 78' },
    { name: 'com.example.crashy', domain: 'user', state: 'failed', lastExit: 'signal 11' },
    { name: 'com.apple.wifiFirmwareLoader', domain: 'system', state: 'failed', lastExit: 'exit 1' },
    { name: 'com.vix.cron', domain: 'system', state: 'running', pid: 812 },
    { name: 'homebrew.mxcl.postgresql@18', domain: 'user', state: 'running', pid: 4242 },
    { name: 'com.apple.Finder', domain: 'user', state: 'running', pid: 691 },
    { name: 'com.apple.runningboardd', domain: 'system', state: 'running', pid: 415 },
    { name: 'com.microsoft.OneDriveStandaloneUpdaterDaemon', domain: 'system', state: 'stopped', lastExit: 'signal 15' },
    { name: 'org.virtualbox.vboxwebsvc', domain: 'user', state: 'stopped' },
    { name: 'com.apple.kernelmanager_helper', domain: 'system', state: 'stopped' },
    { name: 'com.apple.lskdd', domain: 'system', state: 'stopped' },
    { name: 'com.apple.progressd', domain: 'user', state: 'stopped', lastExit: 'signal 9' },
    { name: 'com.apple.SafariHistoryServiceAgent', domain: 'user', state: 'stopped' }
  ]);
  const failed = json(await m.call('services', { state: 'failed', limit: 2 }));
  assert.deepEqual(failed.services.map((s) => s.name), ['com.example.broken', 'com.example.crashy']);
  assert.equal(failed.matched, 3);
  const found = json(await m.call('services', { filter: 'POSTGRES' }));
  assert.deepEqual(found.services.map((s) => s.name), ['homebrew.mxcl.postgresql@18']);
  assert.equal(found.filter, 'postgres');
  const noSystem = json(await createMachineTools({ platform: 'darwin', runCommand: stubRunner({ 'launchctl list': DARWIN_LAUNCHCTL_LIST }), host: stubHost() }).call('services', {}));
  assert.equal(noSystem.total, 7);
  assert.deepEqual(noSystem.notes, ['System daemons could not be listed.']);
  const none = createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(textOf(await none.call('services', {})), 'launchctl is not available on this system.');
});

test('services on Linux reads systemctl, marks failed units and skips missing ones', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'systemctl list-units --type=service --all --no-pager --no-legend --plain': LINUX_UNITS }, calls), host: stubHost() });
  const out = json(await m.call('services', {}));
  assert.equal(out.total, 6);
  assert.equal(out.running, 2);
  assert.equal(out.failed, 2);
  assert.deepEqual(out.services.map((s) => [s.name, s.state]), [
    ['certbot', 'failed'], ['nginx', 'failed'], ['accounts-daemon', 'running'], ['cron', 'running'],
    ['apparmor', 'active (exited)'], ['ssh', 'stopped']
  ]);
  assert.equal(out.services[1].description, 'A high performance web server and a reverse pro...');
  assert.deepEqual(json(await m.call('services', { state: 'stopped' })).services.map((s) => s.name), ['ssh']);
  assert.deepEqual(json(await m.call('services', { filter: 'secure shell' })).services.map((s) => s.name), ['ssh']);
  const noSystemd = createMachineTools({
    platform: 'linux',
    runCommand: stubRunner(() => ({ code: 1, stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.\nFailed to connect to bus: Host is down\n" })),
    host: stubHost()
  });
  assert.equal(textOf(await noSystemd.call('services', {})), 'systemd is not available on this system.');
});

test('services on Windows reads Win32_Service and calls an automatic service that stopped with an error failed', async () => {
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: WIN_SERVICES }), host: stubHost() });
  const out = json(await m.call('services', {}));
  assert.equal(out.total, 6);
  assert.equal(out.running, 1);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.services, [
    { name: 'BrokenSvc', state: 'failed', start: 'auto', lastExit: 'exit 1067', description: 'Broken Vendor Service' },
    { name: 'Spooler', state: 'running', start: 'auto', pid: 2468, description: 'Print Spooler' },
    { name: 'gupdate', state: 'stopped', start: 'auto', description: 'Google Update Service' },
    { name: 'NeverStarted', state: 'stopped', start: 'auto', description: 'Never Started' },
    { name: 'Pending', state: 'start pending', start: 'auto', pid: 3333, description: 'Pending Service' },
    { name: 'wuauserv', state: 'stopped', start: 'manual', description: 'Windows Update' }
  ]);
  const empty = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: [] }), host: stubHost() });
  assert.equal(textOf(await empty.call('services', {})), 'Get-CimInstance listed no services.');
});

test('services stays inside the budget with hundreds of long names', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ name: `Vendor${i}${'x'.repeat(80)}`, display: 'd'.repeat(90), state: 'Running', start: 'Auto', pid: 1000 + i, exit: 0 }));
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Service: many }), host: stubHost() });
  const r = await m.call('services', { limit: 100 });
  assert.ok(fits(textOf(r)), `${textOf(r).length} characters`);
  const out = json(r);
  assert.equal(out.services.length + out.servicesNotShown, 100);
  assert.ok(out.services.every((s) => s.description.length <= 50));
});

// startup_items

test('startup_items on macOS lists launch agents and daemons with what they run, overrides and running state', async () => {
  const LA = path.join('/Users/alice', 'Library', 'LaunchAgents');
  const host = stubHost({
    dirs: {
      [LA]: ['homebrew.mxcl.postgresql@18.plist', 'org.virtualbox.vboxwebsrv.plist'],
      '/Library/LaunchAgents': ['us.zoom.updater.plist'],
      '/Library/LaunchDaemons': ['broken.plist', 'com.vix.cron.plist', 'notes.txt']
    },
    files: {
      [path.join(LA, 'homebrew.mxcl.postgresql@18.plist')]: PLIST_POSTGRES,
      [path.join(LA, 'org.virtualbox.vboxwebsrv.plist')]: PLIST_VBOX,
      [path.join('/Library/LaunchAgents', 'us.zoom.updater.plist')]: PLIST_ZOOM,
      [path.join('/Library/LaunchDaemons', 'com.vix.cron.plist')]: 'bplist00 binary'
    }
  });
  const runner = darwinServices({
    'launchctl print-disabled gui/501': DARWIN_DISABLED_USER,
    'launchctl print-disabled system': DARWIN_DISABLED_SYSTEM,
    [`plutil -convert xml1 -o - ${path.join('/Library/LaunchDaemons', 'com.vix.cron.plist')}`]: PLIST_CRON
  });
  const r = await createMachineTools({ platform: 'darwin', runCommand: runner, host }).call('startup_items', {});
  assert.doesNotMatch(textOf(r), /sk-abcdef/, 'secrets in arguments are redacted');
  assert.deepEqual(json(r), {
    loginAgents: [
      { name: 'homebrew.mxcl.postgresql@18', command: 'postgres -D /opt/homebrew/var/postgresql@18', starts: 'kept running', running: true },
      { name: 'org.virtualbox.vboxwebsvc', command: 'vboxwebsrv', starts: 'on demand', disabled: true }
    ],
    agents: [{ name: 'us.zoom.updater', command: 'ZoomUpdater --update --token=[redacted]', starts: 'scheduled' }],
    daemons: [
      { name: 'broken' },
      { name: 'com.vix.cron', command: 'cron', starts: 'on change', running: true }
    ],
    notes: ['Login items are kept where only root can read them; see System Settings, General, Login Items.']
  });
});

test('startup_items on Linux lists enabled units, user units and autostart entries', async () => {
  const home = '/home/bob';
  const userDir = path.join(home, '.config', 'systemd', 'user');
  const autostart = path.join(home, '.config', 'autostart');
  const host = stubHost({
    homedir: () => home,
    dirs: {
      [userDir]: dirents(['default.target.wants', 'syncthing.service'], { dirs: ['default.target.wants'] }),
      [path.join(userDir, 'default.target.wants')]: ['syncthing.service', 'pipewire.service'],
      [autostart]: ['dropbox.desktop', 'notes.txt', 'old.desktop']
    },
    files: {
      [path.join(autostart, 'dropbox.desktop')]: '[Desktop Entry]\nType=Application\nName=Dropbox\nName[de]=Dropbox DE\nExec=dropbox start -i %U\n',
      [path.join(autostart, 'old.desktop')]: '[Desktop Entry]\nName=Old Thing\nExec=oldthing\nX-GNOME-Autostart-enabled=false\n\n[Desktop Action New]\nName=Not this\n'
    }
  });
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'systemctl list-unit-files --state=enabled --no-pager --no-legend': LINUX_UNIT_FILES }), host });
  assert.deepEqual(json(await m.call('startup_items', {})), {
    systemd: ['apt-daily.timer', 'cron.service', 'getty@.service', 'nginx.service', 'ssh.socket'],
    userSystemd: ['pipewire.service', 'syncthing.service'],
    autostart: [{ name: 'Dropbox', command: 'dropbox start -i' }, { name: 'Old Thing', command: 'oldthing', disabled: true }]
  });
  const bare = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost({ homedir: () => home }) });
  assert.deepEqual(json(await bare.call('startup_items', {})), {
    systemd: [], userSystemd: [], autostart: [], notes: ['systemctl is not available on this system.']
  });
});

test('startup_items on Windows lists Run keys and Startup folders and honours Task Manager switches', async () => {
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_StartupCommand: WIN_STARTUP }), host: stubHost() });
  const r = await m.call('startup_items', {});
  assert.doesNotMatch(textOf(r), /sk-abcdef/);
  assert.deepEqual(json(r), {
    items: [
      { name: 'OneDrive', where: 'Run key', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background' },
      { name: 'SecurityHealth', where: 'Run key, all users', command: '%windir%\\system32\\SecurityHealthSystray.exe' },
      { name: 'Send to OneNote', where: 'Startup folder', command: 'Send to OneNote.lnk', disabled: true },
      { name: 'Updater', where: 'RunOnce key, all users', command: 'C:\\Tools\\updater.exe --api-key=[redacted]', disabled: true }
    ],
    notes: ['Services that start automatically are listed by services.']
  });
});

// hardware_info

test('hardware_info on Apple silicon reads system_profiler without serial numbers', async () => {
  const calls = [];
  const m = createMachineTools({
    platform: 'darwin',
    runCommand: stubRunner({ 'system_profiler -json -detailLevel mini SPHardwareDataType SPDisplaysDataType': JSON.stringify(PROFILER_APPLE) }, calls),
    host: stubHost()
  });
  assert.deepEqual(json(await m.call('hardware_info', {})), {
    model: 'MacBook Air (Mac16,12)',
    cpu: { name: 'Apple M4', threads: 10, cores: 10, performanceCores: 4, efficiencyCores: 6 },
    memory: { total: '16 GB' },
    gpus: [{ name: 'Apple M4', vendor: 'Apple', cores: 8, vram: 'unified memory', metal: 'metal4' }],
    displays: [{ name: 'Color LCD', resolution: '1470x956', pixels: '2940x1912', refreshHz: 60, connection: 'internal', main: true }]
  });
  assert.ok(calls[0].args.includes('mini'), 'mini leaves serial numbers out');
});

test('hardware_info on an Intel Mac lists both GPUs with their memory and every display', async () => {
  const m = createMachineTools({
    platform: 'darwin',
    runCommand: stubRunner({ 'system_profiler -json -detailLevel mini SPHardwareDataType SPDisplaysDataType': JSON.stringify(PROFILER_INTEL) }),
    host: stubHost({ cpus: () => Array.from({ length: 16 }, () => ({ model: 'Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz' })) })
  });
  assert.deepEqual(json(await m.call('hardware_info', {})), {
    model: 'MacBook Pro (MacBookPro16,1)',
    cpu: { name: '8-Core Intel Core i9', threads: 16, cores: 8, speed: '2.3 GHz' },
    memory: { total: '32 GB' },
    gpus: [
      { name: 'Intel UHD Graphics 630', vendor: 'Intel', vram: '1536 MB shared' },
      { name: 'AMD Radeon Pro 5500M', vendor: 'AMD', vram: '4 GB', metal: 'metal3' }
    ],
    displays: [
      { name: 'Color LCD', resolution: '1536x960', pixels: '3072x1920', refreshHz: 60, connection: 'internal', main: true },
      { name: 'DELL U2720Q', resolution: '1920x1080', pixels: '3840x2160', refreshHz: 60, connection: 'external' }
    ]
  });
  const none = createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: stubHost() });
  const bare = json(await none.call('hardware_info', {}));
  assert.equal(bare.cpu.name, 'Apple M4');
  assert.equal(bare.memory.total, '16 GB');
  assert.deepEqual(bare.notes, ['system_profiler: system_profiler is not available on this system', 'No GPU was reported.']);
});

test('hardware_info on Linux joins lscpu, meminfo, lspci, nvidia-smi and the DRM connectors', async () => {
  const host = stubHost({
    files: LINUX_HW_FILES,
    dirs: { [`${SYS}/drm`]: ['card0', 'card0-DP-1', 'card0-eDP-1', 'card0-HDMI-A-1', 'renderD128', 'version'] }
  });
  const m = createMachineTools({
    platform: 'linux',
    runCommand: stubRunner({
      lscpu: LSCPU,
      lspci: LSPCI,
      'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits': 'NVIDIA GeForce MX150, 2048, 535.104.05\n'
    }),
    host
  });
  assert.deepEqual(json(await m.call('hardware_info', {})), {
    model: 'LENOVO 20L8S02E00 ThinkPad T480s',
    cpu: { name: 'Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz', arch: 'x86_64', cores: 4, threads: 8, maxMHz: 4200 },
    memory: { total: '15.6 GB', swap: '2 GB' },
    gpus: [{ name: 'Intel Corporation UHD Graphics 620' }, { name: 'NVIDIA GeForce MX150', vram: '2 GB', driver: '535.104.05' }],
    displays: [
      { name: 'HDMI-A-1', resolution: '3840x2160', connection: 'external' },
      { name: 'eDP-1', resolution: '1920x1080', connection: 'internal' }
    ]
  });
});

test('hardware_info on Linux finds AMD video memory in sysfs and survives a bare container', async () => {
  const host = stubHost({
    files: { [`${SYS}/drm/card1/device/mem_info_vram_total`]: '17163091968\n', [`${PROC}/device-tree/model`]: `Raspberry Pi 5 Model B Rev 1.0${String.fromCharCode(0)}` },
    dirs: { [`${SYS}/drm`]: ['card1', 'renderD128'] }
  });
  const m = createMachineTools({
    platform: 'linux',
    runCommand: stubRunner({ lspci: '03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT] (rev c1)\n' }),
    host
  });
  const out = json(await m.call('hardware_info', {}));
  assert.deepEqual(out.gpus, [{ name: 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]', vram: '16 GB' }]);
  assert.equal(out.model, 'Raspberry Pi 5 Model B Rev 1.0');
  assert.deepEqual(out.notes, ['cpu: lscpu is not available on this system']);
  const bare = json(await createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() }).call('hardware_info', {}));
  assert.equal(bare.cpu.name, 'Apple M4', 'the CPU model falls back to Node');
  assert.equal(bare.memory.total, '16 GB');
  assert.deepEqual(bare.gpus, []);
  assert.ok(bare.notes.includes('gpus: lspci is not available on this system'));
});

test('hardware_info on Windows reads CIM and prefers the driver qwMemorySize over the 4 GB AdapterRAM', async () => {
  const calls = [];
  const m = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_VideoController: WIN_HARDWARE }, {}, calls), host: stubHost() });
  assert.deepEqual(json(await m.call('hardware_info', {})), {
    model: 'Dell Inc. XPS 15 9520',
    cpu: { name: '12th Gen Intel(R) Core(TM) i7-12700H', cores: 14, threads: 20, maxMHz: 2300 },
    memory: { total: '31.8 GB' },
    gpus: [
      { name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', vram: '4 GB', driver: '31.0.15.3623' },
      { name: 'Intel(R) Iris(R) Xe Graphics', vram: '2 GB', driver: '31.0.101.4502' }
    ],
    displays: [{ adapter: 'Intel(R) Iris(R) Xe Graphics', resolution: '3456x2160', refreshHz: 60 }]
  });
  assert.match(psScript(calls[0].args), /HardwareInformation\.qwMemorySize/);
});

// ping_host

test('parsePing reads the summaries of macOS, Linux, BusyBox and Windows in two languages', () => {
  assert.deepEqual(parsePing(PING_DARWIN, 'darwin'), { sent: 2, received: 2, lossPercent: 0, address: '127.0.0.1', rttMs: { min: 0.068, avg: 0.117, max: 0.166 } });
  assert.deepEqual(parsePing(PING6_DARWIN, 'darwin'), { sent: 1, received: 1, lossPercent: 0, address: '::1', rttMs: { min: 0.12, avg: 0.12, max: 0.12 } });
  assert.deepEqual(parsePing(PING_DARWIN_LOSS, 'darwin'), { sent: 2, received: 0, lossPercent: 100, address: '10.0.0.99' });
  assert.deepEqual(parsePing(PING_LINUX, 'linux'), { sent: 2, received: 2, lossPercent: 0, address: '127.0.0.1', rttMs: { min: 0.033, avg: 0.037, max: 0.041 } });
  assert.deepEqual(parsePing(PING_LINUX_V6, 'linux'), { sent: 1, received: 1, lossPercent: 0, address: '::1', rttMs: { min: 0.045, avg: 0.045, max: 0.045 } });
  assert.deepEqual(parsePing(PING_BUSYBOX, 'linux'), { sent: 1, received: 1, lossPercent: 0, address: '10.0.0.1', rttMs: { min: 0.297, avg: 0.297, max: 0.297 } });
  assert.deepEqual(parsePing(PING_WINDOWS, 'win32'), { sent: 2, received: 2, lossPercent: 0, address: '127.0.0.1', rttMs: { min: 0, avg: 0, max: 1 } });
  assert.deepEqual(parsePing(PING_WINDOWS_UNREACHABLE, 'win32'), { sent: 2, received: 0, lossPercent: 100, address: '192.168.1.250' });
  assert.deepEqual(parsePing(PING_WINDOWS_GERMAN, 'win32'), { sent: 2, received: 2, lossPercent: 0, address: '::1', rttMs: { min: 0, avg: 1, max: 2 } });
  assert.equal(parsePing('Ping request could not find host nope.invalid. Please check the name and try again.\r\n', 'win32'), null);
  assert.equal(parsePing('', 'linux'), null);
});

test('ping_host runs each platform ping with bounded waits and reports loss', async () => {
  const calls = [];
  const runner = stubRunner({
    'ping -c 3 -W 2000 -t 8 127.0.0.1': PING_DARWIN,
    'ping6 -c 1 ::1': PING6_DARWIN,
    'ping -n -c 1 -W 2 -w 4 127.0.0.1': PING_LINUX,
    'ping -n 2 -w 2000 127.0.0.1': PING_WINDOWS,
    'ping -c 2 -W 2000 -t 6 10.0.0.99': { code: 2, stdout: PING_DARWIN_LOSS }
  }, calls);
  const mac = createMachineTools({ platform: 'darwin', runCommand: runner, host: stubHost() });
  assert.deepEqual(json(await mac.call('ping_host', { host: '127.0.0.1' })), { host: '127.0.0.1', sent: 2, received: 2, lossPercent: 0, address: '127.0.0.1', rttMs: { min: 0.068, avg: 0.117, max: 0.166 } });
  assert.equal(calls[0].opts.timeoutMs, 10_500);
  assert.equal(json(await mac.call('ping_host', { host: '[::1]', count: 1 })).received, 1);
  assert.deepEqual(json(await mac.call('ping_host', { host: '10.0.0.99', count: 2 })), { host: '10.0.0.99', sent: 2, received: 0, lossPercent: 100, address: '10.0.0.99' });
  const linux = createMachineTools({ platform: 'linux', runCommand: runner, host: stubHost() });
  assert.equal(json(await linux.call('ping_host', { host: '127.0.0.1', count: 1 })).received, 2, 'as the recorded output says');
  const win = createMachineTools({ platform: 'win32', runCommand: runner, host: stubHost() });
  assert.equal(json(await win.call('ping_host', { host: '127.0.0.1', count: 2 })).received, 2);
  assert.equal(json(await win.call('ping_host', { host: '127.0.0.1', count: 2 })).rttMs.max, 1);
  // Counts clamp to 1..4.
  await mac.call('ping_host', { host: '127.0.0.1', count: 99 });
  assert.deepEqual(calls[calls.length - 1].args.slice(0, 2), ['-c', '4']);
});

test('ping_host retries without -n on BusyBox and turns failures into one sentence', async () => {
  const calls = [];
  const busybox = stubRunner({
    'ping -n -c 1 -W 2 -w 4 10.0.0.1': { code: 1, stderr: "ping: invalid option -- 'n'\nBusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary.\n" },
    'ping -c 1 -W 2 -w 4 10.0.0.1': PING_BUSYBOX
  }, calls);
  const m = createMachineTools({ platform: 'linux', runCommand: busybox, host: stubHost() });
  assert.equal(json(await m.call('ping_host', { host: '10.0.0.1', count: 1 })).received, 1);
  assert.equal(calls.length, 2);
  const unknown = createMachineTools({ platform: 'linux', runCommand: stubRunner(() => ({ code: 2, stderr: 'ping: nope.invalid: Name or service not known\n' })), host: stubHost() });
  assert.equal(textOf(await unknown.call('ping_host', { host: 'nope.invalid' })), 'ping failed: ping: nope.invalid: Name or service not known');
  const winUnknown = createMachineTools({ platform: 'win32', runCommand: stubRunner(() => ({ code: 1, stdout: '\r\nPing request could not find host nope.invalid. Please check the name and try again.\r\n' })), host: stubHost() });
  assert.equal(textOf(await winUnknown.call('ping_host', { host: 'nope.invalid' })), 'ping failed: Ping request could not find host nope.invalid. Please check the name and try again.');
  const none = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: stubHost() });
  assert.equal(textOf(await none.call('ping_host', { host: '10.0.0.1' })), 'ping is not available on this system.');
  for (const bad of ['', '-c 9 x', 'a b', 'x;rm', 'a..b', `${'a'.repeat(254)}`, 'http://x']) {
    const r = await m.call('ping_host', { host: bad });
    assert.equal(r.isError, true, bad);
    assert.match(textOf(r), /^host (is required|must be a host name or IP address)\.$/, bad);
  }
});

test('ping_host on macOS stops a ping6 that waits on a silent host and counts its replies', async () => {
  const calls = [];
  // ping6 flushes each reply, so a stopped run still shows the ones that came back.
  const partial = [
    'PING6(56=40+8+8 bytes) fe80::1%lo0 --> fe80::1%lo0',
    '16 bytes from fe80::1%lo0, icmp_seq=0 hlim=64 time=0.096 ms',
    '16 bytes from fe80::1%lo0, icmp_seq=1 hlim=64 time=0.354 ms',
    ''
  ].join('\n');
  const stopped = (stdout) => Object.assign(new Error('ping6 timed out after 6000ms'), { code: null, stdout, stderr: '' });
  const runner = stubRunner({
    'ping6 -c 3 fe80::1%lo0': stopped(partial),
    // With no reply nothing was flushed, not even the first line.
    'ping6 -c 3 2001:db8::1': stopped(''),
    'ping6 -c 1 2001:db8::2': { code: 1, stderr: 'ping6: UDP connect: No route to host\n' }
  }, calls);
  const mac = createMachineTools({ platform: 'darwin', runCommand: runner, host: stubHost() });
  assert.deepEqual(json(await mac.call('ping_host', { host: 'fe80::1%lo0' })), {
    host: 'fe80::1%lo0', sent: 3, received: 2, lossPercent: 33, address: 'fe80::1%lo0', rttMs: { min: 0.096, avg: 0.225, max: 0.354 }
  });
  assert.equal(calls[0].opts.timeoutMs, 6_000, 'a second per ping and 3s for the last reply');
  assert.deepEqual(json(await mac.call('ping_host', { host: '2001:db8::1' })), { host: '2001:db8::1', sent: 3, received: 0, lossPercent: 100 });
  assert.equal(textOf(await mac.call('ping_host', { host: '2001:db8::2', count: 1 })), 'ping failed: ping6: UDP connect: No route to host');
  assert.deepEqual(parsePingReplies(partial, 2).rttMs, { min: 0.096, avg: 0.225, max: 0.354 });
});

test('parseHost keeps names and addresses and refuses anything a command could misread', () => {
  assert.equal(parseHost(' example.com. '), 'example.com');
  assert.equal(parseHost('[fe80::1%en0]'), 'fe80::1%en0');
  assert.equal(parseHost('_sip._tcp.example.com'), '_sip._tcp.example.com');
  assert.equal(parseHost('10.0.0.1'), '10.0.0.1');
  assert.throws(() => parseHost('-oProxyCommand=x'), /must be a host name/);
  assert.throws(() => parseHost(undefined, 'name'), /^Error: name is required\.$/);
});

// dns_lookup

function dnsHost(extra = {}) {
  const asked = [];
  return {
    asked,
    host: stubHost({
      dnsServers: () => ['192.168.1.1', '1.1.1.1'],
      lookup: async (name) => { asked.push(['lookup', name]); return [{ address: '93.184.215.14', family: 4 }, { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }, { address: '93.184.215.14', family: 4 }]; },
      resolve: async (name, type) => {
        asked.push([type, name]);
        if (type === 'AAAA') throw Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' });
        return ['93.184.215.14'];
      },
      reverse: async (ip) => { asked.push(['reverse', ip]); return ['host-1.example.net']; },
      ...extra
    })
  };
}

test('dns_lookup asks the system resolver and the DNS servers, and maps their errors to words', async () => {
  const { host, asked } = dnsHost();
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host });
  assert.deepEqual(json(await m.call('dns_lookup', { name: 'example.com' })), {
    name: 'example.com',
    system: ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    A: ['93.184.215.14'],
    AAAA: 'no records',
    servers: ['192.168.1.1', '1.1.1.1']
  });
  assert.deepEqual(asked.map((a) => a[0]).sort(), ['A', 'AAAA', 'lookup']);
  assert.deepEqual(json(await m.call('dns_lookup', { name: '8.8.8.8' })), { name: '8.8.8.8', reverse: ['host-1.example.net'], servers: ['192.168.1.1', '1.1.1.1'] });
  const failing = dnsHost({
    lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); },
    resolve: async () => { throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' }); }
  });
  const f = json(await createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: failing.host }).call('dns_lookup', { name: 'nope.invalid' }));
  assert.deepEqual([f.system, f.A, f.AAAA], ['not found', 'timed out', 'timed out']);
});

// Go Dark

async function darkFolder(on = true) {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'go-dark.json'), JSON.stringify({ on, changedAt: new Date().toISOString() }));
  return dir;
}

test('Go Dark blocks ping, DNS and port checks to the internet, read fresh at each call', async () => {
  const dataDir = await darkFolder();
  const calls = [];
  const { host, asked } = dnsHost();
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'ping -n -c 1 -W 2 -w 4 192.168.1.1': PING_LINUX }, calls), host, dataDir });
  for (const [tool, args, target] of [
    ['ping_host', { host: 'example.com', count: 1 }, 'example.com'],
    ['ping_host', { host: '8.8.8.8' }, '8.8.8.8'],
    ['dns_lookup', { name: 'example.com' }, 'example.com'],
    ['check_port', { host: '1.1.1.1', port: 443 }, '1.1.1.1']
  ]) {
    const r = await m.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.equal(textOf(r), `Blocked by Go Dark. Turn it off to reach ${target}.`);
  }
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(asked.length, 0, 'nothing was resolved');
  // The LAN and this machine stay reachable.
  assert.equal(json(await m.call('ping_host', { host: '192.168.1.1', count: 1 })).sent, 2, 'the recorded output');
  // A local name resolves through the system only, since a DNS server is on the internet.
  const local = json(await m.call('dns_lookup', { name: 'nas.local' }));
  assert.equal(local.A, undefined);
  assert.deepEqual(local.notes, ['Go Dark is on and a DNS server is outside this network, so only the system resolver was asked.']);
  assert.deepEqual(asked.map((a) => a[0]), ['lookup']);
  // With only LAN DNS servers, the servers are asked too.
  const lan = dnsHost({ dnsServers: () => ['192.168.1.1', '[fe80::1]:53'.replace('fe80::1', '::1')] });
  const lanOut = json(await createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: lan.host, dataDir }).call('dns_lookup', { name: 'printer.local' }));
  assert.deepEqual(lanOut.A, ['93.184.215.14']);
  // Switched off on disk: allowed at once.
  await fs.writeFile(path.join(dataDir, 'go-dark.json'), JSON.stringify({ on: false }));
  assert.equal(json(await m.call('dns_lookup', { name: 'example.com' })).A[0], '93.184.215.14');
});

// check_port

test('check_port reports open with latency, closed, timeout and unresolvable hosts', async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const open = server.address().port;
  const spare = net.createServer();
  await new Promise((r) => spare.listen(0, '127.0.0.1', r));
  const closed = spare.address().port;
  await new Promise((r) => spare.close(r));
  try {
    const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: {} });
    const o = json(await m.call('check_port', { host: '127.0.0.1', port: open }));
    assert.equal(o.state, 'open');
    assert.equal(o.address, '127.0.0.1');
    assert.ok(o.latencyMs >= 0 && o.latencyMs < 3000);
    assert.equal(json(await m.call('check_port', { host: '127.0.0.1', port: closed })).state, 'closed');
    assert.equal(json(await m.call('check_port', { host: 'localhost', port: String(open) })).state, 'open');
    for (const port of [0, 70000, 'http', 1.5]) {
      assert.equal(textOf(await m.call('check_port', { host: '127.0.0.1', port })), 'port must be a whole number from 1 to 65535.');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  const silent = () => Object.assign(new EventEmitter(), { destroy() {}, remoteAddress: undefined });
  const hang = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: { connect: silent } });
  assert.deepEqual(json(await hang.call('check_port', { host: '10.1.2.3', port: 22, timeoutMs: 100 })), { host: '10.1.2.3', port: 22, state: 'timeout', waitedMs: 100 });
  const failing = (code) => ({
    connect: () => {
      const s = silent();
      setImmediate(() => s.emit('error', Object.assign(new Error(code), { code })));
      return s;
    }
  });
  const nx = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: failing('ENOTFOUND') });
  assert.equal(textOf(await nx.call('check_port', { host: 'nope.invalid', port: 80 })), 'Could not resolve nope.invalid.');
  const unreachable = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: failing('EHOSTUNREACH') });
  assert.equal(json(await unreachable.call('check_port', { host: '10.9.9.9', port: 80 })).state, 'unreachable');
  // Node reports a failed attempt on every address of a name as one AggregateError.
  const both = createMachineTools({
    platform: 'linux', runCommand: stubRunner({}),
    host: { connect: () => { const s = silent(); setImmediate(() => s.emit('error', Object.assign(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]), {}))); return s; } }
  });
  assert.equal(json(await both.call('check_port', { host: 'localhost', port: 81 })).state, 'closed');
});

// kill_process

function killHost({ alive = new Set([4321]), pid = 100, ppid = 50, electron = false, kill } = {}) {
  const sent = [];
  return {
    sent,
    host: stubHost({
      pid: () => pid,
      ppid: () => ppid,
      electron: () => electron,
      kill: kill || ((target, sig) => {
        if (sig !== 0) sent.push([target, sig]);
        if (!alive.has(target)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        if (sig !== 0) alive.delete(target);
        return true;
      })
    })
  };
}

test('kill_process stops a process, names it and waits for it to exit', async () => {
  const { host, sent } = killHost();
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner({ 'ps -o comm= -p 4321': '/usr/local/bin/node\n' }), host });
  assert.deepEqual(json(await m.call('kill_process', { pid: 4321 })), { pid: 4321, name: 'node', signal: 'SIGTERM', exited: true });
  assert.deepEqual(sent, [[4321, 'SIGTERM']]);
  assert.equal(textOf(await m.call('kill_process', { pid: 4321 })), 'No process has pid 4321.');
  const forced = killHost({ alive: new Set([77]) });
  const f = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host: forced.host });
  assert.deepEqual(json(await f.call('kill_process', { pid: '77', force: true })), { pid: 77, signal: 'SIGKILL', exited: true });
  const win = killHost({ alive: new Set([5555]) });
  const w = createMachineTools({ platform: 'win32', runCommand: stubRunner({ 'tasklist /fi PID eq 5555 /fo csv /nh': '"node.exe","5555","Console","1","45,000 K"\r\n' }), host: win.host });
  assert.deepEqual(json(await w.call('kill_process', { pid: 5555 })), { pid: 5555, name: 'node.exe', signal: 'terminate', exited: true });
});

test('kill_process refuses the system, this server, the backend and bad pids', async () => {
  const { host, sent } = killHost();
  const m = createMachineTools({ platform: 'linux', runCommand: stubRunner({}), host });
  assert.equal(textOf(await m.call('kill_process', { pid: 100 })), 'Refusing to stop Mirabilis itself.');
  assert.equal(textOf(await m.call('kill_process', { pid: 50 })), 'Refusing to stop Mirabilis itself.');
  assert.equal(textOf(await m.call('kill_process', { pid: 1 })), 'Refusing to stop pid 1: it is part of the operating system.');
  assert.equal(textOf(await m.call('kill_process', { pid: 0 })), 'Refusing to stop pid 0: it is part of the operating system.');
  for (const pid of [-5, 'abc', 2.5, null, true, '', ' ']) {
    assert.equal(textOf(await m.call('kill_process', { pid })), 'pid must be a positive whole number.', String(pid));
  }
  assert.deepEqual(sent, [], 'no signal was sent');
});

test('kill_process in the desktop app also protects the app and its own processes, not what the backend started', async () => {
  // 40 is the app, 50 the backend, 60 the frontend server, 100 this server, 80 a model
  // runtime the backend started, 4321 something else entirely.
  const table = ['1 0', '40 1', '50 40', '60 40', '70 60', '80 50', '100 50', '4321 1'].join('\n');
  const { host, sent } = killHost({ electron: true, alive: new Set([4321, 60, 70, 80]) });
  const m = createMachineTools({ platform: 'darwin', runCommand: stubRunner({ 'ps -A -o pid=,ppid=': table }), host });
  for (const pid of [40, 50, 60, 100]) assert.equal(textOf(await m.call('kill_process', { pid })), 'Refusing to stop Mirabilis itself.', String(pid));
  for (const pid of [80, 70, 4321]) assert.equal(json(await m.call('kill_process', { pid })).exited, true, String(pid));
  assert.deepEqual(sent, [[80, 'SIGTERM'], [70, 'SIGTERM'], [4321, 'SIGTERM']]);
  // Outside the desktop app the frontend is an ordinary process.
  const dev = killHost({ alive: new Set([60]) });
  assert.equal(json(await createMachineTools({ platform: 'darwin', runCommand: stubRunner({}), host: dev.host }).call('kill_process', { pid: 60 })).exited, true);
  // Windows asks CIM for the process tree.
  const winTable = [[1, 0], [40, 1], [50, 40], [60, 40], [100, 50], [4321, 1]].map(([p, pp]) => ({ p, pp }));
  const w = killHost({ electron: true, alive: new Set([4321, 60]) });
  const win = createMachineTools({ platform: 'win32', runCommand: windowsRunner({ Win32_Process: winTable }), host: w.host });
  assert.equal(textOf(await win.call('kill_process', { pid: 60 })), 'Refusing to stop Mirabilis itself.');
});

test('kill_process explains permission errors and a process that will not quit', async () => {
  const denied = killHost({ kill: (_pid, sig) => { if (sig !== 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); } });
  const d = createMachineTools({ platform: 'darwin', runCommand: stubRunner({ 'ps -o comm= -p 406': '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer\n' }), host: denied.host });
  assert.equal(textOf(await d.call('kill_process', { pid: 406 })), 'Not permitted to stop 406 (WindowServer): it belongs to another user or the system.');
  let t = 0;
  const stubborn = killHost({ kill: () => true });
  const s = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'ps -o stat= -p 4321': 'S\n' }), host: stubborn.host, now: () => (t += 1_000) });
  assert.deepEqual(json(await s.call('kill_process', { pid: 4321 })), { pid: 4321, signal: 'SIGTERM', exited: false, note: 'Still running; call again with force true to kill it.' });
  t = 0;
  const zombie = createMachineTools({ platform: 'linux', runCommand: stubRunner({ 'ps -o stat= -p 4321': 'Z+\n' }), host: stubborn.host, now: () => (t += 1_000) });
  assert.equal(json(await zombie.call('kill_process', { pid: 4321 })).exited, true, 'an exited process waiting for its parent is done');
});

test('kill_process stops a real process on this machine', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const gone = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => child.once('spawn', resolve));
  const m = createMachineTools();
  const out = json(await m.call('kill_process', { pid: child.pid }));
  assert.equal(out.pid, child.pid);
  assert.equal(out.exited, true);
  assert.match(out.name, /node/i);
  await gone;
  assert.equal(textOf(await m.call('kill_process', { pid: process.pid })), 'Refusing to stop Mirabilis itself.');
});

// Parsers

test('the launchd parsers read list, print and print-disabled output', () => {
  assert.deepEqual(parseLaunchctlList(DARWIN_LAUNCHCTL_LIST).slice(0, 3), [
    { label: 'com.apple.SafariHistoryServiceAgent', pid: null, status: 0 },
    { label: 'com.apple.progressd', pid: null, status: -9 },
    { label: 'com.apple.Finder', pid: 691, status: 0 }
  ]);
  assert.deepEqual(parseLaunchctlPrint(DARWIN_LAUNCHCTL_SYSTEM).map((r) => [r.label, r.pid, r.status]), [
    ['com.apple.lskdd', null, null], ['com.apple.runningboardd', 415, null], ['com.apple.wifiFirmwareLoader', null, 1],
    ['com.apple.kernelmanager_helper', null, null], ['com.microsoft.OneDriveStandaloneUpdaterDaemon', null, -15], ['com.vix.cron', 812, null]
  ]);
  assert.deepEqual([...parseLaunchctlDisabled(DARWIN_DISABLED_USER + DARWIN_DISABLED_SYSTEM)], [
    ['com.apple.ScriptMenuApp', true], ['org.virtualbox.vboxwebsvc', true], ['homebrew.mxcl.postgresql@18', false],
    ['com.vix.cron', false], ['com.example.legacy', true]
  ]);
  assert.deepEqual(parseLaunchdPlist(plist('<key>Label</key><string>a&amp;b</string><key>Program</key><string>/x/y</string><key>WatchPaths</key><array/>')),
    { label: 'a&b', command: 'y', starts: 'on change', disabled: false });
  assert.deepEqual(parseLaunchdPlist(plist('<key>Disabled</key><true/>')), { label: undefined, command: '', starts: 'on demand', disabled: true });
});

test('the log parsers handle compact macOS lines, journal JSON and event log rows', () => {
  const mac = parseMacLog(DARWIN_LOG);
  assert.equal(mac.length, 7);
  assert.deepEqual({ ...mac[3], time: undefined }, { time: undefined, level: 'fault', process: 'Google Chrome Helper (Renderer)', pid: '981', message: '[com.google.Chrome:gpu] GPU process crashed with a second line of detail' });
  const journal = parseJournal(`${JOURNAL}\n-- No entries --\n{broken json\n`);
  assert.equal(journal.length, 5);
  assert.equal(journal[3].message, 'hi bytes');
  assert.equal(journal[0].process, 'kernel');
  assert.equal(journal[3].process, 'node', '_COMM stands in for a missing identifier');
  const win = parseWinEvents(WIN_EVENTS[0]);
  assert.equal(win.length, 1, 'a single event arrives as an object, not an array');
  assert.equal(win[0].process, 'DistributedCOM 10016');
  assert.deepEqual(parseWinEvents(null), []);
  const groups = groupLogEntries([
    { time: new Date(1), level: 'error', process: 'a', pid: '1', message: 'took 12 ms on 0x1f' },
    { time: new Date(2), level: 'error', process: 'b', pid: '2', message: 'other' },
    { time: new Date(3), level: 'error', process: 'a', pid: '1', message: 'took 900 ms on 0xff' }
  ]);
  assert.deepEqual(groups.map((g) => [g.last.process, g.count, g.last.message]), [['b', 1, 'other'], ['a', 2, 'took 900 ms on 0xff']]);
});

test('parseSystemctlUnits strips the failed marker and keeps descriptions', () => {
  const rows = parseSystemctlUnits(LINUX_UNITS);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[2], { unit: 'certbot.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Certbot' });
  assert.deepEqual(parseSystemctlUnits(`${String.fromCodePoint(0xd7)} x.service loaded failed failed X\n`).map((r) => r.unit), ['x.service']);
});

// Output budget

test('fitResult trims lists from the chosen end, counts what it left out and keeps strings whole when it can', () => {
  const small = { a: 1, list: [1, 2] };
  assert.equal(fitResult(small, [['list', 'end']]), JSON.stringify(small));
  const big = { items: Array.from({ length: 200 }, (_, i) => `item-${i}-${'x'.repeat(40)}`), itemsNotShown: 5 };
  const fromEnd = JSON.parse(fitResult(big, [['items', 'end']]));
  assert.equal(fromEnd.items[0], big.items[0]);
  assert.equal(fromEnd.items.length + fromEnd.itemsNotShown, 205);
  const fromStart = JSON.parse(fitResult(big, [['items', 'start']]));
  assert.equal(fromStart.items[fromStart.items.length - 1], big.items[199]);
  const text = { shown: 300, text: Array.from({ length: 300 }, (_, i) => `line ${i} "quoted" \\ back`).join('\n') };
  const cut = JSON.parse(fitResult(text, [['text', 'start']]));
  assert.ok(cut.text.endsWith('line 299 "quoted" \\ back'));
  assert.equal(cut.shown, cut.text.split('\n').length);
  assert.equal(cut.truncated, true);
  const quotes = { s: '"'.repeat(2500) };
  assert.ok(fits(fitResult(quotes)), 'the escaped form counts too');
  assert.ok(fits(fitResult({ n: 'y'.repeat(9000) })));
  // Bisection, not one serialization per item.
  const started = Date.now();
  const huge = JSON.parse(fitResult({ notMeasured: Array.from({ length: 100_000 }, (_, i) => `file-${i}.bin`) }, [['notMeasured', 'end']]));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  assert.equal(huge.notMeasured.length + huge.notMeasuredNotShown, 100_000);
  assert.ok(huge.notMeasured.length > 100, 'as many as fit are kept');
  const one = { shown: 1, text: 'x'.repeat(5000) };
  assert.ok(fits(fitResult(one, [['text', 'start']])), 'a single long line is shortened instead');
});

test('formatBytes uses decimal units like Finder', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1000), '1 KB');
  assert.equal(formatBytes(307_200), '307 KB');
  assert.equal(formatBytes(30_720), '30.7 KB');
  assert.equal(formatBytes(2_097_152), '2.1 MB');
  assert.equal(formatBytes(123_456_789_012), '123 GB');
  assert.equal(formatBytes(2e12), '2 TB');
});

// The tail-keeping runner

test('machineRunner with tailBytes keeps the newest whole lines of a long output', async () => {
  const script = "let s = ''; for (let i = 0; i < 200000; i++) s += 'line ' + i + '\\n'; process.stdout.write(s);";
  const res = await machineRunner(process.execPath, ['-e', script], { tailBytes: 64 * 1024, timeoutMs: 20_000 });
  assert.ok(res.dropped > 0);
  assert.ok(Buffer.byteLength(res.stdout) <= 64 * 1024);
  const lines = res.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^line \d+$/, 'the cut line is dropped');
  assert.equal(lines[lines.length - 1], 'line 199999');
  const run = createProbeRunner({ platform: process.platform, runCommand: machineRunner });
  const missing = await run('mirabilis-no-such-command-7f3a', [], undefined, { tailBytes: 1024 });
  assert.equal(missing.missing, true);
  const slow = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], undefined, { tailBytes: 1024, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  const failed = await run(process.execPath, ['-e', "process.stdout.write('partial\\n'); process.exit(3)"], undefined, { tailBytes: 1024 });
  assert.equal(failed.ok, false);
  assert.equal(failed.stdout, 'partial\n');
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], controller.signal, { tailBytes: 1024, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 100);
  assert.match((await pending).error, /was cancelled/);
});

// No utility at all

test('every tool answers in one plain sentence on a machine with none of the utilities', async () => {
  const dir = await tempDir();
  const log = path.join(dir, 'a.log');
  await fs.writeFile(log, 'hello\n');
  const args = {
    read_log: { path: log }, disk_usage: { path: dir }, ping_host: { host: '127.0.0.1' }, dns_lookup: { name: 'localhost' },
    check_port: { host: '127.0.0.1', port: 9 }, kill_process: { pid: 999_999 }
  };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const m = createMachineTools({
      platform,
      runCommand: stubRunner({}),
      host: stubHost({ homedir: () => dir, readdir: (p) => fs.readdir(p, { withFileTypes: true }), kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } })
    });
    for (const name of TOOL_NAMES) {
      const r = await m.call(name, args[name] || {});
      const text = textOf(r);
      assert.ok(fits(text), `${platform} ${name}`);
      if (r.isError) assert.doesNotMatch(text, /\n|undefined|\[object/, `${platform} ${name}: ${text}`);
      else assert.doesNotThrow(() => JSON.parse(text), `${platform} ${name}`);
    }
  }
});

// The real thing, on the machine running the tests.

test('the read-only tools run for real here within the budget', { skip: process.platform === 'win32' }, async () => {
  const dir = await fillFolder();
  const m = createMachineTools({ dataDir: dir });
  for (const [name, args] of [
    ['hardware_info', {}], ['services', { limit: 5 }], ['startup_items', {}], ['system_logs', { minutes: 1, limit: 5 }],
    ['disk_usage', { path: dir }], ['dns_lookup', { name: 'localhost' }], ['ping_host', { host: '127.0.0.1', count: 1 }]
  ]) {
    const r = await m.call(name, args);
    const text = textOf(r);
    assert.ok(fits(text), `${name} is ${text.length} characters`);
    // What this machine lacks or does not let this user read is an answer, not a failure.
    if (r.isError) assert.match(text, /not available on this system|cannot read|Permission denied|not permitted/i, `${name}: ${text}`);
    else assert.equal(typeof JSON.parse(text), 'object', name);
  }
});
