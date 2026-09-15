// Tilt (gyroscope/orientation) compensation for the handheld LiDAR triad, and the
// calibration that finds where each LiDAR points relative to the IMU.
//
// WHY THIS EXISTS -------------------------------------------------------------
// handheldPose.js reads position as `origin distance - distance now`, which is
// exact only while the module does not ROTATE. A beam that meets its surface at
// theta off the normal measures `h / cos(theta)`, not the perpendicular distance
// h, so a hand tilt of 10 deg inflates a 1 m reading by 15 mm and a 20 deg tilt
// by 64 mm. The tilt is not noise -- it is systematic and hand-held rotation is
// easily +-15 deg -- so it dominates the 0.5-1 mm sensor noise the averaging
// window was tuned against.
//
// THE MODEL -------------------------------------------------------------------
// Let
//   q(t)  BNO085 game rotation vector, RAW sensor frame, [x,y,z,w]; body -> IMU
//         world. Gravity-referenced (roll/pitch absolute), yaw free-running.
//   v_k   unit direction LiDAR k points, in the IMU's own sensor frame. This is
//         the mount -- the "relative orientation of the IMU and the LiDARs" --
//         and it is what fitMount() below measures.
//   q0    q at the moment the origin was declared.
//   Qr    = q0* (x) q, the rotation since the origin, acting in the body frame
//         the module had AT the origin.
//   mu_k  the surface normal, in that same body-at-origin frame.
//   p_k   lever arm: where LiDAR k's emitter sits relative to the point the
//         module pivots about, in the IMU sensor frame, mm.
//
// A beam from a point X along direction B to a plane with unit normal n returns
// range `h / (n . B)` where h is the perpendicular distance from X to the plane.
// Expressing n and B in the body-at-origin frame gives the whole correction:
//
//   g_k = mu_k . (Qr v_k)          cosine of the incidence angle
//   h_k = d_k * g_k                perpendicular distance  (EXACT, not a small-
//                                  angle approximation)
//   pos_k = sign_k * [ (h0_k - h_k) - mu_k . (Qr p_k - p_k) ]
//
// With no rotation Qr = I, g = 1 and this collapses to `sign * (d0 - d)` -- the
// uncorrected formula -- so the correction is a strict drop-in.
//
// WHAT mu IS, AND THE ONE APPROXIMATION IN THIS VERSION ------------------------
// mu_k is where the surface normal sits relative to the module AT THE ORIGIN, so
// it is not a property of the hardware and cannot come out of the mount
// calibration. This version assumes the operator held the module square to its
// surfaces when declaring the origin, i.e. mu_k = v_k, which makes
// g_k = v_k . (Qr v_k) -- conveniently also the statement that spinning a LiDAR
// about its own beam changes nothing, which is physically true.
//
// The cost of that assumption is worth knowing exactly. With an origin
// misalignment alpha and a later tilt theta, the residual error is
// `tan(alpha) * tan(theta)` of the reading, against `1/cos(theta) - 1` for no
// correction at all. Those are equal at alpha = theta/2, so:
//
//   THE CORRECTION HELPS ONLY IF THE ORIGIN POSE IS SQUARE TO BETTER THAN HALF
//   THE TILT YOU THEN APPLY. Hold it within a couple of degrees at the origin
//   (each reading is at a MINIMUM when its beam is perpendicular -- aim by
//   minimising) and a +-15 deg working tilt drops from 3.5% to 0.5%.
//
// The panel shows each axis's live tilt so this is visible rather than assumed.
// The proper fix is to fit mu at origin time from a deliberate 2 s wobble (the
// same linear solve fitBeam() already uses for `a`, with v known); the
// machinery is here, the UX is not, and that is the next step.
//
// HOW ACCURATE THE MOUNT HAS TO BE, AND WHY THE CORRECTION RUNS UNCALIBRATED ---
// Worst-case position error on an 800 mm standoff, swept over every direction of
// mount error and every direction of tilt:
//
//   mount error      5 deg tilt   10     15     20     25
//   0.5 deg             0.0 mm    0.0    0.0    0.0    0.0
//   2 deg               0.0       0.0    0.0    0.1    0.1
//   5 deg               0.0       0.1    0.2    0.4    0.6
//   8 deg               0.1       0.2    0.5    1.0    1.6
//   NO CORRECTION       3.1      12.3   28.2   51.3   82.7
//
// The mount enters only to SECOND order -- g = v.(Qr v) tilts both the assumed
// normal and the assumed beam together, so getting v wrong mostly cancels. So
// the correction is worth having with the nominal mount alone and is enabled by
// default; calibration is a refinement, not a precondition. What calibration is
// really for is the lever-arm term, which depends on mu's direction to FIRST
// order, and as an independent check on imu_calibration.py's R_ACCEL -- that
// file records its own forward/left rows as inferred rather than measured, and
// fitBeam() measures them.
//
// OTHER LIMITS, all pre-existing and none of them fixed by this file:
//   - Each beam must keep hitting the SAME flat surface. Sliding past a doorway
//     is a step, not motion.
//   - The game rotation vector's yaw drifts (no magnetometer -- bno085.py enables
//     report 0x08, accel+gyro only), typically 1-2 deg over a minute. It costs
//     very little here, and it is worth knowing why rather than assuming:
//       * Y/height is EXACTLY immune. Yaw is rotation about the down beam's own
//         axis, and spinning a LiDAR about its own beam cannot change its range
//         to a perpendicular surface. Measured 0.000 mm at drifts to 20 deg.
//       * X and Z cost `standoff * psi^2/2` -- second order. Measured on a 700 mm
//         wall: 0.11 mm at 1 deg, 0.43 at 2, 2.7 at 5, 10.6 at 10.
//       * Travel does NOT bleed between axes. The axes are pinned to the surface
//         normals captured at the origin, so drift corrupts the cosine, not the
//         axis definition: 200 mm of forward travel under 2 deg of drift puts
//         0.43 mm into X, the same as standing still.
//     At the real 1-2 deg/minute that is 0.1-0.4 mm over a session, under the
//     sensor's own noise floor. Switching to the mag-fused rotation vector (0x05)
//     would buy that back and cost far more: this instrument images REBAR, so a
//     magnetometer is pulled by exactly the thing being looked for.
//   - Lever arms are operator-entered, default 0. At 50 mm and 10 deg they are
//     worth 8.7 mm, so they are not negligible once measured.

