#!/usr/bin/env python3
"""What is actually arriving at each ADC?

Reads the full raw nios captures stored by probe_wobble.py --keep-captures and
reports, per channel: DC offset, peak, how much of the record is at or near the
rail, and where the energy sits in frequency. adc_peak on the wire is a single
max over a whole sweep -- it says a rail was touched but not how often, by what,
or at which frequency, and those are the things that decide whether clipping is
costing anything.

    python3 pi/radar/analyze_adc.py cap.npz
"""
import argparse
import sys

import numpy as np

SAMPLE_RATE = 10_000_000.0
CW_OFFSET = 100_000.0
FULL_SCALE = 2047.0


def chan_stats(flat, stride, offset, num_steps, label):
    i = flat[0::2].astype(np.float64)
    q = flat[1::2].astype(np.float64)
    n = min(len(i), len(q))
    i, q = i[:n], q[:n]
    env = np.maximum(np.abs(i), np.abs(q))
    clip = float((env >= FULL_SCALE).mean())
    near = float((env >= 0.95 * FULL_SCALE).mean())
    rms = float(np.sqrt((i * i + q * q).mean()))
    print(f"    {label}: dc I {i.mean():+8.2f}  dc Q {q.mean():+8.2f}   "
          f"rms {rms:7.1f}  peak {env.max():6.0f} ({env.max()/FULL_SCALE*100:.0f}% FS)"
          f"   at-rail {clip*100:6.3f}%   >95% FS {near*100:6.3f}%")
    return {'clip': clip, 'rms': rms, 'dc': (i.mean(), q.mean())}


def spectrum(flat, label, nfft=8192, top=8):
    i = flat[0::2].astype(np.float64)
    q = flat[1::2].astype(np.float64)
    n = min(len(i), len(q), nfft * 40)
    z = (i[:n] + 1j * q[:n])
    m = (n // nfft) * nfft
    if m < nfft:
        return
    seg = z[:m].reshape(-1, nfft)
    w = np.hanning(nfft)
    P = (np.abs(np.fft.fft(seg * w, axis=1)) ** 2).mean(axis=0)
    P = np.fft.fftshift(P)
    f = np.fft.fftshift(np.fft.fftfreq(nfft, 1 / SAMPLE_RATE))
    Pdb = 10 * np.log10(np.maximum(P, 1e-12))
    Pdb -= Pdb.max()
    # report the biggest peaks, excluding the immediate neighbourhood of each
    order = np.argsort(Pdb)[::-1]
    picked = []
    for idx in order:
        if all(abs(f[idx] - f[j]) > 30e3 for j in picked):
            picked.append(idx)
        if len(picked) >= top:
            break
    print(f"    {label} spectrum, strongest components (dB rel own peak):")
    print("      " + "   ".join(f"{f[j]/1e3:+8.1f}kHz:{Pdb[j]:6.1f}" for j in picked))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('npz')
    args = ap.parse_args()
    z = np.load(args.npz, allow_pickle=True)
    caps = {}
    for k in z.files:
        if '__cap' in k:
            blk, rest = k.split('__cap', 1)
            idx, field = rest.split('__', 1)
            caps.setdefault((blk, int(idx)), {})[field] = z[k]
    if not caps:
        print("no full captures (run probe_wobble.py --keep-captures N)")
        return 1
    seen = set()
    for (blk, idx), c in sorted(caps.items()):
        if blk in seen:
            continue
        seen.add(blk)
        print(f"\n=== {blk} (capture {idx}) ===")
        for label, key in (('RX1 antenna  ', 'sig'), ('RX2 reference', 'ref')):
            chan_stats(c[key], int(c['stride']), int(c['offset']),
                       int(c['num_steps']), label)
        for label, key in (('RX1', 'sig'), ('RX2', 'ref')):
            spectrum(c[key], label)
        print("    (the sweep retunes during this record, so the spectrum is "
              "pooled over all steps: a line that stays put across steps shows "
              "here, one that moves smears)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
