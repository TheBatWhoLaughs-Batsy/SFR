// Imaging Bench effect math.
//
// Every export here is a pure function over a `waterfall_snapshot` (v1) plus a
// params object; nothing touches React or the DOM. Effects return plain arrays
// plus axis metadata and the display just draws them, so each effect can be
// exercised head-first from a test without mounting anything.
//
// Row ordering matches the live waterfall: rows[0] is the OLDEST sweep and is
// drawn at the bottom of the pane.

const SPEED_OF_LIGHT = 299_792_458;

// ── FFT ────────────────────────────────────────────────────────────────────
// Radix-2 in-place, same implementation the live display and lib/rangeProfile
// already use.

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + halfLen] * curRe - im[i + j + halfLen] * curIm;
        const vIm = re[i + j + halfLen] * curIm + im[i + j + halfLen] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + halfLen] = uRe - vRe;
        im[i + j + halfLen] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

export function ifftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ── Windows ────────────────────────────────────────────────────────────────

function besselI0(x) {
  let sum = 1.0;
  let term = 1.0;
  for (let k = 1; k <= 25; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

export function rectangularWindow(n) {
  const w = new Float64Array(n);
  w.fill(1.0);
  return w;
}

export function hanningWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  }
  return w;
}

export function kaiserWindow(n, beta) {
  const w = new Float64Array(n);
  const denom = besselI0(beta);
  for (let i = 0; i < n; i++) {
    const a = 2.0 * i / (n - 1) - 1.0;
    w[i] = besselI0(beta * Math.sqrt(1.0 - a * a)) / denom;
  }
  return w;
}

export const WINDOW_TYPES = ['rectangular', 'hanning', 'kaiser'];

/** Resolve a window-type name into an (n) => Float64Array taper. */
export function windowFn(type, beta) {
  if (type === 'kaiser') return (n) => kaiserWindow(n, beta);
  if (type === 'hanning') return hanningWindow;
  return rectangularWindow;
}

// ── Colormaps ──────────────────────────────────────────────────────────────
// All are (t in [0,1]) => [r, g, b] with 0-255 components, the same signature
// as the jet() the live waterfall uses.

function clamp255(v) {
  return Math.round(255 * Math.max(0, Math.min(1, v)));
}

// Polynomial fits to the matplotlib / Google originals — accurate to ~1/255
// and far cheaper than shipping 256-entry tables.
function poly(t, c) {
  const x = Math.max(0, Math.min(1, t));
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = c[6][k];
    for (let i = 5; i >= 0; i--) v = v * x + c[i][k];
    out[k] = clamp255(v);
  }
  return out;
}

const VIRIDIS_C = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];

const INFERNO_C = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

const TURBO_C = [
  [0.1140890109226559, 0.06288340699912215, 0.2248337216805064],
  [6.716419456701526, 3.182286745507602, 7.571981696424315],
  [-66.09402360453038, -4.9279827041226, -10.09439367561635],
  [228.7660791526501, 25.04986699771073, -91.54105330182436],
  [-334.8351565777451, -69.31749712757485, 288.5858850615712],
  [218.7637218434795, 67.52150567819112, -305.2045772184957],
  [-52.88903478218835, -21.54527364654712, 110.5174647748972],
];

export function viridis(t) { return poly(t, VIRIDIS_C); }
export function inferno(t) { return poly(t, INFERNO_C); }
export function turbo(t) { return poly(t, TURBO_C); }

export function grey(t) {
  const v = clamp255(t);
  return [v, v, v];
}

export function jet(t) {
  const x = Math.max(0, Math.min(1, t));
  return [
    clamp255(Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 3)))),
    clamp255(Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 2)))),
    clamp255(Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 1)))),
  ];
}

export const COLORMAPS = { viridis, inferno, turbo, grey, jet };
export const COLORMAP_NAMES = ['viridis', 'inferno', 'turbo', 'grey', 'jet'];

/**
 * Build a colour lookup closure honouring the reverse flag and gamma. Gamma
 * bends where the map's midpoint lands without touching the data itself.
 */
export function colormapFn(name, { reverse = false, gamma = 1.0 } = {}) {
  const base = COLORMAPS[name] || viridis;
  return (t) => {
    let x = Math.max(0, Math.min(1, t));
    if (gamma !== 1.0) x = Math.pow(x, gamma);
    if (reverse) x = 1 - x;
    return base(x);
  };
}

/** HSV -> RGB, h in degrees, s/v in [0,1]. Used by the phase-as-hue effect. */
export function hsvToRgb(h, s, v) {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return [clamp255(r + m), clamp255(g + m), clamp255(b + m)];
}

// ── CFAR ───────────────────────────────────────────────────────────────────

export const CFAR_GUARD = 4;
export const CFAR_TRAIN = 16;
export const CFAR_ALPHA = 6;
export const CFAR_VARIANTS = ['ca', 'go', 'so'];

/**
 * Constant false alarm rate threshold over a dB-valued range profile.
 *
 * variant:
 *   'ca' — cell-averaging, the mean of both training halves (the live SFCW
 *          display's behaviour, and what this replaced when it was lifted here)
 *   'go' — greatest-of, max of the two halves; the right choice next to the
 *          strong wall return, where a clutter edge otherwise drags the
 *          threshold down on the far side
 *   'so' — smallest-of, min of the two halves; better for closely spaced
 *          targets, worse at clutter edges
 */
export function computeCFAR(mags, guardCells, trainCells, alphaDb, variant = 'ca') {
  const n = mags.length;
  const threshold = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // `sum`/`count` accumulate in the original side-then-k order rather than
    // being derived from the two halves, so the CA result stays bit-identical
    // to the implementation this replaced in SfcwDisplay. The per-half
    // accumulators exist only for the GO/SO variants.
    let sum = 0, count = 0;
    let loSum = 0, loCount = 0, hiSum = 0, hiCount = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = guardCells + 1; k <= guardCells + trainCells; k++) {
        const idx = i + side * k;
        if (idx >= 0 && idx < n) {
          sum += mags[idx];
          count++;
          if (side < 0) { loSum += mags[idx]; loCount++; }
          else { hiSum += mags[idx]; hiCount++; }
        }
      }
    }

    let noise;
    if (variant === 'go' || variant === 'so') {
      const loAvg = loCount > 0 ? loSum / loCount : null;
      const hiAvg = hiCount > 0 ? hiSum / hiCount : null;
      if (loAvg === null && hiAvg === null) noise = mags[i];
      else if (loAvg === null) noise = hiAvg;
      else if (hiAvg === null) noise = loAvg;
      else noise = variant === 'go' ? Math.max(loAvg, hiAvg) : Math.min(loAvg, hiAvg);
    } else {
      noise = count > 0 ? sum / count : mags[i];
    }

    threshold[i] = noise + alphaDb;
  }
  return threshold;
}

