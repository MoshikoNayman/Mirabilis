// Regenerate desktop app icons from desktop/icons/icon-source.svg.
// Run from the frontend directory so the bundled `sharp` resolves:
//   cd frontend && node ../scripts/generate-icons.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// sharp lives in the frontend workspace; resolve it from there regardless of cwd.
const require = createRequire(join(root, 'frontend', 'package.json'));
const sharp = require('sharp');
const iconsDir = join(root, 'desktop', 'icons');
const src = join(iconsDir, 'icon-source.svg');

const png = (size) =>
  sharp(src, { density: 512 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

// 1) icon.png (1024)
writeFileSync(join(iconsDir, 'icon.png'), await png(1024));

// 2) icon.icns via macOS iconutil
const iset = join(iconsDir, 'icon.iconset');
rmSync(iset, { recursive: true, force: true });
mkdirSync(iset, { recursive: true });
const specs = [
  [16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'],
  [128, '128x128'], [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'],
  [512, '512x512'], [1024, '512x512@2x'],
];
for (const [sz, name] of specs) writeFileSync(join(iset, `icon_${name}.png`), await png(sz));
execSync(`iconutil -c icns -o "${join(iconsDir, 'icon.icns')}" "${iset}"`);
rmSync(iset, { recursive: true, force: true });

// 3) Mirabilis.ico - a 256x256 PNG wrapped in a minimal ICO container
const ico = await png(256);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);       // reserved
header.writeUInt16LE(1, 2);       // type: icon
header.writeUInt16LE(1, 4);       // image count
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);           // width  (0 = 256)
entry.writeUInt8(0, 1);           // height (0 = 256)
entry.writeUInt16LE(1, 4);        // color planes
entry.writeUInt16LE(32, 6);       // bits per pixel
entry.writeUInt32LE(ico.length, 8);
entry.writeUInt32LE(6 + 16, 12);  // offset to PNG data
writeFileSync(join(iconsDir, 'Mirabilis.ico'), Buffer.concat([header, entry, ico]));

console.log('Icons regenerated: icon.png, icon.icns, Mirabilis.ico');
