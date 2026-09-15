// Seepage (in-wall moisture) detection, 2026-09-14. The SAR panel's Detection section runs
// this instead of lib/sarDetect.js when its mode is "Seepage". Pure: projected C-scan rows
// in, rated patches out. CLAUDE.md "Seepage test" has the measurements behind every choice.
//
// WHY A SEPARATE DETECTOR. Water in a brick joint is not a compact scatterer. On the
// seepage test it raised amplitude but its SAR coherence was 0.09 against ~0.35 for pipes,
// and it LOST contrast as the aperture widened (+10.4 dB over the empty wall at 4 cm of
// aperture, +4.9 dB over the full row) where a pipe gains (+0.2 -> +6.0 dB). So this does
// not focus and does not use coherence at all:
//
//   1. Per row, subtract the row's complex mean from h_cal: removes the wall face, the rig
//      echoes and anything else constant along the row.
//   2. Per cell, look STRAIGHT DOWN: Hanning matched filter at apparent range
//      standoff + sqrt(er) * z for depths inside the wall, the cell's own standoff.
//   3. Smooth the power over +-1 cm laterally and +-0.5 cm in depth.
//   4. Score = dB over the median of the same row at the same depth (lateral contrast
//      within the row, so no pass-to-pass calibration enters). Column score = the max over
//      the in-wall band, and the depth where it occurs.
//   5. Patch = 8-connected cells above threshold in (row, column), spanning >= 3 rows and
//      >= 2 cm, away from the scan's ends.
//   6. With an empty reference: the empty scan gets the same map ON ITS OWN, and a patch
//      whose cells are also bright there (>= threshold - 3 dB on >= half of them) is the
//      wall's own feature. Per-cell subtraction of the empty pass was tried first and does
//      NOT work -- pass-to-pass noise (standoff sd ~3 mm per cell) made swapped pairs
//      produce patches as strong as the seepage.
//   7. The back-face shadow (target / reference back-face echo behind the patch, relative
//      to the whole scan's median ratio) is REPORTED, not used as a gate: it separated the
//      seepage from the false alarms by as little as 0.2 dB.
//
// PROVISIONAL. Tuned on one real seepage scan plus the pipe/rod bench sets as negatives;
// the rod scans produced an unexplained patch at x ~27-28 cm that the empty check does not
// remove. The thresholds are a fit, not a validation.

const C = 299792458;

export const SEEPAGE_DEFAULTS = {
  bandFromCm: 3,            // in-wall band: this far below the wall face ...
  bandStopAboveBackCm: 3,   // ... down to this far above the back face (wall thickness - 3)
  depthStepCm: 0.5,
  smoothXcm: 1,             // power averaged over +-1 cm laterally ...
  smoothZbins: 1,           // ... and +-1 depth step
  thresholdDb: 6,           // a cell is part of a patch at this lateral contrast (held at +5/+6/+7 dB)
  minRows: 3,               // a patch spans at least this many rows (capped at the scan's row count)
  minWidthCm: 2,
  endExcludeCm: 8,          // columns this close to either end of the scan are not searched
  refVetoMarginDb: 3,       // an empty-scan cell counts as "also bright" at >= threshold - 3 dB ...
  refVetoFrac: 0.5,         // ... and a patch is the empty wall's own feature when that holds on >= half
                            // its cells (seepage 26-33%, the fixed wall features 72-100%)
  backFaceWindowCm: 4,      // back-face echo: max within +-4 cm of apparent range standoff + n * thickness
  shadowExtendCm: 4,        // shadow averaged over the patch's columns and this far past its far edge,
                            // as validated offline (the dimming sat just beyond the patch)
};

const key = (iy, ix) => iy * 100000 + ix;
const keyIy = (k) => Math.floor(k / 100000);
const keyIx = (k) => k % 100000;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const hann = (K) => Array.from({ length: K }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (K - 1)));
const usable = (rows) => (rows || []).filter((r) => r.cells && r.cells.length >= 2 && r.cells[0].h_cal_real);

