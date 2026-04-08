import os from 'node:os';
import { exec as childExec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(childExec);

const APPLE_BANDWIDTH_MAP = [
  ['apple m4 max', '546 GB/s'],
  ['apple m4 pro', '273 GB/s'],
  ['apple m4', '120 GB/s'],
  ['apple m3 max', '300 GB/s'],
  ['apple m3 pro', '150 GB/s'],
  ['apple m3', '100 GB/s'],
  ['apple m2 ultra', '800 GB/s'],
  ['apple m2 max', '400 GB/s'],
  ['apple m2 pro', '200 GB/s'],
  ['apple m2', '100 GB/s'],
  ['apple m1 ultra', '800 GB/s'],
  ['apple m1 max', '400 GB/s'],
  ['apple m1 pro', '200 GB/s'],
  ['apple m1', '68 GB/s']
];

// More specific entries before less specific (e.g. 'm1 pro' before 'm1')
const APPLE_MEMORY_TYPE_MAP = [
  // Pro/Max/Ultra variants must appear before base entries
  ['apple m4 max', 'LPDDR5X'],
  ['apple m4 pro', 'LPDDR5X'],
  ['apple m4', 'LPDDR5'],       // base M4
  ['apple m3 max', 'LPDDR5X'],
  ['apple m3 pro', 'LPDDR5X'],
  ['apple m3', 'LPDDR5'],       // base M3
  ['apple m2 ultra', 'LPDDR5X'],
  ['apple m2 max', 'LPDDR5X'],
  ['apple m2 pro', 'LPDDR5X'],
  ['apple m2', 'LPDDR5'],       // base M2
  ['apple m1 ultra', 'LPDDR5'],
  ['apple m1 max', 'LPDDR5'],
  ['apple m1 pro', 'LPDDR5'],
  ['apple m1', 'LPDDR4X']       // base M1
];

const APPLE_NEURAL_ENGINE_MAP = [
  ['apple m4', '16C'],
  ['apple m3', '16C'],
  ['apple m2', '16C'],
  ['apple m1', '16C']
];

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatGb(value) {
  if (!value || Number.isNaN(Number(value))) {
    return 'Unknown';
  }
  return `${Number(value).toFixed(0)} GB`;
}

function extractNumber(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : 0;
}

async function runCommand(command, timeout = 4000) {
  try {
    const { stdout } = await execAsync(command, { timeout, maxBuffer: 1024 * 1024 * 4 });
    return stdout.trim();
  } catch {
    return '';
  }
}

function parseKeyValueLines(output) {
  const result = {};
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.includes('=') ? '=' : line.includes(':') ? ':' : null;
    if (!separator) continue;
    const [key, ...rest] = line.split(separator);
    result[normalizeWhitespace(key)] = normalizeWhitespace(rest.join(separator));
  }
  return result;
}

function parseLsCpu(output) {
  if (!output) return {};
  try {
    const parsed = JSON.parse(output);
    const entries = Array.isArray(parsed.lscpu) ? parsed.lscpu : [];
    return entries.reduce((acc, entry) => {
      if (entry?.field) {
        acc[normalizeWhitespace(entry.field.replace(/:$/, ''))] = normalizeWhitespace(entry.data);
      }
      return acc;
    }, {});
  } catch {
    return parseKeyValueLines(output);
  }
}

function vendorFromStrings(...values) {
  const haystack = values.map((value) => String(value || '').toLowerCase()).join(' ');
  if (haystack.includes('apple')) return 'apple';
  if (haystack.includes('nvidia') || haystack.includes('geforce') || haystack.includes('quadro') || haystack.includes('tesla')) return 'nvidia';
  if (haystack.includes('amd') || haystack.includes('radeon')) return 'amd';
  if (haystack.includes('intel')) return 'intel';
  if (haystack.includes('npu') || haystack.includes('neural') || haystack.includes('asic') || haystack.includes('tensor')) return 'npu';
  if (haystack.includes('arm') || haystack.includes('cortex') || haystack.includes('neoverse')) return 'arm';
  return 'generic';
}

