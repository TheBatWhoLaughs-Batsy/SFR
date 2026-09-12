#!/usr/bin/env python3
"""DAS (Delay-and-Sum) Backprojection SAR Reconstruction.

Reads a B-scan JSON file from the SFCW radar system and produces a coherent
SAR image using Delay-and-Sum backprojection. Fully standalone — no server
or frontend required.

Usage:
    Set DATASET_DIR and FILENAME below, then run:
    python SAR_Test_Ground.py
"""

import json
import glob
import os
import time
import numpy as np
import matplotlib.pyplot as plt

# ============================================================================
# USER CONFIGURATION
# ============================================================================
DATASET_DIR = "/home/alwin/Downloads"
FILENAME = "2pipes testbench.json"  # Set to None to load first .json in DATASET_DIR

MAX_DEPTH_CM = 20       # Imaging depth limit (cm) — physical depth in medium
PIXELS_X = 100          # Lateral resolution
PIXELS_Z = 100          # Depth resolution
DYN_RANGE_DB = 40       # Display dynamic range (dB below peak)
USE_BG_SUBTRACTION = True  # Subtract bgRef from JSON if available
USE_SYNTHETIC = False    # Generate synthetic data instead of loading file

# SAR_MODE: "ideal" (monostatic, free-space) or "real" (bistatic, two-layer)
SAR_MODE = "ideal"

# Real-mode parameters (ignored in ideal mode)
TX_RX_GAP_M = 0.066        # 66mm antenna separation
AIR_STANDOFF_M = 0.030     # 30mm air gap above sand/medium surface
MEDIUM_EPS_R = 3.0         # relative permittivity of medium (dry sand)

# Synthetic scene definition (x_cm, z_cm, amplitude)
SYNTH_TARGETS = [
    (10, 8, 1.0),    # pipe 1: 10cm lateral, 8cm deep
    (28, 15, 0.7),   # pipe 2: 28cm lateral, 15cm deep
    (20, 22, 0.5),   # pipe 3: 20cm lateral, 22cm deep
]
SYNTH_NUM_POSITIONS = 20
SYNTH_STEP_CM = 2.0     # denser spacing for better aperture sampling

# ============================================================================
# CONSTANTS
# ============================================================================
SPEED_OF_LIGHT = 299_792_458  # m/s


def generate_synthetic():
    """Generate synthetic SFCW B-scan data with known point targets."""
    start_freq_hz = 2e9
    stop_freq_hz = 5e9
    num_steps = 151
    freq_step_hz = 20e6
    freqs = np.linspace(start_freq_hz, stop_freq_hz, num_steps)

    num_positions = SYNTH_NUM_POSITIONS
    step_size_m = SYNTH_STEP_CM / 100.0
    antenna_x = np.arange(num_positions) * step_size_m

    h_cal = np.zeros((num_positions, num_steps), dtype=complex)
    for tx, tz, amp in SYNTH_TARGETS:
        tx_m = tx / 100.0
        tz_m = tz / 100.0
        for p in range(num_positions):
            R = np.sqrt((antenna_x[p] - tx_m)**2 + tz_m**2)
            # Monostatic round-trip phase: exp(-j * 4pi * f * R / c)
            h_cal[p] += amp * np.exp(-1j * 4 * np.pi * freqs * R / SPEED_OF_LIGHT)

    # Add small noise
    noise = 0.01 * (np.random.randn(*h_cal.shape) + 1j * np.random.randn(*h_cal.shape))
    h_cal += noise

    return {
        'h_cal': h_cal,
        'bg_ref': None,
        'num_positions': num_positions,
        'num_steps': num_steps,
        'step_size_m': step_size_m,
        'start_freq_hz': start_freq_hz,
        'stop_freq_hz': stop_freq_hz,
        'freq_step_hz': freq_step_hz,
        'range_offset': 0.0,
    }


def load_bscan(filepath):
    """Load B-scan JSON and extract all parameters needed for reconstruction."""
    with open(filepath, 'r') as f:
        raw = json.load(f)

    data = raw['data']
    num_positions = len(data)

    # Spatial step from params (in cm, convert to meters)
    step_size_cm = raw['params']['stepSize']
    step_size_m = step_size_cm / 100.0

    # Frequency parameters from sfcwParams (MHz) and per-position data (Hz)
    start_freq_hz = raw['sfcwParams']['startFreq'] * 1e6
    stop_freq_hz = raw['sfcwParams']['stopFreq'] * 1e6
    freq_step_hz = data[0]['step_size']  # already in Hz
    num_steps = data[0]['num_steps']
    range_offset = data[0]['range_offset']

    # Build complex h_cal matrix [num_positions x num_steps]
    h_cal = np.zeros((num_positions, num_steps), dtype=complex)
    for i, pos in enumerate(data):
        h_cal[i] = np.array(pos['h_cal_real']) + 1j * np.array(pos['h_cal_imag'])

    # Extract background reference if present
    bg_ref = None
    if raw.get('bgRef') and raw['bgRef'].get('h_cal_real') and raw['bgRef'].get('h_cal_imag'):
        bg_ref = np.array(raw['bgRef']['h_cal_real']) + 1j * np.array(raw['bgRef']['h_cal_imag'])

    return {
        'h_cal': h_cal,
        'bg_ref': bg_ref,
        'num_positions': num_positions,
        'num_steps': num_steps,
        'step_size_m': step_size_m,
        'start_freq_hz': start_freq_hz,
        'stop_freq_hz': stop_freq_hz,
        'freq_step_hz': freq_step_hz,
        'range_offset': range_offset,
    }