function standoffFn(params, cells) {
  const manualM = Math.max(0, (params.manualStandoffMm || 0) / 1000);
  if (params.autoStandoff === false) return () => manualM;
  const so = cells.map((c) => c.lidar_standoff_mm).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const medM = so.length ? so[so.length >> 1] / 1000 : 0;
  return (c) => (c.lidar_standoff_mm != null && Number.isFinite(c.lidar_standoff_mm) ? c.lidar_standoff_mm / 1000 : medM);
}

// Steps 1-2: per-cell power at each depth of zGrid, straight down, row mean removed.
function cellPowers(rows, params, zGrid) {
  const n = Math.sqrt(params.epsilonR > 0 ? params.epsilonR : 1);
  const f0 = (params.startFreq || 2000) * 1e6;
  const map = new Map();
  for (const { iy, cells } of rows) {
    const K = cells[0].h_cal_real.length, W = hann(K);
    const mr = new Float64Array(K), mi = new Float64Array(K);
    for (const c of cells) for (let k = 0; k < K; k++) { mr[k] += c.h_cal_real[k] / cells.length; mi[k] += c.h_cal_imag[k] / cells.length; }
    const standoff = standoffFn(params, cells);
    for (const c of cells) {
      const s = standoff(c), df = c.step_size || 60e6, off = Number.isFinite(c.range_offset) ? c.range_offset : 0.378;
      const P = new Float64Array(zGrid.length);
      for (let zi = 0; zi < zGrid.length; zi++) {
        const R = s + (n * zGrid[zi]) / 100 + off;
        let a = 0, b = 0;
        for (let k = 0; k < K; k++) {
          const ph = (4 * Math.PI * (f0 + k * df) * R) / C, cr = Math.cos(ph), sr = Math.sin(ph);
          const x = W[k] * (c.h_cal_real[k] - mr[k]), y = W[k] * (c.h_cal_imag[k] - mi[k]);
          a += x * cr - y * sr; b += x * sr + y * cr;
        }
        P[zi] = a * a + b * b;
      }
      map.set(key(iy, c.grid_ix), P);
    }
  }
  return map;
}

// Step 3.
function smooth(map, hStep, o, nz) {
  const kx = Math.round(o.smoothXcm / hStep), kz = o.smoothZbins, out = new Map();
  for (const [k, P] of map) {
    const iy = keyIy(k), ix = keyIx(k), S = new Float64Array(nz);
    for (let zi = 0; zi < nz; zi++) {
      let s = 0, cnt = 0;
      for (let dx = -kx; dx <= kx; dx++) {
        const Q = map.get(key(iy, ix + dx));
        if (!Q) continue;
        for (let dz = -kz; dz <= kz; dz++) { if (zi + dz < 0 || zi + dz >= nz) continue; s += Q[zi + dz]; cnt++; }
      }
      S[zi] = s / cnt;
    }
    out.set(k, S);
  }
  return out;
}

// Step 4: { d: dB over the row's median at that depth, maxed over the band; z: where }.
function columnScores(sm, zGrid, b0, b1) {
  const byRow = new Map();
  for (const k of sm.keys()) { const iy = keyIy(k); if (!byRow.has(iy)) byRow.set(iy, []); byRow.get(iy).push(k); }
  const out = new Map();
  for (const keys of byRow.values()) {
    const meds = zGrid.map((_, zi) => { const a = keys.map((k) => sm.get(k)[zi]).sort((p, q) => p - q); return a[a.length >> 1]; });
    for (const k of keys) {
      const P = sm.get(k);
      let best = -Infinity, bz = 0;
      for (let zi = b0; zi <= b1; zi++) { const d = 10 * Math.log10(P[zi] / meds[zi]); if (d > best) { best = d; bz = zGrid[zi]; } }
      out.set(k, { d: best, z: bz });
    }
  }
  return out;
}

