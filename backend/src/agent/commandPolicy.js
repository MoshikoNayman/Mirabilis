// @ts-check
// Decide whether a shell command only reads. Security boundary: Read only access
// and the auto-allow path of Ask first depend on it. When unsure, not read-only.

/** Split a word into its program basename, honouring / and \ separators. */
function basenameOf(token, platform) {
  const s = String(token || '');
  const parts = platform === 'win32' ? s.split(/[\\/]/) : s.split('/');
  return parts[parts.length - 1] || s;
}

/** First argument that is not a flag. */
function firstNonFlag(args) {
  for (const a of args) if (!a.startsWith('-')) return a;
  return undefined;
}

/**
 * The subcommand of a tool that takes global value options before it.
 * Skips `flag value` pairs and `--flag=value` and bare flags.
 */
function extractSub(args, valueFlags) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (valueFlags.has(a)) { i += 1; continue; }
    if (a.startsWith('--') && a.includes('=')) continue;
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

/** Index of the first non-flag arg (the subcommand position). */
function subIndex(args, valueFlags) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (valueFlags.has(a)) { i += 1; continue; }
    if (a.startsWith('--') && a.includes('=')) continue;
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/** Short-flag cluster (e.g. -qf) that contains one of these letters. */
function clusterHas(arg, letters) {
  if (!/^-[A-Za-z]+$/.test(arg)) return false;
  for (const ch of letters) if (arg.includes(ch)) return true;
  return false;
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const DOCKER_VALUE_FLAGS = new Set(['-H', '--host', '--context', '-c', '--config', '--log-level']);
const NPM_VALUE_FLAGS = new Set(['--prefix', '-C', '-w', '--workspace']);
const MAKE_VALUE_FLAGS = new Set(['-C', '-f', '-I', '-o', '-W', '--directory', '--file', '--makefile']);

/** Global value options to skip before a program's subcommand. */
function valueFlagsFor(prog) {
  if (prog === 'git') return GIT_VALUE_FLAGS;
  if (prog === 'docker') return DOCKER_VALUE_FLAGS;
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn') return NPM_VALUE_FLAGS;
  if (prog === 'make') return MAKE_VALUE_FLAGS;
  return new Set();
}

/** System bin dirs where a path-qualified read-only program is still trusted. */
const SYSTEM_BIN_DIRS = new Set(['/bin', '/usr/bin', '/sbin', '/usr/sbin', '/opt/homebrew/bin', '/usr/local/bin']);

/** The directory of a path-qualified token is a trusted system bin dir. */
function inSystemBin(token) {
  const slash = token.lastIndexOf('/');
  const dir = slash > 0 ? token.slice(0, slash) : token.slice(0, slash + 1);
  return SYSTEM_BIN_DIRS.has(dir);
}

/** Programs read-only no matter their arguments (POSIX). */
const ALWAYS = new Set([
  'ls', 'cat', 'head', 'wc', 'stat', 'du', 'df', 'grep', 'egrep', 'fgrep',
  'which', 'whereis', 'uname', 'sw_vers', 'whoami', 'id', 'groups', 'uptime', 'printenv',
  'ps', 'vm_stat', 'system_profiler', 'ioreg', 'netstat', 'lsof', 'traceroute', 'dig',
  'nslookup', 'host', 'free', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'nproc', 'getconf',
  'locale', 'cut', 'tr', 'column', 'jq', 'echo', 'printf', 'pwd',
  'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum', 'sha256sum', 'md5sum',
  'mdfind', 'mdls', 'kextstat', 'true', 'test', '['
]);

/** Argument rules for programs that are read-only only in some forms (POSIX). */
const RULES = /** @type {Record<string, (args: string[], platform: string) => boolean>} */ ({
  tail: (args) => !args.some((a) => a === '-f' || a === '-F' || a === '--follow' || clusterHas(a, 'fF')),
  find: (args) => !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a)),
  // rg --pre and --hostname-bin run an external program on matched files.
  rg: (args) => !args.some((a) => a === '--pre' || a.startsWith('--pre=')
    || a === '--pre-glob' || a.startsWith('--pre-glob=')
    || a === '--hostname-bin' || a.startsWith('--hostname-bin=')),
  // sort -o / --output overwrite a file; any short cluster with o is the output flag.
  sort: (args) => !args.some((a) => a === '-o' || a === '--output' || a.startsWith('--output=')
    || (/^-[^-]/.test(a) && a.includes('o'))),
  // uniq writes its OUTPUT operand; allow at most one (INPUT) non-flag operand.
  uniq: (args) => {
    if (args.some((a) => a === '-o' || a === '--output' || a.startsWith('--output='))) return false;
    const valueFlags = new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars']);
    let operands = 0;
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (valueFlags.has(a)) { i += 1; continue; }
      if (a.startsWith('-') && a !== '-') continue;
      operands += 1;
    }
    return operands <= 1;
  },
  // tree -o writes its listing to a file.
  tree: (args) => !args.some((a) => a === '-o' || a === '--output' || a.startsWith('--output=')),
  // file -C compiles and writes a magic file.
  file: (args) => !args.some((a) => a === '-C' || a === '--compile' || clusterHas(a, 'C')),
  hostname: (args) => args.length === 0,
  // date -s/--set and the BSD positional form (date 1130, date 010112002025) set the clock.
  date: (args) => {
    const valueFlags = new Set(['-r', '-d', '-t', '-f', '--date', '--reference', '--file']);
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a === '-s' || a === '--set' || a.startsWith('--set=')) return false;
      if (valueFlags.has(a)) { i += 1; continue; }
      if (a.startsWith('+')) continue;
      if (a.startsWith('-')) continue;
      if (/^\d{4,}(\.\d{2})?$/.test(a)) return false;
    }
    return true;
  },
  top: (args, platform) => {
    if (platform === 'linux') {
      const hasB = args.includes('-b') || args.some((a) => clusterHas(a, 'b'));
      const nIdx = args.indexOf('-n');
      const hasN = (nIdx >= 0 && /^\d+$/.test(args[nIdx + 1] || '')) || args.some((a) => /^-n\d+$/.test(a));
      return hasB && hasN;
    }
    const lIdx = args.indexOf('-l');
    return (lIdx >= 0 && /^\d+$/.test(args[lIdx + 1] || '')) || args.some((a) => /^-l\d+$/.test(a));
  },
  iostat: (args) => args.some((a) => /^\d+$/.test(a)),
  sysctl: (args) => !args.some((a) => a === '-w' || a.includes('=')),
  pmset: (args) => args[0] === '-g',
  diskutil: (args) => args[0] === 'list' || args[0] === 'info' || (args[0] === 'apfs' && args[1] === 'list'),
  ifconfig: (args) => args.length === 0
    || (args.length === 1 && (['-a', '-l', '-s'].includes(args[0]) || !args[0].startsWith('-'))),
  ip: (args) => ['a', 'addr', 'address', 'r', 'route', 'l', 'link', 'n', 'neigh'].includes(args[0])
    && (args[1] === undefined || ['show', 'list', 'ls'].includes(args[1])),
  route: (args, platform) => (platform === 'linux'
    ? (args.length === 1 && args[0] === '-n')
    : (args[0] === '-n' && args[1] === 'get')),
  arp: (args) => args[0] === '-a' || args[0] === '-an',
  ping: (args) => {
    const ci = args.indexOf('-c');
    const n = ci >= 0 ? Number(args[ci + 1]) : NaN;
    const inline = args.map((a) => /^-c(\d+)$/.exec(a)).find(Boolean);
    const inlineN = inline ? Number(inline[1]) : NaN;
    return (Number.isFinite(n) && n >= 1 && n <= 20) || (Number.isFinite(inlineN) && inlineN >= 1 && inlineN <= 20);
  },
  scutil: (args) => ['--dns', '--proxy', '--get', '--nwi'].includes(args[0]),
  networksetup: (args) => Boolean(args[0]) && (args[0].startsWith('-get') || args[0].startsWith('-list')),
  launchctl: (args) => ['list', 'print', 'blame'].includes(args[0]),
  log: (args) => args[0] === 'show',
  journalctl: (args) => !args.some((a) => a === '-f' || a === '--follow' || clusterHas(a, 'f')
    || a.startsWith('--vacuum') || ['--rotate', '--flush', '--sync', '--relinquish-var'].includes(a)),
  dmesg: (args) => !args.some((a) => a === '-c' || a === '-C' || a === '--clear' || clusterHas(a, 'cC')),
  systemctl: (args) => ['status', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'show', 'cat'].includes(firstNonFlag(args)),
  service: (args) => args.length === 1 && args[0] === '--status-all',
  brew: (args) => {
    if (args[0] === '--version') return true;
    const sub = firstNonFlag(args);
    if (['list', 'ls', 'info', 'doctor', 'config', 'outdated', 'leaves', 'deps'].includes(sub)) return true;
    if (sub === 'services') return args[args.indexOf('services') + 1] === 'list';
    return false;
  },
  npm: (args) => {
    if (args[0] === '-v' || args[0] === '--version') return true;
    const sub = firstNonFlag(args);
    if (['ls', 'list', 'view', 'outdated', 'doctor'].includes(sub)) return true;
    if (sub === 'config') {
      const next = args[args.indexOf('config') + 1];
      return next === 'get' || next === 'list';
    }
    return false;
  },
  node: (args) => args[0] === '-v' || args[0] === '--version',
  python3: (args) => args[0] === '--version' || args[0] === '-V',
  python: (args) => args[0] === '--version' || args[0] === '-V',
  pip: (args) => ['list', 'show', 'freeze'].includes(firstNonFlag(args)),
  pip3: (args) => ['list', 'show', 'freeze'].includes(firstNonFlag(args)),
  git: (args) => gitReadOnly(args),
  docker: (args) => {
    const sub = extractSub(args, DOCKER_VALUE_FLAGS);
    const i = subIndex(args, DOCKER_VALUE_FLAGS);
    const post = i >= 0 ? args.slice(i + 1) : [];
    if (['ps', 'images', 'info', 'version', 'inspect'].includes(sub)) return true;
    if (sub === 'logs') return !post.some((a) => a === '-f' || a === '--follow' || clusterHas(a, 'f'));
    if (sub === 'stats') return post.includes('--no-stream');
    return false;
  },
  ollama: (args) => {
    if (args[0] === '--version' || args[0] === '-v') return true;
    return ['list', 'ls', 'ps', 'show'].includes(firstNonFlag(args));
  },
  openssl: (args) => args[0] === 'version',
  defaults: (args) => args[0] === 'read',
  plutil: (args) => args[0] === '-p' || args[0] === '-lint',
  codesign: (args) => ['-d', '-dv', '-dvv', '-v', '--verify'].includes(args[0])
    && !args.some((a) => a === '-s' || a === '--sign' || a === '--remove-signature' || a === '-f'),
  spctl: (args) => args[0] === '--assess' || args[0] === '--status',
  csrutil: (args) => args[0] === 'status',
  fdesetup: (args) => args[0] === 'status',
  softwareupdate: (args) => args[0] === '-l' || args[0] === '--list'
});

