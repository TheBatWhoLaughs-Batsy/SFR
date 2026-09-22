# IMU — BNO085

**Purpose** — orientation. Tilt compensation for the handheld position, heading for the
rover's closed-loop steering, and a 3D attitude display.

**Location** — `pi/sensors/bno085.py`, calibration in `pi/sensors/imu_calibration.py`,
diagnostics in `pi/sensors/bno085_diag.py`. I2C address `0x4A`. Wiring in `CONTEXT.md`.

Replaced an MPU-6500 at `0x68`. Speaks **SHTP over I2C**, not simple register read/write — a
hand-rolled driver on `smbus2`/`i2c_msg`, matching the repo's other sensor drivers with no
framework dependency. The adafruit BNO08x libraries are installed on the Pi from cross-checking
the protocol during bring-up; nothing shipped uses them.

---

## Packet shape

Deliberately unchanged from the MPU-6500 era — `accel` / `gyro` / `temp`, same consumers — so
the axis remap and the groundstation's Madgwick filter kept working unmodified. The driver
converts the calibrated accelerometer report (m/s², Q8) to g and the gyroscope report (rad/s,
Q9) to deg/s, so nothing downstream needed unit changes.

**`temp` streams `null`** — the SH-2 report set has no plain temperature report. Every consumer
handles that.

The quaternion is the **game rotation vector** (report `0x08`, accel + gyro only), so roll and
pitch are gravity-referenced and drift-free while yaw free-runs at ~1-2 deg/minute.

**Do not switch to the magnetometer-fused rotation vector.** The mag-fused report is one
constant away, but this instrument images rebar — a magnetometer aimed at reinforced concrete
is pulled by exactly the thing being looked for, so the heading error would correlate with the
target. Conduit, steel studs and wiring make indoor heading untrustworthy generally. Measured
cost of the drift: height is *exactly* immune (yaw is rotation about the down beam's own axis),
and the other two axes cost `standoff * ψ²/2` — second order, ~0.1-0.4 mm over a session.

## The axis remap

`imu_calibration.py`'s `R_ACCEL` / `R_GYRO`. The BNO085's raw axes are a **full relabelling**
of the body frame, not a two-axis swap:

    raw X -> roll axis (forward), raw Z -> pitch axis (left), raw Y -> yaw axis (up)

`R_GYRO`: `roll = -gyro_x`, `pitch = +gyro_z`, `yaw = +gyro_y`.

**`R_ACCEL`'s forward/left rows are inferred, not independently measured** — set equal to
`R_GYRO`'s on the documented fact that the BNO085's SH-2 reports share one sensor frame across
accel, gyro and mag. That was **not** true of the MPU-6500, whose two matrices were genuinely
different, so do not assume the equivalence generalises to other hardware.

The handheld mount calibration (see `handheld.md`) independently measures those rows, and
would be the first real confirmation of them.

### Testing trap: a level resting pose proves nothing

`auto_calibrate` reruns on every `stream.py` startup and its accel-bias step subtracts whatever
the raw reading was *at that moment*. Calibrating and then immediately reading the same static
pose cancels any remaining wrong-axis error — "up reads ~1 g" regardless of whether `R_ACCEL`
is correct. A known-wrong mapping passed this exact check.

**The only real test is dynamic**: tilt through a known roll, pitch and yaw and check that the
reported axis *and sign* match the physical motion.

If a report of "X is swapped with Y" arrives, **ask for a full walk-through** — rotate slowly
through each of roll, pitch and yaw individually, reporting sign and which body-frame value
moves for each. Two rounds of partial feedback already produced one wrong intermediate fix.

## Report rates and the buffer

48-byte read buffer, 20 ms (50 Hz) report intervals for both accelerometer and gyroscope.

These are tuned together and the reason is not obvious. Each I2C read transaction costs real
time regardless of whether data is pending — 12 ms for a 128-byte read on this Pi, 3.2 ms at
32 bytes — and the BNO085 pushes reports on its own schedule whether or not the host drains
them. At 100 Hz + 100 Hz against 12 ms reads the drain loop could never catch up: every call
hit its read cap, batched packets outgrew the buffer and were silently truncated, and gyro-bias
calibration did not finish within 20 s.

If report intervals ever need to rise for a smoother display, **drop the per-call read cap
first and re-measure the steady-state read count** — do not just change the interval.

## Known failures

**`RuntimeError: BNO085: feature 0x01 was not confirmed enabled`** — the handshake loops were
rate-capped below the sensor's own report rate, so a sensor left streaming by a previous run
starved them. Fixed in `bno085.py` (silence features first, drain to empty, handle oversized
packets), reproduced against a single-FIFO fake. **Not yet confirmed on the rig** — run
`python3 pi/sensors/bno085_diag.py`.

**Every `SET_FEATURE_COMMAND` ignored while Product ID queries work** — the SH-2 application
firmware is not running. **Power-cycle the board before chasing protocol theories**; that is
what fixed it during bring-up, after corrected sequence numbers, long settle times and full
channel drains had all been ruled out.

**Nothing at any I2C address** — check it is physically plugged in. That was the answer once,
after a long investigation into a theory (IMU and LiDAR sharing a rail) that was wrong on every
count.

## Change history

MPU-6500 to BNO085 on 2026-08-24; `mpu6500.py` deleted. The onboard sensor fusion (rotation
vector) was deliberately not adopted for the streamed packet — smaller blast radius — though
the handheld path does use the quaternion.
