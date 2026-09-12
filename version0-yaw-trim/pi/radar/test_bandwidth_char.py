#!/usr/bin/env python3
"""bladeRF bandwidth characterization test.

Probes the full instantaneous bandwidth capability.
Uses the exact same TX/RX dual-channel pattern as sfcw_engine.py (which is proven to work).

Run on the Pi with bladeRF connected (stop sdr_server first).
Results saved to bandwidth_char_results.json
"""

import sys
import time
import json
import threading
import numpy as np
import bladerf
from bladerf._bladerf import ChannelLayout, Format, ffi, libbladeRF

MGC = libbladeRF.BLADERF_GAIN_MGC
TUNING_MODE_FPGA = libbladeRF.BLADERF_TUNING_MODE_FPGA
SCALE = 2047


def open_blade():
    dev = bladerf.BladeRF()
    return dev


def configure_dual(dev, sample_rate, center_freq, tx_gain=30, rx_gain=20):
    """Configure all 4 channels — mirrors BladeRFDriver._configure_channels_dual."""
    dev_ptr = dev.dev[0]
    analog_bw = min(int(sample_rate), 56_000_000)
    for ch_idx in range(2):
        tx_ch = bladerf.CHANNEL_TX(ch_idx)
        rx_ch = bladerf.CHANNEL_RX(ch_idx)
        libbladeRF.bladerf_set_sample_rate(dev_ptr, tx_ch, int(sample_rate), ffi.NULL)
        libbladeRF.bladerf_set_sample_rate(dev_ptr, rx_ch, int(sample_rate), ffi.NULL)
        libbladeRF.bladerf_set_bandwidth(dev_ptr, tx_ch, int(analog_bw), ffi.NULL)
        libbladeRF.bladerf_set_bandwidth(dev_ptr, rx_ch, int(analog_bw), ffi.NULL)
        libbladeRF.bladerf_set_frequency(dev_ptr, tx_ch, int(center_freq))
        libbladeRF.bladerf_set_frequency(dev_ptr, rx_ch, int(center_freq))
        libbladeRF.bladerf_set_gain_mode(dev_ptr, rx_ch, MGC)


def make_tx_tone(n_samples, sample_rate, offset_hz, amplitude=0.8):
    """Generate dual-channel interleaved TX buffer for a CW tone at offset."""
    t = np.arange(n_samples, dtype=np.float64) / sample_rate
    phase = 2 * np.pi * offset_hz * t
    i_samp = (np.cos(phase) * amplitude * SCALE).astype(np.int16)
    q_samp = (np.sin(phase) * amplitude * SCALE).astype(np.int16)
    buf = np.empty(n_samples * 4, dtype=np.int16)
    buf[0::4] = i_samp  # TX1 I
    buf[1::4] = q_samp  # TX1 Q
    buf[2::4] = i_samp  # TX2 I
    buf[3::4] = q_samp  # TX2 Q
    return buf


