// Suggests a wall permittivity from the back-wall echo, for the SAR panel.
//
// The physics is one line: the back face sits sqrt(er) * thickness of apparent range
// behind the front face, so er = (separation / thickness)^2. The separation is a
// DIFFERENCE of two ranges, which is what makes this immune to the range offset and
// to the LiDAR offset -- both shift the two echoes equally. Only the operator-measured
// wall thickness has to be right.
//
// What is averaged: the coherent mean of every cell's RAW h_cal, never the
// background-subtracted spectrum. A background model is built to remove exactly the
// wall echoes this needs. The coherent mean keeps laterally uniform echoes (front
// face, back face) and suppresses anything that changes along the scan, so a target
// cannot pose as the back wall. Hanning, because rectangular sidelobes of the front
// face (-13 dB) land right where a weak back-wall echo sits.
//
// Why it SUGGESTS rather than sets, and why every candidate is returned. Measured on
// the gw2 bench's rod1.json (2026-09-13): the averaged profile holds three echoes that
// would each imply a back wall -- er ~2.4 (the strongest, -6 dB), ~5.5 (-14 dB) and
// ~9.6 (-17 dB). Ground truth (a rod immediately behind the 15 cm wall) picks 5.5: at
// 2.4 the rod would focus ~15 cm behind the wall. The -6 dB echo is present in the gw2
// model at every standoff and repeats at an even spacing, i.e. it belongs to the rig,
// not the wall, and nothing in a single scan can tell the two apart. So the strongest
// echo is NOT a safe answer. The highlighted suggestion is the strongest candidate
// inside the dry masonry / concrete range; the rest stay one click away.

import { computeComplexRangeProfile } from './rangeProfile';
import { windowFn } from './imagingEffects';

// Dry brick 3.5-5, dry concrete 4.5-8 at 2-5 GHz. Wide on purpose -- it only has to
// exclude what cannot be masonry (air-like rig echoes, the far multiple).
export const ER_PLAUSIBLE_MIN = 3;
export const ER_PLAUSIBLE_MAX = 10;
const ER_SEARCH_MIN = 1.5;
const ER_SEARCH_MAX = 16;
// An echo more than this far below the front face is not reported at all.
const ECHO_FLOOR_DB = -30;

function localPeaks(amp, dist) {
  const out = [];
  const step = dist.length > 1 ? dist[1] - dist[0] : 0;
  for (let i = 1; i < amp.length - 1; i++) {
    const a = amp[i];
    if (!(a > 0) || a < amp[i - 1] || a <= amp[i + 1]) continue;
    // Parabolic interpolation on log amplitude: the zero-padded bin is ~1 cm, and a
    // 1 cm error in the separation is ~0.7 of er at 15 cm of wall.
    let off = 0;
    if (amp[i - 1] > 0 && amp[i + 1] > 0) {
      const l = Math.log(amp[i - 1]);
      const c = Math.log(a);
      const r = Math.log(amp[i + 1]);
      const den = l - 2 * c + r;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
    }
    out.push({ rangeM: dist[i] + off * step, amp: a });
  }
  return out;
}

/**
 * @param scanData  C-scan records carrying raw h_cal_real/h_cal_imag and step_size
 * @param wallThicknessCm  operator-measured wall thickness
 * @returns {{status: 'ok'|'implausible'|'no_candidate'|'no_echo'|'no_data'|'no_thickness',
 *            best?: object, candidates?: object[], numCells?: number, wallThicknessCm?: number}}
 *   Each candidate: { epsilonR, separationM, relDb, plausible }, sorted strongest first.
 */
export function estimateWallPermittivity(scanData, wallThicknessCm) {
  if (!(wallThicknessCm > 0)) return { status: 'no_thickness' };
  const cells = (scanData || []).filter((p) => p && p.h_cal_real && p.h_cal_imag);
  if (cells.length === 0) return { status: 'no_data' };
  const numSteps = cells[0].h_cal_real.length;
  const stepSize = cells[0].step_size;
  if (numSteps < 8 || !(stepSize > 0)) return { status: 'no_data' };

  const re = new Array(numSteps).fill(0);
  const im = new Array(numSteps).fill(0);
  let n = 0;
  for (const c of cells) {
    if (c.h_cal_real.length !== numSteps || c.step_size !== stepSize) continue;
    for (let k = 0; k < numSteps; k++) {
      re[k] += c.h_cal_real[k];
      im[k] += c.h_cal_imag[k];
    }
    n++;
  }
  for (let k = 0; k < numSteps; k++) {
    re[k] /= n;
    im[k] /= n;
  }

  // Range offset 0: only separations are used, and a non-zero offset would discard
  // the bins before it -- which is where the front face sits under a wrong offset.
  const win = windowFn('hanning')(numSteps);
  const prof = computeComplexRangeProfile(re, im, numSteps, stepSize, 0, win);
  const amp = prof.re.map((r, i) => Math.hypot(r, prof.im[i]));
  const peaks = localPeaks(amp, prof.distances);
  if (peaks.length === 0) return { status: 'no_echo', numCells: n, wallThicknessCm };

  const face = peaks.reduce((a, b) => (b.amp > a.amp ? b : a));
  const T = wallThicknessCm / 100;
  const candidates = [];
  for (const pk of peaks) {
    const sep = pk.rangeM - face.rangeM;
    if (sep <= 0) continue;
    const er = (sep / T) ** 2;
    const relDb = 20 * Math.log10(pk.amp / face.amp);
    if (er < ER_SEARCH_MIN || er > ER_SEARCH_MAX || relDb < ECHO_FLOOR_DB) continue;
    candidates.push({
      epsilonR: er,
      separationM: sep,
      relDb,
      plausible: er >= ER_PLAUSIBLE_MIN && er <= ER_PLAUSIBLE_MAX,
    });
  }
  candidates.sort((a, b) => b.relDb - a.relDb);
  const best = candidates.find((c) => c.plausible) || null;
  return {
    status: best ? 'ok' : candidates.length ? 'implausible' : 'no_candidate',
    best,
    candidates,
    numCells: n,
    wallThicknessCm,
  };
}
