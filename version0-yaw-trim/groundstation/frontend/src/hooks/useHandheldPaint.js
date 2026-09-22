import { useCallback, useEffect, useRef, useState } from 'react';
import { cellAtOffsetMm, cellsOnLine, brushCells } from '@/lib/projectorDemo';

// Projector Demo, handheld mode: light up the grid cells the handheld module reaches.
//
// Position is the Handheld + IMU panel's own (lib/handheldPose.js computeHandheldPosition,
// with its origin, wiring and averaging), so the two panels cannot disagree. The shared
// origin is the CENTRE OF THE TOP-LEFT CELL: X right and Y up from there, exactly as the rover
// mode uses the rover's start position (lib/projectorDemo.js cellAtOffsetMm).
//
// A session starts PAUSED with coverage cleared. While playing, the position acts as a BRUSH:
// every position update lights every cell within HANDHELD_BRUSH_RADIUS cells of the cell the
// module is in front of (a disc counted in cells). While paused, or with no X/Y position (no origin, or a
// LiDAR not reading), nothing is marked; the current cell is still tracked so the monitor can
// outline it. Coverage stays after the session ends, until reset or a new grid.
//
// PATH: while playing, every position update is also recorded as a point
// [t_s, x_mm, y_mm, z_mm, ix, iy] -- the Pi's sensor timestamp, the Handheld panel's position
// (mm from the origin; x right, y up, z forward) and the cell it was over (null off the grid).
// Each Play starts a new segment, and so does an origin change, because the coordinates before
// and after it are measured from different origins; a brief loss of position does not. Points
// live in a ref rather than state, so they are never passed as props (React's dev build diffs
// changed props into the Performance timeline, see CLAUDE.md), and the point count on screen is
// refreshed at most 4 times a second. The path is cleared by Start session and by Reset.
//
// The LiDARs publish a new value 11-17 times a second, so a quick swipe can pass a cell
// between two readings. Cells on the line between two consecutive cells are marked too, but
// only across a short jump (HANDHELD_FILL_MAX_CELLS): a longer one is more likely a beam
// sliding off a surface edge, a pause-and-reposition, or an origin change than real motion,
// and bridging it would light cells the module never passed.

export const HANDHELD_FILL_MAX_CELLS = 2;
export const HANDHELD_BRUSH_RADIUS = 5;

export const PATH_FILE_TYPE = 'projector_demo_handheld_path';
export const PATH_COLUMNS = ['t_s', 'x_mm', 'y_mm', 'z_mm', 'ix', 'iy'];
const PATH_PUBLISH_MS = 250;
const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const emptyPath = () => ({ segments: [], open: null, lastT: null, points: 0, publishedAt: 0 });

const sameCell = (a, b) => (a === b) || (!!a && !!b && a.ix === b.ix && a.iy === b.iy);

