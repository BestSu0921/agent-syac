// agent-sync logo 纯 Node 光栅化：无任何外部依赖（内置 zlib 编码 PNG）
// 形状：碳黑底 → 琥珀辉光 → 源节点圆角方框描边 + 内核 → 三条贝塞尔辐射线 → 三色端点
import zlib from 'node:zlib';
import fs from 'node:fs/promises';

const S = 1024;            // 主图尺寸（512 设计稿 × 2）
const K = 2;               // 设计稿坐标 → 像素倍率
const buf = Buffer.alloc(S * S * 4);

const AMBER = [0xff, 0xb2, 0x24];
const GREEN = [0x3d, 0xdc, 0x97];
const CREAM = [0xe9, 0xe4, 0xd8];
const BG = [0x0b, 0x0c, 0x0e];

function blend(x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= S || y >= S || alpha <= 0) return;
  const i = (y * S + x) * 4;
  const a = Math.min(alpha, 1);
  buf[i] = Math.round(rgb[0] * a + buf[i] * (1 - a));
  buf[i + 1] = Math.round(rgb[1] * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(rgb[2] * a + buf[i + 2] * (1 - a));
  buf[i + 3] = 255;
}

// 背景
for (let i = 0; i < S * S; i++) {
  buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255;
}

// 辉光：以源节点为中心的径向衰减
const GCX = 152 * K, GCY = 256 * K, GMAX = 420 * K;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - GCX, y - GCY);
    if (d < GMAX) blend(x, y, AMBER, 0.16 * (1 - d / GMAX) ** 1.6);
  }
}

// 圆角矩形 SDF（cx,cy 中心 / hw,hh 半宽高 / r 圆角）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}

function strokeRoundRect(cx, cy, hw, hh, r, halfW, rgb) {
  for (let y = Math.floor((cy - hh - halfW) * K); y <= Math.ceil((cy + hh + halfW) * K); y++) {
    for (let x = Math.floor((cx - hw - halfW) * K); x <= Math.ceil((cx + hw + halfW) * K); x++) {
      const d = Math.abs(sdRoundRect(x / K, y / K, cx, cy, hw, hh, r));
      if (d <= halfW / K) blend(x, y, rgb, Math.min(1, (halfW / K - d) * K * 0.9 + 0.35));
    }
  }
}

function fillRoundRect(cx, cy, hw, hh, r, rgb) {
  for (let y = Math.floor((cy - hh) * K); y <= Math.ceil((cy + hh) * K); y++) {
    for (let x = Math.floor((cx - hw) * K); x <= Math.ceil((cx + hw) * K); x++) {
      if (sdRoundRect(x / K, y / K, cx, cy, hw, hh, r) <= 0) blend(x, y, rgb, 1);
    }
  }
}

function fillCircle(cx, cy, r, rgb) {
  for (let y = Math.floor((cy - r) * K); y <= Math.ceil((cy + r) * K); y++) {
    for (let x = Math.floor((cx - r) * K); x <= Math.ceil((cx + r) * K); x++) {
      const d = Math.hypot(x / K - cx, y / K - cy);
      if (d <= r) blend(x, y, rgb, Math.min(1, (r - d) * K * 0.9 + 0.35));
    }
  }
}

// 三次贝塞尔采样 + 圆头粗线（按行带扫描：只遍历包围盒附近的像素行）
function strokeBezier(p0, p1, p2, p3, halfW, rgb) {
  const pts = [];
  for (let i = 0; i <= 220; i++) {
    const t = i / 220, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  const minX = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0])) * K - halfW * K));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(...pts.map(p => p[0])) * K + halfW * K));
  const minY = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1])) * K - halfW * K));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(...pts.map(p => p[1])) * K + halfW * K));
  const seg = [];
  for (let i = 0; i < pts.length - 1; i++) seg.push([pts[i], pts[i + 1]]);
  for (let y = minY; y <= maxY; y++) {
    const py = y / K;
    for (let x = minX; x <= maxX; x++) {
      const px = x / K;
      let min = Infinity;
      for (const [[ax, ay], [bx, by]] of seg) {
        const vx = bx - ax, vy = by - ay;
        const len2 = vx * vx + vy * vy;
        let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
        if (d < min) min = d;
        if (min <= halfW) break;
      }
      if (min <= halfW) blend(x, y, rgb, Math.min(1, (halfW - min) * K * 0.9 + 0.35));
    }
  }
}

// ---- 绘制（512 设计稿坐标）----
strokeRoundRect(152, 256, 68, 68, 30, 14, AMBER);
fillRoundRect(152, 256, 24, 24, 12, AMBER);
strokeBezier([232, 256], [296, 256], [316, 128], [392, 128], 12, AMBER);
strokeBezier([232, 256], [296, 256], [316, 256], [392, 256], 12, AMBER);
strokeBezier([232, 256], [296, 256], [316, 384], [392, 384], 12, [255, 178, 36]);
fillCircle(416, 128, 26, AMBER);
fillCircle(416, 256, 26, GREEN);
fillCircle(416, 384, 26, CREAM);

// ---- PNG 编码 ----
function crc32(bufData) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of bufData) c = crc32.table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
  return out;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
await fs.writeFile('D:/ai-agent-backup/design/logo-1024.png', png);

// ---- 逐级降采样（2 的幂，2×2 均值），直接在内存 RGBA 上做 ----
function encodePNG(rgba, size) {
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 6;
  const rowF = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rowF, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(rowF, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let curBuf = buf, cur = S;
for (const to of [512, 256, 128, 64, 32, 16]) {
  // 先缩放到目标尺寸，再用目标尺寸编码（顺序反了会写成裁切图）
  const k = cur / to;
  const nb = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) for (let x = 0; x < to; x++) {
    let r = 0, g2 = 0, b = 0, n = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const i = ((y * k + dy) * cur + (x * k + dx)) * 4;
      r += curBuf[i]; g2 += curBuf[i + 1]; b += curBuf[i + 2]; n++;
    }
    const i = (y * to + x) * 4;
    nb[i] = Math.round(r / n); nb[i + 1] = Math.round(g2 / n); nb[i + 2] = Math.round(b / n); nb[i + 3] = 255;
  }
  await fs.writeFile(`D:/ai-agent-backup/design/logo-${to}.png`, encodePNG(nb, to));
  curBuf = nb; cur = to;
}
console.log('全部尺寸生成: 1024 → 512 → 256 → 128 → 64 → 32 → 16');
