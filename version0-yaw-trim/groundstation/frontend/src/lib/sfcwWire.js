// Decoder for the binary sfcw_result frames sdr_server sends to a client that opts in
// with { cmd: 'sfcw_binary', enabled: true }. Frame layout and the reasons for it are
// in pi/radar/sfcw_wire.py.
//
// A binary frame carries h_cal and every scalar field of the JSON message, but not the
// Pi's own range profile (distances / magnitudes). Several consumers still read those
// straight off the live sweep -- the capture copies in App.jsx, buildCellRecord (which
// stores them in C-scan cells and the export), CscanPanel's depth-gate bound, SAR
// detection, SfcwDisplay's guard -- so the decoded message rebuilds them with the Pi's
// own arithmetic (sfcw_engine._process_h_cal, then sdr_server's rounding). They are
// lazy: computed on first read and cached, so a sweep nothing reads them from never
// pays for them, which at 100 Hz is most sweeps. To every consumer they look like the
// ordinary array properties the JSON message had: enumerable (spread, JSON.stringify
// and structuredClone include them), in the same key position, and assignable.
//
// Dependency-free on purpose, so node can import this file directly for checks.

const SPEED_OF_LIGHT = 299792458; // sfcw_engine.SPEED_OF_LIGHT
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextDecoder();

/**
 * Decode one binary sfcw_result frame. Returns the message object, or null when the
 * buffer is not a frame this decoder understands.
 */
export function decodeSfcwBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return null;
  const bytes = new Uint8Array(buffer);
  // 'SFR1'
  if (bytes[0] !== 0x53 || bytes[1] !== 0x46 || bytes[2] !== 0x52 || bytes[3] !== 0x31) return null;
  const view = new DataView(buffer);
  const headerLen = view.getUint32(4, true);
  if (8 + headerLen > buffer.byteLength) return null;
  let header;
  try {
    header = JSON.parse(utf8.decode(bytes.subarray(8, 8 + headerLen)));
  } catch {
    return null;
  }
  const n = header?.n;
  const offset = Math.ceil((8 + headerLen) / 8) * 8;
  if (!Number.isInteger(n) || n <= 0 || offset + 16 * n > buffer.byteLength) return null;

  let values;
  if (LITTLE_ENDIAN) {
    values = new Float64Array(buffer, offset, 2 * n);
  } else {
    values = new Float64Array(2 * n);
    for (let i = 0; i < 2 * n; i++) values[i] = view.getFloat64(offset + 8 * i, true);
  }
  // The frame carries h_cal at FULL precision. Consumers get it rounded to 8 decimals,
  // exactly as np.round does for the JSON message, so they see identical numbers. The
  // profile is rebuilt from the unrounded views, because that is what the Pi computed
  // its own from: rebuilt from the 8-decimal values, ~1% of a quiet sweep's bins come
  // out 0.01 dB off. The views are never handed to consumers, so an in-place edit of
  // msg.h_cal_real cannot change the profile either.
  const re = values.subarray(0, n);
  const im = values.subarray(n, 2 * n);
  // The Pi computed its profile with ITS range offset. App.jsx's range-offset guard may
  // later overwrite msg.range_offset with the panel's value; the rebuilt profile must
  // still match what the JSON message would have carried, so capture it now.
  const stepSize = header.step_size;
  const rangeOffset = header.range_offset;
  delete header.n;

  // Same key order as the JSON message: type, distances, magnitudes, h_cal_real,
  // h_cal_imag, then the rest in the order the Pi sent them.
  const msg = { type: header.type };
  let profile = null;
  const piProfile = () => profile || (profile = piRangeProfile(re, im, stepSize, rangeOffset));
  defineLazy(msg, 'distances', () => piProfile().distances);
  defineLazy(msg, 'magnitudes', () => piProfile().magnitudes);
  msg.h_cal_real = Array.from(re, (x) => roundHalfEven(x, 1e8));
  msg.h_cal_imag = Array.from(im, (x) => roundHalfEven(x, 1e8));
  // The unrounded values, for a recorder that wants the frame's full precision (the Handheld
  // Capture panel). Non-enumerable, so spread, JSON.stringify and structuredClone of the
  // message are unchanged; copies, so nothing written to them can reach the profile above.
  Object.defineProperty(msg, 'h_cal_full_real', { value: Float64Array.from(re), enumerable: false });
  Object.defineProperty(msg, 'h_cal_full_imag', { value: Float64Array.from(im), enumerable: false });
  for (const key of Object.keys(header)) {
    if (key !== 'type') msg[key] = header[key];
  }
  return msg;
}

