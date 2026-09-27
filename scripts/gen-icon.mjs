// 生成应用图标（dsh HarmonyOS）—— 未来感系列：深空渐变圆角底 + 霓虹主体 + 外发光 + 内描边。
//
// 候选（--variant）：
//   ring  霓虹光环 / 传送门：发光圆环 + 轨道点，环心透出光晕
//   hex   六边形核心：发光六边形框 + 中心光核
//   wave  极光波：多条霓虹正弦波带横贯（青→紫→品红）
//   grid  合成波：地平线上的发光「太阳」+ 透视网格
//   emblem 参考「科技徽章」：四段蓝色金属环 + 品红/青霓虹光环 + 中心光核 + 十字光柱 + 电路纹理
//
// 渲染：先按 SIZE/2 分辨率求主体覆盖率掩膜（4x4 超采样），再做盒式模糊得到辉光掩膜，
// 最后双线性放大合成（默认 512）。
//
// 用法：
//   node scripts/gen-icon.mjs [--variant ring|hex|wave|grid] [--out 某个.png] [--size 512]
//
// 不给 --out 时写入仓库里的 6 个图标资源（AppScope / entry 各 media）——**注意会覆盖当前图标**。
// 当前采用的图标是仓库里原有的那张（不是本脚本生成的）；本脚本只是「试候选」的工具，
// 候选图建议先 `--out` 到临时目录看过再决定。末尾打印 ASCII 预览，便于无图形环境自检。
//
// 依赖精简后的 Jimp 子树（同 scripts/jimp-deps.json）；可用 JIMP_MODULES=<node_modules 路径> 覆盖。
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_PATHS = [
  "AppScope/resources/base/media/app_icon.png",
  "AppScope/resources/base/media/icon.png",
  "AppScope/resources/base/media/product_logo_32.png",
  "AppScope/resources/base/media/startIcon.png",
  "entry/src/main/resources/base/media/app_icon.png",
  "entry/src/main/resources/base/media/startIcon.png"
];

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SIZE = Number(argOf("--size", "512"));
const OUT = argOf("--out", "");
const VARIANT = argOf("--variant", "emblem");
const MODULES = process.env.JIMP_MODULES ?? join(ROOT, "node_modules/@deepseek-ai/dsh-attachment-local/node_modules");

