// Digital twin of the scanned wall: a to-scale cuboid plus a cylinder per detected pipe.
// Pure -- takes the detection result (lib/sarDetect.js) and the grid geometry, returns
// plain numbers in centimetres. The 3D view (components/SarWall3D.jsx) only draws this.
//
// Frame: x = lateral position along the scan (cm, the SAR axis), y = height (cm, grid
// row 0 at the bottom), depth = distance into the wall from the FRONT face (cm). A pipe
// detected behind the back face has depth > thickness and is drawn behind the cuboid.
//
// Pipes need not be vertical. Each confirmed target carries its peak position in every
// row that saw it (perRow); x(y) and depth(y) are fitted independently by weighted
// least squares, weight = linear power of that row's peak. A slope is only KEPT when the
// change it predicts across the scanned height is (a) larger than the imaging resolution
// and (b) at least three standard errors of the slope. (a) is the one that matters on
// short scans: on the 6-row, 5 cm-tall bench scans of STRAIGHT vertical pipes, per-row
// peaks drift 1.4-1.9 cm across the height (half-pixel quantisation plus the +-0.5-1 cm
// offset between rows driven in opposite directions), which a residual-only test kept
// as 11-18 degree leans. With a 3.2 cm floor those scans render vertical, and any lean
// under ~atan(3.2 / height) is reported as unmeasurable rather than invented.
// Fewer than two rows seeing it -> vertical at the consensus position.

import { effectiveRating } from './sarDetect';

// ~ lateral resolution of the detection chain: 1.5 (Hanning) x c / (4 f_centre) at 3.5 GHz.
export const TILT_MIN_CHANGE_CM = 3.2;

function weightedLine(pts, key) {
  // returns { a, b, rms } for key = a + b * (y - yMean)
  let sw = 0, sy = 0, sv = 0;
  for (const p of pts) { sw += p.w; sy += p.w * p.y; sv += p.w * p[key]; }
  const ym = sy / sw, vm = sv / sw;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += p.w * (p.y - ym) * (p[key] - vm); sxx += p.w * (p.y - ym) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  let r2 = 0;
  for (const p of pts) r2 += p.w * (p[key] - (vm + b * (p.y - ym))) ** 2;
  const rms = Math.sqrt(r2 / sw);
  // standard error of the slope, with the weights normalised to the point count
  const n = pts.length;
  const sxxN = sxx * (n / sw);
  const seB = n > 2 && sxxN > 0 ? Math.sqrt((r2 / sw) * n / (n - 2) / sxxN) : Infinity;
  return { a: vm, b, ym, rms, seB };
}

/**
 * @param detection  result of runDetection (targets, xMin, xMax, hStep, rowIys, wallThicknessCm)
 * @param geom       { vStep (cm between rows), wallThicknessCm (fallback), handleEnds, includeProbable }
 */
