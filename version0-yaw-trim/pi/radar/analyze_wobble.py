#!/usr/bin/env python3
"""Score a probe_wobble.py capture: S_repeat, per-channel CV, and the
common-mode / signal-only / reference-only split.

    python3 pi/radar/analyze_wobble.py base.npz [more.npz ...]

METRICS

S_repeat  signal energy over ADJACENT-SWEEP difference energy, /2 (a difference
          of two independent samples has twice the variance). Adjacent, not
          deviation-from-the-mean, so slow drift during a block does not score
          as wobble -- that is what made one 2026-08-29 run read 41.8 dB where
          runs minutes earlier gave 47.
          Reported WINDOWED (100 sweeps) with the worst 2 steps of each window
          trimmed, because the TX2->RX2 loopback on this bench throws discrete
          single-step episodes that drag a whole block's aggregate into the
          teens while the other sweeps sit at 33-36 dB.

CV        sweep-to-sweep coefficient of variation of |S|, |R|, |H| per step,
          then the median over steps. Magnitudes, because they are immune to
          the LO phase the fastlock recall re-randomises.

SPLIT     with a = d|S|/|S| and b = d|R|/|R| per step:
              common     = cov(a, b)                (cancels in the ratio)
              signal     = var(a) - cov(a, b)       (does NOT cancel)
              reference  = var(b) - cov(a, b)       (does NOT cancel)
          reported as sqrt, in percent. h_cal's own variance is var(a-b).
"""
import json
import sys

import numpy as np


def contiguous_runs(t, factor=3.0):
    """Split a block into runs of genuinely consecutive sweeps.

    With --interleave the stored sweeps of one config are several chunks that
    were seconds apart on the bench, so np.diff over the concatenation
    differences pairs that were never adjacent. S_repeat is an ADJACENT-sweep
    metric and silently reads several dB low if those pairs are included --
    measured on the 1300-sweep validation, 36.4 dB across the concatenation
    against 41.4 dB within chunks, for the same data.
    """
    if t is None or len(t) < 3:
        return [(0, len(t) if t is not None else 0)]
    dt = np.diff(t)
    med = np.median(dt[dt > 0]) if np.any(dt > 0) else 0.0
    if med <= 0:
        return [(0, len(t))]
    brk = np.flatnonzero(dt > factor * med) + 1
    edges = [0, *brk.tolist(), len(t)]
    return [(a, b) for a, b in zip(edges[:-1], edges[1:]) if b - a >= 10]


def s_repeat_windowed(h, win=100, trim=2, t=None):
    """Windowed, worst-`trim`-steps-trimmed S_repeat in dB. Returns per-window.

    Windows never span a break in time (see contiguous_runs).
    """
    out = []
    spans = []
    for a, b in contiguous_runs(t if t is not None else np.arange(len(h))):
        for s in range(a, b - 1, win):
            e = min(s + win, b)
            if e - s >= 10:
                spans.append((s, e))
    for s, e in spans:
        seg = h[s:e]
        d = np.diff(seg, axis=0)
        num = (np.abs(seg[1:]) ** 2).mean(axis=0)      # per step
        den = (np.abs(d) ** 2).mean(axis=0) / 2.0
        if trim > 0 and len(den) > trim:
            keep = np.argsort(den)[:len(den) - trim]   # drop worst-energy steps
            num, den = num[keep], den[keep]
        tot = den.sum()
        out.append(10 * np.log10(num.sum() / tot) if tot > 0 else np.nan)
    return np.array(out)


def s_repeat_raw(h):
    d = np.diff(h, axis=0)
    den = (np.abs(d) ** 2).sum() / 2.0
    return 10 * np.log10((np.abs(h[1:]) ** 2).sum() / den) if den > 0 else np.nan


