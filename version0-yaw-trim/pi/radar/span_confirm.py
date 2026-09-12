#!/usr/bin/env python3
"""Record a continuous standoff traverse to confirm the span-clamp mechanism live.

Phase 1 concluded that the false targets come from querying the background model
outside its captured standoff span, where inferInterpModel silently clamps. That
conclusion was reached entirely offline -- leave-one-out residuals plus clamp
arithmetic -- and was never checked against the symptom. This tool closes that gap.

It records sweeps continuously while you move the antenna slowly through and past
both edges of the model's span, pairing each sweep with its own standoff. Run
span_analyze.py afterwards to get suppression vs. mm-outside-span, which is the
live analogue of the LOO falloff curve (1 mm -> 20.6 dB, 5 mm -> 6.8, 20 mm -> -3.5).

IMPORTANT -- aim at a BLANK section of wall with no target behind it. The whole
method rests on every residual peak being false by construction. Point it at
something real and the analysis measures nothing.

Requires stream.py (9001) and sdr_server.py (9003) running.

    python3 span_confirm.py --seconds 120
"""

import argparse
import asyncio
import json
import os
import sys
import time

import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from capture_bgmodel import DATA_DIR, SDR_URL, SENSOR_URL, SFCW_PARAMS, LidarTracker, sensor_task

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_TRAINING = os.path.join(REPO_ROOT, 'data', 'bgmodel_pass1.json')


def span_of(training_path):
    """The standoff span the model will cover, and the offset it was built under."""
    doc = json.load(open(training_path))
    ds = [c['stats']['standoffMm'] for c in doc['captures']
          if c.get('stats') and c['stats'].get('standoffMm') is not None]
    return min(ds), max(ds), float(doc.get('lidarAntennaOffsetMm'))


def status(standoff, lo, hi):
    if standoff is None:
        return 'no lidar', 0.0
    if standoff < lo:
        return f'{lo - standoff:5.1f} mm BELOW span', lo - standoff
    if standoff > hi:
        return f'{standoff - hi:5.1f} mm ABOVE span', standoff - hi
    return '      IN SPAN       ', 0.0


async def run(args):
    lo, hi, offset = span_of(args.training)
    print(f"model span  : standoff {lo:.1f} .. {hi:.1f} mm   (offset {offset:.0f})")
    print(f"stay in span: lidar reads {lo + offset:.0f} .. {hi + offset:.0f} mm")
    print()
    print("Aim at a BLANK wall. Then, slowly and continuously over the run:")
    print("  1. start mid-span and hold a few seconds")
    print("  2. move in past the near edge, well past it (~30 mm outside)")
    print("  3. come back through the span to the far edge and past it")
    print("  4. return to mid-span")
    print("Move smoothly -- the analysis bins by standoff, so a slow sweep")
    print("through the boundary is worth more than time spent parked.")
    print()

    tracker = LidarTracker(offset)
    stop = asyncio.Event()
    st = asyncio.create_task(sensor_task(tracker, stop))
    await asyncio.sleep(1.0)
    if tracker.latest is None:
        print("!! no lidar on port 9001 -- is stream.py running?")
        stop.set(); await st
        return 1

    sweeps = []
    async with websockets.connect(SDR_URL, max_size=None) as ws:
        await ws.send(json.dumps({
            'cmd': 'sfcw_set_params',
            'start_freq_mhz': SFCW_PARAMS['startFreq'],
            'stop_freq_mhz': SFCW_PARAMS['stopFreq'],
            'step_size_mhz': SFCW_PARAMS['stepSize'],
            'num_buffers': SFCW_PARAMS['numBuffers'],
            'settle_count': SFCW_PARAMS['settleCount'],
            'tx1_gain': SFCW_PARAMS['tx1Gain'], 'rx1_gain': SFCW_PARAMS['rx1Gain'],
            'tx2_gain': SFCW_PARAMS['tx2Gain'], 'rx2_gain': SFCW_PARAMS['rx2Gain'],
            'range_offset': SFCW_PARAMS['rangeOffset'],
        }))
        await ws.send(json.dumps({'cmd': 'sfcw_start'}))

        t0 = time.time()
        first = True
        n_in = n_out = 0
        while time.time() - t0 < args.seconds:
            try:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))
            except asyncio.TimeoutError:
                print("\n!! no sweeps for 5 s -- is sdr_server.py running?")
                break
            if m.get('type') == 'sfcw_error':
                print(f"\n!! sfcw_error: {m}")
                break
            if m.get('type') != 'sfcw_result':
                continue

            prov = tracker.take()
            if first:  # straddles the start command; its lidar window is not clean
                first = False
                continue

            s = prov['lidar_standoff_mm']
            txt, outside = status(s, lo, hi)
            if outside > 0:
                n_out += 1
            else:
                n_in += 1
            sweeps.append({
                'h_cal_real': m.get('h_cal_real'), 'h_cal_imag': m.get('h_cal_imag'),
                'num_steps': m.get('num_steps'), 'step_size': m.get('step_size'),
                'range_offset': m.get('range_offset'), 'timestamp': m.get('timestamp'),
                'phase_coherence': m.get('phase_coherence'),
                'outside_mm': outside, **prov,
            })
            rem = args.seconds - (time.time() - t0)
            print(f"\r  {rem:5.1f}s left | lidar {prov['lidar_raw_mm'] or 0:6.1f} mm | "
                  f"standoff {s if s is not None else float('nan'):6.1f} | {txt} | "
                  f"in {n_in:4d} / out {n_out:4d}  ", end='', flush=True)

        await ws.send(json.dumps({'cmd': 'sfcw_stop'}))

    stop.set(); await st
    print()

    if not sweeps:
        print("!! no sweeps recorded")
        return 1

    os.makedirs(DATA_DIR, exist_ok=True)
    out = os.path.join(DATA_DIR, f"span_confirm_{time.strftime('%Y%m%d-%H%M%S')}.json")
    json.dump({
        'version': 1, 'type': 'span_confirm_traverse',
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'trainingSet': os.path.basename(args.training),
        'spanLoMm': lo, 'spanHiMm': hi, 'lidarAntennaOffsetMm': offset,
        'sfcwParams': SFCW_PARAMS, 'sweeps': sweeps,
    }, open(out, 'w'))

    covered = sorted({round(s['outside_mm']) for s in sweeps if s['outside_mm'] > 0})
    print(f"wrote {len(sweeps)} sweeps ({n_in} in span, {n_out} outside) -> {out}")
    print(f"outside-span distances covered: {covered[:20]}{' ...' if len(covered) > 20 else ''} mm")
    if n_out < 20:
        print("!! few out-of-span sweeps -- the falloff curve will be thin. Consider re-running.")
    print(f"\nnext:  python3 span_analyze.py {out}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--seconds', type=float, default=120.0)
    ap.add_argument('--training', default=DEFAULT_TRAINING)
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == '__main__':
    main()