function gpuCategoryForVendor(vendor) {
  switch (vendor) {
    case 'apple': return 'SoC GPU';
    case 'nvidia': return 'Dedicated GPU';
    case 'amd': return 'Dedicated GPU';
    case 'intel': return 'Integrated GPU';
    case 'arm': return 'Integrated GPU';
    case 'npu': return 'NPU';
    default: return 'CPU (no dedicated GPU)';
  }
}

function backendForVendor(vendor) {
  switch (vendor) {
    case 'apple': return 'Metal';
    case 'nvidia': return 'CUDA';
    case 'amd': return 'ROCm';
    case 'intel': return 'oneAPI';
    case 'arm': return 'ACL';
    case 'npu': return 'NPU';
    default: return 'CPU';
  }
}

function memoryTypeForVendor(vendor) {
  switch (vendor) {
    case 'apple': return 'Unified';
    case 'nvidia': return 'GDDR';
    case 'amd': return 'DDR';
    case 'intel': return 'DDR';
    case 'arm': return 'Shared';
    case 'npu': return 'SRAM/On-chip';
    default: return 'DDR';
  }
}

function lookupAppleBandwidth(chipName) {
  const lowerChip = String(chipName || '').toLowerCase();
  for (const [needle, bandwidth] of APPLE_BANDWIDTH_MAP) {
    if (lowerChip.includes(needle)) {
      return bandwidth;
    }
  }
  return 'Unknown';
}

function lookupAppleMemoryType(chipName) {
  const lower = String(chipName || '').toLowerCase();
  for (const [needle, memType] of APPLE_MEMORY_TYPE_MAP) {
    if (lower.includes(needle)) return memType;
  }
  return 'Unified';
}

function lookupAppleNeuralEngine(chipName) {
  const lower = String(chipName || '').toLowerCase();
  for (const [needle, value] of APPLE_NEURAL_ENGINE_MAP) {
    if (lower.includes(needle)) return value;
  }
  return '';
}