// ---------------------------------------------------------------------------
// Quaternion helpers. [x, y, z, w], Hamilton convention, body -> world.
// ---------------------------------------------------------------------------

export function qNormalize(q) {
  if (!Array.isArray(q) || q.length !== 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(q[i])) return null;
    n += q[i] * q[i];
  }
  n = Math.sqrt(n);
  if (!(n > 1e-9)) return null;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** a* (x) b -- the rotation that takes `a`'s frame to `b`'s. */
export function qRelative(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  // conjugate of a is [-ax, -ay, -az, aw]
  return [
    aw * bx - ax * bw - ay * bz + az * by,
    aw * by + ax * bz - ay * bw - az * bx,
    aw * bz - ax * by + ay * bx - az * bw,
    aw * bw + ax * bx + ay * by + az * bz,
  ];
}

/** Rotate vector v by quaternion q. */
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (u x v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** Rotate vector v by the INVERSE of q. */
export function qRotateInv(q, v) {
  return qRotate([-q[0], -q[1], -q[2], q[3]], v);
}

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);

export function unit3(a) {
  const n = norm3(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : null;
}

const DEG = 180 / Math.PI;
export const angleBetweenDeg = (a, b) =>
  Math.acos(Math.max(-1, Math.min(1, dot3(a, b)))) * DEG;

// ---------------------------------------------------------------------------
// Small dense linear algebra. Everything here is 3x3 or 9x9, so clarity beats
// cleverness; these run once per calibration, never per frame.
// ---------------------------------------------------------------------------

/** Solve the symmetric positive-definite normal equations A x = b in place.
 *  Gaussian elimination with partial pivoting. Returns null if singular. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // Gauss-Jordan leaves M diagonal, so row i's unknown is its augment over M[i][i].
  return M.map((row, i) => row[n] / row[i]);
}

/** Least squares for `X w ~ y` via the normal equations. `rows` are the
 *  regressors, one per sample. Ridge term keeps a rank-deficient design (an
 *  operator who only rotated about one axis) from producing a wild answer
 *  rather than a detectable one; it is tiny next to any real signal. */
function lstsq(rows, y, ridge = 1e-12) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let t = 0; t < rows.length; t++) {
    const r = rows[t];
    for (let i = 0; i < n; i++) {
      b[i] += r[i] * y[t];
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j];
    }
  }
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, A[i][i]);
  for (let i = 0; i < n; i++) A[i][i] += ridge * (scale || 1);
  return solveLinear(A, b);
}