class DualStreamer:
    """Manages dual-channel TX+RX streaming — same pattern as sfcw_engine."""

    def __init__(self, dev, sample_rate, n_samples=1024):
        self.dev = dev
        self.sample_rate = sample_rate
        self.n_samples = n_samples
        self._tx_stop = threading.Event()
        self._rx_stop = threading.Event()
        self._tx_thread = None
        self._rx_thread = None
        self._rx_lock = threading.Lock()
        self._rx_latest = None
        self._rx_seq = 0
        self._tx_lock = threading.Lock()
        self._tx_bytes = None

    def start(self, tx_gain=30, rx_gain=20):
        """Start TX+RX dual streams."""
        n = self.n_samples
        # Initial silence
        silence = np.zeros(n * 4, dtype=np.int16)
        self._tx_bytes = silence.tobytes()

        # TX sync config + enable (must be before RX)
        self.dev.sync_config(
            layout=ChannelLayout.TX_X2,
            fmt=Format.SC16_Q11,
            num_buffers=16,
            buffer_size=4096,
            num_transfers=8,
            stream_timeout=3500
        )
        self.dev.enable_module(bladerf.CHANNEL_TX(0), True)
        self.dev.enable_module(bladerf.CHANNEL_TX(1), True)

        # RX sync config + enable
        self.dev.sync_config(
            layout=ChannelLayout.RX_X2,
            fmt=Format.SC16_Q11,
            num_buffers=16,
            buffer_size=4096,
            num_transfers=8,
            stream_timeout=3500
        )
        self.dev.enable_module(bladerf.CHANNEL_RX(0), True)
        self.dev.enable_module(bladerf.CHANNEL_RX(1), True)

        # Set gains AFTER enable (enable resets them)
        dev_ptr = self.dev.dev[0]
        for ch_idx in range(2):
            libbladeRF.bladerf_set_gain_mode(dev_ptr, bladerf.CHANNEL_RX(ch_idx), MGC)
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_RX(ch_idx), int(rx_gain))
            libbladeRF.bladerf_set_gain(dev_ptr, bladerf.CHANNEL_TX(ch_idx), int(tx_gain))

        self._tx_stop.clear()
        self._rx_stop.clear()
        self._rx_seq = 0

        self._tx_thread = threading.Thread(target=self._tx_loop, daemon=True)
        self._rx_thread = threading.Thread(target=self._rx_loop, daemon=True)
        self._tx_thread.start()
        self._rx_thread.start()
        time.sleep(0.05)

    def stop(self):
        """Stop streams gracefully."""
        self._rx_stop.set()
        self._tx_stop.set()
        if self._rx_thread:
            self._rx_thread.join(timeout=2)
        if self._tx_thread:
            self._tx_thread.join(timeout=2)
        try:
            self.dev.enable_module(bladerf.CHANNEL_RX(0), False)
            self.dev.enable_module(bladerf.CHANNEL_RX(1), False)
        except Exception:
            pass
        try:
            self.dev.enable_module(bladerf.CHANNEL_TX(0), False)
            self.dev.enable_module(bladerf.CHANNEL_TX(1), False)
        except Exception:
            pass

    def set_tx(self, tone_buf):
        """Update TX buffer (numpy int16 array, dual-ch interleaved)."""
        with self._tx_lock:
            self._tx_bytes = tone_buf.tobytes()

    def wait_buffers(self, count, timeout=2.0):
        """Wait for `count` new RX buffers to arrive."""
        with self._rx_lock:
            target = self._rx_seq + count
        deadline = time.monotonic() + timeout
        while True:
            with self._rx_lock:
                if self._rx_seq >= target:
                    return True
            if time.monotonic() > deadline:
                return False
            time.sleep(0.0002)

    def capture(self, ref_tone, n_avg=4, discard=2):
        """Discard buffers, then average n_avg measurements. Returns (sig1, sig2) complex."""
        self.wait_buffers(discard)

        sig1_accum = 0j
        sig2_accum = 0j
        captured = 0
        with self._rx_lock:
            last_seq = self._rx_seq

        for _ in range(n_avg):
            deadline = time.monotonic() + 2.0
            while True:
                with self._rx_lock:
                    if self._rx_seq > last_seq:
                        rx1, rx2 = self._rx_latest
                        last_seq = self._rx_seq
                        break
                if time.monotonic() > deadline:
                    rx1 = rx2 = None
                    break
                time.sleep(0.0002)

            if rx1 is None:
                continue

            rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
            rx2_c = (rx2[0::2].astype(np.float64) + 1j * rx2[1::2].astype(np.float64)) / SCALE
            sig1_accum += np.mean(rx1_c * ref_tone)
            sig2_accum += np.mean(rx2_c * ref_tone)
            captured += 1

        if captured == 0:
            return 0j, 0j
        return sig1_accum / captured, sig2_accum / captured

    def get_rx_rate(self, duration=2.0):
        """Measure actual RX throughput over `duration` seconds."""
        with self._rx_lock:
            start_seq = self._rx_seq
        time.sleep(duration)
        with self._rx_lock:
            end_seq = self._rx_seq
        return (end_seq - start_seq) * self.n_samples / duration

    def _tx_loop(self):
        try:
            while not self._tx_stop.is_set():
                with self._tx_lock:
                    buf = self._tx_bytes
                self.dev.sync_tx(buf, self.n_samples)
        except Exception as e:
            if not self._tx_stop.is_set():
                print(f"  [TX error: {e}]")

    def _rx_loop(self):
        n = self.n_samples
        buf = bytearray(n * 2 * 2 * 2)
        try:
            while not self._rx_stop.is_set():
                self.dev.sync_rx(buf, n)
                iq = np.frombuffer(buf, dtype=np.int16).copy()
                rx1 = np.empty(n * 2, dtype=np.int16)
                rx2 = np.empty(n * 2, dtype=np.int16)
                rx1[0::2] = iq[0::4]
                rx1[1::2] = iq[1::4]
                rx2[0::2] = iq[2::4]
                rx2[1::2] = iq[3::4]
                with self._rx_lock:
                    self._rx_latest = (rx1, rx2)
                    self._rx_seq += 1
        except Exception as e:
            if not self._rx_stop.is_set():
                print(f"  [RX error: {e}]")


