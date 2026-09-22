// Projector Demo panel: a grid of coloured cells, drawn by hand or loaded from a file.
//
// Pure (no React, no DOM), so the file format and the painting arithmetic can be checked
// from node. Cell frame is the C-scan's: ix = 0 is the LEFT column, iy = 0 the BOTTOM row,
// steps in cm, and a cell's colour lives at `iy * hCount + ix`.

export const PROJECTOR_DEMO_FILE_TYPE = 'projector_demo_grid';
// v2 adds an optional `radar` block (Draw mode's pipe/seepage layers, seed and look, see
// lib/radarLook.js). Version 1 files, colours only, still load.
export const PROJECTOR_DEMO_FILE_VERSION = 2;

// Same bounds the C-scan panel's Scan Grid fields use.
export const GRID_LIMITS = { countMin: 1, countMax: 200, stepMin: 0.5, stepMax: 50 };

export const DEFAULT_GRID = { hCount: 10, hStep: 5, vCount: 6, vStep: 5 };

// What an unpainted cell (colour null) looks like wherever colours are shown: a new grid, a
// cleared grid, an erased cell, and a cell a file does not list. Files stay sparse -- only
// painted cells are written -- so this is a display default, not stored per cell.
export const GRID_BACKGROUND = '#0b1a3d';

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeColor(c) {
  return typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : null;
}

export function emptyColors(grid) {
  return new Array(grid.hCount * grid.vCount).fill(null);
}

export function makeGrid(params = DEFAULT_GRID) {
  const g = {
    hCount: params.hCount, hStep: params.hStep, vCount: params.vCount, vStep: params.vStep,
  };
  return { ...g, colors: emptyColors(g) };
}

// New geometry, keeping every colour whose (ix, iy) is still inside it. Counts are what
// change the index layout; steps only change the cell size.
export function resizeGrid(grid, params) {
  const next = makeGrid({ ...grid, ...params });
  const w = Math.min(grid.hCount, next.hCount);
  const h = Math.min(grid.vCount, next.vCount);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      next.colors[iy * next.hCount + ix] = grid.colors[iy * grid.hCount + ix] ?? null;
    }
  }
  return next;
}

// Set `cells` to `color` (null erases). Returns the same object when nothing changed, so a
// drag over already-painted cells does not re-render.
export function paintCells(grid, cells, color) {
  const c = color == null ? null : normalizeColor(color);
  let colors = null;
  for (const { ix, iy } of cells) {
    if (ix < 0 || ix >= grid.hCount || iy < 0 || iy >= grid.vCount) continue;
    const i = iy * grid.hCount + ix;
    if (grid.colors[i] === c) continue;
    if (!colors) colors = grid.colors.slice();
    colors[i] = c;
  }
  return colors ? { ...grid, colors } : grid;
}

// The cell in front of a point given as an offset in mm from the CENTRE OF THE TOP-LEFT CELL,
// X positive right and Y positive UP (the rover's frame and the handheld's). Nearest cell
// centre on both axes; null off the grid. Rows count down from the top, so the offset goes
// negative in Y as you move down the grid.
export function cellAtOffsetMm(dxMm, dyMm, grid) {
  const ix = Math.round(dxMm / (grid.hStep * 10));
  const r = Math.round(-dyMm / (grid.vStep * 10));
  if (!(ix >= 0 && ix < grid.hCount && r >= 0 && r < grid.vCount)) return null;
  return { ix, iy: grid.vCount - 1 - r };
}

// Every grid cell within `radius` cells of `center`: a disc measured in CELLS, not cm, so on a
// grid with unequal steps it is an ellipse on the wall. The handheld brush.
export function brushCells(center, radius, grid) {
  const r = Math.max(0, Math.floor(radius));
  const out = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const ix = center.ix + dx;
      const iy = center.iy + dy;
      if (ix >= 0 && ix < grid.hCount && iy >= 0 && iy < grid.vCount) out.push({ ix, iy });
    }
  }
  return out;
}