// Step 5.
function findPatches(scores, hStep, xLo, xHi, o, minRows) {
  const on = new Set();
  for (const [k, s] of scores) { const x = keyIx(k) * hStep; if (s.d >= o.thresholdDb && x >= xLo && x <= xHi) on.add(k); }
  const seen = new Set(), patches = [];
  for (const start of on) {
    if (seen.has(start)) continue;
    const queue = [start], px = [];
    seen.add(start);
    while (queue.length) {
      const j = queue.pop(); px.push(j);
      const iy = keyIy(j), ix = keyIx(j);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nb = key(iy + dy, ix + dx);
        if (on.has(nb) && !seen.has(nb)) { seen.add(nb); queue.push(nb); }
      }
    }
    const rows = [...new Set(px.map(keyIy))].sort((a, b) => a - b);
    const xs = px.map((j) => keyIx(j) * hStep);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (rows.length < minRows || x1 - x0 < o.minWidthCm) continue;
    const zs = px.map((j) => scores.get(j).z).sort((a, b) => a - b);
    const ds = px.map((j) => scores.get(j).d);
    const lin = ds.map((d) => Math.pow(10, d / 10));
    const wsum = lin.reduce((s, v) => s + v, 0);
    const xc = px.reduce((s, j, i) => s + keyIx(j) * hStep * lin[i], 0) / wsum;
    const perRow = rows.map((iy) => {
      const c = px.filter((j) => keyIy(j) === iy);
      const cx = c.map((j) => keyIx(j) * hStep), cz = c.map((j) => scores.get(j).z).sort((a, b) => a - b);
      return { iy, x0: Math.min(...cx), x1: Math.max(...cx), z0: cz[0], z1: cz[cz.length - 1], depth: cz[cz.length >> 1] };
    });
    patches.push({
      px, x0, x1, xc, rows, rowCount: rows.length,
      depth: zs[zs.length >> 1], zMin: zs[0], zMax: zs[zs.length - 1],
      peakDb: Math.max(...ds), meanDb: mean(ds), cells: px.length, perRow,
    });
  }
  return patches.sort((a, b) => b.peakDb * b.cells - a.peakDb * a.cells);
}

// Step 7: strongest raw echo within +-window of the back face's apparent range, per cell.
function backFacePowers(rows, params, wallT, o) {
  const n = Math.sqrt(params.epsilonR > 0 ? params.epsilonR : 1);
  const f0 = (params.startFreq || 2000) * 1e6;
  const map = new Map();
  for (const { iy, cells } of rows) {
    const K = cells[0].h_cal_real.length, W = hann(K), standoff = standoffFn(params, cells);
    for (const c of cells) {
      const df = c.step_size || 60e6, off = Number.isFinite(c.range_offset) ? c.range_offset : 0.378;
      const centre = standoff(c) + (n * wallT) / 100, win = o.backFaceWindowCm / 100;
      let best = 0;
      for (let R = centre - win; R <= centre + win + 1e-9; R += 0.005) {
        let a = 0, b = 0;
        for (let k = 0; k < K; k++) {
          const ph = (4 * Math.PI * (f0 + k * df) * (R + off)) / C, cr = Math.cos(ph), sr = Math.sin(ph);
          const x = W[k] * c.h_cal_real[k], y = W[k] * c.h_cal_imag[k];
          a += x * cr - y * sr; b += x * sr + y * cr;
        }
        best = Math.max(best, a * a + b * b);
      }
      map.set(key(iy, c.grid_ix), best);
    }
  }
  return map;
}

/**
 * @param rows      [{ iy, cells }] projected like useSarDetect does (h_cal, standoff, step, offset, grid_ix)
 * @param params    { stepSize cm, vStep cm, startFreq MHz, epsilonR, wallThickness cm, autoStandoff, manualStandoffMm }
 * @param options   SEEPAGE_DEFAULTS overrides
 * @param emptyRows same shape, a same-session empty-wall scan, or null
 * Patch ratings: 'moisture' (survived the empty check), 'reference' (the empty wall has it
 * too), 'unverified' (no empty reference to check against).
 */
