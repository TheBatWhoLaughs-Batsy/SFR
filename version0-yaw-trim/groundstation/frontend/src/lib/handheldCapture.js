// Handheld Capture panel: record EVERYTHING from a hand-held scan of a wall patch, raw, for
// post-processing. Nothing is averaged, binned or thrown away.
//
// Pure (no React, no DOM), so it can be checked from node.
//
// WHAT IS RECORDED (one JSON object per line, see lib/captureWriter.js):
//   k: 'sweep'   every sfcw_result exactly as received, BEFORE App.jsx's guards touch it
//                (so range_offset is the Pi's own), minus the Pi range profile
//                (distances/magnitudes, which are a function of h_cal, step_size and
//                range_offset). h_cal is full float64 precision when the Pi sends binary
//                frames (h_cal_precision 'float64'), else the 8-decimal JSON values.
//   k: 'sensor'  every packet from the sensor stream (port 9001) exactly as received:
//                all LiDAR heads with seq/ts/err, accel, gyro, quat, yaw, timestamps.
//   k: 'sdr'     every other message on the SDR socket except the RF Calib panel's
//                rx_data/rx_fft streams (sfcw_status, sfcw_error, errors, ...).
//   k: 'place'   DERIVED, for convenience only: where this app put a sweep (position at
//                its midpoint and the cell), written while playing. Recomputable from the
//                raw sweep and sensor lines.
//   k: 'event'   session start/end, play/pause, origin set, any config change.
// Every line carries `rx_ms`, the browser's wall clock when it arrived. `timestamp` and the
// per-head `ts` inside the raw lines are the Pi's time.time().
//
// POSITION (for the coverage map and the 'place' lines). Each axis is its own track, built
// only from NEW measurements -- a head's `seq` advancing -- and stamped with that head's own
// `ts`, the Pi time the measurement first appeared (stream.py lidar_poll_loop), minus an
// operator-set extra latency. So:
//   - the LiDAR lag is corrected: a packet repeats the last measurement for up to ~90 ms,
//     and timing positions by the PACKET put them that far behind, in the direction of
//     motion (~15 mm at 200 mm/s, opposite on the return pass);
//   - a head that stops measuring stops adding points, so its track goes stale and sweeps
//     are refused rather than filed at a position frozen by the carried reading;
//   - no averaging window, so no averaging lag.
// Tilt correction per measurement is the Handheld panel's own (axisPositionMm).
//
// FRAME. mm from the origin, x right, y UP, z forward. The origin is the TOP-LEFT CORNER of
// the patch: column ix = floor(x / hStep), row-from-top = floor(-y / vStep); cells use the
// C-scan frame (ix = 0 left column, iy = 0 BOTTOM row).

import { HANDHELD_AXES, axisPositionMm, lidarsByUart } from './handheldPose.js';

export const CAPTURE_SESSION_TYPE = 'handheld_capture_session';
export const CAPTURE_SESSION_VERSION = 2;
export const CAPTURE_GRID_LIMITS = { countMin: 1, countMax: 200, stepMin: 0.5, stepMax: 50 };
export const DEFAULT_CAPTURE_GRID = { hCount: 10, hStep: 5, vCount: 10, vStep: 5 };
export const LATENCY_LIMITS_MS = { min: 0, max: 300 };

// A moving head reports a new value every 60-90 ms; a still one republishes every 250 ms
// (stream.py LIDAR_STABLE_REPUBLISH_S). Wider than this and the head has stopped measuring.
export const AXIS_GAP_MAX_S = 0.35;
export const AXIS_KEEP_S = 5;
// How long a sweep may wait (browser time) for both axes to have a measurement after it.
export const PENDING_MAX_MS = 1000;
export const PENDING_MAX = 512;

/** The cell under a point in mm from the patch's top-left corner (x right, y up), or null. */
export function cellAtCornerOffsetMm(xMm, yMm, grid) {
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return null;
  const ix = Math.floor(xMm / (grid.hStep * 10));
  const r = Math.floor(-yMm / (grid.vStep * 10));
  if (!(ix >= 0 && ix < grid.hCount && r >= 0 && r < grid.vCount)) return null;
  return { ix, iy: grid.vCount - 1 - r };
}