// ── Statistics helpers ─────────────────────────────────────────────────────

/** Linear-interpolated percentile of a numeric array. `p` is 0-100. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

/** Mean after discarding the top and bottom `frac` of the sorted sample. */
function trimmedMean(values, frac = 0.2) {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const cut = Math.floor(sorted.length * frac);
  const lo = cut;
  const hi = sorted.length - cut;
  if (hi - lo < 1) return median(sorted);
  let s = 0;
  for (let i = lo; i < hi; i++) s += sorted[i];
  return s / (hi - lo);
}

const STAT_FNS = { median, mean, trimmed: trimmedMean };

// ── Snapshot access ────────────────────────────────────────────────────────

/** The RF frequency of each step, in Hz. */
export function snapshotFreqs(snapshot) {
  const c = snapshot.common || {};
  const n = c.num_steps || (snapshot.sweeps[0] ? snapshot.sweeps[0].real.length : 0);
  const start = c.start_freq;
  const step = c.step_size;
  const freqs = new Float64Array(n);
  if (start == null || step == null) {
    // Pre-start_freq snapshots: the axis is unknown, so index it instead of
    // inventing frequencies. Callers surface this via freqsKnown.
    for (let i = 0; i < n; i++) freqs[i] = i;
    return freqs;
  }
  for (let i = 0; i < n; i++) freqs[i] = start + i * step;
  return freqs;
}

export function freqsKnown(snapshot) {
  const c = snapshot.common || {};
  return c.start_freq != null && c.step_size != null;
}

/** Validate an imported file. Returns null when it is a usable v1 snapshot. */
export function validateSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return 'Not a JSON object.';
  if (obj.type !== 'waterfall_snapshot') {
    return `Not a waterfall snapshot (type is "${obj.type || 'missing'}").`;
  }
  if (!Array.isArray(obj.sweeps) || obj.sweeps.length === 0) return 'Snapshot has no sweeps.';
  const s0 = obj.sweeps[0];
  if (!Array.isArray(s0.real) || !Array.isArray(s0.imag)) return 'Sweeps have no complex data.';
  if (s0.real.length !== s0.imag.length) return 'Sweep real/imag lengths differ.';
  if (!obj.common || obj.common.step_size == null) return 'Snapshot is missing common.step_size.';
  return null;
}

/** Human-readable summary for the panel readout. */
export function snapshotSummary(snapshot) {
  const c = snapshot.common || {};
  const n = snapshot.sweeps.length;
  const steps = c.num_steps || snapshot.sweeps[0].real.length;
  const known = freqsKnown(snapshot);
  const spanHz = known ? (c.stop_freq - c.start_freq) : null;
  return {
    sweeps: n,
    steps,
    startGHz: known ? c.start_freq / 1e9 : null,
    stopGHz: known ? c.stop_freq / 1e9 : null,
    stepMHz: c.step_size / 1e6,
    bandwidthHz: spanHz,
    rangeResCm: spanHz ? (SPEED_OF_LIGHT / (2 * spanHz)) * 100 : null,
    maxRangeM: SPEED_OF_LIGHT / (2 * c.step_size),
    rangeOffset: c.range_offset || 0,
    timestamp: snapshot.timestamp || null,
  };
}

// ── Range profiles ─────────────────────────────────────────────────────────

export const DEFAULT_PROFILE = {
  windowType: 'rectangular',
  kaiserBeta: 3,
  zeroPad: 4,
  rangeComp: 0,
};

/**
 * Window -> zero-padded IFFT -> complex range profile, for every sweep in the
 * snapshot. This is the one expensive step; every range-domain effect builds on
 * the result, so callers should memoize it on [snapshot, profile].
 *
 * Range compensation is folded into the complex profile as an amplitude gain of
 * r^(n/2), which is exactly the `+ n*10*log10(r)` dB the live display applies —
 * doing it here keeps magnitude and phase consistent for the complex effects.
 *
 * Bins at negative distance (the range_offset region) are dropped, matching the
 * live display and the Pi.
 */
export function prepare(snapshot, profile = DEFAULT_PROFILE) {
  const c = snapshot.common;
  const numSteps = c.num_steps || snapshot.sweeps[0].real.length;
  const stepSize = c.step_size;
  const rangeOffset = c.range_offset || 0;
  const zeroPad = profile.zeroPad || 4;
  const nfft = nextPow2(numSteps * zeroPad);
  const half = nfft >> 1;

  const maxRange = SPEED_OF_LIGHT / (2 * stepSize);
  const allDist = new Float64Array(half);
  for (let i = 0; i < half; i++) allDist[i] = (i / nfft) * maxRange - rangeOffset;
  let startIdx = 0;
  while (startIdx < half && allDist[startIdx] < 0) startIdx++;
  const distances = allDist.slice(startIdx);
  const numBins = distances.length;

  // Amplitude gain per bin from the R^n compensation.
  const gain = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const r = distances[i] + rangeOffset;
    gain[i] = (profile.rangeComp > 0 && r > 0.01) ? Math.pow(r, profile.rangeComp / 2) : 1;
  }

  const win = windowFn(profile.windowType, profile.kaiserBeta)(numSteps);

  const re = [], im = [], mag = [], magDb = [];
  for (const sweep of snapshot.sweeps) {
    const fr = new Float64Array(nfft);
    const fi = new Float64Array(nfft);
    for (let i = 0; i < numSteps; i++) {
      fr[i] = sweep.real[i] * win[i];
      fi[i] = sweep.imag[i] * win[i];
    }
    ifftInPlace(fr, fi);

    const r = new Float64Array(numBins);
    const m = new Float64Array(numBins);
    const a = new Float64Array(numBins);
    const d = new Float64Array(numBins);
    for (let i = 0; i < numBins; i++) {
      const g = gain[i];
      r[i] = fr[startIdx + i] * g;
      m[i] = fi[startIdx + i] * g;
      a[i] = Math.sqrt(r[i] * r[i] + m[i] * m[i]);
      d[i] = 20 * Math.log10(a[i] + 1e-12);
    }
    re.push(r); im.push(m); mag.push(a); magDb.push(d);
  }

  return { nfft, startIdx, distances, numBins, numSweeps: re.length, re, im, mag, magDb, gain, stepSize, rangeOffset, numSteps };
}

