// Projector Demo, Draw mode: make a hand-drawn grid look like an SFCW C-scan of a wall.
//
// Pure (no React, no DOM). The drawing is two layers of strengths in [0, 1] per cell, PIPE and
// SEEPAGE, plus a noise seed and a set of look settings. renderRadarLook() turns that into one
// viridis colour per cell: dark for no detection, bright for detection.
//
//   background  seeded Perlin fBm ("rolling" level changes a wall-sized scale apart), a small
//               per-row offset (real rasters never match row to row) and per-cell speckle
//   pipe        a soft Gaussian cross-section of a real width in cm, drawn as the MAX over the
//               stroke, so a stroke keeps its peak brightness whatever the cell size; its
//               brightness wanders along the stroke (specular variation) and it carries a faint
//               wide halo, the way a real return has sidelobes
//   seepage     the painted region blurred wide and modulated by its own noise: a diffuse,
//               low-contrast cloud with no edge
//
// Features are added with a "screen" blend, v + (1 - v) * f, so they brighten toward 1 without
// clipping flat. Widths are in cm, not cells, so the same drawing looks the same at any step.
//
// Deterministic: the same document always renders the same colours, so an export and a re-render
// agree. Exports still store the rendered colours themselves, which is what Rover and Handheld
// show, so a later change to this renderer cannot alter a saved image.

import { viridis } from './imagingEffects';
import { brushCells } from './projectorDemo';

export const LOOK_CONTROLS = [
  { key: 'bgLevel', group: 'Background', label: 'Level', min: 0, max: 0.6, step: 0.01, digits: 2 },
  { key: 'bgRoll', group: 'Background', label: 'Rolling', min: 0, max: 0.4, step: 0.01, digits: 2 },
  { key: 'bgScaleCm', group: 'Background', label: 'Roll size', min: 5, max: 150, step: 1, digits: 0, unit: ' cm' },
  { key: 'speckle', group: 'Background', label: 'Speckle', min: 0, max: 0.2, step: 0.005, digits: 3 },
  { key: 'rowStripe', group: 'Background', label: 'Row mismatch', min: 0, max: 0.1, step: 0.005, digits: 3 },
  { key: 'pipeWidthCm', group: 'Pipes', label: 'Width', min: 0.5, max: 15, step: 0.5, digits: 1, unit: ' cm' },
  { key: 'pipeGain', group: 'Pipes', label: 'Brightness', min: 0.05, max: 1, step: 0.01, digits: 2 },
  { key: 'pipeGlow', group: 'Pipes', label: 'Halo', min: 0, max: 0.6, step: 0.01, digits: 2 },
  { key: 'pipeSparkle', group: 'Pipes', label: 'Specular variation', min: 0, max: 0.8, step: 0.01, digits: 2 },
  { key: 'seepSpreadCm', group: 'Seepage', label: 'Spread', min: 1, max: 30, step: 0.5, digits: 1, unit: ' cm' },
  { key: 'seepGain', group: 'Seepage', label: 'Brightness', min: 0.05, max: 1, step: 0.01, digits: 2 },
];

export const DEFAULT_LOOK = {
  bgLevel: 0.12, bgRoll: 0.12, bgScaleCm: 35, speckle: 0.04, rowStripe: 0.02,
  pipeWidthCm: 3, pipeGain: 0.75, pipeGlow: 0.2, pipeSparkle: 0.35,
  seepSpreadCm: 6, seepGain: 0.45,
};

export const newSeed = () => Math.floor(Math.random() * 2147483646) + 1;

// Every look setting present, finite and inside its control's range.
export function normalizeLook(look) {
  const out = { ...DEFAULT_LOOK };
  for (const c of LOOK_CONTROLS) {
    const v = look?.[c.key];
    if (Number.isFinite(v)) out[c.key] = Math.min(c.max, Math.max(c.min, v));
  }
  return out;
}

// ── documents ─────────────────────────────────────────────────────────────

export function emptyRadarDoc(params, seed = newSeed(), look = DEFAULT_LOOK) {
  const n = params.hCount * params.vCount;
  return {
    hCount: params.hCount, hStep: params.hStep, vCount: params.vCount, vStep: params.vStep,
    pipe: new Float32Array(n), seep: new Float32Array(n), seed, look: normalizeLook(look),
  };
}

// New geometry, keeping every painted strength whose (ix, iy) is still inside it.
export function resizeRadarDoc(doc, params) {
  const next = emptyRadarDoc({ ...doc, ...params }, doc.seed, doc.look);
  const w = Math.min(doc.hCount, next.hCount);
  const h = Math.min(doc.vCount, next.vCount);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      next.pipe[iy * next.hCount + ix] = doc.pipe[iy * doc.hCount + ix];
      next.seep[iy * next.hCount + ix] = doc.seep[iy * doc.hCount + ix];
    }
  }
  return next;
}