def run_test_1_sample_rate():
    """Test maximum sustainable sample rate."""
    print("\n" + "="*60)
    print("TEST 1: Maximum sustainable sample rate (dual-channel)")
    print("="*60)

    rates = [4_000_000, 10_000_000, 20_000_000, 30_000_000,
             40_000_000, 50_000_000, 56_000_000]
    results = []

    for rate in rates:
        print(f"\n  {rate/1e6:.0f} Msps: ", end="", flush=True)
        dev = None
        streamer = None
        try:
            dev = open_blade()
            configure_dual(dev, rate, 3_000_000_000)
            streamer = DualStreamer(dev, rate, n_samples=1024)
            streamer.start()

            # Set a 100 kHz tone so TX is active
            tx_buf = make_tx_tone(1024, rate, 100_000)
            streamer.set_tx(tx_buf)
            time.sleep(0.3)

            actual_rate = streamer.get_rx_rate(2.0)
            ratio = actual_rate / rate

            status = 'ok' if ratio > 0.8 else 'underrun'
            print(f"{status} — {actual_rate/1e6:.1f} Msps ({ratio*100:.0f}%)")
            results.append({'rate_mhz': rate/1e6, 'status': status,
                           'actual_msps': actual_rate/1e6, 'ratio': ratio})
        except Exception as e:
            print(f"ERROR: {e}")
            results.append({'rate_mhz': rate/1e6, 'status': 'error', 'error': str(e)})
        finally:
            if streamer:
                streamer.stop()
            if dev:
                dev.close()
            time.sleep(0.5)

    ok_rates = [r['rate_mhz'] for r in results if r['status'] == 'ok']
    max_rate = max(ok_rates) * 1e6 if ok_rates else 2_000_000
    print(f"\n  → Max sustainable: {max_rate/1e6:.0f} Msps")
    return results, int(max_rate)


