#!/usr/bin/env python3
"""Capture-position test: is anything still settling inside the dwell?

Takes the full raw nios captures stored by

    probe_wobble.py --block '{"name":"cap","keep_captures":N}'

and re-demodulates each step at many window positions INSIDE its own dwell.
One capture gives every position, so this costs no extra hardware time and the
positions are compared on identical data rather than across runs.

Two different questions, and they are not the same:

  TREND  mean |S| (and |R|, and h_cal phase) against window position, pooled
         over steps and sweeps. A settling transient shows up here as a
         systematic ramp; a settled channel is flat.

  WOBBLE sweep-to-sweep CV at each position. If incomplete settling were what
         re-randomises the measurement at every retune, the CV would FALL as
         the window moves later into the dwell. If the CV is flat, whatever
         causes the wobble was already frozen before the window opened, and no
         amount of extra settling can help.

    python3 pi/radar/analyze_dwell.py cap.npz [--positions 12] [--win 1000]
"""
import argparse
import sys

import numpy as np

SAMPLE_RATE = 10_000_000.0
CW_OFFSET = 100_000.0


def demod_at(flat, offset, stride, num_steps, lead, win, tone):
    i_v = flat[0::2][offset:offset + num_steps * stride].reshape(num_steps, stride)
    q_v = flat[1::2][offset:offset + num_steps * stride].reshape(num_steps, stride)
    iw = i_v[:, lead:lead + win]
    qw = q_v[:, lead:lead + win]
    return (iw @ tone.real - qw @ tone.imag
            + 1j * (iw @ tone.imag + qw @ tone.real)) / win


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('npz')
    ap.add_argument('--positions', type=int, default=12)
    ap.add_argument('--win', type=int, default=1000,
                    help='sub-window length in samples (multiple of 100 keeps '
                         'LO leakage on a sinc null)')
    args = ap.parse_args()

    z = np.load(args.npz, allow_pickle=True)
    caps = {}
    for k in z.files:
        if '__cap' in k:
            blk, rest = k.split('__cap', 1)
            idx, field = rest.split('__', 1)
            caps.setdefault((blk, int(idx)), {})[field] = z[k]
    if not caps:
        print("no full captures in this file "
              "(run probe_wobble.py with keep_captures > 0)")
        return 1

    win = args.win - args.win % int(round(SAMPLE_RATE / CW_OFFSET))
    t = np.arange(win) / SAMPLE_RATE
    tone = (np.exp(-1j * 2 * np.pi * CW_OFFSET * t) / 2047.0).astype(np.complex128)

    by_block = {}
    for (blk, idx), c in sorted(caps.items()):
        stride = int(c['stride']); settle = int(c['settle'])
        guard = int(c['guard']); ns = int(c['num_steps'])
        offset = int(c['offset'])
        lo = guard                          # earliest usable lead
        hi = stride - guard - win           # latest
        if hi <= lo:
            print(f"{blk}: dwell too short for a {win}-sample window")
            continue
        leads = np.linspace(lo, hi, args.positions).astype(int)
        S = np.zeros((len(leads), ns), dtype=np.complex128)
        R = np.zeros((len(leads), ns), dtype=np.complex128)
        for li, lead in enumerate(leads):
            S[li] = demod_at(c['sig'], offset, stride, ns, lead, win, tone)
            R[li] = demod_at(c['ref'], offset, stride, ns, lead, win, tone)
        by_block.setdefault(blk, {'leads': leads, 'settle': settle,
                                  'stride': stride, 'S': [], 'R': []})
        by_block[blk]['S'].append(S)
        by_block[blk]['R'].append(R)

    for blk, d in by_block.items():
        S = np.stack(d['S'])                # (sweeps, positions, steps)
        R = np.stack(d['R'])
        H = np.zeros_like(S)
        ok = np.abs(R) > 1e-12
        H[ok] = S[ok] / R[ok]
        leads = d['leads']
        nsw = S.shape[0]
        print(f"\n=== {blk}: {nsw} captures, window {win} samples "
              f"({win/SAMPLE_RATE*1e6:.0f} us), dwell stride {d['stride']}, "
              f"engine nios_settle {d['settle']} ===")
        print(f"  {'lead':>7}{'us after':>10} | "
              f"{'|S| rel':>9}{'|R| rel':>9}{'ph(H) mrad':>12} | "
              f"{'cv|S| %':>9}{'cv|R| %':>9}{'cv|H| %':>9}{'sd phH mrad':>13}")
        print(f"  {'(smp)':>7}{'retune':>10} | "
              f"{'-- TREND vs last position --':^30} | "
              f"{'---------- WOBBLE, sweep to sweep ----------':^40}")
        refS = np.abs(S[:, -1, :]).mean()
        refR = np.abs(R[:, -1, :]).mean()
        refP = H[:, -1, :]
        for li, lead in enumerate(leads):
            mS = np.abs(S[:, li, :]).mean() / refS
            mR = np.abs(R[:, li, :]).mean() / refR
            dph = np.angle((H[:, li, :] * np.conj(refP)).mean()) * 1e3
            def cv(x):
                if nsw < 2:
                    return np.nan
                m = np.abs(x[:, li, :])
                return 100 * (np.diff(m, axis=0).std() / np.sqrt(2)
                              / max(m.mean(), 1e-30))
            zz = H[:, li, :] / np.maximum(np.abs(H[:, li, :]), 1e-30)
            sdp = (np.angle(zz[1:] * np.conj(zz[:-1])).std() / np.sqrt(2) * 1e3
                   if nsw > 1 else np.nan)
            print(f"  {lead:>7}{lead/SAMPLE_RATE*1e6:>10.1f} | "
                  f"{mS:>9.5f}{mR:>9.5f}{dph:>12.2f} | "
                  f"{cv(S):>9.3f}{cv(R):>9.3f}{cv(H):>9.3f}{sdp:>13.2f}")
        print("  TREND columns are relative to the LAST position, so a settled "
              "channel reads 1.00000 / 0.00 all the way up.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