export default function useHandheldPaint({ grid, pose, connected, sampleTime }) {
  const [session, setSession] = useState({ active: false, playing: false });
  const [cov, setCov] = useState({ cells: null, count: 0, current: null });
  const trail = useRef({ covered: null, count: 0, last: null, current: null, originKey: null });
  const path = useRef(emptyPath());
  const [pathInfo, setPathInfo] = useState({ points: 0, segments: 0 });
  // Pi time of the packet `pose` was computed from; read by the effect below for this render.
  const sampleTimeRef = useRef(sampleTime);
  sampleTimeRef.current = sampleTime;

  const publishPath = useCallback(() => {
    const p = path.current;
    p.publishedAt = performance.now();
    setPathInfo({ points: p.points, segments: p.segments.length });
  }, []);
  const clearPath = useCallback(() => {
    path.current = emptyPath();
    setPathInfo({ points: 0, segments: 0 });
  }, []);
  const gridRef = useRef(grid);
  gridRef.current = grid;

  const clear = useCallback((g) => {
    const t = trail.current;
    t.covered = g ? new Uint8Array(g.hCount * g.vCount) : null;
    t.count = 0;
    t.last = null;
    t.current = null;
    setCov({ cells: t.covered ? new Uint8Array(t.covered) : null, count: 0, current: null });
  }, []);

  // A new or unloaded grid starts uncovered and ends any session on the old one.
  useEffect(() => {
    clear(grid);
    setSession({ active: false, playing: false });
  }, [grid, clear]);

  useEffect(() => {
    if (!session.active || !grid) return;
    const t = trail.current;
    if (!t.covered || t.covered.length !== grid.hCount * grid.vCount) return;

    // A new origin moves every cell under the module: never bridge across it.
    const originKey = `${pose?.axes?.x?.originMm}|${pose?.axes?.y?.originMm}`;
    if (originKey !== t.originKey) { t.originKey = originKey; t.last = null; path.current.open = null; }

    const x = connected ? pose?.pos?.x : null;
    const y = connected ? pose?.pos?.y : null;
    const cell = x != null && y != null ? cellAtOffsetMm(x, y, grid) : null;

    if (session.playing && x != null && y != null) {
      const p = path.current;
      const raw = sampleTimeRef.current;
      const tS = Number.isFinite(raw) ? raw : Date.now() / 1000;
      // The pose is recomputed for reasons other than a new packet (origin, wiring, averaging);
      // one point per packet.
      if (tS !== p.lastT) {
        if (!p.open) {
          const om = (k) => (Number.isFinite(pose?.axes?.[k]?.originMm) ? pose.axes[k].originMm : null);
          p.open = { started_s: round3(tS), origin_mm: { x: om('x'), y: om('y'), z: om('z') }, points: [] };
          p.segments.push(p.open);
        }
        const z = connected ? pose?.pos?.z : null;
        p.open.points.push([
          round3(tS), round1(x), round1(y), z == null ? null : round1(z),
          cell ? cell.ix : null, cell ? cell.iy : null,
        ]);
        p.lastT = tS;
        p.points += 1;
        if (performance.now() - p.publishedAt >= PATH_PUBLISH_MS) publishPath();
      }
    }
    let changed = !sameCell(cell, t.current);
    t.current = cell;

    if (session.playing && cell) {
      const near = t.last
        && Math.max(Math.abs(t.last.ix - cell.ix), Math.abs(t.last.iy - cell.iy)) <= HANDHELD_FILL_MAX_CELLS;
      for (const c of (near ? cellsOnLine(t.last, cell) : [cell])) {
        for (const b of brushCells(c, HANDHELD_BRUSH_RADIUS, grid)) {
          const i = b.iy * grid.hCount + b.ix;
          if (!t.covered[i]) { t.covered[i] = 1; t.count += 1; changed = true; }
        }
      }
      t.last = cell;
    } else {
      // Paused, lost, or off the grid: the next reached cell starts a fresh trail.
      t.last = null;
    }

    if (changed) setCov({ cells: new Uint8Array(t.covered), count: t.count, current: cell });
  }, [pose, connected, session, grid, publishPath]);

  const start = useCallback(() => {
    if (!gridRef.current) return;
    clear(gridRef.current);
    clearPath();
    trail.current.originKey = null;
    setSession({ active: true, playing: false });
  }, [clear, clearPath]);

  const end = useCallback(() => {
    trail.current.last = null;
    trail.current.current = null;
    path.current.open = null;
    publishPath();
    setSession({ active: false, playing: false });
    setCov(c => ({ ...c, current: null }));
  }, [publishPath]);

  const togglePlay = useCallback(() => {
    trail.current.last = null;
    // Pausing closes the segment; the next Play opens a new one.
    path.current.open = null;
    publishPath();
    setSession(s => (s.active ? { ...s, playing: !s.playing } : s));
  }, [publishPath]);

  // Clears both the reached cells and the recorded path. Not during a session.
  const resetCoverage = useCallback(() => {
    if (session.active) return;
    clear(gridRef.current);
    clearPath();
  }, [session.active, clear, clearPath]);

  // The export file. Self-describing: columns, frame and clock are named in it.
  const makePathFile = useCallback(() => {
    const g = gridRef.current;
    return {
      version: 1,
      type: PATH_FILE_TYPE,
      exported_at: new Date().toISOString(),
      frame: 'Handheld + IMU panel position in mm from the origin, which is the centre of the '
        + 'top-left grid cell: x right, y up, z forward. Tilt-corrected when the panel corrects tilt.',
      clock: 't_s is the Pi sensor packet timestamp, seconds (time.time()).',
      cell: 'ix counts from the left column, iy from the BOTTOM row; null when off the grid.',
      grid: g ? { hCount: g.hCount, hStep: g.hStep, vCount: g.vCount, vStep: g.vStep } : null,
      columns: PATH_COLUMNS,
      segments: path.current.segments
        .filter(s => s.points.length)
        .map(s => ({ started_s: s.started_s, origin_mm: s.origin_mm, points: s.points })),
    };
  }, []);

  return {
    active: session.active, playing: session.playing,
    covered: cov.cells, coveredCount: cov.count, currentCell: cov.current,
    start, end, togglePlay, resetCoverage,
    pathPoints: pathInfo.points, pathSegments: pathInfo.segments, makePathFile,
  };
}