export function buildWallTwin(detection, geom = {}) {
  if (!detection) return null;
  const hStep = detection.hStep > 0 ? detection.hStep : 0.5;
  const vStep = geom.vStep > 0 ? geom.vStep : 1;
  const thickness = detection.wallThicknessCm > 0 ? detection.wallThicknessCm : (geom.wallThicknessCm || 15);
  const iys = (detection.rowIys && detection.rowIys.length) ? detection.rowIys : [0];
  const minIy = Math.min(...iys), maxIy = Math.max(...iys);
  const rowY = (iy) => iy * vStep;
  const wall = {
    x0: detection.xMin - hStep / 2,
    x1: detection.xMax + hStep / 2,
    y0: rowY(minIy) - vStep / 2,
    y1: rowY(maxIy) + vStep / 2,
    thickness,
  };
  const span = wall.y1 - wall.y0;
  const wanted = geom.includeProbable ? ['confirmed', 'probable'] : ['confirmed'];

  const pipes = [];
  for (const t of detection.targets || []) {
    const rating = effectiveRating(t, geom.handleEnds !== false);
    if (!wanted.includes(rating)) continue;
    const pts = (t.perRow || [])
      .filter((r) => r.seen && Number.isFinite(r.x) && Number.isFinite(r.depth))
      .map((r) => ({ y: rowY(r.iy), x: r.x, depth: r.depth, w: Math.pow(10, (Number.isFinite(r.db) ? r.db : 0) / 10) }));
    const distinctY = new Set(pts.map((p) => p.y)).size;

    let fx = { a: t.x, b: 0, ym: (wall.y0 + wall.y1) / 2, rms: 0 };
    let fz = { a: t.depth, b: 0, ym: fx.ym, rms: 0 };
    let tiltKept = false, depthTiltKept = false;
    if (distinctY >= 2) {
      fx = weightedLine(pts, 'x');
      fz = weightedLine(pts, 'depth');
      const dx = Math.abs(fx.b * span), dz = Math.abs(fz.b * span);
      tiltKept = dx > TILT_MIN_CHANGE_CM && Math.abs(fx.b) > 3 * fx.seB;
      depthTiltKept = dz > TILT_MIN_CHANGE_CM && Math.abs(fz.b) > 3 * fz.seB;
      if (!tiltKept) fx = { ...fx, b: 0 };
      if (!depthTiltKept) fz = { ...fz, b: 0 };
    }
    const xAt = (y) => fx.a + fx.b * (y - fx.ym);
    const zAt = (y) => fz.a + fz.b * (y - fz.ym);

    // Diameter: the resolution-deconvolved estimate, bounded by what the image actually
    // shows. Floored at 1.5 cm so a thin rod is still visible; it is APPROXIMATE -- the
    // ~3.2 cm imaging resolution limits what can be said about anything thinner.
    const measured = Number.isFinite(t.widthCm) ? t.widthCm : 3;
    const est = Number.isFinite(t.sizeEstCm) ? t.sizeEstCm : measured;
    const diameter = Math.max(1.5, Math.min(measured, est));

    pipes.push({
      rating,
      p0: { x: xAt(wall.y0), y: wall.y0, depth: zAt(wall.y0) },
      p1: { x: xAt(wall.y1), y: wall.y1, depth: zAt(wall.y1) },
      xMid: xAt((wall.y0 + wall.y1) / 2),
      depthMid: zAt((wall.y0 + wall.y1) / 2),
      diameter,
      widthCm: measured,
      tiltDeg: Math.atan(fx.b) * 180 / Math.PI,
      depthTiltDeg: Math.atan(fz.b) * 180 / Math.PI,
      tiltKept,
      depthTiltKept,
      rowsSeen: distinctY,
      rowsTotal: iys.length,
      fitRmsCm: fx.rms,
      behindWall: zAt((wall.y0 + wall.y1) / 2) > thickness,
    });
  }
  pipes.sort((a, b) => a.xMid - b.xMid);
  // Seepage mode: in-wall patches as boxes spanning their columns, rows and depths. Patches
  // the empty reference also has are left out, like reference-matched pipes.
  const moisture = (detection.patches || []).filter((p) => p.rating !== 'reference').map((p) => ({
    rating: p.rating,
    x0: p.x0 - hStep / 2, x1: p.x1 + hStep / 2,
    y0: rowY(Math.min(...p.rows)) - vStep / 2, y1: rowY(Math.max(...p.rows)) + vStep / 2,
    z0: Math.max(0, p.zMin - 0.5), z1: Math.min(thickness, p.zMax + 0.5),
    xMid: p.xc, depth: p.depth, meanDb: p.meanDb, rowsSeen: p.rowCount, rowsTotal: iys.length,
  }));
  // The smallest lean this scan can show, for the UI: below it a pipe is drawn vertical.
  const minLeanDeg = span > 0 ? Math.atan(TILT_MIN_CHANGE_CM / span) * 180 / Math.PI : 90;
  return { wall, pipes, moisture, mode: detection.mode || 'pipe', rowYs: iys.map(rowY), usedReference: !!detection.usedReference, minLeanDeg };
}
