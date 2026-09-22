#!/usr/bin/env python3
"""Per-retune wobble probe: record h_signal and h_reference SEPARATELY.

The SDR websocket only ever carries h_cal = h_signal / h_reference, so nothing
downstream can tell a wobble in the antenna channel from one in the reference.
This drives SFCWEngine directly (stop sdr_server first) in 'nios' mode, where
the host still sees raw IQ, and stores one complex phasor per channel per step
per sweep.

    stop sdr_server (leave stream.py/rover_server alone), then:

    python3 pi/radar/probe_wobble.py --sweeps 300 --out base.npz
    python3 pi/radar/probe_wobble.py --const-freq 3500 --sweeps 300 --out const.npz
    python3 pi/radar/probe_wobble.py --tx2 30 --rx2 20 --sweeps 300 --out g3020.npz
    python3 pi/radar/probe_wobble.py --window-scan --sweeps 40 --out win.npz

Blocks are meant to be BRACKETED: run the control config, then the variant,
then the control again, and treat anything inside the control spread as no
effect. --block runs several configs back to back in one device session, which
is the cheapest way to bracket (no reopen between them).

Analyse with analyze_wobble.py.
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from radar.bladerf_driver import BladeRFDriver          # noqa: E402
from radar.sfcw_engine import SFCWEngine, master_grid_freqs  # noqa: E402


def build_const_grid(engine, freq_hz, num_steps):
    """A 'sweep' that retunes to the SAME frequency every step.

    The point of this is to separate 'a retune happened' from 'the frequency
    changed'. The NIOS still fires one retune per step and the capture is
    sliced identically, so everything about the measurement is the same except
    that the synthesizer is asked for the frequency it is already on.
    """
    master = engine._qt_master_freqs
    idx = int(np.argmin(np.abs(master - int(freq_hz))))
    f = int(master[idx])
    freqs = np.full(num_steps, f, dtype=np.int64)
    qt_rx = [engine._qt_master_rx[idx]] * num_steps
    qt_tx = [engine._qt_master_tx[idx]] * num_steps
    return freqs, qt_rx, qt_tx


def read_gains(engine):
    """What the RFIC actually took -- libbladeRF silently clamps to range."""
    from bladerf._bladerf import ffi, libbladeRF
    import bladerf as _b
    dev = engine.driver.device.dev[0]
    out = {}
    for label, ch in (('tx1', _b.CHANNEL_TX(0)), ('tx2', _b.CHANNEL_TX(1)),
                      ('rx1', _b.CHANNEL_RX(0)), ('rx2', _b.CHANNEL_RX(1))):
        v = ffi.new('int *')
        out[label] = int(v[0]) if libbladeRF.bladerf_get_gain(dev, ch, v) == 0 else None
    return out


def build_list_grid(engine, freqs_mhz, num_steps):
    """A grid cycling through an explicit list of frequencies.

    [f]        -> retune to the same frequency every step (no frequency change)
    [f1, f2]   -> alternate, so every step is a jump of exactly f2 - f1
    Lets the size of the frequency JUMP be varied independently of everything
    else about the sweep.
    """
    master = engine._qt_master_freqs
    idxs = []
    for f in freqs_mhz:
        idxs.append(int(np.argmin(np.abs(master - int(float(f) * 1e6)))))
    pick = [idxs[i % len(idxs)] for i in range(num_steps)]
    freqs = np.array([int(master[i]) for i in pick], dtype=np.int64)
    return (freqs, [engine._qt_master_rx[i] for i in pick],
            [engine._qt_master_tx[i] for i in pick])


def apply_cfg(engine, cfg):
    """Push one config onto the engine. Gains need the modules re-poked."""
    # In 'dsp' mode a sweep is usually in flight (pipelined EXEC) and the FPGA
    # stepper then OWNS the AD9361 SPI, so gain/register writes below would be
    # silently lost or land corrupted. Drain the in-flight sweep first, the
    # same way the engine's own gain path and re-prime do. Measured: without
    # this, 4-6 of 9 gain changes during a live dsp session landed wrong or
    # not at all; with it, 9/9.
    if engine.sweep_mode == 'dsp' and getattr(engine, '_nios_primed_steps', 0):
        engine._dsp_cancel_pending(engine._nios_primed_steps)
    for k in ('tx1_gain', 'rx1_gain', 'tx2_gain', 'rx2_gain'):
        if cfg.get(k) is not None:
            setattr(engine, k, int(cfg[k]))
    if cfg.get('settle_count') is not None:
        engine.settle_count = int(cfg['settle_count'])
    # dsp-chain knobs go through set_params, which owns the rounding, the
    # dwell floor (stepper preload) and the chain-dirty flag; the engine then
    # pushes the selection to the FPGA between sweeps.
    dsp_keys = {k: cfg[k] for k in ('dsp_flush_sel', 'dsp_accum_sel',
                                    'dsp_dwell') if cfg.get(k) is not None}
    if dsp_keys:
        engine.set_params(**dsp_keys)
    if cfg.get('nios_settle') is not None:
        engine.nios_settle = int(cfg['nios_settle'])
    if cfg.get('nios_dwell') is not None:
        engine.nios_dwell = int(cfg['nios_dwell'])
    engine.driver.tx_gain = engine.tx1_gain
    engine.driver.rx_gain = engine.rx1_gain
    engine.driver.tx2_gain = engine.tx2_gain
    engine.driver.rx2_gain = engine.rx2_gain
    engine.driver.reapply_dual_gains()

    # AD9361 tracking calibrations -- see rfic_regs.py. These are written on
    # EVERY block, not only the ones that ask, so a control block is guaranteed
    # to be at the session baseline instead of silently inheriting whatever the
    # previous block left in the RFIC.
    from radar.rfic_regs import set_tracking, write_reg, CAL_CFG_1, DC_OFFSET_CFG_2
    dev = engine.driver.device.dev[0]
    base = getattr(engine, '_probe_rfic_base', None)
    trk = {k: cfg.get(k) for k in ('rx_quad_track', 'apply_quad_corr',
                                   'bb_dc_track', 'rf_dc_track')}
    if any(v is not None for v in trk.values()):
        if base is not None:                 # start from the baseline every time
            write_reg(dev, CAL_CFG_1, base[0])
            write_reg(dev, DC_OFFSET_CFG_2, base[1])
        set_tracking(dev, **trk)
    elif base is not None:
        write_reg(dev, CAL_CFG_1, base[0])
        write_reg(dev, DC_OFFSET_CFG_2, base[1])


def run_block(engine, cfg, sweeps, freqs, qt_rx, qt_tx, keep_captures=0,
              settle_s=1.0):
    """One measurement block. Returns a dict of arrays."""
    apply_cfg(engine, cfg)
    prev_mode = engine.sweep_mode
    if cfg.get('core'):
        engine.sweep_mode = cfg['core']
    time.sleep(settle_s)             # let any gain change settle before block 0

    n = len(freqs)  # noqa: F841 (kept for readability below)
    sig = np.zeros((sweeps, n), dtype=np.complex128)
    ref = np.zeros((sweeps, n), dtype=np.complex128)
    hcal = np.zeros((sweeps, n), dtype=np.complex128)
    tstamp = np.zeros(sweeps, dtype=np.float64)
    core = np.zeros(sweeps, dtype='<U10')
    adc1 = np.zeros(sweeps, dtype=np.float64)
    adc2 = np.zeros(sweeps, dtype=np.float64)
    caps = []

    engine.keep_raw_channels = True
    got = 0
    attempts = 0
    while got < sweeps and attempts < sweeps * 4:
        attempts += 1
        engine.keep_full_capture = (len(caps) < keep_captures)
        engine._last_channels = None
        h, dropped, adc = engine._sweep_dispatch(freqs, qt_rx, qt_tx,
                                                 engine.num_buffers,
                                                 engine.settle_count)
        t = time.time()
        if h is None:
            continue
        if engine._last_channels is None:
            # 'dsp' mode: the FPGA demodulates AND divides, so the two halves
            # never exist on the host. h_cal metrics still work; the
            # per-channel split does not, and the analyser detects the zeros.
            if engine.sweep_mode != 'dsp':
                continue             # a nios/standard fallback sweep: skip it
        else:
            s, r = engine._last_channels
            sig[got] = s
            ref[got] = r
        hcal[got] = h
        tstamp[got] = t
        core[got] = engine._last_sweep_core
        if adc:
            adc1[got] = adc.get('rx1', 0.0)
            adc2[got] = adc.get('rx2', 0.0)
        if engine.keep_full_capture and engine._last_capture is not None:
            caps.append(engine._last_capture)
            engine._last_capture = None
        got += 1
    engine.keep_raw_channels = False
    engine.keep_full_capture = False
    engine.sweep_mode = prev_mode

    return {
        'sig': sig[:got], 'ref': ref[:got], 'hcal': hcal[:got],
        't': tstamp[:got], 'core': core[:got],
        'adc_rx1': adc1[:got], 'adc_rx2': adc2[:got],
        'freqs': np.asarray(freqs, dtype=np.int64),
        'cfg': json.dumps(cfg), 'attempts': attempts, 'captures': caps,
    }


def merge(acc, res):
    """Accumulate one chunk into a block's running result."""
    if acc is None:
        return {k: (list(v) if k == 'captures' else v) for k, v in res.items()}
    for k in ('sig', 'ref', 'hcal', 't', 'core', 'adc_rx1', 'adc_rx2'):
        acc[k] = np.concatenate([acc[k], res[k]])
    acc['attempts'] += res['attempts']
    acc['captures'] = list(acc['captures']) + list(res['captures'])
    return acc