/**
 * Resolve the View section's range zoom into a column slice. Effects clip to
 * this before computing colour limits, so percentiles and dynamic scaling
 * describe what is actually on screen rather than the whole profile.
 */
export function viewWindow(distances, view) {
  const n = distances.length;
  if (!view) return { c0: 0, c1: n - 1, distances };
  const lo = view.rangeMin != null ? view.rangeMin : distances[0];
  const hi = view.rangeMax != null ? view.rangeMax : distances[n - 1];
  let c0 = 0;
  while (c0 < n - 1 && distances[c0] < lo) c0++;
  let c1 = n - 1;
  while (c1 > c0 && distances[c1] > hi) c1--;
  return { c0, c1, distances: distances.slice(c0, c1 + 1) };
}

function sliceRows(rowsFull, c0, c1) {
  return rowsFull.map(r => r.slice(c0, c1 + 1));
}

/** Min/max over an array of rows, ignoring non-finite entries. */
export function rowsExtent(rows) {
  let lo = Infinity, hi = -Infinity;
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (hi - lo < 1e-12) { lo -= 0.5; hi += 0.5; }
  return { min: lo, max: hi };
}

function rangeAxis(distances) {
  return {
    min: distances[0],
    max: distances[distances.length - 1],
    label: 'Range',
    unit: 'm',
  };
}

function sweepAxis(n) {
  return { min: 0, max: Math.max(0, n - 1), label: 'Sweep #', unit: '' };
}

// ── Effect catalogue ───────────────────────────────────────────────────────
// `multiSweep` effects are meaningless on a one-sweep snapshot and the panel
// disables them. `perSweep` effects render one sweep at a time and are driven
// by the View section's sweep selector.

export const EFFECTS = [
  {
    id: 'none',
    label: '0 · None',
    description:
      'The reference image: exactly what the live SFCW waterfall would show — window, zero-padded IFFT, magnitude. ' +
      'A target is a bright vertical stripe holding still across sweeps. Every other effect is judged against this one.',
  },
  {
    id: 'compression',
    label: '1 · Compression Exponent',
    description:
      'Displays |H|^p normalised to the peak, turning the binary dB/LIN switch into a continuous dial. ' +
      'Small p flattens the wall return and lifts weak targets out of the floor; p=1 is linear, p=2 favours the strongest return.',
  },
  {
    id: 'percentile',
    label: '2 · Percentile Clipping',
    description:
      'Takes the colour limits from percentiles of the data instead of its min and max, so one saturating or dead bin ' +
      'cannot steal the whole colour range. The image is unchanged — only how much of the scale the bulk of the data gets.',
  },
  {
    id: 'binnorm',
    label: '3 · Per-Bin Temporal Normalisation',
    description:
      'Divides every range bin by its own statistic over time, an adaptive clutter map with no capture step and no model. ' +
      'The wall face and cable coupling are constant and normalise to 0 dB; anything that changes rises above it.',
    multiSweep: true,
  },
  {
    id: 'cfar',
    label: '4 · CFAR Ratio',
    description:
      'Shows signal over its CFAR threshold rather than raw amplitude, so 0 dB means exactly "at detection threshold". ' +
      'The colour scale is absolute and never needs rescaling between scenes — anything warm is a detection.',
  },
  {
    id: 'colormap',
    label: '5 · Colormap',
    description:
      'The same reference image under all five colour maps side by side. Jet manufactures false edges at its cyan and ' +
      'yellow transitions and hides gradients in the green, so structure that appears in jet alone is the map, not the data.',
  },
  {
    id: 'phasehue',
    label: '6 · Phase as Hue',
    description:
      'Hue is the phase of the complex range profile, brightness is its magnitude — the phase every other view throws away. ' +
      'A real scatterer holds phase across sweeps and reads as a smooth hue band; noise is rainbow confetti.',
  },
  {
    id: 'coherence',
    label: '7 · Sweep-to-Sweep Coherence',
    description:
      'Normalised complex correlation between a sweep and one lag earlier, over a sliding window. It is amplitude-independent: ' +
      'a stationary target scores ~1 no matter how weak, noise scores ~0. This is the "is it actually there" view.',
    multiSweep: true,
  },
  {
    id: 'integration',
    label: '8 · Coherent vs Non-Coherent',
    description:
      'Averaging the complex profile cancels noise and keeps phase-stable targets; averaging its magnitude keeps everything. ' +
      'Their ratio is a phase-stability map — near 0 dB is a real static scatterer, deeply negative is noise that happens to be bright.',
    multiSweep: true,
  },
  {
    id: 'dispersion',
    label: '9 · Frequency–Range Dispersion',
    description:
      'Slides a sub-band across the frequency steps, IFFTs each one and stacks them: range across, sub-band centre up. ' +
      'Rebar is spectrally flat and holds one range; dielectric contrasts fade with frequency and multipath walks in range as the band moves.',
    perSweep: true,
  },
  {
    id: 's21',
    label: '10 · Raw S21 vs Frequency',
    description:
      'The calibrated h_cal against frequency, before any IFFT. A target at range R is a sinusoid of period c/2R, so a shallow ' +
      'return smeared into the wall lobe is often an obvious clean ripple here. It is also the fastest way to spot a corrupted sweep.',
    perSweep: true,
  },
];

