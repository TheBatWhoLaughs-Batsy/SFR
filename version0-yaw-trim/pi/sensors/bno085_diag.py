#!/usr/bin/env python3
"""Report what the BNO085 is actually doing, instead of guessing.

Run on the Pi:   python3 pi/sensors/bno085_diag.py

Makes no assumptions and changes nothing permanently. It answers, in order:
is the bus working at all, is the SH-2 app running, is the sensor already
streaming from a previous process, does the handshake complete, and are
transfers being corrupted. Each stage prints a verdict and what to do about it.
"""

import argparse
import struct
import sys
import time

try:
    import smbus2
except ImportError:
    sys.exit("smbus2 missing:  pip3 install smbus2")

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import bno085 as B

CHAN = {0: 'shtp-cmd', 1: 'executable', 2: 'control', 3: 'input-report',
        4: 'wake-input', 5: 'gyro-rv'}
CTRL = {0xF8: 'product-id-response', 0xF9: 'product-id-request',
        0xFC: 'get-feature-response', 0xFD: 'set-feature-command',
        0xF1: 'command-response', 0xFA: 'timestamp-rebase',
        0xFB: 'base-timestamp'}
RPT = {0x01: 'accelerometer', 0x02: 'gyroscope', 0x08: 'game-rotation-vector',
       0x04: 'linear-accel', 0x05: 'rotation-vector', 0xFB: 'base-timestamp',
       0xFA: 'timestamp-rebase'}


def describe(p):
    ch = CHAN.get(p['channel'], f"ch{p['channel']}")
    d = p['data']
    tag = ''
    if d:
        if p['channel'] == 2:
            tag = CTRL.get(d[0], f'0x{d[0]:02x}')
            if d[0] in (0xFC, 0xFD) and len(d) > 1:
                tag += f" feature=0x{d[1]:02x} ({RPT.get(d[1], '?')})"
        elif p['channel'] == 3:
            ids, i = [], 0
            while i < len(d):
                rid = d[i]
                ln = B._REPORT_LENGTHS.get(rid)
                ids.append(RPT.get(rid, f'0x{rid:02x}'))
                if ln is None:
                    ids.append('<unknown, stopped>')
                    break
                i += ln
            tag = '+'.join(ids)
        elif p['channel'] == 1:
            tag = 'reset-complete' if d[0] == 0x01 else f'0x{d[0]:02x}'
    return (f"  ch={p['channel']:<2} {ch:<13} len={len(d) + 4:<4}"
            f"{' CONT' if p['continued'] else '     '} {tag}")


