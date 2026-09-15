// Target detection on per-row SAR images -- the pipeline that found 11 of 11 labelled
// targets on the 2026-09-13/14 bench sets (+-1 cm) with the false positives that a
// same-session empty reference removes. Pure: `runDetection` takes projected C-scan
// cells and returns rated targets. `sarDetect.worker.js` is the only production caller;
// the Node harness described in CLAUDE.md drives this same function on saved scans.
//
// The chain is FIXED here rather than taken from the SAR panel's display toggles: it is
// the chain that was validated (rank-1 complex SVD, Hanning, coherent, layered ray,
// Auto standoff). The display image may be processed differently; markers are placed by
// physical (x, depth), which both share.
//
// LINES, NOT COLUMNS (2026-09-14). A pipe need not be vertical. Each row keeps its own
// peak profile (max of amplitude x coherence over the search depth band), and a Hough
// search scores every straight line through the rows -- a position at mid-height plus a
// slope dx/dy -- by the mean linear power along it. A vertical line (slope 0) scores
// exactly what the old fixed-column cross-row average did, so vertical pipes are found
// as before; a slanted pipe is no longer smeared across columns. Slopes are searched up
// to `maxLeanDeg` in steps that move the drift across the scan by half a pixel.
//
// Two lines are compared by their MEAN LATERAL DISTANCE over the scan's rows -- for
// merging (`nmsXCm`), the six tests (`lineMatchCm`), the empty reference (`refMatchCm`)
// and sidelobe removal (`sidelobeCm`). The first version compared mid-height position
// plus drift, and on the 5 cm-tall bench scans steep lines threading from a pipe to a
// feature 3-4 cm away escaped every one of those checks despite lying on top of the
// pipe at the rows: bench false positives went 2 -> 5. Searching many slopes also lets a
// line thread through clutter by chance, so a line whose drift exceeds the resolution
// needs `slantedExtraProminenceDb` more prominence to rate probable (such stray lines
// scored 4-5 dB; real slanted pipes 10-18).
//
// The SIX TESTS a candidate LINE is scored on:
//   1. rows      seen (>= +6 dB over that row's own median, within `rowSearchCm` of
//                where the line crosses that row) in >= 60% of the rows
//   2. gfit      the same line is found when the clutter is removed by the guarded
//                along-track fit instead of SVD -- two different clutter models agree
//   3. low       also found using only the lower half of the band (2-3.5 GHz)
//   4. high      also found using only the upper half (3.5-5 GHz) -- a sidelobe's
//                offset scales with wavelength, a scatterer's position does not
//   5. trimStart also found with the first 8 columns of every row dropped
//   6. trimEnd   also found with the last 8 columns dropped -- an artefact of the
//                aperture's end moves with the end; a target stays
// Three GATES decide what a passing score means:
//   prominence   dB of the rows lined up along the line, at its depth, over the median
//                of their lateral neighbours 4-12 cm either side. A compact scatterer
//                scores >= 8, a full-width band (rig echo, back-wall multiple) ~0-4.
//   edge         mid-height position inside `endExcludeCm` of either end of the scan,
//                where the aperture is truncated. The UI shows it as unresolved.
//   reference    an empty-wall scan of the same bench and session has a line at the same
//                place. Real fixed reflectors (a crevice, the rig) pass all six tests
//                because they ARE reflectors; only a control removes them. Matched
//                one-to-one: each empty-scan line explains at most one scan line.
// Rating: confirmed = 6/6 and prominence >= 8; probable = >= 4/6 INCLUDING the rows test
// and prominence >= 4. A probable within `sidelobeCm` of a stronger confirmed target is
// dropped as that target's sidelobe (Hanning puts them 4-5 cm out at this geometry).

import { reconstructMany } from './sarReconstruct';

const C = 299792458;