// Paint `cells` with `tool` ('pipe' | 'seepage' | 'erase'). A pipe stroke is one cell wide (its
// visible width is a look setting); seepage and the eraser stamp a disc of `radius` cells.
// Painting keeps the stronger value. Returns the same object when nothing changed.
export function paintRadarDoc(doc, cells, tool, strength, radius) {
  const W = doc.hCount;
  const s = Math.fround(Math.min(1, Math.max(0, strength)));
  let pipe = null;
  let seep = null;
  for (const c of cells) {
    const stamp = tool === 'pipe' ? [c] : brushCells(c, radius, doc);
    for (const b of stamp) {
      if (b.ix < 0 || b.ix >= doc.hCount || b.iy < 0 || b.iy >= doc.vCount) continue;
      const i = b.iy * W + b.ix;
      if (tool === 'erase') {
        if ((pipe || doc.pipe)[i] !== 0) { if (!pipe) pipe = doc.pipe.slice(); pipe[i] = 0; }
        if ((seep || doc.seep)[i] !== 0) { if (!seep) seep = doc.seep.slice(); seep[i] = 0; }
      } else if (tool === 'pipe') {
        if (s > (pipe || doc.pipe)[i]) { if (!pipe) pipe = doc.pipe.slice(); pipe[i] = s; }
      } else if (tool === 'seepage') {
        if (s > (seep || doc.seep)[i]) { if (!seep) seep = doc.seep.slice(); seep[i] = s; }
      }
    }
  }
  return pipe || seep ? { ...doc, pipe: pipe || doc.pipe, seep: seep || doc.seep } : doc;
}

export function featureCount(doc) {
  let n = 0;
  for (let i = 0; i < doc.pipe.length; i++) if (doc.pipe[i] > 0 || doc.seep[i] > 0) n++;
  return n;
}

// File form: the seed, the look, and each layer as a sparse [ix, iy, strength] list. Strengths
// are written to 3 decimals; the brush paints in 0.05 steps, so they come back bit-identical.
export function radarDocToFile(doc) {
  const layer = (arr) => {
    const out = [];
    for (let iy = 0; iy < doc.vCount; iy++) {
      for (let ix = 0; ix < doc.hCount; ix++) {
        const v = arr[iy * doc.hCount + ix];
        if (v > 0) out.push([ix, iy, Math.round(v * 1000) / 1000]);
      }
    }
    return out;
  };
  return { seed: doc.seed, look: { ...doc.look }, pipe: layer(doc.pipe), seepage: layer(doc.seep) };
}

// Returns { doc } or { error }. `grid` is the file's already-validated geometry.
export function radarDocFromFile(radar, grid) {
  if (!radar || typeof radar !== 'object') return { error: 'This file has no pipe or seepage layers.' };
  if (!Number.isInteger(radar.seed)) return { error: 'radar.seed must be a whole number.' };
  const doc = emptyRadarDoc(grid, radar.seed, radar.look);
  for (const [name, key] of [['pipe', 'pipe'], ['seepage', 'seep']]) {
    const arr = radar[name];
    if (!Array.isArray(arr)) return { error: `radar.${name} must be a list.` };
    for (let k = 0; k < arr.length; k++) {
      const e = arr[k];
      const ok = Array.isArray(e) && e.length === 3
        && Number.isInteger(e[0]) && Number.isInteger(e[1]) && Number.isFinite(e[2])
        && e[0] >= 0 && e[0] < grid.hCount && e[1] >= 0 && e[1] < grid.vCount && e[2] >= 0 && e[2] <= 1;
      if (!ok) return { error: `radar.${name}[${k}] must be [ix, iy, strength] inside the grid.` };
      doc[key][e[1] * grid.hCount + e[0]] = e[2];
    }
  }
  return { doc };
}

// ── rendering ─────────────────────────────────────────────────────────────

