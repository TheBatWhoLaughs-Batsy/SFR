// Interpolating background model.
//
// The background is a smooth function of standoff, and captures are dense
// (~5 mm) relative to how fast it varies, so the right estimator is
// interpolation over the captured positions — not a network fit to them.
// Measured on the 30-position bench set, leave-one-position-out:
//
//   cubic spline           20.3 dB   best mean, but overshoots on a bad knot
//   Akima                  19.7 dB   worst-case knot 4.0 dB vs cubic's -12.3
//   pchip                  17.5 dB
//   linear interp          12.4 dB
//   Fourier-feature MLP    11.9 dB
//   1-64-64-302 MLP         4.9 dB
//
// Akima is used: it gives up ~0.6 dB of mean for a 16 dB better worst case,
// because it does not propagate a bad capture into its neighbours' intervals.
//
// Standoff is unwound by UNWIND_ALPHA before interpolating and rewound after.
// Alpha < 1 is not a typo: the measured optimum is a broad plateau over
// 0.70-0.85 (20.6 dB at 0.75, 19.1 dB at 1.00). Unwinding removes fast phase
// so the interpolated function is smoother, but it also injects the lidar's
// own error into the target, and 0.8 is where those trade off.

const SPEED_OF_LIGHT = 299792458;

export const UNWIND_ALPHA = 0.80;

// Positions closer than this are the same position; merged so the knot
// sequence stays strictly increasing, which Akima requires.
const MERGE_MM = 0.5;

// Akima slopes for one series. Less overshoot than a natural cubic spline
// because each slope depends only on nearby differences.
function akimaSlopes(x, y) {
  const n = x.length;
  if (n === 2) {
    const s = (y[1] - y[0]) / (x[1] - x[0]);
    return Float64Array.from([s, s]);
  }

  const m = new Float64Array(n + 3); // m[2..n] hold the real differences
  for (let i = 0; i < n - 1; i++) m[i + 2] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
  m[1] = 2 * m[2] - m[3];
  m[0] = 2 * m[1] - m[2];
  m[n + 1] = 2 * m[n] - m[n - 1];
  m[n + 2] = 2 * m[n + 1] - m[n];

  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w1 = Math.abs(m[i + 3] - m[i + 2]);
    const w2 = Math.abs(m[i + 1] - m[i]);
    const den = w1 + w2;
    t[i] = den > 1e-30
      ? (w1 * m[i + 1] + w2 * m[i + 2]) / den
      : 0.5 * (m[i + 1] + m[i + 2]);
  }
  return t;
}

// Cubic Hermite on [x0,x1] from endpoint values and slopes
function hermite(x, x0, x1, y0, y1, t0, t1) {
  const h = x1 - x0;
  const s = (x - x0) / h;
  const s2 = s * s, s3 = s2 * s;
  return y0 * (2 * s3 - 3 * s2 + 1)
       + y1 * (-2 * s3 + 3 * s2)
       + h * t0 * (s3 - 2 * s2 + s)
       + h * t1 * (s3 - s2);
}

function freqGrid(startFreqMhz, stopFreqMhz, numSteps) {
  const a = startFreqMhz * 1e6, b = stopFreqMhz * 1e6;
  const out = new Float64Array(numSteps);
  for (let i = 0; i < numSteps; i++) out[i] = a + (i / (numSteps - 1)) * (b - a);
  return out;
}

// Collapse samples to strictly-increasing knots, averaging coincident positions
function toKnots(samples) {
  const ok = samples
    .filter(s => s && s.h_cal_real && s.h_cal_imag && s.lidar_standoff_mm != null)
    .sort((a, b) => a.lidar_standoff_mm - b.lidar_standoff_mm);
  if (ok.length === 0) return [];

  const knots = [];
  let group = [ok[0]];
  const flush = () => {
    const n = group.length;
    const S = group[0].h_cal_real.length;
    const re = new Float64Array(S), im = new Float64Array(S);
    let d = 0;
    for (const g of group) {
      d += g.lidar_standoff_mm / n;
      for (let i = 0; i < S; i++) {
        re[i] += g.h_cal_real[i] / n;
        im[i] += g.h_cal_imag[i] / n;
      }
    }
    knots.push({ d, re, im, merged: n });
  };
  for (let k = 1; k < ok.length; k++) {
    if (ok[k].lidar_standoff_mm - group[group.length - 1].lidar_standoff_mm < MERGE_MM) {
      group.push(ok[k]);
    } else {
      flush();
      group = [ok[k]];
    }
  }
  flush();
  return knots;
}