def adj_cv(x, t=None):
    """Per-step ADJACENT-sweep fractional spread of |x|, in percent.

    This is the quantity S_repeat is built from, so it is the one to quote
    beside it. frac()/cv below is deviation from the BLOCK MEAN, which also
    counts slow drift across the block -- useful, but a different number, and
    mixing the two silently is how a 16x turns into a 5x.
    """
    m = np.abs(x)
    ds = [np.diff(m[a:b], axis=0)
          for a, b in contiguous_runs(t if t is not None else np.arange(len(m)))]
    d = np.concatenate(ds) if ds else np.diff(m, axis=0)
    mu = m.mean(axis=0)
    return 100 * d.std(axis=0) / np.sqrt(2) / np.maximum(mu, 1e-30)


def frac(x):
    """Per-step fractional deviation of |x| about its own mean, sweep to sweep."""
    m = np.abs(x)
    mu = m.mean(axis=0, keepdims=True)
    return (m - mu) / np.maximum(mu, 1e-30)


def split(sig, ref):
    a, b = frac(sig), frac(ref)
    va = a.var(axis=0)
    vb = b.var(axis=0)
    cab = (a * b).mean(axis=0) - a.mean(axis=0) * b.mean(axis=0)
    vh = (a - b).var(axis=0)
    def pct(v):
        return 100 * np.sqrt(np.maximum(v, 0.0))
    return {
        'common_pct': pct(cab), 'sig_only_pct': pct(va - cab),
        'ref_only_pct': pct(vb - cab), 'hmag_pct': pct(vh),
        'sig_pct': pct(va), 'ref_pct': pct(vb),
        'rho': cab / np.maximum(np.sqrt(va * vb), 1e-30),
    }


def additive_vs_multiplicative(h):
    """Is the sweep-to-sweep error a FIXED phasor added to h_cal, or a FIXED
    FRACTION of it?

    Additive (external interference, thermal noise, a spur) gives a residual
    whose absolute size does not care how big |H| is at that step, so it is
    flat across a profile whose |H| spans tens of dB. Multiplicative (a gain
    or phase wobble somewhere in the chain) gives a residual proportional to
    |H|. The correlation between the two, over steps, separates them -- and it
    is a strong test here because |H| spans ~17x across a 2-5 GHz sweep.

    Returns per-step mean phasor, per-step complex residual sd, and the
    correlation. h_cal's phase is stable sweep to sweep (the LO phase cancels
    in the ratio), so the mean phasor is meaningful and no de-rotation is
    needed.
    """
    mH = h.mean(axis=0)
    res = h - mH
    sd = np.sqrt((np.abs(res) ** 2).mean(axis=0))
    mag = np.abs(mH)
    if len(mag) > 2 and mag.std() > 0 and sd.std() > 0:
        r = float(np.corrcoef(mag, sd)[0, 1])
        # slope of a log-log fit: 1.0 = purely multiplicative, 0.0 = additive
        good = (mag > 0) & (sd > 0)
        slope = (float(np.polyfit(np.log(mag[good]), np.log(sd[good]), 1)[0])
                 if good.sum() > 3 else np.nan)
    else:
        r, slope = np.nan, np.nan
    return mag, sd, r, slope


def phase_cv(x):
    """Per-step sweep-to-sweep phase std (rad), unwrapped about the mean phasor."""
    z = x / np.maximum(np.abs(x), 1e-30)
    m = z.mean(axis=0, keepdims=True)
    m = m / np.maximum(np.abs(m), 1e-30)
    return np.angle(z * np.conj(m)).std(axis=0)


def robust_z_outliers(h, thresh=8.0):
    """Per-(sweep, step) cells beyond `thresh` robust sigma of that step."""
    m = np.abs(h)
    med = np.median(m, axis=0, keepdims=True)
    mad = np.median(np.abs(m - med), axis=0, keepdims=True) * 1.4826
    z = np.abs(m - med) / np.maximum(mad, 1e-30)
    return int((z > thresh).sum()), float(z.max()), z.size