/** Dominant eigenpair of a symmetric 3x3, by power iteration. Enough for the
 *  rank-1 extraction and the spread metrics; a full SVD would be overkill. */
function dominantEigen(S, seed = [1, 1, 1]) {
  let v = unit3(seed) || [1, 0, 0];
  let lambda = 0;
  for (let it = 0; it < 200; it++) {
    const w = [
      S[0][0] * v[0] + S[0][1] * v[1] + S[0][2] * v[2],
      S[1][0] * v[0] + S[1][1] * v[1] + S[1][2] * v[2],
      S[2][0] * v[0] + S[2][1] * v[1] + S[2][2] * v[2],
    ];
    const n = norm3(w);
    if (!(n > 1e-300)) return { value: 0, vector: v };
    const next = [w[0] / n, w[1] / n, w[2] / n];
    lambda = dot3(next, w);
    const moved = Math.abs(dot3(next, v));
    v = next;
    if (moved > 1 - 1e-15) break;
  }
  return { value: lambda, vector: v };
}

function outerAdd(S, a, b, scale = 1) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += scale * a[i] * b[j];
}

// ---------------------------------------------------------------------------
// Mount calibration
// ---------------------------------------------------------------------------

// Minimum evidence before a fit is offered as usable. Each is a separate way the
// operator can produce a confident-looking but meaningless answer, and the two
// rotation gates are measured rather than guessed -- see rotationCoverage().
//
// From a simulated module (true mount 6.5 deg off nominal, 1 mm quantisation,
// 300 samples), fitted-direction error against how the operator moved:
//
//   rotation     translation 0 mm   3 mm    10 mm
//   ~11 deg, 2 axes    0.2-0.5 deg  0.1-1.6  1.5-4.6   <- too little rotation
//   ~21 deg, 2 axes    0.02-0.05    0.06-0.34  0.4-1.0
//   ~35 deg, 2 axes    0.02         0.05-0.12  0.1-0.2
//   any, ONE axis      3-94 deg     3-92     73-95     <- degenerate, see below
//
// So 20 deg of two-axis rotation is where it becomes reliable, and rotating
// about a single axis is not merely imprecise -- it is a genuine gauge freedom
// (both unknown directions can be spun about that axis with no change in the
// prediction), which is why it produces confident answers up to 95 deg wrong.
export const CAL_MIN_SAMPLES = 120;      // ~2.5 s at the 50 Hz sensor stream
export const CAL_MIN_ROT_DEG = 18;       // how far the module was rotated at all
export const CAL_MIN_SECOND_AXIS_DEG = 4;  // rotation about a SECOND axis
export const CAL_MAX_RMS_MM = 6;         // fit residual, in millimetres of range
export const CAL_MAX_MOUNT_DEG = 35;     // how far the answer may sit from nominal

/** How the module was actually moved during a calibration run, measured from the
 *  rotations alone so it says nothing about -- and cannot be flattered by -- the
 *  fit that follows.
 *
 *  Each sample's rotation is taken as a rotation VECTOR (axis * angle, radians).
 *  `maxDeg` is how far from the reference pose the module ever got; the two
 *  spreads are the RMS rotation about the most- and second-most-used axes. The
 *  SECOND one is the load-bearing number: with rotation about a single axis the
 *  problem has a gauge freedom about that axis, so it is unidentifiable however
 *  many samples are taken and however far it is rotated.
 *
 *  An earlier version measured the spread of the fitted BEAM directions instead.
 *  That is circular -- a badly wrong `v` traces a wide cone and scores well, so
 *  it read 6 deg of "coverage" on a single-axis run whose answer was 21 deg
 *  wrong. Measure the input, not the output. */