// Build the model: unwind each knot, precompute Akima slopes per output so
// inference is a bracket search plus one Hermite evaluation.
export function buildInterpModel(samples, sfcwParams, opts = {}) {
  const alpha = opts.unwindAlpha != null ? opts.unwindAlpha : UNWIND_ALPHA;
  const knots = toKnots(samples);
  if (knots.length < 2) throw new Error('Need at least 2 distinct positions');

  const numSteps = knots[0].re.length;
  for (const k of knots) {
    if (k.re.length !== numSteps) throw new Error('Captures have mismatched numSteps');
  }
  const freqs = freqGrid(sfcwParams.startFreq, sfcwParams.stopFreq, numSteps);

  const n = knots.length;
  const d = new Float64Array(n);
  const uRe = [], uIm = [];
  for (let k = 0; k < n; k++) {
    d[k] = knots[k].d;
    const dm = knots[k].d / 1000;
    const re = new Float64Array(numSteps), im = new Float64Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      // unwind: multiply by exp(+j * 4pi * f * alpha * d / c)
      const ph = 4 * Math.PI * freqs[i] * alpha * dm / SPEED_OF_LIGHT;
      const cp = Math.cos(ph), sp = Math.sin(ph);
      re[i] = knots[k].re[i] * cp - knots[k].im[i] * sp;
      im[i] = knots[k].re[i] * sp + knots[k].im[i] * cp;
    }
    uRe.push(re);
    uIm.push(im);
  }

  // Slopes per frequency bin, per quadrature
  const sRe = [], sIm = [];
  for (let k = 0; k < n; k++) {
    sRe.push(new Float64Array(numSteps));
    sIm.push(new Float64Array(numSteps));
  }
  const col = new Float64Array(n);
  for (let i = 0; i < numSteps; i++) {
    for (let k = 0; k < n; k++) col[k] = uRe[k][i];
    let t = akimaSlopes(d, col);
    for (let k = 0; k < n; k++) sRe[k][i] = t[k];
    for (let k = 0; k < n; k++) col[k] = uIm[k][i];
    t = akimaSlopes(d, col);
    for (let k = 0; k < n; k++) sIm[k][i] = t[k];
  }

  return {
    type: 'interp',
    unwindAlpha: alpha,
    numSteps,
    numPositions: n,
    mergedPositions: knots.reduce((a, k) => a + (k.merged > 1 ? 1 : 0), 0),
    d: Array.from(d),
    uRe: uRe.map(a => Array.from(a)),
    uIm: uIm.map(a => Array.from(a)),
    sRe: sRe.map(a => Array.from(a)),
    sIm: sIm.map(a => Array.from(a)),
    freqs: Array.from(freqs),
    sfcwParams: { startFreq: sfcwParams.startFreq, stopFreq: sfcwParams.stopFreq, numSteps },
  };
}

// Predict the background at a standoff. Clamped to the captured range: an
// Akima cubic extrapolates to nonsense, and the near field gives us no reason
// to trust anything outside where we measured.
export function inferInterpModel(model, distanceMm, numSteps) {
  const { d, uRe, uIm, sRe, sIm, freqs } = model;
  const alpha = model.unwindAlpha;
  const n = d.length;
  const S = numSteps != null ? numSteps : model.numSteps;

  const x = Math.min(Math.max(distanceMm, d[0]), d[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= x) lo = mid; else hi = mid;
  }

  const bgReal = new Array(S), bgImag = new Array(S);
  const dm = distanceMm / 1000;
  const aRe = uRe[lo], bRe = uRe[hi], aIm = uIm[lo], bIm = uIm[hi];
  const taRe = sRe[lo], tbRe = sRe[hi], taIm = sIm[lo], tbIm = sIm[hi];
  for (let i = 0; i < S; i++) {
    const rr = hermite(x, d[lo], d[hi], aRe[i], bRe[i], taRe[i], tbRe[i]);
    const ri = hermite(x, d[lo], d[hi], aIm[i], bIm[i], taIm[i], tbIm[i]);
    // rewind: multiply by exp(-j * 4pi * f * alpha * d / c)
    const ph = 4 * Math.PI * freqs[i] * alpha * dm / SPEED_OF_LIGHT;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    bgReal[i] = rr * cp + ri * sp;
    bgImag[i] = -rr * sp + ri * cp;
  }
  return { bgReal, bgImag };
}

// Leave-one-position-out self-evaluation: rebuild without each position and
// score how well it predicts that position's measured spectrum, as suppression
// in dB. This is the number to trust — not a training loss.
export function evaluateLoo(samples, sfcwParams, opts = {}) {
  const knots = toKnots(samples);
  const n = knots.length;
  const asSamples = knots.map(k => ({
    h_cal_real: Array.from(k.re),
    h_cal_imag: Array.from(k.im),
    lidar_standoff_mm: k.d,
  }));

  const per = [];
  for (let i = 0; i < n; i++) {
    const tr = asSamples.filter((_, j) => j !== i);
    let suppDb = null;
    if (tr.length >= 2) {
      const m = buildInterpModel(tr, sfcwParams, opts);
      const { bgReal, bgImag } = inferInterpModel(m, asSamples[i].lidar_standoff_mm, m.numSteps);
      let sig = 0, err = 0;
      for (let k = 0; k < m.numSteps; k++) {
        const re = asSamples[i].h_cal_real[k], im = asSamples[i].h_cal_imag[k];
        sig += re * re + im * im;
        const dr = re - bgReal[k], di = im - bgImag[k];
        err += dr * dr + di * di;
      }
      suppDb = 10 * Math.log10(sig / (err || 1e-30));
    }
    per.push({ d: asSamples[i].lidar_standoff_mm, suppDb });
  }

  const vals = per.map(p => p.suppDb).filter(v => v != null).sort((a, b) => a - b);
  return {
    per,
    meanSuppDb: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    medianSuppDb: vals.length ? vals[Math.floor(vals.length / 2)] : null,
    worstSuppDb: vals.length ? vals[0] : null,
  };
}