/** git subcommands and their read-only argument rules. */
function gitReadOnly(args) {
  const i = subIndex(args, GIT_VALUE_FLAGS);
  if (i < 0) return false;
  // Global options before the subcommand that inject config or run a program.
  const pre = args.slice(0, i);
  if (pre.some((a) => a === '-c' || a === '--config-env' || a.startsWith('--config-env=')
    || a === '--exec-path' || a.startsWith('--exec-path=')
    || a === '-p' || a === '--paginate')) {
    return false;
  }
  const sub = args[i];
  const post = args.slice(i + 1);
  if (['status', 'rev-parse', 'describe', 'blame', 'ls-files', 'ls-tree', 'shortlog'].includes(sub)) {
    return true;
  }
  if (['log', 'diff', 'show'].includes(sub)) {
    // --output writes a file; --ext-diff and --textconv run a configured program.
    return !post.some((a) => a === '--output' || a.startsWith('--output=')
      || a === '--ext-diff' || a === '--textconv');
  }
  if (sub === 'branch') {
    const mutators = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy',
      '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'];
    if (post.some((a) => mutators.includes(a) || a.startsWith('--set-upstream')
      || a.startsWith('--set-upstream-to='))) {
      return false;
    }
    const listFlags = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
      '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
    const hasListFlag = post.some((a) => listFlags.includes(a) || a.startsWith('--contains=')
      || a.startsWith('--points-at=') || a.startsWith('--format=') || a.startsWith('--sort='));
    const operands = post.filter((a) => !a.startsWith('-'));
    // A bare operand creates or renames a branch; only a listing filter is read-only.
    return operands.length === 0 || hasListFlag;
  }
  if (sub === 'remote') {
    if (post.length === 0) return true;
    const rsub = extractSub(post, new Set());
    if (rsub === undefined) return post.every((a) => a === '-v' || a === '--verbose');
    return rsub === 'show' || rsub === 'get-url';
  }
  if (sub === 'tag') {
    if (post.some((a) => ['-d', '-a', '-s', '-m', '-f', '--delete'].includes(a))) return false;
    return post.length === 0 || post.includes('-l') || post.includes('--list');
  }
  if (sub === 'config') {
    const getFlag = post.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
    const setish = post.some((a) => ['--replace-all', '--add', '--unset', '--unset-all'].includes(a));
    const operands = post.filter((a) => !a.startsWith('-'));
    return getFlag && !setish && operands.length <= 1;
  }
  return false;
}