export function rotationCoverage(samples) {
  if (!samples || !samples.length) return { n: 0, maxDeg: 0, spreadDeg: [0, 0] };
  const vecs = [];
  let maxDeg = 0;
  for (const { qr } of samples) {
    const s = Math.hypot(qr[0], qr[1], qr[2]);
    const ang = 2 * Math.atan2(s, Math.abs(qr[3]));   // abs: q and -q are one rotation
    const sign = qr[3] < 0 ? -1 : 1;
    maxDeg = Math.max(maxDeg, ang * DEG);
    if (s > 1e-12) {
      const k = (sign * ang) / s;
      vecs.push([qr[0] * k, qr[1] * k, qr[2] * k]);
    } else {
      vecs.push([0, 0, 0]);
    }
  }
  const S = Array.from({ length: 3 }, () => new Array(3).fill(0));
  for (const r of vecs) outerAdd(S, r, r, 1 / vecs.length);
  const e1 = dominantEigen(S);
  outerAdd(S, e1.vector, e1.vector, -e1.value);
  const e2 = dominantEigen(S, [e1.vector[1], e1.vector[2], e1.vector[0]]);
  return {
    n: samples.length,
    maxDeg,
    spreadDeg: [Math.sqrt(Math.max(0, e1.value)) * DEG, Math.sqrt(Math.max(0, e2.value)) * DEG],
  };
}

/** Fit one LiDAR's beam direction in the IMU sensor frame.
 *
 *  Holding the module in one place and rotating it makes the perpendicular
 *  distance H constant while the measured range varies, so
 *
 *      1/d_t = (1/H) * mu . (Qr_t v)  =  a . (Qr_t v)
 *
 *  which is BILINEAR in the two unknown directions (`a`, carrying 1/H in its
 *  length, and `v`). Alternating least squares splits it into two 3-parameter
 *  linear solves, each well conditioned where the joint 9-parameter form is not:
 *  the samples live near the identity rotation, so vec(Qr) explores barely four
 *  of its nine dimensions.
 *
 *  Started from BOTH the nominal mount and a rank-1 factorisation of the
 *  unconstrained 9-parameter fit, keeping whichever converges lower -- the
 *  nominal comes from imu_calibration.py's axis remap, whose forward/left rows
 *  that file itself records as inferred rather than measured, so it must not be
 *  the only way in.
 *
 *  `samples` are `{ qr, d }`: rotation since the calibration reference pose, and
 *  the measured range in mm. */
