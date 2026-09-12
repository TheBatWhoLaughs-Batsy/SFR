"""Convert gprMax time-domain B-scan (merged HDF5) to SFCW JSON format.

Reads the merged .out file, computes the DFT at exactly the SFCW stepped
frequencies, and writes a JSON file compatible with SAR_Test_Ground.py's
load_bscan() function.
"""

import numpy as np
import h5py
import json
import sys
import os

# --- Configuration ---
MERGED_HDF5 = "/home/alwin/gprMax/user_models/sand_pipe_bscan_2D_merged.out"
BG_HDF5 = "/home/alwin/gprMax/user_models/sand_nopipe_bscan_2D_merged.out"
OUTPUT_JSON = "/home/alwin/Downloads/gprmax_sand_pipe_sim.json"

START_FREQ_HZ = 2e9
STOP_FREQ_HZ = 5e9
FREQ_STEP_HZ = 20e6
SCAN_STEP_CM = 0.5      # 5mm spatial step
RANGE_OFFSET = 0.0      # no cable delay in simulation


def compute_dft(hdf5_path, freqs):
    """Read merged HDF5 and compute DFT at target frequencies."""
    with h5py.File(hdf5_path, 'r') as f:
        dt = float(f.attrs['dt'])
        ez_data = np.array(f['/rxs/rx1/Ez'])

    n_time, n_positions = ez_data.shape
    print(f"  {n_positions} positions x {n_time} time samples, dt={dt*1e12:.3f} ps")

    t = np.arange(n_time) * dt
    W = np.exp(-1j * 2 * np.pi * freqs[:, np.newaxis] * t[np.newaxis, :])
    H = (W @ ez_data).T  # shape: [n_positions, num_steps]
    print(f"  Max |H| = {np.max(np.abs(H)):.4e}")
    return H


def convert_gprmax_to_sfcw(merged_path, output_path, bg_path=None):
    freqs = np.arange(START_FREQ_HZ, STOP_FREQ_HZ + FREQ_STEP_HZ / 2, FREQ_STEP_HZ)
    num_steps = len(freqs)
    print(f"Target: {num_steps} freq points, {freqs[0]/1e9:.1f}-{freqs[-1]/1e9:.1f} GHz")

    print(f"Signal file: {merged_path}")
    H = compute_dft(merged_path, freqs)

    bg_ref_dict = None
    if bg_path and os.path.exists(bg_path):
        print(f"Background file: {bg_path}")
        H_bg = compute_dft(bg_path, freqs)
        # Use mean across all background positions as the reference
        bg_mean = H_bg.mean(axis=0)
        bg_ref_dict = {
            "h_cal_real": bg_mean.real.tolist(),
            "h_cal_imag": bg_mean.imag.tolist(),
        }
        print(f"  BG ref: mean of {H_bg.shape[0]} positions")

    data_list = []
    for pos in range(H.shape[0]):
        data_list.append({
            "h_cal_real": H[pos].real.tolist(),
            "h_cal_imag": H[pos].imag.tolist(),
            "num_steps": int(num_steps),
            "step_size": int(FREQ_STEP_HZ),
            "range_offset": RANGE_OFFSET,
        })

    output = {
        "version": 1,
        "timestamp": "gprMax_simulation",
        "params": {
            "stepSize": SCAN_STEP_CM,
            "numPositions": H.shape[0],
        },
        "sfcwParams": {
            "startFreq": int(START_FREQ_HZ / 1e6),
            "stopFreq": int(STOP_FREQ_HZ / 1e6),
            "stepSize": int(FREQ_STEP_HZ / 1e6),
        },
        "data": data_list,
        "bgRef": bg_ref_dict,
    }

    with open(output_path, 'w') as f:
        json.dump(output, f)

    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Written: {output_path} ({file_size_mb:.1f} MB)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else MERGED_HDF5
    dst = sys.argv[2] if len(sys.argv) > 2 else OUTPUT_JSON
    bg = sys.argv[3] if len(sys.argv) > 3 else BG_HDF5
    convert_gprmax_to_sfcw(src, dst, bg)
