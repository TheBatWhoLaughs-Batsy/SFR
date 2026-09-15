// Handheld positioning from three mutually perpendicular TF-LC02 LiDARs.
//
// Each LiDAR measures the distance to whatever surface it points at. With the
// module in a room corner-like setting (a wall ahead, a wall to the right, the
// floor below), moving the module along one axis changes only that axis's
// distance, so position along the axis is simply
//
//     pos = distance at origin - distance now
//
// Frame: X right, Y UP, Z forward. X and Z are positive in the direction their
// LiDAR points; Y is positive UP (operator's choice, 2026-09-15), so its sign is flipped:
//   X: the RIGHT-facing LiDAR.  Moving right shortens it -> +x.
//   Y: the DOWN-facing LiDAR.   Moving UP lengthens it   -> +y (sign -1).
//   Z: the FORWARD LiDAR.
// Which UART each one is on is an operator setting, see DEFAULT_ASSIGNMENT.
//
// ROTATION is corrected, since 2026-09-15, using the BNO085's game rotation
// vector -- tilting by theta lengthens every beam by 1/cos(theta), which is
// 28 mm on a 800 mm reading at 15 deg and dwarfs the sub-millimetre sensor noise
// the averaging window was tuned against. handheldTilt.js holds the geometry,
// the calibration that finds where each beam points relative to the IMU, and the
// measurement of what each part of it is worth. It degrades to the uncorrected
// reading whenever the orientation is missing, so a Pi with no IMU behaves
// exactly as before.
//
// Limits of this rough version, all worth knowing before trusting a number:
//   - The tilt correction assumes the module was held SQUARE to its surfaces when
//     the origin was declared; that residual is `tan(origin error)*tan(tilt)` and
//     is why the panel shows each axis's live tilt. See handheldTilt.js.
//   - It assumes each beam keeps hitting the SAME flat surface. Sliding past the
//     edge of a table or a doorway is a step in that axis, not motion.
//   - Nothing here is Pi-side: the Pi only streams distances, the origin lives
//     on the groundstation (same rule as background subtraction).

import { qNormalize, qRelative, beamGeometry } from './handheldTilt';

// `vNominal` is where each beam points in the IMU's own sensor frame, taken from
// imu_calibration.py's R_ACCEL remap (forward = -imu_x, left = +imu_z, up =
// +imu_y). It is the starting point for the tilt calibration and the fallback
// when there is none -- and a rough mount is nearly as good as a calibrated one
// for the obliquity correction, which is why tilt compensation does not wait for
// a calibration. See handheldTilt.js for the measured sensitivity table.
export const HANDHELD_AXES = [
  { key: 'x', lidar: 'right', label: 'X', dir: 'right',   name: 'Right',   sign: 1,  vNominal: [0, 0, -1] },
  { key: 'y', lidar: 'down',  label: 'Y', dir: 'up',      name: 'Down',    sign: -1, vNominal: [0, -1, 0] },
  { key: 'z', lidar: 'fwd',   label: 'Z', dir: 'forward', name: 'Forward', sign: 1,  vNominal: [-1, 0, 0] },
];

// Which UART each direction's LiDAR is wired to, as confirmed by the operator on
// 2026-09-15: right on UART3, forward on UART2, down on UART1. Editable in the panel.
// The forward one must match stream.py's PRIMARY (LIDAR_PORTS_DEFAULT[0]), which is
// the standoff everything else reads; the panel warns when they disagree.
export const DEFAULT_ASSIGNMENT = { fwd: 'uart2', right: 'uart3', down: 'uart1' };
export const UART_CHOICES = ['uart0', 'uart1', 'uart2', 'uart3', 'uart4'];

// How long a failed read may carry the last good reading forward. Matches
// App.jsx's LIDAR_CARRY_MS and stream.py's LIDAR_DROPOUT_WARN_S: scattered
// invalid returns (30-40% of reads at a poor angle on this bench) must not make
// the position flicker, but a sensor dark for longer than this is not current.
export const HANDHELD_CARRY_S = 1.0;