export function fitBeam(samples, vNominal) {
  if (!samples || samples.length < 8) return null;
  const y = samples.map(s => 1 / s.d);

  // --- initial guess A: unconstrained 9-parameter fit, then rank-1 ---
  let vSvd = null;
  {
    const rows = samples.map(({ qr }) => {
      // vec(Qr) as a 9-vector, so that <K, Qr> = a.(Qr v) with K = a v^T.
      const c0 = qRotate(qr, [1, 0, 0]);
      const c1 = qRotate(qr, [0, 1, 0]);
      const c2 = qRotate(qr, [0, 0, 1]);
      return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
    });
    const k = lstsq(rows, y, 1e-9);
    if (k) {
      const K = [[k[0], k[1], k[2]], [k[3], k[4], k[5]], [k[6], k[7], k[8]]];
      const KtK = Array.from({ length: 3 }, () => new Array(3).fill(0));
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          for (let m = 0; m < 3; m++) KtK[i][j] += K[m][i] * K[m][j];
        }
      }
      const { vector } = dominantEigen(KtK, vNominal);
      vSvd = vector;
    }
  }

  const runFrom = (v0) => {
    let v = unit3(v0);
    if (!v) return null;
    let a = null;
    for (let it = 0; it < 60; it++) {
      const xRows = samples.map(({ qr }) => qRotate(qr, v));
      a = lstsq(xRows, y);
      if (!a) return null;
      const zRows = samples.map(({ qr }) => qRotateInv(qr, a));
      const vNew = lstsq(zRows, y);
      if (!vNew) return null;
      const u = unit3(vNew);
      if (!u) return null;
      const moved = Math.abs(dot3(u, v));
      v = u;
      if (moved > 1 - 1e-14) break;
    }
    // One last `a` for the v we ended on, so the two halves agree.
    const xRows = samples.map(({ qr }) => qRotate(qr, v));
    a = lstsq(xRows, y);
    if (!a) return null;
    const aNorm = norm3(a);
    if (!(aNorm > 1e-12)) return null;

    // (a, v) and (-a, -v) fit identically; the cosines do not care but the lever
    // arm term does. Take the branch pointing the way the beam actually points.
    let mu = [a[0] / aNorm, a[1] / aNorm, a[2] / aNorm];
    if (dot3(v, vNominal) < 0) {
      v = [-v[0], -v[1], -v[2]];
      mu = [-mu[0], -mu[1], -mu[2]];
    }

    let se = 0;
    let maxTilt = 0;
    for (let t = 0; t < samples.length; t++) {
      const g = dot3(mu, qRotate(samples[t].qr, v));
      const dPred = g > 1e-6 ? 1 / (aNorm * g) : Infinity;
      const e = dPred - samples[t].d;
      se += e * e;
      maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, g))) * DEG);
    }
    return { v, mu, H: 1 / aNorm, rmsMm: Math.sqrt(se / samples.length), maxTiltDeg: maxTilt };
  };

  const candidates = [runFrom(vNominal), vSvd && runFrom(vSvd)].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((p, q) => p.rmsMm - q.rmsMm);
  const best = candidates[0];

  return {
    ...best,
    n: samples.length,
    coverage: rotationCoverage(samples),
    mountDeg: angleBetweenDeg(best.v, vNominal),
  };
}

/** Per-axis reasons a fit is not trustworthy. Empty array = usable. */
export function fitProblems(fit) {
  if (!fit) return ['no fit'];
  const out = [];
  if (fit.n < CAL_MIN_SAMPLES) out.push(`only ${fit.n} samples`);
  if (fit.coverage.maxDeg < CAL_MIN_ROT_DEG) {
    out.push(`rotated only ${fit.coverage.maxDeg.toFixed(0)}°, need ${CAL_MIN_ROT_DEG}°`);
  }
  if (fit.coverage.spreadDeg[1] < CAL_MIN_SECOND_AXIS_DEG) {
    out.push(`rotated about one axis only (${fit.coverage.spreadDeg[1].toFixed(1)}° about a second)`);
  }
  if (!(fit.rmsMm <= CAL_MAX_RMS_MM)) out.push(`residual ${fit.rmsMm.toFixed(1)} mm`);
  if (fit.mountDeg > CAL_MAX_MOUNT_DEG) {
    out.push(`${fit.mountDeg.toFixed(0)}° from the nominal mount`);
  }
  return out;
}

/** Collects `{ q, d_per_axis }` while the operator wobbles the module, then
 *  fits every axis against the reference pose the run started from.
 *
 *  Per-axis sample sets are kept separate on purpose: a LiDAR whose surface is
 *  missing (calibrating against one wall rather than a corner) simply fails its
 *  own fit instead of poisoning the other two. */
// A run is ended by the operator, so it has no natural length. Past this many
// samples per axis (2 minutes at the 50 Hz sensor stream) further samples are
// dropped rather than accumulated: the fit is already saturated long before
// here, and an unbounded buffer on a panel someone walked away from is a leak.
export const CAL_MAX_SAMPLES = 6000;