def drift(x):
    """Fraction of per-step |x| variance explained by a straight line in sweep
    index -- separates slow drift (thermal) from white per-retune noise."""
    m = np.abs(x)
    n = len(m)
    t = np.arange(n) - (n - 1) / 2.0
    tt = (t * t).sum()
    mu = m.mean(axis=0, keepdims=True)
    r = m - mu
    slope = (t[:, None] * r).sum(axis=0) / tt
    expl = (slope ** 2) * tt
    tot = (r ** 2).sum(axis=0)
    return expl / np.maximum(tot, 1e-30), slope / np.maximum(mu[0], 1e-30) * n * 100


def lag1(x):
    r = frac(x)
    a = r[:-1] - r[:-1].mean(axis=0)
    b = r[1:] - r[1:].mean(axis=0)
    return ((a * b).mean(axis=0) /
            np.maximum(a.std(axis=0) * b.std(axis=0), 1e-30))


def const_freq_report(name, sig, ref, h):
    """For a block where every step is the SAME frequency.

    Consecutive steps are one dwell apart (0.41 ms at 4096 samples) and each
    follows its own retune, while the scene cannot move in that time. So the
    step-to-step spread WITHIN one sweep is the per-retune wobble with the room
    held out, and comparing it against the sweep-to-sweep spread of the same
    quantity says how much of the latter is the room (or drift) rather than the
    retune.
    """
    def adj_cv(x, axis):
        m = np.abs(x)
        d = np.diff(m, axis=axis)
        mu = m.mean()
        # adjacent-difference sd of a stationary series is sqrt(2)*sigma
        return 100 * d.std() / np.sqrt(2) / max(mu, 1e-30)

    out = {}
    for lbl, x in (('S', sig), ('R', ref), ('H', h)):
        out[f'step_{lbl}'] = adj_cv(x, 1)     # step to step, within a sweep
        out[f'sweep_{lbl}'] = adj_cv(x, 0)    # sweep to sweep, same step
    # phase, same two axes
    for lbl, x in (('H', h),):
        z = x / np.maximum(np.abs(x), 1e-30)
        out[f'step_ph{lbl}'] = float(np.angle(z[:, 1:] * np.conj(z[:, :-1])).std()
                                     / np.sqrt(2))
        out[f'sweep_ph{lbl}'] = float(np.angle(z[1:] * np.conj(z[:-1])).std()
                                      / np.sqrt(2))
    print(f"\n  CONSTANT-FREQUENCY block '{name}': every step is one more retune "
          f"to the same frequency.")
    print(f"    {'':<10}{'|S| %':>9}{'|R| %':>9}{'|H| %':>9}{'ph(H) rad':>12}")
    print(f"    {'step->step':<10}{out['step_S']:>9.3f}{out['step_R']:>9.3f}"
          f"{out['step_H']:>9.3f}{out['step_phH']:>12.5f}   "
          f"<- per-retune, scene frozen (0.41 ms apart)")
    print(f"    {'sweep->sweep':<10}{out['sweep_S']:>9.3f}{out['sweep_R']:>9.3f}"
          f"{out['sweep_H']:>9.3f}{out['sweep_phH']:>12.5f}   "
          f"<- per-retune + scene/drift")
    extra_S = out['sweep_S'] ** 2 - out['step_S'] ** 2
    extra_H = out['sweep_H'] ** 2 - out['step_H'] ** 2
    print(f"    implied non-retune term:  |S| "
          f"{np.sqrt(max(extra_S,0)):.3f}%   |H| {np.sqrt(max(extra_H,0)):.3f}%")
    return out


