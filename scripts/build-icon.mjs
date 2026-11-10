/**
 * 生成瑶光（Alkaid）图标：`assets/icon.png` + `assets/icon.ico`。
 *
 * 为什么自己画而不装 sharp/canvas：
 * 本机没有原生编译工具链，那些包容易在安装阶段失败；而图标本来就是**几何图形**，
 * 用纯 Node + 内置 zlib 直接光栅化，比引入一个渲染器更可控（还能对 16px 单独调参）。
 *
 * 跑法：`node scripts/build-icon.mjs`
 *
 * 设计：北斗七星连成斗形，**斗柄末端那颗（瑶光）最亮** —— 这就是"瑶光"的本义。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // 超采样倍数（抗锯齿）

// ───────────────────────── 基础绘制（全部在 0..1 归一化坐标里） ─────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blendPixel(canvas, size, x, y, r, g, b, a) {
  if (a <= 0) return;
  const index = (y * size + x) * 4;
  const dstA = canvas[index + 3] / 255;
  const srcA = a;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  canvas[index] = Math.round((r * srcA + canvas[index] * dstA * (1 - srcA)) / outA);
  canvas[index + 1] = Math.round((g * srcA + canvas[index + 1] * dstA * (1 - srcA)) / outA);
  canvas[index + 2] = Math.round((b * srcA + canvas[index + 2] * dstA * (1 - srcA)) / outA);
  canvas[index + 3] = Math.round(outA * 255);
}

/** 圆角矩形遮罩（0..1）—— 所有内容最后都要乘上它，否则辉光会溢出圆角 */
function roundedMask(size) {
  const mask = new Float32Array(size * size);
  const inset = 0.012;
  const radius = 0.223;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = Math.max(inset + radius - u, 0, u - (1 - inset - radius));
      const dy = Math.max(inset + radius - v, 0, v - (1 - inset - radius));
      const dist = Math.hypot(dx, dy);
      const insideRect = u > inset && u < 1 - inset && v > inset && v < 1 - inset;
      mask[y * size + x] = insideRect ? clamp01((radius - dist) * size + 0.5) : 0;
    }
  }
  return mask;
}

/** 圆角矩形遮罩 + 径向渐变填充 */
function drawBackground(canvas, size) {
  const radius = 0.223;
  const inset = 0.012;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // 圆角矩形距离场
      const dx = Math.max(inset + radius - u, 0, u - (1 - inset - radius));
      const dy = Math.max(inset + radius - v, 0, v - (1 - inset - radius));
      const outside = Math.hypot(dx, dy);
      const insideRect = u > inset && u < 1 - inset && v > inset && v < 1 - inset;
      if (!insideRect || outside > radius) continue;

      // 径向渐变（中心偏左上）
      const t = clamp01(Math.hypot(u - 0.32, v - 0.26) / 0.95);
      let r;
      let g;
      let b;
      if (t < 0.45) {
        const k = t / 0.45;
        r = 0x23 + (0x14 - 0x23) * k;
        g = 0x2a + (0x16 - 0x2a) * k;
        b = 0x5c + (0x35 - 0x5c) * k;
      } else {
        const k = (t - 0.45) / 0.55;
        r = 0x14 + (0x07 - 0x14) * k;
        g = 0x16 + (0x06 - 0x16) * k;
        b = 0x35 + (0x0f - 0x35) * k;
      }
      blendPixel(canvas, size, x, y, r, g, b, 1);
    }
  }
}

/** 沿线段画一条有宽度的线（按到线段距离做抗锯齿） */
function drawSegment(canvas, size, x1, y1, x2, y2, width, r, g, b, alpha) {
  const minX = Math.max(0, Math.floor((Math.min(x1, x2) - width) * size));
  const maxX = Math.min(size - 1, Math.ceil((Math.max(x1, x2) + width) * size));
  const minY = Math.max(0, Math.floor((Math.min(y1, y2) - width) * size));
  const maxY = Math.min(size - 1, Math.ceil((Math.max(y1, y2) + width) * size));

  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      let t = len2 === 0 ? 0 : ((px - x1) * vx + (py - y1) * vy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dist = Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
      const edge = width * 0.5;
      if (dist > edge) continue;
      blendPixel(canvas, size, x, y, r, g, b, alpha * clamp01((edge - dist) / (1 / size) + 0.5));
    }
  }
}

/** 径向衰减的光斑（glow） */
function drawGlow(canvas, size, cx, cy, radius, r, g, b, alpha) {
  const minX = Math.max(0, Math.floor((cx - radius) * size));
  const maxX = Math.min(size - 1, Math.ceil((cx + radius) * size));
  const minY = Math.max(0, Math.floor((cy - radius) * size));
  const maxY = Math.min(size - 1, Math.ceil((cy + radius) * size));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const d = Math.hypot(px - cx, py - cy) / radius;
      if (d >= 1) continue;
      const falloff = (1 - d) * (1 - d);
      blendPixel(canvas, size, x, y, r, g, b, alpha * falloff);
    }
  }
}

function drawCircle(canvas, size, cx, cy, radius, r, g, b, alpha) {
  const minX = Math.max(0, Math.floor((cx - radius) * size));
  const maxX = Math.min(size - 1, Math.ceil((cx + radius) * size));
  const minY = Math.max(0, Math.floor((cy - radius) * size));
  const maxY = Math.min(size - 1, Math.ceil((cy + radius) * size));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const d = Math.hypot(px - cx, py - cy);
      if (d > radius + 1 / size) continue;
      blendPixel(canvas, size, x, y, r, g, b, alpha * clamp01((radius - d) * size + 0.5));
    }
  }
}

