#!/usr/bin/env python3
"""Port of groundstation/frontend/src/lib/bgModelInterp.js + rangeProfile.js.

Exists so the interpolating background model can be applied to recorded sweeps
offline, on the Pi, without a browser. Phase 1 built an equivalent port in a
scratchpad that is now gone (CLAUDE.md still references `scratchpad/regime_gap.py`,
which no longer exists) -- this one lives in the repo so the next session does not
write a third copy.

Ported deliberately literally, including two things that look like bugs and are not:

  * `infer()` interpolates at the *clamped* standoff but rewinds the phase at the
    *unclamped* one, exactly as inferInterpModel does. Out of span, that means the
    residual structure comes from the nearest knot while the phase ramp is for the
    true distance. Reproducing this is the entire point of the span analysis -- a
    "tidier" port that clamps both would not exhibit the failure being measured.
  * `akima_slopes` keeps the JS's m[0..n+2] extrapolated-difference layout rather
    than using scipy's Akima1DInterpolator, so the numbers match the shipped
    display bit-for-bit rather than approximately.

Run directly to self-check against a training export:
    python3 bgmodel_interp.py ../../data/bgmodel_pass1.json
"""

import json
import math

import numpy as np

SPEED_OF_LIGHT = 299792458.0
UNWIND_ALPHA = 0.80
MERGE_MM = 0.5


def freq_grid(start_mhz, stop_mhz, num_steps):
    a, b = start_mhz * 1e6, stop_mhz * 1e6
    return a + (np.arange(num_steps) / (num_steps - 1)) * (b - a)


def akima_slopes(x, Y):
    """Akima slopes for every column of Y (n_knots, S) sharing knot positions x."""
    n = len(x)
    S = Y.shape[1]
    if n == 2:
        s = (Y[1] - Y[0]) / (x[1] - x[0])
        return np.vstack([s, s])

    m = np.zeros((n + 3, S))
    dx = np.diff(x)[:, None]
    m[2:n + 1] = np.diff(Y, axis=0) / dx
    m[1] = 2 * m[2] - m[3]
    m[0] = 2 * m[1] - m[2]
    m[n + 1] = 2 * m[n] - m[n - 1]
    m[n + 2] = 2 * m[n + 1] - m[n]

    t = np.zeros((n, S))
    for i in range(n):
        w1 = np.abs(m[i + 3] - m[i + 2])
        w2 = np.abs(m[i + 1] - m[i])
        den = w1 + w2
        near_zero = den <= 1e-30
        safe = np.where(near_zero, 1.0, den)
        t[i] = np.where(near_zero,
                        0.5 * (m[i + 1] + m[i + 2]),
                        (w1 * m[i + 1] + w2 * m[i + 2]) / safe)
    return t


def _hermite(x, x0, x1, y0, y1, t0, t1):
    h = x1 - x0
    s = (x - x0) / h
    s2, s3 = s * s, s * s * s
    return (y0 * (2 * s3 - 3 * s2 + 1) + y1 * (-2 * s3 + 3 * s2)
            + h * t0 * (s3 - 2 * s2 + s) + h * t1 * (s3 - s2))


def _to_knots(samples):
    def usable(s):
        # `is not None` rather than truthiness: samples round-tripped through
        # evaluate_loo carry numpy arrays, which raise on bool().
        return (s.get('h_cal_real') is not None and s.get('h_cal_imag') is not None
                and len(s['h_cal_real']) > 0
                and s.get('lidar_standoff_mm') is not None)

    ok = sorted((s for s in samples if usable(s)), key=lambda s: s['lidar_standoff_mm'])
    if not ok:
        return []
    knots, group = [], [ok[0]]

    def flush():
        n = len(group)
        knots.append({
            'd': sum(g['lidar_standoff_mm'] for g in group) / n,
            're': np.mean([g['h_cal_real'] for g in group], axis=0),
            'im': np.mean([g['h_cal_imag'] for g in group], axis=0),
        })

    for s in ok[1:]:
        if s['lidar_standoff_mm'] - group[-1]['lidar_standoff_mm'] < MERGE_MM:
            group.append(s)
        else:
            flush()
            group = [s]
    flush()
    return knots


def build_model(samples, sfcw_params, alpha=UNWIND_ALPHA):
    knots = _to_knots(samples)
    if len(knots) < 2:
        raise ValueError('Need at least 2 distinct positions')
    num_steps = len(knots[0]['re'])
    freqs = freq_grid(sfcw_params['startFreq'], sfcw_params['stopFreq'], num_steps)

    d = np.array([k['d'] for k in knots])
    re = np.array([k['re'] for k in knots])
    im = np.array([k['im'] for k in knots])

    # unwind: multiply by exp(+j * 4pi * f * alpha * d / c)
    ph = 4 * np.pi * freqs[None, :] * alpha * (d[:, None] / 1000.0) / SPEED_OF_LIGHT
    cp, sp = np.cos(ph), np.sin(ph)
    u_re = re * cp - im * sp
    u_im = re * sp + im * cp

    return {
        'type': 'interp', 'unwindAlpha': alpha, 'numSteps': num_steps,
        'numPositions': len(knots), 'd': d, 'uRe': u_re, 'uIm': u_im,
        'sRe': akima_slopes(d, u_re), 'sIm': akima_slopes(d, u_im),
        'freqs': freqs,
        'sfcwParams': {'startFreq': sfcw_params['startFreq'],
                       'stopFreq': sfcw_params['stopFreq'], 'numSteps': num_steps},
    }