function formatCacheBytes(value) {
  const n = Number(value);
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function parseNvidiaSmiMemType(output) {
  const match = String(output || '').match(/Memory Type\s*:\s*(.+)/i);
  return match ? normalizeWhitespace(match[1]) : null;
}

function wmicMemoryTypeToString(code) {
  const map = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' };
  return map[Number(code)] || null;
}

function buildProfile({
  vendor,
  backend,
  archName,
  bandwidth,
  computeCores,
  logicName,
  cpuCores,
  cpuThreads,
  cpuClock,
  gpuClock,
  memorySize,
  memoryType,
  memorySpeed,
  subProcessorInfo,
  gpuCategory,
  gpuMemoryType,
  systemMemoryType,
  cpuCaches,
  npuLabel,
  npuExpanded
}) {
  const coresLabel = `${computeCores || cpuCores || 1}C`;
  const memoryLimit = memorySize || 'Unknown';
  const resolvedGpuCategory = gpuCategory || gpuCategoryForVendor(vendor || 'generic');
  const resolvedMemType = systemMemoryType || memoryTypeForVendor(vendor || 'generic');
  const cacheStr = cpuCaches
    ? ['l1', 'l2', 'l3'].map((k) => (cpuCaches[k] ? `${k.toUpperCase()}: ${cpuCaches[k]}` : null)).filter(Boolean).join(' / ')
    : null;

  const computeLines = [
    resolvedGpuCategory,
    `Arch: ${archName || 'Unknown'}`,
    `Bandwidth: ${bandwidth || 'Unknown'}`,
    gpuMemoryType ? `Memory: ${gpuMemoryType}` : null
  ].filter(Boolean);

  const logicLines = [
    `Arch: ${archName || 'Unknown'}`,
    cacheStr ? `Cache: ${cacheStr}` : null,
    subProcessorInfo || 'Sub-processor info unavailable'
  ].filter(Boolean);

  const memoryLines = [
    `Size: ${memoryLimit}`,
    `Type: ${resolvedMemType}`,
    memorySpeed ? `Speed: ${memorySpeed}` : null,
    bandwidth && bandwidth !== 'Unknown' ? `Bandwidth: ${bandwidth}` : null
  ].filter(Boolean);

  return {
    compute: {
      label: `${backend} • ${coresLabel}${gpuClock ? ' @ ' + gpuClock : ''}`,
      expanded: computeLines.join('\n')
    },
    logic: {
      label: `${logicName || 'Unknown'} • ${cpuCores || 1}C/${cpuThreads || cpuCores || 1}T${cpuClock ? ' @ ' + cpuClock : ''}`,
      expanded: logicLines.join('\n')
    },
    memory: {
      label: `${memoryLimit} • ${resolvedMemType}${memorySpeed ? ' • ' + memorySpeed : ''}`,
      expanded: memoryLines.join('\n')
    },
    npu: npuLabel
      ? {
          label: npuLabel,
          expanded: npuExpanded || 'NPU available'
        }
      : null,
    action: {
      label: 'Change Engine',
      options: [backend, 'CPU']
    }
  };
}

async function getDarwinProfile() {
  const [hardwareJson, displayJson, physicalCpuText, logicalCpuText, l1CacheText, l2CacheText, l3CacheText, memDataJson] = await Promise.all([
    runCommand('system_profiler SPHardwareDataType -json'),
    runCommand('system_profiler SPDisplaysDataType -json'),
    runCommand('sysctl -n hw.physicalcpu'),
    runCommand('sysctl -n hw.logicalcpu'),
    runCommand('sysctl -n hw.l1dcachesize'),
    runCommand('sysctl -n hw.l2cachesize'),
    runCommand('sysctl -n hw.l3cachesize'),
    runCommand('system_profiler SPMemoryDataType -json')
  ]);

  let hardware = {};
  let display = {};
  try {
    hardware = JSON.parse(hardwareJson || '{}').SPHardwareDataType?.[0] || {};
  } catch {}
  try {
    display = JSON.parse(displayJson || '{}').SPDisplaysDataType?.[0] || {};
  } catch {}

  const cpuModel = normalizeWhitespace(hardware.chip_type || hardware.cpu_type || os.cpus()?.[0]?.model || os.arch());
  const gpuName = normalizeWhitespace(display.sppci_model || display._name || cpuModel);
  const cpuCores = Math.max(1, Number(physicalCpuText) || os.cpus()?.length || 1);
  const cpuThreads = Math.max(cpuCores, Number(logicalCpuText) || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpuCores));
  const memorySize = normalizeWhitespace(hardware.physical_memory || formatGb(os.totalmem() / (1024 ** 3)));
  const bandwidth = lookupAppleBandwidth(cpuModel);
  const rawCpuSpeed = normalizeWhitespace(hardware.current_processor_speed || '');
  const cpuClock = rawCpuSpeed && !/^(unknown|n\/a)$/i.test(rawCpuSpeed) ? rawCpuSpeed : null;

  const cpuCaches = {
    l1: formatCacheBytes(l1CacheText),
    l2: formatCacheBytes(l2CacheText),
    l3: formatCacheBytes(l3CacheText) || null
  };

  // Memory type: try SPMemoryDataType first, fall back to chip lookup table
  let systemMemoryType = lookupAppleMemoryType(cpuModel);
  try {
    const memData = JSON.parse(memDataJson || '{}');
    const memItems = memData.SPMemoryDataType;
    if (Array.isArray(memItems)) {
      for (const slot of memItems) {
        const slotType = normalizeWhitespace(slot?.dimm_type || '');
        if (slotType && !/empty|n\/a/i.test(slotType)) {
          const typed = slotType.match(/(lpddr\w*|ddr\w*|hbm\w*)/i);
          if (typed) { systemMemoryType = typed[1].toUpperCase(); break; }
        }
      }
    }
  } catch {}

  const neuralEngine = lookupAppleNeuralEngine(cpuModel);
  const npuLabel = neuralEngine ? `NPU • ${neuralEngine}` : 'NPU • on-chip';
  const npuExpanded = [
    'Apple Neural Engine',
    neuralEngine ? `Configuration: ${neuralEngine}` : null,
    'Type: on-chip accelerator',
    'Workloads: local AI/ML inference'
  ].filter(Boolean).join('\n');

  return buildProfile({
    vendor: 'apple',
    backend: backendForVendor('apple'),
    archName: cpuModel,
    bandwidth,
    computeCores: cpuCores,
    logicName: cpuModel,
    cpuCores,
    cpuThreads,
    cpuClock,
    gpuClock: null,
    memorySize,
    memoryType: 'Unified',
    memorySpeed: bandwidth === 'Unknown' ? '' : bandwidth,
    subProcessorInfo: `Integrated graphics: ${gpuName}; Neural Engine is on-chip`,
    gpuCategory: 'SoC GPU',
    gpuMemoryType: `${systemMemoryType} (Unified)`,
    systemMemoryType,
    cpuCaches,
    npuLabel,
    npuExpanded
  });
}