/** Windows (win32) read-only programs. */
function winReadOnly(prog, args) {
  const p = prog.toLowerCase();
  if (['dir', 'type', 'where', 'findstr', 'systeminfo', 'tasklist', 'netstat', 'hostname', 'whoami', 'ver', 'tracert', 'nslookup'].includes(p)) {
    return true;
  }
  if (p === 'ipconfig') return args.length === 0 || (args.length === 1 && args[0].toLowerCase() === '/all');
  if (p === 'ping') {
    const ni = args.indexOf('-n');
    const n = ni >= 0 ? Number(args[ni + 1]) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 20;
  }
  return false;
}

const NETWORK_PROGRAMS = new Set([
  'ping', 'traceroute', 'tracert', 'dig', 'nslookup', 'host', 'curl', 'wget',
  'softwareupdate', 'ssh', 'scp', 'rsync', 'nc', 'telnet', 'ftp'
]);

const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'brew', 'docker', 'kubectl', 'cargo', 'go',
  'pip', 'pip3', 'systemctl', 'launchctl', 'ollama', 'make'
]);

/** Program names shown in Settings as read-only (POSIX). */
export const READ_ONLY_PROGRAMS = [...new Set([...ALWAYS, ...Object.keys(RULES)])].sort();

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const HARMLESS_REDIR = ['&>/dev/null', '2>/dev/null', '1>/dev/null', '2>&1', '>/dev/null', '</dev/null'];