def run_test_2_freq_response(sample_rate):
    """Sweep tone across bandwidth, measure amplitude + phase for both channels."""
    print(f"\n{'='*60}")
    print(f"TEST 2: Frequency response across {sample_rate/1e6:.0f} MHz bandwidth")
    print(f"{'='*60}")

    center_freq = 3_000_000_000
    n_samples = 4096
    max_offset = int(sample_rate * 0.45)
    num_points = 41
    offsets = np.linspace(-max_offset, max_offset, num_points).astype(int)

    print(f"  Center: {center_freq/1e9:.3f} GHz, sweep ±{max_offset/1e6:.1f} MHz, {num_points} points")

    dev = open_blade()
    configure_dual(dev, sample_rate, center_freq)
    streamer = DualStreamer(dev, sample_rate, n_samples=n_samples)
    streamer.start()

    t = np.arange(n_samples, dtype=np.float64) / sample_rate
    rx1_data = []
    rx2_data = []

    for idx, offset in enumerate(offsets):
        tx_buf = make_tx_tone(n_samples, sample_rate, int(offset))
        streamer.set_tx(tx_buf)
        ref_tone = np.exp(-1j * 2 * np.pi * offset * t)
        s1, s2 = streamer.capture(ref_tone, n_avg=8, discard=6)

        rx1_data.append({'offset_mhz': float(offset/1e6), 'mag': float(np.abs(s1)), 'phase': float(np.angle(s1))})
        rx2_data.append({'offset_mhz': float(offset/1e6), 'mag': float(np.abs(s2)), 'phase': float(np.angle(s2))})

        if idx % 5 == 0:
            print(f"  [{idx+1:2d}/{num_points}] {offset/1e6:+6.1f} MHz: "
                  f"RX1={20*np.log10(np.abs(s1)+1e-12):+.1f}dB  "
                  f"RX2={20*np.log10(np.abs(s2)+1e-12):+.1f}dB")

    streamer.stop()
    dev.close()

    # Analyze
    for label, data in [("RX1 (antenna)", rx1_data), ("RX2 (loopback ref)", rx2_data)]:
        mags = np.array([d['mag'] for d in data])
        phases = np.array([d['phase'] for d in data])
        offs = np.array([d['offset_mhz'] for d in data])

        if np.max(mags) < 1e-10:
            print(f"\n  {label}: NO SIGNAL")
            continue

        mag_db = 20 * np.log10(mags / np.max(mags) + 1e-12)
        center_idx = len(mags) // 2

        # -3dB and -6dB BW
        bw3_lo, bw3_hi = offs[0], offs[-1]
        bw6_lo, bw6_hi = offs[0], offs[-1]
        for i in range(center_idx, -1, -1):
            if mag_db[i] < -3:
                bw3_lo = offs[i]; break
        for i in range(center_idx, len(mag_db)):
            if mag_db[i] < -3:
                bw3_hi = offs[i]; break
        for i in range(center_idx, -1, -1):
            if mag_db[i] < -6:
                bw6_lo = offs[i]; break
        for i in range(center_idx, len(mag_db)):
            if mag_db[i] < -6:
                bw6_hi = offs[i]; break

        flat_10 = np.ptp(mag_db[np.abs(offs) <= 10]) if np.any(np.abs(offs) <= 10) else float('nan')
        flat_20 = np.ptp(mag_db[np.abs(offs) <= 20]) if np.any(np.abs(offs) <= 20) else float('nan')

        # Phase linearity
        pu = np.unwrap(phases)
        valid = mags > np.max(mags) * 0.1
        if np.sum(valid) > 3:
            c = np.polyfit(offs[valid], pu[valid], 1)
            resid = pu[valid] - np.polyval(c, offs[valid])
            pnl = float(np.std(resid) * 180 / np.pi)
        else:
            pnl = float('nan')

        print(f"\n  ─── {label} ───")
        print(f"  -3dB BW: {bw3_hi - bw3_lo:.1f} MHz ({bw3_lo:+.1f} to {bw3_hi:+.1f})")
        print(f"  -6dB BW: {bw6_hi - bw6_lo:.1f} MHz ({bw6_lo:+.1f} to {bw6_hi:+.1f})")
        print(f"  Flatness ±10 MHz: {flat_10:.2f} dB p-p")
        print(f"  Flatness ±20 MHz: {flat_20:.2f} dB p-p")
        print(f"  Phase nonlinearity σ: {pnl:.2f}°")

    return {'rx1': rx1_data, 'rx2': rx2_data, 'sample_rate': sample_rate}