export function createMountCalibrator(axes) {
  let ref = null;
  let dropped = 0;
  const samples = {};
  for (const a of axes) samples[a.key] = [];
  return {
    get refQ() { return ref; },
    /** `distances` is `{ x, y, z }` in mm; anything non-finite is skipped. */
    push(q, distances) {
      const qn = qNormalize(q);
      if (!qn) return false;
      if (!ref) ref = qn;
      const qr = qRelative(ref, qn);
      let any = false;
      for (const a of axes) {
        const d = distances?.[a.key];
        if (Number.isFinite(d) && d > 1) {
          if (samples[a.key].length < CAL_MAX_SAMPLES) {
            samples[a.key].push({ qr, d });
            any = true;
          } else dropped++;
        }
      }
      return any;
    },
    counts() {
      const out = {};
      for (const a of axes) out[a.key] = samples[a.key].length;
      out.dropped = dropped;
      return out;
    },
    /** Live rotation coverage, so the panel can show whether the operator has
     *  moved enough -- and in enough DIRECTIONS -- while they are still moving,
     *  rather than only telling them afterwards that the run was degenerate.
     *  Fit-independent, so it is meaningful before any fit exists. */
    coverage(key) {
      const k = key ?? axes[0]?.key;
      return rotationCoverage(samples[k] || []);
    },
    solve() {
      const result = { refQ: ref, at: Date.now(), axes: {} };
      for (const a of axes) {
        const fit = fitBeam(samples[a.key], a.vNominal);
        result.axes[a.key] = fit ? { ...fit, problems: fitProblems(fit) } : null;
      }
      // The three heads are mounted mutually perpendicular, so the largest
      // departure from 90 deg between the fitted directions is an independent
      // check on the whole run -- it uses no information the fits were given.
      const good = axes.filter(a => result.axes[a.key]);
      let orthoDeg = null;
      for (let i = 0; i < good.length; i++) {
        for (let j = i + 1; j < good.length; j++) {
          const ang = angleBetweenDeg(result.axes[good[i].key].v, result.axes[good[j].key].v);
          const err = Math.abs(ang - 90);
          orthoDeg = orthoDeg == null ? err : Math.max(orthoDeg, err);
        }
      }
      result.orthoDeg = orthoDeg;
      return result;
    },
  };
}

/** The part of a calibration result that is safe to put into service: axes whose
 *  fit passed every gate. A rejected axis is DROPPED rather than stored, so it
 *  falls back to the nominal mount -- keeping a fit that failed its own checks
 *  would be worse than having none, since a single-axis run lands up to 95 deg
 *  out while looking perfectly confident. Returns null if nothing passed. */
export function acceptedMount(result) {
  if (!result?.axes) return null;
  const axes = {};
  let n = 0;
  for (const [key, fit] of Object.entries(result.axes)) {
    if (fit && fitProblems(fit).length === 0) { axes[key] = fit; n++; }
  }
  return n ? { at: result.at, refQ: result.refQ, orthoDeg: result.orthoDeg, axes } : null;
}

// ---------------------------------------------------------------------------
// Runtime correction
// ---------------------------------------------------------------------------

/** Geometry for one axis at one instant.
 *
 *  `v` beam direction in the IMU sensor frame (calibrated, or the nominal).
 *  `qr` rotation since the origin pose, or null when there is no orientation.
 *  `lever` emitter offset in the IMU sensor frame, mm, or null.
 *
 *  Returns `{ cos, tiltDeg, hMm, leverMm }`. `cos` is 1 and `tiltDeg` 0 when no
 *  orientation is available, which makes the caller degrade to the uncorrected
 *  reading rather than to a wrong one. */
export function beamGeometry(v, qr, dMm, lever) {
  if (!qr) {
    return { cos: 1, tiltDeg: 0, hMm: dMm, leverMm: 0, available: false };
  }
  const mu = v;                       // square-at-origin; see the header.
  const b = qRotate(qr, v);
  const cos = Math.max(-1, Math.min(1, dot3(mu, b)));
  const tiltDeg = Math.acos(cos) * DEG;
  // A beam past 90 deg is not looking at its surface at all; refuse rather than
  // report a negative or explosive perpendicular distance.
  const usable = cos > 0.05;
  let leverMm = 0;
  if (lever && (lever[0] || lever[1] || lever[2])) {
    const moved = qRotate(qr, lever);
    leverMm = dot3(mu, [moved[0] - lever[0], moved[1] - lever[1], moved[2] - lever[2]]);
  }
  return {
    cos,
    tiltDeg,
    hMm: dMm != null && usable ? dMm * cos : null,
    leverMm,
    available: usable,
  };
}
