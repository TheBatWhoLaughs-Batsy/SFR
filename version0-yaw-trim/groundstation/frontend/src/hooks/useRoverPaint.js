import { useCallback, useEffect, useRef, useState } from 'react';
import { cellsOnLine, cellAtOffsetMm, columnCells } from '@/lib/projectorDemo';
import {
  clampTarget, moveCompletion,
  MOVE_TIMEOUT_FLOOR_MS, STATUS_STALE_MS, POS_TOL_MM, POS_GRACE_MS,
} from './useRoverScan';

// Projector Demo, rover mode: drive the rover over a loaded grid in a snake and record which
// cells it has been in front of. No sweep is taken.
//
// Geometry: where the rover stands when Start is pressed is the CENTRE OF THE TOP-LEFT CELL.
// The grid is driven in PASSES, in a snake: the first left to right, the next right to left,
// and so on (the rover's X is positive right, Y positive up, so moving down is -vStep). Each
// pass is ONE move at the chosen speed along one row, and between passes the rover makes one
// vertical move at the column the pass ended on.
//
// Vertical neighbours (N, default 1): a pass lights its own row plus N rows above and N below,
// a band of 2N+1 rows. Passes are 2N+1 rows apart, so one pass's lower neighbours sit right
// against the next pass's upper neighbours without overlapping. The first pass runs N rows
// below the top, so its upper neighbours cover the top row rather than falling off the grid;
// the last is held on the bottom row so the rover never drives below the grid (its band may
// then overlap the one before). N = 0 is one pass per row, starting on the top row.
//
// Coverage comes from the position the rover REPORTS, not from the plan: a cell counts once
// the reported position is within half a pitch of its centre, and that cell's N vertical
// neighbours are lit with it. Status arrives at ~11 Hz, so a fast rover can pass a cell between
// two frames; every cell on the line between the previous and the current cell is marked, since
// the rover drove through them.
//
// Same safety rules as the C-scan rover raster (useRoverScan.js): refused unless the rover is
// at rest and the whole grid fits inside the soft limits; exact move completion by token; a
// move ending as anything but 'completed', a timeout, or stopping off target aborts with an
// e-stop; a lost or silent link, or a latched e-stop, ends the run. The traverse speed is
// pushed as x_max_speed and put back on every exit, because set_config persists on the Pi.