def run_test_3_phase_stability(sample_rate):
    """Phase repeatability at different offsets (no PLL retune between them)."""
    print(f"\n{'='*60}")
    print(f"TEST 3: Phase stability at sub-step offsets (no PLL retune)")
    print(f"{'='*60}")

    n_samples = 4096
    n_trials = 20
    offsets = [-20_000_000, -10_000_000, 0, 10_000_000, 20_000_000]

    dev = open_blade()
    configure_dual(dev, sample_rate, 3_000_000_000)
    streamer = DualStreamer(dev, sample_rate, n_samples=n_samples)
    streamer.start()
    t = np.arange(n_samples, dtype=np.float64) / sample_rate

    print(f"  {n_trials} trials per offset, measuring phase jitter\n")

    results = []
    for offset in offsets:
        tx_buf = make_tx_tone(n_samples, sample_rate, offset)
        streamer.set_tx(tx_buf)
        ref_tone = np.exp(-1j * 2 * np.pi * offset * t)
        streamer.wait_buffers(8)

        h_cals = []
        with streamer._rx_lock:
            last_seq = streamer._rx_seq

        for _ in range(n_trials):
            deadline = time.monotonic() + 2.0
            while True:
                with streamer._rx_lock:
                    if streamer._rx_seq > last_seq:
                        rx1, rx2 = streamer._rx_latest
                        last_seq = streamer._rx_seq
                        break
                if time.monotonic() > deadline:
                    break
                time.sleep(0.0002)

            rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
            rx2_c = (rx2[0::2].astype(np.float64) + 1j * rx2[1::2].astype(np.float64)) / SCALE
            s1 = np.mean(rx1_c * ref_tone)
            s2 = np.mean(rx2_c * ref_tone)
            if np.abs(s2) > 1e-10:
                h_cals.append(s1 / s2)

        if h_cals:
            h = np.array(h_cals)
            phase_std = float(np.std(np.angle(h))) * 180 / np.pi
            mag_cv = float(np.std(np.abs(h)) / np.mean(np.abs(h)) * 100)
            mean_mag = float(np.mean(np.abs(h)))
            print(f"  {offset/1e6:+6.0f} MHz: h_cal φσ={phase_std:.2f}°  mag_cv={mag_cv:.1f}%  |h|={mean_mag:.4f}")
            results.append({'offset_mhz': offset/1e6, 'phase_std_deg': phase_std,
                           'mag_cv_pct': mag_cv, 'mean_mag': mean_mag})

    streamer.stop()
    dev.close()
    return results