/** One axis's measurement track on the Pi clock. */
export function createAxisTrack(gapMaxS = AXIS_GAP_MAX_S, keepS = AXIS_KEEP_S) {
  let pts = [];
  return {
    push(t, v) {
      if (!Number.isFinite(t) || !Number.isFinite(v)) return;
      const last = pts[pts.length - 1];
      if (last) {
        if (t === last.t) { pts[pts.length - 1] = { t, v }; return; }
        if (t < last.t) pts = []; // Pi clock went backwards (restart)
      }
      pts.push({ t, v });
      let drop = 0;
      while (drop < pts.length - 1 && t - pts[drop].t > keepS) drop++;
      if (drop) pts.splice(0, drop);
    },
    clear() { pts = []; },
    size() { return pts.length; },
    latestT() { return pts.length ? pts[pts.length - 1].t : null; },
    /** { status: 'ok', v } | { status: 'wait' } | { status: 'none', reason } */
    at(t) {
      if (!pts.length) return { status: 'wait' };
      const last = pts[pts.length - 1];
      if (t > last.t) return { status: 'wait' };
      if (t < pts[0].t) return { status: 'none', reason: 'too_old' };
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].t <= t) lo = mid; else hi = mid;
      }
      const a = pts[lo];
      const b = pts[hi];
      if (b.t - a.t > gapMaxS) return { status: 'none', reason: 'gap' };
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { status: 'ok', v: a.v + f * (b.v - a.v) };
    },
  };
}

/** Position tracks for all three axes, fed with raw sensor packets, plus the forward head's
 *  RAW distance (`fwdMm`): the standoff a background model is indexed by is the plain LiDAR
 *  reading minus the antenna offset, not a tilt-corrected position, and it needs no origin. */
export function createHandheldTracks() {
  const tracks = Object.fromEntries(HANDHELD_AXES.map((a) => [a.key, createAxisTrack()]));
  const fwdMm = createAxisTrack();
  const lastSeq = {};
  return {
    tracks,
    fwdMm,
    clear() {
      for (const t of Object.values(tracks)) t.clear();
      fwdMm.clear();
      for (const k of Object.keys(lastSeq)) delete lastSeq[k];
    },
    /** The newest position both X and Y can give: at the older of the two axes' latest
     *  measurements, so neither is extrapolated. { x, y, t } or null. */
    livePosition() {
      const tx = tracks.x.latestT();
      const ty = tracks.y.latestT();
      if (tx == null || ty == null) return null;
      const t = Math.min(tx, ty);
      const rx = tracks.x.at(t);
      const ry = tracks.y.at(t);
      if (rx.status !== 'ok' || ry.status !== 'ok') return null;
      return { x: rx.v, y: ry.v, t };
    },
    /** Adds the measurements that are NEW in this packet. `cfg`: { origin, assignment, mount,
     *  tilt, latencyMs }. Returns how many points were added. */
    push(msg, cfg) {
      if (!msg || !msg.lidars || typeof msg.lidars !== 'object') return 0;
      const byUart = lidarsByUart(msg);
      let added = 0;
      for (const a of HANDHELD_AXES) {
        const uart = cfg.assignment?.[a.lidar];
        const l = uart ? byUart[uart] : null;
        if (!l || l.seq == null || !Number.isFinite(l.ts)) continue;
        if (lastSeq[a.key] === l.seq) continue;
        lastSeq[a.key] = l.seq;
        // seq only advances on a valid read, and last_good_mm is that read's value.
        const mm = Number.isFinite(l.last_good_mm) ? l.last_good_mm : l.mm;
        const t = l.ts - (cfg.latencyMs || 0) / 1000;
        if (a.lidar === 'fwd') fwdMm.push(t, mm);
        const p = axisPositionMm(a.key, mm, msg.quat, cfg.origin, { mount: cfg.mount, tilt: cfg.tilt });
        if (p == null) continue;
        tracks[a.key].push(t, p);
        added++;
      }
      return added;
    },
  };
}

const FULL_PRECISION_KEYS = new Set(['distances', 'magnitudes', 'h_cal_real', 'h_cal_imag']);

/** The raw record for one sweep. Reads keys without touching the decoder's lazy profile
 *  getters (Object.keys does not invoke them), so recording costs no IFFT. */
export function sweepRecord(msg, rxMs) {
  const rec = { k: 'sweep', rx_ms: rxMs };
  for (const key of Object.keys(msg)) {
    if (FULL_PRECISION_KEYS.has(key)) continue;
    rec[key] = msg[key];
  }
  const fullRe = msg.h_cal_full_real;
  const fullIm = msg.h_cal_full_imag;
  if (fullRe && fullIm) {
    rec.h_cal_real = Array.from(fullRe);
    rec.h_cal_imag = Array.from(fullIm);
    rec.h_cal_precision = 'float64';
  } else {
    rec.h_cal_real = msg.h_cal_real ?? null;
    rec.h_cal_imag = msg.h_cal_imag ?? null;
    rec.h_cal_precision = 'json';
  }
  return rec;
}