const TOKEN_PREFIX = `pd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
let tokenCounter = 0;
const nextToken = () => `${TOKEN_PREFIX}-${++tokenCounter}`;

const TICK_MS = 40;
// v2: the default went from 50 to 300 mm/s, and a browser holding the old value would keep it.
const SPEED_KEY = 'projdemo_rover_speed_v2';
export const PAINT_SPEED = { min: 1, max: 300, dflt: 300 };
const VNEIGHBOURS_KEY = 'projdemo_rover_vneighbours';
export const PAINT_VNEIGHBOURS = { min: 0, max: 20, dflt: 1 };

const IDLE = {
  active: false, phase: 'idle', row: null, rowsTotal: 0, pass: null, passesTotal: 0,
  message: null, error: null,
};

// The row (counted from the top) each pass drives along. Pure.
export function paintRows(vCount, n) {
  const k = Math.max(0, Math.floor(n));
  const step = 2 * k + 1;
  const rows = [];
  for (let r = Math.min(k, vCount - 1); ; r += step) {
    const rr = Math.min(r, vCount - 1);
    rows.push(rr);
    if (rr + k >= vCount - 1) break;
  }
  return rows;
}

// Every move of the snake, in order, starting from the top-left cell. Pure.
export function paintLegs(grid, x0, y0, n = 0) {
  const px = grid.hStep * 10;
  const py = grid.vStep * 10;
  const legs = [];
  let col = 0;
  let row = 0;
  paintRows(grid.vCount, n).forEach((r, pass) => {
    if (r !== row) {
      legs.push({ kind: 'row', pass, row: r, x_mm: x0 + col * px, y_mm: y0 - r * py });
      row = r;
    }
    col = pass % 2 === 0 ? grid.hCount - 1 : 0;
    legs.push({ kind: 'traverse', pass, row: r, x_mm: x0 + col * px, y_mm: y0 - r * py });
  });
  return legs;
}

// The cell the rover is in front of, or null. iy is bottom-based like the rest of the grid.
export function paintCellAt(x, y, grid, x0, y0) {
  return cellAtOffsetMm(x - x0, y - y0, grid);
}

export default function useRoverPaint({ grid, roverStatus, roverConnected, sendRover, otherActive }) {
  const optsRef = useRef(null);
  optsRef.current = { grid, roverStatus, roverConnected, sendRover, otherActive };

  const [speed, setSpeedState] = useState(() => {
    const v = parseFloat(localStorage.getItem(SPEED_KEY));
    return Number.isFinite(v) && v >= PAINT_SPEED.min && v <= PAINT_SPEED.max ? v : PAINT_SPEED.dflt;
  });
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const setSpeed = useCallback((v) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(PAINT_SPEED.max, Math.max(PAINT_SPEED.min, v));
    localStorage.setItem(SPEED_KEY, String(c));
    setSpeedState(c);
  }, []);

  const [vNeighbours, setVNeighboursState] = useState(() => {
    const v = parseInt(localStorage.getItem(VNEIGHBOURS_KEY), 10);
    return Number.isInteger(v) && v >= PAINT_VNEIGHBOURS.min && v <= PAINT_VNEIGHBOURS.max
      ? v : PAINT_VNEIGHBOURS.dflt;
  });
  const vnRef = useRef(vNeighbours);
  vnRef.current = vNeighbours;
  const setVNeighbours = useCallback((v) => {
    if (!Number.isFinite(v)) return;
    const c = Math.min(PAINT_VNEIGHBOURS.max, Math.max(PAINT_VNEIGHBOURS.min, Math.round(v)));
    localStorage.setItem(VNEIGHBOURS_KEY, String(c));
    setVNeighboursState(c);
  }, []);

  const [ui, setUi] = useState(IDLE);
  // Coverage survives the end of a run, so the finished picture stays up until reset.
  const [cov, setCov] = useState({ cells: null, count: 0, current: null });
  const machine = useRef(null);
  const timer = useRef(null);

  const publishUi = useCallback(() => {
    const st = machine.current;
    if (!st) return;
    const leg = st.legs[st.leg];
    setUi({
      active: true, phase: st.phase, row: leg ? leg.row : null, rowsTotal: st.grid.vCount,
      pass: leg ? leg.pass : null, passesTotal: st.passesTotal,
      message: st.message, error: null,
    });
  }, []);

  const publishCov = useCallback((st) => {
    setCov({ cells: new Uint8Array(st.covered), count: st.coveredCount, current: st.current });
  }, []);

  const markAt = useCallback((st, x, y) => {
    const cell = paintCellAt(x, y, st.grid, st.x0, st.y0);
    if (!cell) {
      if (st.current) { st.current = null; publishCov(st); }
      return;
    }
    if (st.current && st.current.ix === cell.ix && st.current.iy === cell.iy) return;
    const n = st.grid.hCount;
    for (const c of (st.last ? cellsOnLine(st.last, cell) : [cell])) {
      for (const b of columnCells(c, st.vNeighbours, st.grid)) {
        const i = b.iy * n + b.ix;
        if (!st.covered[i]) { st.covered[i] = 1; st.coveredCount += 1; }
      }
    }
    st.last = cell;
    st.current = cell;
    publishCov(st);
  }, [publishCov]);

  // Ends the run. `halt` is null (send nothing), 'stop' (decelerate) or 'estop' (latch).
  const finish = useCallback((phase, message, error, halt) => {
    const o = optsRef.current;
    const st = machine.current;
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    machine.current = null;
    // Halt first, so putting the faster speed back cannot speed up a move still in flight.
    if (halt) {
      try { o.sendRover({ cmd: halt === 'estop' ? 'rover_estop' : 'rover_stop' }); } catch { /* link gone */ }
    }
    if (st && st.speedApplied && st.prevMaxSpeed != null) {
      try {
        o.sendRover({ cmd: 'rover_set_config', config: { x_max_speed: st.prevMaxSpeed } });
      } catch { /* link gone */ }
    }
    if (st) setCov(c => ({ ...c, current: null }));
    setUi({ ...IDLE, phase, message, error });
  }, []);

  const issueLeg = useCallback((st) => {
    const o = optsRef.current;
    const status = o.roverStatus;
    const cfg = status?.config;
    const leg = st.legs[st.leg];
    const target = clampTarget({ x_mm: leg.x_mm, y_mm: leg.y_mm }, cfg);
    const dist = Math.hypot(leg.x_mm - st.planned.x_mm, leg.y_mm - st.planned.y_mm);
    const axisSpeed = leg.kind === 'traverse' ? st.speed : Math.max(1, cfg?.y_max_speed || 25);
    st.phase = leg.kind === 'traverse' ? 'traversing' : 'row_change';
    st.target = target;
    st.planned = { x_mm: leg.x_mm, y_mm: leg.y_mm };
    st.issuedAt = performance.now();
    st.timeoutMs = Math.max(MOVE_TIMEOUT_FLOOR_MS, (dist / axisSpeed) * 1000 * 3 + 5000);
    st.idleSince = null;
    st.movesDoneAtIssue = typeof status?.moves_done === 'number' ? status.moves_done : null;
    st.moveToken = nextToken();
    st.tokenSupported = typeof status?.last_done_token !== 'undefined';
    st.message = leg.kind === 'traverse'
      ? `Pass ${leg.pass + 1} of ${st.passesTotal} · row ${leg.row + 1} of ${st.grid.vCount}`
      : `Stepping down to row ${leg.row + 1}`;
    o.sendRover({ cmd: 'rover_move_abs', x_mm: target.x_mm, y_mm: target.y_mm, token: st.moveToken });
    publishUi();
  }, [publishUi]);

  // Next leg, skipping zero-length ones (a one-column grid has no traverse to drive).
  const advance = useCallback((st) => {
    st.leg += 1;
    while (st.leg < st.legs.length) {
      const leg = st.legs[st.leg];
      if (Math.hypot(leg.x_mm - st.planned.x_mm, leg.y_mm - st.planned.y_mm) > 0.01) {
        issueLeg(st);
        return;
      }
      st.planned = { x_mm: leg.x_mm, y_mm: leg.y_mm };
      st.leg += 1;
    }
    finish('done', `Finished — ${st.coveredCount} of ${st.covered.length} cells covered.`, null, null);
  }, [issueLeg, finish]);

  const tick = useCallback(() => {
    const o = optsRef.current;
    const st = machine.current;
    if (!st) return;
    const status = o.roverStatus;
    const now = performance.now();

    if (!o.roverConnected || !status || !status.board_connected) {
      finish('error', null, 'Rover link lost — run stopped.', null);
      return;
    }
    if (status.estop) {
      finish('error', null, 'E-stop latched — run stopped.', null);
      return;
    }
    if (status.last_status_at !== st.lastStatusAt) {
      st.lastStatusAt = status.last_status_at;
      st.lastStatusSeenAt = now;
      markAt(st, status.x_mm, status.y_mm);
    } else if (now - st.lastStatusSeenAt > STATUS_STALE_MS) {
      finish('error', null,
        `No rover status for ${(STATUS_STALE_MS / 1000).toFixed(0)} s — run stopped.`, 'stop');
      return;
    }

    const { exact, completed, since } = moveCompletion(st, status, now);
    const idle = !status.moving && (status.pending_moves | 0) === 0 && (status.queue_depth | 0) === 0;
    if (exact && completed && status.last_done_reason && status.last_done_reason !== 'completed') {
      finish('error', null,
        `Move ended as '${status.last_done_reason}' instead of completing — run stopped.`, 'estop');
      return;
    }
    if (completed && idle) {
      const off = Math.hypot(status.x_mm - st.target.x_mm, status.y_mm - st.target.y_mm);
      if (off <= POS_TOL_MM) {
        advance(st);
        return;
      }
      if (st.idleSince == null) st.idleSince = now;
      else if (now - st.idleSince >= POS_GRACE_MS) {
        finish('error', null, `Rover stopped ${off.toFixed(1)} mm from its target — run stopped.`, 'estop');
      }
      return;
    }
    st.idleSince = null;
    if (since > st.timeoutMs) {
      finish('error', null, 'Move timed out — the rover never reached its target.', 'estop');
    }
  }, [finish, markAt, advance]);

  const start = useCallback(() => {
    if (machine.current) return;
    const o = optsRef.current;
    const status = o.roverStatus;
    const g = o.grid;
    const fail = (msg) => setUi({ ...IDLE, phase: 'error', error: msg });

    if (!g) return fail('Import a grid first.');
    if (!o.roverConnected || !status || !status.board_connected) return fail('Rover controller is not connected.');
    if (o.otherActive) return fail('A C-scan or BG Model rover scan is running — stop it first.');
    if (status.estop) return fail('E-stop is latched — clear it in the Rover Scan panel first.');
    if (status.moving || (status.pending_moves | 0) > 0 || (status.queue_depth | 0) > 0) {
      return fail('The rover is still moving. Wait for it to stop: the top-left cell is taken from where it stands.');
    }
    if (!Number.isFinite(status.x_mm) || !Number.isFinite(status.y_mm)) return fail('No rover position yet.');

    const cfg = status.config;
    const x0 = status.x_mm;
    const y0 = status.y_mm;
    const xEnd = x0 + (g.hCount - 1) * g.hStep * 10;
    const yEnd = y0 - (g.vCount - 1) * g.vStep * 10;
    // No endstops: refuse a grid that does not fit rather than clamp and drive a different one.
    if (cfg && cfg.limits_enabled) {
      const bad = [];
      if (x0 < cfg.x_min_mm || xEnd > cfg.x_max_mm) {
        bad.push(`X ${x0.toFixed(0)}–${xEnd.toFixed(0)} mm is outside ${cfg.x_min_mm}–${cfg.x_max_mm}`);
      }
      if (yEnd < cfg.y_min_mm || y0 > cfg.y_max_mm) {
        bad.push(`Y ${yEnd.toFixed(0)}–${y0.toFixed(0)} mm is outside ${cfg.y_min_mm}–${cfg.y_max_mm}`);
      }
      if (bad.length) return fail(`The grid does not fit inside the soft limits: ${bad.join('; ')}.`);
    }

    const spd = speedRef.current;
    const nb = vnRef.current;
    const st = {
      grid: g, x0, y0, vNeighbours: nb, passesTotal: paintRows(g.vCount, nb).length,
      legs: paintLegs(g, x0, y0, nb), leg: -1, planned: { x_mm: x0, y_mm: y0 },
      speed: spd, prevMaxSpeed: cfg ? cfg.x_max_speed : null, speedApplied: false,
      covered: new Uint8Array(g.hCount * g.vCount), coveredCount: 0, current: null, last: null,
      phase: 'starting', message: null, target: { x_mm: x0, y_mm: y0 },
      issuedAt: 0, timeoutMs: MOVE_TIMEOUT_FLOOR_MS, idleSince: null,
      movesDoneAtIssue: null, moveToken: null, tokenSupported: false,
      lastStatusAt: status.last_status_at, lastStatusSeenAt: performance.now(),
    };
    machine.current = st;
    if (st.prevMaxSpeed != null && Math.abs(st.prevMaxSpeed - spd) > 1e-6) {
      o.sendRover({ cmd: 'rover_set_config', config: { x_max_speed: spd } });
      st.speedApplied = true;
    }
    markAt(st, x0, y0);
    advance(st);
    if (machine.current === st) timer.current = setInterval(tick, TICK_MS);
    return undefined;
  }, [markAt, advance, tick]);

  const stop = useCallback(() => {
    if (machine.current) finish('stopped', 'Run stopped.', null, 'stop');
  }, [finish]);

  const resetCoverage = useCallback(() => {
    if (machine.current) return;
    const g = optsRef.current.grid;
    setCov({ cells: g ? new Uint8Array(g.hCount * g.vCount) : null, count: 0, current: null });
    setUi(IDLE);
  }, []);

  // A new or unloaded grid starts uncovered; changing it mid-run ends the run.
  useEffect(() => {
    if (machine.current && machine.current.grid !== grid) {
      finish('error', null, 'The grid changed during the run.', 'stop');
    }
    setCov({ cells: grid ? new Uint8Array(grid.hCount * grid.vCount) : null, count: 0, current: null });
  }, [grid, finish]);

  // Unmounting mid-run (tab closed, reload): finish() never runs, so put the speed back here.
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    const st = machine.current;
    if (st && st.speedApplied && st.prevMaxSpeed != null) {
      try {
        optsRef.current.sendRover({ cmd: 'rover_set_config', config: { x_max_speed: st.prevMaxSpeed } });
      } catch { /* link gone */ }
    }
    machine.current = null;
  }, []);

  return {
    ...ui, covered: cov.cells, coveredCount: cov.count, currentCell: cov.current,
    speed, setSpeed, vNeighbours, setVNeighbours, start, stop, resetCoverage,
  };
}