export const DETECT_DEFAULTS = {
  endExcludeCm: 6,          // truncated-aperture zone at each end of the scan
  trimCols: 8,              // columns dropped for the two trim tests
  lineMatchCm: 2.0,         // two variants' lines are the same pipe below this mean lateral distance
  rowSupportDb: 6,          // a row "sees" a target when its profile clears this
  rowSupportFrac: 0.6,      // fraction of rows that must see it
  peakThresholdDb: 4,       // minimum line score to be a candidate at all
  confirmedProminenceDb: 8,
  probableProminenceDb: 4,
  refMatchDepthCm: 3,       // reference line must be this close in depth (~ the depth resolution
                            // in the wall). 4 let a weak empty-scan line 4.0 cm shallower veto
                            // the real 33 cm pipe on a tall slanted scan.
  refMatchMarginDb: 5.5,    // ... and no more than this much weaker than the candidate. The gw2
                            // crevice reads 4.5-4.7 dB stronger in target scans than in its
                            // control (standoff change); a real pipe next to a weak empty-scan
                            // line read 6.3 dB stronger. 5.5 sits between them.
  sidelobeCm: 6,            // a probable this close to a stronger confirmed is its sidelobe
  searchMinDepthCm: 5,      // search band, true depth below the wall face (2026-09-14, operator's
  searchMaxDepthCm: 20,     // choice). Was wall thickness -3 .. +11 cm, i.e. 12.2-26.2 on gw2,
                            // which cannot see anything inside the wall (seepage at 5-12 cm).
  guardedWindowCols: 20,
  guardedGuardCols: 6,
  guardedAlpha: 0.9,
  // line search
  maxLeanDeg: 45,           // steepest lean searched, degrees from vertical
  lineMinCoverage: 0.6,     // a line must lie inside the scan for this fraction of rows
  driftMatchCm: 3.2,        // drift across the scan below this is indistinguishable from vertical
  nmsXCm: 3.2,              // lines closer than this (mean lateral distance) are one pipe
  refMatchCm: 2.5,          // a reference line this close (mean lateral distance) may veto a candidate.
                            // Safe at 2.5 only because matching is ONE-TO-ONE (see runDetection): the
                            // empty scan images the gw2 crevice at 35.0 cm, between the scan's crevice
                            // line (36.5) and the real 32 cm pipe (33.0); the crevice line takes it.
  slantedExtraProminenceDb: 2, // extra prominence a slanted line needs to rate probable
  rowSearchCm: 1.5,         // per-row peak search around where the line crosses the row
};

// ---- clutter removal: guarded along-track fit (the alternative to SVD) ---------------
// Per frequency, fits h(q) = coupling + wall * exp(-j 4 pi f alpha d_q / c) over the
// columns within `windowCols` of each cell but outside `guardCols`, and subtracts the
// fit evaluated at the cell. The guard is what keeps a target from fitting itself away.
export function guardedFit(cells, { windowCols, guardCols, f0Hz, stepHz, alpha }) {
  const K = cells[0].h_cal_real.length;
  const known = cells.map((c) => c.lidar_standoff_mm).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const med = known.length ? known[known.length >> 1] : 0;
  const sd = cells.map((c) => (c.lidar_standoff_mm == null || !Number.isFinite(c.lidar_standoff_mm) ? med : c.lidar_standoff_mm));
  return cells.map((c, p) => {
    const S = [];
    for (let q = 0; q < cells.length; q++) {
      const g = Math.abs(cells[q].grid_ix - c.grid_ix);
      if (g > guardCols && g <= windowCols) S.push(q);
    }
    const re = new Array(K), im = new Array(K);
    for (let k = 0; k < K; k++) {
      const f = f0Hz + k * stepHz;
      let N = 0, Br = 0, Bi = 0, Yr = 0, Yi = 0, Zr = 0, Zi = 0;
      for (const q of S) {
        const ph = -4 * Math.PI * f * alpha * (sd[q] / 1000) / C;
        const br = Math.cos(ph), bi = Math.sin(ph);
        const yr = cells[q].h_cal_real[k], yi = cells[q].h_cal_imag[k];
        N++; Br += br; Bi += bi; Yr += yr; Yi += yi;
        Zr += br * yr + bi * yi; Zi += br * yi - bi * yr;
      }
      let bgr = 0, bgi = 0;
      if (N > 0) {
        const det = N * N - (Br * Br + Bi * Bi);
        if (det < 1e-3 * N * N) { bgr = Yr / N; bgi = Yi / N; }
        else {
          const cr = (N * Yr - (Br * Zr - Bi * Zi)) / det, ci = (N * Yi - (Br * Zi + Bi * Zr)) / det;
          const wr = (N * Zr - (Br * Yr + Bi * Yi)) / det, wi = (N * Zi - (Br * Yi - Bi * Yr)) / det;
          const ph = -4 * Math.PI * f * alpha * (sd[p] / 1000) / C;
          const pr = Math.cos(ph), pi = Math.sin(ph);
          bgr = cr + wr * pr - wi * pi; bgi = ci + wr * pi + wi * pr;
        }
      }
      re[k] = c.h_cal_real[k] - bgr; im[k] = c.h_cal_imag[k] - bgi;
    }
    return { ...c, h_cal_real: re, h_cal_imag: im };
  });
}