export const DEFAULT_PARAMS = {
  profile: { ...DEFAULT_PROFILE },
  view: { rangeMin: 0, rangeMax: 3, sweepIndex: 0, followLatest: true },
  colormap: { name: 'viridis', reverse: false, gamma: 1.0 },
  none: { scaleMode: 'linear' },
  compression: { p: 0.5, showDbReference: false },
  percentile: { low: 2, high: 99.5, scope: 'history' },
  binnorm: { stat: 'median', windowLen: 50, sliding: false, units: 'db', floorDb: -60 },
  cfar: { guard: CFAR_GUARD, train: CFAR_TRAIN, alpha: CFAR_ALPHA, variant: 'ca', detectionsOnly: false },
  phasehue: { valueGamma: 0.5, saturation: 1.0, rotationDeg: 0, floorDb: -40 },
  coherence: { K: 5, lag: 1, maskEnabled: false, maskDb: -40, autoScale: false },
  integration: { K: 10, mode: 'side' },
  // overlap 0.6 at width 0.25 is the point where the default 8 sub-bands
  // actually fit across a 51-step sweep; at 0.5 only 6 do.
  dispersion: { count: 8, widthFrac: 0.25, overlap: 0.6, windowType: 'hanning', avgN: 1 },
  s21: { component: 'mag', display: 'line' },
};

// ── Effects ────────────────────────────────────────────────────────────────

function profileLabel(pr) {
  const win = pr.windowType === 'kaiser' ? `kaiser b${pr.kaiserBeta}` : pr.windowType;
  return `${win} · pad x${pr.zeroPad}${pr.rangeComp > 0 ? ` · R^${pr.rangeComp}` : ''}`;
}

function effectNone(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const isDb = p.scaleMode === 'db';
  const rows = sliceRows(isDb ? prep.magDb : prep.mag, w.c0, w.c1);
  const ext = rowsExtent(rows);
  return {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: { min: ext.min, max: ext.max, unit: isDb ? 'dB' : '', label: isDb ? 'Magnitude' : 'Magnitude (lin)' },
    title: 'NONE · REFERENCE RANGE PROFILE',
    subtitle: `${isDb ? 'dB' : 'linear'} · ${profileLabel(pr)}`,
    notes: ['Identical processing to the live SFCW waterfall.'],
  };
}

function effectCompression(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const lin = sliceRows(prep.mag, w.c0, w.c1);
  const ext = rowsExtent(lin);
  const peak = Math.max(ext.max, 1e-12);

  const rows = lin.map(row => {
    const out = new Float64Array(row.length);
    for (let i = 0; i < row.length; i++) out[i] = Math.pow(row[i] / peak, p.p);
    return out;
  });

  const result = {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: { min: 0, max: 1, unit: '', label: `(|H|/peak)^${p.p.toFixed(2)}`, fixed: true },
    title: 'COMPRESSION EXPONENT',
    subtitle: `p = ${p.p.toFixed(2)} · ${profileLabel(pr)}`,
    notes: [
      `p towards 0 approaches log compression, p=1 linear, p=2 power. Peak = ${peak.toExponential(2)}.`,
    ],
  };

  if (p.showDbReference) {
    const dbRows = sliceRows(prep.magDb, w.c0, w.c1);
    const dbExt = rowsExtent(dbRows);
    result.inset = {
      label: 'dB reference',
      rows: dbRows,
      v: { min: dbExt.min, max: dbExt.max, unit: 'dB' },
    };
  }
  return result;
}

function effectPercentile(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const rows = sliceRows(prep.magDb, w.c0, w.c1);

  if (p.scope === 'row') {
    // Each row gets its own limits and is normalised into [0,1], so a row's
    // internal contrast survives where a whole-history scale would flatten it.
    let loMin = Infinity, loMax = -Infinity, hiMin = Infinity, hiMax = -Infinity;
    let clipLow = 0, clipHigh = 0, total = 0;
    const out = rows.map(row => {
      const lo = percentile(row, p.low);
      const hi = percentile(row, p.high);
      if (lo < loMin) loMin = lo;
      if (lo > loMax) loMax = lo;
      if (hi < hiMin) hiMin = hi;
      if (hi > hiMax) hiMax = hi;
      const span = Math.max(hi - lo, 1e-9);
      const o = new Float64Array(row.length);
      for (let i = 0; i < row.length; i++) {
        total++;
        if (row[i] < lo) clipLow++;
        else if (row[i] > hi) clipHigh++;
        o[i] = Math.max(0, Math.min(1, (row[i] - lo) / span));
      }
      return o;
    });
    return {
      kind: 'waterfall',
      rows: out,
      x: rangeAxis(w.distances),
      y: sweepAxis(out.length),
      v: { min: 0, max: 1, unit: '', label: 'Per-row normalised', fixed: true },
      title: 'PERCENTILE CLIPPING · PER-ROW',
      subtitle: `p${p.low} - p${p.high}`,
      notes: [
        `Row low limits ${loMin.toFixed(1)} to ${loMax.toFixed(1)} dB, high limits ${hiMin.toFixed(1)} to ${hiMax.toFixed(1)} dB.`,
        `Clipped ${clipLow} low (${(100 * clipLow / total).toFixed(2)}%), ${clipHigh} high (${(100 * clipHigh / total).toFixed(2)}%) of ${total} samples.`,
      ],
    };
  }

  // Whole visible history: the image is untouched, only the limits move.
  const flat = [];
  for (const row of rows) for (let i = 0; i < row.length; i++) flat.push(row[i]);
  const lo = percentile(flat, p.low);
  const hi = percentile(flat, p.high);
  let clipLow = 0, clipHigh = 0;
  for (const v of flat) { if (v < lo) clipLow++; else if (v > hi) clipHigh++; }
  const ext = rowsExtent(rows);

  return {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: { min: lo, max: Math.max(hi, lo + 1e-6), unit: 'dB', label: 'Magnitude', fixed: true },
    title: 'PERCENTILE CLIPPING · VISIBLE HISTORY',
    subtitle: `p${p.low} = ${lo.toFixed(1)} dB to p${p.high} = ${hi.toFixed(1)} dB`,
    notes: [
      `Data spans ${ext.min.toFixed(1)} to ${ext.max.toFixed(1)} dB; the percentiles keep ${(hi - lo).toFixed(1)} dB of it.`,
      `Clipped ${clipLow} low (${(100 * clipLow / flat.length).toFixed(2)}%), ${clipHigh} high (${(100 * clipHigh / flat.length).toFixed(2)}%) of ${flat.length} samples.`,
    ],
  };
}