/**
 * Lex a command into segments (split on | || && ;) with dequoted words, while
 * flagging any construct that could change state: substitution, subshell,
 * background, a redirection other than the harmless /dev/null forms, a newline.
 * @param {string} command
 * @returns {{segments: string[][], danger: string|null}}
 */
function analyze(command) {
  const s = String(command == null ? '' : command);
  if (s.includes('\n') || s.includes('\r')) return { segments: [], danger: 'contains a newline' };

  let state = 'normal'; // normal | single | double
  let escaped = false;
  /** @type {string|null} */
  let danger = null;
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let wordOpen = false;
  /** @type {string[]} */
  const mask = [];
  let prevSig = ' ';
  const setDanger = (r) => { if (!danger) danger = r; };
  const pushWord = () => { if (wordOpen) { words.push(word); word = ''; wordOpen = false; } };
  const pushSegment = () => { pushWord(); segments.push(words); words = []; };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];

    if (escaped) { word += c; wordOpen = true; mask.push(' '); prevSig = ' '; escaped = false; continue; }

    if (state === 'single') {
      if (c === "'") { state = 'normal'; wordOpen = true; } else { word += c; wordOpen = true; }
      mask.push(' '); prevSig = ' '; continue;
    }

    if (state === 'double') {
      if (c === '\\') {
        if (n === '$' || n === '`' || n === '"' || n === '\\') escaped = true;
        else { word += c; wordOpen = true; }
        mask.push(' '); prevSig = ' '; continue;
      }
      if (c === '"') { state = 'normal'; wordOpen = true; mask.push(' '); prevSig = ' '; continue; }
      if (c === '`') setDanger('uses command substitution');
      else if (c === '$' && n === '(') setDanger('uses command substitution');
      word += c; wordOpen = true; mask.push(' '); prevSig = ' '; continue;
    }

    // normal state
    if (c === '\\') { escaped = true; continue; }
    if (c === "'") { state = 'single'; wordOpen = true; mask.push(' '); prevSig = ' '; continue; }
    if (c === '"') { state = 'double'; wordOpen = true; mask.push(' '); prevSig = ' '; continue; }
    if (c === '`') { setDanger('uses command substitution'); pushWord(); mask.push(' '); prevSig = ' '; continue; }
    if (c === '$' && n === '(') { setDanger('uses command substitution'); i += 1; mask.push(' '); prevSig = ' '; continue; }
    if (c === '(' || c === ')') { setDanger('uses a subshell'); pushWord(); mask.push(' '); prevSig = ' '; continue; }
    if (c === ' ' || c === '\t') { pushWord(); mask.push(' '); prevSig = ' '; continue; }

    if (c === '|') {
      if (n === '|') { pushSegment(); i += 1; }
      else if (n === '&') { setDanger('pipes into the background'); pushSegment(); i += 1; }
      else pushSegment();
      mask.push(' '); prevSig = ' '; continue;
    }
    if (c === ';') { pushSegment(); mask.push(' '); prevSig = ' '; continue; }
    if (c === '&') {
      if (n === '&') { pushSegment(); i += 1; mask.push(' '); prevSig = ' '; continue; }
      if (n === '>') { pushWord(); mask.push('&', '>'); i += 1; prevSig = '>'; continue; }
      if (prevSig === '>') { mask.push('&'); prevSig = '&'; continue; }
      setDanger('runs in the background'); pushWord(); mask.push(' '); prevSig = ' '; continue;
    }
    if (c === '>' || c === '<') { pushWord(); mask.push(c); prevSig = c; continue; }

    word += c; wordOpen = true; mask.push(c); prevSig = c;
  }

  if (state !== 'normal' || escaped) setDanger('has an unterminated quote or trailing backslash');
  pushSegment();

  let scrub = mask.join('');
  for (const form of HARMLESS_REDIR) scrub = scrub.split(form).join(' ');
  if (/[<>]/.test(scrub)) setDanger('redirects to a file');

  return { segments: segments.filter((seg) => seg.length > 0), danger };
}

