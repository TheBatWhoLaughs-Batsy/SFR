// B-scan background subtraction — groundstation-side, mirroring the SFCW panel.
//
// Two mutually exclusive sources, never both:
//   - captured reference: one sweep, subtracted exactly as captured. It is only
//     valid near the standoff AND the position it was taken at; nothing here
//     tries to extrapolate it to either, because the attempt to do so made it
//     worse (see bgForStandoff).
//   - ML model: the background is inferred per position from that position's
//     own standoff, so it stays valid across the whole captured span.
//   - Super Fit: a previously captured grid of the SAME wall, cell for cell.
//     Each cell is subtracted from the cell at its own (grid_ix, grid_iy), so
//     the background is matched in position rather than only in standoff. This
//     is the only source that can cancel a wall whose standoff varies across the
//     grid -- the 2026-08-30 rover diagnosis measured a 17 mm standoff span over
//     one 700x150 mm grid, and a single captured reference is worth only 14-18
//     dB against that because it is right for one position and wrong for the
//     rest.
//
// Every position is tagged with a bg_status saying what actually happened. A
// cell whose background could not be resolved must never be drawn as if it had
// been subtracted -- see BG_STATUS in cscanGrid.js.
//
// The Pi ships raw h_cal and holds no background state; everything here runs
// on the groundstation so B-scan exports, SAR and BG-model training data all
// keep reading the unmodified wire values.

import { inferBgModel } from './bgModelInfer';
import { computeRangeAmplitude, ampToDb } from './rangeProfile';
import { windowFn } from './imagingEffects';
import { BG_STATUS } from './cscanGrid';

// Background spectrum to subtract at one position.
//
// Returns { bgReal, bgImag, status } when a background was produced, or
// { status } naming why it could not be. Sources are mutually exclusive and are
// tried in the order Super Fit -> model -> captured reference, matching the
// panel, which clears the others whenever one is selected.
export function backgroundFor({ bgRef, bgModel, superFit }, pos, numSteps) {
  if (superFit) {
    const cell = superFitCell(superFit, pos);
    if (!cell) return { status: BG_STATUS.NO_SUPERFIT_CELL };
    if (cell.re.length !== numSteps) return { status: BG_STATUS.SIZE_MISMATCH };
    return { bgReal: cell.re, bgImag: cell.im, status: BG_STATUS.OK };
  }

  if (bgModel) {
    if (bgModel.sfcwParams && bgModel.sfcwParams.numSteps !== numSteps) {
      return { status: BG_STATUS.SIZE_MISMATCH };
    }
    const standoffMm = pos.lidar_standoff_mm;
    if (standoffMm == null) return { status: BG_STATUS.NO_STANDOFF };
    const bg = inferBgModel(bgModel, standoffMm, numSteps);
    // inferInterpModel CLAMPS to the nearest captured knot and returns a
    // confident-looking spectrum, with nothing on the wire to say it did. The
    // 2026-08-28 measurements put the cost at 19 dB just 5 mm outside the span
    // and NEGATIVE suppression past 10 mm -- the subtraction then adds more
    // energy than it removes. Detect it here so the cell can be flagged.
    const span = modelSpan(bgModel);
    const clamped = span != null && (standoffMm < span.min || standoffMm > span.max);
    return { ...bg, status: clamped ? BG_STATUS.CLAMPED : BG_STATUS.OK };
  }

  if (bgRef && bgRef.h_cal_real && bgRef.h_cal_imag) {
    if (bgRef.h_cal_real.length !== numSteps) return { status: BG_STATUS.SIZE_MISMATCH };
    // Subtracted exactly as captured. There used to be a lidar-driven phase
    // ramp here that shifted the reference in range to "correct" for each
    // cell's standoff; it is gone deliberately and must not come back without
    // a bench measurement first. Two reasons (both measured on `row4`, an
    // empty-wall 15x4 C-scan, 2026-08-30 -- see CLAUDE.md):
    //
    //   1. Its sign was inverted. An echo at distance d is exp(-j*2pi*2d*f/c),
    //      so pushing the background OUT by deltaD needs exp(-j...); the code
    //      applied exp(+j...) and pulled it IN, turning a deltaD error into
    //      2*deltaD. Verified: a synthetic echo at 100 mm given deltaD=+10 mm
    //      landed at 90 mm instead of 110 mm.
    //   2. Even with the sign right it loses. Mean suppression over row4's 60
    //      cells: 4.4 dB as shipped, 6.4 dB sign-corrected, 10.9 dB with no
    //      alignment at all. The dominant background term sits at alpha ~ 0 (a
    //      static coupling reflection that does not move with standoff), so
    //      shifting the WHOLE spectrum corrupts the largest component to fix a
    //      smaller one -- in either direction.
    //
    // The shipped version drove the mismatched rows to NEGATIVE suppression,
    // i.e. the subtraction added more energy than it removed, manufacturing
    // detections on a wall with nothing in it. Super Fit is the supported way
    // to handle a background that varies across the grid.
    return { bgReal: bgRef.h_cal_real, bgImag: bgRef.h_cal_imag, status: BG_STATUS.OK };
  }

  return { status: BG_STATUS.NO_REF };
}