function effectBinNorm(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const lin = sliceRows(prep.mag, w.c0, w.c1);
  const nRows = lin.length;
  const nBins = lin[0].length;
  const statFn = STAT_FNS[p.stat] || median;

  // The floor guard is relative to the whole image's peak, so it means the same
  // thing regardless of gain settings.
  const peak = rowsExtent(lin).max;
  const eps = peak * Math.pow(10, p.floorDb / 20);

  const K = Math.max(2, Math.min(p.windowLen, nRows));
  const rows = [];

  if (!p.sliding) {
    // One statistic per bin over the whole buffer - cheaper and steadier.
    const col = new Float64Array(nRows);
    const ref = new Float64Array(nBins);
    for (let b = 0; b < nBins; b++) {
      for (let t = 0; t < nRows; t++) col[t] = lin[t][b];
      ref[b] = Math.max(statFn(col), eps);
    }
    for (let t = 0; t < nRows; t++) {
      const o = new Float64Array(nBins);
      for (let b = 0; b < nBins; b++) o[b] = lin[t][b] / ref[b];
      rows.push(o);
    }
  } else {
    // Centred sliding window, clipped at the buffer ends.
    const halfK = K >> 1;
    for (let t = 0; t < nRows; t++) {
      const t0 = Math.max(0, Math.min(nRows - K, t - halfK));
      const t1 = Math.min(nRows, t0 + K);
      const buf = new Float64Array(t1 - t0);
      const o = new Float64Array(nBins);
      for (let b = 0; b < nBins; b++) {
        for (let k = t0; k < t1; k++) buf[k - t0] = lin[k][b];
        o[b] = lin[t][b] / Math.max(statFn(buf), eps);
      }
      rows.push(o);
    }
  }

  const isDb = p.units === 'db';
  const out = isDb
    ? rows.map(r => {
        const o = new Float64Array(r.length);
        for (let i = 0; i < r.length; i++) o[i] = 20 * Math.log10(r[i] + 1e-12);
        return o;
      })
    : rows;

  const ext = rowsExtent(out);
  const statLabel = p.stat === 'trimmed' ? 'trimmed mean (20%)' : p.stat;
  return {
    kind: 'waterfall',
    rows: out,
    x: rangeAxis(w.distances),
    y: sweepAxis(out.length),
    v: { min: ext.min, max: ext.max, unit: isDb ? 'dB' : 'x', label: 'Ratio' },
    title: 'PER-BIN TEMPORAL NORMALISATION',
    subtitle: `${statLabel} · ${p.sliding ? `sliding K=${K}` : 'whole buffer'} · ${isDb ? 'dB ratio' : 'ratio'}`,
    notes: [
      `Constant bins land at ${isDb ? '0 dB' : '1.0x'}; the floor guard is ${p.floorDb} dB below the image peak.`,
    ],
  };
}

function effectCfar(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  // CFAR trains on neighbouring bins, so run it over the full profile and clip
  // afterwards - otherwise the zoom edges get a one-sided threshold.
  const rows = [];
  for (const full of prep.magDb) {
    const th = computeCFAR(full, p.guard, p.train, p.alpha, p.variant);
    const o = new Float64Array(w.c1 - w.c0 + 1);
    for (let i = 0; i < o.length; i++) {
      const ratio = full[w.c0 + i] - th[w.c0 + i];
      o[i] = p.detectionsOnly ? (ratio > 0 ? 1 : 0) : ratio;
    }
    rows.push(o);
  }

  let detCount = 0, total = 0;
  for (const row of rows) for (let i = 0; i < row.length; i++) {
    total++;
    if (p.detectionsOnly ? row[i] > 0.5 : row[i] > 0) detCount++;
  }

  const variantName = { ca: 'cell-averaging', go: 'greatest-of', so: 'smallest-of' }[p.variant] || p.variant;
  return {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: p.detectionsOnly
      ? { min: 0, max: 1, unit: '', label: 'Detection', fixed: true }
      : { min: -20, max: 20, unit: 'dB', label: 'Signal / threshold', fixed: true },
    title: p.detectionsOnly ? 'CFAR DETECTIONS' : 'CFAR RATIO',
    subtitle: `${variantName} · G=${p.guard} T=${p.train} a=${p.alpha} dB`,
    notes: [
      p.detectionsOnly
        ? 'Binary mask - anything above the threshold is 1.'
        : 'Colour limits are pinned at +/-20 dB; 0 dB is exactly the detection threshold, so the scale is absolute across scenes.',
      `${detCount} of ${total} cells (${(100 * detCount / total).toFixed(2)}%) are above threshold.`,
    ],
  };
}

function effectColormap(prep, p, view, pr, cmap) {
  const w = viewWindow(prep.distances, view);
  const rows = sliceRows(prep.magDb, w.c0, w.c1);
  const ext = rowsExtent(rows);
  return {
    kind: 'panes',
    panes: COLORMAP_NAMES.map(name => ({ label: name, rows, colormap: name })),
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: { min: ext.min, max: ext.max, unit: 'dB', label: 'Magnitude' },
    title: 'COLORMAP COMPARISON',
    subtitle: `active: ${cmap.name}${cmap.reverse ? ' (reversed)' : ''} · gamma ${cmap.gamma.toFixed(2)}`,
    notes: [
      'The same reference dB image under every map. The chosen map stays active for all the other effects.',
    ],
  };
}

function effectPhaseHue(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const nBins = w.c1 - w.c0 + 1;
  let peak = 1e-12;
  for (const m of prep.mag) for (let i = w.c0; i <= w.c1; i++) if (m[i] > peak) peak = m[i];
  const floorLin = peak * Math.pow(10, p.floorDb / 20);

  const rgb = [];
  let floored = 0, total = 0;
  for (let t = 0; t < prep.numSweeps; t++) {
    const re = prep.re[t], im = prep.im[t], mg = prep.mag[t];
    const px = new Uint8ClampedArray(nBins * 3);
    for (let i = 0; i < nBins; i++) {
      const b = w.c0 + i;
      total++;
      if (mg[b] < floorLin) {
        floored++;
        continue; // stays black
      }
      const hue = (Math.atan2(im[b], re[b]) * 180 / Math.PI) + p.rotationDeg;
      const value = Math.pow(Math.min(1, mg[b] / peak), p.valueGamma);
      const [r, g, bl] = hsvToRgb(hue, p.saturation, value);
      px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = bl;
    }
    rgb.push(px);
  }

  return {
    kind: 'rgb',
    rgb,
    x: rangeAxis(w.distances),
    y: sweepAxis(rgb.length),
    legend: 'hue',
    legendRotation: p.rotationDeg,
    title: 'PHASE AS HUE',
    subtitle: `gamma ${p.valueGamma.toFixed(2)} · sat ${p.saturation.toFixed(2)} · rot ${p.rotationDeg} deg · floor ${p.floorDb} dB`,
    notes: [
      `Hue is the complex range profile's phase, brightness its magnitude. ${floored} of ${total} cells (${(100 * floored / total).toFixed(1)}%) are below the floor and drawn black.`,
    ],
  };
}

