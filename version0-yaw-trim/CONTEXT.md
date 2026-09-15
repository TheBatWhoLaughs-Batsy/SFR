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
- Sweep cores (`sweep_mode`, set with `pi/radar/set_sweep_mode.py`):
  - `nios` (default): the FPGA's Nios steps the synthesizers, the Pi receives the
    raw IQ and demodulates each step. ~36 Hz at 51 steps.
  - `dsp`: the FPGA steps the synthesizers from its own table and also mixes,
    averages and divides each step, so the Pi reads one small burst of finished
    `h_cal` values per sweep. ~100 Hz at 51 steps; 2..255 steps. Needs the v15
    image (`fpga/images/hostedxA9_niosIIf_sweep_dsp_v15_fifo256_signaltap.rbf`).
    See CLAUDE.md "On-FPGA DSP sweep path".
  - `standard`: host-driven retune per step over USB (~18 Hz), the fallback.

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

### Three heads (2026-09-15): forward = UART2, right = UART3, down = UART1

**The table above is the single-head wiring from 2026-08-24 and is now the RIGHT-facing
head.** The forward (radar standoff) head moved to UART2. Operator-confirmed wiring:

| Head | Points | Device | Overlay | GPIO (TX/RX) | Header pins |
|---|---|---|---|---|---|
| Forward (Z), **standoff** | forward | `/dev/ttyAMA2` | `uart2-pi5` | 4 / 5 | 7 / 29 |
| Right (X) | right | `/dev/ttyAMA3` | `uart3-pi5` | 8 / 9 | 24 / 21 |
| Down (Y) | down | `/dev/ttyAMA1` | `uart1-pi5` | 0 / 1 | 27 / 28 |

All three overlays are in `/boot/firmware/config.txt`. **UART1 uses GPIO 0/1, the HAT ID
EEPROM pins**: the firmware reads that EEPROM at boot only, so reusing them works (verified
on the Pi), but the HAT's ID EEPROM is unreadable once Linux is up.

`stream.py` opens one `lidar_poll_loop` per head (`--lidar-ports`, PRIMARY FIRST, default
`/dev/ttyAMA2,/dev/ttyAMA3,/dev/ttyAMA1`). The first port feeds the legacy `lidar_*`
fields, i.e. the standoff for SFCW/C-scan/SAR/BG model and the rover yaw controller. Every
head is also published under `lidars.uartN`, and `lidar_primary` names the first. A port
that fails to open is skipped with a warning. The Handheld panel's Wiring selectors must
agree with the primary for forward; the panel warns if they do not.

## Handheld Scan panel (2026-09-15)

Left-sidebar panel `handheldscan` ("Handheld Scan") — the C-scan workflow for the
HAND-CARRIED head. Nothing drives the head; the three-LiDAR position (`handheldPose`,
IMU-tilt-corrected) says which grid cell it is over, and a capture tags the SFCW
sweep-after-next as that cell.

Files: `lib/handheldScan.js` (pure geometry, unit-tested), `components/HandheldScanPanel.jsx`,
`components/HandheldScanDisplay.jsx`; wired through App.jsx / Sidebar.jsx / Viewport.jsx.

**Own state, isolated from C-scan.** `hhScanData` / `hhCaptureRef` are separate from the
rover/manual `bscanData` / `bscanCaptureRef`, so the two panels never collide. The sweep
handler's capture branch and `buildCellRecord` are reused, so records, colour scaling and
export are identical to C-scan and `buildCscanGrid` renders the plan view directly. Grid
coords are cscanGrid's (origin bottom-left, ix→right, iy→up, snake path, `grid_ix/iy`).

**Transport.** ▶ Start = sweep on (if it is not) AND auto-capture armed. ❚❚ Pause = disarm
only; the sweep stays up so resume is instant. ■ Stop = sweep off, any capture in flight
cancelled. Manual Capture works whenever the sweep runs, paused or not.

**Capture readiness** (`captureReadiness`), in order: origin set → position present → inside
grid → cell empty → forward-axis tilt ≤ 12° → head within the cell's centre zone
(min(15 mm, 40 % of the half-pitch + 2)). Each failure has a one-line reason on the panel.
**Auto-capture** fires after a 400 ms dwell over a ready cell; it is a `setTimeout` keyed on
the ready cell, not a per-render clock, so it does not depend on render cadence.

**Abort on move.** On every sweep of a capture in flight the handler re-checks the live pose:
if the head has left the tagged cell, or the position has dropped, the looks so far are
discarded (a smeared record under the wrong index is worse than no record). One low note;
the panel says why. Sweep stopping from anywhere also cancels an in-flight capture.

**Provenance per cell**, beside the C-scan fields: `hh_x_mm`, `hh_y_mm` (mean head position
over the looks), `hh_xy_std_mm` (how still the hand was — the aperture the coherent
average really covered), `hh_tilt_deg`. Each look also carries `hh_x_mm/hh_y_mm`.

**Recapture / Clear this cell** act on the cell under the head. Recapture drops the record
and tags the next sweep; a re-capture always REPLACES, never duplicates.

**Beep.** Two rising notes on capture, one low note on abort (Web Audio, default on) —
the operator's eyes are on the wall, not the screen. Panel also shows standoff (forward
LiDAR minus antenna offset, judged against 0–150 mm), forward tilt, per-head LiDAR status,
and aim arrows to the centre of the current (or next empty) cell.