// `center` plus the `n` cells directly above and below it in the same column, clipped to the
// grid. The rover's vertical neighbours.
export function columnCells(center, n, grid) {
  const k = Math.max(0, Math.floor(n));
  const out = [];
  for (let dy = -k; dy <= k; dy++) {
    const iy = center.iy + dy;
    if (iy >= 0 && iy < grid.vCount && center.ix >= 0 && center.ix < grid.hCount) out.push({ ix: center.ix, iy });
  }
  return out;
}

export function filledCount(grid) {
  return grid ? grid.colors.reduce((n, c) => n + (c ? 1 : 0), 0) : 0;
}

// Every cell on the straight line from a to b, both ends included. A fast mouse jumps
// several cells between pointer events; painting only the endpoints would leave gaps.
export function cellsOnLine(a, b) {
  const out = [];
  let x = a.ix;
  let y = a.iy;
  const dx = Math.abs(b.ix - a.ix);
  const dy = -Math.abs(b.iy - a.iy);
  const sx = a.ix < b.ix ? 1 : -1;
  const sy = a.iy < b.iy ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ ix: x, iy: y });
    if (x === b.ix && y === b.iy) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

// File: grid geometry plus the coloured cells, as a list, so a file is readable and editable by
// hand. Empty cells are absent. `radar`, when given, is Draw mode's editable source for the image
// (the cell colours are the rendered result, and are what Rover and Handheld show).
export function serializeGrid(grid, radar = null) {
  const cells = [];
  for (let iy = 0; iy < grid.vCount; iy++) {
    for (let ix = 0; ix < grid.hCount; ix++) {
      const color = grid.colors[iy * grid.hCount + ix];
      if (color) cells.push({ ix, iy, color });
    }
  }
  return {
    version: PROJECTOR_DEMO_FILE_VERSION,
    type: PROJECTOR_DEMO_FILE_TYPE,
    timestamp: new Date().toISOString(),
    grid: { hCount: grid.hCount, hStep: grid.hStep, vCount: grid.vCount, vStep: grid.vStep },
    cells,
    ...(radar ? { radar } : {}),
  };
}

// Returns { grid, radar } or { error }. `radar` is the raw block (null if absent); Draw mode
// validates it with radarDocFromFile. Refuses rather than clamps: a grid silently cut down to
// fit would project a different pattern than the one in the file.
export function parseGrid(obj) {
  if (!obj || typeof obj !== 'object') return { error: 'Not a JSON object.' };
  if (obj.type !== PROJECTOR_DEMO_FILE_TYPE) {
    return { error: `Not a projector demo grid (type is ${JSON.stringify(obj.type ?? null)}).` };
  }
  if (obj.version !== 1 && obj.version !== 2) {
    return { error: `Unsupported file version ${JSON.stringify(obj.version ?? null)}.` };
  }
  const g = obj.grid || {};
  const L = GRID_LIMITS;
  for (const k of ['hCount', 'vCount']) {
    if (!Number.isInteger(g[k]) || g[k] < L.countMin || g[k] > L.countMax) {
      return { error: `grid.${k} must be a whole number from ${L.countMin} to ${L.countMax}.` };
    }
  }
  for (const k of ['hStep', 'vStep']) {
    if (!Number.isFinite(g[k]) || g[k] < L.stepMin || g[k] > L.stepMax) {
      return { error: `grid.${k} must be from ${L.stepMin} to ${L.stepMax} cm.` };
    }
  }
  if (!Array.isArray(obj.cells)) return { error: 'cells must be a list.' };
  const grid = makeGrid(g);
  for (let n = 0; n < obj.cells.length; n++) {
    const c = obj.cells[n] || {};
    if (!Number.isInteger(c.ix) || !Number.isInteger(c.iy)
      || c.ix < 0 || c.ix >= grid.hCount || c.iy < 0 || c.iy >= grid.vCount) {
      return { error: `cells[${n}] is outside the ${grid.hCount} × ${grid.vCount} grid.` };
    }
    const color = normalizeColor(c.color);
    if (!color) return { error: `cells[${n}].color must be #rrggbb.` };
    grid.colors[c.iy * grid.hCount + c.ix] = color;
  }
  return { grid, radar: obj.version >= 2 && obj.radar ? obj.radar : null };
}