// ---- helpers --------------------------------------------------------------------------
function sliceBand(cells, k0, k1) {
  return cells.map((c) => ({ ...c, h_cal_real: c.h_cal_real.slice(k0, k1), h_cal_imag: c.h_cal_imag.slice(k0, k1) }));
}

function interp1(xs, ys, x) {
  if (x < xs[0] || x > xs[xs.length - 1]) return NaN;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = xs[hi] > xs[lo] ? (x - xs[lo]) / (xs[hi] - xs[lo]) : 0;
  return ys[lo] * (1 - t) + ys[hi] * t;
}

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((p, q) => p - q);
  return a.length ? a[a.length >> 1] : NaN;
}

// Reconstruction -> normalised amplitude x coherence on the common (xAxis, zAxis) grid,
// NaN outside this row's aperture. Normalised by the median over depths at or below
// the search band's top, so rows and scans are comparable in dB.
function gridWeight(res, xAxisCm, zAxisCm, zNormCm) {
  const { pixelsX: X, pixelsZ: Z, image, coherence, apertureStart, apertureLength, depthMax } = res;
  const xs = Array.from({ length: X }, (_, i) => ((apertureStart || 0) + (i / (X - 1)) * apertureLength) * 100);
  const zs = Array.from({ length: Z }, (_, i) => Math.max(0.005, (i / (Z - 1)) * depthMax) * 100);
  const W = new Float64Array(Z * X);
  for (let i = 0; i < W.length; i++) W[i] = Math.pow(10, image[i] / 20) * (coherence ? coherence[i] : 1);
  // resample: depth first (per column), then lateral
  const cols = new Array(X);
  for (let xi = 0; xi < X; xi++) {
    const col = new Float64Array(Z);
    for (let zi = 0; zi < Z; zi++) col[zi] = W[zi * X + xi];
    cols[xi] = zAxisCm.map((z) => (z <= zs[Z - 1] ? interp1(zs, col, Math.max(z, zs[0])) : NaN));
  }
  const out = zAxisCm.map((_, zi) => {
    const rowVals = cols.map((c) => c[zi]);
    return xAxisCm.map((x) => interp1(xs, rowVals, x));
  });
  const norm = [];
  for (let zi = 0; zi < zAxisCm.length; zi++) {
    if (zAxisCm[zi] < zNormCm) continue;
    // Non-zero pixels only (2026-09-14). Debiased coherence is exactly 0 wherever the
    // aperture's contributions did not agree -- 15-70% of pixels depending on depth -- so an
    // all-pixel median moved with HOW MANY pixels failed, not with signal level, and shifted a
    // target scan and its reference by different amounts. See CLAUDE.md "Seepage test".
    for (const v of out[zi]) if (Number.isFinite(v) && v > 0) norm.push(v);
  }
  norm.sort((a, b) => a - b);
  const med = norm.length ? norm[norm.length >> 1] : 1;
  return out.map((row) => row.map((v) => v / (med || 1)));
}

// Per row: max over the search depth band, in dB, plus the depth of that max.
function bandProfile(G, zAxisCm, zlo, zhi) {
  const nx = G[0].length;
  const db = new Array(nx).fill(NaN), depth = new Array(nx).fill(NaN);
  for (let xi = 0; xi < nx; xi++) {
    let best = -Infinity, bz = NaN;
    for (let zi = 0; zi < zAxisCm.length; zi++) {
      if (zAxisCm[zi] < zlo || zAxisCm[zi] > zhi) continue;
      const v = G[zi][xi];
      if (Number.isFinite(v) && v > best) { best = v; bz = zAxisCm[zi]; }
    }
    if (best > 0) { db[xi] = 10 * Math.log10(best); depth[xi] = bz; }
  }
  return { db, depth };
}

// ---- the line search ------------------------------------------------------------------
// Mean lateral distance between two lines over the given row heights.
function meanLineDistance(a, ycA, b, ycB, ys) {
  if (!ys.length) return Math.abs(a.x - b.x);
  let sum = 0;
  for (const y of ys) sum += Math.abs((a.x + a.s * (y - ycA)) - (b.x + b.s * (y - ycB)));
  return sum / ys.length;
}