function effectCoherence(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const nBins = w.c1 - w.c0 + 1;
  const nRows = prep.numSweeps;
  const K = Math.max(2, p.K);
  const lag = Math.max(1, p.lag);

  let peak = 1e-12;
  for (const m of prep.mag) for (let i = w.c0; i <= w.c1; i++) if (m[i] > peak) peak = m[i];
  const maskLin = peak * Math.pow(10, p.maskDb / 20);

  const rows = [];
  let undefinedRows = 0;
  for (let t = 0; t < nRows; t++) {
    const o = new Float64Array(nBins);
    // Pairs (t-k, t-k-lag) for k = 0..K-1, dropped where either index is
    // before the start of the buffer.
    const pairs = [];
    for (let k = 0; k < K; k++) {
      const a = t - k;
      const b = a - lag;
      if (b >= 0) pairs.push([a, b]);
    }
    // One pair is always exactly 1.0 by construction, which would read as a
    // perfect target everywhere. Leave those rows undefined instead.
    if (pairs.length < 2) {
      o.fill(NaN);
      undefinedRows++;
      rows.push(o);
      continue;
    }
    for (let i = 0; i < nBins; i++) {
      const bin = w.c0 + i;
      let cr = 0, ci = 0, pa = 0, pb = 0, magSum = 0;
      for (const [a, b] of pairs) {
        const ar = prep.re[a][bin], ai = prep.im[a][bin];
        const br = prep.re[b][bin], bi = prep.im[b][bin];
        // a * conj(b)
        cr += ar * br + ai * bi;
        ci += ai * br - ar * bi;
        pa += ar * ar + ai * ai;
        pb += br * br + bi * bi;
        magSum += prep.mag[a][bin];
      }
      if (p.maskEnabled && (magSum / pairs.length) < maskLin) {
        o[i] = NaN;
        continue;
      }
      const denom = Math.sqrt(pa * pb);
      o[i] = denom > 1e-24 ? Math.min(1, Math.sqrt(cr * cr + ci * ci) / denom) : NaN;
    }
    rows.push(o);
  }

  const ext = rowsExtent(rows);
  return {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: sweepAxis(rows.length),
    v: p.autoScale
      ? { min: ext.min, max: ext.max, unit: '', label: 'Coherence' }
      : { min: 0, max: 1, unit: '', label: 'Coherence', fixed: true },
    title: 'SWEEP-TO-SWEEP COHERENCE',
    subtitle: `K=${K} · lag=${lag}${p.maskEnabled ? ` · masked below ${p.maskDb} dB` : ''}`,
    notes: [
      'Amplitude-independent: a weak-but-real return scores the same as a strong one. 1 is perfectly stationary, 0 is noise.',
      undefinedRows > 0
        ? `${undefinedRows} row${undefinedRows === 1 ? '' : 's'} at the start of the buffer have fewer than two pairs and are drawn dark.`
        : null,
    ].filter(Boolean),
  };
}

function effectIntegration(prep, p, view, pr) {
  const w = viewWindow(prep.distances, view);
  const nBins = w.c1 - w.c0 + 1;
  const nRows = prep.numSweeps;
  const K = Math.max(2, Math.min(p.K, nRows));

  // Coherent integration is a complex mean. Averaging h_cal over K sweeps and
  // then transforming is the same thing as averaging the complex range profiles,
  // because the IFFT is linear - so this runs in the range domain, where the
  // non-coherent average (a mean of magnitudes) also lives.
  const coh = [], non = [], ratio = [];
  for (let t = 0; t < nRows; t++) {
    const t0 = Math.max(0, t - K + 1);
    const n = t - t0 + 1;
    const c = new Float64Array(nBins);
    const nc = new Float64Array(nBins);
    const rt = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
      const bin = w.c0 + i;
      let sr = 0, si = 0, sm = 0;
      for (let k = t0; k <= t; k++) {
        sr += prep.re[k][bin];
        si += prep.im[k][bin];
        sm += prep.mag[k][bin];
      }
      const cohMag = Math.sqrt(sr * sr + si * si) / n;
      const nonMag = sm / n;
      c[i] = 20 * Math.log10(cohMag + 1e-12);
      nc[i] = 20 * Math.log10(nonMag + 1e-12);
      rt[i] = c[i] - nc[i];
    }
    coh.push(c); non.push(nc); ratio.push(rt);
  }

  const sharedExt = rowsExtent(coh.concat(non));
  const shared = { min: sharedExt.min, max: sharedExt.max, unit: 'dB', label: 'Magnitude' };
  const ratioExt = rowsExtent(ratio);
  const ratioV = { min: Math.min(ratioExt.min, -1), max: 0, unit: 'dB', label: 'Coherent / non-coherent' };

  const base = {
    x: rangeAxis(w.distances),
    y: sweepAxis(nRows),
    title: 'COHERENT vs NON-COHERENT INTEGRATION',
    subtitle: `K=${K} · ${p.mode}`,
  };

  if (p.mode === 'coherent') {
    return { ...base, kind: 'waterfall', rows: coh, v: shared,
      notes: [`Complex mean over ${K} sweeps - noise cancels, phase-stable targets survive.`] };
  }
  if (p.mode === 'noncoherent') {
    return { ...base, kind: 'waterfall', rows: non, v: shared,
      notes: [`Magnitude mean over ${K} sweeps - everything survives, including bright noise.`] };
  }
  if (p.mode === 'ratio') {
    return { ...base, kind: 'waterfall', rows: ratio, v: ratioV,
      notes: ['Phase-stability map. Near 0 dB is a real static scatterer; deeply negative is noise that happens to be bright.'] };
  }

  return {
    ...base,
    kind: 'panes',
    panes: [
      { label: 'coherent', rows: coh },
      { label: 'non-coherent', rows: non },
      { label: 'ratio (dB)', rows: ratio, v: ratioV },
    ],
    v: shared,
    notes: [
      'Coherent and non-coherent share one colour scale, which is the whole comparison. The ratio pane is a relative quantity in different units, so it carries its own scale.',
    ],
  };
}

