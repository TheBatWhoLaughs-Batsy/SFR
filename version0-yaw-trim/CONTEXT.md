# version0 — SFCW Radar Wall Imaging System

## Mission

Within-wall imaging using a Stepped-Frequency Continuous Wave (SFCW) radar.
The goal is to image what is inside the wall (rebar, pipes, voids, studs),
not what is beyond it.

---

## Hardware

| Component | Model | Interface | Role |
|-----------|-------|-----------|------|
| Compute | Raspberry Pi (with AI HAT+) | — | On-board control, sensor fusion, data capture |
| LiDAR | TF-LC02 | UART (serial) | Range/distance reference |
| IMU | BNO085 (was MPU-6500 until 2026-08-24) | I2C | Orientation, acceleration, gyro |
| SDR | bladeRF | USB | SFCW radar TX/RX |
| Antennas | 2x Vivaldi | SMA to bladeRF | Wideband TX and RX |
| Rover | Stepper gantry + Arduino UNO | WebSocket over LAN | 2-axis positioning of the radar head |
| Network | Ethernet/WiFi | LAN | Pi <-> PC link |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        LAN                                   │
│                                                             │
│  ┌─────────────────────┐          ┌──────────────────────┐ │
│  │   Raspberry Pi       │          │   PC (Groundstation) │ │
│  │                     │          │                      │ │
│  │  - Sensor capture   │  ◄────►  │  - Control panel     │ │
│  │  - Radar TX/RX      │  socket  │  - Debug tools       │ │
│  │  - Data streaming   │          │  - Heavy processing  │ │
│  │                     │          │  - 3D visualization  │ │
│  └─────────────────────┘          └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Operational Model

- **No direct input to the Pi.** All commands originate from the groundstation.
- **Pi streams data** (raw IQ, sensor logs) to groundstation.
- **Heavy processing** (image reconstruction, SAR focusing) runs on the PC.
- **Debug everything.** Every subsystem has a dedicated debug view on groundstation.

## Groundstation Debug Tools (planned)

- LiDAR distance log + live plot
- IMU orientation/accel live view
- 3D position visualizer (fused estimate)
- Radar TX/RX pattern viewer
- Raw IQ waterfall / spectrogram
- SFCW range profile display
- SAR image reconstruction view
- System health / link status

## Groundstation Control Panel (planned)

- Initiate scan
- Stop / pause / resume
- Configure radar parameters (freq range, step size, dwell time)
- Configure sensor sampling rates
- Trigger calibration routines
- Data recording start/stop

## Directory Structure

```
version0/
├── pi/                    # Code that runs on the Raspberry Pi
│   ├── sensors/           # LiDAR, IMU drivers/readers
│   ├── radar/             # bladeRF SFCW control
│   ├── rover/             # Stepper gantry control + position tracking
│   ├── comms/             # Network transport to groundstation
│   └── scripts/           # Startup, calibration, utilities
├── groundstation/         # Code that runs on the PC
│   ├── ui/                # Main GUI framework
│   ├── debug/             # All debug/visualization tools
│   ├── control/           # Command panel (start/stop/config)
│   ├── processing/        # Heavy compute (SAR, image recon)
│   └── comms/             # Network transport to Pi
├── shared/                # Code used by both Pi and PC
│   ├── protocols/         # Message formats, command definitions
│   └── config/            # Shared configuration constants
├── docs/                  # Additional documentation
├── CONTEXT.md             # THIS FILE — project global context
└── CLAUDE.md              # Claude Code project instructions
```

## Network Protocol (TBD)

Communication between Pi and groundstation. Likely ZeroMQ or raw TCP sockets
with a simple framed binary protocol. Requirements:
- Low-latency command delivery (groundstation -> Pi)
- High-throughput data streaming (Pi -> groundstation)
- Multiplexed channels (IQ data, sensor data, status)

## Radar Parameters

- Hardware: bladeRF xA9 (AD9361 RFIC)
- Frequency range: 1–3 GHz (configurable, max ~3.8 GHz)
- Step size: 10 MHz default
- Dwell time per step: 1 ms (PLL settle)
- TX power: 1.0 amplitude, gain 50 dB (RF Calib panel default; RX gain 25 dB, center freq
  2000 MHz, sample rate 10 Msps — see `BladeRFDriver.__init__` / `RfCalibPanel.jsx`)