def run_interleaved(engine, blocks, grids, total, chunk, keep_captures,
                    settle_s=0.4):
    """Cycle the configs in small chunks instead of running each to completion.

    Block-sequential A/B is only valid if the bench holds still for the whole
    session, and on this rig it does not: the TX2->RX2 loopback throws episodes
    that last tens of seconds, so a config that happens to run during one is
    scored for the bench's behaviour rather than its own. Rotating in chunks
    spreads every episode across every config, which turns a bias into noise
    that the control spread then reports honestly.
    """
    acc = {b.get('name', f'block{i}'): None for i, b in enumerate(blocks)}
    done = {k: 0 for k in acc}
    rounds = 0
    while any(v < total for v in done.values()):
        rounds += 1
        for i, cfg in enumerate(blocks):
            name = cfg.get('name', f'block{i}')
            want = min(chunk, total - done[name])
            if want <= 0:
                continue
            bf, bqr, bqt = grids[name]
            res = run_block(engine, cfg, want, bf, bqr, bqt,
                            keep_captures=(keep_captures
                                           if done[name] == 0 else 0),
                            settle_s=settle_s)
            acc[name] = merge(acc[name], res)
            done[name] += len(res['t'])
            if len(res['t']) == 0:      # nothing usable: do not spin forever
                done[name] = total
        print(f"[probe] interleave round {rounds}: "
              + "  ".join(f"{k}={v}" for k, v in done.items()), flush=True)
    return acc