function effectDispersion(snapshot, prep, p, view, pr) {
  const c = snapshot.common;
  const numSteps = prep.numSteps;
  const freqs = snapshotFreqs(snapshot);
  const known = freqsKnown(snapshot);

  const idx = Math.max(0, Math.min(snapshot.sweeps.length - 1, view.sweepIndex));
  const avgN = Math.max(1, Math.min(p.avgN, idx + 1));

  // Coherent average of the selected sweep and the avgN-1 before it. A single
  // sweep is noisy at sub-band resolution.
  const hr = new Float64Array(numSteps);
  const hi = new Float64Array(numSteps);
  for (let k = idx - avgN + 1; k <= idx; k++) {
    const sw = snapshot.sweeps[k];
    for (let i = 0; i < numSteps; i++) { hr[i] += sw.real[i]; hi[i] += sw.imag[i]; }
  }
  for (let i = 0; i < numSteps; i++) { hr[i] /= avgN; hi[i] /= avgN; }

  const subWidth = Math.max(4, Math.min(numSteps, Math.round(p.widthFrac * numSteps)));
  const hop = Math.max(1, Math.round(subWidth * (1 - p.overlap)));
  const maxCount = Math.floor((numSteps - subWidth) / hop) + 1;
  const count = Math.max(1, Math.min(p.count, maxCount));

  const win = windowFn(p.windowType, pr.kaiserBeta)(subWidth);
  const w = viewWindow(prep.distances, view);
  const nBins = w.c1 - w.c0 + 1;

  const rows = [];
  const centres = [];
  for (let s = 0; s < count; s++) {
    const off = s * hop;
    const fr = new Float64Array(prep.nfft);
    const fi = new Float64Array(prep.nfft);
    for (let i = 0; i < subWidth; i++) {
      fr[i] = hr[off + i] * win[i];
      fi[i] = hi[off + i] * win[i];
    }
    // Starting the sub-band at a non-zero step does not shift range: range is
    // set by the rate of phase change with frequency, not by the offset.
    ifftInPlace(fr, fi);
    const o = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
      const b = prep.startIdx + w.c0 + i;
      const g = prep.gain[w.c0 + i];
      const m = Math.sqrt(fr[b] * fr[b] + fi[b] * fi[b]) * g;
      o[i] = 20 * Math.log10(m + 1e-12);
    }
    rows.push(o);
    centres.push(freqs[off + (subWidth >> 1)]);
  }

  const subBwHz = known ? (subWidth - 1) * c.step_size : null;
  const subResCm = subBwHz ? (SPEED_OF_LIGHT / (2 * subBwHz)) * 100 : null;
  const fullBwHz = known ? (numSteps - 1) * c.step_size : null;
  const fullResCm = fullBwHz ? (SPEED_OF_LIGHT / (2 * fullBwHz)) * 100 : null;

  const ext = rowsExtent(rows);
  return {
    kind: 'waterfall',
    rows,
    x: rangeAxis(w.distances),
    y: known
      ? { min: centres[0] / 1e9, max: centres[centres.length - 1] / 1e9, label: 'Sub-band centre', unit: 'GHz', decimals: 2 }
      : { min: 0, max: Math.max(0, count - 1), label: 'Sub-band #', unit: '' },
    v: { min: ext.min, max: ext.max, unit: 'dB', label: 'Magnitude' },
    title: 'FREQUENCY-RANGE DISPERSION',
    subtitle: `sweep ${idx + 1}/${snapshot.sweeps.length}${avgN > 1 ? ` (coherent avg of ${avgN})` : ''} · ${count} sub-bands of ${subWidth} steps`,
    notes: [
      subResCm
        ? `Sub-band range resolution is ${subResCm.toFixed(1)} cm, against ${fullResCm.toFixed(1)} cm full-band - much coarser, which is the price of the frequency axis.`
        : 'Frequency axis unknown (snapshot predates start_freq); sub-bands are indexed instead.',
      count < p.count
        ? `Only ${count} of the ${p.count} requested sub-bands fit at this width and overlap (hop = ${hop} steps).`
        : `Hop is ${hop} steps.`,
    ],
  };
}

/** In-place-safe phase unwrap over a wrapped-phase array, radians. */
function unwrap(phase) {
  const out = new Float64Array(phase.length);
  let offset = 0;
  out[0] = phase[0];
  for (let i = 1; i < phase.length; i++) {
    let d = phase[i] - phase[i - 1];
    while (d > Math.PI) { d -= 2 * Math.PI; }
    while (d < -Math.PI) { d += 2 * Math.PI; }
    offset += d;
    out[i] = phase[0] + offset;
  }
  return out;
}

/** Unwrapped phase minus its least-squares linear trend, in radians. */
function phaseResidual(real, imag, n) {
  const wrapped = new Float64Array(n);
  for (let i = 0; i < n; i++) wrapped[i] = Math.atan2(imag[i], real[i]);
  const un = unwrap(wrapped);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += un[i]; sxx += i * i; sxy += i * un[i]; }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const res = new Float64Array(n);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    res[i] = un[i] - (slope * i + intercept);
    sum += res[i];
    sumSq += res[i] * res[i];
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return { residual: res, std, slope, unwrapped: un, wrapped };
}

const COHERENCE_LIMIT_RAD = 0.3;   // the Pi's own coherent/incoherent cut

const S21_COMPONENTS = {
  mag:       { label: 'Magnitude', unit: 'dB' },
  phase:     { label: 'Phase (wrapped)', unit: 'deg' },
  unwrapped: { label: 'Phase (unwrapped)', unit: 'deg' },
  reim:      { label: 'Real & imaginary', unit: '' },
  residual:  { label: 'Phase residual after linear fit', unit: 'rad' },
};

function s21Component(sweep, n, component) {
  if (component === 'mag') {
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      o[i] = 20 * Math.log10(Math.hypot(sweep.real[i], sweep.imag[i]) + 1e-12);
    }
    return o;
  }
  if (component === 'phase') {
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) o[i] = Math.atan2(sweep.imag[i], sweep.real[i]) * 180 / Math.PI;
    return o;
  }
  if (component === 'unwrapped') {
    const wrapped = new Float64Array(n);
    for (let i = 0; i < n; i++) wrapped[i] = Math.atan2(sweep.imag[i], sweep.real[i]);
    const un = unwrap(wrapped);
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) o[i] = un[i] * 180 / Math.PI;
    return o;
  }
  return phaseResidual(sweep.real, sweep.imag, n).residual;
}

