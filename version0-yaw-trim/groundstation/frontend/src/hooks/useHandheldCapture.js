import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPTURE_GRID_LIMITS, CAPTURE_SESSION_TYPE, CAPTURE_SESSION_VERSION, DEFAULT_CAPTURE_GRID, FORMAT_NOTES,
  LATENCY_LIMITS_MS, PENDING_MAX, PENDING_MAX_MS,
  cellAtCornerOffsetMm, createHandheldTracks, isEmptyDspSweep, nextSessionName, roughCellRecord, sweepMidpoint, sweepRecord,
  validateSessionName,
} from '@/lib/handheldCapture';
import { createSessionWriter } from '@/lib/captureWriter';
import { fsAccessSupported, loadDirHandle, saveDirHandle } from '@/lib/dirHandleStore';

// Handheld Capture panel: record a hand-held scan of a wall patch, raw and complete, straight
// to disk. See lib/handheldCapture.js for what is recorded and lib/captureWriter.js for how.
//
// Flow: choose a folder and a session name (a subfolder of that name is created; Start is
// refused while anything of that name exists), Start session (starts recording and the SFCW
// sweep if it is not running), hold the module at the patch's TOP-LEFT CORNER and Set origin,
// Play and move. Everything is recorded from Start to End, playing or not; Play/Pause only
// decides which sweeps are placed on the coverage map, and is itself recorded as an event.
//
// FEEDS. App calls onSensor for every sensor packet and onSdr for every SDR message, straight
// from the websocket handlers -- not from a React render, which can coalesce packets under load
// and so lose position updates. Nothing large goes through React state: the writer, tracks,
// pending sweeps and coverage counts are refs, published to the panel at most 4 times a second.

const TICK_MS = 250;
const FLUSH_EVERY_TICKS = 4;      // ~1 s: the most a crash can lose
const MANIFEST_EVERY_TICKS = 40;  // ~10 s, plus on every new segment
const BACKLOG_ALARM_BYTES = 64 * 1024 * 1024;
// The live position is dropped once its newest measurement is this far behind the newest packet.
const LIVE_POS_MAX_AGE_S = 0.5;
// How long (browser time) a sweep already placed in X and Y waits for the forward LiDAR's
// next measurement, so its standoff can be interpolated rather than left empty.
const FWD_WAIT_MS = 400;
const MANIFEST = 'session.json';

const DIR_KEY = 'handheld-capture-dir';
const GRID_KEY = 'handheld_capture_grid_v1';
const NAME_KEY = 'handheld_capture_name_v2';
const MIN_SWEEPS_KEY = 'handheld_capture_min_sweeps_v1';
const LATENCY_KEY = 'handheld_capture_lidar_latency_ms_v1';
export const MIN_SWEEPS_LIMITS = { min: 1, max: 1000 };

const zeroCounters = () => ({
  sweeps: 0, sensor: 0, sdr: 0, events: 0, placed: 0, noPosition: 0, offGrid: 0, emptySweeps: 0,
});

