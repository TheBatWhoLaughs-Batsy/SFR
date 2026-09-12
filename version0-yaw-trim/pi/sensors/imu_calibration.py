"""IMU calibration: bias estimation and axis remapping.

Original calibration discovery results (measured on the MPU-6500):
  Gravity when level: accel +X = +1g  -> IMU +X = physical UP
  Roll right:  gyro +Z (+70.6 deg)    -> IMU Z = roll/forward axis
  Pitch down:  gyro -Y (-40.1 deg)    -> IMU Y = pitch/left axis
  Yaw right:   gyro -X (-84.7 deg)    -> IMU X = yaw/up axis

Body frame (right-hand):
  Body X = FORWARD, Body Y = LEFT, Body Z = UP

BNO085 remap (2026-08-24, revised after two rounds of live testing): raw gravity
lands on +Y (~0.98g, board flat on the bench -- confirmed directly), which fixes
raw Y = physical UP = the yaw axis. The gyro axis identities were resolved from two
rounds of live rotation feedback, not derived in one pass:
  Round 1 (MPU-6500 mapping applied unchanged to the BNO085): pitch read out as yaw.
    -> true pitch involves raw X (whatever was in the "yaw" slot).
  Round 2 (after swapping pitch/yaw to route raw X into pitch): roll and pitch read
    swapped. -> true roll is whatever round 1's fix put in the "pitch" slot (raw X),
    true pitch is whatever was still in "roll" (raw Z). Yaw was not reported wrong
    either round, so it stays on raw Y.
Net result: raw X = roll axis (forward), raw Z = pitch axis (left), raw Y = yaw axis
(up) -- a full relabeling of all three axes, not the simpler two-axis swap the round-1
fix assumed (that assumption is what round 2's feedback disproved).

R_ACCEL's forward/left rows are NOT independently verified -- there's no live accel
test analogous to the gyro rotation tests above, only the confirmed gravity/up
measurement. They're set equal to R_GYRO's rows on the reasoning that the BNO085's
SH-2 reports (unlike the MPU-6500's) are documented to share one common sensor frame
across accel/gyro/mag, so the same axis-identity-and-sign relabeling should carry
over directly. If "forward" or "left" prove backwards under a real accel test (e.g.
nose-down tilt, or roll onto one side), that's the part to re-derive -- "up" is solid.

Accel mapping:  body = R_ACCEL @ imu
  forward = -imu_x, left = imu_z, up = imu_y

Gyro mapping:  body = R_GYRO @ imu
  roll_rate(+right) = -gyro_x, pitch_rate(+up) = +gyro_z, yaw_rate(+right) = +gyro_y
"""

import json
import os
import time
import numpy as np

CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'imu_cal.json')

R_ACCEL = np.array([
    [-1, 0,  0],   # forward = -imu_x
    [0,  0,  1],   # left    =  imu_z
    [0,  1,  0],   # up      =  imu_y
], dtype=np.float64)

R_GYRO = np.array([
    [-1, 0,  0],   # roll  = -gyro_x  (positive = right)
    [0,  0,  1],   # pitch = +gyro_z  (positive = up)
    [0,  1,  0],   # yaw   = +gyro_y  (positive = right)
], dtype=np.float64)