function effectS21(snapshot, prep, p, view) {
  const n = prep.numSteps;
  const known = freqsKnown(snapshot);
  const freqs = snapshotFreqs(snapshot);
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = known ? freqs[i] / 1e9 : i;
  const xAxis = {
    min: xs[0], max: xs[n - 1],
    label: known ? 'Frequency' : 'Step index',
    unit: known ? 'GHz' : '',
    decimals: known ? 2 : 0,
  };

  const comp = S21_COMPONENTS[p.component] || S21_COMPONENTS.mag;
  // Real & imaginary is two traces against one axis; it has no single scalar to
  // colour a waterfall with, so that combination stays a line plot.
  const forcedLine = p.component === 'reim';
  const asWaterfall = p.display === 'waterfall' && !forcedLine;

  // Per-sweep phase residual std: the direct corrupted-sweep detector. A late
  // retune leaves one step holding the previous frequency's IQ, which shows up
  // here long before the range profile explains it.
  const stds = snapshot.sweeps.map(sw => phaseResidual(sw.real, sw.imag, n).std);
  const reported = snapshot.sweeps.map(sw =>
    (sw.phase_coherence && sw.phase_coherence.phase_std_rad != null)
      ? sw.phase_coherence.phase_std_rad : null);
  const bad = stds.map((s, i) => Math.max(s, reported[i] != null ? reported[i] : 0) > COHERENCE_LIMIT_RAD);
  const badCount = bad.filter(Boolean).length;

  const coherenceNote = p.component === 'residual'
    ? (badCount > 0
        ? `${badCount} of ${stds.length} sweeps exceed ${COHERENCE_LIMIT_RAD} rad and are flagged red - likely corrupted sweeps (see the settle_count history in CLAUDE.md).`
        : `All ${stds.length} sweeps are under ${COHERENCE_LIMIT_RAD} rad of phase residual.`)
    : null;

  if (asWaterfall) {
    const rows = snapshot.sweeps.map(sw => s21Component(sw, n, p.component));
    const ext = rowsExtent(rows);
    return {
      kind: 'waterfall',
      rows,
      x: xAxis,
      y: sweepAxis(rows.length),
      v: { min: ext.min, max: ext.max, unit: comp.unit, label: comp.label },
      rowFlags: p.component === 'residual' ? bad : null,
      title: 'RAW S21 vs FREQUENCY',
      subtitle: `${comp.label} · all ${rows.length} sweeps`,
      notes: [
        'Before any IFFT. A target at range R is a sinusoid in frequency of period c/2R.',
        coherenceNote,
      ].filter(Boolean),
    };
  }

  const idx = Math.max(0, Math.min(snapshot.sweeps.length - 1, view.sweepIndex));
  const sweep = snapshot.sweeps[idx];
  let series;
  if (p.component === 'reim') {
    const re = Float64Array.from(sweep.real.slice(0, n));
    const im = Float64Array.from(sweep.imag.slice(0, n));
    series = [
      { label: 'real', color: '#D1855C', y: re },
      { label: 'imag', color: '#6B9BD2', y: im },
    ];
  } else {
    series = [{ label: comp.label, color: '#D1855C', y: s21Component(sweep, n, p.component) }];
  }

  const notes = [
    'Before any IFFT. A target at range R is a sinusoid in frequency of period c/2R.',
    forcedLine && p.display === 'waterfall'
      ? 'Real & imaginary is a two-trace component, so this stays a line plot.'
      : null,
    p.component === 'residual'
      ? `This sweep: sigma = ${stds[idx].toFixed(3)} rad computed here` +
        (reported[idx] != null ? `, ${reported[idx].toFixed(3)} rad reported by the Pi` : '') +
        `. Limit is ${COHERENCE_LIMIT_RAD} rad.`
      : null,
    coherenceNote,
  ].filter(Boolean);

  return {
    kind: 'lines',
    xs,
    series,
    x: xAxis,
    yAxis: { label: comp.label, unit: comp.unit },
    guides: p.component === 'residual'
      ? [{ value: COHERENCE_LIMIT_RAD, color: '#ef4444' }, { value: -COHERENCE_LIMIT_RAD, color: '#ef4444' }]
      : null,
    alert: p.component === 'residual' && bad[idx],
    title: 'RAW S21 vs FREQUENCY',
    subtitle: `${comp.label} · sweep ${idx + 1}/${snapshot.sweeps.length}`,
    notes,
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Render one effect. `prep` is the memoized output of prepare() for the same
 * snapshot and params.profile; pass it in so switching effects does not redo
 * every IFFT.
 */
export function renderEffect(snapshot, effectId, params, prep) {
  const view = params.view;
  const pr = params.profile;
  const meta = EFFECTS.find(e => e.id === effectId) || EFFECTS[0];

  if (meta.multiSweep && prep.numSweeps < 2) {
    return {
      kind: 'message',
      title: meta.label.toUpperCase(),
      message: `${meta.label} needs at least two sweeps; this snapshot has ${prep.numSweeps}.`,
    };
  }

  switch (effectId) {
    case 'none':        return effectNone(prep, params.none, view, pr);
    case 'compression': return effectCompression(prep, params.compression, view, pr);
    case 'percentile':  return effectPercentile(prep, params.percentile, view, pr);
    case 'binnorm':     return effectBinNorm(prep, params.binnorm, view, pr);
    case 'cfar':        return effectCfar(prep, params.cfar, view, pr);
    case 'colormap':    return effectColormap(prep, params.none, view, pr, params.colormap);
    case 'phasehue':    return effectPhaseHue(prep, params.phasehue, view, pr);
    case 'coherence':   return effectCoherence(prep, params.coherence, view, pr);
    case 'integration': return effectIntegration(prep, params.integration, view, pr);
    case 'dispersion':  return effectDispersion(snapshot, prep, params.dispersion, view, pr);
    case 's21':         return effectS21(snapshot, prep, params.s21, view);
    default:            return effectNone(prep, params.none, view, pr);
  }
}