def run_test_4_switching_settle(sample_rate):
    """How many buffers needed after switching offset before measurement is stable?"""
    print(f"\n{'='*60}")
    print(f"TEST 4: Sub-step switching settle time")
    print(f"{'='*60}")

    n_samples = 1024  # smaller for faster buffers
    offset_a = 0
    offset_b = 20_000_000
    n_capture = 16
    n_trials = 5

    dev = open_blade()
    configure_dual(dev, sample_rate, 3_000_000_000)
    streamer = DualStreamer(dev, sample_rate, n_samples=n_samples)
    streamer.start()
    t = np.arange(n_samples, dtype=np.float64) / sample_rate
    ref_b = np.exp(-1j * 2 * np.pi * offset_b * t)
    buf_a = make_tx_tone(n_samples, sample_rate, offset_a)
    buf_b = make_tx_tone(n_samples, sample_rate, offset_b)

    # Steady-state at offset_b
    streamer.set_tx(buf_b)
    streamer.wait_buffers(12)
    ss_vals = []
    with streamer._rx_lock:
        last_seq = streamer._rx_seq
    for _ in range(10):
        deadline = time.monotonic() + 2.0
        while True:
            with streamer._rx_lock:
                if streamer._rx_seq > last_seq:
                    rx1, rx2 = streamer._rx_latest
                    last_seq = streamer._rx_seq
                    break
            if time.monotonic() > deadline:
                break
            time.sleep(0.0002)
        rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
        ss_vals.append(float(np.abs(np.mean(rx1_c * ref_b))))

    ss_mag = np.mean(ss_vals)
    buf_us = n_samples / sample_rate * 1e6
    print(f"  Switching {offset_a/1e6:.0f} → {offset_b/1e6:.0f} MHz")
    print(f"  Buffer size: {n_samples} samples = {buf_us:.1f} µs")
    print(f"  Steady-state |s|: {ss_mag:.5f}")
    print(f"  {n_trials} trials, {n_capture} buffers captured after each switch\n")

    all_mags = np.zeros((n_trials, n_capture))
    for trial in range(n_trials):
        streamer.set_tx(buf_a)
        streamer.wait_buffers(8)
        # Switch
        streamer.set_tx(buf_b)
        with streamer._rx_lock:
            last_seq = streamer._rx_seq
        for i in range(n_capture):
            deadline = time.monotonic() + 2.0
            while True:
                with streamer._rx_lock:
                    if streamer._rx_seq > last_seq:
                        rx1, rx2 = streamer._rx_latest
                        last_seq = streamer._rx_seq
                        break
                if time.monotonic() > deadline:
                    break
                time.sleep(0.0002)
            rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
            all_mags[trial, i] = float(np.abs(np.mean(rx1_c * ref_b)))

    streamer.stop()
    dev.close()

    avg_mags = np.mean(all_mags, axis=0)
    err_pct = np.abs(avg_mags - ss_mag) / ss_mag * 100
    settle_idx = n_capture
    print(f"  {'Buf':>4} {'|s|':>9} {'Err%':>7} {'OK':>4}")
    for i in range(n_capture):
        ok = err_pct[i] < 3.0
        print(f"  {i:4d} {avg_mags[i]:9.5f} {err_pct[i]:7.2f} {'✓' if ok else ''}")
        if ok and settle_idx == n_capture:
            settle_idx = i

    print(f"\n  → Settled at buffer #{settle_idx} = {settle_idx * buf_us:.1f} µs")
    return {'settle_idx': settle_idx, 'settle_us': settle_idx * buf_us,
            'buf_us': buf_us, 'convergence': avg_mags.tolist()}