// A reading carried forward may seed the origin only if it is this fresh. The
// `mm` field goes null on a single failed read, so requiring a LIVE value would
// make "set origin" fail at random ~1 click in 4; a quarter second is at most a
// few mm of hand motion.
export const ORIGIN_MAX_AGE_S = 0.25;

// Averaging window for the displayed distances and position. Measured on the
// bench 2026-09-15 (60 s, module still, forward uart2 / down uart1; each head
// reports a new value 11-13 times a second, 1 mm quantisation):
//
//   window (ms)          0     100    250    500    1000
//   noise (mm)         0.7-1.0 0.5-0.75 ~0.5 0.35-0.45 ~0.3
//   frame-to-frame p95  1-2    0.4-0.6  ~0.2  ~0.1    ~0.05
//   lag (ms)             0      50    125    250     500
//
// 250 ms removes nearly all the visible flicker for ~125 ms of lag. The operator
// chose 100 ms as the default (half the lag, some flicker left). Past ~500 ms the
// noise barely falls (a drift floor, also seen in lidar_noise_char.py) while the lag
// keeps growing.
export const AVERAGE_WINDOWS_MS = [0, 100, 250, 500, 1000];
export const DEFAULT_AVERAGE_MS = 100;
const HISTORY_KEEP_S = 1.5;

// v2 for the assignment: under v1 the default had forward and down swapped, so a
// saved v1 origin holds each axis's reference from the wrong LiDAR.
// v3 for the origin: it now carries the ORIENTATION each axis's reference was
// taken at, which tilt compensation measures against. A v2 origin has none, and
// silently reusing it would leave the correction referenced to whatever attitude
// the module happens to be in at page load.
const ORIGIN_KEY = 'handheld_origin_v3';
const ASSIGNMENT_KEY = 'handheld_lidar_assignment_v2';
const MOUNT_KEY = 'handheld_mount_v1';
const TILT_KEY = 'handheld_tilt_enabled_v1';
// v2 so a browser holding the old 250 ms default picks up the new one.
const AVERAGE_KEY = 'handheld_average_ms_v2';
const LEGACY_KEY = 'legacy:fwd';

// The UART a `lidars` entry comes from. stream.py keys entries by UART
// ({uart1, uart2, uart3}); an older version keyed them by role but carried the
// port. Both resolve to a UART name here, and the assignment gives each a role.
function uartOf(key, l) {
  if (/^uart\d+$/.test(key)) return key;
  const m = /ttyAMA(\d+)$/.exec(l?.port ?? '');
  return m ? `uart${m[1]}` : null;
}

/** The packet's `lidars` re-keyed by UART name. Exported because the tilt
 *  calibration in App.jsx needs the same mapping, and a second copy of it is the
 *  drift hazard this repo already records for CFAR and the TF-LC02 parsers. */
export function lidarsByUart(msg) {
  const byUart = {};
  for (const [key, l] of Object.entries(msg.lidars)) {
    const u = uartOf(key, l);
    if (u && !byUart[u]) byUart[u] = l;
  }
  return byUart;
}

/** Normalises the sensor packet to `{ legacy, lidars: {fwd, right, down}, uarts }`.
 *  A Pi whose stream.py predates the handheld LiDARs has no `lidars` field; its
 *  single forward LiDAR is read from the legacy `lidar_*` fields instead. */
export function readHandheldLidars(msg, assignment = DEFAULT_ASSIGNMENT) {
  if (!msg) return null;
  if (msg.lidars && typeof msg.lidars === 'object') {
    const byUart = lidarsByUart(msg);
    const lidars = {};
    for (const a of HANDHELD_AXES) lidars[a.lidar] = byUart[assignment?.[a.lidar]] ?? null;
    return { legacy: false, lidars, uarts: Object.keys(byUart).sort() };
  }
  return {
    legacy: true,
    uarts: [],
    lidars: {
      fwd: {
        present: true,
        port: null,
        mm: msg.lidar ?? null,
        seq: msg.lidar_seq ?? null,
        ts: msg.lidar_ts ?? null,
        err: msg.lidar_err ?? null,
        last_good_mm: msg.lidar_last_good_mm ?? null,
        last_good_age_s: msg.lidar_last_good_age_s ?? null,
      },
    },
  };
}

