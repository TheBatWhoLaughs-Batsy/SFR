#!/usr/bin/env python3
"""Direct AD9361 register access on the bladeRF 2.0, for the tracking
calibrations libbladeRF turns on and never exposes.

libbladeRF's bladerf2 init calls ad9361_tracking_control(bbdc, rfdc, rxquad)
with everything enabled, and offers no API to change it afterwards. These are
the loops that could plausibly re-converge after each fastlock recall, and they
are PER RX CHANNEL, so anything they do does NOT cancel in h_signal/h_reference.

Registers (thirdparty/analogdevicesinc/no-OS/ad9361/sw/ad9361.h):

    0x169 REG_CALIBRATION_CONFIG_1
        bit 7  ENABLE_PHASE_CORR          apply the RX quadrature phase correction
        bit 6  ENABLE_GAIN_CORR           apply the RX quadrature gain correction
        bit 3  FREE_RUN_MODE              track continuously rather than on a trigger
        bit 1  ENABLE_TRACKING_MODE_CH2   keep ADAPTING the RX2 coefficients
        bit 0  ENABLE_TRACKING_MODE_CH1   keep ADAPTING the RX1 coefficients

    0x18B REG_DC_OFFSET_CONFIG2
        bit 5  ENABLE_BB_DC_OFFSET_TRACKING
        bit 3  ENABLE_RF_OFFSET_TRACKING

Note the distinction that matters: clearing the TRACKING_MODE bits FREEZES the
correction at its current value (the correction is still applied), while
clearing PHASE_CORR/GAIN_CORR stops applying it at all. Freezing is the
interesting one -- it keeps whatever calibration the chip converged to and only
removes the per-retune re-adaptation.

Standalone:
    python3 pi/radar/rfic_regs.py            # read and decode (device must be free)
"""
CAL_CFG_1 = 0x169
DC_OFFSET_CFG_2 = 0x18B

ENABLE_PHASE_CORR = 1 << 7
ENABLE_GAIN_CORR = 1 << 6
FREE_RUN_MODE = 1 << 3
TRACK_CH2 = 1 << 1
TRACK_CH1 = 1 << 0

BB_DC_TRACK = 1 << 5
RF_DC_TRACK = 1 << 3


def read_reg(dev_ptr, addr):
    from bladerf._bladerf import ffi, libbladeRF
    val = ffi.new('uint8_t *')
    rc = libbladeRF.bladerf_get_rfic_register(dev_ptr, addr, val)
    if rc != 0:
        raise RuntimeError(f"bladerf_get_rfic_register(0x{addr:03X}) rc={rc}")
    return int(val[0])


def write_reg(dev_ptr, addr, value):
    from bladerf._bladerf import libbladeRF
    rc = libbladeRF.bladerf_set_rfic_register(dev_ptr, addr, int(value) & 0xFF)
    if rc != 0:
        raise RuntimeError(f"bladerf_set_rfic_register(0x{addr:03X}) rc={rc}")


def decode(cal1, dc2):
    return {
        'rx_quad_phase_corr': bool(cal1 & ENABLE_PHASE_CORR),
        'rx_quad_gain_corr': bool(cal1 & ENABLE_GAIN_CORR),
        'free_run': bool(cal1 & FREE_RUN_MODE),
        'track_rx1': bool(cal1 & TRACK_CH1),
        'track_rx2': bool(cal1 & TRACK_CH2),
        'bb_dc_track': bool(dc2 & BB_DC_TRACK),
        'rf_dc_track': bool(dc2 & RF_DC_TRACK),
    }


def snapshot(dev_ptr):
    c1 = read_reg(dev_ptr, CAL_CFG_1)
    d2 = read_reg(dev_ptr, DC_OFFSET_CFG_2)
    return c1, d2, decode(c1, d2)


def set_tracking(dev_ptr, rx_quad_track=None, apply_quad_corr=None,
                 bb_dc_track=None, rf_dc_track=None, verbose=True):
    """Change only what is asked for; None leaves a bit alone.

    Returns (before, after) as (cal1, dc2) pairs so a caller can restore.
    """
    c1 = read_reg(dev_ptr, CAL_CFG_1)
    d2 = read_reg(dev_ptr, DC_OFFSET_CFG_2)
    before = (c1, d2)

    if rx_quad_track is not None:
        if rx_quad_track:
            c1 |= TRACK_CH1 | TRACK_CH2
        else:
            c1 &= ~(TRACK_CH1 | TRACK_CH2) & 0xFF
    if apply_quad_corr is not None:
        if apply_quad_corr:
            c1 |= ENABLE_PHASE_CORR | ENABLE_GAIN_CORR
        else:
            c1 &= ~(ENABLE_PHASE_CORR | ENABLE_GAIN_CORR) & 0xFF
    if bb_dc_track is not None:
        d2 = (d2 | BB_DC_TRACK) if bb_dc_track else (d2 & ~BB_DC_TRACK & 0xFF)
    if rf_dc_track is not None:
        d2 = (d2 | RF_DC_TRACK) if rf_dc_track else (d2 & ~RF_DC_TRACK & 0xFF)

    if c1 != before[0]:
        write_reg(dev_ptr, CAL_CFG_1, c1)
    if d2 != before[1]:
        write_reg(dev_ptr, DC_OFFSET_CFG_2, d2)

    rc1 = read_reg(dev_ptr, CAL_CFG_1)
    rd2 = read_reg(dev_ptr, DC_OFFSET_CFG_2)
    if verbose:
        print(f"[rfic] 0x169 {before[0]:#04x} -> {rc1:#04x}   "
              f"0x18B {before[1]:#04x} -> {rd2:#04x}   {decode(rc1, rd2)}")
    if (rc1, rd2) != (c1, d2):
        print(f"[rfic] WARNING: readback {rc1:#04x}/{rd2:#04x} != "
              f"written {c1:#04x}/{d2:#04x} -- the RFIC did not take it")
    return before, (rc1, rd2)


def main():
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from radar.bladerf_driver import BladeRFDriver
    d = BladeRFDriver()
    d.open()
    try:
        c1, d2, dec = snapshot(d.device.dev[0])
        print(f"0x169 CALIBRATION_CONFIG_1 = {c1:#04x}")
        print(f"0x18B DC_OFFSET_CONFIG2    = {d2:#04x}")
        for k, v in dec.items():
            print(f"  {k:<22} {v}")
    finally:
        d.close()


if __name__ == '__main__':
    main()