- Antenna polarization: co-pol initially
- Phase coherence: Dual-channel reference method — TX2→RX2 short SMA cable
  provides phase reference. Signal (RX1) divided by reference (RX2) cancels
  random PLL phase offsets between TX and RX synthesizers at each step.
  AD9361 single-synth mode does NOT work (FDD requires both PLLs active).

## Wiring — BNO085 (I2C mode)

Replaced the MPU-6500 on 2026-08-24 (same I2C1 bus). Confirmed by probe: I2C address
`0x4A` (`i2cdetect -y 1`), SCL/SDA on the same Pin 5 / Pin 3 (GPIO 3 / GPIO 2) I2C1 bus the
MPU-6500 used. **Exact VCC/GND header pins and whether RST/PS0/PS1 are wired to anything on
the Pi are not confirmed** — no GPIO shows as driving a reset line for it (`gpioinfo`), so
either those pins are strapped on-board (normal for most BNO085 breakouts, which fix
PS0/PS1 for I2C app mode and leave RST pulled up) or genuinely floating. During bring-up the
chip briefly got stuck in a state where control-channel queries worked but sensor feature
reports wouldn't enable — a power cycle fixed it (see the CLAUDE.md IMU section) — so it
does need real power, not just I2C soft reset, to leave that state. Fill in the actual VCC
pin and RST/PS status here next time the wiring is physically checked instead of leaving
this as a known gap.

## Wiring — TF-LC02 LiDAR (UART)

**Moved to UART3 (2026-08-24) after UART0's receiver was found dead** — see CLAUDE.md's
LiDAR silent-serial investigation for the full diagnostic trail (loopback + `TIOCGICOUNT`
testing isolated it to UART0's RX peripheral specifically, not the module, not the wiring,
not the Pi's GPIO pins themselves). VCC is 3.3V and not shared with the IMU, confirmed
correct and unchanged throughout.

| TF-LC02 Pin | Raspberry Pi | Notes |
|---|---|---|
| VCC | 3.3V rail | Not shared with IMU |
| GND | Pin 6 (GND) | Common ground |
| TX | Pin 21 (GPIO 9 / RXD3) | LiDAR TX → Pi RX |
| RX | Pin 24 (GPIO 8 / TXD3) | Pi TX → LiDAR RX |

`uart3-pi5` overlay enabled in `config.txt` (`uart0-pi5` disabled, left commented rather than
removed). Device: `/dev/ttyAMA3` (was `/dev/serial0`/`ttyAMA10` — do not revert to that, its
receiver is dead). Serial console disabled.

## LiDAR → Antenna Offset (measured 2026-08-28)

**165 mm measured; 160 mm used** (5 mm buffer so a true zero-standoff pose reports
slightly positive). With the antenna aperture placed against the wall, the TF-LC02 reads
**164.83 mm ± 0.68**. Standoff = `lidar_reading − offset`, so real operation spans a lidar
reading of roughly **165–315 mm** for 0–150 mm of standoff.

The value was hardcoded at 315 mm in `App.jsx` until 2026-08-28 and did not match this
mounting. It is now App.jsx state, persisted to `localStorage.lidar_antenna_offset_mm` and
editable in the SFCW panel's Standoff section. **Re-measure it after any re-mount** — put
the aperture against the wall, read the lidar, subtract 5. Background models record the
offset they were built under (`geometry.lidarAntennaOffsetMm`) and the panel warns when a
loaded model disagrees with the current setting. See CLAUDE.md's background-subtraction
section for why a *constant* offset error cancels but a *changed* one does not.

## BNO085 — the "feature 0x01 was not confirmed enabled" failure (2026-09-10)

**Not a power-cycle problem.** The file's own header blamed the SH-2 app not running;
that was a guess and it is wrong for this symptom. Three real bugs in `bno085.py`, found
2026-09-12 and reproduced against a fake device with a single output FIFO:

**1. The handshake loops could not outpace the sensor.** `_check_product_id` and
`_enable_feature` did `time.sleep(0.02)` after *every* read, including reads that
returned a packet — capping intake at ~50 packets/s. With accel and gyro both at 50 Hz
the device emits ~100 reports/s. Any restart of `stream.py` that did not cut the
sensor's power (a crash, Ctrl-C, `systemctl restart`, re-running the script) leaves the
features enabled and the sensor streaming, so the queue grows faster than the loop
drains it and the `0xFC` response — which sits *behind* the backlog in the device's
single FIFO — is never reached. Measured: with 300 packets queued the old loop did 100
reads in 2.02 s and timed out with 399 still pending; with 50 queued it succeeded. That
is the whole bug, and it is why the failure looked intermittent.

**2. `_drain` drained nothing.** It looped on wall-clock with a 10 ms sleep — ~30 reads
in its 0.3 s budget, against 100 reports/s. It returned with the queue as full as it
started. Now drains until the device reports empty several times in a row.

**3. `_read` silently truncated long packets.** `buf[4:4+data_len]` does not raise when
the buffer is short, so anything over `_MAX_PACKET` (48 B) became a short packet and
`_handle_input_reports` bailed mid-batch. The SHTP advertisement sent after every reset
is ~272 B. The continuation bit was masked off and the fragment parsed as a whole
packet. Now the length is read first and an oversized packet is re-read at its true size
in one transaction; continuations are flagged and dropped.

**Fixes:** read flat out while packets flow and sleep only when the device is empty
(`_await_control`); drain to empty; handle oversized packets; **`_silence()` disables all
features with a Set Feature interval of 0 before the handshake**, so a previously
streaming sensor goes quiet without touching its power; accept the feature's own data as
confirmation (a missed `0xFC` used to fail a sensor that was in fact streaming); retry
the whole sequence ×3; count `io_errors` / `bad_headers` / `oversize_reads` and name the
likely cause in the exception.

**`pi/sensors/bno085_diag.py`** reports which of these it actually is, in seven stages:
bus reachable, already-streaming check *before sending anything*, silence+drain, reset
advertisement (flags packets over 48 B), product ID, per-feature enable with timings,
then live data with an `|accel|` sanity check. Run it before theorising.

**Still possible and not excluded:** the BNO08x relies on I2C clock stretching, which the
Pi's BCM controller implements badly. Stage 1 of the diagnostic detects it (intermittent
short reads) and the fix is `dtparam=i2c_arm_baudrate=50000` in
`/boot/firmware/config.txt`. The BOOT pin being held low, and a genuinely wedged SH-2
app, remain possible — but they are now the *last* hypotheses, not the first.