/** A C-scan cell record from ONE sweep, for the rough output view (lib/bscanBg.js applyBscanBg
 *  and lib/cscanGrid.js read these fields). `rangeOffset` is the panel's, as the C-scan records
 *  it; `standoffMm` is the forward LiDAR at the sweep midpoint minus the antenna offset. */
export function roughCellRecord(msg, cell, grid, { standoffMm, rangeOffset, lidarOffsetMm, tMid }) {
  return {
    h_cal_real: msg.h_cal_real.slice(),
    h_cal_imag: msg.h_cal_imag.slice(),
    num_steps: msg.num_steps ?? msg.h_cal_real.length,
    step_size: msg.step_size,
    start_freq: msg.start_freq,
    range_offset: Number.isFinite(rangeOffset) ? rangeOffset : msg.range_offset,
    lidar_standoff_mm: Number.isFinite(standoffMm) ? standoffMm : null,
    lidar_offset_mm: lidarOffsetMm ?? null,
    grid_ix: cell.ix,
    grid_iy: cell.iy,
    x_cm: cell.ix * grid.hStep,
    y_cm: cell.iy * grid.vStep,
    timestamp: msg.timestamp,
    t_mid: tMid,
  };
}

/** Sweep midpoint on the Pi clock. `timestamp` is stamped when the sweep ends. */
export function sweepMidpoint(msg, periodMs) {
  const p = Number.isFinite(periodMs) && periodMs > 0 && periodMs < 2000 ? periodMs : 30;
  return msg.timestamp - p / 2000;
}

export const isEmptyDspSweep = (msg) => msg.sweep_core === 'fallback'
  && Array.isArray(msg.h_cal_real) && msg.h_cal_real.length > 0
  && msg.h_cal_real.every((v, i) => v === 0 && msg.h_cal_imag?.[i] === 0);

// ── Names ─────────────────────────────────────────────────────────────────

const BAD_CHARS = /[\\/:*?"<>| -]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** `{ ok, name, message }` for a session name typed by the operator (it becomes a folder). */
export function validateSessionName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, name: null, message: 'Enter a name.' };
  if (BAD_CHARS.test(name)) return { ok: false, name: null, message: 'Not allowed in a name: \\ / : * ? " < > |' };
  if (name.startsWith('.') || name.endsWith('.')) return { ok: false, name: null, message: 'A name cannot start or end with a dot.' };
  if (RESERVED.test(name)) return { ok: false, name: null, message: 'That name is reserved by Windows.' };
  if (name.length > 120) return { ok: false, name: null, message: 'Name is too long (120 characters max).' };
  return { ok: true, name, message: null };
}

/** "wall_A_07" -> "wall_A_08", keeping zero padding. Unchanged without a trailing number. */
export function nextSessionName(raw) {
  const name = String(raw ?? '').trim();
  const m = name.match(/^(.*?)(\d+)$/);
  if (!m) return name;
  return `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}`;
}

export const FORMAT_NOTES = {
  layout: 'session.json (this manifest) plus stream_NNNNNN.jsonl segments; concatenate the segments '
    + 'in order for the full stream. One JSON object per line.',
  kinds: {
    sweep: 'Every sfcw_result as received from the Pi, before any groundstation processing. The Pi '
      + 'range profile (distances, magnitudes) is omitted: recompute it from h_cal, step_size and '
      + 'range_offset (Hanning window, IFFT zero-padded to 4x, as sfcw_engine does). h_cal_precision '
      + 'says whether h_cal is full float64 or the 8-decimal JSON values. timestamp is the Pi time the '
      + 'sweep ENDED.',
    sensor: 'Every sensor-stream packet as received: lidars.<uart>.{mm, seq, ts, err, last_good_mm, '
      + 'last_good_age_s}, quat, accel, gyro, yaw_deg, timestamp. seq advances once per distinct '
      + 'measurement and ts is the Pi time it first appeared.',
    sdr: 'Every other SDR-socket message (status, errors), excluding the RF Calib rx_data/rx_fft streams.',
    place: 'DERIVED by this app: t_mid (Pi time of the sweep midpoint), x/y/z mm from the origin at '
      + 't_mid, interpolated per axis between LiDAR measurements timed by their own ts minus '
      + 'lidar_latency_ms, and the cell (ix, iy). Null fields when no position was available.',
    event: 'Session events and configuration changes.',
  },
  frame: 'Origin is the TOP-LEFT CORNER of the patch. x right, y UP (negative going down), z forward, mm. '
    + 'Cells: ix from the left column, iy from the BOTTOM row.',
  clocks: 'rx_ms is the browser wall clock (Date.now()) at arrival. timestamp / ts / t_mid are the Pi time.time().',
};