def stage(n, title):
    print(f"\n── {n}. {title} " + "─" * max(0, 56 - len(title)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bus', type=int, default=1)
    ap.add_argument('--addr', type=lambda v: int(v, 0), default=B.ADDR)
    ap.add_argument('--watch', type=float, default=3.0,
                    help='seconds to watch the stream at the end (default 3)')
    a = ap.parse_args()

    print(f"BNO085 diagnostic — bus {a.bus}, address 0x{a.addr:02x}")
    try:
        with open('/sys/module/i2c_bcm2835/parameters/baudrate') as f:
            print(f"i2c baudrate parameter: {f.read().strip()}")
    except OSError:
        pass

    # ---------------------------------------------------------------- stage 1
    stage(1, "is anything at that address?")
    try:
        bus = smbus2.SMBus(a.bus)
    except OSError as e:
        sys.exit(f"  cannot open bus {a.bus}: {e}\n  -> is I2C enabled? raspi-config")
    dev = B.BNO085.__new__(B.BNO085)          # no __init__: no reset, no enables
    dev.bus, dev.addr = bus, a.addr
    dev._tx_seq = [0] * 6
    dev._latest_accel = dev._latest_gyro = (0.0, 0.0, 0.0)
    dev._latest_quat = None
    dev.io_errors = dev.bad_headers = dev.oversize_reads = 0

    ok = 0
    for _ in range(20):
        try:
            m = smbus2.i2c_msg.read(a.addr, 4)
            bus.i2c_rdwr(m)
            ok += 1
        except OSError:
            pass
    print(f"  {ok}/20 four-byte reads succeeded")
    if ok == 0:
        sys.exit("  -> nothing responds. Check wiring, 3V3, and `i2cdetect -y 1`\n"
                 "     (address is 0x4B instead of 0x4A if the ADR pin is pulled high)")
    if ok < 20:
        print("  -> INTERMITTENT. This is the clock-stretching problem: add\n"
              "     dtparam=i2c_arm_baudrate=50000 to /boot/firmware/config.txt, reboot")

    # ---------------------------------------------------------------- stage 2
    stage(2, "is it already streaming? (nothing sent yet)")
    seen, t0 = [], time.monotonic()
    while time.monotonic() - t0 < 1.0:
        p = dev._read()
        if p:
            seen.append(p)
        else:
            time.sleep(0.002)
    inputs = [p for p in seen if p['channel'] == 3]
    print(f"  {len(seen)} packets in 1 s, {len(inputs)} of them sensor data")
    for p in seen[:8]:
        print(describe(p))
    if len(seen) > 8:
        print(f"  ... {len(seen) - 8} more")
    if inputs:
        print(f"  -> ALREADY STREAMING at ~{len(inputs)} reports/s from a previous run.\n"
              "     The old driver's handshake read at most 50/s, so its response was\n"
              "     buried and it reported 'feature not confirmed enabled'. No power\n"
              "     cycle needed: the fixed driver silences the features first.")
    elif seen:
        print("  -> queued packets but no sensor data (advertisement / reset leftovers)")
    else:
        print("  -> quiet, as expected for an idle sensor")

    # ---------------------------------------------------------------- stage 3
    stage(3, "silence any running features, then drain")
    n = dev._silence()
    print(f"  drained {n} packets after disabling all three features")
    print(f"  io_errors={dev.io_errors} bad_headers={dev.bad_headers} "
          f"oversize={dev.oversize_reads}")

    # ---------------------------------------------------------------- stage 4
    stage(4, "soft reset and read the advertisement")
    dev._soft_reset(settle_s=0.3)
    seen, t0 = [], time.monotonic()
    while time.monotonic() - t0 < 1.0:
        p = dev._read()
        if p:
            seen.append(p)
        else:
            time.sleep(0.002)
    print(f"  {len(seen)} packets after reset")
    for p in seen[:10]:
        print(describe(p))
    big = [p for p in seen if len(p['data']) + 4 > 48]
    if big:
        print(f"  -> {len(big)} packet(s) exceed the OLD 48-byte buffer "
              f"(largest {max(len(p['data']) + 4 for p in big)} B).\n"
              "     Those were being silently truncated before this fix.")

    # ---------------------------------------------------------------- stage 5
    stage(5, "product ID (does the SH-2 app answer?)")
    try:
        dev._check_product_id()
        print(f"  OK — part number {dev.part_number}")
    except RuntimeError as e:
        print(f"  FAILED: {e}")
        print("  -> the control channel is not answering at all. Bus-level problem,\n"
              "     or the chip is held in reset. Stop here and fix that first.")
        return

    # ---------------------------------------------------------------- stage 6
    stage(6, "enable each feature")
    for fid, name, us in ((B.REPORT_ACCELEROMETER, 'accelerometer', 20000),
                          (B.REPORT_GYROSCOPE, 'gyroscope', 20000),
                          (B.REPORT_GAME_ROTATION_VECTOR, 'game-rotation-vector', 20000)):
        t0 = time.monotonic()
        try:
            dev._enable_feature(fid, us)
            print(f"  0x{fid:02x} {name:<22} enabled in {time.monotonic() - t0:.3f} s")
        except RuntimeError as e:
            print(f"  0x{fid:02x} {name:<22} FAILED after "
                  f"{time.monotonic() - t0:.3f} s — {e}")
            if fid == B.REPORT_GAME_ROTATION_VECTOR:
                print("     -> rotation is optional; yaw auto-trim will be unavailable\n"
                      "        but accel/gyro streaming still works.")
            else:
                print("     -> product ID answered but this did not. If stage 2 showed\n"
                      "        streaming, the silencing in stage 3 should have cleared it;\n"
                      "        if it did not, suspect the bus (stage 1) next, and only\n"
                      "        then the SH-2 app / BOOT pin.")

    # ---------------------------------------------------------------- stage 7
    stage(7, f"watch the data for {a.watch:.0f} s")
    t0 = time.monotonic()
    n = 0
    while time.monotonic() - t0 < a.watch:
        r = dev.read_all()
        n += 1
        if n % 25 == 0:
            ax, ay, az = r['accel']
            gx, gy, gz = r['gyro']
            yaw = dev.yaw_deg()
            print(f"  accel {ax:+6.2f} {ay:+6.2f} {az:+6.2f} g   "
                  f"gyro {gx:+7.2f} {gy:+7.2f} {gz:+7.2f} °/s   "
                  f"yaw {'—' if yaw is None else f'{yaw:+7.2f}°'}")
        time.sleep(0.02)

    mag = sum(v * v for v in dev._latest_accel) ** 0.5
    print(f"\n  |accel| = {mag:.3f} g  (expect ~1.00 at rest)")
    if dev._latest_accel == (0.0, 0.0, 0.0):
        print("  -> accel never updated: reports enabled but no data parsed.")
    elif abs(mag - 1.0) > 0.25:
        print("  -> magnitude is wrong. Either the rig is moving, or reports are being\n"
              "     mis-parsed (check _REPORT_LENGTHS against what stage 4 printed).")
    else:
        print("  -> accelerometer is healthy.")
    print(f"  yaw: {'available' if dev.yaw_deg() is not None else 'NOT available'}")
    print(f"\n  transport: io_errors={dev.io_errors} bad_headers={dev.bad_headers} "
          f"oversize_reads={dev.oversize_reads}")
    if dev.bad_headers > 10 or dev.io_errors > 0:
        print("  -> corrupted transfers. Lower the I2C clock:\n"
              "     dtparam=i2c_arm_baudrate=50000 in /boot/firmware/config.txt")
    dev.close()


if __name__ == '__main__':
    main()