def compute_range_profiles(h_cal, num_steps, freq_step_hz, range_offset):
    """Compute complex range profiles for all positions via windowed IFFT.

    Distance axis is free-space electrical path (half round-trip).
    """
    nfft = 1 << int(np.ceil(np.log2(num_steps * 4)))

    window = np.hanning(num_steps)
    h_windowed = h_cal * window[np.newaxis, :]

    crp_full = np.fft.ifft(h_windowed, n=nfft, axis=1)

    max_range = SPEED_OF_LIGHT / (2 * freq_step_hz)
    half = nfft // 2
    dist_axis = np.arange(half) / nfft * max_range - range_offset

    valid_mask = dist_axis >= 0
    crp = crp_full[:, :half][:, valid_mask]
    crp_distances = dist_axis[valid_mask]

    crp_dist_start = crp_distances[0]
    crp_dist_step = (crp_distances[-1] - crp_distances[0]) / (len(crp_distances) - 1)

    return crp, crp_distances, crp_dist_start, crp_dist_step


def snell_ray_path(dx_abs, standoff, depth, eps_r, n_iter=6):
    """One-way electrical path from source (in air) to target (in medium).

    Solves Snell's law at the air-medium interface via Newton's method.
    Vectorized: dx_abs can be a numpy array.

    Returns electrical path length (free-space equivalent meters).
    """
    dx_abs = np.asarray(dx_abs, dtype=float)
    scalar = dx_abs.ndim == 0
    dx_abs = np.atleast_1d(dx_abs)

    n2 = np.sqrt(eps_r)
    result = np.empty_like(dx_abs)

    # Handle near-zero lateral offset (straight down, no refraction)
    near_zero = dx_abs < 1e-9
    result[near_zero] = standoff + depth * n2

    mask = ~near_zero
    if np.any(mask):
        dx = dx_abs[mask]
        # Newton solve for refraction point xr
        # Constraint: sin(θ_air) = n2 * sin(θ_sand)
        #   xr/sqrt(xr²+h²) = n2 * (dx-xr)/sqrt((dx-xr)²+d²)
        xr = dx * standoff / (standoff + depth * n2)  # initial guess

        for _ in range(n_iter):
            a = np.sqrt(xr**2 + standoff**2)
            b = np.sqrt((dx - xr)**2 + depth**2)
            f = xr / a - n2 * (dx - xr) / b
            df = standoff**2 / a**3 + n2 * depth**2 / b**3
            xr = xr - f / df
            xr = np.clip(xr, 0, dx)

        air_leg = np.sqrt(xr**2 + standoff**2)
        sand_leg = np.sqrt((dx - xr)**2 + depth**2)
        result[mask] = air_leg + sand_leg * n2

    return float(result[0]) if scalar else result


def das_backprojection(crp, crp_dist_start, crp_dist_step, antenna_x,
                       k_start, max_depth_m, pixels_x, pixels_z):
    """Coherent DAS backprojection SAR — dual mode (ideal/real)."""
    num_positions = crp.shape[0]
    num_bins = crp.shape[1]
    aperture_length = antenna_x[-1] - antenna_x[0]
    crp_end_bin = num_bins - 2

    laterals = np.linspace(0, aperture_length, pixels_x)
    image = np.zeros((pixels_z, pixels_x))

    if SAR_MODE == "real":
        half_gap = TX_RX_GAP_M / 2

    for zi in range(pixels_z):
        depth = max(0.005, (zi / (pixels_z - 1)) * max_depth_m)

        sum_complex = np.zeros(pixels_x, dtype=complex)

        for p in range(num_positions):
            if SAR_MODE == "ideal":
                dx = laterals - antenna_x[p]
                R = np.sqrt(dx**2 + depth**2)
                lookup = R
                phase = 2 * k_start * R
            else:
                tx_x = antenna_x[p] - half_gap
                rx_x = antenna_x[p] + half_gap

                dx_tx = np.abs(laterals - tx_x)
                dx_rx = np.abs(laterals - rx_x)

                L_tx = snell_ray_path(dx_tx, AIR_STANDOFF_M, depth, MEDIUM_EPS_R)
                L_rx = snell_ray_path(dx_rx, AIR_STANDOFF_M, depth, MEDIUM_EPS_R)
                L_total = L_tx + L_rx

                lookup = L_total / 2
                phase = k_start * L_total

            bin_float = (lookup - crp_dist_start) / crp_dist_step
            bin_idx = np.floor(bin_float).astype(int)
            frac = bin_float - bin_idx
            valid = (bin_idx >= 0) & (bin_idx < crp_end_bin)

            idx_safe = np.clip(bin_idx, 0, num_bins - 2)
            val = crp[p, idx_safe] * (1 - frac) + crp[p, idx_safe + 1] * frac

            correction = np.exp(1j * phase)
            sum_complex += np.where(valid, val * correction, 0)

        image[zi, :] = 20 * np.log10(np.abs(sum_complex) + 1e-12)

        if zi % 10 == 0:
            print(f"    row {zi}/{pixels_z}", end='\r')

    print(f"    {'':30s}", end='\r')
    return image