export function modelSpan(bgModel) {
  if (!bgModel || !Array.isArray(bgModel.d) || bgModel.d.length < 2) return null;
  return { min: bgModel.d[0], max: bgModel.d[bgModel.d.length - 1] };
}

// Super Fit is keyed by grid cell, so a position has to say which cell it is.
// A record imported from a linear v4 scan carries no indices and cannot be
// matched -- that is a genuine miss, not something to paper over with the
// capture order, because the capture order of the reference grid and of the new
// scan need not agree (manual snakes up, the rover snakes down).
export function superFitCell(superFit, pos) {
  if (pos.grid_ix == null || pos.grid_iy == null) return null;
  return superFit.cells[`${pos.grid_ix},${pos.grid_iy}`] || null;
}

// Back-compat shim for callers that only have a standoff (the BG-model preview
// in App.jsx). Super Fit is per cell and has no meaning without one.
export function bgForStandoff(sources, standoffMm, numSteps) {
  const r = backgroundFor(sources, { lidar_standoff_mm: standoffMm }, numSteps);
  return r.bgReal ? { bgReal: r.bgReal, bgImag: r.bgImag } : null;
}

export function freqGrid(startFreqMhz, stopFreqMhz, numSteps) {
  const startHz = startFreqMhz * 1e6;
  const stopHz = stopFreqMhz * 1e6;
  const freqs = new Array(numSteps);
  for (let i = 0; i < numSteps; i++) {
    freqs[i] = startHz + (i / (numSteps - 1)) * (stopHz - startHz);
  }
  return freqs;
}

// Per-cell sweeps. A cell captured with Avg > 1 holds every sweep it took, not
// just the average -- so the coherent/incoherent choice stays live after the
// scan and can be flipped against recorded data. Older records (and v6 imports)
// carry only the one spectrum, which is the same thing with N = 1.
//
// A cell captured with the panel's raw-sweep retention off also has none, and
// is handled by the same fallback: h_cal is already the coherent mean of the
// looks that were dropped, so the coherent path is exact and only incoherent
// averaging is unavailable. Use cellLookCount() to tell the two apart -- the
// number of looks survives on `sweep_count` even when the looks do not.
export function cellSweeps(pos) {
  if (Array.isArray(pos.sweeps) && pos.sweeps.length > 0) return pos.sweeps;
  return [{ h_cal_real: pos.h_cal_real, h_cal_imag: pos.h_cal_imag }];
}

// How many looks went into this cell, whether or not they are still stored.
export function cellLookCount(pos) {
  if (Array.isArray(pos.sweeps) && pos.sweeps.length > 0) return pos.sweeps.length;
  if (pos.sweep_count > 0) return pos.sweep_count;
  return 1;
}