export function runSeepageDetection(rows, params, options = {}, emptyRows = null) {
  const o = { ...SEEPAGE_DEFAULTS, ...options };
  rows = usable(rows);
  if (!rows.length) return null;
  const hStep = params.stepSize > 0 ? params.stepSize : 1;
  const vStep = params.vStep > 0 ? params.vStep : 1;
  const wallT = params.wallThickness > 0 ? params.wallThickness : 15;
  const z0 = o.bandFromCm, z1 = Math.max(z0 + 2, wallT - o.bandStopAboveBackCm);
  // one smoothing step either side of the band is all the grid needs
  const zGrid = [];
  for (let z = z0 - 2 * o.depthStepCm; z <= z1 + 2 * o.depthStepCm + 1e-9; z += o.depthStepCm) zGrid.push(+z.toFixed(3));
  const b0 = zGrid.findIndex((z) => z >= z0 - 1e-9);
  let b1 = b0; zGrid.forEach((z, i) => { if (z <= z1 + 1e-9) b1 = i; });

  const allIx = rows.flatMap((r) => r.cells.map((c) => c.grid_ix)).filter(Number.isFinite);
  const xMin = Math.min(...allIx) * hStep, xMax = Math.max(...allIx) * hStep;
  const rowIys = rows.map((r) => r.iy).sort((a, b) => a - b);
  const minRows = Math.min(o.minRows, rows.length);

  const scores = columnScores(smooth(cellPowers(rows, params, zGrid), hStep, o, zGrid.length), zGrid, b0, b1);
  const found = findPatches(scores, hStep, xMin + o.endExcludeCm, xMax - o.endExcludeCm, o, minRows);

  const empties = emptyRows ? usable(emptyRows) : [];
  let ref = null;
  if (empties.length) {
    const eScores = columnScores(smooth(cellPowers(empties, params, zGrid), hStep, o, zGrid.length), zGrid, b0, b1);
    const tBF = backFacePowers(rows, params, wallT, o), eBF = backFacePowers(empties, params, wallT, o);
    const ratios = [];
    for (const [k, v] of tBF) { const e = eBF.get(k); if (e > 0 && v > 0) ratios.push(10 * Math.log10(v / e)); }
    ratios.sort((a, b) => a - b);
    ref = { eScores, tBF, eBF, ratioMed: ratios.length ? ratios[ratios.length >> 1] : 0 };
  }

  const patches = found.map((p, id) => {
    let rating = 'unverified', reference = null, shadowDb = null;
    if (ref) {
      const vals = p.px.map((k) => ref.eScores.get(k)).filter(Boolean).map((s) => s.d);
      if (vals.length) {
        const frac = vals.filter((d) => d >= o.thresholdDb - o.refVetoMarginDb).length / vals.length;
        reference = { frac, meanDb: mean(vals), cells: vals.length };
        rating = frac >= o.refVetoFrac ? 'reference' : 'moisture';
      }
      const sh = [];
      for (const [k, v] of ref.tBF) {
        const x = keyIx(k) * hStep;
        if (!p.rows.includes(keyIy(k)) || x < p.x0 || x > p.x1 + o.shadowExtendCm) continue;
        const e = ref.eBF.get(k);
        if (e > 0 && v > 0) sh.push(10 * Math.log10(v / e));
      }
      if (sh.length) shadowDb = mean(sh) - ref.ratioMed;
    }
    const { px, ...rest } = p;
    return { id, ...rest, rating, reference, shadowDb };
  });

  const rowYs = rowIys.map((iy) => iy * vStep);
  return {
    mode: 'seepage',
    targets: [],          // pipe-mode consumers read this; seepage results carry patches instead
    patches,
    xMin, xMax, hStep, vStep,
    depthBand: [z0, zGrid[b1]],
    endExcludeCm: o.endExcludeCm,
    thresholdDb: o.thresholdDb,
    minRows,
    rowsTotal: rows.length, rowIys, rowYs,
    yMid: rowYs.length ? (Math.min(...rowYs) + Math.max(...rowYs)) / 2 : 0,
    spanCm: rowYs.length ? Math.max(...rowYs) - Math.min(...rowYs) : 0,
    usedReference: !!ref,
    wallThicknessCm: wallT,
  };
}
