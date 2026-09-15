// SAR detections drawn onto the C-scan plan view (and so onto the projector window).
//
// CONFIRMED pipes always; PROBABLE pipes only when the operator asks for them
// (`includeProbable`). Every segment carries its rating so the display can colour the two
// apart. Ratings are the ones the SAR panel shows (effectiveRating, so a target inside the end
// zones reads as unresolved while Handle ends is on, and is not drawn). A probable that is a
// confirmed target's sidelobe was already rated 'none' by the detector. Seepage patches are
// deliberately left out for now.
//
// A pipe is drawn only over rows the detection actually used, and in each of those rows only
// if the grid cell under the line was captured. Nothing is extended over rows that have not
// been scanned yet.
//
// COORDINATES. Detection positions are antenna positions: x = grid_ix * hStep and a row's
// y = grid_iy * vStep. The plan view draws cell ix over [ix, ix+1] * hStep, so an antenna
// position is the CENTRE of its cell -- half a cell must be added in both axes or every pipe
// lands half a cell left and half a cell low. `cellUnits*` below do that conversion.

import { effectiveRating } from './sarDetect';
import { TILT_MIN_CHANGE_CM } from './wallTwin';

// Detection x (cm) -> plan-view column units (cell ix spans [ix, ix+1]).
export function cellUnitsX(xCm, hStep) {
  return xCm / hStep + 0.5;
}

/**
 * @param detection  result of lib/sarDetect.js finishDetection (pipe mode), or null
 * @param params     grid params ({ hStep, vStep } in cm)
 * @param handleEnds the SAR panel's Handle ends toggle
 * @param capturedAt (ix, iy) => boolean, whether that grid cell holds a capture
 * @param options    { includeProbable }
 * @returns {{ segments, confirmed, probable, hiddenAtEnds, rowsUsed, usable, reason }}
 *   segments: one per (pipe, row): { rating, targetX, iy, xLowCm, xHighCm, widthCm }, where
 *   xLowCm / xHighCm are the line's position at the row's lower and upper cell edges.
 *   `probable` counts probable targets whether or not they are included.
 */
export function pipeOverlay(detection, params, handleEnds, capturedAt, options = {}) {
  const empty = (reason) => ({ segments: [], confirmed: 0, probable: 0, hiddenAtEnds: 0, rowsUsed: [], usable: false, reason });
  if (!detection) return empty('none');
  if (detection.mode === 'seepage') return empty('seepage');
  const hStep = params && params.hStep;
  const vStep = params && params.vStep;
  if (!(hStep > 0) || !(vStep > 0)) return empty('geometry');
  // A result computed for a different pitch would be drawn in the wrong places. It is
  // replaced by the next run, which the parameter change already triggers.
  if (Math.abs(detection.hStep - hStep) > 1e-9 || Math.abs(detection.vStep - vStep) > 1e-9) {
    return empty('geometry');
  }
  const includeProbable = !!options.includeProbable;
  const rowsUsed = Array.isArray(detection.rowIys) ? detection.rowIys : [];
  const yc = Number.isFinite(detection.yMid) ? detection.yMid : 0;
  const segments = [];
  let confirmed = 0, probable = 0, hiddenAtEnds = 0;
  for (const t of detection.targets || []) {
    const rating = effectiveRating(t, handleEnds);
    if (rating === 'unresolved') {
      if (t.rating === 'confirmed' || (includeProbable && t.rating === 'probable')) hiddenAtEnds++;
      continue;
    }
    if (rating === 'confirmed') confirmed++;
    else if (rating === 'probable') probable++;
    else continue;
    if (rating === 'probable' && !includeProbable) continue;
    // Drift below the lateral resolution is not a measurable lean (the bench's straight pipes
    // drift 1-2 cm over a short scan), so it is drawn vertical -- the same rule the 3D view uses.
    const rawSlope = Number.isFinite(t.slope) ? t.slope : 0;
    const drift = Number.isFinite(t.driftCm) ? t.driftCm : 0;
    const s = Math.abs(drift) > TILT_MIN_CHANGE_CM ? rawSlope : 0;
    // The measured -6 dB width, never narrower than one column so a pipe stays visible.
    const widthCm = Math.max(Number.isFinite(t.widthCm) ? t.widthCm : 0, hStep);
    for (const iy of rowsUsed) {
      const xc = t.x + s * (iy * vStep - yc);
      const ix = Math.round(xc / hStep);
      if (capturedAt && !capturedAt(ix, iy)) continue;
      segments.push({ rating, targetX: t.x, iy, xLowCm: xc - (s * vStep) / 2, xHighCm: xc + (s * vStep) / 2, widthCm });
    }
  }
  return { segments, confirmed, probable, hiddenAtEnds, rowsUsed, usable: true, reason: null };
}