// Does this cell still carry the individual looks? Incoherent averaging needs
// them; everything else in the pipeline reads the coherent mean.
export function cellHasLooks(pos) {
  return Array.isArray(pos.sweeps) && pos.sweeps.length > 1;
}

// Coherent mean of the complex spectra. This is what h_cal on the record means
// for a multi-sweep cell, and it is what SAR and the BG-model trainer read --
// both are inherently coherent, so neither has an incoherent variant to pick.
export function coherentMean(sweeps, numSteps) {
  if (sweeps.length === 1) return { re: sweeps[0].h_cal_real, im: sweeps[0].h_cal_imag };
  const re = new Array(numSteps).fill(0);
  const im = new Array(numSteps).fill(0);
  for (const s of sweeps) {
    for (let i = 0; i < numSteps; i++) { re[i] += s.h_cal_real[i]; im[i] += s.h_cal_imag[i]; }
  }
  for (let i = 0; i < numSteps; i++) { re[i] /= sweeps.length; im[i] /= sweeps.length; }
  return { re, im };
}

// Subtract the selected background from every position and recompute range
// profiles. Returns the input untouched when no background is selected.
//
// opts:
//   mode        'complex' (default) | 'magnitude'  -- see below
//   windowType  'rectangular' (default) | 'hanning' | 'kaiser'
//   kaiserBeta  beta for the kaiser window
//   avgMode     'coherent' (default) | 'incoherent' -- how a multi-sweep cell
//               is combined. Both cut the visible wobble by sqrt(N), but only
//               coherent removes the noise's contribution to the MEAN;
//               incoherent converges to |signal + noise|, which in a deep null
//               is dominated by the noise and can never say whether anything is
//               there. The two are indistinguishable more than ~10 dB above the
//               floor, so the difference is entirely a null-depth question.
//
// Subtraction mode:
//   'complex'   vector difference of h_cal, then one IFFT. This is what removes
//               the wall/coupling return so a target 16.6 dB beneath it is not
//               buried. Sensitive to standoff error: 1 mm is 12 degrees at 5 GHz.
//   'magnitude' transform BOTH spectra and difference the dB profiles. This is
//               the DETECTION statistic -- the 2026-08-28 A/B found the target
//               as +4.4 dB at 21.2 cm against a 0.23 dB target-free control,
//               and it survives ~1 mm of standoff error because a sub-mm shift
//               is a small fraction of a 9.76 mm range bin.
//
// Neither is a better version of the other: complex is for seeing, magnitude is
// for deciding. In magnitude mode h_cal_real/imag are left at the coherent mean,
// because a dB difference cannot be expressed as a modified h_cal -- so SAR,
// which reads h_cal, must stay on complex.
//
// ORDER OF OPERATIONS matters and is deliberate: the background is subtracted
// from EACH SWEEP, before averaging, not from the average. For coherent
// averaging the two are identical (both are linear), but for incoherent they
// are not -- averaging |signal| first and subtracting a complex background
// afterwards is not a defined operation, whereas subtracting per sweep and then
// averaging the resulting magnitudes is exactly "N independent looks at the
// residual".
// Per-CELL memo of the result above, keyed on the record's own identity.
//
// This is a pure per-cell map with no cross-cell dependency, which is what makes
// it memoisable at all. It matters because of the continuous raster's live
// flush: that rewrites bscanData at 4 Hz while a row is being driven, and every
// cell of every COMPLETED row is byte-for-byte the record it was last time --
// yet the whole grid was re-subtracted and re-transformed from scratch on each
// flush. Measured on a 101x15 grid at 8 looks/cell, this function alone was
// 13.5 ms per call and is called two to three times per flush (the complex
// result, the SAR one, and the magnitude one when that mode is on); incoherent
// averaging takes it to 83 ms, because it runs one IFFT PER LOOK.
//
// A WeakMap so a record dropped by New Scan, an import, or a row being re-driven
// takes its cache with it. Several entries per record because the callers ask
// different questions of the same cell and a single slot would thrash between
// them: processedBscanData (complex, this panel's background), the magnitude
// result when that mode is on, and sarProcessedData (complex, SAR's own
// background toggle and no window). Three, because those are exactly the live
// callers -- a fourth slot would only ever hold an entry left behind by a
// settings change, which is cheaper to recompute than to keep.
//
// It is NOT free: measured on a 1515-cell grid, each retained option set costs
// ~4 MB, so the cache holds up to ~12 MB where the two memo results it partly
// replaces already held ~7 MB. That is the trade -- ~5 MB against 4-8x less
// work per flush -- and it is bounded, which unbounded per-cell memoisation
// would not be.
//
// SAFETY: the cached object is SHARED between calls, so nothing downstream may
// mutate a processed record. Checked across the whole frontend -- the displays
// and cscanGrid read only, svdFilter spreads into new objects, and the SAR
// worker is handed a projection. Keep it that way.
const CELL_CACHE = new WeakMap();
const CELL_CACHE_MAX = 3;