def display_results(crp_raw, crp_sub, crp_distances, image, aperture_length_m,
                    max_depth_m, dyn_range_db, compute_time_ms, has_bg):
    """Display B-scan(s) and SAR image side by side."""
    max_depth_idx = np.searchsorted(crp_distances, max_depth_m)
    extent_bscan = [crp_distances[0] * 100, crp_distances[max_depth_idx] * 100,
                    crp_raw.shape[0] - 0.5, -0.5]
    extent_sar = [0, aperture_length_m * 100, max_depth_m * 100, 0]

    peak = np.max(image)
    vmin_sar = peak - dyn_range_db
    vmax_sar = peak

    if has_bg:
        fig, axes = plt.subplots(1, 3, figsize=(18, 6))

        # Raw B-scan
        bscan_raw_mag = 20 * np.log10(np.abs(crp_raw[:, :max_depth_idx]) + 1e-12)
        bpeak = np.max(bscan_raw_mag)
        im0 = axes[0].imshow(bscan_raw_mag, aspect='auto', cmap='jet',
                             extent=extent_bscan, vmin=bpeak - dyn_range_db, vmax=bpeak)
        axes[0].set_xlabel('Depth (cm)')
        axes[0].set_ylabel('Position Index')
        axes[0].set_title('B-scan (raw)')
        fig.colorbar(im0, ax=axes[0], shrink=0.8)

        # BG-subtracted B-scan
        bscan_sub_mag = 20 * np.log10(np.abs(crp_sub[:, :max_depth_idx]) + 1e-12)
        speak = np.max(bscan_sub_mag)
        im1 = axes[1].imshow(bscan_sub_mag, aspect='auto', cmap='jet',
                             extent=extent_bscan, vmin=speak - dyn_range_db, vmax=speak)
        axes[1].set_xlabel('Depth (cm)')
        axes[1].set_ylabel('Position Index')
        axes[1].set_title('B-scan (BG subtracted)')
        fig.colorbar(im1, ax=axes[1], shrink=0.8)

        # SAR image
        im2 = axes[2].imshow(image, aspect='auto', cmap='inferno',
                             extent=extent_sar, vmin=vmin_sar, vmax=vmax_sar,
                             interpolation='bilinear')
        axes[2].set_xlabel('Lateral Position (cm)')
        axes[2].set_ylabel('Depth (cm)')
        axes[2].set_title(f'DAS SAR — {compute_time_ms:.0f} ms')
        fig.colorbar(im2, ax=axes[2], shrink=0.8)
    else:
        fig, axes = plt.subplots(1, 2, figsize=(14, 6))

        # B-scan only
        bscan_mag = 20 * np.log10(np.abs(crp_raw[:, :max_depth_idx]) + 1e-12)
        bpeak = np.max(bscan_mag)
        im0 = axes[0].imshow(bscan_mag, aspect='auto', cmap='jet',
                             extent=extent_bscan, vmin=bpeak - dyn_range_db, vmax=bpeak)
        axes[0].set_xlabel('Depth (cm)')
        axes[0].set_ylabel('Position Index')
        axes[0].set_title('B-scan (no BG ref available)')
        fig.colorbar(im0, ax=axes[0], shrink=0.8)

        # SAR image
        im1 = axes[1].imshow(image, aspect='auto', cmap='inferno',
                             extent=extent_sar, vmin=vmin_sar, vmax=vmax_sar,
                             interpolation='bilinear')
        axes[1].set_xlabel('Lateral Position (cm)')
        axes[1].set_ylabel('Depth (cm)')
        axes[1].set_title(f'DAS SAR — {compute_time_ms:.0f} ms')
        fig.colorbar(im1, ax=axes[1], shrink=0.8)

    plt.tight_layout()
    out_path = os.path.join(DATASET_DIR, 'sar_result.png')
    plt.savefig(out_path, dpi=150, bbox_inches='tight')
    print(f"  Saved figure: {out_path}")
    plt.show()