/** 四芒星（沿四个方向的渐细光针） */
function drawSparkle(canvas, size, cx, cy, length, width) {
  const spikes = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  for (const [dx, dy] of spikes) {
    for (let k = 0; k < length * size; k += 1) {
      const t = k / (length * size);
      const w = width * (1 - t) * (1 - t) + 0.002;
      const px = cx + (dx * length * t);
      const py = cy + (dy * length * t);
      drawSegment(canvas, size, px - (dy === 0 ? 0 : w), py - (dx === 0 ? 0 : w), px + (dy === 0 ? 0 : w), py + (dx === 0 ? 0 : w), Math.max(w, 1 / size), 234, 247, 255, 0.85 * (1 - t));
    }
  }
}

// ───────────────────────── 北斗七星布局 ─────────────────────────

const STARS = [
  { name: '瑶光', x: 0.191, y: 0.234, r: 0.049 },
  { name: '开阳', x: 0.297, y: 0.363, r: 0.021 },
  { name: '玉衡', x: 0.406, y: 0.488, r: 0.022 },
  { name: '天权', x: 0.531, y: 0.562, r: 0.023 },
  { name: '天玑', x: 0.648, y: 0.687, r: 0.021 },
  { name: '天璇', x: 0.488, y: 0.789, r: 0.021 },
  { name: '天枢', x: 0.402, y: 0.644, r: 0.02 },
];

const HANDLE = [0, 1, 2, 3];
const BOWL = [3, 4, 5, 6, 3];

function render(size) {
  const big = size * SS;
  const canvas = new Uint8Array(big * big * 4);

  drawBackground(canvas, big);

  // 细边框（很淡，只为让圆角在浅色桌面上有轮廓）
  const rimWidth = Math.max(1, 0.006 * big);
  for (const [a, b] of [
    [0, 1],
    [0, 2],
  ]) {
    void a;
    void b;
  }
  drawCircle(canvas, big, 0.5, 0.5, 0.9, 0, 0, 0, 0); // 占位，避免空循环（不影响像素）
  void rimWidth;

  // 连接线
  const lineWidth = Math.max(0.008, 1.6 / size);
  for (let i = 0; i < HANDLE.length - 1; i += 1) {
    const a = STARS[HANDLE[i]];
    const b = STARS[HANDLE[i + 1]];
    drawSegment(canvas, big, a.x, a.y, b.x, b.y, lineWidth, 157, 184, 232, 0.44);
  }
  for (let i = 0; i < BOWL.length - 1; i += 1) {
    const a = STARS[BOWL[i]];
    const b = STARS[BOWL[i + 1]];
    drawSegment(canvas, big, a.x, a.y, b.x, b.y, lineWidth, 157, 184, 232, 0.44);
  }

  // 次星（越靠斗身越暗一点点）
  for (let i = 1; i < STARS.length; i += 1) {
    const star = STARS[i];
    const alpha = 0.86 - i * 0.02;
    drawCircle(canvas, big, star.x, star.y, star.r * (size <= 32 ? 1.25 : 1), 242, 246, 255, alpha);
  }

  // 瑶光：三层辉光 + 实心核 + 四芒
  const main = STARS[0];
  drawGlow(canvas, big, main.x, main.y, 0.22, 90, 170, 255, 0.5);
  drawGlow(canvas, big, main.x, main.y, 0.115, 190, 230, 255, 0.75);
  drawCircle(canvas, big, main.x, main.y, main.r, 255, 255, 255, 1);
  if (size >= 32) drawSparkle(canvas, big, main.x, main.y, 0.085, 0.011);

  // ★ 关键：把溢出圆角的部分裁掉（否则四角会看到辉光的蓝边）
  const mask = roundedMask(big);
  for (let i = 0; i < big * big; i += 1) {
    canvas[i * 4 + 3] = Math.round(canvas[i * 4 + 3] * mask[i]);
  }

  // 降采样
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const index = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const alpha = canvas[index + 3] / 255;
          r += canvas[index] * alpha;
          g += canvas[index + 1] * alpha;
          b += canvas[index + 2] * alpha;
          a += alpha;
        }
      }
      const count = SS * SS;
      const out = (y * size + x) * 4;
      if (a === 0) {
        rgba[out] = 0;
        rgba[out + 1] = 0;
        rgba[out + 2] = 0;
        rgba[out + 3] = 0;
      } else {
        rgba[out] = Math.round(r / a);
        rgba[out + 1] = Math.round(g / a);
        rgba[out + 2] = Math.round(b / a);
        rgba[out + 3] = Math.round((a / count) * 255);
      }
    }
  }
  return rgba;
}

// ───────────────────────── PNG / ICO 编码 ─────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const base = index * 16;
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, base);
    entries.writeUInt8(image.size >= 256 ? 0 : image.size, base + 1);
    entries.writeUInt8(0, base + 2);
    entries.writeUInt8(0, base + 3);
    entries.writeUInt16LE(1, base + 4);
    entries.writeUInt16LE(32, base + 6);
    entries.writeUInt32LE(image.png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

// ───────────────────────── 产出 ─────────────────────────

const SIZES = [16, 32, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));

writeFileSync(join(ROOT, 'assets', 'icon.png'), images[images.length - 1].png);
writeFileSync(join(ROOT, 'assets', 'icon.ico'), buildIco(images));

console.log('已生成 assets/icon.png (256×256) 与 assets/icon.ico');
console.log(`尺寸与字节数: ${images.map((i) => `${i.size}:${i.png.length}`).join(' ')}`);