async function getLinuxProfile() {
  const [lscpuJson, nvidiaInfo, clinfoText, totalMemText, nvidiaSmiQ, dmidecodeText, npuLspci, npuDevfs, dmidecodeSpeedText] = await Promise.all([
    runCommand('lscpu -J'),
    runCommand('nvidia-smi --query-gpu=name,memory.total,memory.bus_width,clocks.max.memory,clocks.max.graphics --format=csv,noheader,nounits'),
    runCommand('clinfo'),
    runCommand("awk '/MemTotal/ {print $2}' /proc/meminfo"),
    runCommand("nvidia-smi -q 2>/dev/null | grep 'Memory Type' | head -1"),
    runCommand("dmidecode -t 17 2>/dev/null | grep -m1 'Type:' | awk '{print $2}'"),
    runCommand("lspci 2>/dev/null | grep -iE 'npu|neural|ai accelerator|vpu|xdna|gaudi|habana' | head -1"),
    runCommand("ls /dev 2>/dev/null | grep -iE 'npu|accel|vpu' | head -5"),
    runCommand("dmidecode -t 17 2>/dev/null | grep -m1 'Configured Memory Speed:' | sed 's/.*Speed: //'")
  ]);

  const cpuInfo = parseLsCpu(lscpuJson);
  const cpuModel = normalizeWhitespace(cpuInfo['Model name'] || os.cpus()?.[0]?.model || os.arch());
  const archName = normalizeWhitespace(cpuInfo.Architecture || os.arch());
  const cpuCores = Math.max(1, Number(cpuInfo['Core(s) per socket']) || Number(cpuInfo['CPU(s)']) || os.cpus()?.length || 1);
  const cpuThreads = Math.max(cpuCores, Number(cpuInfo['CPU(s)']) || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpuCores));
  const memorySize = formatGb((Number(totalMemText) || os.totalmem() / 1024) / (1024 ** 2));
  const rawCpuMHz = Number(cpuInfo['CPU max MHz'] || cpuInfo['CPU MHz'] || 0);
  const cpuClock = rawCpuMHz > 0 ? `${(rawCpuMHz / 1000).toFixed(1)} GHz` : null;

  const cpuCaches = {
    l1: normalizeWhitespace(cpuInfo['L1d cache'] || '') || null,
    l2: normalizeWhitespace(cpuInfo['L2 cache'] || '') || null,
    l3: normalizeWhitespace(cpuInfo['L3 cache'] || '') || null
  };

  let vendor = vendorFromStrings(nvidiaInfo, clinfoText, cpuModel, archName);
  let gpuName = '';
  let bandwidth = 'Unknown';
  let gpuMemoryType = null;
  let gpuClock = null;

  if (nvidiaInfo) {
    const [name, memoryMb, busWidthBits, memoryClockMHz, gpuCoreMHz] = nvidiaInfo.split(',').map((part) => normalizeWhitespace(part));
    gpuName = name;
    const busWidth = Number(busWidthBits);
    const memoryClock = Number(memoryClockMHz);
    if (busWidth > 0 && memoryClock > 0) {
      const gbPerSec = Math.round(((memoryClock * 2) * (busWidth / 8)) / 1000);
      bandwidth = `${gbPerSec} GB/s`;
    }
    vendor = 'nvidia';
    gpuMemoryType = parseNvidiaSmiMemType(nvidiaSmiQ);
    gpuClock = gpuCoreMHz && Number(gpuCoreMHz) > 0 ? `${(Number(gpuCoreMHz) / 1000).toFixed(1)} GHz` : null;
  } else if (clinfoText) {
    const vendorMatch = clinfoText.match(/Device Vendor\s+(.+)/i);
    const nameMatch = clinfoText.match(/Device Name\s+(.+)/i);
    gpuName = normalizeWhitespace(nameMatch?.[1] || '');
    vendor = vendorFromStrings(vendorMatch?.[1], gpuName, cpuModel, archName);
  }

  // System RAM type via dmidecode (available without root on some distros)
  let systemMemoryType = null;
  const dmiType = normalizeWhitespace(dmidecodeText);
  if (dmiType && /^(ddr|lpddr|hbm)/i.test(dmiType)) {
    systemMemoryType = dmiType.toUpperCase();
  }
  const rawMemSpeed = normalizeWhitespace(dmidecodeSpeedText);
  const linuxMemSpeed = /^[0-9]/.test(rawMemSpeed) ? rawMemSpeed : '';

  const backend = backendForVendor(vendor);
  const memoryType = memoryTypeForVendor(vendor);
  const logicName = vendor === 'apple' || vendor === 'npu' ? normalizeWhitespace(gpuName || cpuModel) : cpuModel;
  const subProcessorInfo = gpuName
    ? `Accelerator: ${gpuName}; Host CPU: ${cpuModel}`
    : `Host processor: ${cpuModel}`;

  const npuSource = normalizeWhitespace(npuLspci || npuDevfs);
  const hasNpu = Boolean(npuSource);
  const npuLabel = hasNpu ? 'NPU • detected' : null;
  const npuExpanded = hasNpu
    ? ['Neural Processing Unit', `Device: ${npuSource}`, 'Workloads: local AI/ML inference'].join('\n')
    : null;

  return buildProfile({
    vendor,
    backend,
    archName,
    bandwidth,
    computeCores: cpuCores,
    logicName,
    cpuCores,
    cpuThreads,
    cpuClock,
    gpuClock,
    memorySize,
    memoryType,
    memorySpeed: linuxMemSpeed,
    subProcessorInfo,
    gpuCategory: gpuCategoryForVendor(vendor),
    gpuMemoryType,
    systemMemoryType,
    cpuCaches,
    npuLabel,
    npuExpanded
  });
}