// profiles[r] = { db[], depth[] } on xAxis, rowYs[r] = that row's height (cm).
// Returns candidate lines { x (at mid-height yc), s (dx/dy), db (mean power along it) }.
function houghLines(profiles, rowYs, xAxis, hStep, o) {
  const nr = profiles.length, nx = xAxis.length;
  const yMin = Math.min(...rowYs), yMax = Math.max(...rowYs);
  const yc = (yMin + yMax) / 2, span = yMax - yMin;
  const slopes = [0];
  if (nr >= 3 && span > 0) {
    const ds = (hStep / 2) / span;                       // half a pixel of drift per step
    const sMax = Math.tan((o.maxLeanDeg * Math.PI) / 180);
    const n = Math.floor(sMax / ds);
    for (let k = 1; k <= n; k++) { slopes.push(k * ds, -k * ds); }
    slopes.sort((a, b) => a - b);
  }
  const ns = slopes.length;
  const pw = profiles.map((p) => p.db.map((v) => (Number.isFinite(v) ? Math.pow(10, v / 10) : NaN)));
  const minRows = Math.max(1, Math.ceil(o.lineMinCoverage * nr));
  const x0 = xAxis[0];
  const score = new Float64Array(ns * nx).fill(NaN);
  for (let si = 0; si < ns; si++) {
    const s = slopes[si];
    for (let i = 0; i < nx; i++) {
      let sum = 0, n = 0;
      for (let r = 0; r < nr; r++) {
        const f = (xAxis[i] + s * (rowYs[r] - yc) - x0) / hStep;
        let j = Math.floor(f), t = f - j;
        if (j === nx - 1 && t < 1e-9) { j = nx - 2; t = 1; }
        if (j < 0 || j >= nx - 1) continue;
        const a = pw[r][j], b = pw[r][j + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        sum += a * (1 - t) + b * t; n++;
      }
      if (n >= minRows && sum > 0) score[si * nx + i] = 10 * Math.log10(sum / n);
    }
  }
  // local maxima in (slope, position): +-1 cm of drift, +-1 cm of position
  const kS = ns > 1 ? Math.max(1, Math.round(1.0 / (hStep / 2))) : 0;
  const kX = Math.max(1, Math.round(1.0 / hStep));
  const cands = [];
  for (let si = 0; si < ns; si++) {
    for (let i = 0; i < nx; i++) {
      const v = score[si * nx + i];
      if (!Number.isFinite(v) || v <= o.peakThresholdDb) continue;
      let isMax = true;
      for (let a = -kS; a <= kS && isMax; a++) {
        const sj = si + a; if (sj < 0 || sj >= ns) continue;
        for (let b = -kX; b <= kX; b++) {
          if (a === 0 && b === 0) continue;
          const ij = i + b; if (ij < 0 || ij >= nx) continue;
          const w = score[sj * nx + ij];
          // strict on one side of the tie so a plateau yields exactly one maximum
          if (Number.isFinite(w) && (w > v || (w === v && (a < 0 || (a === 0 && b < 0))))) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ x: xAxis[i], s: slopes[si], db: v });
    }
  }
  cands.sort((p, q) => q.db - p.db);
  const lines = [];
  for (const c of cands) {
    if (lines.some((l) => meanLineDistance(l, yc, c, yc, rowYs) <= o.nmsXCm)) continue;
    lines.push(c);
  }
  return { lines, yc, span };
}

// Where a line crosses each row, and that row's own peak near there.
function lineRows(line, profiles, rowYs, rowIys, xAxis, hStep, yc, o) {
  const kR = Math.max(1, Math.round(o.rowSearchCm / hStep));
  return profiles.map((p, r) => {
    const xPred = line.x + line.s * (rowYs[r] - yc);
    const jp = Math.round((xPred - xAxis[0]) / hStep);
    let best = -Infinity, bj = -1;
    for (let j = jp - kR; j <= jp + kR; j++) {
      if (j < 0 || j >= xAxis.length) continue;
      const v = p.db[j];
      if (Number.isFinite(v) && v > best) { best = v; bj = j; }
    }
    return { iy: rowIys[r], y: rowYs[r], xPred, x: bj >= 0 ? xAxis[bj] : NaN, depth: bj >= 0 ? p.depth[bj] : NaN, db: best, seen: best >= o.rowSupportDb };
  });
}

// Depth along the line: least-squares line over the rows that saw it, so a pipe that
// also changes depth is followed, falling back to the median, then to the band peak.
function fitDepth(perRow) {
  const pts = perRow.filter((r) => r.seen && Number.isFinite(r.depth));
  if (pts.length >= 3) {
    const ym = pts.reduce((s, p) => s + p.y, 0) / pts.length, dm = pts.reduce((s, p) => s + p.depth, 0) / pts.length;
    let sxy = 0, sxx = 0;
    for (const p of pts) { sxy += (p.y - ym) * (p.depth - dm); sxx += (p.y - ym) ** 2; }
    const b = sxx > 0 ? sxy / sxx : 0;
    return (y) => dm + b * (y - ym);
  }
  const m = median(pts.map((p) => p.depth));
  const fallback = Number.isFinite(m) ? m : median(perRow.map((r) => r.depth));
  return () => fallback;
}

// Rows lined up along the line: mean weight at offsets -halfCm..+halfCm from where the
// line crosses each row, at the line's depth in that row. Prominence and width come from
// this, so a slanted pipe is measured along itself rather than smeared across columns.
function alignedProfile(grids, perRow, depthAt, xAxis, zAxis, hStep, halfCm) {
  const K = Math.round(halfCm / hStep);
  const acc = new Float64Array(2 * K + 1), cnt = new Uint16Array(2 * K + 1);
  perRow.forEach((pr, r) => {
    const G = grids[r]; if (!G) return;
    const xr = pr.seen && Number.isFinite(pr.x) ? pr.x : pr.xPred;
    const dz = depthAt(pr.y);
    if (!Number.isFinite(xr) || !Number.isFinite(dz)) return;
    let zi = 0, bestDz = Infinity;
    for (let k = 0; k < zAxis.length; k++) { const d = Math.abs(zAxis[k] - dz); if (d < bestDz) { bestDz = d; zi = k; } }
    const j0 = Math.round((xr - xAxis[0]) / hStep);
    for (let k = -K; k <= K; k++) {
      const j = j0 + k; if (j < 0 || j >= xAxis.length) continue;
      const v = G[zi][j]; if (!Number.isFinite(v)) continue;
      acc[k + K] += v; cnt[k + K]++;
    }
  });
  return { K, vals: Array.from(acc, (v, i) => (cnt[i] ? v / cnt[i] : NaN)) };
}

function prominenceOf(aligned, hStep) {
  const { K, vals } = aligned; const c = vals[K];
  if (!(c > 0)) return NaN;
  const inner = Math.round(4 / hStep), outer = Math.round(12 / hStep);
  const nb = [];
  for (let d = inner; d <= Math.min(outer, K); d++) { for (const j of [K - d, K + d]) if (Number.isFinite(vals[j])) nb.push(vals[j]); }
  const m = median(nb);
  return Number.isFinite(m) ? 10 * Math.log10(c / (m || 1e-12)) : NaN;
}

// Apparent lateral size. `widthCm` is the -6 dB width of the aligned profile -- what the
// image shows and what the marker is drawn to. `sizeEstCm` removes the imaging
// resolution in quadrature: ~ c/(4 f_centre) (refraction-limited aperture, so
// independent of er) times 1.5 for Hanning, ~3.2 cm here; anything thinner reads as the
// floor. Approximate.
function sizeOf(aligned, hStep, fCentreHz) {
  const { K, vals } = aligned; const peak = vals[K];
  if (!(peak > 0)) return {};
  let l = K, r = K;
  while (l > 0 && Number.isFinite(vals[l - 1]) && vals[l - 1] >= 0.5 * peak) l--;
  while (r < vals.length - 1 && Number.isFinite(vals[r + 1]) && vals[r + 1] >= 0.5 * peak) r++;
  const width = (r - l + 1) * hStep;
  const res = 1.5 * (C / (4 * fCentreHz)) * 100;
  return { widthCm: width, sizeEstCm: Math.max(1, Math.min(25, Math.sqrt(Math.max(0, width * width - res * res)))) };
}

// ---- the detector ---------------------------------------------------------------------
// Split into stages (2026-09-14) so the reconstructions -- 97% of detection time -- can run
// in parallel: sarDetect.worker.js plans, farms rows out to a pool of
// sarDetectRow.worker.js, and finishes. runDetection composes the same stages in one
// thread for the Node harness.
//   planDetection           geometry shared by every row (small, structured-cloneable)
//   reconstructRowVariants  one row's variants -> resampled grids (the expensive part)
//   emptyReferenceLines     the empty scan's lines, from its base-variant grids
//   finishDetection         line search, six tests, reference, ratings

export const VARIANTS = [
  { key: 'base', pre: 'svd', band: 'full', trim: null },
  { key: 'gfit', pre: 'gfit', band: 'full', trim: null },
  { key: 'low', pre: 'svd', band: 'low', trim: null },
  { key: 'high', pre: 'svd', band: 'high', trim: null },
  { key: 'trimStart', pre: 'svd', band: 'full', trim: 'start' },
  { key: 'trimEnd', pre: 'svd', band: 'full', trim: 'end' },
];
export const VARIANT_KEYS = VARIANTS.map((v) => v.key);

export function usableRows(rows) {
  return (rows || []).filter((r) => r.cells && r.cells.length >= 2 && r.cells[0].h_cal_real);
}

/**
 * @param rows       [{ iy, cells }] -- cells projected like useSarWorker does, PLUS grid_ix
 * @param params     SAR panel params (stepSize cm, vStep cm between rows, startFreq MHz,
 *                   epsilonR, wallThickness cm, refraction, autoStandoff, manualStandoffMm)
 * @param options    DETECT_DEFAULTS overrides
 */
export function planDetection(rows, params, options = {}) {
  const o = { ...DETECT_DEFAULTS, ...options };
  rows = usableRows(rows);
  if (!rows.length) return null;
  const hStep = params.stepSize > 0 ? params.stepSize : 1;
  const vStep = params.vStep > 0 ? params.vStep : 1;
  const K = rows[0].cells[0].h_cal_real.length;
  const stepHz = rows[0].cells[0].step_size || 60e6;
  const f0Hz = (params.startFreq || 2000) * 1e6;
  const fHiHz = f0Hz + (K - 1) * stepHz;
  const wallT = params.wallThickness > 0 ? params.wallThickness : 15;
  const zlo = Math.max(1, o.searchMinDepthCm), zhi = Math.max(zlo + 1, o.searchMaxDepthCm);
  const allIx = rows.flatMap((r) => r.cells.map((c) => c.grid_ix)).filter(Number.isFinite);
  const ixMin = allIx.length ? Math.min(...allIx) : 0;
  const ixMax = allIx.length ? Math.max(...allIx) : rows[0].cells.length - 1;
  const xAxis = [];
  for (let i = ixMin; i <= ixMax; i++) xAxis.push(i * hStep);
  const zAxis = [];
  for (let z = 0.5; z <= zhi + 6; z += 0.5) zAxis.push(z);
  const kMid = Math.floor(K / 2);
  const bands = { full: [0, K, f0Hz], low: [0, Math.ceil(K / 2), f0Hz], high: [kMid, K, f0Hz + kMid * stepHz] };
  const baseParams = {
    stepSize: hStep, maxDepth: zhi + 6, aperture: 1, coherent: true, svdEnabled: true, svdK: 1, svdStrength: 1,
    epsilonR: params.epsilonR, windowType: 'hanning', kaiserBeta: 3, wallThickness: params.wallThickness,
    refraction: params.refraction !== false, autoStandoff: params.autoStandoff !== false,
    manualStandoffMm: params.manualStandoffMm || 0,
  };
  return { o, params, hStep, vStep, K, stepHz, f0Hz, fHiHz, wallT, zlo, zhi, xAxis, zAxis, bands, baseParams };
}

function variantJob(plan, cells, v) {
  const { o, bands, stepHz, baseParams } = plan;
  let c = cells;
  if (v.trim === 'start') c = c.slice(o.trimCols);
  else if (v.trim === 'end') c = c.slice(0, Math.max(2, c.length - o.trimCols));
  const [k0, k1, fb] = bands[v.band];
  c = sliceBand(c, k0, k1);
  if (v.pre === 'gfit') c = guardedFit(c, { windowCols: o.guardedWindowCols, guardCols: o.guardedGuardCols, f0Hz: fb, stepHz, alpha: o.guardedAlpha });
  return [c, { ...baseParams, startFreq: fb / 1e6, svdEnabled: v.pre === 'svd' }];
}

// One row's variants, reconstructed together so they share ray tables, then resampled
// onto the common grid. { [variantKey]: grid | null }.
export function reconstructRowVariants(plan, cells, keys = VARIANT_KEYS) {
  const vs = VARIANTS.filter((v) => keys.includes(v.key));
  const results = reconstructMany(vs.map((v) => variantJob(plan, cells, v)));
  const out = {};
  vs.forEach((v, i) => { out[v.key] = results[i] ? gridWeight(results[i], plan.xAxis, plan.zAxis, plan.zlo) : null; });
  return out;
}

// Everything the empty reference's lines depend on apart from the empty scan itself: the
// panel params, the detector options, and the target scan's lateral grid and sweep plan
// (the reference is reconstructed onto the TARGET's grid). Callers key a cache on this
// plus the identity of the empty scan.
export function emptyReferenceKey(plan) {
  return JSON.stringify([plan.params, plan.o, plan.hStep, plan.vStep, plan.K, plan.stepHz, plan.f0Hz, plan.xAxis[0], plan.xAxis.length]);
}

// emptyGrids = [{ iy, G }] from reconstructRowVariants(plan, cells, ['base']).base
export function emptyReferenceLines(plan, emptyGrids) {
  const { o, xAxis, zAxis, hStep, vStep, zlo, zhi } = plan;
  const profiles = [], ys = [], iys = [];
  for (const { iy, G } of emptyGrids) {
    if (G) { profiles.push(bandProfile(G, zAxis, zlo, zhi)); ys.push(iy * vStep); iys.push(iy); }
  }
  if (!profiles.length) return [];
  const h = houghLines(profiles, ys, xAxis, hStep, o);
  return h.lines.map((l) => {
    const pr = lineRows(l, profiles, ys, iys, xAxis, hStep, h.yc, o);
    return { ...l, yc: h.yc, depth: fitDepth(pr)(h.yc), rows: pr.filter((p) => p.seen).length };
  });
}

/**
 * @param plan          planDetection(...)
 * @param rowResults    [{ iy, grids }] in row order, grids from reconstructRowVariants
 * @param emptyLines    emptyReferenceLines(...) or []
 * @param usedReference whether an empty reference was supplied
 */
export function finishDetection(plan, rowResults, emptyLines = [], usedReference = false) {
  const { o, hStep, vStep, xAxis, zAxis, zlo, zhi, f0Hz, fHiHz, wallT } = plan;

  // Per variant: per-row profiles, then the line search. Rows whose reconstruction fails
  // are dropped from THAT variant only; the base variant's row list defines the scan.
  const V = {};
  let baseGrids = [], baseRowYs = [], baseRowIys = [], baseProfiles = [];
  for (const v of VARIANTS) {
    const profiles = [], grids = [], ys = [], iys = [];
    for (const rr of rowResults) {
      const G = rr.grids ? rr.grids[v.key] : null;
      if (!G) continue;
      grids.push(G); profiles.push(bandProfile(G, zAxis, zlo, zhi)); ys.push(rr.iy * vStep); iys.push(rr.iy);
    }
    if (!profiles.length) return null;
    V[v.key] = houghLines(profiles, ys, xAxis, hStep, o);
    if (v.key === 'base') { baseGrids = grids; baseRowYs = ys; baseRowIys = iys; baseProfiles = profiles; }
  }
  const { yc, span } = V.base;

  // same line in another variant: close on average across the rows
  const sameLine = (a, b, ycB = yc, tol = o.lineMatchCm) => meanLineDistance(a, yc, b, ycB, baseRowYs) <= tol;

  const needRows = Math.max(1, Math.ceil(o.rowSupportFrac * baseProfiles.length));
  const xMin = xAxis[0], xMax = xAxis[xAxis.length - 1];
  const fCentre = (f0Hz + fHiHz) / 2;
  const targets = V.base.lines.map((line) => {
    const perRow = lineRows(line, baseProfiles, baseRowYs, baseRowIys, xAxis, hStep, yc, o);
    const depthAt = fitDepth(perRow);
    const depth = depthAt(yc);
    const rowsSeen = perRow.filter((p) => p.seen).length;
    const tests = {
      rows: rowsSeen >= needRows,
      gfit: V.gfit.lines.some((l) => sameLine(line, l)),
      low: V.low.lines.some((l) => sameLine(line, l)),
      high: V.high.lines.some((l) => sameLine(line, l)),
      trimStart: V.trimStart.lines.some((l) => sameLine(line, l)),
      trimEnd: V.trimEnd.lines.some((l) => sameLine(line, l)),
    };
    const testsPassed = Object.values(tests).filter(Boolean).length;
    const aligned = alignedProfile(baseGrids, perRow, depthAt, xAxis, zAxis, hStep, 12);
    const prom = prominenceOf(aligned, hStep);
    const edge = line.x < xMin + o.endExcludeCm || line.x > xMax - o.endExcludeCm;
    const yBottom = yc - span / 2, yTop = yc + span / 2;
    return {
      x: line.x, depth, db: line.db, rows: rowsSeen, rowsTotal: baseProfiles.length,
      slope: line.s, driftCm: line.s * span, leanDeg: (Math.atan(line.s) * 180) / Math.PI,
      xBottom: line.x + line.s * (yBottom - yc), xTop: line.x + line.s * (yTop - yc), yMid: yc,
      tests, testsPassed, prominenceDb: prom, edge, inReference: false, reference: null, rating: 'none',
      ...sizeOf(aligned, hStep, fCentre),
      perRow,
    };
  });
  // Empty reference, matched ONE-TO-ONE. A fixed reflector appears once in the empty scan,
  // so each reference line may explain at most one scan line and each scan line at most one
  // reference line. Candidate pairs (within refMatchCm mean lateral distance, refMatchDepthCm
  // in depth, and not more than refMatchMarginDb weaker) are assigned cheapest first, cost =
  // (distance / refMatchCm)^2 + (depth difference / refMatchDepthCm)^2. Letting every scan
  // line check every reference line independently vetoed a real pipe beside the crevice on a
  // tall slanted scan while the crevice's own line escaped by 0.1 cm; this assignment was the
  // most robust of the rules tried (35 of 60 neighbouring threshold settings kept every target).
  const pairs = [];
  targets.forEach((t, ti) => emptyLines.forEach((e, ei) => {
    if (!Number.isFinite(e.depth) || !Number.isFinite(t.depth)) return;
    const d = meanLineDistance({ x: t.x, s: t.slope }, yc, e, e.yc, baseRowYs);
    const dz = Math.abs(e.depth - t.depth);
    if (d > o.refMatchCm || dz > o.refMatchDepthCm || e.db < t.db - o.refMatchMarginDb) return;
    pairs.push({ ti, ei, cost: (d / o.refMatchCm) ** 2 + (dz / o.refMatchDepthCm) ** 2 });
  }));
  pairs.sort((p, q) => p.cost - q.cost);
  const usedT = new Set(), usedE = new Set();
  for (const p of pairs) {
    if (usedT.has(p.ti) || usedE.has(p.ei)) continue;
    usedT.add(p.ti); usedE.add(p.ei);
    targets[p.ti].reference = emptyLines[p.ei];
    targets[p.ti].inReference = true;
  }
  for (const t of targets) {
    if (t.reference) t.rating = 'reference';
    else if (t.testsPassed === 6 && t.prominenceDb >= o.confirmedProminenceDb) t.rating = 'confirmed';
    else if (t.testsPassed >= 4 && t.tests.rows
      && t.prominenceDb >= o.probableProminenceDb + (Math.abs(t.driftCm) > o.driftMatchCm ? o.slantedExtraProminenceDb : 0)) t.rating = 'probable';
  }
  // Sidelobe suppression: a probable lying within sidelobeCm (mean lateral distance) of a
  // STRONGER confirmed target.
  for (const t of targets) {
    if (t.rating !== 'probable') continue;
    const lobe = targets.find((u) => u !== t && u.rating === 'confirmed' && u.db > t.db
      && meanLineDistance({ x: u.x, s: u.slope }, yc, { x: t.x, s: t.slope }, yc, baseRowYs) <= o.sidelobeCm);
    if (lobe) { t.rating = 'none'; t.sidelobeOf = lobe.x; }
  }
  targets.sort((a, b) => a.x - b.x);
  return {
    targets,
    emptyLines,
    // kept for callers that read peaks: the reference lines at their mid-height
    emptyPeaks: emptyLines.map((e) => ({ x: e.x, depth: e.depth, db: e.db, rows: e.rows })),
    xMin, xMax, hStep, vStep, depthBand: [zlo, zhi], endExcludeCm: o.endExcludeCm,
    rowsTotal: baseProfiles.length, needRows, rowIys: baseRowIys, rowYs: baseRowYs, yMid: yc, spanCm: span,
    usedReference,
    wallThicknessCm: wallT,
  };
}

/**
 * The whole detection in one thread (the Node harness, and the worker's fallback).
 * @param rows       [{ iy, cells }]
 * @param params     see planDetection
 * @param options    DETECT_DEFAULTS overrides
 * @param emptyRows  same shape as rows, from an empty-wall scan, or null
 * @param onProgress optional (0..1)
 */
export function runDetection(rows, params, options = {}, emptyRows = null, onProgress = () => {}) {
  rows = usableRows(rows);
  if (!rows.length) return null;
  const plan = planDetection(rows, params, options);
  const empties = emptyRows ? usableRows(emptyRows) : [];
  const total = rows.length * VARIANTS.length + empties.length;
  let done = 0;
  const rowResults = rows.map((r) => {
    const grids = reconstructRowVariants(plan, r.cells);
    done += VARIANTS.length; onProgress(done / total);
    return { iy: r.iy, grids };
  });
  const emptyGrids = empties.map((r) => {
    const G = reconstructRowVariants(plan, r.cells, ['base']).base;
    done++; onProgress(done / total);
    return { iy: r.iy, G };
  });
  const emptyLines = emptyGrids.length ? emptyReferenceLines(plan, emptyGrids) : [];
  return finishDetection(plan, rowResults, emptyLines, !!(emptyRows && emptyRows.length));
}

// The rating the UI shows once the ends toggle is applied. Kept out of runDetection so
// the toggle does not trigger a recompute.
export function effectiveRating(t, handleEnds) {
  if (handleEnds && t.edge && t.rating !== 'reference') return t.rating === 'none' ? 'none' : 'unresolved';
  return t.rating;
}