## IMU Calibration & Orientation

**Stale as of 2026-08-24 — measured for the MPU-6500, not re-verified for the BNO085 that
replaced it.** Confirmed on the bench: the BNO085's raw gravity reading lands on a different
axis than the MPU-6500's did, so the mapping below is known wrong until re-run through the
calibration discovery tool. See `imu_calibration.py`'s module docstring and the CLAUDE.md
IMU section for specifics.

MPU-6500 mounting orientation (determined via calibration tool):
- IMU +X = physical UP (gravity reads +1g on X when level)
- IMU Y = pitch axis (pitch down = gyro -Y)
- IMU Z = roll/forward axis (roll right = gyro +Z)

Body frame convention (right-hand):
- Body X = FORWARD
- Body Y = LEFT
- Body Z = UP

Data sent over WebSocket (port 9001) is in body frame:
- `accel`: [forward, left, up] in g
- `gyro`: [roll_rate, pitch_rate, yaw_rate] in deg/s
- Positive: roll right, pitch up, yaw right

Startup calibration: 2s stationary capture → gyro/accel bias saved to `pi/sensors/imu_cal.json`.
Use `--skip-cal` flag on `stream.py` to reuse previous calibration.

## Rover — Stepper Gantry

Arduino UNO R4 WiFi + CNC Shield V3, four A4988-class drivers, firmware in `rover/`.
Two axes only — **X = left/right**, **Y = up/down**. There is no standoff (toward-wall)
axis, so standoff is still set by hand and measured by the LiDAR.

| axis | driver pins (STEP/DIR) | mechanism | resolution | travel | max / jog speed |
|---|---|---|---|---|---|
| **Y** vertical | 3 / 6 (`PIN_X_*`) | leadscrew, 2 mm × 4-start = 8 mm/rev | **200.0 steps/mm** exact (5 µm) | 1 m, soft-limited 150–850 mm | 25 / 15 mm/s |
| **X** horizontal | 2/5 front (`PIN_Y_*`), 4/7 rear right (`PIN_Z_*`), 12/13 rear left (`PIN_A_*`) | 66 mm drive wheels, rolling | **7.7166 steps/mm** (130 µm) | 4 m, soft-limited 0–3900 mm | 150 / 60 mm/s |