def infer(model, distance_mm):
    """Background spectrum at a standoff. Clamps like inferInterpModel does."""
    d = model['d']
    n = len(d)
    x = min(max(distance_mm, d[0]), d[-1])
    lo, hi = 0, n - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if d[mid] <= x:
            lo = mid
        else:
            hi = mid

    rr = _hermite(x, d[lo], d[hi], model['uRe'][lo], model['uRe'][hi],
                  model['sRe'][lo], model['sRe'][hi])
    ri = _hermite(x, d[lo], d[hi], model['uIm'][lo], model['uIm'][hi],
                  model['sIm'][lo], model['sIm'][hi])

    # rewind at the UNCLAMPED distance -- see module docstring
    ph = 4 * np.pi * model['freqs'] * model['unwindAlpha'] * (distance_mm / 1000.0) / SPEED_OF_LIGHT
    cp, sp = np.cos(ph), np.sin(ph)
    return rr * cp + ri * sp, -rr * sp + ri * cp


def range_profile(re, im, step_size, range_offset):
    """Zero-padded IFFT range profile; mirrors rangeProfile.js computeRangeProfile."""
    num_steps = len(re)
    nfft = 1 << math.ceil(math.log2(num_steps * 4))
    buf = np.zeros(nfft, dtype=complex)
    buf[:num_steps] = np.asarray(re) + 1j * np.asarray(im)
    prof = np.fft.ifft(buf)

    max_range = SPEED_OF_LIGHT / (2 * step_size)
    half = nfft // 2
    dist = (np.arange(half) / nfft) * max_range - range_offset
    keep = dist >= 0
    mags_db = 20 * np.log10(np.abs(prof[:half][keep]) + 1e-12)
    return mags_db, dist[keep]


def suppression_db(h_re, h_im, bg_re, bg_im):
    """10*log10(signal / residual) -- the same metric evaluateLoo reports."""
    h = np.asarray(h_re) + 1j * np.asarray(h_im)
    r = h - (np.asarray(bg_re) + 1j * np.asarray(bg_im))
    sig = float(np.sum(np.abs(h) ** 2))
    err = float(np.sum(np.abs(r) ** 2))
    return 10 * math.log10(sig / (err or 1e-30))


def load_training_export(path):
    """v2 bgmodel_training_data -> one sample per capture (the coherent mean),
    matching App.jsx's 'build' action."""
    doc = json.load(open(path))
    if doc.get('type') != 'bgmodel_training_data':
        raise ValueError(f'not a training export: {path}')
    samples = []
    for c in doc['captures']:
        st = c.get('stats')
        if not st or st.get('standoffMm') is None:
            continue
        samples.append({'h_cal_real': st['h_mean_real'], 'h_cal_imag': st['h_mean_imag'],
                        'lidar_standoff_mm': st['standoffMm'], 'num_steps': st['numSteps']})
    return samples, doc


def evaluate_loo(samples, sfcw_params, alpha=UNWIND_ALPHA):
    knots = _to_knots(samples)
    as_samples = [{'h_cal_real': k['re'], 'h_cal_imag': k['im'],
                   'lidar_standoff_mm': k['d']} for k in knots]
    out = []
    for i in range(len(as_samples)):
        tr = [s for j, s in enumerate(as_samples) if j != i]
        if len(tr) < 2:
            continue
        m = build_model(tr, sfcw_params, alpha)
        bg_re, bg_im = infer(m, as_samples[i]['lidar_standoff_mm'])
        interior = m['d'][0] <= as_samples[i]['lidar_standoff_mm'] <= m['d'][-1]
        out.append({'d': as_samples[i]['lidar_standoff_mm'], 'interior': interior,
                    'suppDb': suppression_db(as_samples[i]['h_cal_real'],
                                             as_samples[i]['h_cal_imag'], bg_re, bg_im)})
    return out


if __name__ == '__main__':
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else '../../data/bgmodel_pass1.json'
    samples, doc = load_training_export(path)
    p = doc['sfcwParams']
    print(f'{len(samples)} positions, numSteps={samples[0]["num_steps"]}, '
          f'{p["startFreq"]}-{p["stopFreq"]} MHz, offset={doc.get("lidarAntennaOffsetMm")}')
    m = build_model(samples, p)
    print(f'model span {m["d"][0]:.1f} .. {m["d"][-1]:.1f} mm  ({m["numPositions"]} knots)')
    loo = evaluate_loo(samples, p)
    inn = [r['suppDb'] for r in loo if r['interior']]
    out = [r['suppDb'] for r in loo if not r['interior']]
    print(f'LOO interior : n={len(inn):2d}  mean {np.mean(inn):6.2f} dB  '
          f'median {np.median(inn):6.2f}  worst {min(inn):6.2f}')
    if out:
        print(f'LOO clamped  : n={len(out):2d}  mean {np.mean(out):6.2f} dB')