def run_test_5_offset_vs_retune(sample_rate):
    """Compare measurement at +20 MHz via offset vs via PLL retune."""
    print(f"\n{'='*60}")
    print(f"TEST 5: Offset method vs PLL retune comparison")
    print(f"{'='*60}")

    center = 3_000_000_000
    target_offset = 20_000_000
    n_samples = 4096
    n_trials = 20
    t = np.arange(n_samples, dtype=np.float64) / sample_rate

    # Method A: offset from center
    print(f"\n  A: center={center/1e9:.3f} GHz, tone at +{target_offset/1e6:.0f} MHz")
    dev = open_blade()
    configure_dual(dev, sample_rate, center)
    streamer = DualStreamer(dev, sample_rate, n_samples=n_samples)
    streamer.start()
    buf_a = make_tx_tone(n_samples, sample_rate, target_offset)
    ref_a = np.exp(-1j * 2 * np.pi * target_offset * t)
    streamer.set_tx(buf_a)
    streamer.wait_buffers(10)

    hcal_a = []
    with streamer._rx_lock:
        last_seq = streamer._rx_seq
    for _ in range(n_trials):
        deadline = time.monotonic() + 2.0
        while True:
            with streamer._rx_lock:
                if streamer._rx_seq > last_seq:
                    rx1, rx2 = streamer._rx_latest
                    last_seq = streamer._rx_seq
                    break
            if time.monotonic() > deadline:
                break
            time.sleep(0.0002)
        rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
        rx2_c = (rx2[0::2].astype(np.float64) + 1j * rx2[1::2].astype(np.float64)) / SCALE
        s1 = np.mean(rx1_c * ref_a)
        s2 = np.mean(rx2_c * ref_a)
        if np.abs(s2) > 1e-10:
            hcal_a.append(s1 / s2)

    streamer.stop()
    dev.close()
    time.sleep(0.3)

    # Method B: retune PLL to target, 100 kHz tone
    print(f"  B: retune to {(center+target_offset)/1e9:.3f} GHz, tone at 100 kHz")
    dev = open_blade()
    configure_dual(dev, sample_rate, center + target_offset)
    streamer = DualStreamer(dev, sample_rate, n_samples=n_samples)
    streamer.start()
    cw = 100_000
    buf_b = make_tx_tone(n_samples, sample_rate, cw)
    ref_b = np.exp(-1j * 2 * np.pi * cw * t)
    streamer.set_tx(buf_b)
    streamer.wait_buffers(10)

    hcal_b = []
    with streamer._rx_lock:
        last_seq = streamer._rx_seq
    for _ in range(n_trials):
        deadline = time.monotonic() + 2.0
        while True:
            with streamer._rx_lock:
                if streamer._rx_seq > last_seq:
                    rx1, rx2 = streamer._rx_latest
                    last_seq = streamer._rx_seq
                    break
            if time.monotonic() > deadline:
                break
            time.sleep(0.0002)
        rx1_c = (rx1[0::2].astype(np.float64) + 1j * rx1[1::2].astype(np.float64)) / SCALE
        rx2_c = (rx2[0::2].astype(np.float64) + 1j * rx2[1::2].astype(np.float64)) / SCALE
        s1 = np.mean(rx1_c * ref_b)
        s2 = np.mean(rx2_c * ref_b)
        if np.abs(s2) > 1e-10:
            hcal_b.append(s1 / s2)

    streamer.stop()
    dev.close()

    result = {}
    if hcal_a and hcal_b:
        a = np.array(hcal_a)
        b = np.array(hcal_b)
        a_ps = float(np.std(np.angle(a)) * 180 / np.pi)
        b_ps = float(np.std(np.angle(b)) * 180 / np.pi)
        a_mc = float(np.std(np.abs(a)) / np.mean(np.abs(a)) * 100)
        b_mc = float(np.std(np.abs(b)) / np.mean(np.abs(b)) * 100)
        a_mm = float(np.mean(np.abs(a)))
        b_mm = float(np.mean(np.abs(b)))

        print(f"\n  {'':18} {'A (offset)':>12} {'B (retune)':>12}")
        print(f"  {'|h_cal| mean':18} {a_mm:12.5f} {b_mm:12.5f}")
        print(f"  {'Mag CV %':18} {a_mc:12.2f} {b_mc:12.2f}")
        print(f"  {'Phase σ °':18} {a_ps:12.2f} {b_ps:12.2f}")

        verdict = "PASS" if a_ps <= b_ps * 1.5 else "WARN"
        print(f"\n  → {verdict}: offset phase σ={a_ps:.2f}° vs retune σ={b_ps:.2f}°")
        result = {'a_phase_std': a_ps, 'b_phase_std': b_ps,
                  'a_mag_cv': a_mc, 'b_mag_cv': b_mc,
                  'a_mag_mean': a_mm, 'b_mag_mean': b_mm}
    return result


# ─── Main ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    all_results = {}

    # Test 1
    rate_results, max_rate = run_test_1_sample_rate()
    all_results['test1_sample_rates'] = rate_results
    all_results['max_sustainable_rate_mhz'] = max_rate / 1e6
    test_rate = min(max_rate, 56_000_000)
    print(f"\n  → Using {test_rate/1e6:.0f} Msps for tests 2-5")
    time.sleep(0.5)

    # Test 2
    freq_resp = run_test_2_freq_response(test_rate)
    all_results['test2_freq_response'] = freq_resp
    time.sleep(0.5)

    # Test 3
    phase_stab = run_test_3_phase_stability(test_rate)
    all_results['test3_phase_stability'] = phase_stab
    time.sleep(0.5)

    # Test 4
    switching = run_test_4_switching_settle(test_rate)
    all_results['test4_switching'] = switching
    time.sleep(0.5)

    # Test 5
    comparison = run_test_5_offset_vs_retune(test_rate)
    all_results['test5_comparison'] = comparison

    # Save
    out = '/home/sfr/version0/pi/radar/bandwidth_char_results.json'
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n{'='*60}")
    print(f"ALL DONE — saved to {out}")
    print(f"{'='*60}")
