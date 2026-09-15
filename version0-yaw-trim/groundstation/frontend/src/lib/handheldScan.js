// Handheld scan: the operator sweeps a hand-carried head across a wall, and the
// three-LiDAR position (lib/handheldPose.js) says which grid cell the head is
// over. Unlike the rover C-scan, nothing drives the head -- there is no path to
// command, only a path to RECORD. So this module is deliberately small: it maps
// a live (x, y) in mm to a cell, tracks which cells are filled, and answers
// "are we parked over an empty cell long enough to capture".
//
// Coordinates match the C-scan grid (lib/cscanGrid.js) so every downstream
// display, the export format and buildCscanGrid all work unchanged:
//   - origin is the grid's BOTTOM-LEFT corner,
//   - ix runs right (+x), iy runs up (+y),
//   - a cell record carries grid_ix / grid_iy / x_cm / y_cm.
// The handheld X axis is the pose's X (right), Y is the pose's Y (up). Both are
// millimetres from the handheld origin, which the operator declares with the
// head held at the grid's bottom-left corner.
//
// What this does NOT do: it never commands motion, never talks to the Pi, and
// holds no sweep data -- the capture path in App.jsx owns the SFCW sweep exactly
// as it does for the manual C-scan. This file is pure geometry and bookkeeping.

// A cell is hStep/vStep cm wide. The head is "in" cell (ix, iy) when its
// position falls inside that cell's rectangle, with the origin at a corner.
export function cellForPosition(xMm, yMm, params) {
  if (xMm == null || yMm == null) return null;
  const hStepMm = params.hStep * 10;
  const vStepMm = params.vStep * 10;
  if (!(hStepMm > 0) || !(vStepMm > 0)) return null;
  const ix = Math.floor(xMm / hStepMm);
  const iy = Math.floor(yMm / vStepMm);
  if (ix < 0 || ix >= params.hCount || iy < 0 || iy >= params.vCount) return null;
  return { ix, iy };
}

// Centre of a cell in mm from the origin, for the "distance to target" readout
// and the guidance arrow.
export function cellCentreMm(ix, iy, params) {
  return {
    x: (ix + 0.5) * params.hStep * 10,
    y: (iy + 0.5) * params.vStep * 10,
  };
}

// How far the head is from the centre of the cell it is over, in mm. Used to
// tell the operator to hold still, and to gate auto-capture to the middle of a
// cell rather than its edge (a capture taken on a boundary is ambiguous about
// which cell it belongs to).
export function offsetFromCentre(xMm, yMm, cell, params) {
  if (!cell) return null;
  const c = cellCentreMm(cell.ix, cell.iy, params);
  return { dx: xMm - c.x, dy: yMm - c.y, dist: Math.hypot(xMm - c.x, yMm - c.y) };
}

// Which grid cells already hold a capture. A Set of "ix,iy" keys, cheap to test
// while drawing and while deciding whether the current cell still needs a look.
export function filledCells(scanData) {
  const s = new Set();
  for (const p of scanData) {
    if (p.grid_ix != null && p.grid_iy != null) s.add(`${p.grid_ix},${p.grid_iy}`);
  }
  return s;
}

export function cellKey(cell) {
  return cell ? `${cell.ix},${cell.iy}` : null;
}

export function isFilled(cell, filled) {
  return !!cell && filled.has(cellKey(cell));
}

// The next empty cell along the C-scan snake path, so the panel can show the
// operator where to go next without imposing an order -- they may fill cells in
// any order they like, this is only a suggestion and a progress anchor. Row 0
// is the bottom, left-to-right; each row up reverses (matches cellForIndex in
// lib/cscanGrid.js).
export function nextEmptyCell(filled, params) {
  const { hCount, vCount } = params;
  for (let iy = 0; iy < vCount; iy++) {
    for (let along = 0; along < hCount; along++) {
      const ix = iy % 2 === 0 ? along : hCount - 1 - along;
      if (!filled.has(`${ix},${iy}`)) return { ix, iy };
    }
  }
  return null; // grid complete
}