async function getWindowsProfile() {
  const [cpuText, gpuText, memText, nvidiaInfo, nvidiaSmiQ, npuText] = await Promise.all([
    runCommand('wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors,L2CacheSize,L3CacheSize,MaxClockSpeed /format:list'),
    runCommand('wmic path win32_videocontroller get Name,AdapterRAM /format:list'),
    runCommand('wmic memorychip get Capacity,Speed,MemoryType /format:list'),
    runCommand('nvidia-smi --query-gpu=name,memory.total,memory.bus_width,clocks.max.memory,clocks.max.graphics --format=csv,noheader,nounits'),
    runCommand('nvidia-smi -q 2>&1 | findstr "Memory Type"'),
    runCommand('wmic path Win32_PnPEntity get Name /format:list | findstr /I "NPU Neural XDNA AI Boost"')
  ]);

  const cpuInfo = parseKeyValueLines(cpuText);
  const gpuInfo = parseKeyValueLines(gpuText);
  const memInfo = parseKeyValueLines(memText);
  const cpuModel = normalizeWhitespace(cpuInfo.Name || os.cpus()?.[0]?.model || os.arch());
  const cpuCores = Math.max(1, Number(cpuInfo.NumberOfCores) || os.cpus()?.length || 1);
  const cpuThreads = Math.max(cpuCores, Number(cpuInfo.NumberOfLogicalProcessors) || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpuCores));
  const memorySize = formatGb(os.totalmem() / (1024 ** 3));
  const memorySpeed = memInfo.Speed ? `${memInfo.Speed} MT/s` : '';
  const rawCpuMHz = Number(cpuInfo.MaxClockSpeed) || 0;
  const cpuClock = rawCpuMHz > 0 ? `${(rawCpuMHz / 1000).toFixed(1)} GHz` : null;

  // CPU caches — wmic reports L2/L3 in KB
  const l2Kb = Number(cpuInfo.L2CacheSize) || 0;
  const l3Kb = Number(cpuInfo.L3CacheSize) || 0;
  const cpuCaches = {
    l1: null,
    l2: l2Kb ? (l2Kb >= 1024 ? `${Math.round(l2Kb / 1024)} MB` : `${l2Kb} KB`) : null,
    l3: l3Kb ? (l3Kb >= 1024 ? `${Math.round(l3Kb / 1024)} MB` : `${l3Kb} KB`) : null
  };

  // System RAM type from wmic MemoryType numeric code
  const systemMemoryType = wmicMemoryTypeToString(memInfo.MemoryType) || null;

  let vendor = vendorFromStrings(nvidiaInfo, gpuInfo.Name, cpuModel, os.arch());
  let bandwidth = 'Unknown';
  let gpuName = normalizeWhitespace(gpuInfo.Name || '');
  let gpuMemoryType = null;
  let gpuClock = null;

  if (nvidiaInfo) {
    const [name, _memoryMb, busWidthBits, memoryClockMHz, gpuCoreMHz] = nvidiaInfo.split(',').map((part) => normalizeWhitespace(part));
    gpuName = name;
    const busWidth = Number(busWidthBits);
    const memoryClock = Number(memoryClockMHz);
    if (busWidth > 0 && memoryClock > 0) {
      const gbPerSec = Math.round(((memoryClock * 2) * (busWidth / 8)) / 1000);
      bandwidth = `${gbPerSec} GB/s`;
    }
    vendor = 'nvidia';
    gpuMemoryType = parseNvidiaSmiMemType(nvidiaSmiQ);
    gpuClock = gpuCoreMHz && Number(gpuCoreMHz) > 0 ? `${(Number(gpuCoreMHz) / 1000).toFixed(1)} GHz` : null;
  }

  const backend = backendForVendor(vendor);
  const npuLine = normalizeWhitespace(String(npuText || '').split(/\r?\n/).find((line) => /name\s*=\s*/i.test(line)) || npuText);
  const hasNpu = Boolean(npuLine);

  return buildProfile({
    vendor,
    backend,
    archName: normalizeWhitespace(os.arch()),
    bandwidth,
    computeCores: cpuCores,
    logicName: vendor === 'npu' ? normalizeWhitespace(gpuName || cpuModel) : cpuModel,
    cpuCores,
    cpuThreads,
    cpuClock,
    gpuClock,
    memorySize,
    memoryType: memoryTypeForVendor(vendor),
    memorySpeed,
    subProcessorInfo: gpuName ? `Accelerator: ${gpuName}; Host CPU: ${cpuModel}` : `Host processor: ${cpuModel}`,
    gpuCategory: gpuCategoryForVendor(vendor),
    gpuMemoryType,
    systemMemoryType,
    cpuCaches,
    npuLabel: hasNpu ? 'NPU • detected' : null,
    npuExpanded: hasNpu ? ['Neural Processing Unit', `Device: ${npuLine}`, 'Workloads: local AI/ML inference'].join('\n') : null
  });
}

export async function getLocalHardwareProfile() {
  switch (process.platform) {
    case 'darwin':
      return getDarwinProfile();
    case 'linux':
      return getLinuxProfile();
    case 'win32':
      return getWindowsProfile();
    default:
      return buildProfile({
        vendor: vendorFromStrings(os.arch()),
        backend: 'CPU',
        archName: normalizeWhitespace(os.arch()),
        bandwidth: 'Unknown',
        computeCores: os.cpus()?.length || 1,
        logicName: normalizeWhitespace(os.cpus()?.[0]?.model || os.arch()),
        cpuCores: os.cpus()?.length || 1,
        cpuThreads: typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus()?.length || 1),
        cpuClock: null,
        gpuClock: null,
        memorySize: formatGb(os.totalmem() / (1024 ** 3)),
        memoryType: 'DDR',
        memorySpeed: '',
        subProcessorInfo: 'Sub-processor info unavailable'
      });
  }
}