def main():
    if USE_SYNTHETIC:
        print("SYNTHETIC MODE — generating point targets:")
        for i, (tx, tz, amp) in enumerate(SYNTH_TARGETS):
            print(f"  Target {i+1}: ({tx} cm, {tz} cm), amp={amp}")
        params = generate_synthetic()
    else:
        # Resolve file path
        if FILENAME:
            filepath = os.path.join(DATASET_DIR, FILENAME)
        else:
            json_files = glob.glob(os.path.join(DATASET_DIR, '*.json'))
            if not json_files:
                print(f"No .json files found in {DATASET_DIR}")
                return
            filepath = json_files[0]
        print(f"Loading: {filepath}")
        params = load_bscan(filepath)

    print(f"  Positions: {params['num_positions']}")
    print(f"  Spatial step: {params['step_size_m']*100:.1f} cm")
    print(f"  Frequency: {params['start_freq_hz']/1e9:.1f} - {params['stop_freq_hz']/1e9:.1f} GHz")
    print(f"  Freq steps: {params['num_steps']} ({params['freq_step_hz']/1e6:.0f} MHz step)")
    print(f"  Range offset: {params['range_offset']} m")
    print(f"  BG reference: {'YES' if params['bg_ref'] is not None else 'NO'}")

    bandwidth = params['stop_freq_hz'] - params['start_freq_hz']
    range_res = SPEED_OF_LIGHT / (2 * bandwidth)
    print(f"  Range resolution: {range_res*1000:.1f} mm (free-space)")
    print(f"  SAR mode: {SAR_MODE}")
    if SAR_MODE == "real":
        range_res_med = range_res / np.sqrt(MEDIUM_EPS_R)
        print(f"  In-medium resolution: {range_res_med*1000:.1f} mm (εr={MEDIUM_EPS_R})")

    h_cal = params['h_cal']

    # Background subtraction
    bg_applied = False
    if USE_BG_SUBTRACTION and params['bg_ref'] is not None:
        h_cal_sub = h_cal - params['bg_ref'][np.newaxis, :]
        bg_applied = True
        print(f"\n  BG subtraction: APPLIED")
    else:
        h_cal_sub = h_cal
        if not USE_SYNTHETIC:
            if USE_BG_SUBTRACTION:
                print(f"\n  BG subtraction: REQUESTED but no bgRef in file")
            else:
                print(f"\n  BG subtraction: OFF")

    # Compute range profiles (raw for display, subtracted for SAR)
    crp_raw, crp_distances, _, _ = compute_range_profiles(
        h_cal, params['num_steps'], params['freq_step_hz'], params['range_offset']
    )
    t0 = time.perf_counter()
    crp_sub, _, crp_dist_start, crp_dist_step = compute_range_profiles(
        h_cal_sub, params['num_steps'], params['freq_step_hz'], params['range_offset']
    )
    t1 = time.perf_counter()
    print(f"\nRange profiles: {(t1-t0)*1000:.1f} ms")
    print(f"  Bins: {crp_sub.shape[1]}, dist range: {crp_distances[0]*100:.2f} - {crp_distances[-1]*100:.2f} cm")

    # Setup backprojection parameters
    antenna_x = np.arange(params['num_positions']) * params['step_size_m']
    k_start = 2 * np.pi * params['start_freq_hz'] / SPEED_OF_LIGHT
    max_depth_m = MAX_DEPTH_CM / 100.0
    aperture_length = antenna_x[-1] - antenna_x[0]

    print(f"\nBackprojection ({PIXELS_X}x{PIXELS_Z} grid)...")
    print(f"  Aperture: {aperture_length*100:.1f} cm")
    print(f"  Max depth: {MAX_DEPTH_CM} cm")

    # Run DAS on the (possibly BG-subtracted) data
    t2 = time.perf_counter()
    image = das_backprojection(
        crp_sub, crp_dist_start, crp_dist_step, antenna_x,
        k_start, max_depth_m, PIXELS_X, PIXELS_Z
    )
    t3 = time.perf_counter()
    compute_ms = (t3 - t2) * 1000
    print(f"  Done in {compute_ms:.0f} ms")
    print(f"  Peak: {np.max(image):.1f} dB")

    # Display B-scan + SAR side by side
    display_results(crp_raw, crp_sub, crp_distances, image,
                    aperture_length, max_depth_m, DYN_RANGE_DB,
                    compute_ms, bg_applied)


if __name__ == '__main__':
    main()