Not wired: background subtraction in this panel's display (records carry the provenance, so
it adds the same way C-scan does it); projector; detection overlay. Deliberately left out.

## LiDAR → Antenna Offset (measured 2026-08-28)

**165 mm measured; 160 mm used** (5 mm buffer so a true zero-standoff pose reports
slightly positive). With the antenna aperture placed against the wall, the TF-LC02 reads
**164.83 mm ± 0.68**. Standoff = `lidar_reading − offset`, so real operation spans a lidar
reading of roughly **165–315 mm** for 0–150 mm of standoff.

**Re-measure after the 2026-09-15 three-head re-wire** — the standoff now comes from the
UART2 (forward) head, so if its mounting differs from the old single head this value is
wrong, and background models captured against the old head are referenced to a different
point on the module rather than merely stale.

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

### Steering: three modes (2026-09-12)

`pi/rover/yaw_control.py`. `rover_server.py` subscribes to the sensor stream
(`--sensors-url`, default `ws://127.0.0.1:9001`) for both `yaw_deg` and `lidar`.

| mode | feedback | fixes | cannot fix |
|---|---|---|---|
| `manual` | none | — | — |
| `heading` | IMU | travelling slanted | being on the **wrong line** |
| `track` | IMU + LiDAR | both | — |

**Why `track` exists.** Heading is unobservable in position. Holding heading keeps the
rover parallel, so any disturbance that shoves it sideways leaves it running perfectly
parallel along a *new*, permanently offset line. Observed on the rig; inherent, not a bug.
`track` cascades the LiDAR standoff into the heading reference:

    d_err = standoff − standoff_ref                     mm, + is too far
    psi   = clamp(−Kd·d_err·travel·s, ±psi_max)         deg, heading offset
    e     = wrap(yaw − (yaw_ref + psi))                 deg
    alpha = clamp(Kp·e·dir + bias)                      percent
    bias += Ki·e·dir·dt

Being too far becomes a small request to point at the wall, which the inner loop flies.
**`dir` appears twice, for different reasons**: inner, because the same alpha yaws the
chassis the opposite way in reverse; outer, because a given heading moves the rover
sideways the opposite way in reverse. Both automatic. The outer loop is **P-only on
purpose** — heading→lateral is an integrator, so P already drives the error to zero, and
a second integrator would fight the inner loop's `bias` for the same authority.

Simulated (6 passes, drift −2.5 %, 0.03° IMU noise, 8 mm LiDAR noise) — after a 40 mm
sideways shove: `heading` settles **75.5 mm** off the line and stays there; `track`
returns to **0.0 mm**. Kd sweep: 0.02–0.20 all converge; **0.05 is the default**.

**Degradation is deliberate.** Stale IMU → hold alpha, steer nothing. Stale or implausible
LiDAR → `track` silently behaves as `heading` (straight, not distance-corrected) rather
than steering on a bad range. LiDAR samples are deduped by `lidar_seq` (measurements, not
polls), gated to 40–2000 mm, EMA-filtered, and a single >120 mm jump is rejected unless
three in a row (then re-acquire).

**Two sign checks on the rig, one flag each, both in the panel.** Engage `heading`: if the
drift gets worse → `yaw_invert`. Engage `track` offset from the wall: if it drives away
from the target instead of back → `standoff_invert`. The simulation shows a wrong
standoff sign diverging from 260 mm to 489 mm in a single pass, so it is obvious, not
subtle.

Config: `yaw_kp/ki/invert`, `standoff_kd/max_deg/deadband_mm/invert/ref_mm`
(`standoff_ref_mm` 0 = capture on engage). Mode is a *command* (`rover_yaw_mode`), never
persisted — the references do not survive a restart either.

**Measured on the rig 2026-09-12:** open-loop needs −3 % right, −2 % left → a −2.5 %
reversing part (wheel mismatch) plus ±0.5 % non-reversing (floor/cable). The latter
accumulates across a raster, which is why the loops exist.

### Yaw trim (firmware 2.5.0, 2026-09-12)

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
| SDR control + IQ stream | 9003 | WebSocket | Pi ↔ Browser (sweeps as binary frames to the groundstation, JSON to other clients; see CLAUDE.md "binary sweep frames") |
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
- [x] On-FPGA DSP sweep path (`sweep_mode='dsp'`, v15 image, run on hardware 2026-09-14)
- [ ] Decide whether to flash v15 to SPI (flash still holds the v1 sweep image)
- [x] Rover firmware rewrite (ISR stepping, JSON protocol, E-stop, soft limits, calibration)
- [x] Rover jog control + position tracking from the controller's own step counter
- [x] Rover automated grid raster (drives the C-Scan panel's grid; Scan Mode = Rover)
- [x] Rover yaw trim — open-loop differential rear wheels, Pi-owned value, panel control (2.5.0)
- [x] Rover steering: `manual` / `heading` (IMU) / `track` (IMU + LiDAR cascade)
- [x] Handheld Scan panel — hand-carried C-scan, cells filled from the 3-LiDAR position
      (`lib/handheldScan.js`, `HandheldScanPanel/Display.jsx`); manual + dwell auto-capture
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