/** One LiDAR's usable reading: live, held (carried forward), lost or absent. */
export function axisReading(l) {
  if (!l) return { status: 'absent', mm: null, ageS: null, err: null, port: null };
  const port = l.port ?? null;
  if (l.present === false) {
    return { status: 'absent', mm: null, ageS: null, err: l.err ?? null, port };
  }
  if (Number.isFinite(l.mm)) return { status: 'live', mm: l.mm, ageS: 0, err: null, port };
  const age = l.last_good_age_s;
  if (Number.isFinite(l.last_good_mm) && Number.isFinite(age) && age <= HANDHELD_CARRY_S) {
    return { status: 'held', mm: l.last_good_mm, ageS: age, err: l.err ?? null, port };
  }
  return {
    status: 'lost', mm: null,
    ageS: Number.isFinite(age) ? age : null,
    err: l.err ?? null, port,
  };
}

/** Per-LiDAR history of valid readings, fed with EVERY sensor packet (50 Hz), for
 *  averaging and for the measurement rate. Packets arrive at a steady rate, so a
 *  plain mean over the packets in a window is a time-weighted mean of the value. */
export function createLidarHistory() {
  const samples = {};  // key -> [{t, mm, q}]
  const rates = {};    // key -> measurement-rate tracker
  const record = (key, t, l, q) => {
    if (Number.isFinite(l?.mm)) {
      const arr = samples[key] || (samples[key] = []);
      arr.push({ t, mm: l.mm, q });
      let drop = 0;
      while (drop < arr.length && t - arr[drop].t > HISTORY_KEEP_S) drop++;
      if (drop) arr.splice(0, drop);
    }
    const r = rates[key] || (rates[key] = createMeasurementRate());
    r.push(l?.seq, l?.ts);
  };
  return {
    push(msg) {
      const t = msg?.timestamp;
      if (!Number.isFinite(t)) return;
      // The orientation is stamped onto every sample rather than read once at
      // use time. The averaging window is up to a second long, and the tilt
      // correction is a function of BOTH the range and the attitude it was taken
      // at -- correcting the averaged range with the latest attitude would put a
      // whole window's worth of hand rotation onto one reading (at 30 deg/s and
      // a 100 ms window that is ~5 mm on 800).
      const q = qNormalize(msg.quat);
      if (msg.lidars && typeof msg.lidars === 'object') {
        for (const [u, l] of Object.entries(lidarsByUart(msg))) record(u, t, l, q);
      } else if (msg.lidar !== undefined) {
        record(LEGACY_KEY, t, { mm: msg.lidar, seq: msg.lidar_seq, ts: msg.lidar_ts }, q);
      }
    },
    /** Mean over the window. `transform(mm, q)` maps each sample before it is
     *  averaged (the tilt correction); a sample it rejects is skipped, so a burst
     *  of past-grazing attitudes thins the average rather than poisoning it. */
    average(key, nowT, windowMs, transform = null) {
      const arr = samples[key];
      if (!arr || !Number.isFinite(nowT)) return null;
      let sum = 0, n = 0;
      for (let i = arr.length - 1; i >= 0 && nowT - arr[i].t <= windowMs / 1000; i--) {
        if (arr[i].t > nowT) continue;
        const v = transform ? transform(arr[i].mm, arr[i].q) : arr[i].mm;
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      return n ? sum / n : null;
    },
    hz(key, nowT) {
      return rates[key]?.hz(nowT) ?? null;
    },
  };
}

/** The calibrated beam direction of each axis in the IMU sensor frame, falling
 *  back to the nominal mount where there is no calibration for that axis. */
export function mountVectors(mount) {
  const out = {};
  for (const a of HANDHELD_AXES) {
    const v = mount?.axes?.[a.key]?.v;
    out[a.key] = Array.isArray(v) && v.length === 3 ? v : a.vNominal;
  }
  return out;
}

/** Position of the module relative to `origin`.
 *
 *  `origin` is `{ x, y, z, q: { x, y, z } }` -- each axis's reference distance in
 *  mm and the ORIENTATION it was taken at. The quaternions are per axis, not one
 *  for the whole origin, because "set origin" may refresh only the axes that had
 *  a fresh reading and leave the others on a reference taken in some earlier
 *  pose; a single shared quaternion would then be wrong for those.
 *
 *  With `history` and `windowMs` > 0, distances are averaged over that window;
 *  the unaveraged reading is kept as `rawMm`.
 *
 *  Tilt compensation turns each measured range into the PERPENDICULAR distance
 *  before differencing -- see handheldTilt.js. It needs an orientation now and an
 *  orientation at the origin; missing either, that axis silently falls back to
 *  the raw difference, which is what this function has always computed. */
export function computeHandheldPosition(msg, origin, assignment = DEFAULT_ASSIGNMENT,
  { history = null, windowMs = 0, mount = null, tilt = true, lever = null } = {}) {
  const src = readHandheldLidars(msg, assignment);
  const nowT = msg?.timestamp;
  const quat = qNormalize(msg?.quat);
  const vByAxis = mountVectors(mount);
  const axes = {};
  const pos = {};
  let tiltActive = false;
  for (const a of HANDHELD_AXES) {
    const r = axisReading(src?.lidars?.[a.lidar] ?? null);
    const uart = src?.legacy ? null : (assignment?.[a.lidar] ?? null);
    const histKey = src?.legacy ? (a.lidar === 'fwd' ? LEGACY_KEY : null) : uart;
    const rawMm = r.mm;
    const v = vByAxis[a.key];
    const q0 = qNormalize(origin?.q?.[a.key]);
    const arm = lever?.[a.key] ?? null;
    // One place decides whether this axis is corrected, so the live tilt readout
    // and the number the position is built from can never disagree.
    const on = !!(tilt && q0 && quat);
    const geomAt = (mm, q) => beamGeometry(v, on && q ? qRelative(q0, q) : null, mm, arm);

    let mm = rawMm;
    let hMm = rawMm == null ? null : geomAt(rawMm, quat).hMm;
    if (rawMm != null && history && windowMs > 0 && histKey) {
      mm = history.average(histKey, nowT, windowMs) ?? rawMm;
      // Correct each sample at ITS OWN attitude, then average; see the history.
      hMm = history.average(histKey, nowT, windowMs, (d, q) => {
        const g = geomAt(d, q);
        return g.hMm == null ? null : g.hMm + g.leverMm;
      }) ?? hMm;
    } else if (hMm != null) {
      hMm += geomAt(rawMm, quat).leverMm;
    }

    const live = geomAt(rawMm ?? 1000, quat);
    const corrected = on && live.available;
    if (corrected) tiltActive = true;
    const hz = history && histKey ? history.hz(histKey, nowT) : null;
    const originMm = Number.isFinite(origin?.[a.key]) ? origin[a.key] : null;
    const usedMm = corrected && hMm != null ? hMm : mm;
    const posMm = usedMm != null && originMm != null ? a.sign * (originMm - usedMm) : null;
    axes[a.key] = {
      ...a, ...r, mm, rawMm, hz, uart, originMm, posMm,
      // Tilt provenance, so the panel reports what was done rather than what was
      // asked for: `corrected` is false when the axis fell back for any reason.
      corrected,
      tiltDeg: on ? live.tiltDeg : null,
      perpMm: corrected ? hMm : null,
      tiltGainMm: corrected && mm != null && hMm != null ? hMm - mm : null,
      grazing: on && !live.available,
    };
    pos[a.key] = posMm;
  }
  return {
    connected: !!msg,
    legacy: src?.legacy ?? false,
    uarts: src?.uarts ?? [],
    primary: msg?.lidar_primary ?? null,
    windowMs,
    quat,
    hasOrientation: !!quat,
    tiltRequested: !!tilt,
    tiltActive,
    calibrated: !!mount,
    axes,
    pos,
  };
}

/** New origin from the current readings. Axes with no fresh reading keep
 *  whatever origin they had (possibly none), and are reported in `kept`.
 *
 *  The RAW reading is stored, not the tilt-corrected one: the origin is the
 *  reference the correction is measured FROM, so at the origin attitude the
 *  correction is the identity by construction. Storing a corrected value would
 *  double-count the pose the operator was holding. */
export function originFromPose(pose, prev) {
  const origin = { ...(prev || {}) };
  origin.q = { ...(prev?.q || {}) };
  const set = [];
  const kept = [];
  for (const a of HANDHELD_AXES) {
    const ax = pose.axes[a.key];
    const fresh = ax.mm != null
      && (ax.status === 'live' || (ax.ageS != null && ax.ageS <= ORIGIN_MAX_AGE_S));
    if (fresh) {
      origin[a.key] = ax.mm;
      origin.q[a.key] = pose.quat ?? null;
      set.push(a.key);
    } else kept.push(a.key);
  }
  return { origin, set, kept };
}

/** Measurements per second from `seq`/`ts`, both on the Pi's clock. `seq` counts
 *  distinct measurements (see stream.py), so this is the sensor's own rate, not
 *  the 200 Hz poll rate. */
export function createMeasurementRate(windowS = 3) {
  let lastSeq = null;
  const ts = [];
  return {
    push(seq, t) {
      if (seq == null || !Number.isFinite(t) || seq === lastSeq) return;
      lastSeq = seq;
      ts.push(t);
      while (ts.length && t - ts[0] > windowS) ts.shift();
    },
    hz(nowPiTs) {
      if (ts.length && Number.isFinite(nowPiTs) && nowPiTs - ts[ts.length - 1] > windowS) return 0;
      if (ts.length < 2) return null;
      const span = ts[ts.length - 1] - ts[0];
      return span > 0 ? (ts.length - 1) / span : null;
    },
  };
}

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the setting still works for this session.
  }
}

