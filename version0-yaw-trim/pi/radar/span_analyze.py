#!/usr/bin/env python3
"""Score a span_confirm traverse: does suppression actually collapse outside the span?

Reads a span_confirm_*.json traverse, rebuilds the interpolating model from the
same training export the traverse was recorded against, and applies it to every
recorded sweep at that sweep's own standoff -- exactly what the live SFCW path does.

Two questions, two metrics:

  suppression dB   10*log10(sum|h|^2 / sum|h-h_hat|^2), the same quantity
                   evaluateLoo reports. Compared against Phase 1's offline
                   falloff curve; agreement confirms the mechanism quantitatively.

  peak/rms         of the residual range profile. Phase 1's interior residuals
                   scored 2.58 (noise-like); a discrete false target gives >>10.
                   This is the one that speaks to the actual symptom, because a
                   flat residual makes no phantom no matter how large it is.

    python3 span_analyze.py ../../data/span_confirm_<ts>.json
"""

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bgmodel_interp import (build_model, infer, load_training_export,
                            range_profile, suppression_db)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Phase 1's offline LOO falloff, for comparison. mm outside span -> suppression dB.
LOO_FALLOFF = [(1, 20.6), (2, 14.6), (5, 6.8), (10, 1.1), (20, -3.5)]

BINS = [(0, 0, 'in span'), (0, 1, '0-1 mm out'), (1, 2, '1-2 mm out'),
        (2, 5, '2-5 mm out'), (5, 10, '5-10 mm out'), (10, 20, '10-20 mm out'),
        (20, 1e9, '>20 mm out')]


def analyze(path):
    doc = json.load(open(path))
    if doc.get('type') != 'span_confirm_traverse':
        raise ValueError(f'not a traverse recording: {path}')

    training = os.path.join(REPO_ROOT, 'data', doc['trainingSet'])
    samples, tdoc = load_training_export(training)
    model = build_model(samples, tdoc['sfcwParams'])
    lo, hi = model['d'][0], model['d'][-1]
    print(f"traverse   : {len(doc['sweeps'])} sweeps from {os.path.basename(path)}")
    print(f"model      : {model['numPositions']} knots, span {lo:.1f} .. {hi:.1f} mm "
          f"(from {doc['trainingSet']})")

    rows = []
    for s in doc['sweeps']:
        d = s.get('lidar_standoff_mm')
        if d is None or not s.get('h_cal_real'):
            continue
        if len(s['h_cal_real']) != model['numSteps']:
            continue
        bg_re, bg_im = infer(model, d)
        h_re = np.asarray(s['h_cal_real'])
        h_im = np.asarray(s['h_cal_imag'])
        res_re, res_im = h_re - bg_re, h_im - bg_im

        supp = suppression_db(h_re, h_im, bg_re, bg_im)
        mags, dist = range_profile(res_re, res_im, s['step_size'], s['range_offset'])
        lin = 10 ** (mags / 20.0)
        raw_mags, _ = range_profile(h_re, h_im, s['step_size'], s['range_offset'])

        rows.append({
            'outside': s['outside_mm'], 'standoff': d, 'supp': supp,
            'peak_rms': float(lin.max() / (np.sqrt(np.mean(lin ** 2)) + 1e-30)),
            'res_peak_db': float(mags.max()),
            'raw_peak_db': float(raw_mags.max()),
            'peak_range_m': float(dist[int(np.argmax(lin))]),
            'lidar_std': s.get('lidar_std'), 'lidar_n': s.get('lidar_n'),
        })

    if not rows:
        print('!! no usable sweeps (standoff missing, or numSteps mismatch)')
        return 1

    ns = [r['lidar_n'] for r in rows if r['lidar_n']]
    if ns:
        print(f"standoff   : {np.mean(ns):.1f} distinct lidar samples/sweep, "
              f"sigma {np.nanmean([r['lidar_std'] or np.nan for r in rows]):.2f} mm")
    print()

    hdr = f"{'bin':<14}{'n':>5}{'supp dB':>10}{'  (LOO)':>9}{'resid pk/rms':>14}{'pk range m':>12}"
    print(hdr)
    print('-' * len(hdr))
    loo_lookup = dict(LOO_FALLOFF)
    for lo_b, hi_b, label in BINS:
        sel = [r for r in rows if (r['outside'] == 0 if hi_b == 0
                                   else lo_b < r['outside'] <= hi_b)]
        if not sel:
            continue
        ref = ''
        for mm, db in LOO_FALLOFF:
            if lo_b < mm <= hi_b:
                ref = f'{db:.1f}'
        if hi_b == 0:
            ref = '25.98'
        print(f"{label:<14}{len(sel):>5}{np.mean([r['supp'] for r in sel]):>10.2f}"
              f"{ref:>9}{np.mean([r['peak_rms'] for r in sel]):>14.2f}"
              f"{np.median([r['peak_range_m'] for r in sel]):>12.3f}")

    inside = [r for r in rows if r['outside'] == 0]
    outside = [r for r in rows if r['outside'] > 0]
    print()
    print('VERDICT')
    if inside:
        pk = np.mean([r['peak_rms'] for r in inside])
        sp = np.mean([r['supp'] for r in inside])
        print(f"  in span : suppression {sp:6.2f} dB, residual peak/rms {pk:5.2f}")
        if pk > 10:
            print("    !! discrete residual peaks while IN span -- a second mechanism")
            print("       exists that span-clamping does not explain.")
        elif sp < 10:
            print("    !! weak suppression in span despite no clamping -- check that the")
            print("       model matches current geometry, and that the wall was blank.")
        else:
            print("    OK -- noise-like residual in span, consistent with Phase 1.")
    if outside:
        far = [r for r in outside if r['outside'] > 10]
        print(f"  outside : {len(outside)} sweeps, "
              f"suppression {np.mean([r['supp'] for r in outside]):6.2f} dB")
        if far:
            print(f"    >10 mm out: suppression {np.mean([r['supp'] for r in far]):6.2f} dB, "
                  f"peak/rms {np.mean([r['peak_rms'] for r in far]):5.2f}")
            if np.mean([r['supp'] for r in far]) < 3:
                print("    CONFIRMED -- subtraction stops helping outside the span.")
    else:
        print("  !! no out-of-span sweeps recorded; re-run the traverse further past an edge.")
    return 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(analyze(sys.argv[1]))