function defineLazy(obj, key, compute) {
  const settle = (target, value) => {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  };
  Object.defineProperty(obj, key, {
    enumerable: true,
    configurable: true,
    get() {
      const value = compute();
      settle(this, value);
      return value;
    },
    set(value) {
      settle(this, value);
    },
  });
}

/**
 * The Pi's range profile for one sweep, exactly as the JSON sfcw_result carries it:
 * sfcw_engine._process_h_cal (np.hanning window, ifft zero-padded to 4 x num_steps,
 * 20*log10(|.| + 1e-12), first half, bins at distance >= 0) followed by sdr_server's
 * np.round(distances, 4) and np.round(magnitudes, 2).
 */
export function piRangeProfile(re, im, stepSize, rangeOffset) {
  const M = re.length;
  const nfft = M * 4;
  const half = Math.floor(nfft / 2);
  const hr = new Float64Array(M);
  const hi = new Float64Array(M);
  for (let m = 0; m < M; m++) {
    // numpy >= 1.x np.hanning: n = arange(1-M, M, 2); 0.5 + 0.5*cos(pi*n/(M-1))
    const w = M === 1 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (1 - M + 2 * m) / (M - 1));
    hr[m] = re[m] * w;
    hi[m] = im[m] * w;
  }
  const maxRange = SPEED_OF_LIGHT / (2 * stepSize);
  const { cos, sin } = trigTable(M, nfft, half);
  const distances = [];
  const magnitudes = [];
  for (let k = 0; k < half; k++) {
    const d = k / nfft * maxRange - rangeOffset;
    if (!(d >= 0)) continue;
    // np.fft.ifft: (1/nfft) * sum_m x[m] * exp(+2*pi*i*m*k/nfft)
    let sr = 0;
    let si = 0;
    const row = k * M;
    for (let m = 0; m < M; m++) {
      const c = cos[row + m];
      const s = sin[row + m];
      sr += hr[m] * c - hi[m] * s;
      si += hr[m] * s + hi[m] * c;
    }
    const mag = 20 * Math.log10(Math.hypot(sr / nfft, si / nfft) + 1e-12);
    distances.push(roundHalfEven(d, 1e4));
    magnitudes.push(roundHalfEven(mag, 1e2));
  }
  return { distances, magnitudes };
}

// cos/sin of 2*pi*m*k/nfft for k < half, m < M. Only a handful of step counts are ever
// in use, so a small cache avoids recomputing the table for every sweep.
const trigCache = new Map();
function trigTable(M, nfft, half) {
  const key = `${M}`;
  let t = trigCache.get(key);
  if (!t) {
    const cos = new Float64Array(half * M);
    const sin = new Float64Array(half * M);
    for (let k = 0; k < half; k++) {
      for (let m = 0; m < M; m++) {
        const a = 2 * Math.PI * m * k / nfft;
        cos[k * M + m] = Math.cos(a);
        sin[k * M + m] = Math.sin(a);
      }
    }
    t = { cos, sin };
    if (trigCache.size >= 8) trigCache.delete(trigCache.keys().next().value);
    trigCache.set(key, t);
  }
  return t;
}

// np.round(x, decimals) for a float: rint(x * 10**decimals) / 10**decimals, where rint
// rounds a tie to the even neighbour and keeps the sign of zero. Math.round sends every
// tie upward, so it would disagree exactly on the .5 cases.
function roundHalfEven(x, scale) {
  const y = x * scale;
  const f = Math.floor(y);
  let r;
  if (y - f === 0.5) {
    r = f % 2 === 0 ? f : f + 1;
    if (r === 0 && y < 0) r = -0;
  } else {
    r = Math.round(y);
  }
  return r / scale;
}