def report(path, verbose=True):
    z = np.load(path, allow_pickle=True)
    meta = json.loads(str(z['meta'])) if 'meta' in z else []
    freqs = z['freqs'] if 'freqs' in z else None
    names = [m['name'] for m in meta] or sorted(
        {k.split('__')[0] for k in z.files if '__' in k})
    rows = []
    for name in names:
        try:
            sig, ref, h = z[f'{name}__sig'], z[f'{name}__ref'], z[f'{name}__hcal']
        except KeyError:
            continue
        if len(h) < 20:
            continue
        tt = z[f'{name}__t'] if f'{name}__t' in z.files else None
        sw = s_repeat_windowed(h, t=tt)
        have_ch = np.abs(sig).max() > 0 and np.abs(ref).max() > 0
        if not have_ch:
            # 'dsp' mode: no per-channel data exists (the FPGA divides on chip).
            sig = ref = h
        sp = split(sig, ref)
        no, zmax, ncell = robust_z_outliers(h)
        dh, slope_pct = drift(h)
        mag, sdres, r_am, slope_am = additive_vs_multiplicative(h)
        cfg = next((m['cfg'] for m in meta if m['name'] == name), {})
        bfreqs = z[f'{name}__freqs'] if f'{name}__freqs' in z.files else freqs
        is_const = bfreqs is not None and len(np.unique(bfreqs)) == 1
        row = {
            'name': name, 'n': len(h), 'cfg': cfg,
            'S_rep_win': float(np.nanmedian(sw)),
            'S_rep_win_lo': float(np.nanmin(sw)) if len(sw) else np.nan,
            'S_rep_win_hi': float(np.nanmax(sw)) if len(sw) else np.nan,
            'S_rep_raw': float(s_repeat_raw(h)),
            'runs': len(contiguous_runs(tt if tt is not None
                                        else np.arange(len(h)))),
            'cv_S': float(np.median(sp['sig_pct'])),
            'cv_R': float(np.median(sp['ref_pct'])),
            'cv_H': float(np.median(sp['hmag_pct'])),
            'adj_S': float(np.median(adj_cv(sig, tt))),
            'adj_R': float(np.median(adj_cv(ref, tt))),
            'adj_H': float(np.median(adj_cv(h, tt))),
            'common': float(np.median(sp['common_pct'])),
            'sig_only': float(np.median(sp['sig_only_pct'])),
            'ref_only': float(np.median(sp['ref_only_pct'])),
            'rho': float(np.median(sp['rho'])),
            'ph_S': float(np.median(phase_cv(sig))),
            'ph_R': float(np.median(phase_cv(ref))),
            'ph_H': float(np.median(phase_cv(h))),
            'z_out': no, 'z_max': zmax, 'z_cells': ncell,
            'drift_frac': float(np.median(dh)),
            'lag1_H': float(np.median(lag1(h))),
            'adc1': float(z[f'{name}__adc_rx1'].max()),
            'adc2': float(z[f'{name}__adc_rx2'].max()),
            'per_step_cvH': sp['hmag_pct'],
            'per_step_cvS': sp['sig_pct'],
            'per_step_cvR': sp['ref_pct'],
            'is_const': bool(is_const), 'bfreqs': bfreqs,
            'have_ch': bool(have_ch),
            'Hmag': float(np.median(mag)), 'resid_sd': float(np.median(sdres)),
            'am_corr': r_am, 'am_slope': slope_am,
            'resid_arr': sdres, 'mag_arr': mag,
        }
        rows.append(row)

    if verbose:
        print(f"\n=== {path} ===")
        hdr = (f"{'block':<14}{'n':>5}{'S_rep':>8}{'[lo-hi]':>14}"
               f"{'adjS%':>7}{'adjR%':>7}{'adjH%':>7}"
               f"{'cvS%':>7}{'cvR%':>7}{'cvH%':>7}"
               f"{'com%':>7}{'sig%':>7}{'ref%':>7}{'rho':>6}"
               f"{'phH':>7}{'z>8':>6}{'zmax':>7}")
        print(hdr)
        print('-' * len(hdr))
        if any(not r['have_ch'] for r in rows):
            print("  NOTE: blocks marked * ran in 'dsp' mode -- the FPGA divides "
                  "on chip, so the S/R columns are h_cal repeated, not a split.")
        for r in rows:
            span = f"[{r['S_rep_win_lo']:.1f}-{r['S_rep_win_hi']:.1f}]"
            print(f"{r['name'] + ('' if r['have_ch'] else '*'):<14}{r['n']:>5}{r['S_rep_win']:>8.1f}{span:>14}"
                  f"{r['adj_S']:>7.3f}{r['adj_R']:>7.3f}{r['adj_H']:>7.3f}"
                  f"{r['cv_S']:>7.3f}{r['cv_R']:>7.3f}{r['cv_H']:>7.3f}"
                  f"{r['common']:>7.3f}{r['sig_only']:>7.3f}{r['ref_only']:>7.3f}"
                  f"{r['rho']:>6.2f}{r['ph_H']:>7.4f}"
                  f"{r['z_out']:>6}{r['z_max']:>7.1f}")
        print("\nadditive vs multiplicative: is the error a fixed phasor added to "
              "h_cal, or a fixed fraction of it?")
        print(f"  {'block':<14}{'med |H|':>9}{'med resid':>11}{'resid/|H|%':>12}"
              f"{'corr':>7}{'loglog slope':>14}")
        for r in rows:
            print(f"  {r['name']:<14}{r['Hmag']:>9.4f}{r['resid_sd']:>11.5f}"
                  f"{100*r['resid_sd']/max(r['Hmag'],1e-30):>12.3f}"
                  f"{r['am_corr']:>7.2f}{r['am_slope']:>14.2f}")
        print("  slope 1.0 = purely multiplicative (a gain/phase wobble), "
              "0.0 = purely additive (interference, noise, a spur).")

        print("  adj* = adjacent-sweep (what S_repeat is built from); "
              "cv* = deviation from the block mean (adds slow drift).")
        print(f"\nphase std (rad): S and R are dominated by the fastlock relock "
              f"and are meaningless alone; H is the one that matters.")
        for r in rows:
            print(f"  {r['name']:<14} ph_S {r['ph_S']:.3f}  ph_R {r['ph_R']:.3f}"
                  f"  ph_H {r['ph_H']:.5f}   drift {r['drift_frac']*100:5.1f}%"
                  f"  lag1 {r['lag1_H']:+.3f}   adc rx1 {r['adc1']:.0f}"
                  f" rx2 {r['adc2']:.0f}")
        for r in rows:
            if r['is_const']:
                const_freq_report(r['name'], z[f"{r['name']}__sig"],
                                  z[f"{r['name']}__ref"], z[f"{r['name']}__hcal"])
        stepped = [r for r in rows if not r['is_const']]
        if freqs is not None and len(stepped):
            rows_fs = stepped
            print("\nper-step cv of |H| (%), vs frequency:")
            f_mhz = freqs / 1e6
            for r in rows_fs:
                v = r['per_step_cvH']
                worst = np.argsort(v)[-4:][::-1]
                print(f"  {r['name']:<14} med {np.median(v):.3f}  "
                      f"p90 {np.percentile(v,90):.3f}  max {v.max():.3f} "
                      f"@{f_mhz[v.argmax()]:.0f}MHz   worst4: "
                      + ", ".join(f"{f_mhz[i]:.0f}MHz:{v[i]:.2f}" for i in worst))
            if len(rows_fs) >= 2:
                print("\n  frequency-structure repeatability "
                      "(corr of per-step cv between blocks):")
                for i in range(len(rows_fs)):
                    for j in range(i + 1, len(rows_fs)):
                        c = np.corrcoef(rows_fs[i]['per_step_cvH'],
                                        rows_fs[j]['per_step_cvH'])[0, 1]
                        cs = np.corrcoef(rows_fs[i]['per_step_cvS'],
                                         rows_fs[j]['per_step_cvS'])[0, 1]
                        print(f"    {rows_fs[i]['name']:>12} vs "
                              f"{rows_fs[j]['name']:<12} |H| {c:+.2f}"
                              f"   |S| {cs:+.2f}")
    return rows


if __name__ == '__main__':
    for p in sys.argv[1:]:
        report(p)
