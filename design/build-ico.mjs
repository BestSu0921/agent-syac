// 多尺寸 PNG 打包成 icon.ico（PNG-in-ICO，Vista+ 全支持）
import fs from 'node:fs/promises';

const sizes = [256, 128, 64, 32, 16];
const pngs = [];
for (const s of sizes) {
  pngs.push({ s, data: await fs.readFile(`D:/ai-agent-backup/design/logo-${s}.png`) });
}
const count = pngs.length;
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(count, 4);
let offset = 6 + 16 * count;
const entries = [];
for (const { s, data } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e[2] = 0; e[3] = 0; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  entries.push(e); offset += data.length;
}
await fs.writeFile('D:/ai-agent-backup/tauri-app/src-tauri/icons/icon.ico',
  Buffer.concat([dir, ...entries, ...pngs.map(p => p.data)]));
console.log('icon.ico:', offset, '字节（', sizes.join('/'), '）');