// Progress for the header: filled vs total, and whether every cell is done.
export function scanProgress(scanData, params) {
  const total = Math.max(1, params.hCount) * Math.max(1, params.vCount);
  const filled = filledCells(scanData);
  // Only count cells that fall within the CURRENT grid; a cell captured then
  // orphaned by shrinking the grid should not inflate the count.
  let inGrid = 0;
  for (const key of filled) {
    const [ix, iy] = key.split(',').map(Number);
    if (ix < params.hCount && iy < params.vCount) inGrid++;
  }
  return { filled: inGrid, total, complete: inGrid >= total };
}

// Auto-capture readiness. The head must be inside a cell, that cell must be
// empty, the head must be near the cell centre (not straddling a boundary), and
// it must have been held still for a dwell time. The caller owns the dwell
// clock (it needs the position stream's timestamps); this returns the geometric
// verdict and the reason, so the panel can explain why it is or is not ready.
//
// `settleRadiusMm` keeps a capture away from cell edges; `steadyMm` is how tight
// the recent position spread must be to count as "held still".
export function captureReadiness(pose, params, filled, opts = {}) {
  const settleRadiusMm = opts.settleRadiusMm ?? 15;
  // A radar look taken with the head tilted is not a look at the cell in
  // front of it. The forward axis's live tilt is what the pose already
  // reports; past this the head must be squared up before a capture counts.
  const maxTiltDeg = opts.maxTiltDeg ?? 12;
  const x = pose?.pos?.x;
  const y = pose?.pos?.y;
  const hasOrigin = pose?.axes?.x?.originMm != null && pose?.axes?.y?.originMm != null;
  if (!hasOrigin) return { ready: false, reason: 'no-origin', cell: null };
  if (x == null || y == null) {
    return { ready: false, reason: 'no-position', cell: null };
  }
  const cell = cellForPosition(x, y, params);
  if (!cell) return { ready: false, reason: 'outside-grid', cell: null };
  if (isFilled(cell, filled)) return { ready: false, reason: 'cell-filled', cell };
  const tilt = pose?.axes?.z?.tiltDeg;
  if (tilt != null && Math.abs(tilt) > maxTiltDeg) {
    return { ready: false, reason: 'tilted', cell, tiltDeg: tilt, maxTiltDeg };
  }
  const off = offsetFromCentre(x, y, cell, params);
  // The centre zone is min(settleRadius, 40% of the smaller cell half-extent),
  // so a small cell is not impossible to satisfy and a big one is not so loose
  // that two cells share the sweet spot.
  const halfX = params.hStep * 10 * 0.5;
  const halfY = params.vStep * 10 * 0.5;
  const zone = Math.min(settleRadiusMm, 0.4 * Math.min(halfX, halfY) + 2);
  if (off.dist > zone) return { ready: false, reason: 'off-centre', cell, off, zone };
  return { ready: true, reason: 'ready', cell, off, zone };
}

// A short human string for whichever readiness reason is current.
export const READINESS_TEXT = {
  'no-origin': 'Set the origin first',
  'no-position': 'No position — a LiDAR is not reading',
  'outside-grid': 'Outside the grid',
  'cell-filled': 'Cell captured — move on, or recapture',
  'tilted': 'Square the head to the wall',
  'off-centre': 'Centre the head over the cell',
  'ready': 'Ready to capture',
};

// Spread of the head's position across the looks that made one cell, in mm:
// the aperture the coherent average was really taken over. Same idea as the
// rover's rover_x_std_mm, so an export says how still the hand was.
export function positionSpread(points) {
  const xs = points.map(p => p.x).filter(Number.isFinite);
  const ys = points.map(p => p.y).filter(Number.isFinite);
  if (xs.length === 0) return { x: null, y: null, std: null };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  const var2 = (a, m) => a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
  const std = Math.sqrt(var2(xs, mx) + var2(ys, my));
  return { x: mx, y: my, std };
}