1600 steps/rev (200-step motors at 1/8 microstepping). Scans typically span ~100 mm.
**Pin map and direction flags are as set on the rig 2026-09-12** (`rover/config.h`:
`V_DIR_INVERT false`, `H_DIR_INVERT true`, per-wheel `H_INVERT_Y true / Z true / A false`).
The `PIN_X_*` / `PIN_Y_*` macro names no longer correspond to the shield silkscreen — go by
the pin numbers, and re-verify by jogging each axis after any driver is reseated.

**Wheel layout is an auto-rickshaw**: one driven front wheel (pins 2/5), two driven rear
wheels on separate axles — right (4/7) and left (12/13). Nothing steers. The chassis yaws
when the rear pair turn at different rates, and that is how drift is corrected: see
"Yaw trim" below.

### Yaw trim — closed loop from the BNO085 (2026-09-12)

`pi/rover/yaw_control.py`. `rover_server.py` subscribes to the sensor stream
(`--sensors-url`, default `ws://127.0.0.1:9001`) and takes `yaw_deg` from it — the
BNO085's **game rotation vector** (gyro + accel fusion, no magnetometer, so the steppers
cannot disturb it; heading is relative to the chip's last reset and drifts slowly). In
**auto** mode (`rover_yaw_mode`, a command not a config key, so it never survives a
restart) the loop runs on every board status frame:

    e     = wrap(yaw − yaw_ref)             deg, CCW positive
    alpha = Kp·e·dir + bias, clamped ±30    dir = sign of horizontal travel
    bias += Ki·e·dir·dt                     learns the standing drift

and sends `trim` to the board at most 4 Hz, only on change, only while moving
horizontally; a stale IMU (>1 s) holds the last alpha. `yaw_ref` is captured when auto
engages and by `rover_yaw_zero` ("this is parallel"). Auto is seeded with the manual
value; switching back to manual keeps the learned alpha as the new manual value. `yaw_kp`,
`yaw_ki`, `yaw_invert` are config. **If auto makes the drift worse, flip `yaw_invert`** —
that is the IMU's mounting sense, and the docstring in `yaw_control.py` shows it
diverging within seconds when wrong. Simulated against a reversing-drift plant with 0.03°
IMU noise: learns the rig's −2.5 % bias exactly, worst error ~1° during learning, 0.07°
steady, ~3 trim sends/s.

**Measured on the rig 2026-09-12:** open-loop needs −3 % going right and −2 % going
left. That decomposes into a −2.5 % reversing part (wheel mismatch) and a ±0.5 %
non-reversing part (floor/cable); the latter accumulates across a raster, which is why
the loop exists.

### Yaw trim (firmware 2.4.0, 2026-09-12)

The horizontal axis generates ONE base step rate that drives the front wheel and the
position count. Each rear wheel has its own accumulator fed with the base rate scaled by
(1 ∓ trim). `yaw_trim_pct` in the Pi's config (±30, `CONFIG_BOUNDS`) is pushed in every
`cfg` as `yaw`; the board applies it and echoes it in `status`. **Positive = left rear
faster = nose turns right**; `YAW_TRIM_INVERT` in `config.h` flips the sign if the rig
disagrees. The Pi persists it (`rover_state.json`), the board does not. Tuned from the
panel's "Steering Trim" section: jog along the wall, nudge until the gap holds. The front
wheel cannot steer, so it scrubs slightly while the rear pair turns the chassis —
negligible at the few percent a drift needs.

**No endstops and no encoder.** Soft limits are the only travel protection, and the
operator declaring the position is the only ground truth. The horizontal axis rolls on
wheels, so slip is possible in principle (judged unlikely in practice); the odometer since
the last declared position is reported as the exposure.

The Arduino is a **WebSocket client**: it dials into the Pi on port 8765 and the Pi is the
server. The link speaks line JSON with sequence numbers — `move` / `jog` / `jog_hold` /
`stop` / `estop` / `clear_estop` / `set_pos` / `cfg` / `enable` outbound, and
`hello` / `status` (20 Hz) / `ack` / `done` / `err` inbound. **Everything on the wire is in
STEPS**; millimetres exist only on the Pi, which holds the calibration.

Step pulses come from a 20 kHz timer ISR so that WiFi servicing cannot disturb them, which
is what lets the board stay responsive during motion — continuous jog, E-stop mid-move and
live position all depend on it.