/** A single segment's program is read-only and its arguments pass its rules. */
function segmentReadOnly(words, platform) {
  if (!words.length) return false;
  if (ENV_ASSIGN_RE.test(words[0])) return false;
  const prog = basenameOf(words[0], platform);
  if (prog === 'sudo' || prog === 'doas' || prog === 'exec') return false;
  const args = words.slice(1);
  if (platform === 'win32') return winReadOnly(prog, args);
  // A path-qualified program is trusted only from a system bin dir; otherwise it
  // is any executable that happens to be named like a read-only tool.
  if (words[0].includes('/') && !inSystemBin(words[0])) return false;
  if (ALWAYS.has(prog)) return true;
  const rule = RULES[prog];
  return rule ? Boolean(rule(args, platform)) : false;
}

/** This segment touches the network. */
function segmentNetwork(words, platform) {
  const prog = basenameOf(words[0], platform);
  if (NETWORK_PROGRAMS.has(prog)) return true;
  const args = words.slice(1);
  if (prog === 'git' && ['fetch', 'pull', 'push', 'clone', 'ls-remote'].includes(extractSub(args, GIT_VALUE_FLAGS))) return true;
  if (prog === 'npm' && ['view', 'outdated'].includes(firstNonFlag(args))) return true;
  if (prog === 'brew' && firstNonFlag(args) === 'outdated') return true;
  return false;
}