export function applyBscanBg(bscanData, opts, sfcwParams) {
  if (bscanData.length === 0) return bscanData;
  const { enabled, bgRef, bgModel, superFit, mode } = opts;
  const sources = { bgRef, bgModel, superFit };
  const active = enabled && (bgModel || bgRef || superFit);
  const magnitudeMode = mode === 'magnitude';
  const incoherent = opts.avgMode === 'incoherent';
  const makeWin = windowFn(opts.windowType || 'rectangular', opts.kaiserBeta != null ? opts.kaiserBeta : 3);

  // Everything that changes the answer and is not the record itself. The three
  // background sources are compared by IDENTITY rather than folded into this
  // string: they are objects, they are replaced wholesale whenever they change
  // (capture, load, clear), and hashing their contents every call would cost
  // more than the work being avoided.
  const key = `${!!active}|${mode || 'complex'}|${incoherent}|${opts.windowType || 'rectangular'}`
    + `|${opts.kaiserBeta != null ? opts.kaiserBeta : 3}|${sfcwParams.startFreq}|${sfcwParams.stopFreq}`;

  return bscanData.map((pos) => {
    if (!pos.h_cal_real || !pos.h_cal_imag) return pos;

    let slots = CELL_CACHE.get(pos);
    if (slots) {
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.key === key && s.bgRef === bgRef && s.bgModel === bgModel && s.superFit === superFit) {
          // Most-recently-used to the front, so the slot evicted at the cap is
          // the one no caller has asked for in the longest time.
          if (i > 0) { slots.splice(i, 1); slots.unshift(s); }
          return s.out;
        }
      }
    } else {
      slots = [];
      CELL_CACHE.set(pos, slots);
    }
    const out = computeCell(pos);
    slots.unshift({ key, bgRef, bgModel, superFit, out });
    if (slots.length > CELL_CACHE_MAX) slots.length = CELL_CACHE_MAX;
    return out;
  });

  function computeCell(pos) {
    const numSteps = pos.h_cal_real.length;
    const freqs = freqGrid(sfcwParams.startFreq, sfcwParams.stopFreq, numSteps);
    const win = makeWin(numSteps);
    const sweeps = cellSweeps(pos);
    const mean = coherentMean(sweeps, numSteps);
    const prof = (re, im) => computeRangeAmplitude(re, im, numSteps, pos.step_size, pos.range_offset, win);

    // Mean of the LINEAR amplitude profiles of each sweep. Averaging dB instead
    // would be a geometric mean, which is not what incoherent integration is.
    const incoherentAmp = (offRe, offIm) => {
      let acc = null;
      let dists = null;
      for (const s of sweeps) {
        let re = s.h_cal_real, im = s.h_cal_imag;
        if (offRe) {
          re = new Array(numSteps); im = new Array(numSteps);
          for (let i = 0; i < numSteps; i++) {
            re[i] = s.h_cal_real[i] - offRe[i];
            im[i] = s.h_cal_imag[i] - offIm[i];
          }
        }
        const r = prof(re, im);
        if (acc === null) { acc = r.amplitudes.slice(); dists = r.distances; }
        else for (let i = 0; i < acc.length; i++) acc[i] += r.amplitudes[i];
      }
      for (let i = 0; i < acc.length; i++) acc[i] /= sweeps.length;
      return { amplitudes: acc, distances: dists };
    };

    const base = {
      ...pos, freqs,
      // What was TAKEN, not what is still stored -- a cell whose raw looks were
      // freed is still an N-look coherent mean and must not read as N = 1.
      num_sweeps: cellLookCount(pos),
      // What is still being DONE with them. A freed cell cannot be averaged
      // incoherently whatever the toggle says, so it reports 'coherent'.
      avg_mode: sweeps.length > 1 ? (incoherent ? 'incoherent' : 'coherent')
        : (cellLookCount(pos) > 1 ? 'coherent' : null),
    };

    if (!active) {
      const r = (incoherent && sweeps.length > 1) ? incoherentAmp(null, null) : prof(mean.re, mean.im);
      return {
        ...base, magnitudes: ampToDb(r.amplitudes), distances: r.distances,
        h_cal_real: mean.re, h_cal_imag: mean.im,
        bg_status: BG_STATUS.OFF, bg_sub_mode: null,
      };
    }

    const bg = backgroundFor(sources, pos, numSteps);
    if (!bg.bgReal) {
      // No background for this cell. The raw spectrum is kept so the record is
      // not destroyed, but the status marks it invalid and every scale and
      // every colour downstream excludes it -- an un-subtracted cell sitting in
      // a subtracted grid reads as a target and sets the colour limits.
      const r = (incoherent && sweeps.length > 1) ? incoherentAmp(null, null) : prof(mean.re, mean.im);
      return {
        ...base, magnitudes: ampToDb(r.amplitudes), distances: r.distances,
        h_cal_real: mean.re, h_cal_imag: mean.im,
        bg_status: bg.status, bg_sub_mode: mode || 'complex',
      };
    }

    if (magnitudeMode) {
      const sig = (incoherent && sweeps.length > 1) ? incoherentAmp(null, null) : prof(mean.re, mean.im);
      const ref = prof(bg.bgReal, bg.bgImag);
      const sigDb = ampToDb(sig.amplitudes);
      const refDb = ampToDb(ref.amplitudes);
      const n = Math.min(sigDb.length, refDb.length);
      const diff = new Array(n);
      for (let i = 0; i < n; i++) diff[i] = sigDb[i] - refDb[i];
      return {
        ...base,
        magnitudes: diff,
        distances: sig.distances.slice(0, n),
        // h_cal stays the coherent mean: the difference is not a spectrum.
        h_cal_real: mean.re, h_cal_imag: mean.im,
        bg_magnitudes: refDb,
        bg_status: bg.status, bg_sub_mode: 'magnitude',
      };
    }

    const real = new Array(numSteps);
    const imag = new Array(numSteps);
    for (let i = 0; i < numSteps; i++) {
      real[i] = mean.re[i] - bg.bgReal[i];
      imag[i] = mean.im[i] - bg.bgImag[i];
    }
    const r = (incoherent && sweeps.length > 1)
      ? incoherentAmp(bg.bgReal, bg.bgImag)
      : prof(real, imag);
    return {
      ...base, magnitudes: ampToDb(r.amplitudes), distances: r.distances,
      h_cal_real: real, h_cal_imag: imag,
      bg_status: bg.status, bg_sub_mode: 'complex',
    };
  }
}