if (!existsSync(join(MODULES, "@jimp/core"))) {
  console.error(`找不到精简后的 Jimp：${MODULES}
用 JIMP_MODULES=<node_modules 路径> 指定，例如 dsh 包内的
  <dsh-0.1.7-rc.2>/node_modules/@deepseek-ai/dsh-attachment-local/node_modules
或先 npm install @jimp/core @jimp/js-png @jimp/js-jpeg（见 scripts/jimp-deps.json）`);
  process.exit(1);
}
const req = createRequire(join(MODULES, "noop.js"));
const { createJimp } = req("@jimp/core");
const Jimp = createJimp({
  formats: [req("@jimp/js-png").default, req("@jimp/js-jpeg").default],
  plugins: [req("@jimp/plugin-resize").methods]
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 霓虹色带：青 → 紫 → 品红（t 0..1） */
function neonAt(t) {
  const u = clamp01(t);
  if (u < 0.5) {
    const k = u / 0.5;
    return [lerp(34, 139, k), lerp(211, 92, k), lerp(238, 246, k)];
  }
  const k = (u - 0.5) / 0.5;
  return [lerp(139, 232, k), lerp(92, 64, k), lerp(246, 200, k)];
}

/** 圆角矩形有符号距离（<0 在内部） */
function roundedRectSdf(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 四个候选
/** ring：光环 + 轨道点 */
const RING_R = 0.285, RING_W = 0.036;
function ringHit(px, py) {
  const dx = px - 0.5, dy = py - 0.5, d = Math.hypot(dx, dy);
  const ang = (Math.atan2(dy, dx) + TAU) % TAU;
  const width = RING_W * (0.75 + 0.35 * (0.5 + 0.5 * Math.sin(ang)));
  if (Math.abs(d - RING_R) <= width) return true;
  const ox = 0.5 + 0.415 * Math.cos(-0.9), oy = 0.5 + 0.415 * Math.sin(-0.9);
  return Math.hypot(px - ox, py - oy) <= 0.052;
}
function ringT(px, py) {
  return ((Math.atan2(py - 0.5, px - 0.5) + TAU) % TAU) / TAU;
}

/** hex：六边形框 + 中心光核 */
const HEX_R = 0.30, HEX_W = 0.030;
function hexHit(px, py) {
  const dx = px - 0.5, dy = py - 0.5;
  if (Math.hypot(dx, dy) <= 0.115) return true;
  const a = 0.5236;
  const d = Math.max(Math.abs(dx) * Math.cos(a) + Math.abs(dy) * Math.sin(a), Math.abs(dy)) - HEX_R * Math.cos(a);
  return Math.abs(d) <= HEX_W;
}
function hexT(px, py) {
  return (px + py) / 2;
}

/** wave：多条霓虹波带 */
function waveHit(px, py) {
  const bands = [
    { y: 0.34, amp: 0.075, k: 2.1, ph: 0.4, w: 0.030 },
    { y: 0.50, amp: 0.095, k: 1.7, ph: 2.2, w: 0.034 },
    { y: 0.66, amp: 0.070, k: 2.6, ph: 4.1, w: 0.026 }
  ];
  for (const b of bands) {
    const y = b.y + b.amp * Math.sin(b.k * TAU * px + b.ph);
    if (Math.abs(py - y) <= b.w) return true;
  }
  return false;
}
function waveT(px) {
  return px;
}

/** grid：地平线上的「太阳」+ 透视网格 */
const HORIZON = 0.615;
function gridHit(px, py) {
  const d = Math.hypot(px - 0.5, py - 0.40);
  if (d > 0.185) return false;
  for (let i = 0; i < 5; i++) {
    const y = 0.435 + i * 0.036;
    if (py > y && py < y + 0.014) return false;
  }
  return true;
}
function gridT(px, py) {
  return 0.35 + 0.65 * clamp01((py - 0.2) / 0.5);
}

const VARIANTS = {
  ring: { hit: ringHit, t: ringT, glow: 0.038, bg: "portal" },
  hex: { hit: hexHit, t: hexT, glow: 0.030, bg: "core" },
  wave: { hit: waveHit, t: waveT, glow: 0.032, bg: "aurora" },
  grid: { hit: gridHit, t: gridT, glow: 0.040, bg: "synth" }
};
const V = VARIANTS[VARIANT] ?? VARIANTS.ring;


// ---------------------------------------------------------------- emblem（参考图构图）
const EM = {
  bracketR: 0.360, bracketW: 0.088, bracketSpan: 0.86,   // 四段金属环（对角线方向）
  ring: 0.238, ringW: 0.017,                              // 外光环
  ring2: 0.150, ring2W: 0.008,                            // 内光环
  core: 0.050,                                            // 光核
  beamW: 0.016,                                           // 十字光柱半宽
  trace1: 0.300, trace2: 0.432                            // 电路环
};
/** 角度差（0..π） */
function angleDiff(a, b) {
  let d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return d > Math.PI ? TAU - d : d;
}
/** 四段金属环 */
function bracketHit(px, py) {
  const dx = px - 0.5, dy = py - 0.5, d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  if (Math.abs(d - EM.bracketR) > EM.bracketW / 2) return false;
  for (let q = 0; q < 4; q++) {
    if (angleDiff(ang, Math.PI / 4 + q * (Math.PI / 2)) <= EM.bracketSpan / 2) return true;
  }
  return false;
}
/** 霓虹光环 + 内环 + 光核 */
function neonHit(px, py) {
  const d = Math.hypot(px - 0.5, py - 0.5);
  if (d <= EM.core) return true;
  if (Math.abs(d - EM.ring) <= EM.ringW) return true;
  return Math.abs(d - EM.ring2) <= EM.ring2W;
}
function emblemBackground(px, py) {
  const d = Math.hypot(px - 0.5, py - 0.5);
  let r = 9, g = 13, b = 34;
  // 中心青紫辉光
  const halo = Math.exp(-(d * d) / 0.055);
  r += 34 * halo; g += 86 * halo; b += 132 * halo;
  // 暗角
  const vig = 1 - 0.35 * clamp01((d - 0.30) / 0.28);
  r *= vig; g *= vig; b *= vig;
  return [r, g, b];
}
/** 装饰：十字光柱 + 电路环/辐条/节点（都不发光，纯叠加） */
function emblemDecorate(px, py, color) {
  let [r, g, b] = color;
  const dx = Math.abs(px - 0.5), dy = Math.abs(py - 0.5);
  const d = Math.hypot(dx, dy);
  // 十字光柱（竖向偏青、横向偏品红）
  const vbeam = Math.exp(-((dx / EM.beamW) ** 2) * 1.6);
  const hbeam = Math.exp(-((dy / (EM.beamW * 1.15)) ** 2) * 1.6);
  if (vbeam > 0.01) { r += 90 * vbeam; g += 190 * vbeam; b += 240 * vbeam; }
  if (hbeam > 0.01) { r += 150 * hbeam; g += 60 * hbeam; b += 210 * hbeam; }
  // 电路环
  for (const tr of [EM.trace1, EM.trace2]) {
    if (Math.abs(d - tr) < 0.0035) { r += 26; g += 74; b += 96; }
  }
  // 辐条 + 节点
  const ang = Math.atan2(py - 0.5, px - 0.5);
  for (let i = 0; i < 12; i++) {
    const a = i * (TAU / 12) + 0.26;
    if (angleDiff(ang, a) < 0.006 && d > 0.34 && d < 0.46) { r += 22; g += 62; b += 84; }
    const nd = 0.40 + 0.028 * (i % 3);
    const nx = 0.5 + nd * Math.cos(a), ny = 0.5 + nd * Math.sin(a);
    if (Math.hypot(px - nx, py - ny) < 0.010) { r += 40; g += 120; b += 160; }
  }
  // 细噪点，避免大面积死平
  const n = Math.sin(px * 917.3 + py * 431.7) * Math.sin(px * 213.1 - py * 733.9);
  r += n * 3.5; g += n * 3.5; b += n * 3.5;
  return [r, g, b];
}
function emblemTint(px, py) {
  const d = Math.hypot(px - 0.5, py - 0.5);
  if (d <= EM.core * 1.5) return [255, 255, 255];
  const t = ((Math.atan2(py - 0.5, px - 0.5) + TAU) % TAU) / TAU;
  return [lerp(64, 236, t), lerp(196, 72, t), lerp(255, 255, t)];
}
function emblemMetal(px, py) {
  const t = clamp01((py - 0.15) / 0.7);
  const base = [lerp(206, 63, t), lerp(234, 132, t), lerp(255, 235, t)];
  // 金属感：沿半径做一条高光
  const d = Math.hypot(px - 0.5, py - 0.5);
  const hl = Math.exp(-(((d - (EM.bracketR - EM.bracketW * 0.22)) / (EM.bracketW * 0.16)) ** 2));
  return [lerp(base[0], 255, hl), lerp(base[1], 255, hl), lerp(base[2], 255, hl)];
}

// ---------------------------------------------------------------- 掩膜与辉光
function coverage(n, ss, test) {
  const mask = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (test((x + (sx + 0.5) / ss) / n, (y + (sy + 0.5) / ss) / n)) hit++;
        }
      }
      mask[y * n + x] = hit / (ss * ss);
    }
  }
  return mask;
}
function blurBox(mask, n, radius, passes = 2) {
  let src = mask;
  for (let pass = 0; pass < passes; pass++) {
    const tmp = new Float32Array(n * n);
    const win = radius * 2 + 1;
    for (let y = 0; y < n; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[y * n + Math.min(n - 1, Math.max(0, k))];
      for (let x = 0; x < n; x++) {
        tmp[y * n + x] = sum / win;
        const out = Math.min(n - 1, Math.max(0, x - radius));
        const into = Math.min(n - 1, Math.max(0, x + radius + 1));
        sum += src[y * n + into] - src[y * n + out];
      }
    }
    const out = new Float32Array(n * n);
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
      for (let y = 0; y < n; y++) {
        out[y * n + x] = sum / win;
        const up = Math.min(n - 1, Math.max(0, y - radius));
        const down = Math.min(n - 1, Math.max(0, y + radius + 1));
        sum += tmp[down * n + x] - tmp[up * n + x];
      }
    }
    src = out;
  }
  return src;
}
function sampleMask(mask, n, u, v) {
  const x = Math.min(n - 1, Math.max(0, u * n - 0.5));
  const y = Math.min(n - 1, Math.max(0, v * n - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = mask[y0 * n + x0] * (1 - fx) + mask[y0 * n + x1] * fx;
  const b = mask[y1 * n + x0] * (1 - fx) + mask[y1 * n + x1] * fx;
  return a * (1 - fy) + b * fy;
}

const MASK_N = Math.round(SIZE / 2);
const heroMask = coverage(MASK_N, 4, V.hit);
const heroGlow = blurBox(heroMask, MASK_N, Math.max(2, Math.round(MASK_N * V.glow)));

// ---------------------------------------------------------------- 背景 / 装饰
function background(px, py) {
  const t = clamp01(((px + py) / 2) * 1.15);
  let r = lerp(9, 30, t), g = lerp(13, 20, t), b = lerp(36, 74, t);
  if (V.bg === "portal") {
    const d = Math.hypot(px - 0.5, py - 0.5);
    const halo = Math.exp(-(d * d) / 0.055) * 0.95;
    r += 30 * halo; g += 96 * halo; b += 120 * halo;
  } else if (V.bg === "core") {
    const d = Math.hypot(px - 0.5, py - 0.5);
    const halo = Math.exp(-(d * d) / 0.10) * 0.9;
    r += 44 * halo; g += 26 * halo; b += 110 * halo;
  } else if (V.bg === "aurora") {
    const halo = Math.exp(-(((px - 0.5) ** 2) / 0.16 + ((py - 0.5) ** 2) / 0.22)) * 0.7;
    r += 22 * halo; g += 44 * halo; b += 92 * halo;
  } else {
    const halo = Math.exp(-(((px - 0.5) ** 2) / 0.10 + ((py - 0.40) ** 2) / 0.05));
    r += 96 * halo; g += 24 * halo; b += 88 * halo;
  }
  return [r, g, b];
}

/** 装饰层（不发光）：grid 的透视网格 + 地平线 */
function decorate(px, py, color) {
  if (V.bg !== "synth") return color;
  const [r, g, b] = color;
  const line = [lerp(r, 150, 0.55), lerp(g, 96, 0.55), lerp(b, 240, 0.55)];
  if (py > HORIZON && py < 0.94) {
    const t = (py - HORIZON) / (0.94 - HORIZON);
    const spread = 0.10 + 1.5 * t * t;
    const u = (px - 0.5) / (0.075 * spread);
    if (Math.abs(u - Math.round(u)) < 0.035) return line;
    for (let i = 1; i <= 5; i++) {
      const y = HORIZON + (0.94 - HORIZON) * (i / 5) ** 1.8;
      if (Math.abs(py - y) < 0.0055) return line;
    }
  }
  if (Math.abs(py - HORIZON) < 0.006) return [lerp(r, 255, 0.7), lerp(g, 120, 0.7), lerp(b, 200, 0.7)];
  return color;
}

// ---------------------------------------------------------------- 合成
const buf = Buffer.alloc(SIZE * SIZE * 4);

if (VARIANT === "emblem") {
  const bracketMask = coverage(MASK_N, 4, bracketHit);
  const neonMask = coverage(MASK_N, 4, neonHit);
  const bracketGlow = blurBox(bracketMask, MASK_N, Math.max(2, Math.round(MASK_N * 0.018)));
  const neonGlow = blurBox(neonMask, MASK_N, Math.max(2, Math.round(MASK_N * 0.052)));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = (x + 0.5) / SIZE, py = (y + 0.5) / SIZE;
      const i = (y * SIZE + x) * 4;
      const sdf = roundedRectSdf(px, py, 0.5, 0.5, 0.465, 0.465, 0.225);
      if (sdf > 0) continue;
      let [r, g, b] = emblemBackground(px, py);
      // 金属环 + 冷光
      const bg1 = sampleMask(bracketGlow, MASK_N, px, py);
      if (bg1 > 0.002) { const a = clamp01(bg1 * 1.6) * 0.45; r = lerp(r, 120, a); g = lerp(g, 190, a); b = lerp(b, 255, a); }
      const bc = sampleMask(bracketMask, MASK_N, px, py);
      if (bc > 0.001) {
        const [mr, mg, mb] = emblemMetal(px, py);
        const k = clamp01(bc * 1.2);
        r = lerp(r, mr, k); g = lerp(g, mg, k); b = lerp(b, mb, k);
        if (bc > 0.05 && bc < 0.95) { r = lerp(r, 255, 0.30); g = lerp(g, 255, 0.30); b = lerp(b, 255, 0.30); }
      }
      // 霓虹光环 + 光核 + 强辉光
      const ng = sampleMask(neonGlow, MASK_N, px, py);
      if (ng > 0.002) {
        const [nr, ngt, nb] = emblemTint(px, py);
        const a = clamp01(ng * 2.1) * 0.80;
        r = lerp(r, nr, a); g = lerp(g, ngt, a); b = lerp(b, nb, a);
      }
      const nc = sampleMask(neonMask, MASK_N, px, py);
      if (nc > 0.001) {
        const [nr, ngt, nb] = emblemTint(px, py);
        const k = clamp01(nc * 1.25);
        r = lerp(r, nr, k); g = lerp(g, ngt, k); b = lerp(b, nb, k);
        const dist = Math.hypot(px - 0.5, py - 0.5);
        if (dist < EM.core * 1.25) { r = lerp(r, 255, 0.85); g = lerp(g, 255, 0.9); b = lerp(b, 255, 0.95); }
      }
      const dec = emblemDecorate(px, py, [r, g, b]);
      r = dec[0]; g = dec[1]; b = dec[2];
      if (sdf > -0.012) {
        const k = clamp01(-sdf / 0.012);
        const a = (1 - k) * 0.5;
        r = lerp(r, 150, a); g = lerp(g, 205, a); b = lerp(b, 255, a);
      }
      buf[i] = Math.round(Math.min(255, r));
      buf[i + 1] = Math.round(Math.min(255, g));
      buf[i + 2] = Math.round(Math.min(255, b));
      buf[i + 3] = 255;
    }
  }
}