/**
 * @param {string} command
 * @param {{platform?: string}} [opts]
 * @returns {{readOnly: boolean, network: boolean, programs: string[], prefix: string, reason: string}}
 */
export function classifyCommand(command, opts = {}) {
  const platform = opts.platform || process.platform;
  const { segments, danger } = analyze(command);
  const programs = segments.map((w) => basenameOf(w[0], platform));
  const network = segments.some((w) => segmentNetwork(w, platform));
  const prefix = ruleForCommand(command, { platform });

  if (danger) return { readOnly: false, network, programs, prefix, reason: danger };
  if (!segments.length) return { readOnly: false, network, programs, prefix, reason: 'no command to run' };

  const bad = segments.find((w) => !segmentReadOnly(w, platform));
  if (bad) {
    const prog = basenameOf(bad[0], platform);
    return { readOnly: false, network, programs, prefix, reason: `not a read-only command: ${prog}` };
  }
  return { readOnly: true, network, programs, prefix, reason: 'read-only' };
}

/**
 * The rule an "Always allow" click saves: program plus the first non-flag word
 * for subcommand tools, else the program alone. Based on the first segment.
 * @param {string} command
 * @param {{platform?: string}} [opts]
 * @returns {string}
 */
export function ruleForCommand(command, opts = {}) {
  const platform = opts.platform || process.platform;
  const { segments } = analyze(command);
  if (!segments.length) return '';
  const words = segments[0];
  const prog = basenameOf(words[0], platform);
  const args = words.slice(1);
  if ((prog === 'python3' || prog === 'python') && args[0] === '-m') {
    return args[1] ? `${prog} -m ${args[1]}` : `${prog} -m`;
  }
  if (SUBCOMMAND_PROGRAMS.has(prog)) {
    const sub = extractSub(args, valueFlagsFor(prog));
    return sub ? `${prog} ${sub}` : prog;
  }
  return prog;
}

/**
 * Normalize a segment for rule matching: basename the program and drop a
 * subcommand program's global value options so a saved `git pull` rule matches
 * `git -C repo pull`.
 */
function normalizeSegment(words, platform) {
  const prog = basenameOf(words[0], platform);
  const args = words.slice(1);
  if (SUBCOMMAND_PROGRAMS.has(prog)) {
    const idx = subIndex(args, valueFlagsFor(prog));
    if (idx >= 0) return [prog, ...args.slice(idx)];
  }
  return [prog, ...args];
}

/** A segment's normalized tokens begin with a rule's tokens. */
function segmentMatchesRule(words, ruleTokens, platform) {
  const norm = normalizeSegment(words, platform);
  if (norm.length < ruleTokens.length) return false;
  return ruleTokens.every((t, i) => t === norm[i]);
}

/**
 * True when every segment is read-only or matches a user rule. Any non-stripped
 * redirection or subshell syntax fails the whole command.
 * @param {string} command
 * @param {string[]} rules
 * @param {{platform?: string}} [opts]
 * @returns {boolean}
 */
export function matchesAllowRules(command, rules, opts = {}) {
  const platform = opts.platform || process.platform;
  const { segments, danger } = analyze(command);
  if (danger) return false;
  if (!segments.length) return false;
  const ruleTokens = (rules || [])
    .map((r) => String(r || '').trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
  return segments.every((words) => segmentReadOnly(words, platform)
    || ruleTokens.some((rt) => segmentMatchesRule(words, rt, platform)));
}