export function loadHandheldOrigin() {
  const o = loadJson(ORIGIN_KEY);
  if (!o || typeof o !== 'object') return null;
  const out = { q: {} };
  let n = 0;
  for (const a of HANDHELD_AXES) {
    if (!Number.isFinite(o[a.key])) continue;
    out[a.key] = o[a.key];
    out.q[a.key] = qNormalize(o.q?.[a.key]);
    n++;
  }
  return n ? out : null;
}

export const saveHandheldOrigin = (origin) => saveJson(ORIGIN_KEY, origin);

/** The stored mount calibration, as produced by createMountCalibrator().solve().
 *  Only `axes[k].v` is load-bearing; the rest is kept so the panel can show how
 *  the calibration that is in force was obtained, and how good it was. */
export function loadHandheldMount() {
  const m = loadJson(MOUNT_KEY);
  if (!m || typeof m !== 'object' || !m.axes) return null;
  let usable = 0;
  for (const a of HANDHELD_AXES) {
    const v = m.axes[a.key]?.v;
    if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) usable++;
  }
  return usable ? m : null;
}

export const saveHandheldMount = (mount) => saveJson(MOUNT_KEY, mount);

// Default ON. The correction is worth having with the nominal mount alone (see
// the sensitivity table in handheldTilt.js), and it falls back to the raw
// difference on any axis that has no orientation, so switching it on cannot
// break a rig that has no working IMU. The toggle exists to A/B it.
export function loadHandheldTiltEnabled() {
  const v = loadJson(TILT_KEY);
  return typeof v === 'boolean' ? v : true;
}

export const saveHandheldTiltEnabled = (on) => saveJson(TILT_KEY, !!on);

export function loadHandheldAssignment() {
  const o = loadJson(ASSIGNMENT_KEY);
  const out = { ...DEFAULT_ASSIGNMENT };
  if (o && typeof o === 'object') {
    for (const a of HANDHELD_AXES) if (UART_CHOICES.includes(o[a.lidar])) out[a.lidar] = o[a.lidar];
  }
  return out;
}

export const saveHandheldAssignment = (assignment) => saveJson(ASSIGNMENT_KEY, assignment);

export function loadHandheldAverageMs() {
  const v = loadJson(AVERAGE_KEY);
  return AVERAGE_WINDOWS_MS.includes(v) ? v : DEFAULT_AVERAGE_MS;
}

export const saveHandheldAverageMs = (ms) => saveJson(AVERAGE_KEY, ms);