if (VARIANT !== "emblem") {
const _bufAlias = buf;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = (x + 0.5) / SIZE, py = (y + 0.5) / SIZE;
    const i = (y * SIZE + x) * 4;
    const sdf = roundedRectSdf(px, py, 0.5, 0.5, 0.465, 0.465, 0.225);
    if (sdf > 0) continue; // 圆角外透明

    let [r, g, b] = background(px, py);
    const tint = neonAt(V.t(px, py));

    const glow = sampleMask(heroGlow, MASK_N, px, py);
    if (glow > 0.002) {
      const a = clamp01(glow * 1.9) * 0.68;
      r = lerp(r, tint[0], a); g = lerp(g, tint[1], a); b = lerp(b, tint[2], a);
    }
    const cover = sampleMask(heroMask, MASK_N, px, py);
    if (cover > 0.001) {
      const core = clamp01(cover * 1.25);
      r = lerp(r, tint[0], core); g = lerp(g, tint[1], core); b = lerp(b, tint[2], core);
      if (cover > 0.06 && cover < 0.94) { r = lerp(r, 255, 0.35); g = lerp(g, 255, 0.35); b = lerp(b, 255, 0.35); }
    }
    const decorated = decorate(px, py, [r, g, b]);
    r = decorated[0]; g = decorated[1]; b = decorated[2];
    if (sdf > -0.014) {
      const k = clamp01(-sdf / 0.014);
      const a = (1 - k) * 0.5;
      r = lerp(r, 120, a); g = lerp(g, 190, a); b = lerp(b, 255, a);
    }

    buf[i] = Math.round(Math.min(255, r));
    buf[i + 1] = Math.round(Math.min(255, g));
    buf[i + 2] = Math.round(Math.min(255, b));
    buf[i + 3] = 255;
  }
}
}

let image;
try {
  image = Jimp.fromBitmap({ data: buf, width: SIZE, height: SIZE });
} catch {
  image = new Jimp({ width: SIZE, height: SIZE, color: 0x00000000 });
  image.bitmap.data = buf;
}
const png = await image.getBuffer("image/png");
const targets = OUT ? [OUT] : ICON_PATHS.map((p) => join(ROOT, p));
for (const p of targets) writeFileSync(p, png);
console.log(`[${VARIANT}] 写出 ${targets.length} 个图标，${SIZE}x${SIZE}，${png.length} bytes`);

const W = 56, H = 28;
const small = image.clone().resize({ w: W, h: H });
const chars = " .:-=+*#%@";
for (let y = 0; y < H; y++) {
  let line = "";
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, d = small.bitmap.data;
    const a = d[i + 3] / 255;
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    line += a < 0.15 ? " " : chars[Math.min(9, Math.max(1, Math.round(lum * 9)))];
  }
  console.log("  |" + line + "|");
}