def save(out, meta, freqs, path):
    out = dict(out)
    out['freqs'] = np.asarray(freqs, dtype=np.int64)
    out['meta'] = np.array(json.dumps(meta))
    np.savez_compressed(path, **out)
    print(f"[probe] wrote {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sweeps', type=int, default=300)
    ap.add_argument('--start', type=float, default=2000.0, help='MHz')
    ap.add_argument('--stop', type=float, default=5000.0, help='MHz')
    ap.add_argument('--step', type=float, default=60.0, help='MHz')
    ap.add_argument('--const-freq', type=float, default=None,
                    help='MHz: retune to THIS frequency every step instead of '
                         'sweeping. Separates "a retune happened" from "the '
                         'frequency changed".')
    ap.add_argument('--const-steps', type=int, default=51)
    ap.add_argument('--tx1', type=int, default=None)
    ap.add_argument('--rx1', type=int, default=None)
    ap.add_argument('--tx2', type=int, default=None)
    ap.add_argument('--rx2', type=int, default=None)
    ap.add_argument('--nios-settle', type=int, default=None)
    ap.add_argument('--nios-dwell', type=int, default=None)
    ap.add_argument('--keep-captures', type=int, default=0,
                    help='store N full raw captures (~8 MB each) so a probe '
                         'can re-demodulate sub-windows inside each dwell')
    ap.add_argument('--block', action='append', default=None,
                    help='JSON config for one block; repeat to run several '
                         'back to back in one device session (bracketing). '
                         'e.g. --block \'{"name":"ctrl"}\' '
                         '--block \'{"name":"v","tx2_gain":30,"rx2_gain":20}\'')
    ap.add_argument('--mode', default='nios',
                    choices=('nios', 'standard', 'dsp'),
                    help="sweep core for the whole session. 'dsp' must be set "
                         "here, not per block: the RX sample format is fixed "
                         "when the stream is configured.")
    ap.add_argument('--interleave', type=int, default=0,
                    help='rotate the configs every N sweeps instead of running '
                         'each block to completion. Makes an A/B immune to the '
                         'slow bench episodes this rig throws.')
    ap.add_argument('--out', default='wobble.npz')
    args = ap.parse_args()

    driver = BladeRFDriver()
    driver.open()
    engine = SFCWEngine(driver)
    # 'nios' and 'standard' leave raw IQ on the host, so the per-channel split
    # works. 'dsp' does the demod AND the division on the FPGA, so only h_cal
    # exists -- and the sample format is fixed when the stream is configured,
    # so dsp cannot be mixed with the other two in one session.
    engine.sweep_mode = args.mode

    for k, v in (('tx1_gain', args.tx1), ('rx1_gain', args.rx1),
                 ('tx2_gain', args.tx2), ('rx2_gain', args.rx2)):
        if v is not None:
            setattr(engine, k, v)
    if args.nios_settle is not None:
        engine.nios_settle = args.nios_settle
    if args.nios_dwell is not None:
        engine.nios_dwell = args.nios_dwell

    engine.set_params(start_freq=args.start * 1e6, stop_freq=args.stop * 1e6,
                      step_size=args.step * 1e6)
    engine._configure_hardware()
    engine._start_tx_rx()

    from radar.rfic_regs import snapshot, write_reg, CAL_CFG_1, DC_OFFSET_CFG_2
    _c1, _d2, _dec = snapshot(engine.driver.device.dev[0])
    engine._probe_rfic_base = (_c1, _d2)
    print(f"[probe] RFIC baseline 0x169={_c1:#04x} 0x18B={_d2:#04x} {_dec}")

    if args.const_freq is not None:
        freqs, qt_rx, qt_tx = build_const_grid(engine, args.const_freq * 1e6,
                                               args.const_steps)
        print(f"[probe] CONSTANT frequency {freqs[0]/1e6:.0f} MHz x "
              f"{len(freqs)} retunes per sweep")
    else:
        with engine._lock:
            st, sp, sz = engine.start_freq, engine.stop_freq, engine.step_size
        freqs, qt_rx, qt_tx = engine._build_sweep_grid(st, sp, sz)
        print(f"[probe] sweep {freqs[0]/1e6:.0f}-{freqs[-1]/1e6:.0f} MHz, "
              f"{len(freqs)} steps")

    blocks_cfg = ([json.loads(b) for b in args.block] if args.block
                  else [{'name': 'block0'}])

    # Warm-up: the first sweeps after a stream start include the NIOS prime and
    # whatever the ring was holding. Never scored.
    for _ in range(12):
        engine._sweep_dispatch(freqs, qt_rx, qt_tx, engine.num_buffers,
                               engine.settle_count)

    def grid_for(cfg):
        if cfg.get('freq_list') is not None:
            return build_list_grid(engine, cfg['freq_list'],
                                   int(cfg.get('const_steps', args.const_steps)))
        if cfg.get('const_freq') is not None:
            return build_const_grid(engine, float(cfg['const_freq']) * 1e6,
                                    int(cfg.get('const_steps', args.const_steps)))
        if cfg.get('no_quicktune'):
            return freqs, None, None
        return freqs, qt_rx, qt_tx

    out = {}
    meta = []
    try:
        if args.interleave:
            grids = {c.get('name', f'block{i}'): grid_for(c)
                     for i, c in enumerate(blocks_cfg)}
            for i, c in enumerate(blocks_cfg):
                nm = c.get('name', f'block{i}')
                g = grids[nm][0]
                print(f"[probe] block '{nm}' cfg={c} ({len(g)} steps, "
                      f"{g[0]/1e6:.0f}-{g[-1]/1e6:.0f} MHz)")
            t0 = time.time()
            acc = run_interleaved(engine, blocks_cfg, grids, args.sweeps,
                                  args.interleave, args.keep_captures)
            dt = time.time() - t0
            print(f"[probe] interleaved session done in {dt:.1f}s, "
                  f"gains {read_gains(engine)}")
            for i, cfg in enumerate(blocks_cfg):
                name = cfg.get('name', f'block{i}')
                res = acc[name]
                if res is None or len(res['t']) == 0:
                    print(f"[probe]   {name}: 0 usable sweeps")
                    continue
                got = len(res['t'])
                print(f"[probe]   {name}: {got} sweeps, "
                      f"{res['attempts']-got} skipped, "
                      f"rx1 peak {res['adc_rx1'].max():.0f} "
                      f"rx2 peak {res['adc_rx2'].max():.0f}")
                for k in ('sig', 'ref', 'hcal', 't', 'core', 'adc_rx1',
                          'adc_rx2', 'freqs'):
                    out[f'{name}__{k}'] = res[k]
                for ci, cap in enumerate(res['captures']):
                    for k, v in cap.items():
                        out[f'{name}__cap{ci}__{k}'] = np.asarray(v)
                meta.append({'name': name, 'cfg': cfg, 'sweeps': got,
                             'seconds': round(dt, 2),
                             'skipped': int(res['attempts'] - got)})
            blocks_cfg = []          # skip the sequential loop below
            save(out, meta, freqs, args.out)
        for bi, cfg in enumerate(blocks_cfg):
            name = cfg.get('name', f'block{bi}')
            # A block may override the grid, so a constant-frequency run can be
            # bracketed by stepped controls inside ONE device session.
            if cfg.get('freq_list') is not None:
                bf, bqr, bqt = build_list_grid(
                    engine, cfg['freq_list'],
                    int(cfg.get('const_steps', args.const_steps)))
            elif cfg.get('const_freq') is not None:
                bf, bqr, bqt = build_const_grid(
                    engine, float(cfg['const_freq']) * 1e6,
                    int(cfg.get('const_steps', args.const_steps)))
            else:
                bf, bqr, bqt = freqs, qt_rx, qt_tx
            if cfg.get('no_quicktune'):
                # _sweep_core falls back to a full bladerf_set_frequency per
                # step when it has no profiles -- a complete VCO calibration
                # rather than a fastlock recall. Slow, but it is the only way
                # to ask whether quick-tune itself is what re-randomises the
                # measurement.
                bqr, bqt = None, None
            print(f"[probe] block '{name}' cfg={cfg} "
                  f"({len(bf)} steps, {bf[0]/1e6:.0f}-{bf[-1]/1e6:.0f} MHz) ...",
                  flush=True)
            t0 = time.time()
            res = run_block(engine, cfg, cfg.get('sweeps', args.sweeps),
                            bf, bqr, bqt,
                            keep_captures=cfg.get('keep_captures',
                                                  args.keep_captures))
            dt = time.time() - t0
            got = len(res['t'])
            if got == 0:
                print(f"[probe]   *** 0 usable sweeps in {dt:.1f}s "
                      f"({res['attempts']} attempts, all fallbacks) -- "
                      f"block skipped", flush=True)
                meta.append({'name': name, 'cfg': cfg, 'sweeps': 0,
                             'seconds': round(dt, 2),
                             'skipped': int(res['attempts'])})
                continue
            print(f"[probe]   {got} sweeps in {dt:.1f}s "
                  f"({got/max(dt,1e-9):.1f} Hz), {res['attempts']-got} skipped "
                  f"(fallbacks), rx1 peak {res['adc_rx1'].max():.0f} "
                  f"rx2 peak {res['adc_rx2'].max():.0f} "
                  f"gains {read_gains(engine)}", flush=True)
            for k in ('sig', 'ref', 'hcal', 't', 'core', 'adc_rx1', 'adc_rx2',
                      'freqs'):
                out[f'{name}__{k}'] = res[k]
            for ci, cap in enumerate(res['captures']):
                for k, v in cap.items():
                    out[f'{name}__cap{ci}__{k}'] = np.asarray(v)
            meta.append({'name': name, 'cfg': cfg, 'sweeps': got,
                         'seconds': round(dt, 2),
                         'skipped': int(res['attempts'] - got)})
            save(out, meta, freqs, args.out)
    finally:
        try:
            # Never leave the RFIC in a probe's state -- these registers persist
            # on the device until something rewrites them, and sdr_server would
            # then inherit them with nothing on screen saying so.
            write_reg(engine.driver.device.dev[0], CAL_CFG_1, _c1)
            write_reg(engine.driver.device.dev[0], DC_OFFSET_CFG_2, _d2)
            print(f"[probe] RFIC restored to 0x169={_c1:#04x} 0x18B={_d2:#04x}")
        except Exception as e:
            print(f"[probe] WARNING: could not restore RFIC registers: {e}")
        # Teardown must never lose the data. In 'dsp' mode especially,
        # _stop_tx_rx() can raise (_rfic_host_get_gain returns InvalError once
        # the RX module is down) or hang in sync_worker's stop, and the save
        # would then never run -- which is why the save happens before this.
        try:
            engine._stop_tx_rx()
        except Exception as e:
            print(f"[probe] WARNING: _stop_tx_rx failed: {e}")
        try:
            driver.close()
        except Exception as e:
            print(f"[probe] WARNING: driver.close failed: {e}")

    save(out, meta, freqs, args.out)


if __name__ == '__main__':
    main()