WiFi credentials are in `rover/secrets.h`, gitignored; `rover/secrets.example.h` is the
committed template.

The rig's board radio MAC is **F4:12:FA:6E:A9:9C** (Espressif — the R4's WiFi is an
ESP32-S3); on 2026-09-10 it held **192.168.1.5** by DHCP and the Pi held **192.168.1.8**.
(A second Espressif device, 04:CF:4B:B5:15:03, sits at 192.168.1.11 on the same network —
an earlier note recorded that one as the board; it is not the one on the rig.) Neither has a
router reservation yet; `PI_HOST` in `secrets.h` is baked into the firmware, so the Pi's
address moving is a known way for the board to dial nobody. The firmware
prints its MAC at boot in both byte orders, since this library family fills the array
backwards. A reservation makes the address deterministic but does **not** guarantee the DHCP
exchange itself succeeds — `linkReady()` in the firmware is what makes a failed lease
recoverable, and `USE_STATIC_IP` in `config.h` skips DHCP entirely if it is ever needed.

Firmware layout: `config.h` (pins, mechanism, defaults), `motion_core.h` (ramp, limits,
watchdog — Arduino-free and unit-tested), `protocol_core.h` (JSON — likewise), `rover.ino`
(pins, timer, sockets, flash persistence). `rover/test/build_check.sh` runs the native
tests and type-checks the sketch; `pi/rover/rover_sim.py` stands in for the board so the
Pi and groundstation are testable without the rig.

## Network Ports

| Service | Port | Protocol | Direction |
|---------|------|----------|-----------|
| Sensor stream (IMU + LiDAR) | 9001 | WebSocket | Pi → Browser |
| Rover control + position | 9002 | WebSocket | Pi ↔ Browser |
| Rover ← Arduino UNO link | 8765 | WebSocket | UNO → Pi (the UNO dials in) |
| SDR control + IQ stream | 9003 | WebSocket | Pi ↔ Browser |
| Groundstation UI | 5000 | HTTP | PC local |

## Current Status

- [x] Project scaffolded
- [x] Context documented
- [x] Hardware connections (IMU + LiDAR wired and tested)
- [x] IMU driver (BNO085 over I2C, was MPU-6500)
- [x] LiDAR driver (TF-LC02 over UART)
- [x] Combined sensor WebSocket stream (port 9001)
- [x] Groundstation UI — IMU + LiDAR debug panel
- [x] IMU calibration (gyro bias + accel bias at startup, persisted to imu_cal.json)
- [ ] IMU axis remapping (IMU frame → body frame: forward/left/up) — done for MPU-6500,
      confirmed wrong for BNO085, needs re-discovery
- [x] Madgwick AHRS orientation filter (quaternion-based, groundstation 3D view)
- [x] IMU calibration discovery tool (groundstation panel)
- [x] BladeRF driver + AquaSense calibration panel (signal generator + oscilloscope)
- [ ] BladeRF SFCW implementation
- [x] Rover firmware rewrite (ISR stepping, JSON protocol, E-stop, soft limits, calibration)
- [x] Rover jog control + position tracking from the controller's own step counter
- [x] Rover automated grid raster (drives the C-Scan panel's grid; Scan Mode = Rover)
- [x] Rover yaw trim — open-loop differential rear wheels, Pi-owned value, panel control (2.4.0)
- [x] Rover yaw closed-loop from the BNO085 game rotation vector (`yaw_control.py`, panel Manual/Auto)
- [x] BNO085 init failure diagnosed: handshake loops were rate-capped below the sensor's
      own report rate, so a sensor left streaming by a previous run starved them. Fixed in
      `bno085.py` (silence features first, drain to empty, handle oversized packets);
      reproduced and verified against a single-FIFO fake. `bno085_diag.py` added.
- [ ] Confirm on the rig with `python3 pi/sensors/bno085_diag.py`
- [ ] Network protocol (formal)
- [ ] Integration testing
- [ ] SAR image reconstruction

---

## Maintenance Rules

**This file and CLAUDE.md must be kept up to date by Claude (or any AI assistant)
as the project evolves.** Whenever a session produces key information — design
decisions, hardware discoveries, protocol specs, calibration data, wiring
pinouts, architectural changes, or anything a future session would need — update
these files before the session ends. They are the persistent memory of this
project across sessions, collaborators, and machines.