function loadGrid() {
  try {
    const g = JSON.parse(localStorage.getItem(GRID_KEY));
    const L = CAPTURE_GRID_LIMITS;
    if (g && [g.hCount, g.vCount].every(v => Number.isInteger(v) && v >= L.countMin && v <= L.countMax)
      && [g.hStep, g.vStep].every(v => Number.isFinite(v) && v >= L.stepMin && v <= L.stepMax)) {
      return { hCount: g.hCount, hStep: g.hStep, vCount: g.vCount, vStep: g.vStep };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CAPTURE_GRID };
}

function loadNumber(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const v = Number(raw);
    return raw != null && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function persist(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: session-only */ }
}

async function entryExists(dir, name) {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch (e) {
    if (e?.name === 'TypeMismatchError') return true; // a file of that name
    if (e?.name !== 'NotFoundError') throw e;
  }
  return false;
}

export default function useHandheldCapture({
  sfcwRunning, startSweep, stopSweep, sfcwParams, lidarOffsetMm,
  origin, assignment, avgMs, tilt, mount, sweepPeriodMs,
}) {
  const [grid, setGrid] = useState(loadGrid);
  const [minSweeps, setMinSweepsState] = useState(() => loadNumber(MIN_SWEEPS_KEY, 3));
  const [latencyMs, setLatencyMsState] = useState(() => loadNumber(LATENCY_KEY, 0));
  const [name, setNameState] = useState(() => {
    try { return localStorage.getItem(NAME_KEY) || 'patch_01'; } catch { return 'patch_01'; }
  });
  const [dir, setDir] = useState({ handle: null, name: null, state: fsAccessSupported() ? 'none' : 'unsupported' });
  const [nameCheck, setNameCheck] = useState({ state: 'idle', message: null });
  const [session, setSession] = useState({ active: false, playing: false, name: null });
  const [busy, setBusy] = useState(null); // 'starting' | 'ending' | null
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ ...zeroCounters(), pending: 0, captured: 0, thin: 0 });
  const [rec, setRec] = useState(null);
  const [lastSession, setLastSession] = useState(null);
  const [version, setVersion] = useState(0);
  // Measurement-timed position from the capture's own tracks, for the panel tiles (4 Hz). The
  // viewport's dot reads livePosRef every frame instead.
  const [livePos, setLivePos] = useState(null);
  // The first sweep placed in each cell, as C-scan records, for the rough output view. Published
  // as a new array only when a cell gets its first sweep. Bounded by the grid (one sweep a cell).
  const [rough, setRough] = useState({ grid: null, data: [] });

  const tracksRef = useRef(null);
  if (!tracksRef.current) tracksRef.current = createHandheldTracks();
  const writerRef = useRef(null);
  const sessionRef = useRef({ active: false, playing: false, closing: false });
  const countersRef = useRef(zeroCounters());
  const countsRef = useRef({ grid: null, counts: null });
  const pendingRef = useRef([]);
  const windowRef = useRef({ playT: Infinity, pauseT: null });
  const lastPiTRef = useRef(null);
  const versionRef = useRef(0);
  const tickRef = useRef({ n: 0, segments: 0, lastLines: 0, lastAt: 0 });
  const livePosRef = useRef(null);
  const firstRef = useRef({ grid: null, cells: null, count: 0, published: 0 });

  // Everything the socket feeds and timers read, current as of the last render.
  const live = useRef({});
  live.current = {
    grid, minSweeps, latencyMs, name, dir, sfcwRunning, startSweep, stopSweep, sfcwParams, lidarOffsetMm,
    origin, assignment, avgMs, tilt, mount, periodMs: sweepPeriodMs,
  };
  const trackCfg = () => {
    const L = live.current;
    return { origin: L.origin, assignment: L.assignment, mount: L.mount, tilt: L.tilt, latencyMs: L.latencyMs };
  };
  const configSnapshot = () => {
    const L = live.current;
    return {
      grid: { ...L.grid },
      origin: L.origin ?? null,
      lidar_assignment: L.assignment ?? null,
      lidar_latency_ms: L.latencyMs,
      tilt_correction: !!L.tilt,
      mount: L.mount ?? null,
      handheld_panel_average_ms: L.avgMs,
      lidar_antenna_offset_mm: L.lidarOffsetMm ?? null,
      sfcw_params: L.sfcwParams ?? null,
      min_sweeps_per_cell: L.minSweeps,
    };
  };

  const log = useCallback((obj) => {
    const w = writerRef.current;
    const s = sessionRef.current;
    if (!w || !s.active || s.closing) return;
    w.append(obj);
  }, []);
  const logEvent = useCallback((event, extra = {}) => {
    if (!writerRef.current || !sessionRef.current.active) return;
    countersRef.current.events++;
    writerRef.current.append({ k: 'event', rx_ms: Date.now(), event, pi_t: lastPiTRef.current, ...extra });
  }, []);

  // ── Settings ────────────────────────────────────────────────────────────
  const setGridParams = useCallback((p) => {
    if (sessionRef.current.active) return;
    setGrid((g) => {
      const next = { ...g, ...p };
      persist(GRID_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const setMinSweeps = useCallback((v) => {
    const n = Math.round(v);
    setMinSweepsState(n);
    persist(MIN_SWEEPS_KEY, String(n));
  }, []);
  const setLatencyMs = useCallback((v) => {
    const n = Math.max(LATENCY_LIMITS_MS.min, Math.min(LATENCY_LIMITS_MS.max, v));
    setLatencyMsState(n);
    persist(LATENCY_KEY, String(n));
  }, []);
  const setName = useCallback((v) => {
    if (sessionRef.current.active) return;
    setNameState(v);
    persist(NAME_KEY, v);
  }, []);

  // Positions from before and after a change of origin, wiring, mount, tilt or latency are in
  // different frames or on different clocks, so they must not be interpolated together.
  const frameKey = JSON.stringify([origin, assignment, mount, !!tilt, latencyMs]);
  useEffect(() => {
    tracksRef.current.clear();
    pendingRef.current = [];
  }, [frameKey]);

  // Any configuration change during a session is recorded.
  const configKey = JSON.stringify([origin, assignment, mount, !!tilt, latencyMs, avgMs, lidarOffsetMm, sfcwParams, minSweeps]);
  const configKeyRef = useRef(configKey);
  useEffect(() => {
    if (configKeyRef.current === configKey) return;
    configKeyRef.current = configKey;
    logEvent('config', { config: configSnapshot() });
  }, [configKey, logEvent]);

  // ── Folder ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!fsAccessSupported()) return undefined;
    let cancelled = false;
    (async () => {
      const handle = await loadDirHandle(DIR_KEY);
      if (!handle || cancelled) return;
      let perm = 'prompt';
      try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch { /* treat as prompt */ }
      if (!cancelled) setDir({ handle, name: handle.name, state: perm === 'granted' ? 'ready' : 'needs-permission' });
    })();
    return () => { cancelled = true; };
  }, []);

  const chooseFolder = useCallback(async () => {
    if (sessionRef.current.active || !fsAccessSupported()) return;
    try {
      const handle = await window.showDirectoryPicker({ id: 'handheld-capture', mode: 'readwrite' });
      setError(null);
      setDir({ handle, name: handle.name, state: 'ready' });
      saveDirHandle(DIR_KEY, handle);
    } catch (e) {
      if (e?.name !== 'AbortError') setError(`Could not open the folder: ${e?.message || e}`);
    }
  }, []);

  const reconnectFolder = useCallback(async () => {
    const h = live.current.dir.handle;
    if (!h) return;
    try {
      const perm = await h.requestPermission({ mode: 'readwrite' });
      setDir({ handle: h, name: h.name, state: perm === 'granted' ? 'ready' : 'needs-permission' });
    } catch (e) {
      setError(`Could not get access to the folder: ${e?.message || e}`);
    }
  }, []);

  // ── Name check: valid, and nothing of that name in the folder ───────────
  const checkSeq = useRef(0);
  const recheckName = useCallback(async () => {
    const seq = ++checkSeq.current;
    const { name: n, dir: d } = live.current;
    const v = validateSessionName(n);
    if (!v.ok) { setNameCheck({ state: 'invalid', message: v.message }); return; }
    if (d.state !== 'ready' || !d.handle) { setNameCheck({ state: 'nofolder', message: 'Choose a folder first.' }); return; }
    setNameCheck({ state: 'checking', message: null });
    try {
      const exists = await entryExists(d.handle, v.name);
      if (seq !== checkSeq.current) return;
      setNameCheck(exists
        ? { state: 'exists', message: `"${v.name}" already exists in this folder.` }
        : { state: 'ok', message: null });
    } catch (e) {
      if (seq === checkSeq.current) setNameCheck({ state: 'error', message: `Could not check the folder: ${e?.message || e}` });
    }
  }, []);

  useEffect(() => {
    if (session.active) return undefined;
    const id = setTimeout(recheckName, 250);
    return () => clearTimeout(id);
  }, [name, dir, session.active, recheckName]);

  useEffect(() => {
    const onFocus = () => { if (!sessionRef.current.active) recheckName(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [recheckName]);

  // ── Placement (coverage map + 'place' lines) ────────────────────────────
  const drain = useCallback((ignoreWait = false) => {
    const pending = pendingRef.current;
    const { tracks } = tracksRef.current;
    const cov = countsRef.current;
    const c = countersRef.current;
    const nowPerf = performance.now();
    while (pending.length) {
      const p = pending[0];
      const w = windowRef.current;
      if (w.pauseT != null && p.tMid > w.pauseT) { pending.shift(); continue; }
      const rx = tracks.x.at(p.tMid);
      const ry = tracks.y.at(p.tMid);
      const waiting = rx.status === 'wait' || ry.status === 'wait';
      if (waiting && !ignoreWait && nowPerf - p.arrived <= PENDING_MAX_MS) break;
      // The forward head measures at its own moments, so X and Y can bracket a sweep before it
      // does. Wait a little for it too -- otherwise about a third of sweeps got no standoff --
      // but not for long, so a forward head that is out of range does not stall placement.
      const rf = tracksRef.current.fwdMm.at(p.tMid);
      if (rf.status === 'wait' && !ignoreWait && nowPerf - p.arrived <= FWD_WAIT_MS) break;
      pending.shift();
      const rz = tracks.z.at(p.tMid);
      const x = rx.status === 'ok' ? rx.v : null;
      const y = ry.status === 'ok' ? ry.v : null;
      const cell = x != null && y != null && cov.grid ? cellAtCornerOffsetMm(x, y, cov.grid) : null;
      let reason = null;
      if (x == null || y == null) {
        c.noPosition++;
        reason = `no_position:x=${rx.reason || rx.status},y=${ry.reason || ry.status}`;
      } else if (!cell) {
        c.offGrid++;
        reason = 'off_patch';
      } else {
        c.placed++;
        const i = cell.iy * cov.grid.hCount + cell.ix;
        cov.counts[i]++;
        versionRef.current++;
        const first = firstRef.current;
        if (first.cells && !first.cells[i] && Array.isArray(p.msg.h_cal_real) && Array.isArray(p.msg.h_cal_imag)) {
          const L = live.current;
          first.cells[i] = roughCellRecord(p.msg, cell, cov.grid, {
            standoffMm: rf.status === 'ok' && Number.isFinite(L.lidarOffsetMm) ? rf.v - L.lidarOffsetMm : null,
            rangeOffset: L.sfcwParams?.rangeOffset,
            lidarOffsetMm: L.lidarOffsetMm,
            tMid: p.tMid,
          });
          first.count++;
        }
      }
      log({
        k: 'place', rx_ms: Date.now(), sweep_timestamp: p.ts, t_mid: p.tMid,
        x_mm: x, y_mm: y, z_mm: rz.status === 'ok' ? rz.v : null, fwd_mm: rf.status === 'ok' ? rf.v : null,
        ix: cell ? cell.ix : null, iy: cell ? cell.iy : null, reason,
      });
    }
  }, [log]);

  // ── Socket feeds (called by App for every message) ──────────────────────
  const onSensor = useCallback((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (Number.isFinite(msg.timestamp)) lastPiTRef.current = msg.timestamp;
    tracksRef.current.push(msg, trackCfg());
    const lp = tracksRef.current.livePosition();
    livePosRef.current = lp && Number.isFinite(msg.timestamp) && msg.timestamp - lp.t <= LIVE_POS_MAX_AGE_S ? lp : null;
    const s = sessionRef.current;
    if (!s.active || s.closing) return;
    countersRef.current.sensor++;
    log({ k: 'sensor', rx_ms: Date.now(), ...msg });
    if (pendingRef.current.length) drain();
  }, [log, drain]);

  const onSdr = useCallback((msg) => {
    const s = sessionRef.current;
    if (!s.active || s.closing || !msg || typeof msg !== 'object') return;
    if (msg.type === 'rx_data' || msg.type === 'rx_fft') return;
    const rxMs = Date.now();
    if (msg.type !== 'sfcw_result') {
      countersRef.current.sdr++;
      log({ k: 'sdr', rx_ms: rxMs, ...msg });
      return;
    }
    countersRef.current.sweeps++;
    log(sweepRecord(msg, rxMs));
    if (!s.playing || typeof msg.timestamp !== 'number') return;
    // The Pi's keep-alive for a failed FPGA read is a sweep of zeros: recorded, never placed.
    if (isEmptyDspSweep(msg)) { countersRef.current.emptySweeps++; return; }
    const tMid = sweepMidpoint(msg, live.current.periodMs);
    if (!(tMid >= windowRef.current.playT)) return;
    const pending = pendingRef.current;
    // `msg` is held only until the sweep is placed (bounded by PENDING_MAX), for the rough view.
    pending.push({ tMid, ts: msg.timestamp, arrived: performance.now(), msg });
    if (pending.length > PENDING_MAX) { pending.shift(); countersRef.current.noPosition++; }
    drain();
  }, [log, drain]);

  // ── Manifest ────────────────────────────────────────────────────────────
  const manifest = useCallback((complete) => {
    const s = sessionRef.current;
    const w = writerRef.current;
    const cov = countsRef.current;
    let captured = 0;
    let thin = 0;
    if (cov.counts) {
      for (const n of cov.counts) {
        if (n > 0) captured++;
        if (n > 0 && n < live.current.minSweeps) thin++;
      }
    }
    return JSON.stringify({
      type: CAPTURE_SESSION_TYPE,
      version: CAPTURE_SESSION_VERSION,
      name: s.name,
      complete: !!complete,
      started_at: s.startedAt,
      ended_at: complete ? new Date().toISOString() : null,
      written_at: new Date().toISOString(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      config_at_start: s.config,
      counters: { ...countersRef.current },
      coverage: cov.grid ? {
        grid: cov.grid, captured_cells: captured, thin_cells: thin,
        note: 'Sweeps placed per cell while playing, iy from the BOTTOM row; derived, for convenience.',
        counts: Array.from(cov.counts),
      } : null,
      segments: w ? w.segments() : [],
      format: FORMAT_NOTES,
    }, null, 1);
  }, []);

  // ── Timers: placement expiry, stats, flush, manifest ────────────────────
  const publish = useCallback(() => {
    const cov = countsRef.current;
    let captured = 0;
    let thin = 0;
    if (cov.counts) {
      const min = live.current.minSweeps;
      for (const n of cov.counts) { if (n > 0) captured++; if (n > 0 && n < min) thin++; }
    }
    const next = { ...countersRef.current, pending: pendingRef.current.length, captured, thin };
    setStats((prev) => (Object.keys(next).every(k => prev[k] === next[k]) ? prev : next));
    setVersion((v) => (v === versionRef.current ? v : versionRef.current));
    const lp = livePosRef.current;
    setLivePos((prev) => {
      if (!lp) return prev ? null : prev;
      return prev && Math.abs(prev.x - lp.x) < 0.5 && Math.abs(prev.y - lp.y) < 0.5 ? prev : { x: lp.x, y: lp.y };
    });
    const first = firstRef.current;
    if (first.cells && first.count !== first.published) {
      first.published = first.count;
      setRough({ grid: first.grid, data: first.cells.filter(Boolean) });
    }
    const w = writerRef.current;
    if (w) {
      const st = w.stats();
      const t = tickRef.current;
      const nowMs = Date.now();
      let linesPerS = t.linesPerS || 0;
      if (nowMs - t.lastAt >= 1000) {
        linesPerS = t.lastAt ? ((st.lines - t.lastLines) * 1000) / (nowMs - t.lastAt) : 0;
        t.lastLines = st.lines;
        t.lastAt = nowMs;
        t.linesPerS = linesPerS;
      }
      setRec({ ...st, linesPerS, backlogAlarm: st.backlogBytes > BACKLOG_ALARM_BYTES });
    }
  }, []);

  useEffect(() => { publish(); }, [minSweeps, publish]);

  // Outside a session the tick below is off, but the panel still shows where the module is.
  useEffect(() => {
    if (session.active) return undefined;
    const id = setInterval(() => {
      const lp = livePosRef.current;
      setLivePos((prev) => {
        if (!lp) return prev ? null : prev;
        return prev && Math.abs(prev.x - lp.x) < 0.5 && Math.abs(prev.y - lp.y) < 0.5 ? prev : { x: lp.x, y: lp.y };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [session.active]);

  useEffect(() => {
    if (!session.active) return undefined;
    const id = setInterval(() => {
      const t = tickRef.current;
      t.n++;
      drain();
      const w = writerRef.current;
      if (w && t.n % FLUSH_EVERY_TICKS === 0) w.flush();
      const segs = w ? w.stats().segments : 0;
      if (w && (segs !== t.segments || t.n % MANIFEST_EVERY_TICKS === 0) && !sessionRef.current.closing) {
        t.segments = segs;
        w.writeFile(MANIFEST, manifest(false));
      }
      publish();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [session.active, drain, publish, manifest]);

  useEffect(() => {
    if (!session.active) return undefined;
    const onBefore = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [session.active]);

  // ── Session ─────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (sessionRef.current.active || busy) return;
    const L = live.current;
    setError(null);
    const v = validateSessionName(L.name);
    if (!v.ok) { setError(v.message); return; }
    if (L.dir.state !== 'ready' || !L.dir.handle) { setError('Choose a folder first.'); return; }
    setBusy('starting');
    let created = false;
    try {
      if (await entryExists(L.dir.handle, v.name)) {
        setNameCheck({ state: 'exists', message: `"${v.name}" already exists in this folder.` });
        setError(`"${v.name}" already exists in this folder. Pick another name.`);
        return;
      }
      const sessionDir = await L.dir.handle.getDirectoryHandle(v.name, { create: true });
      created = true;
      writerRef.current = createSessionWriter(sessionDir);
      countersRef.current = zeroCounters();
      countsRef.current = { grid: { ...L.grid }, counts: new Uint32Array(L.grid.hCount * L.grid.vCount) };
      firstRef.current = { grid: { ...L.grid }, cells: new Array(L.grid.hCount * L.grid.vCount).fill(null), count: 0, published: 0 };
      setRough({ grid: { ...L.grid }, data: [] });
      pendingRef.current = [];
      windowRef.current = { playT: Infinity, pauseT: null };
      tickRef.current = { n: 0, segments: 0, lastLines: 0, lastAt: 0 };
      versionRef.current++;
      sessionRef.current = {
        active: true, playing: false, closing: false, name: v.name,
        startedAt: new Date().toISOString(), config: configSnapshot(), startedSweep: false,
      };
      configKeyRef.current = JSON.stringify([L.origin, L.assignment, L.mount, !!L.tilt, L.latencyMs, L.avgMs, L.lidarOffsetMm, L.sfcwParams, L.minSweeps]);
      // Proves the folder is writable before anything is scanned, and claims the name.
      if (!(await writerRef.current.writeFile(MANIFEST, manifest(false)))) {
        throw new Error(writerRef.current.stats().lastError || 'the first write failed');
      }
      logEvent('session_start', { config: sessionRef.current.config });
      if (!L.sfcwRunning) {
        L.startSweep();
        sessionRef.current.startedSweep = true;
        logEvent('sfcw_start_requested');
      }
      setSession({ active: true, playing: false, name: v.name });
      setLastSession(null);
      publish();
    } catch (e) {
      sessionRef.current = { active: false, playing: false, closing: false };
      writerRef.current = null;
      if (created) {
        try { await L.dir.handle.removeEntry(v.name, { recursive: true }); } catch { /* leave it */ }
      }
      setError(`Could not start: ${e?.message || e}`);
    } finally {
      setBusy(null);
    }
  }, [busy, manifest, logEvent, publish]);

  const togglePlay = useCallback(() => {
    const s = sessionRef.current;
    if (!s.active || s.closing) return;
    const piT = lastPiTRef.current;
    if (s.playing) {
      windowRef.current = { ...windowRef.current, pauseT: piT ?? -Infinity };
      sessionRef.current = { ...s, playing: false };
      logEvent('pause');
      writerRef.current?.flush();
    } else {
      windowRef.current = { playT: piT ?? -Infinity, pauseT: null };
      pendingRef.current = [];
      sessionRef.current = { ...s, playing: true };
      logEvent('play');
    }
    setSession((prev) => ({ ...prev, playing: sessionRef.current.playing }));
    publish();
  }, [logEvent, publish]);

  const noteOriginSet = useCallback((detail) => logEvent('origin_set', detail), [logEvent]);

  const end = useCallback(async () => {
    const s = sessionRef.current;
    if (!s.active || busy) return;
    setBusy('ending');
    setError(null);
    try {
      if (!s.closing) {
        if (s.playing) {
          windowRef.current = { ...windowRef.current, pauseT: lastPiTRef.current ?? -Infinity };
          sessionRef.current = { ...sessionRef.current, playing: false };
          setSession((prev) => ({ ...prev, playing: false }));
          logEvent('pause');
        }
        if (sessionRef.current.startedSweep && live.current.sfcwRunning) {
          live.current.stopSweep();
          logEvent('sfcw_stop_requested');
        }
        // Let the last sweeps, measurements and the Pi's status reply arrive and be recorded.
        await new Promise((r) => setTimeout(r, 400));
        drain(true);
        logEvent('session_end', { counters: { ...countersRef.current } });
        sessionRef.current = { ...sessionRef.current, closing: true };
      }
      const w = writerRef.current;
      const okData = await w.finish();
      const okManifest = await w.writeFile(MANIFEST, manifest(okData));
      publish();
      if (!okData || !okManifest) {
        setError(`Saving failed (${w.stats().lastError || 'unknown error'}). The data is still in memory: fix the folder and press End session again.`);
        return;
      }
      const cur = sessionRef.current;
      setLastSession({ name: cur.name, lines: w.stats().lines, bytes: w.stats().writtenBytes, segments: w.stats().segments });
      sessionRef.current = { active: false, playing: false, closing: false };
      writerRef.current = null;
      pendingRef.current = [];
      setSession({ active: false, playing: false, name: null });
      const next = nextSessionName(cur.name);
      setNameState(next);
      persist(NAME_KEY, next);
    } finally {
      setBusy(null);
    }
  }, [busy, drain, logEvent, manifest, publish]);

  const restartSweep = useCallback(() => {
    const s = sessionRef.current;
    if (!s.active || s.closing || live.current.sfcwRunning) return;
    live.current.startSweep();
    sessionRef.current = { ...s, startedSweep: true };
    logEvent('sfcw_start_requested');
  }, [logEvent]);

  return {
    grid, setGridParams, minSweeps, setMinSweeps, latencyMs, setLatencyMs,
    name, setName, nameCheck, recheckName,
    dir, chooseFolder, reconnectFolder,
    session, busy, error, stats, rec, lastSession,
    start, end, togglePlay, restartSweep, noteOriginSet,
    onSensor, onSdr, countsRef, version, livePos, livePosRef, rough,
  };
}