def load_config():
    """Load calibration config from disk, or return defaults."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    return {
        'gyro_bias': [0.0, 0.0, 0.0],
        'accel_bias': [0.0, 0.0, 0.0],
        'calibrated_at': None,
        'temperature_at_cal': None,
    }


def save_config(config):
    """Persist calibration config to disk."""
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)


def calibrate_gyro_bias(imu, duration=2.0, rate=200):
    """Capture stationary gyro samples and compute zero-rate bias.

    Args:
        imu: sensor driver instance (read_all() -> {accel, gyro, temp}, close())
        duration: seconds to sample
        rate: approximate sample rate (Hz)

    Returns:
        dict with gyro_bias, accel_bias, temperature, sample_count
    """
    samples_gyro = []
    samples_accel = []
    temps = []

    interval = 1.0 / rate
    n_samples = int(duration * rate)

    print(f"IMU calibration: collecting {n_samples} samples over {duration}s (hold still)...")

    for _ in range(n_samples):
        t0 = time.monotonic()
        data = imu.read_all()
        samples_gyro.append(data['gyro'])
        samples_accel.append(data['accel'])
        temps.append(data['temp'])
        elapsed = time.monotonic() - t0
        if elapsed < interval:
            time.sleep(interval - elapsed)

    gyro_arr = np.array(samples_gyro)
    accel_arr = np.array(samples_accel)

    gyro_bias = gyro_arr.mean(axis=0).tolist()
    accel_mean = accel_arr.mean(axis=0).tolist()

    # Accel bias: subtract expected gravity from the dominant axis.
    # Gravity should be +1g on IMU Y axis when level, for the BNO085's mounting
    # (was X for the MPU-6500 -- see the module docstring's remap note). Keep this
    # in sync with R_ACCEL above; they encode the same physical fact.
    accel_bias = [
        accel_mean[0] - 0.0,
        accel_mean[1] - 1.0,  # Y has gravity
        accel_mean[2] - 0.0,
    ]

    gyro_std = gyro_arr.std(axis=0).tolist()
    # Not every driver reports temperature (the BNO085's SH-2 report set has no plain
    # temperature report, so its read_all() always returns temp: None) -- skip rather
    # than feed None into np.mean, which raises.
    valid_temps = [t for t in temps if t is not None]
    temp_mean = float(np.mean(valid_temps)) if valid_temps else None

    print(f"  Gyro bias: [{gyro_bias[0]:.4f}, {gyro_bias[1]:.4f}, {gyro_bias[2]:.4f}] deg/s")
    print(f"  Gyro noise (std): [{gyro_std[0]:.4f}, {gyro_std[1]:.4f}, {gyro_std[2]:.4f}] deg/s")
    print(f"  Accel bias: [{accel_bias[0]:.4f}, {accel_bias[1]:.4f}, {accel_bias[2]:.4f}] g")
    print(f"  Temperature: {temp_mean:.1f} °C" if temp_mean is not None else "  Temperature: n/a")
    print(f"  Samples: {len(samples_gyro)}")

    config = {
        'gyro_bias': gyro_bias,
        'accel_bias': accel_bias,
        'calibrated_at': time.time(),
        'temperature_at_cal': temp_mean,
        'gyro_noise_std': gyro_std,
        'sample_count': len(samples_gyro),
    }

    save_config(config)
    print(f"  Saved to {CONFIG_PATH}")

    return config


class CalibratedIMU:
    """Wrapper around an IMU driver that applies bias correction and axis remapping."""

    def __init__(self, imu, auto_calibrate=True, cal_duration=2.0):
        """
        Args:
            imu: sensor driver instance (read_all() -> {accel, gyro, temp}, close())
            auto_calibrate: if True, run gyro bias calibration on init
            cal_duration: seconds for bias calibration
        """
        self.imu = imu
        self.config = load_config()

        if auto_calibrate or self.config['calibrated_at'] is None:
            self.config = calibrate_gyro_bias(imu, duration=cal_duration)
        else:
            print(f"IMU: using saved calibration from {self.config['calibrated_at']}")

        self.gyro_bias = np.array(self.config['gyro_bias'])
        self.accel_bias = np.array(self.config['accel_bias'])

    def read_raw(self):
        """Read bias-corrected values in IMU frame."""
        data = self.imu.read_all()

        accel = np.array(data['accel']) - self.accel_bias
        gyro = np.array(data['gyro']) - self.gyro_bias

        return {
            'accel': accel,
            'gyro': gyro,
            'temp': data['temp'],
            # Pass-through from the sensor's own fusion; not remapped (it is a
            # heading about the sensor's Z, which is up on this mount).
            'yaw_deg': data.get('yaw_deg'),
            'quat': data.get('quat'),
        }

    def read_body(self):
        """Read bias-corrected, axis-remapped values in body frame.

        Body frame:
            accel: [forward, left, up] in g
            gyro: [roll_rate, pitch_rate, yaw_rate] in deg/s
                  roll right = +, pitch up = +, yaw right = +
        """
        raw = self.read_raw()

        accel_body = R_ACCEL @ raw['accel']
        gyro_body = R_GYRO @ raw['gyro']

        return {
            'accel': accel_body,
            'gyro': gyro_body,
            'temp': raw['temp'],
            'yaw_deg': raw.get('yaw_deg'),
            'quat': raw.get('quat'),
        }

    def close(self):
        self.imu.close()