function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash to [0, 1): per-cell speckle and per-row offsets.
function hash01(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Classic 2D Perlin gradient noise from a seeded permutation, roughly in [-1, 1].
function makePerlin(seed) {
  const rnd = mulberry32(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const X = fx & 255;
    const Y = fy & 255;
    const xf = x - fx;
    const yf = y - fy;
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return x1 + v * (x2 - x1);
  };
}

function fbm(noise, x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq + o * 17.1, y * freq + o * 31.7);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const clampUnit = (x) => Math.max(-1, Math.min(1, x));

// For every cell, the strongest `mask * exp(-d^2 / 2 sigma^2)` over the painted cells, with the
// distance d measured in cm. A soft line whose peak stays at the painted strength.
function maxGaussField(mask, g, sigmaCm) {
  const { hCount: W, vCount: H, hStep, vStep } = g;
  const out = new Float32Array(W * H);
  const rx = Math.min(W, Math.ceil((3 * sigmaCm) / hStep));
  const ry = Math.min(H, Math.ceil((3 * sigmaCm) / vStep));
  const kw = 2 * rx + 1;
  const k = new Float32Array(kw * (2 * ry + 1));
  const inv = 1 / (2 * sigmaCm * sigmaCm);
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const ddx = dx * hStep;
      const ddy = dy * vStep;
      k[(dy + ry) * kw + dx + rx] = Math.exp(-(ddx * ddx + ddy * ddy) * inv);
    }
  }
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const m = mask[sy * W + sx];
      if (!(m > 0)) continue;
      const y0 = Math.max(0, sy - ry);
      const y1 = Math.min(H - 1, sy + ry);
      const x0 = Math.max(0, sx - rx);
      const x1 = Math.min(W - 1, sx + rx);
      for (let y = y0; y <= y1; y++) {
        const krow = (y - sy + ry) * kw;
        const orow = y * W;
        for (let x = x0; x <= x1; x++) {
          const v = m * k[krow + x - sx + rx];
          if (v > out[orow + x]) out[orow + x] = v;
        }
      }
    }
  }
  return out;
}

// Normalised 1D Gaussian blur along rows or columns; `sigma` in cells. Outside the grid is zero.
function blur1d(src, W, H, sigma, horizontal) {
  if (!(sigma >= 0.25)) return Float32Array.from(src);
  const r = Math.ceil(3 * sigma);
  const kern = new Float32Array(2 * r + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) { kern[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ksum += kern[i + r]; }
  for (let i = 0; i < kern.length; i++) kern[i] /= ksum;
  const out = new Float32Array(W * H);
  if (horizontal) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          if (xx >= 0 && xx < W) s += src[y * W + xx] * kern[i + r];
        }
        out[y * W + x] = s;
      }
    }
  } else {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i;
          if (yy >= 0 && yy < H) s += src[yy * W + x] * kern[i + r];
        }
        out[y * W + x] = s;
      }
    }
  }
  return out;
}

function anyPainted(arr) {
  for (let i = 0; i < arr.length; i++) if (arr[i] > 0) return true;
  return false;
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

// One viridis colour per cell. Returns a grid in the Projector Demo shape: { hCount, hStep,
// vCount, vStep, colors }, colour at iy * hCount + ix with iy = 0 the bottom row.
export function renderRadarLook(doc) {
  const look = normalizeLook(doc.look);
  const { hCount: W, vCount: H, hStep, vStep } = doc;
  const bgNoise = makePerlin(doc.seed);
  const featNoise = makePerlin((doc.seed ^ 0x9e3779b9) >>> 0);

  const pipeSigma = look.pipeWidthCm / 2.355;          // width is the full width at half maximum
  const hasPipe = anyPainted(doc.pipe);
  const core = hasPipe ? maxGaussField(doc.pipe, doc, pipeSigma) : null;
  const glow = hasPipe && look.pipeGlow > 0 ? maxGaussField(doc.pipe, doc, pipeSigma * 3) : null;
  const seep = anyPainted(doc.seep)
    ? blur1d(blur1d(doc.seep, W, H, look.seepSpreadCm / 2 / hStep, true), W, H, look.seepSpreadCm / 2 / vStep, false)
    : null;

  const rowOff = new Float32Array(H);
  for (let iy = 0; iy < H; iy++) rowOff[iy] = look.rowStripe * (hash01(iy, 7, doc.seed + 11) * 2 - 1);

  const colors = new Array(W * H);
  for (let iy = 0; iy < H; iy++) {
    const yc = iy * vStep;
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix;
      const xc = ix * hStep;
      let v = look.bgLevel
        + look.bgRoll * 1.5 * fbm(bgNoise, xc / look.bgScaleCm, yc / look.bgScaleCm)
        + rowOff[iy];
      if (glow && glow[i] > 0) v += (1 - v) * look.pipeGain * look.pipeGlow * glow[i];
      if (core && core[i] > 0) {
        const spec = 1 - look.pipeSparkle * (0.5 + 0.5 * clampUnit(featNoise(xc / 6, yc / 6) * 1.4));
        v += (1 - v) * look.pipeGain * core[i] * spec;
      }
      if (seep && seep[i] > 0) {
        const mod = 0.55 + 0.45 * (0.5 + 0.5 * clampUnit(featNoise(xc / 4 + 97.3, yc / 4 + 41.7) * 1.4));
        v += (1 - v) * look.seepGain * Math.min(1, seep[i]) * mod;
      }
      v += look.speckle * (hash01(ix, iy, doc.seed) * 2 - 1);
      v = Math.min(1, Math.max(0, v));
      const [r, g, b] = viridis(Math.round(v * 1023) / 1023);
      colors[i] = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    }
  }
  return { hCount: W, hStep, vCount: H, vStep, colors };
}
