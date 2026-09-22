# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

SFCW radar for within-wall imaging (rebar, pipes, voids, studs — not beyond the wall).
See CONTEXT.md for full system description.

## Key Facts

- This repo runs on TWO machines: Raspberry Pi (pi/) and PC (groundstation/)
- Clone the repo on both; run the appropriate code on each
- Pi never receives direct user input — all control via groundstation over LAN
- Heavy compute (SAR reconstruction, ML) belongs on the PC side
- Every subsystem must have a corresponding debug tool on groundstation

## Code Conventions

- Python for all Pi code (sensor drivers, radar control, networking)
- Python or TypeScript for groundstation (TBD based on UI framework choice)
- Shared protocol definitions in shared/protocols/
- Keep sensor interfaces minimal and async-friendly
- Prefer ZeroMQ or similar for IPC once protocol is chosen

## Hardware Context

- Raspberry Pi with AI HAT+ (Hailo-8L accelerator)
- LiDAR: TF-LC02 (UART, 115200 baud default) — **wired to `/dev/serial0`, not `/dev/ttyAMA0`.**
  On this Pi 5, `dtoverlay=uart0-pi5` (the GPIO14/15 header UART, `/boot/firmware/config.txt`)
  enumerates as `ttyAMA10`, which `/dev/serial0` symlinks to. `/dev/ttyAMA0` is a *different,
  always-present* PL011 UART used internally for Bluetooth (`hci_uart_bcm`) — it opens
  successfully with no error, so a driver defaulting to it doesn't crash, it just silently
  reads nothing forever. `pi/sensors/tflc02.py` `TFLC02.__init__` now defaults to
  `/dev/serial0`; don't change it back to `/dev/ttyAMA0`. The `config.txt` comment above the
  overlay line still says "creates /dev/ttyAMA0", which is wrong for the Pi 5 — go by
  `/dev/serial0` in code, not that comment.
- IMU: MPU-6500 (I2C, address 0x68)
- SDR: bladeRF (USB, use libbladeRF / pybladeRF)
- Antennas: 2x Vivaldi (wideband, one TX one RX)

**IMU failure must not take LiDAR streaming down with it (fixed 2026-08-24).**
`pi/sensors/stream.py` `sensor_loop()` used to construct `MPU6500()` *before*
`TFLC02()`. When the IMU isn't responding on the I2C bus (`OSError: [Errno 121]
Remote I/O error` — confirm with `i2cdetect -y 1`, address `0x68` absent), that
constructor throws and kills `sensor_loop` before the LiDAR is ever initialized —
so a dead/disconnected IMU presented as "the lidar isn't working" even though the
LiDAR wiring and driver were completely fine. `sensor_loop` now builds the LiDAR
first and wraps IMU init in try/except: on failure it logs a warning and streams
`accel`/`gyro`/`temp` as `null` while LiDAR keeps working normally. Keep this
independence — don't let either sensor's failure gate the other.

**Extended 2026-08-24: the per-iteration reads are guarded too.** Init-time protection
was not enough — an IMU that enumerates fine at startup can drop off the bus later, and
`MPU6500._read_raw` -> `read_i2c_block_data` then raises `OSError 121` on *every* loop
iteration. That exception escaped `sensor_loop`, hit `log_task_exception`, and called
`request_stop()` — killing the whole `stream.py` process, so port 9001 went dead and the
groundstation reconnect-looped. Symptom: LiDAR/standoff reads `—` in the SFCW, C-scan and
BG Model panels (they all share `App.jsx`'s `lidarMm`) and the sidebar's IMU Hz tile also
reads `—`, while the SDR panel on port 9003 keeps working normally — which looks like a
LiDAR bug but is the IMU killing the shared stream. `sensor_loop` now wraps the IMU read
in try/except (streaming nulls) and disables the IMU after `IMU_FAIL_LIMIT = 20`
consecutive failures, because each failing read costs an I2C timeout that would otherwise
throttle the LiDAR rate. The LiDAR read is guarded the same way.

**Diagnosing a missing standoff readout:** the sidebar's IMU Hz tile is on every panel and
tells the two cases apart. Hz blank -> the sensor stream (port 9001) is down, check
`stream.py`'s stdout on the Pi. Hz live but Standoff `—` -> the stream is up and
`read_distance()` is returning `None`, so it's the TF-LC02 path.
**Since 2026-09-11 you no longer have to guess which:** the packet carries `lidar_err`
naming the cause, and `stream.py` logs a dropout in plain words. See "LiDAR dropouts are
the SENSOR refusing to range" below -- do NOT start from the wiring again.

**LiDAR silent-serial investigation (2026-08-24), unresolved — needs a bench check, not
more code.** `read_distance()` returns `None` because the TF-LC02 gives back literally zero
bytes on `/dev/serial0` — confirmed both actively (sending the `55 AA 81 00 FA` query) and
passively (just listening for 3s with nothing sent), before *and* after a physical power
cycle of the LiDAR board. A powered TF-LC02 replies to something; total silence on both
fronts across a power cycle rules out a code/protocol bug and points at wiring/connector,
not firmware or timing. Two things already ruled out, don't re-check them: (1) the driver
protocol itself — byte-for-byte identical to a completely separate fork on this same machine
(`~/version-venom`, different GitHub remote), so it isn't a broken deviation from something
that used to work; (2) no lost/alternate C-level implementation exists anywhere — full git
history and a filesystem-wide search turned up nothing, the driver has only ever been this
Python file. Per CONTEXT.md, TF-LC02 VCC shares Pin 2 (5V) with the IMU — worth checking that
connection specifically since it's exactly the rail that would've been disturbed while
rewiring the IMU. Next step is physically checking the LiDAR's VCC/GND/TX/RX leads at the
Pi header, not another round of software changes.

**Voltage ruled out (2026-08-24).** Checked the bench wiring against the table above: VCC is
3.3V and *not* shared with the IMU, contrary to what the table previously claimed (fixed in
CONTEXT.md too) — but the TF-LC02 runs on 3.3V by design, and this exact connection was
already confirmed working before, so this is not a mis-wiring and not the cause of the
current silence. Back to square one on root cause: wiring (VCC/GND/TX/RX) is correct and
was previously functional, yet the module now gives zero bytes both actively and passively
across a power cycle. Worth checking next: whether the connector is fully seated (could have
been jarred loose during the IMU rework even though it's on different pins), continuity
along the full length of each lead (not just voltage presence) rather than just at the
header, physical damage to the module or leads from handling during the IMU swap, and
whether anything in `/boot/firmware/config.txt` (the `dtoverlay=uart0-pi5` line) regressed
since it last worked. Still a bench/hardware problem, not a code problem.

**Pi-side UART stack fully checked (2026-08-24) and ruled out.** `dtoverlay=uart0-pi5` intact
in `config.txt`, `/dev/serial0` -> `ttyAMA10` as expected, `dmesg` shows clean PL011 init with
no errors, nothing else has the port open (`lsof`), user is in `dialout`, and `pinctrl get
14,15` shows both correctly muxed to UART0 TXD0/RXD0 (`a4`, idle-high — normal resting state).
A live passive-listen + active-query test against `/dev/serial0` still returned 0 bytes both
ways. Everything software/OS-side on the Pi is healthy — this is now isolated to the module
itself or its TX/RX leads specifically (not VCC/GND, both already confirmed fine). Next step:
unplug the LiDAR and jumper the Pi's TX (pin 8) straight to RX (pin 10) for a bare loopback
test — if that echoes back what's sent, the Pi's UART is fully exonerated and the module/its
TX-RX leads are the remaining suspect (dead unit, or a lead nicked during the IMU rework).

**RESOLVED (2026-08-24): root cause was a dead UART0 receiver on this Pi's RP1 chip — not
the LiDAR module, not any wiring.** With a bare TX(pin 8)-RX(pin 10) short confirmed solid by
continuity meter, a raw GPIO bit-bang test (toggle GPIO14, read GPIO15 with both pins pulled
out of UART mode) passed perfectly — proving the pins and the physical short were both fine.
But a live UART0 loopback still returned 0 bytes, and `TIOCGICOUNT` (via `fcntl.ioctl`,
`0x545D`) showed why: `tx` incremented into the hundreds of thousands while streaming (real
transmit activity, confirmed independently by `/proc/interrupts` counting real IRQs on the
`uart-pl011` line), but `rx` stayed at exactly 0 with zero frame/overrun/parity errors —
not even noise, total silence on the receive side specifically. Cross-check: live-applying
a second UART (`sudo dtoverlay uart3-pi5`, no reboot needed, brings up `/dev/ttyAMA3` on
GPIO8/9 = physical pins 24/21) and shorting *those* pins instead gave a clean, byte-perfect
loopback (icount rx=5/tx=5 for 5 bytes sent) — so this is not a board-wide or software issue,
it's UART0's receive path specifically. **Fix shipped:** `uart0-pi5` disabled (commented, not
removed) and `uart3-pi5` made persistent in `config.txt`; `tflc02.py` `TFLC02.__init__`
now defaults to `/dev/ttyAMA3` (was `/dev/serial0`) — **the earlier instruction above to
default to `/dev/serial0` no longer applies now that UART0 is dead; don't move it back.**
**SUPERSEDED 2026-09-15: the forward (standoff) head is now on `/dev/ttyAMA2`** (three heads
were re-wired; see "Handheld panel" at the end of this file), so `TFLC02.__init__` and
`stream.py`'s `LIDAR_PORTS_DEFAULT[0]` default to it. UART0 is still dead.
LiDAR now wired to physical pins 24 (TX) / 21 (RX) instead of 8/10; VCC (3.3V, not shared
with the IMU — see above) and GND unchanged. Live-tested end to end afterward with clean,
stable readings.

**Also found and fixed while re-testing (2026-08-24): `read_distance()` ignored the
protocol's own error code.** The TF-LC02 response includes an `error_code` byte (offset 6)
that `_read_response()` computed but never checked — an invalid/no-return measurement comes
back as literal distance `8888` with `error_code=4`, and the old code returned `8888` as if
it were a real reading. Confirmed via `read_distance_with_error()` that ~30-40% of reads at
the test bench alternated between valid (`error_code=0`) and this invalid sentinel — normal
behavior for this class of sensor (weak/no return depending on target angle/reflectivity),
not a hardware fault. `_read_response()` now returns `None` when `error_code != 0`, so
callers see the same "no reading yet" signal they'd get from any other transient failure,
instead of a spurious 8.888 m jump in the standoff display.

**IMU was a red herring the whole time — it simply wasn't physically connected.** After the
LiDAR fix, `i2cdetect -y 1` showed nothing at any address, matching CONTEXT.md's existing
note that the BNO085's VCC/GND pins were never confirmed after the chip swap. User checked
the bench and confirmed the BNO085 breakout was not plugged in at all. Once connected, it
enumerates at `0x4A` as documented and streams real accel/gyro data (verified live: resting
pose read `up ≈ 1.0g`, matching the axis-remap calibration check above). The original theory
that started this whole investigation — IMU and LiDAR sharing a 5V rail, one dragging the
other down — was wrong on every count: LiDAR VCC turned out to be 3.3V and not shared with
the IMU at all, and the two failures were completely unrelated (one a dead UART peripheral,
the other a bench cable never plugged back in).

**IMU hardware swap (2026-08-24): MPU-6500 -> BNO085. Driver shipped, axis calibration
still pending.** `mpu6500.py` is deleted (confirmed nothing else imported it); `pi/sensors/
bno085.py` is the new driver, wired into `stream.py` in place of it. BNO085 lives at I2C
`0x4A` (was `0x68` for the MPU-6500) and speaks SHTP over I2C, not simple register
read/write — a hand-rolled raw driver on `smbus2`/`i2c_msg`, matching this repo's other
sensor drivers (no framework dependency). `adafruit-circuitpython-bno08x` +
`adafruit-blinka` are installed on the Pi (`pip3 install --break-system-packages`, not in
`requirements.txt`) from cross-checking the protocol during bring-up; not used by the
shipped driver, safe to leave installed or remove.

**Bring-up history, useful if this ever needs debugging again:** initially every
`SET_FEATURE_COMMAND` (enable accelerometer/gyroscope/rotation vector) got zero response
while Product ID queries worked fine — the classic signature of the SH-2 application
firmware not running (stuck in bootloader/reduced mode). Ruled out corrected per-channel TX
sequence numbers (adafruit's library conflates host-TX/device-RX sequence counters into one
list — a real bug, see its `__init__.py` `_sequence_number` TODO — but not the cause here),
long settle times, full channel drains. **Fixed by power-cycling the board** — confirms it
really was a firmware-not-running state, not a protocol bug. If this regresses, power-cycle
before re-chasing protocol theories.

Packet shape (`accel`/`gyro`/`temp` fields, same consumers) is unchanged from the MPU-6500
era rather than switching to the chip's onboard sensor fusion (rotation vector) — smaller
blast radius, `imu_calibration.py`'s axis remap and the groundstation's Madgwick filter in
`ImuDisplay.jsx` keep working unmodified. `bno085.py` converts the calibrated accelerometer
report (m/s^2, Q8) to g (÷9.80665) and gyroscope report (rad/s, Q9) to deg/s (×180/π), so
nothing downstream needed to change for units. BNO085's SH-2 report set has no plain
temperature report — `temp` streams `null` for this driver, which every consumer already
handles gracefully (see the null-accel `ImuDisplay.jsx` crash fixed the same day).

**Fixed (2026-08-24) after TWO rounds of live testing: `imu_calibration.py`'s R_ACCEL/R_GYRO
axis remap for the BNO085.** Round 1's fix (a simple X<->Y swap, reasoned from the gravity
measurement + "pitch reads as yaw") was WRONG on its own terms — round 2's live feedback
was "pitch and roll are now swapped," meaning the true axis identity is a full relabeling of
all three raw axes, not the two-axis swap round 1 assumed:
  raw X -> roll axis (forward), raw Z -> pitch axis (left), raw Y -> yaw axis (up)
This resolves self-consistently: yaw was never reported wrong across either round, so raw Y
= up = yaw axis stands throughout (also matches the direct gravity measurement). Current
`R_GYRO`: `roll = -gyro_x, pitch = +gyro_z, yaw = +gyro_y`. **`R_ACCEL`'s forward/left rows
are inferred, not independently measured** — set equal to `R_GYRO`'s rows on the reasoning
that BNO085's SH-2 reports are documented to share one common sensor frame across
accel/gyro/mag (true for this chip, was NOT true for the MPU-6500 — its original R_ACCEL and
R_GYRO were genuinely different matrices, so don't assume this equivalence generalizes to
other hardware without checking). Verified: fresh calibration + resting pose gives
`up ≈ 1.0g, forward ≈ 0, left ≈ 0`.

**If a third round of "X is now swapped with Y" feedback comes in, stop patching
incrementally and ask for a full walk-through instead** (rotate slowly through each of
roll/pitch/yaw individually, one at a time, reporting the sign and which body-frame value
actually moves for each) — two rounds of partial feedback already produced one wrong
intermediate fix (round 1's swap), and a third partial round risks the same. A single
complete pass pins all three axes and their signs at once instead of iterating on which pair
is currently swapped.

**Testing trap: don't use "does the resting pose look level" as a check that the axis
remap is fine — it's a false negative for detecting a *remaining* problem,** even though it
correctly reproduces `up ≈ 1g` for whichever mapping is currently in place (round 1's WRONG
mapping also passed this exact check). `auto_calibrate` reruns on every `stream.py` startup
and its accel-bias step subtracts whatever the raw reading was *at that moment* from the
expected-gravity vector — calibrating and then immediately reading the *same* static pose
cancels out any remaining wrong-axis error, "up" reads ~1g regardless of whether R_ACCEL is
actually correct. The only real test is dynamic: tilt the board through a known roll/pitch/
yaw and see if the *reported* axis and *sign* match the *physical* motion — same as the
original MPU-6500 discovery procedure, and the only thing that's actually caught a problem
so far in this whole BNO085 remap effort.

**Fixed: BNO085's report backlog could hang `calibrate_gyro_bias` indefinitely.** Initial
`bno085.py` used a 128-byte read buffer and 10ms/100Hz report intervals for both
accelerometer and gyroscope. Each I2C read transaction has real cost regardless of whether
data is pending -- measured 12ms for a 128-byte read on this Pi's I2C bus, vs. 3.2ms at 32
bytes -- and the BNO085 pushes reports on its own schedule whether or not the host is
draining them. At 100Hz+100Hz combined against ~12ms/read, `read_all()`'s drain loop could
never catch up: every call hit its 32-read cap, batched packets grew past the 128-byte
buffer and got silently truncated, and `calibrate_gyro_bias`'s 200Hz sampling loop (400
samples, meant to take 2s) didn't finish within 20s in testing. Fixed by cutting the read
buffer to 48 bytes and both report intervals to 20ms/50Hz (matching `stream.py`'s default
loop rate) -- confirmed steady-state `read_all()` now does 3-5 reads per call, never near
the cap, and calibration completes in ~2s as intended. If report intervals ever need to
drop for a smoother display, drop the per-call read cap first and re-measure steady-state
read count before assuming it's fine -- don't just lower the interval and move on.

**Fixed (2026-08-24): the whole sensor stream was capped at ~7-10Hz by the dead LiDAR,
not by the BNO085 swap.** `TFLC02.read_distance()` blocks on a 100ms UART timeout when the
sensor doesn't answer (measured directly: every call took exactly ~100ms while the LiDAR
issue above was unresolved), and `sensor_loop` used to `await` it inline in the same loop
that reads the IMU and broadcasts -- so a silent LiDAR throttled the *entire* stream to
~1/0.1s = 10Hz regardless of the `--rate` flag, IMU included. This was reported as "the IMU
feels choppy, worse than the MPU" -- plausible red herring, since the MPU-6500 setup was
presumably running while the LiDAR still answered quickly, so the same blocking-inline
pattern never showed up as a problem. `sensor_loop` now runs `imu_poll_loop` and
`lidar_poll_loop` as separate background tasks, each polling its sensor in its own uncapped
loop via `run_in_executor` and publishing the latest reading into a shared dict; the
broadcast loop just reads those dicts and never awaits either sensor directly. Verified: a
still-unresponsive LiDAR (100ms/read, unchanged) no longer affects IMU rate at all --
measured 48-48.7Hz broadcast throughput at `--rate 50`, up from 7.67Hz before this fix. This
also means the stream will keep running at full rate once the LiDAR hardware issue above is
eventually fixed, not just work around it today.

**bladeRF total-sample-throughput warnings explained (2026-08-24).** The
`check_total_sample_rate` warning in libbladeRF sums each active channel's *actual* achieved
sample rate (`bladerf2.c` reads it back via `get_sample_rate`), not the rate Python
requested. `bladerf_driver.py` `_configure_channels_dual()` was calling
`bladerf_set_sample_rate(..., ffi.NULL)` for the `actual` out-param — silently discarding
whether the RFIC's clock/decimation chain rounded the requested rate to something else.
SFCW's `_configure_hardware()` requests 10 Msps; the observed warning math (92.16 / 3
channels, 122.88 / 4 channels) both divide out to exactly 30.72 Msps per channel, so that's
almost certainly what the hardware actually snapped to. Fixed by capturing `actual` (both in
the raw-ffi dual-channel path and by reading back `Channel.sample_rate` after the
Python-wrapped single-channel sets) and logging a `[bladerf] NOTE: <ch> sample rate snapped
to X Msps (requested Y Msps)` line when it differs — visibility only, no behavior change, so
it's safe without live hardware to test against. **The 30.72 Msps hypothesis is now
FALSIFIED (measured on hardware 2026-08-28).** Calling `bladerf_set_sample_rate(..., actual)`
for 10 Msps on all four channels (RX0/RX1/TX0/TX1) returns `rc=0` with
`actual = 10.000000 Msps` on every one — the RFIC hits the requested rate exactly and does
not snap. So whatever produced the 92.16 / 122.88 warning totals, it was not SFCW's 10 Msps
request being silently rounded to 30.72. Dual-channel RX at 10 Msps also streams cleanly
(60/60 buffers, no timeouts), so sweep-time and RX-timeout problems should not be blamed on
sample-rate snapping — see the FPGA tuning-mode section below for what actually caused the
RX timeouts. Actually eliminating the warning (picking a request rate
the RFIC can hit exactly, e.g. a rate near the well-known 30.72 Msps LTE-grid family) needs
live-hardware validation before changing — RF gain/timing code in this repo has a history of
regressions from unverified changes (see the `settle_count`/`num_buffers` regressions
above), so don't just guess a lower rate to silence it without testing on the bench.
The `[INFO @ .../version.c]` firmware/FPGA-newer-than-compatibility-table lines are harmless
and expected — libbladeRF's bundled compatibility table just lags the flashed firmware/FPGA
versions; ignore them, don't chase a libbladeRF upgrade just to silence an INFO line.

## LiDAR dropouts are the SENSOR refusing to range, not the link (2026-09-11)

Reported as "random issues with the lidar sometimes not working", and separately as
"running long c scans, randomly the lidar data stops and I get those scans with the x
mark". Both are one fault, now measured and now self-reporting.

### What it is

**The module answers every single command and reports a non-zero `error_code`.** Measured
live on the bench: over 30 s, 16.9% of reads failed, **every one of them sensor-reported,
with zero link failures**. The UART underneath is spotless --
`TIOCGICOUNT` on `/dev/ttyAMA3` (read without consuming bytes, alongside a running
`stream.py`) gives **888 B/s TX = 177.6 commands/s against 1423 B/s RX = 177.9 replies/s,
a clean 1:1, and 0 frame / parity / overrun / break / buf_overrun over 100 s.**

So this is a SIGHTING problem -- target range, angle, reflectivity, ambient IR -- and the
fix is to aim the head, not to re-check cables. **Do not re-run the 2026-08-24 wiring
investigation.** That one was real and is fully resolved (dead UART0 receiver); this is a
different failure with the same symptom, and the two were indistinguishable until now.

The dropouts are **total and long**: runs of 9.0 s, 22.3 s, 2.4 s and 1.1 s were caught,
all self-recovering, against 420 s and 180 s windows elsewhere with none at all. They are
condition-dependent, which is exactly why they read as "random".

### The error code is a BITFIELD, and blackouts raise bits ordinary misses do not

Codes observed: **4, 6, 20, 22, 52, 54, 128**. They decompose cleanly into bits --
4 = bit2, 6 = bits1+2, 20 = bits2+4, 22 = bits1+2+4, 52 = bits2+4+5, 54 = bits1+2+4+5,
128 = bit7 alone. So it is a flags register, not an enum, and `error_code != 0` is throwing
away the only information that separates the two regimes:

| | codes |
|---|---|
| ordinary scattered misses (blackout-free windows) | almost entirely **`sensor:4`**, occasionally `128` |
| a real blackout | **`4` + `6` + `20` + `22` together, in the hundreds** |

**Bits 1, 4 and 5 essentially only appear during a sustained out-of-range run**, while an
isolated miss is almost always bare `4`. Useful as a signature, but note BOTH carry 8888
(see below), so the difference is in how the module grades its own failure, not in whether
a measurement was available.

**ROOT CAUSE, settled by a raw probe: the target is simply OUT OF RANGE, and the module
says so with a literal distance of 8888.** Driving the driver directly (stream.py stopped)
while the module was pointed across a room:

| code | reads | distance returned |
|---|---|---|
| 0 | 5,947 | 288-404 mm, real |
| 4 / 6 / 20 / 22 / 54 | 33,825 | **ALL exactly 8888, without exception** |

and a separate 70 s run held at ~300 mm gave **37,211 reads, 100% `error_code 0`, zero
failures** -- at 531 reads/s, i.e. three times harder than `stream.py` polls. So:

- **Nothing usable is being discarded.** Every rejected read carried the 8888 sentinel, so
  the 2026-08-24 decision to reject on `error_code != 0` costs no measurements. Returning
  8888 would put the standoff at 8.888 m and destroy any BG model.
- **Short range is flawless and hammering it is harmless.** Poll rate is exonerated; the
  `--lidar-rate` A/B below is no longer worth running.
- **A "blackout" is not a fault at all.** It is a healthy module reporting that the target
  is beyond what it can measure. Runs of 41.6 s, 16 s and 14.4 s were logged while the
  module was waved around a room.

**An EARLIER ENTRY IN THIS SECTION CLAIMED RANGE WAS FALSIFIED AS THE TRIGGER. THAT WAS
WRONG** and is corrected here. It rested on a 180 s window that swept 31-847 mm with no
blackout -- but that window simply never exceeded the module's reach. 847 mm is inside it;
a room is not. The reach is not a fixed number: it depends on the target's reflectivity and
angle, which is why a bright surface at 850 mm reads fine and a far wall does not.

Operationally this means the blackouts seen while hand-waving are EXPECTED and say nothing
about a scan. During a real C-scan the standoff is 130-400 mm, where the module is
measurably perfect -- so **X marks appearing in an actual raster are far more likely to be
the transport fault below than the sensor.**

`read_distance_detail()` therefore reports `oor:<code>` (distance was 8888) separately from
`sensor:<code>` (non-zero code with a plausible distance -- never yet observed) and
`link:*`, via `is_out_of_range_reason()`. The dropout log names it in words: *"target OUT OF
RANGE -- the module is working and returns its 8888 sentinel"*. The distinction matters
because the operator reported the old 8888-passthrough as "way more responsive and
predictable" -- the information it carried was real, and suppressing the VALUE without
surfacing the FACT is what made a working sensor look broken.

### Why it produces the red X, and why only sometimes

`lidar_standoff_mm` goes null after `LIDAR_CARRY_MS` (1 s) of CONTINUOUS failure. Every
cell captured from then on records a null standoff, and `backgroundFor()` in `bscanBg.js`
returns `BG_STATUS.NO_STANDOFF` -> drawn as a red cross on dark red, excluded from both
colour scales. A 9-22 s dropout is several cells, mid-raster.

**It only happens under a BG MODEL.** A captured reference and Super Fit do not consume
standoff at all, so the identical cells subtract normally in those modes -- which is what
makes it look intermittent and mode-dependent. Two neighbours worth knowing: **SAR does
NOT flag these cells**, it fills them with the median standoff (`sar.worker.js`), so a
dropout degrades SAR quietly rather than visibly; and continuous BG capture refuses to
interpolate across a gap > `MAX_BRACKET_GAP_S`, so a dropout silently thins the run.

### The reason a failure now has a reason

`read_distance()` collapsed FIVE distinct failures into a bare `None` -- timeout, no
header, short frame, bad footer, bad opcode, and `error_code != 0`. Nothing in the system
could tell "the module cannot see the target" from "the module is dead", which is why the
last investigation spent days on cables. `read_distance_with_error()` existed and was
never called.

`tflc02.py` now has ONE parse path (`_read_response` returns `(dist, error_code, reason)`)
with `read_distance()` / `read_distance_detail()` / `read_distance_with_error()` as thin
wrappers -- the two hand-copied parsers it used to carry were the same drift hazard this
repo already records for CFAR and the SAFT kernel. Reasons split into two classes that
demand opposite responses: `sensor:<n>` (module answered; aim/range/reflectivity) and
`link:*` (module did not answer; power/wiring/baud), separated by `is_link_reason()`.

On the wire, additively (a groundstation that predates them ignores them):
`lidar_err`, `lidar_last_good_mm`, `lidar_last_good_age_s`.

**`stream.py` logs a dropout in plain words**, and the rate-limiting is the load-bearing
part. Nothing is printed below `LIDAR_DROPOUT_WARN_S = 1.0 s` of CONTINUOUS failure --
that is not a round number, it is exactly `LIDAR_CARRY_MS` in `App.jsx`, i.e. the moment
the standoff actually goes null and cells actually start rendering invalid, so every line
printed corresponds to something the operator is about to see. A persisting dropout
repeats only every `LIDAR_DROPOUT_REPEAT_S = 15 s`. Verified head-first (15 checks, fake
clock, scripted sensor): a healthy stream and a **40%-scattered-invalid stream are both
completely silent**, a sustained dropout prints exactly one warning naming the dominant
reason and one recovery line with the duration, and a 60 s dropout prints 3-6 lines rather
than 12,000. That silence is the point -- a recurring benign line is what trained the
operator to ignore the `_sweep_core` 2-tuple error for weeks.

### Also fixed: the accumulators grew for as long as the tab was open

`lidarAccumRef` / `poseAccumRef` in `App.jsx` were cleared ONLY inside the `sfcw_result`
handler, so with no sweep running they grew at the measurement rate indefinitely. Besides
the leak, **the first sweep of the next session got a standoff averaged over the entire
idle period** -- over wherever the head was while being carried into place -- reported with
an `lidar_n` in the thousands, which makes it look exceptionally well measured. Entries are
now `{mm, t}`, filtered to `ACCUM_WINDOW_MS = 2000` before a sweep reads them and pruned at
`ACCUM_PRUNE_AT = 512` so an idle tab cannot accumulate. 2 s is generous on purpose: the
job is to exclude the idle period, not to trim a slow sweep, and a 2 s-old reading is
already past the age at which App calls the standoff stale.

### A SECOND, independent cause of the same X marks: one slow client froze the stream

**This is the one that produces a "LiDAR blackout" with a perfectly healthy LiDAR, and it
is now FIXED.** `stream.py`'s broadcast was `await gather(*(c.send(msg) for c in clients))`
with no timeout -- the same slow-client bug already fixed in `sdr_server.py`
(`_send_to_all`) and `rover_server.py` (`_fanout`), left latent here because this file's
gather happened to be safe from the *other* half of that bug (the set-mutation
RuntimeError).

Measured 2026-09-11 against the shipped server, one client that never reads:

| | healthy client alongside it |
|---|---|
| before | 34.0 Hz, worst gap **10,000 ms**, 3 gaps > 1 s in 40 s |
| after `BROADCAST_TIMEOUT_S = 0.5` | 47.8 Hz, worst gap **503 ms**, 0 gaps > 1 s |

A 50 ms-per-packet stall alone (not a full stop) already cost 48.6 -> 36.5 Hz. The residual
503 ms is exactly the one frame that hits the timeout before the client is dropped.

**How this was caught, and the lesson: the Pi log and the UI disagreed.** The operator
reported repeated 5-10 s freezes of the standoff readout with the warning line showing,
over a 12-minute period in which `stream.log` recorded **zero** dropout lines and a
180 s capture measured 0.3% null over 31-847 mm. A LiDAR fault cannot be invisible to the
sensor's own log; a transport fault is invisible to it by construction. **Whenever the UI
says the LiDAR is out and the Pi log is silent, it is not the LiDAR.**

**Contributing factor worth checking on any repeat: how many clients are actually
attached.** `ss -tn | grep :9001` during the incident showed **six** connections from three
machines -- three from one host, plus two in FIN-WAIT-2 (tabs closed without completing the
close, which the 20 s keepalive had not yet reaped) and one with 504 bytes backed up in
Send-Q. Note `rover_server.py` is NOT among them: it never connects to 9001. But each
browser tab opens THREE sockets (9001 sensor, 9002 rover, 9003 SDR) drained by the SAME
main thread, so rover-panel rendering competes with draining the LiDAR socket -- which is
worst during a rover-driven C-scan, exactly when the X marks were reported.

### THE ACTUAL CAUSE of random X marks in a real C-scan: staleness was timed on the BROWSER clock

This is the one that matches the operator's real complaint -- *"C-scans at a near-constant
range of around 200 mm, random cross marks, sometimes rare, sometimes quite frequent"* --
and it is neither of the two above. At 200 mm the sensor is measurably perfect (37,211
consecutive reads at 300 mm, 100% valid, and the module's cadence is FASTEST at short
range), so a null standoff there could never have been the LiDAR.

`App.jsx` decided whether to carry the last reading forward with

    (performance.now() - fresh.t) < LIDAR_CARRY_MS

where `fresh.t` was also `performance.now()`, stamped when the browser got around to
HANDLING the lidar packet. **Both ends were the browser's own scheduling clock, so the test
measured how busy the main thread was, not how old the measurement was.** Any stall past
1 s -- the 4 Hz live-flush derive chain is 32-52 ms per pass over a few hundred cells,
`bscanData` reaches tens of MB, and GC pauses are real -- made every reading look stale the
instant the thread resumed. The sweep landing in that window recorded a null standoff and
its cell rendered INVALID.

That explains every part of the report that the sensor theory could not:
- **constant 200 mm** -- irrelevant, the test never looked at the sensor;
- **random** -- it tracks browser load, not anything physical;
- **"sometimes rare, sometimes quite frequent"** -- the derive chain cost scales with cell
  count, so a big or long-running grid stalls more often than a small one.

Both quantities are already available on the **Pi's** clock -- `lidar_ts` (stamped when the
measurement appeared) and `sfcw_result.timestamp` -- and they are the same `time.time()`,
the pairing `bgContinuous.js` already depends on. The age is now computed from those, with
the browser clock kept only as a fallback for a Pi that sends no `lidar_ts`. Verified by
extracting the SHIPPED expression out of `App.jsx` and driving it (11 checks): a 3 s browser
stall now carries correctly, a genuine 3 s sensor outage still goes null, a measurement
stamped after its sweep is refused rather than treated as infinitely fresh, and the fallback
path behaves as before.

**The general lesson, which this repo keeps relearning: an instrument fed from a throttled,
decimated or re-timed copy of the data reports on the copy.** Same class as `lidar_seq`
counting reads rather than measurements, and as the SFCW header reporting the throttled
display rate as the radar's sweep rate.

Note the send timeout above stops one stalled client taking the others down, but it was
never going to fix this: the stalling client and the scanning tab are the same tab.

The two causes are now distinguishable, which is the practical payoff of the logging:

- **runs of adjacent invalid cells + a `no valid LiDAR reading for N s` line in the Pi log**
  -> the sensor could not range. Re-aim.
- **isolated invalid cells and the Pi log SILENT** -> the browser stalled. Nothing is wrong
  with the LiDAR.

### What to do about the blackouts themselves

The instrumentation names the cause; it does not stop it, and the physical trigger is not
yet known (see above -- range is ruled out). **Before the next long C-scan, watch
`stream.log` for a minute:** a low steady `sensor:4` rate is normal and harmless; a run
past 1 s now announces itself and is the cue to re-aim rather than to scan.

**The poll-rate hypothesis is dead, do not spend time on it.** The idea was that adaptive
integration (17.2 Hz at 165 mm falling to 11.5 Hz at 340 mm) might never complete against a
command every 5.6 ms. Measured: 37,211 consecutive reads at **531/s** with **zero** failures
at 300 mm. Polling hard does not break it.

## Living Documentation Rule

CLAUDE.md and CONTEXT.md are living documents. Whenever you learn key information
worth persisting — new design decisions, hardware findings, protocol choices,
calibration values, architectural changes, or anything a future session would
need to know — update CLAUDE.md and/or CONTEXT.md immediately. Don't wait to be
asked. These files are how context survives across sessions and collaborators.

## Current Phase

IMU, LiDAR, and bladeRF SDR integrated. All stream to groundstation debug panels.
RF Calib panel provides signal generator + oscilloscope for bladeRF calibration — always
runs both channels (antenna TX1/RX1 + reference TX2/RX2 loopback) simultaneously, viewport
split left (antenna) / right (reference) for both TX and RX.
SFCW panel performs stepped-frequency sweeps (2–5 GHz, hard-bounded by the quick-tune master
table's 256-profile hardware ceiling — see Quick-tune master table below) with range profile
+ waterfall display.
Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.
C-scan panel rasters a 2D grid of positions over the target and shares the SFCW panel's
background model machinery (see below). It rasters either by hand or automatically via the
rover gantry — see "Rover-driven C-scan raster".
Rover Scan panel drives the 2-axis stepper gantry (continuous jog, nudge, calibration,
live position from the controller's own step counter) — see below. The automated grid
raster on top of it lives in the C-Scan panel's Rover scan mode, not here.
Imaging Bench panel replays an exported waterfall snapshot through 11 selectable imaging
effects for offline A/B of processing chains — see below.

## SFCW Amplitude Scaling (Dynamic / Manual)

The SFCW panel carries an `sfcwScaleRange = { dynamic, min, max, isDb }` (App.jsx), the
same shape the C-scan panel uses for its colour scale. Dynamic (the default) is the old
behaviour: the range profile's Y axis tracks session-wide extremes and the waterfall's
colour range tracks its visible history. Manual pins **both** panes to one pair of limits.

Seeding matters: the live limits are computed inside `SfcwDisplay`, not the panel, so the
display publishes them every frame through `onDynamicScale` into an App-level **ref**
(`sfcwDynamicScale`) — a ref, not state, so a 3–6 Hz sweep does not re-render the sidebar.
The panel reads it via `getDynamicScale()` at the moment the toggle is clicked, so switching
to manual never makes the colours or the axis jump.

`isDb` records which units the pinned numbers are in. Flipping the display's dB/LIN button
(or "Reset Scale") hands the scale back to dynamic, because dB limits are meaningless on a
linear trace. Panes flag a pinned scale with an amber `MANUAL` next to their title, and the
waterfall's colour-bar numbers turn amber too.

The other two `SfcwDisplay` instances (C-scan and BG Model live sweep) pass no `scaleRange`
and stay dynamic — `manual` is false whenever the prop is absent.

## Background Subtraction — Groundstation Only (SFCW + B-scan)

All background subtraction happens on the groundstation. The Pi ships raw `h_cal`,
holds no background state, and has no notion of a B-scan at all. These commands no
longer exist: `sfcw_capture_bg`, `sfcw_clear_bg`, `sfcw_bg_mode`, `bscan_clear_bg`,
`bscan_capture`, `bscan_bg_capture`, `bgmodel_capture`. Every "capture" now works by
tagging the next `sfcw_result` to arrive, groundstation-side, with a ref flag.

Both panels offer the same two mutually exclusive sources:
- **Captured reference** — "Capture BG" tags the next sweep as `sfcwBgRef` / `bscanBgRef`.
- **ML model** — "Load Model" infers a background from lidar standoff (`bgModelInfer.js`).

Selecting either clears the other; "Clear BG" clears both. Subtraction is always complex
(vector) — the old complex/magnitude toggle is gone, complex was the default and is now
the only mode.

- SFCW live display: `App.jsx` `processedSfcwResult`.
- C-scan: `lib/bscanBg.js` `applyBscanBg()`, shared by `processedBscanData` (C-scan +
  2D Map), `sarProcessedData` (SAR), and `alignedSvdData` (Aligned).

**The model path is strictly better for B-scans.** A captured reference is only valid
near the standoff it was taken at, so B-scan positions are corrected by phase-aligning
it with the lidar standoff difference — a fudge that degrades as the hand-held standoff
drifts. A model is evaluated at *each position's own* standoff, so no alignment is
needed and it stays valid across the whole captured span. Outside that span the Akima
interpolator clamps, so the panel flags standoffs beyond the model's `d` range.

The Aligned panel subtracts first and rotates the residual to the common reference
position. That is identical to rotating both and subtracting (the alignment ramp is a
common factor) and it lets the model see each position's true standoff.

**Why groundstation-side:** Pi-side subtraction ran before transmission, so it silently
contaminated B-scan captures, SAR, and BG-model *training* data, which all read
`msg.h_cal_*`. Keeping the wire raw means only the live display is affected.

Note `SfcwDisplay` recomputes its own range profile from `h_cal_real/imag` for
windowing/range-comp, so any subtraction must write back into those fields — replacing
only `magnitudes`/`distances` gets silently discarded. `applyBscanBg` does this.

**Removed from the panel:** the SVD filter (the Aligned, SAR and 2D Map panels
keep their own; `lib/svd.js` stays) and the Wall section. Wall standoff / thickness /
permittivity were never doing refraction work in practice — εr defaulted to 1, so the
distance correction was the identity and the only live effect was capping display depth
at the wall thickness. That became a single `maxDepth` field under Display, used by both
`BscanDisplay` and `sar.worker.js` — and was split apart again on 2026-08-31, because those
two uses had nothing to do with each other: the display clipping is gone and the
reconstruction depth moved to the SAR panel. See the C-scan imaging section below. Export is
v6 (see the C-scan section); import still reads v3 and maps the old `wallThickness` onto
SAR's depth.
Pi-side architecture: bladerf_driver.py (HAL) → sfcw_engine.py (sweep logic) → sdr_server.py (WebSocket).

**SFCW params are pushed groundstation → Pi, never read back.** The engine carries its
own defaults, and `sfcw_set_params` used to be sent only from a panel field's `onChange`,
so a fresh page load left the Pi sweeping at its defaults while the panel displayed and
derived everything (step count, sweep time, max range) from different ones. `App.jsx`
`sendSfcwParams()` now pushes the full set on SDR connect and again before every
`sfcw_start` (all three start paths: both `App.jsx` handlers and the panel's own toggle).
The panel is the source of truth; keep new SFCW params in that payload or they will not
reach the Pi.
Next steps: SAR reconstruction integration.

## Rover steering: yaw trim + closed loop (ported from `moving_stuff`, 2026-09-13)

`pi/rover/yaw_control.py`, `rover_server.py`'s yaw plumbing, the panel's Steering
Trim section, and firmware yaw trim. The rover has one driven front wheel and two
driven rear wheels on separate axles; **nothing steers**. The chassis yaws when the
rear pair run at different rates, and that is the only steering authority there is.
Full description in CONTEXT.md ("Steering: three modes" and "Yaw trim").

Three modes, each strictly more capable: `manual` (a number the operator tuned by
eye), `heading` (hold the BNO085 heading — fixes travelling SLANTED), `track`
(cascade the LiDAR standoff into the heading reference — also fixes being on the
wrong LINE). Mode is a **command, never persisted**, because the references do not
survive a restart either; the gains are config and are.

**Heading hold cannot recover the line, and that is inherent, not a bug.** Heading is
unobservable in position, so a disturbance that shoves the rover sideways leaves it
running perfectly parallel along a new, permanently offset line. Reproduced here in
simulation: shoved 80 mm off with the heading already correct and no drift at all,
`heading` sits at 280.0 mm for 60 s and never moves; `track` returns to 202.7 mm.
That is the whole reason `track` exists — do not "fix" heading mode to close it.

### What this branch's firmware is, and the lineage trap

**There are two divergent `rover.ino` lineages and this branch carries a THIRD that
is the merge of them.** Do not resolve this by blind checkout in either direction.

- **`rover/` here = firmware 2.5.0 = 2.0.0 (the network recovery ladder,
  `serviceNetwork()` / gateway ping / self-reboot / `test_net.cpp`) + yaw trim + the
  2026-09-12 wiring.**
- **`moving_stuff`'s `rover/` = 2.4.1**, which is the same yaw trim on a 2.0.0 that
  has **no** ladder — it has `ensureLinkHealth()` instead, and it deletes
  `test_net.cpp` and `rover/test/netstubs/`. Taking that commit wholesale would have
  reverted the network work this repo's own "The board could never rejoin the network"
  section records, and dropped the only harness that can test a liveness property.
- What was ported across is exactly: the yaw trim (ISR, `setYawTrim`, `yaw` in
  `cfg`/`hello`/`status`, the `trim` command), the per-wheel `H_INVERT_*` direction
  flags, the pin map and `V_DIR_INVERT` **as set on the rig 2026-09-12**, and
  `RX_BUFFER_SIZE` 256 -> 320. Nothing networking-related moved.
- **`RX_BUFFER_SIZE` and the Pi's `BOARD_RX_LIMIT` must agree** (both 320). The `cfg`
  grew a `yaw` field and a worst-case `cfg` is now 264 bytes; over the limit the board
  rejects it silently apart from one line in its log — and `cfg` is what carries the
  **soft limits**, which on a rig with no endstops are the backstop.

### Signs: two flags, and the defaults are consistent with the documented conventions

`+alpha` turns the nose RIGHT (`rover/config.h`) and `bno085.yaw_deg` is CCW-positive,
so `+alpha` must DECREASE `yaw_deg`. Checked in simulation: with the plant built from
those two documented conventions the shipped defaults (`yaw_invert` false) converge,
and `yaw_invert` true diverges to +185 deg in 20 s where open loop reaches only +12.
So a wrong sign is loud, not subtle — which is what the panel's "if the drift gets
WORSE, flip it" instruction relies on. **Still verify both signs on the rig**; the
simulation validates the arithmetic, not the wiring.

`dir` appears TWICE in the control law for different reasons — inner loop because the
same alpha yaws the chassis the opposite way in reverse, outer loop because a given
heading moves the rover sideways the opposite way in reverse. Both automatic.

The outer loop is **P-only on purpose**: heading -> lateral position is an integrator,
so P already drives standoff error to zero at equilibrium, and a second integrator
would only fight the inner loop's `bias` for authority over the same steady state.

### Degradation is deliberate

A stale IMU holds alpha and steers nothing. A stale or implausible LiDAR drops `track`
to `heading` behaviour — straight, but not distance-corrected — rather than steering on
a bad range. LiDAR samples are deduped by `lidar_seq` (which counts MEASUREMENTS, not
polls — see the LiDAR section above), gated to 40-2000 mm, EMA-filtered, and a single
>120 mm jump is rejected unless three arrive in a row, which is a real move rather than
a speckle off the wall.

### Verification

`yaw_control.py` is pure and was exercised head-first (38 checks): wrap, every staleness and stationary gate, forward/reverse sign, both invert
flags, deadband, the +-30 clamp, the integrator learning a standing bias, the outer
loop's lean and its clamp, duplicate-`seq` and out-of-window LiDAR rejection, the
three-outlier re-acquire, `track` degrading to `heading` when the LiDAR goes quiet, and
the send throttle. Then a closed-loop simulation against a kinematic rover (20 Hz board
status, 14 Hz LiDAR, a +0.6 deg/s standing drift): open loop runs to 434 mm in 30 s;
`heading` holds parallel to under 1 deg; `track` returns to the reference within 3.5 mm
from an 80 mm offset, forward and in reverse. There is still no test runner in this
repo, so these were throwaway scripts.

**Not run on the rig, and the firmware could not even be compiled here** — there is no
C++ toolchain on this machine, so `rover/test/build_check.sh` has NOT been run against
the ported firmware. Run it on the Pi before flashing. What to check on the bench, in
order: (1) `build_check.sh` passes, including the network harness that was kept; (2)
nudge each axis 1 mm and confirm the pin map and all four direction flags against the
rig, since those came from a branch and not from a measurement made here; (3) the two
steering signs.

## Rover Scan Panel + firmware (rewritten 2026-08-29)

Panel id `rover` (`RoverPanel.jsx` + `RoverDisplay.jsx`), between `cscan` and `sar`.
Pi side `pi/rover/rover_server.py` (port 9002), launched by `pi/start.py`. Firmware in
`rover/`. Two axes only -- **X = left/right, Y = up/down** -- there is no standoff axis.

    groundstation --ws:9002--> rover_server --ws:8765--> Arduino UNO R4 WiFi

### The architectural change, and why most of the Pi side got deleted

The first firmware ran its steppers from `loop()` and, so WiFi would not disturb them,
refused to call `webSocket.loop()` while moving. **The board was deaf for the duration of
every move**: it could not be stopped, could not be queried, and silently discarded
anything that arrived mid-move.

Everything the Pi used to do was a workaround for that, and is now gone:
`enforce_move_time`, `ack_grace_s`, `move_overhead_s`, `ACK_GIVEUP`, the jog move-train,
the commanded-vs-confirmed split, `invert_x`/`invert_y`. **Do not reintroduce any of it.**

The firmware now generates steps in a 20 kHz `FspTimer` ISR and the main loop only talks.
Consequences: a held jog key is a real continuous jog, E-stop works during motion, and
position is reported at 20 Hz. `rover/motion_core.h` replaces AccelStepper -- that library
is built around "move to a target", and a jog with no target that must decelerate onto a
soft limit means writing the ramp anyway.

### Position: measured, not dead reckoned

The board reports its own step counter; the Pi converts to mm. One frame end to end --
steps, positive = up/right, origin where the operator last declared it -- so there are no
offsets to keep in sync. Direction sense lives in the firmware (`config.h`
`V_DIR_INVERT`/`H_DIR_INVERT`), not on the Pi.

Remaining error sources, all honest:
- **Quantisation**, bounded at <= half a step (65 um on X, 2.5 um on Y) *however many
  moves have been made*. Verified against the simulator: 400 x 1 mm tracks to +0.35 steps,
  the same as 40 x 1 mm. The old firmware's error grew linearly -- 400 x 1 mm would have
  been +14.7 mm.
- **Calibration**, now the dominant X term. See below.
- **Slip / missed steps**, unobservable. Reported as `travel_mm`, the odometer since the
  last declared position, which is the exposure.

**`ideal_mm` is what makes quantisation bounded, and it is subtle.** It is the commanded
trajectory in mm, kept unrounded; every step target is `round(ideal * steps_per_mm)`.
Computing a relative move as `current_mm + delta` instead does NOT work and reproduces the
original bug exactly: the current position is a whole number of steps, so the rounding
falls the same way every time and compounds. Measured that way: 40 x 1 mm came out +1.469
mm (+3.67%). `ideal_mm` is resynced to reality only on explicit events -- a `done` whose
reason is not `completed`, an E-stop, a jog ending, `set_position`.

**Do not resync it by comparing ideal against actual position.** An earlier attempt did,
on the reasoning that only a cut-short move could put them more than a step apart. It
cannot work: the board acknowledges a move -- advancing the sequence its status stream
reports -- *before* dispatching it from its queue, so every move passes through a window
reporting "new sequence, idle, old position", indistinguishable from a move cut short. The
ideal was destroyed on every move and the 3.67% drift came back untouched.

### The 3.67% rounding bug, and why it was invisible in testing

Old firmware: `lround(mm * 7.7166)` per relative move, remainder discarded. At 1 mm that is
8 steps = 1.0367 mm. The error scales inversely with move size -- 500 mm rounds to within
0.008% -- and the rig had been jogged at a 500 mm step, so **it was correctly reported as
"barely any drift" while being 3.67% wrong at the step size a raster actually uses.** Y is
exactly 200 steps/mm and never had this.

### Bugs found by the simulator, worth not reintroducing

- **`cfg` must never be answered with `hello`.** The Pi pushes its configuration in
  response to a hello, so replying to `cfg` with one is an unbounded cfg -> hello -> cfg
  loop. It saturated the link at **60,727 config pushes in one short test**, and because
  each hello resyncs `ideal_mm` it silently reinstated the quantisation drift. Fixed in
  firmware (cfg and clear_estop reply with `status`, which now carries `pos_valid`) and
  guarded structurally on the Pi by `_link_configured`, so no firmware can induce it.
- **The board's move queue is 4 deep and REJECTS what does not fit.** A rejected move is
  the worst failure available here: `ideal_mm` has already advanced past a move that never
  happened. Measured before flow control existed: 400 rapid 1 mm moves tracked 34 mm short.
  `rover_server` now holds moves in its own `_outbox` and releases them only while the
  board has room, refusing loudly past `OUTBOX_MAX`.
- **`dict.setdefault` evaluates its default eagerly**, so `cmd.setdefault('seq',
  self.next_seq())` burned a sequence number on every jog heartbeat.

### Safety -- there are no endstops on this rig

Soft limits are the only thing between a jog and the end of the rail, so they are enforced
**on the board as well as the Pi**: the Pi can crash or lose its link, the board cannot. A
jog caps its speed at `sqrt(2*a*room)` and coasts onto the limit rather than hitting it.

**Stopping distance is `v^2/2a` and it bit the original tuning.** Both axes shared one
`SPEED = 2000` steps/s, which is 10 mm/s vertically but **259 mm/s horizontally** -- a
129.6 mm stopping distance on a rig whose scans span ~100 mm. Speeds and accelerations are
now per-axis in mm and runtime-configurable; the panel shows the resulting stop distance.
Defaults (vertical 1 m of travel, horizontal 4 m):

| | steps/mm | max speed | jog speed | accel | stop dist max / jog | soft limits |
|---|---|---|---|---|---|---|
| Y vertical, leadscrew | 200.0 exact | 25 mm/s | 15 mm/s | 100 mm/s^2 | 3.1 / 1.1 mm | 150-850 mm |
| X horizontal, 66 mm wheels | 7.7166 | 150 mm/s | 60 mm/s | 500 mm/s^2 | 22.5 / 3.6 mm | 0-3900 mm |

Jog speeds were 5 and 20 mm/s until 2026-08-29 and felt sluggish next to a nudge, which
runs at the much higher *max* speed (a 100 mm nudge reaches it; a 1 mm one does not). Use a
nudge for fine placement and the jog for getting somewhere.

E-stop is software, latched, and works during motion; nothing but `clear_estop` runs while
it is latched. Clearing it marks the position invalid, because cutting the step train at
speed is exactly where a stepper loses steps. A **jog dead-man** lives on the board: the
panel refreshes every 150 ms, the board decelerates after 500 ms of silence, so a dropped
link cannot leave the rover driving. The panel also stops on blur / pointerup /
visibilitychange, since the dead-man costs up to half a second of unwanted travel.

**Standstill whine is the drivers, not the firmware.** A4988-class drivers regulate coil
current by PWM chopping and keep doing so at rest to hold position, which is audible. The
ISR touches no pin while idle (`phase_inc == 0`, and `testSetPosition` asserts no pulses),
so it is not the step train. In order of effect: turn the driver Vref down (also fixes the
holding-current heat), enable idle-disable, or fit TMC2208/2209 for actual silence.

**Idle-disable exists but defaults OFF (`idle_disable_s = 0`).** With no endstop and no
encoder, an axis that creeps while de-energised is silently in the wrong place and nothing
can detect it -- that risk is worse than the noise, so it is opt-in from the panel.
`wakeDrivers()` re-energises and waits `DRIVER_WAKE_MS` before any move, so no steps are
lost coming out of sleep (verified: a 25 mm move after parking landed within 0.011 mm).
Setting the timeout back to 0 re-energises immediately rather than at the next move.

### Verified on the rig, 2026-08-29 (first bring-up of the rewrite)

- **Directions.** Y was correct as shipped; **X was reversed**, so `H_DIR_INVERT` is now
  `true` as well. Both flags were inferred from how the *old* firmware behaved and only one
  survived contact with the rig -- re-check them after any rewiring, by nudging 1 mm and
  watching, not by reasoning.
- **Magnitudes were right first time**, so no wheel calibration was needed: the loaded
  rolling diameter is close enough to the 66.0 mm measured with calipers to be within
  measurement error over the distances tried.
- **A move clamped by a soft limit used to leave the ideal position stranded.** Reported
  from the rig: sitting at 792 with the limit at 850, a +100 nudge correctly stopped at 850,
  but the following -100 went to 792 instead of 750. Cause: the *board* clamps the target
  inside `moveTo()`, so the move then completes normally and reports `completed`, never
  `limit` -- nothing told the Pi the target had been unreachable, and `ideal_mm` stayed at
  892. Fixed by clamping in `move_to_mm` on the Pi, before the ideal is updated, so the
  ideal can never point outside the envelope. The board still clamps as the backstop.
- **A power cycle could leave the board permanently off the network, and only a
  ROUTER restart fixed it.** Cause: `ensureNetwork()` tested `WiFi.status() ==
  WL_CONNECTED` and returned early on that alone. Associating and being on the network
  are different states -- an AP still holding a stale DHCP lease for the board's MAC
  (which is exactly what a power cut leaves behind) will associate it happily and then
  never answer its DHCP request, so `status()` reads `WL_CONNECTED` forever with
  `localIP() == 0.0.0.0`. Every retry path returned early and `ensureSocket()` kept
  restarting a client that could not possibly connect. Restarting the router cleared the
  lease, which is what made the symptom look like a router problem. There is now a
  `linkReady()` (associated **and** holding an address) that all the retry logic tests,
  and a failed DHCP attempt explicitly disconnects so the next one starts clean.
  `USE_STATIC_IP` in `config.h` sidesteps DHCP altogether if it ever recurs.
  **PARTLY SUPERSEDED 2026-09-09: this was the address-less variant, and the fix
  for it was right. There is a second variant it cannot see, where BOTH halves of
  `linkReady()` lie -- see "The board could never rejoin the network" below.**
- **The board does not always reconnect by itself.** Restarting `rover_server.py` left it
  with healthy WiFi (still pingable, still associated) and a socket that never came back,
  needing a power cycle. `ensureSocket()` now tears down and restarts the client after
  `WS_RECONNECT_FORCE_MS` (10 s) of downtime while WiFi is up.
  **SUPERSEDED 2026-09-09: `ensureSocket()` is gone. Restarting the client for ever
  while the radio is wedged is exactly the deadlock described below; the 10 s
  interval survives as the ladder's first rung.**
- **Status arrives at ~11 Hz, not the 20 Hz the firmware aims for.** Harmless -- it is
  display smoothness, not control -- but unexplained. Suspect WiFi latency in the R4's
  socket stack rather than the loop, since the loop does almost nothing.

### The board could never rejoin the network: fixed 2026-09-09

Reported symptom, and it had survived two previous rounds of fixes (both recorded
above and both correct as far as they went): the Arduino drops off the WiFi, is
powered off, is powered back on -- and **never tries to reconnect**. Sometimes the
same happens after the *Pi* is power-cycled. The only reliable cure was restarting
the ROUTER, which is why it kept being read as an AP problem.

**It was not an AP problem. `ensureNetwork()` was never called again, ever.**
Reproduced against the pre-fix firmware (`git show HEAD:rover/rover.ino`) driven by
the new harness: after the AP goes away while the modem stays latched at
`WL_CONNECTED`, the board calls `WiFi.begin()` **once, at boot, and not once more in
15 minutes** -- while calling `webSocket.begin()` 100 times against a dead stack --
and it does **not** recover even after the AP comes back.

**Root cause: the two link layers had a strictly one-way trust relationship.**
`linkReady()` (`WiFi.status() == WL_CONNECTED && localIP() != 0.0.0.0`) was the sole
authority on the WiFi layer, and the socket layer deferred to it unconditionally
(`if (!linkReady()) return;  // ensureNetwork owns that case`). But
**`WiFi.status()` and `WiFi.localIP()` are the modem's opinion of itself, not a
measurement of a working network, and the modem latches**: after an AP disappears
without a clean deauth -- exactly what a power cut at either end leaves behind, and
what an AP holding a stale station entry for this MAC produces -- `status()` can sit
at `WL_CONNECTED` with the last-known address in `localIP()` indefinitely. When it
did, `ensureNetwork()` returned at its first line every single iteration and never
re-associated, while `ensureSocket()` churned `disconnect()`/`begin()` forever.

The deadlock was structural, so no amount of tuning either layer could break it: the
one piece of hard evidence available -- **a socket that will not come back** -- was
never allowed to act on the layer below it. The 2026-08-29 fix addressed the
*address-less* variant of this (`localIP() == 0.0.0.0`) and was right about that one;
it could not see the latched variant, where both halves of `linkReady()` lie.

Note the deadlock also explains the second half of the report. Restarting the router
is not a fix for a stale lease here -- it is simply the only event that changes
enough state at once, and it *sometimes* worked because it is roughly a coin toss
whether the modem notices.

**There was also no recovery of last resort.** Nothing in the firmware could
reinitialise the radio (`WiFi.end()` was never called) or reset the board, so *any*
wedge -- latched status, a modem holding sockets from hundreds of failed reconnects,
an AP refusing this MAC -- was permanent until a human power-cycled something.

**Fix: one escalation ladder (`serviceNetwork()`), and the socket layer is now
allowed to act on the radio.** `ensureNetwork()` and `ensureSocket()` are gone.

|  down for | action |
|---|---|
| 0-10 s | nothing; the library's own reconnect gets its chance |
| 10 s | restart the websocket client |
| ~30 s | **ask the gateway**, not the status register (see below) |
| 5 min | `NVIC_SystemReset()` -- refused unless the rig is parked |

**The gateway ping is the load-bearing idea.** `networkResponds()` pings
`WiFi.gatewayIP()`, and it is the only question in that file whose answer does not
come from the modem's opinion of itself. It separates the two cases the old firmware
could not tell apart, and getting that separation is what makes the ladder safe to
have at all:

- **gateway answers** -> radio and LAN are fine, the Pi is simply not running. Keep
  retrying the socket; **never** recycle, **never** reset. A Pi that is off is an
  everyday state (every `rover_server.py` restart), and escalating on it would reboot
  the board every 5 minutes during ordinary development.
- **gateway silent while `status()` claims connected** -> the radio is lying. Tear it
  all the way down and start over.

Deliberately not a ping of the *Pi*, for the same reason. `NET_USE_PING 0` compiles it
out if `WiFi.ping()` is ever unavailable; that fallback returns **false**, not
`linkReady()` -- answering "should I believe the modem?" with the modem's own opinion
would reinstate the exact deadlock. It then cannot tell the two cases apart and
recycles in both, which is wasteful and the right way round.

Other things that changed with it, each a hole in the old version:

- **`WiFi.end()`, not just `disconnect()`.** `disconnect()` drops the association;
  `end()` stops the WiFi stack in the modem, which is what releases the sockets it is
  holding and re-arms its connection state machine. The first re-association attempt
  is still a plain re-associate (most dropouts are a one-second AP hiccup); every
  attempt after it is a full teardown.
- **`send()` uses `sendTXT()`'s return value**, which it used to discard. A half-open
  TCP connection -- no FIN, no RST, which is what a Pi losing power leaves behind --
  keeps the library reporting the client connected until its own heartbeat gives up
  ~36 s later. A failed write is the earliest unambiguous evidence there is and the
  board is already sending 20 status frames a second. `NET_TX_FAIL_LIMIT = 40` (2 s).
- **The reset check sits BEFORE the escalation branches, not after.** Each branch
  either returns on success or reschedules, so a modem that kept associating happily
  onto a dead network would have escalated for ever and never reached a check placed
  at the end. Caught by the harness, not by reading.
- **The reset is refused unless the rig is parked** (`boardParked()`: not moving,
  nothing queued, no latched E-stop) and `persistBeforeReset()` runs first. That
  helper also **clears the EEPROM magic when `positionValid` is false**, because
  `loadPosition()` marks the position valid whenever it finds a well-formed blob --
  coming back from a reset would otherwise silently re-declare a position an E-stop
  had invalidated. Both its branches skip the write when the bytes are already
  correct, or a board that can never reach the network would erase flash every five
  minutes for as long as the fault lasted.
- **`printMacAddress()` on failure too.** The MAC is what a DHCP reservation is keyed
  on, so it is wanted exactly when the board is *not* getting on the network; the old
  code printed it only after a successful connect, i.e. never when it mattered.
- **`reportScan()` every 4th failed association**, which is the measurement that
  separates "the AP is refusing this board" from "the AP is not there at all". Without
  it both looked identical in the log, which is how this ended up diagnosed as
  "restart the router" rather than as anything specific. A scan takes seconds and
  disturbs an attempt, hence not every time.
- **Association timeout bounded to 10 s** (`NET_ASSOC_TIMEOUT_MS`, was 15-20). The
  retry blocks in `delay()`, so motion is unaffected (it is generated in the ISR) but
  the board is deaf to the groundstation for the duration.
- `onEvent()` now precedes `begin()` in `setup()`, the socket-restart clock no longer
  starts stale, and the retry gate is wrap-safe past 49.7 days.

### `rover/test/test_net.cpp` -- the harness, and why it exists

125-check `test_core.cpp` could never have caught this: the fault is a **liveness**
property ("from every bad state, some action eventually restores the link"), and the
only way to check one is to put the machine in each bad state and run it. Both the
old code and the new one read perfectly reasonably; only the arrangement differed.

`test_net.cpp` **`#include`s `rover.ino`** so it drives the shipped `serviceNetwork()`
and its shipped statics -- a retyped copy would have been free to drift, which for
this file is the whole ballgame. `test/netstubs/` holds scriptable replacements for
`Arduino.h` / `WiFiS3.h` / `WebSocketsClient.h` (fake clock that `delay()` advances,
captured serial log, `NVIC_SystemReset()` that throws); `test/stubs/` still supplies
EEPROM and FspTimer, which is why **netstubs must come FIRST on the include path**
and why the two `Arduino.h` files share the `ROVER_ARDUINO_STUB_H` guard.

Two details in the model are load-bearing and must not be "simplified":

- **The WiFi model's `latched` flag survives `disconnect()` and is cleared only by
  `end()`.** That single behaviour is the whole bug; a model without it passes the old
  firmware.
- **The websocket model connects from `loop()`, not from `begin()`**, matching the
  real client. An earlier version connected inside `begin()`, which made the *old*
  firmware unable to connect at all (it registered `onEvent` after `begin`) and would
  have made any before/after comparison meaningless.

41 checks: a healthy link left alone for 15 minutes; the Pi off for 20 minutes with
no recycle and no reset, recovering the moment it returns; the latched-modem fault
recovering unaided; a permanently wedged modem reaching the reset; the reset refused
while E-stopped and while work is queued; a half-open socket detected from failed
writes; an honest disconnect escalating from plain retry to teardown; and a
never-answering DHCP server retried rather than accepted. `build_check.sh` runs it,
and also now stands in `secrets.example.h` when `rover/secrets.h` is absent (the type
check could not run on a fresh checkout before) and type-checks `rover.ino` both with
and without `NET_USE_PING`.

**Not yet run on the rig.** The model is a model: it has no RF, no real modem
firmware, and `WiFi.ping()` / `WiFi.end()` are assumed to behave as WiFiS3 documents
them. What to check on the bench, in order: (1) that `WiFi.ping()` compiles and
returns sanely on the installed core -- if not, set `NET_USE_PING 0` and accept the
recycles; (2) pull the AP's power with the board running and confirm the log shows
`not to be trusted` and then a successful re-associate; (3) confirm a
`rover_server.py` restart still reconnects in ~10 s and prints `gateway answers`
rather than recycling anything.

### Calibration

X rolls on wheels, so its steps/mm is empirical -- a caliper gives the free diameter
(66.0 mm, confirmed) but a loaded wheel rolls on slightly less. `rover_calibrate` takes a
commanded and a measured distance and scales. Corrections beyond 0.5x-2x are refused as
a mis-entry rather than applied. Y is a leadscrew at exactly 200 steps/mm and should never
need it.

### The .ino preprocessor: define no types in `rover.ino`

The Arduino IDE auto-generates a prototype for every function in a `.ino` and inserts them
near the TOP of the file, above anything defined further down. A function taking a type
defined in the same `.ino` therefore fails to compile:

    error: 'PersistBlob' does not name a type
     static uint32_t blobCheck(const PersistBlob& b)

`PersistBlob` and `QueuedMove` live in `rover/types.h` for this reason. **Anything
`#include`d is visible before the generated prototypes; anything defined in the sketch is
not.** The same applies to default arguments on sketch-level functions, which the generated
prototype duplicates.

`build_check.sh` cannot catch this by compiling -- compiling the `.ino` as plain C++ skips
the `.ino` preprocessing entirely, which is exactly why this got through the type check and
only failed in the IDE. It greps for the pattern instead and fails the build.

Also note the sketch is `rover/rover.ino`, not `main.ino`: the IDE requires the `.ino`
filename to match its folder, or it offers to relocate the file and leave the headers
behind.

### Testing, given there is no Arduino toolchain on the Pi

The firmware cannot be compiled or run on the machine it is developed from, so:

- **`rover/motion_core.h` and `rover/protocol_core.h` contain no Arduino headers** and are
  compiled natively by `rover/test/test_core.cpp` (125 checks: ramp lands on the exact
  step, limits, watchdog, E-stop, JSON scan/emit). Keep new logic there, not in `rover.ino`.
- **`rover/test/build_check.sh`** runs those tests and then type-checks `rover.ino` as plain
  C++ against stubs in `rover/test/stubs/`. A pass means "will probably compile" -- it
  cannot verify the real libraries' signatures or anything about hardware.
- **`pi/rover/rover_sim.py`** speaks the board protocol over the real socket, so the server
  and panel are testable end to end with no rig. Every bug in the list above was found by
  it. It is a kinematic model of a *perfect* machine: no step timing, no missed steps, no
  slip, so it validates protocol and control flow and never mechanical accuracy.

### Protocol (line JSON, flat objects, sequence-numbered)

Pi -> board: `move` (absolute or relative, per axis), `jog`, `jog_hold`, `stop`, `estop`,
`clear_estop`, `set_pos`, `cfg`, `enable`, `ping`. Board -> Pi: `hello` (connect only),
`status` (20 Hz), `ack`, `done`, `err`. A repeated `seq` is re-acknowledged rather than
re-executed, so retransmission is safe; `jog_hold` is exempt and must not advance `lastSeq`,
which the Pi uses to discard status frames older than a position change.

WiFi credentials live in `rover/secrets.h`, **gitignored**, with `secrets.example.h`
committed. They were previously inline in `rover.ino`.

The automated grid raster is **done, but it lives in the C-Scan panel, not this one**
(2026-08-29) -- see "Rover-driven C-scan raster" below. The Rover panel stays jog, nudge,
calibration and tracking; it is the manual control surface, and driving a scan from it
would have meant a second copy of the grid definition.

## Rover-driven C-scan raster (2026-08-29)

The C-Scan panel has a **Scan Mode** toggle: `manual` (the original hand-held flow,
unchanged) or `rover`, which hands the same grid to the gantry. The rover option is
disabled unless the controller is actually linked (`roverConnected && board_connected`),
not merely when the Pi's rover server is up.

**Only the capture ORDER differs between the two modes.** The sweep, the standoff
provenance, and the background subtraction (captured reference or model, `applyBscanBg`)
are the manual path's code, untouched -- a grid captured either way is the same record and
feeds SAR / 2D Map / export identically.

### Two origins, one cell frame

Manual snakes **up from the bottom-left** (`cellForIndex`, unchanged). Rover snakes **down
from the top-left** (`roverCellForIndex`), because that is the natural way to drive a
gantry. Both write the same `grid_ix` / `grid_iy`, where `iy = 0` is still the bottom row,
so the plan view, the export and every downstream panel are order-agnostic.
`orderedCellForIndex(i, hCount, vCount, scanMode)` picks between them and is what
`CscanDisplay` uses for the dashed path, the START marker and the pulsing next cell.

The capture tag `bscanCaptureRef` is now an **object, not a boolean**: the rover raster has
to say which cell a sweep belongs to, because its capture index is not the manual snake's,
and `cellForIndex(prev.length, ...)` would mislabel every cell. `null` means nothing is
tagged.

### Locating the grid: the operator declares where they are, not where it is

There is no way to point at the wall, so the panel asks for the head's **current position
relative to the grid origin** (the top-left corner) in mm -- "right of origin" and "below
origin". At start the origin is `rover_position - right`, `rover_position + below`, and the
rover drives there in **one `rover_move_abs` on both axes**, so it travels left and up
together. Everything after that is absolute against that anchor, so quantisation cannot
accumulate (see `ideal_mm` above).

**A grid that does not fit inside the soft limits is refused, not clamped.** There are no
endstops, and `move_to_mm` clamps silently while still reporting `completed` -- so a grid
hanging over the end of a rail would raster a rectangle that is not the one on screen, with
duplicate cells at the limit. `gridRoverExtent()` is checked against `config.x/y_min/max_mm`
before a single move is issued, and the panel shows the travel range live so a mis-entered
offset is visible before it matters.

### The state machine (`hooks/useRoverScan.js`)

`homing -> moving -> settling -> capturing -> moving -> ...`, a ref plus a 40 ms interval
rather than a chain of effects -- every transition depends on the rover status stream, on
wall-clock timers and on a sweep landing, and as effect dependencies that re-entered itself
on unrelated re-renders.

**Arrival cannot be detected from "idle" alone.** The board acks a move -- advancing the
sequence its status stream reports -- *before* dispatching it from its queue, so there is a
window reporting "idle, old position" for a move that has not started (the same window that
makes `ideal_mm` unresyncable, above). Arrival therefore needs **all** of: `>= 500 ms` since
issue, `!moving`, `pending_moves == 0`, `queue_depth == 0`, **and** position within 1 mm of
the (Pi-identically-clamped) target. Idle-but-not-there for 3 s is a hard failure -- abort
and E-stop -- rather than a capture at the wrong place. Verified against `rover_sim.py` on a
3x2 grid: every cell reached, worst position error at capture **0.065 mm** (half an X step,
the documented quantisation bound), and the zero-length homing-to-cell-0 move -- the case
the 500 ms gate exists for -- was correctly held rather than passed through instantly.

**The settle delay discards the in-flight sweep.** Sweeps free-run at 3-6 Hz, so the sweep
arriving when the settle expires *started* while the rover was still moving and is smeared
across frequency. `skip: 1` on the capture tag drops exactly one; results are emitted
serially, so the one kept is guaranteed to have started after the settle window closed.
Costs ~250 ms a cell. Settle is a panel field, default **200 ms**.

**Stop Session is an E-stop in rover mode**, deliberately -- it is the only control on
screen while the gantry moves on its own. It latches, so the panel grows a Clear E-Stop
button and says the position is no longer trustworthy (cutting the step train at speed is
exactly where a stepper loses steps).

A raster **resumes**: it starts at `bscanData.length`, so stopping and restarting continues
where it left off rather than re-capturing. The origin is re-derived from the current
position each time, so the offset fields must be re-measured before a resume.

Each rover-captured cell records `rover_x_mm` / `rover_y_mm` (where the gantry actually
reported standing) beside `rover_target_x_mm` / `rover_target_y_mm` (where it was told to
go). Keeping both is the point: slip and missed steps are the only error sources nothing can
observe, so the two must not be assumed equal. Export is **v6**; import still reads v3-v5.
Import deliberately does NOT restore `scanMode` -- it is a live control, not data.

## Continuous rover C-scan raster (2026-09-07)

The C-Scan panel's Rover mode gained a **Row traverse** toggle: `continuous` (the new
default) drives a whole row in ONE move and bins the sweeps by the position they were
taken at; `stepped` is the original stop-at-every-cell raster, kept unchanged as the
fallback for ruling the continuous path out. `lib/roverTrack.js` (pure) holds the
position track, the binning and the sampling arithmetic; `useRoverScan.js` grew
`row_start -> row_settle -> traversing` beside the existing `moving -> settling ->
capturing`. **Both walk the grid in the same order** -- `rowTraverse()` reproduces
`roverCellForIndex()` cell for cell (checked) -- so a grid captured either way is the
same record and feeds SAR / 2D Map / export identically.

**Why it is now the right thing to do.** The stepped flow was designed around a 550 ms
sweep, where any motion smeared a sweep across frequency. At the 27.5 ms NIOS sweep the
per-cell cost is ~93% overhead: `MIN_MOVE_MS` 500 + `roverSettleMs` 200 + one
deliberately discarded in-flight sweep (`skip: 1`), against ~28 ms of actual sweeping.
All of it is gone, and the sweeps that used to be thrown away between cells become free
coherent averaging. Measured in simulation, 1 m row at 5 mm pitch: **stepped 76 s at 1
sweep/cell; continuous at 20 mm/s 50 s at 8.3 sweeps/cell (+9.2 dB)**; at 100 mm/s a
3-row 11-cell grid completes in 6.9 s.

### Smear is NOT the limit any more -- spatial sampling is

Motion during a sweep is a phase error bilinear in (step index, velocity). The linear
term is range-Doppler coupling, an apparent range SHIFT of `(f_start/B) * D * sin(theta)
~= 0.65 * D` where `D` is the distance moved during the **20.9 ms RF window** (51 steps x
`NIOS_MIN_DWELL` = 4096 samples at 10 Msps -- note that is the per-STEP dwell, **not**
`RX_BUFFER_SAMPLES = 2048`, which is the host-driven path's DMA granularity). The
quadratic term is the actual defocus.

| v (mm/s) | moved per sweep | range shift | quadratic phase |
|---|---|---|---|
| 20 | 0.42 mm | 0.27 mm | 0.05 rad |
| 100 | 2.09 mm | 1.37 mm | 0.26 rad |
| 150 (X axis max) | 3.13 mm | 2.05 mm | 0.39 rad |

Against a 50 mm range cell and the ~0.79 rad (pi/4) where defocus starts to matter,
**both are inside budget at any speed this rail can reach.** At 550 ms the quadratic term
was 3.4 rad at 50 mm/s, which is why the rig had to stop. Range-Doppler coupling also
says where a sweep "is": the apparent range sits at `f_start/B` = 2/3 through the sweep
rather than at its midpoint, so the phase centre is 65% of the way through the RF window.

**What binds instead is one number: `sweep spacing = v * T_sweep`** -- 0.69 mm at
25 mm/s, 2.75 mm at 100, 4.12 mm at 150. **A grid pitch finer than that leaves cells
empty however long the scan runs**; those sweeps were never taken. Consequently **pitch,
speed and averaging depth are ONE resource, not three**: `sweeps/cell = pitch /
(v * T_sweep)`. Pick two. The panel shows spacing, sweeps/cell, coherent gain, row time
and grid time live, and warns when the pitch is starved.

**Finer is not better past a point.** Spatial Nyquist for the imaging is
`dx <= lambda_min/(4 sin(theta_max))` = 15-21 mm at 5 GHz, so **5 mm already carries 3x
margin**; below that, halving the pitch buys no resolution and costs 3 dB of per-cell SNR
by splitting the same sweeps across twice as many cells. 1 mm is 15x oversampled and
needs v <= 36 mm/s just to fill one sweep per cell.

### Time base: one clock, and one scalar

**SUPERSEDED 2026-09-14 for positions: `last_status_at` is when the Pi RECEIVED a
position, not when it was measured, and keying on it left empty cells. Positions are
now keyed on the board's own clock -- see "Continuous raster holes: positions are now
timed by the board's clock" at the end of this file.** The rest of this section (never
extrapolate, the latency scalar) still holds.

Both streams are already stamped on the **Pi's** clock -- `sfcw_result.timestamp` and
`rover_status.last_status_at` -- so the association never touches `performance.now()`,
which would fold two independent websocket latencies into the answer. The track
**interpolates only and never extrapolates**: a sweep newer than the newest position
frame waits (typically <91 ms, one status period at ~11 Hz) for a frame that brackets it.
Extrapolating on the reported velocity is exact at constant velocity and wrong by half an
acceleration term -- **2.07 mm at 500 mm/s^2 over one status gap** -- precisely at the
ends of a row, where the ramps are.

What remains is a single constant, `roverLatencyMs` (default 0): a sweep is stamped ~14 ms
after its own phase centre, a status frame after its WiFi transit, and their **difference**
is all that matters. **It is a BIAS, not noise** -- its sign follows the direction of
travel, so in a snake it displaces alternate rows oppositely and a straight feature comes
out as a zigzag of `2*v*tau`. Verified in simulation: 40 ms of unmodelled latency at
100 mm/s gives per-row bias **+4.20 / -3.70 / +4.30 mm** (sign flipping with direction,
i.e. an 8 mm zigzag), collapsing to **+0.25 / +0.25 / +0.20 mm** -- a harmless constant
offset -- once corrected.

**Measure it from ONE out-and-back pass over a row**: the spatial lag between the two
directions is exactly `2*v*tau`. Same trick this file already proposes for the LiDAR
timestamp. Note that nothing in the pipeline combines rows coherently today (C-scan
focusing is per row, SAR treats the capture as one line), so an uncorrected tau costs only
the plan-view zigzag -- it does not defocus anything.

### Details that are load-bearing

- **Continuous homing goes straight to the first row's run-up point** (`entryX`), not
  to the origin (2026-09-22). Homing to the origin made row 1 back up by the overrun
  and then drive forward, unlike every later row. `gotoRow` skips the drive-to-start
  when the rover is already parked there. Stepped mode still homes to the origin.
- **The traverse OVERRUNS both ends of every row** (`traverseOverrun` = `v^2/2a` plus
  `max(10 mm, 0.2*v)`; 10.6 mm at 25 mm/s, 30 mm at 100). Two things must fall outside the
  grid: the ramps, where interpolation between status frames is wrong by the acceleration
  term above, and the last ~91 ms of the traverse, which only resolves after the rover has
  stopped. **A grid whose overrun leaves the rail is refused, not clamped** --
  `gridRoverExtentContinuous` is what the soft-limit check uses in this mode, and the
  refusal names the run-up.
- **Arrival is now reported EXACTLY by the board, not waited out.** `rover_server.py`'s
  status carries `moves_done` / `last_done_seq` / `last_done_reason`, incremented from the
  `done` frame the firmware sends once per dispatched move, when every axis it commanded
  has stopped (`rover.ino`, `movePending` block). The Pi always received it; it just never
  forwarded it. A client snapshots the counter when it issues a move and waits for it to
  advance, which is **immune to the ack-before-dispatch window** -- the window that made
  every other signal a heuristic, since `moving` is false in it and position alone cannot
  tell a move that has not started from one that has finished.

  `MIN_MOVE_MS` (500 ms) is now a **fallback only**, for a Pi that predates the field, and
  the panel says so when it is in force. A `done` whose reason is not `completed` (a soft
  limit, a stop) **aborts the scan**: targets are clamped on both sides, so it means the
  geometry is wrong and every cell of the row would land in the wrong place.

- **The continuous row has no static settle, and does not need one.** The traverse starts
  `overrunMm` outside the grid, so the rig spends the whole run-up accelerating and
  running before the first cell -- **450 ms at 25 mm/s, 400 at 100, 500 at 150** -- all of
  it after the vertical step-down has completed, all of it outside the cells. That is
  strictly better settling than standing still for 200 ms, and it is time already being
  spent. `roverRunupExtraMs` (default **0**) is the escape hatch if the mast is ever
  actually seen to ring; `roverSettleMs` still applies to the stepped path, which captures
  standing still and does need it.

- **The row change is purely VERTICAL, and vertical is the slow axis.** A snake ends row
  N at `lastX + overrun` and starts row N+1 at `firstX + overrun`, which is the *same
  point*, so the move between rows has no X component at all -- it is one Y step and
  nothing else. Y runs at 25 mm/s / 100 mm/s^2 against X's 150 / 500, and it takes 6.25 mm
  just to ramp up and back down, so **any row pitch under 6.25 mm is a triangular move
  that never reaches full speed**. `axisMoveSeconds()` (`cscanGrid.js`) is the closed form
  for both cases, checked against numerical integration of the firmware's ramp to <0.1%.

  | row pitch | Y move | old (500 ms gate + 200 ms settle) | now (move + ~1 status frame) |
  |---|---|---|---|
  | 2 mm | 0.283 s | 0.70 s | **0.37 s** |
  | 5 mm | 0.447 s | 0.70 s | **0.54 s** |
  | 10 mm | 0.650 s | 0.85 s | **0.74 s** |
  | 20 mm | 1.050 s | 1.25 s | **1.14 s** |
  | 50 mm | 2.250 s | 2.45 s | **2.34 s** |

  Note the fine pitches gain most, because they were paying the 500 ms gate for a move
  that took half that. What remains is the Y move itself, which is real mechanics, plus
  ~90 ms of status-reporting latency at ~11 Hz.

  On a 1 m row the row change is a small share and it grows as the traverse gets faster --
  15 rows at 10 mm pitch: **2% of the scan at 25 mm/s, 4% at 50, 7% at 100, 10% at 150**.
  So on a wide grid the vertical axis is not worth optimising, but on a NARROW one (short
  rows, many of them) it inverts and dominates. The panel shows Run-up, Row change and
  Grid total separately.

- **Cells are keyed on POSITION, never arrival order.** `Math.round((x - originX)/pitch)`
  is the half-pitch rule; a sweep landing outside the grid is dropped, not clamped. The
  two snake directions visit the same columns in opposite orders and a stuttered link can
  skip a bin, so order means nothing here.
- **The scan speed IS the rail's max speed for the duration**: `x_max_speed` is pushed via
  `rover_set_config` at `beginRaster` and restored by `finish()` on every exit path.
  `set_config` **persists on the Pi**, so failing to restore would quietly slow every
  later nudge and jog.
- **A partial row is harvested on ANY end** -- completion, operator stop, e-stop, link
  loss, or the sweep dying mid-row. A row is a minute of driving; same reasoning as the
  BG-model continuous capture.
- **Resume is by ROW, not by cell count.** A row emits however many cells its bins filled,
  so the flat capture count is not a row counter; `capturedRows` is the number of distinct
  `grid_iy` present in the data.
- **Watch the HOLE, not the fill count.** The panel reports the largest run of consecutive
  empty columns, which is what decides whether a row is usable -- same reason the BG-model
  continuous capture watches Hole rather than Span.
- Cells carry `rover_x_mm` (mean of the interpolated positions of the sweeps in that cell)
  beside `rover_target_x_mm` (the column centre), plus a new **`rover_x_std_mm`** -- the
  aperture the coherent average was actually taken over. At a 10 mm bin that aperture
  costs <= 1.65 dB even at grazing incidence, against the 8-13 dB the averaging buys; at a
  50 mm bin it would be -15.6 dB with a null inside the visible region, which is another
  reason 50 mm pitch was the wrong place to be.
- **`buildCellRecord()` in `App.jsx` is now shared by both capture paths** and pools
  provenance from the looks themselves rather than taking it as an argument. It only ever
  emits the fields it lists -- spreading a whole look would overwrite `h_cal_real/imag`
  with a single sweep and silently undo the averaging, which is a bug that was live in the
  first draft.
- The new params ride along in the v7 export as provenance but are **not restored on
  import**, exactly like `scanMode`: they are live controls, not data.

### Verification

`lib/roverTrack.js` and the traverse geometry are pure and were exercised head-first from
node, and the **real state machine was driven against a simulated ramped gantry and a
36 Hz sweep stream** (React shimmed to four hooks, timers stubbed, fake clock): a full
11x3 raster fills all 33 cells in `roverCellForIndex` order with worst |position - column
centre| of 0.75 mm; the latency bias behaves as derived (above); a stop mid-row harvests
the partial row and restores the speed; 150 mm/s against a 1 mm pitch reports holes rather
than hiding them; 20 mm/s at 5 mm pitch gives 8.3 sweeps/cell against the predicted 9.1;
stepped mode is unchanged; an overrun that leaves the rail is refused; exact arrival
completes a 6x4 grid 5% faster than the 500 ms fallback gate and both fill it identically;
and a move reported as `limit` aborts before a single cell is captured. There is still
no test runner in this repo, so these were throwaway scripts. `vite build` passes.

**NOT yet done on hardware, and these are the things to check first:**
1. **Does motion itself cost anything?** Unknown -- vibration on rolling wheels is the one
   term no arithmetic here can reach. Scan one row out and back at speed and score the two
   passes cell by cell; compare against a stepped pass over the same row.
2. **`roverLatencyMs` is 0 until measured.** The same out-and-back pass gives it, and
   running it three times says whether it REPEATS -- latency does, mechanical hysteresis
   on a rubber-wheel drive reversing direction may not. If it does not repeat, snake is
   unusable and rows have to be driven unidirectionally with a fly-back (which costs
   `v_scan/150` of the row time -- 17% at 25 mm/s but 100% at 150).
3. **Is the ~11 Hz status rate really 11 Hz under load?** Everything above assumes it.

## Continuous rover raster: six bugs found and fixed (2026-09-07)

Driven head-first against a simulated ramped gantry (trapezoidal ramps, a 90 ms
command link so the ack-before-dispatch window is real, ~11 Hz status frames, the
Pi's own broadcast-on-`done`-with-a-stale-position behaviour, and a 36 Hz sweep
stream) with React shimmed to four hooks and a fake clock. 31 checks; `vite build`
passes, `rover/test/build_check.sh` passes. Throwaway scripts, as usual.

Two symptoms were reported: the drive to the origin "sometimes doesn't go and stop
at the mentioned values", and the rig "sometimes goes down a row while it's
sweeping instead of scanning the row then going down". Both reproduce, and they
are different bugs.

**1. `start()` accepted a MOVING rover, so the origin was read off wherever the
last status frame caught it.** The origin is `status.x_mm - roverOriginRightMm`,
i.e. it is only meaningful at rest -- but nothing checked. Reproduced: pressing
Start 200 ms into a 600 mm nudge anchored the grid on a position the rover was
already driving away from, and the homing move then timed out chasing it. Gentler
cases do not error, they just silently put the whole grid somewhere else. `start()`
now refuses unless `!moving && pending_moves == 0 && queue_depth == 0`.

**2. The origin was RE-DERIVED on every session, including a resume.** The
"right of / below origin" offsets describe where the head was standing *when they
were measured*; after a stop it is parked wherever the abandoned row left it, so
re-deriving anchors the rest of the grid somewhere the operator never measured.
The origin is now **anchored once per scan** (`roverOriginAnchor` in `App.jsx`,
published by the hook through `onOriginAnchor`) and reused by every later session
on that grid. Cleared by New Scan and by import -- deliberately NOT restored from
an export, for the same reason `scanMode` is not: it is a live property of the rig.
An anchor whose grid geometry no longer matches is refused rather than reused,
because changing a count or a step re-keys every cell.

**3. Resume skipped a row that was stopped part way through -- this is the "goes
down a row while sweeping".** Resume read `capturedRows`, a count of rows holding
*anything*, so a row stopped mid-traverse counted as done and the next session
drove down past it. Measured: stopping mid-row-1 of a 3-row grid harvested 6 of 11
cells and the resume started on row 2, leaving a half-empty row in the middle of
the grid with nothing on screen saying so -- and, seen from the rig, the raster
"going down a row" instead of scanning one. Resume is now the first row that is not
FULL (`firstIncompleteRoverRow` / `roverRowFill` in `cscanGrid.js`, passed to the
hook as `rowFill`), and `handleRoverRowClose` REPLACES a row's existing columns
rather than appending beside them -- otherwise a re-driven row leaves two records
for one cell, which the plan view resolves by drawing the last one while the
export, SAR and the colour scales all see both.

**4. `traverseOverrun` could be SHORTER THAN HALF A CELL PITCH, so the run-up was
inside the grid rather than outside it.** Cells are keyed by
`Math.round((x - originX)/pitch)`, so everything within half a pitch of column 0's
centre lands in column 0 -- including the rig standing still at the row entry
waiting for the traverse command to reach the board, and the whole acceleration
ramp, which is exactly what the overrun exists to exclude. At 25 mm/s the overrun
was 10.6 mm against a 25 mm half-pitch (50 mm pitch is what this bench uses).
Measured before the fix, 20 mm/s / 50 mm pitch: end cells took stationary and
ramping sweeps and every cell reported a position ~7 mm short of its centre.
`traverseOverrun(speed, accel, hStepMm)` now floors at `pitch/2 + margin`; worst
cell error over a row went from 6.8 mm to 0.8 mm. **Both the hook and
`CscanPanel.jsx` must pass the pitch** -- the panel shows the overrun and checks it
against the soft limits, so a disagreement would refuse or admit the wrong grids.

**5. The per-cell cap TRUNCATED, which biases the coherent average in the
direction of travel.** `MAX_PER_CELL = 64` dropped everything past the 64th sweep,
i.e. kept the ones taken over the leading part of the cell. CLAUDE.md's own claim
that "in practice this never bites" was derived at a 5 mm pitch; at 50 mm and
20 mm/s a cell holds ~90 sweeps. Measured: every cell's `rover_x_mm` came out 7 mm
short of its own centre, biased with the direction of travel and therefore opposite
on alternate rows of a snake -- the same signature as an uncorrected
`roverLatencyMs`, and just as invisible. `createRowBin` now **decimates**: on
hitting the cap it halves the kept set (keep every other) and doubles the stride,
so the retained looks still span the whole cell at between 32 and 64 of them.
Residual position error after the fix: 0.8 mm. `summary()` reports `decimated`.

**6. `moves_done` advancing does not mean OUR move finished.** The counter is
snapshotted from whatever status frame the hook happens to hold, so a `done` for
somebody else's move -- an operator nudge, a stop, a jog ending -- still in flight
when the raster issues a move makes that snapshot stale by one, and the next frame
reads as an instant completion. Arrival then collapses back onto position alone,
which cannot tell a move that has not started from one that has finished: the exact
ack-before-dispatch window the counter exists to close. It also lets the LATCHED
`last_done_reason` from a previous session abort a scan on its first move.

Fixed structurally, Pi-side: `rover_move_abs` accepts an opaque **`token`**, which
`rover_server.py` carries through `_outbox`, maps onto the board sequence the move
is actually sent with (`pump` now keeps `send_board`'s return), and echoes as
**`last_done_token`** in status when THAT move's `done` arrives. Waiting for your
own token back is immune to every other mover on the link and needs no timer. A Pi
without it falls back to `moves_done` **plus a `MOVE_ACK_FLOOR_MS = 300` floor** (a
link round trip plus one status period, which no genuine completion can beat), and
then to the old `MIN_MOVE_MS` timer.

**Also added: a silent-link watchdog.** `board_connected` going false is the Pi
reporting a known state; a Pi that has simply gone quiet was invisible, and the
raster would keep issuing moves against a position it could no longer see. The tick
now aborts after `STATUS_STALE_MS = 4000` without `last_status_at` changing. Note
it only ever compares the Pi's clock with ITSELF -- what is timed locally is how
long we have gone without seeing it move.

**Firmware (`rover/rover.ino`): `stop_reason` is per axis and `moveTo` does not
clear it**, so an axis left out of a move still carried whatever ended its previous
one -- and `sendDone` read both axes unconditionally. A Y-only move following an X
move that ended on a limit would report `limit`, and the Pi aborts a raster on any
reason but `completed`. `dispatchQueued` now clears `stop_reason` on the axes it
commands and records them in `inFlightAxes`; the done block reads only those.
Dormant for the raster as it stands (`issueMove` always sends both axes) but live
for nudges, and one stale byte is a lost scan.

**Also: the hook restores `x_max_speed` on unmount.** `set_config` PERSISTS on the
Pi, so a tab closed mid-raster left the rail at the scan speed and quietly slowed
every later nudge and jog. Best effort -- a hard close can outrun the send.

### The plan view now fills DURING a row, not at the end of one (2026-09-08)

Reported: "each row scan updates at the end, can we get the grid to update real
time, like before." Correct -- the continuous raster emits a row WHOLE, so on a
1 m row at 25 mm/s the plan view sat blank for ~25 s and then filled in one jump.
The stepped raster had always drawn each cell as it was captured. The plan view is
the only thing on screen that says the scan is working, so it should not go dark
for the length of a row.

`createRowCollector` gained **`liveRow()`** -- `{ geom, cells, kept }` read from
the open bin WITHOUT closing it. `cells()` was already a pure re-derivation of
each bin's mean and spread, so calling it repeatedly changes nothing; a cell it
returns and the same cell from `closeRow()` differ only in the sweeps that landed
in between.

App's `publishRowStats` (already throttled to 250 ms for the fill counter) now
also flushes those cells into `bscanData`. **The live flush and the end-of-row
harvest go through ONE function, `writeRoverRowCells`** -- the replace-by-(ix,iy)
merge that already existed for resume. That is what makes it safe to call
repeatedly (each flush supersedes the last, so the close is just the final flush)
and it is why there is no separate "preview" record shape to keep in step with
`buildCellRecord`. A cell drawn while the rover is still driving is built by
exactly the same code as the one that reaches the export.

Verified against the simulated gantry: a row's on-screen fill climbs **1 cell at
3 s to 11 by 23 s** where it used to show nothing until 25 s; the completed grid
is **byte-identical** to the close-only path (ix, iy, sweep count, xMean, xStd,
target, and array ORDER -- so START and the dashed path still read right); no
duplicate cells; and a stop mid-row keeps at least what the flushes had already
shown. 17 checks.

Three things that are load-bearing:

- **The flush is skipped unless the bin's `kept` count changed** (`roverRowKeptRef`,
  reset to -1 on open and on close so those two always write). Rewriting identical
  cells would churn every downstream memo for no visible change -- which matters
  during the run-up and wherever the rover is over ground the grid does not cover.
- **4 Hz is a considered rate, not a default.** The cost is the whole derive chain
  re-running: `applyBscanBg` over every cell, then the shared scale and the focused
  cell values. Measured on the Pi at 8 sweeps a cell, **32 ms for a 147-cell grid
  and 52 ms for 303 cells** -- ~13-21% of one core at 4 Hz there, less on the
  groundstation. Raising the rate is not free, and 4 Hz already puts two updates
  inside a 50 mm cell at 100 mm/s. If it ever needs to go faster, memoise
  `applyBscanBg` PER CELL first (it is a pure per-cell map with no cross-cell
  dependency, so a WeakMap on the record keyed by the subtraction options works);
  do not just lower the interval.
- **The SAR worker's 300 ms debounce therefore never fires DURING a traverse**
  (250 < 300). Deliberate: a reconstruction of a half-driven row is discarded by
  the next flush anyway, and it still runs at every row change, where the flushes
  stop because `publishRowStats` is gated on `isOpen()`.

### Plan-view pixels: exact tiling, and the dashed path is gone (2026-09-08)

Audit of the colouring pipeline after the live flush went in. The cell -> pixel
mapping and the value pipeline were checked end to end; two things were wrong.

**1. EVERY CELL OVERDREW ITS NEIGHBOURS BY UP TO 1.5 px.** `cellRect` returned the
raw fractional rectangle and the three fills compensated for the resulting
hairline gaps with `Math.ceil(r.w) + 0.5, Math.ceil(r.h) + 0.5`. That is a smear,
and it scales with how fine the grid is: measured against the shipped function,
**11.6% of a cell wide on a 101-column raster** (the pitch this rig actually
captures at) and 12.5% tall on an awkward-fraction layout, against ~1.9% on the
21x7 bench grid. A plan view is a measurement -- a cell must cover its own area
and nothing else.

`cellRect` now snaps each edge by rounding the cell BOUNDARY rather than a
position plus a width, so column ix's right edge and column ix+1's left edge are
the same expression and therefore the same pixel. Verified head-first against the
function pulled out of the shipped file (not a retyped copy): **zero gaps, zero
overlaps, zero zero-area cells** across four geometries including to-scale, and
total width within 1 px of the exact extent. Rounding does NOT accumulate --
every edge is rounded from its own absolute boundary -- so the to-scale
projection stays true to within a pixel across the whole grid, which is far
better than the 1.5 px bleed it replaces.

**2. The dashed capture path is REMOVED.** It drew dotted lines joining captured
cell centres in capture order, over the very pixels the plan view exists to show.
It had also become wrong once the grid filled live: a row is written sorted by
COLUMN, so on a right-to-left traverse the path was drawn back to front, and the
open row's records are rewritten on every flush so its `order` churned at 4 Hz.
START still marks where the raster began -- that part reads from the data and is
worth keeping. The pulsing cyan NEXT-cell marker is also dashed but is a single
outline, not lines across the image, and stays.

**What was checked and found correct, so do not go looking again:**

- **`cellRect`'s iy flip** (`originY - (iy+1)*cellH`) and `cellAt`'s inverse agree,
  and `buildCscanGrid`'s `cells[iy*h + ix]` matches the draw loop's indexing. No
  row mirroring, no off-by-one.
- **SAFT addresses neighbours by GRID COLUMN** (`t.n`), not array position, so a
  partial row -- which under live flushing is now the normal case -- does not
  close the gap up and give every later column the wrong lateral offset.
- **The live flush does not change the final image.** Simulated a full 11-column
  traverse (36 Hz sweeps, 11 Hz positions) with flushing on and off and pushed
  both through `applyBscanBg` -> `computeCellValues` -> `buildCscanGrid`:
  **coloured values identical to 0 dB with focusing both on and off**, identical
  shared and grid colour scales, no duplicate cells, a planted target landing in
  the column it was planted in, and every cell within 1 mm of its column centre.

**Known transient, NOT a defect in the final image.** While a row is filling, a
cell at the leading edge has neighbours on one side only, and
`saftFocusedProfile` accumulates a SUM over whatever contributors exist -- so with
Focus on, the leading cells read dim and brighten as the row completes. It is the
same truncated-aperture effect that permanently applies at the two ENDS of every
finished row. Normalising by contributor count would change a kernel shared
bit-identically with the 2D Map, so it was left alone; the final image is
unaffected.

### Long-scan failures: a 282 MB worker clone and a 258-byte cfg (2026-09-08)

Two unrelated reports from one long scan, both reproduced and both fixed.

**BROWSER: `DataCloneError: ... out of memory` + "Maximum update depth exceeded".**
`useSarWorker` posted the WHOLE C-scan record list to the SAR worker, and
`postMessage` structured-clones -- a synchronous deep copy on the main thread on
every job. Since v7 every cell carries `sweeps`, every raw look taken there, which
the worker never reads: it uses only `h_cal_real/imag`, `magnitudes`, `distances`,
`lidar_standoff_mm`, `step_size`, `range_offset`. Measured cost of one clone:

| grid | whole record | SAR's fields only |
|---|---|---|
| 21x7, 18 sweeps/cell | 8.9 MB, 76 ms | 1.6 MB, 7 ms |
| 101x15, 18 sweeps/cell | 91.5 MB, 916 ms | 16.6 MB, 69 ms |
| 101x15, 64 sweeps/cell | **282.2 MB, 3176 ms** | 16.6 MB, 70 ms |

282 MB is the OOM. The **multi-second synchronous block** is also the most likely
explanation for the update-depth error and the `performance.measure` OOM beside it:
the live flush sets state at 4 Hz and the websockets keep delivering throughout, so
React resumes into a huge batch under memory pressure. `SAR_INPUT_FIELDS` +
`projectForSar()` now trim the payload at the postMessage, **5.5-17x less memory and
11-45x faster**. Projected in the HOOK, not at the call site, so a future caller
cannot re-widen it; `sar.worker.js` carries a matching comment because a field that
is not projected arrives as `undefined` rather than raising.

Verified on a real 20-position scan through the actual worker (`self` shimmed,
`sweeps` fabricated so the projection had something to strip): the full `image` and
`coherence` arrays and all 23 scalar result fields are **bit-identical** between the
full and projected inputs. Only `computeTimeMs` differs, being a measurement.

**I did NOT positively identify a self-triggering setState loop.** All eight App
effects and the component effects were checked and each is either ref-only or
guarded; the memory/stall explanation is what the measurement supports. **If
"Maximum update depth exceeded" survives this fix, there is a real loop and it needs
a profile** -- do not assume it is gone.

Note `bscanData` itself still reaches **32 MB at 101x15x18 and 83 MB at 64
sweeps/cell**. That is the data, and `sweeps` has to stay for the coherent/incoherent
toggle, but it bounds how long a scan can get in one tab.

**PI: `board error: too_long: command exceeds the receive buffer` -- the cfg was
being silently rejected.** Measured against the real bench config, the `cfg` command
serialised to **258 bytes against the firmware's 256-byte `RX_BUFFER_SIZE`**, so the
board dropped it.

This is not cosmetic. `cfg` is what carries the **soft limits** to the board, and on
a rig with no endstops those are the backstop that is supposed to survive this Pi
crashing. It also carries the scan speed a raster pushes at `beginRaster` and
restores at the end -- so a rejected cfg means the traverse runs at whatever speed
the board happened to hold.

Cause: `x_steps_per_mm` is `1600/(pi*66) = 7.716603301425229`, so every speed and
acceleration derived from it serialises at full 17-digit double precision --
`"h_speed": 1157.4904952137842` is 19 characters where 10 would do. **The overflow is
DATA-DEPENDENT**, which is why it appeared only once X had been calibrated to an
awkward number: Y is exactly 200 steps/mm and serialises short.

Two fixes, both in `send_board`/`push_config`:
- **3-decimal rounding** on the six float fields. 3 dp of a steps/s figure is
  ~0.0004 mm/s, orders below anything the mechanism can express. 258 -> 226 bytes.
- **Compact JSON separators** (`separators=(',', ':')`), worth another 27 bytes.
  Verified against the FIRMWARE'S OWN PARSER compiled natively from
  `rover/protocol_core.h`: `findValue` terminates a bare value on `,`/`}`/`]`/
  whitespace, so spaced and compact parse identically -- every field of a cfg and a
  move checked both ways.

Result: real config **201 bytes (55 spare)**, and the worst case `CONFIG_BOUNDS`
allows **231 bytes (25 spare)** -- rounding alone did NOT cover that worst case
(258), which is why both changes were needed. `BOARD_RX_LIMIT = 256` now mirrors the
firmware and `send_board` logs and surfaces an oversized command by name rather than
leaving a bare `too_long` in the board log to be correlated by hand. It still sends:
the board's refusal is the authority, and silently dropping would be worse.

Raising `RX_BUFFER_SIZE` in the firmware would add margin but needs a reflash; the
Pi-side fix deploys now and the guard makes a future overflow loud.

### What the harness checks, and what it cannot

31 checks: a clean 11x3 raster (33 cells, every cell within 2 mm of its column
centre, scan speed applied and restored); start refused while moving and accepted
once at rest; stop mid-row then resume (same anchor, no duplicate cells, grid ends
full); the counter fallback with no token support; a silent link aborting while
still harvesting the partial row; a run-up that leaves the rail refused; stepped
mode still snaking `0,1 1,1 2,1 3,1 3,0 2,0 1,0 0,0`; every row change purely
vertical with one row_start and one traverse per row; and an anchor from a
different geometry refused.

The gantry is a KINEMATIC model of a perfect machine -- no missed steps, no slip,
no WiFi jitter beyond a fixed link delay, and the sweep stream never drops. It
validates protocol and control flow only. `pi/rover/rover_sim.py` remains the way to
exercise the real server end to end. **Not yet run on the rig.**

## Imaging Bench Panel — Offline Effect Comparison (2026-08-23)

Panel id `imaging` (`ImagingPanel.jsx` + `ImagingDisplay.jsx` + `lib/imagingEffects.js`),
sitting after `sfcw` in the `PANELS` array. It is **entirely offline**: it reads a
`waterfall_snapshot` JSON exported from the live SFCW waterfall and re-processes it through
a menu of 11 selectable imaging effects, so processing chains can be A/B'd against identical
recorded data without going back to the bench. It never touches the SDR socket.

**All effect math lives in `lib/imagingEffects.js` as pure `(snapshot, params)` functions**
returning plain arrays plus axis metadata. `ImagingDisplay` contains no signal processing —
it memoizes and draws. That split is what makes the effects testable head-first from node
with no React (see the round-trip check below).

### `rawHistory` — the raw complex ring buffer in SfcwDisplay

`waterfallHistory` stores only scalar magnitude rows (dB or linear per `scaleMode`) and is
wiped on every `scaleMode` change, so five of the effects — phase-as-hue, coherence, coherent
integration, dispersion, raw S21 — could not be built from it. `rawHistory` is a parallel
`useRef` buffer with the same `WATERFALL_MAX_ROWS = 100` cap, pushed in the same effect so
row *i* of one lines up with row *i* of the other. Each entry is the sweep untouched by
window / range-comp / averaging / dB conversion:

```
{ real: Float32Array, imag: Float32Array, num_steps, step_size, range_offset,
  start_freq, stop_freq, timestamp, phase_coherence }
```

Source is `sfcwResult.h_cal_real/h_cal_imag` via `hCalRef` (which now also caches
`start_freq` / `stop_freq` / `timestamp` / `phase_coherence`). It is cleared **only** on
unmount, never on a `scaleMode` flip — raw sweeps are unit-agnostic so there is nothing to
invalidate, and that is the one case where the two buffers can differ in length.

A `rawCount` state mirror exists purely so the EXPORT button can enable/disable itself; the
buffer is never read through React. The existing live render path is unchanged.

### `waterfall_<ts>.json` v1 format

Written by the neutral `EXPORT` button in the waterfall pane (`bottom-10 left-14`, inside the
waterfall's own relative container, so it sits alongside — not over — the range profile's
dB/LIN toggle). Gated on `!hideWaterfall`, so only the SFCW panel's instance has it; the
C-scan and BG-model instances do not. Disabled and dimmed when the buffer is empty.

```json
{
  "version": 1,
  "type": "waterfall_snapshot",
  "timestamp": "<ISO>",
  "common": { "num_steps": 51, "step_size": 60000000, "start_freq": 2000000000,
              "stop_freq": 5000000000, "range_offset": 0.5 },
  "displayState": { "scaleMode": "linear", "windowType": "rectangular",
                    "kaiserBeta": 3, "rangeComp": 0, "avgCount": 1 },
  "sweeps": [ { "t": 1755900000.12, "real": [], "imag": [],
                "phase_coherence": { "phase_std_rad": 0.11, "coherent": true } } ]
}
```

`sweeps` is oldest-first; `real`/`imag` are rounded to 8 decimals like the Pi does. ~124 KB
for 100 sweeps × 51 steps. `displayState` is **provenance only** — `App.jsx`
`handleLoadImagingSnapshot()` uses it to seed the bench's "None" mode and the shared
range-profile knobs so the bench opens on the image the operator was looking at, and it is
applied to nothing else.

**`sfcw_result` now carries `start_freq` / `stop_freq`** (`sfcw_engine.py` `_process_h_cal`).
This is the only Pi-side change the panel required. `stop_freq` is the *last frequency
actually visited* (`start + (num_steps-1)*step`), which equals `self.stop_freq` only when the
step divides the span evenly. Dispersion and raw-S21 need the real RF axis and deriving it
from `step_size` alone is guesswork. `snapshotFreqs()` falls back to step index for
pre-`start_freq` snapshots and `freqsKnown()` flags it; the panel says so in the readout.

### The 11 effects

| # | id | What it computes |
|---|---|---|
| 0 | `none` | Reference image — identical processing to the live waterfall |
| 1 | `compression` | `(\|H\|/peak)^p`, a continuous dial where dB and linear are two points |
| 2 | `percentile` | Colour limits from percentiles, whole-history or per-row |
| 3 | `binnorm` | Per-bin temporal normalisation — adaptive clutter map, no capture, no model |
| 4 | `cfar` | Signal / CFAR threshold in dB, so 0 dB is the detection threshold |
| 5 | `colormap` | Same image under all five maps side by side |
| 6 | `phasehue` | Hue = phase of the complex profile, value = magnitude |
| 7 | `coherence` | Normalised complex correlation at lag L over a sliding window |
| 8 | `integration` | Coherent vs non-coherent averaging, and their ratio |
| 9 | `dispersion` | Sub-band sweep — range across, sub-band centre frequency up |
| 10 | `s21` | Calibrated `h_cal` against frequency, before any IFFT |

Notes on the ones with non-obvious choices:

- **Effects 3, 7, 8 need multiple sweeps.** They return `{kind:'message'}` on a one-sweep
  snapshot and the dropdown disables them, rather than rendering garbage.
- **Effect 8 integrates in the range domain, not on `h_cal`.** Averaging complex `h_cal` over
  K sweeps and then transforming is *identical* to averaging the complex range profiles (the
  IFFT is linear), and the non-coherent partner — a mean of magnitudes — only means anything
  in the range domain. Averaging `|h_cal|` in frequency and then transforming would be
  nonsense. Side-by-side gives coherent and non-coherent one shared colour scale, which is
  the whole comparison; the ratio pane is a relative quantity in different units so it
  carries its own scale, marked `OWN SCALE` in amber.
- **Effect 9's sub-band count is capped by width and overlap.** `hop = subWidth*(1-overlap)`,
  so `maxCount = floor((numSteps-subWidth)/hop)+1`; the count slider is clamped to that and
  the canvas says so when it bites. The default `overlap` is **0.6**, which is where the
  default 8 sub-bands actually fit across a 51-step sweep — at 0.5 only 6 do. A sub-band
  starting at a non-zero step does not shift range (range is set by the *rate* of phase
  change with frequency, not the offset), so all sub-bands share one range axis.
- **Effect 10's residual mode is a direct corrupted-sweep detector** and is the reason it
  exists — see the `settle_count` regression history above. A sweep is flagged red when
  `max(computed_std, phase_coherence.phase_std_rad) > 0.3 rad`, matching the Pi's own cut.
  `real & imag` has no single scalar to colour a waterfall with, so that combination stays a
  line plot regardless of the display radio, and says so.
- **CFAR and the window functions were lifted out of `SfcwDisplay` into
  `imagingEffects.js`**, so both panels now call one implementation; CFAR gained GO/SO
  variants (GO holds the threshold up on the far side of the wall return, where CA lets a
  clutter edge drag it down). `computeCFAR` accumulates its CA sum in a side-then-k order
  that looks redundant next to the per-half accumulators the GO/SO variants need — **do not
  "simplify" it into `(loSum + hiSum) / (loCount + hiCount)`.** Float addition is not
  associative and that rewrite shifts the threshold by ~3e-14 dB, which is what the current
  form deliberately avoids: the live display's output is bit-identical to what it produced
  before the lift, verified across window lengths 51–256, Kaiser β 2–14 and five CFAR
  parameter sets.
- **CFAR runs on the full profile and clips afterwards**, so the range-zoom edges do not get
  a one-sided training window.
- **Range compensation is folded into the complex profile** as an amplitude gain of
  `r^(n/2)`, which is exactly the `+ n*10*log10(r)` dB the live display applies — doing it in
  `prepare()` keeps magnitude and phase consistent for the complex effects.

### Structure and cost

`prepare(snapshot, profile)` does the windowing and zero-padded IFFTs once and is memoized on
`[snapshot, params.profile]`; every range-domain effect reads its output, so switching effects
or dragging an effect slider never redoes them. Measured on 100 sweeps × 51 steps: `prepare`
7 ms, every effect ≤ 9 ms, worst case (sliding median, K=50, zero-pad ×8) 32 ms. No manual
Apply button is needed and none exists — every parameter updates the render immediately.

The View section's range zoom is applied **before** colour limits are computed, so percentiles
and dynamic scaling describe what is actually on screen. The colormap choice is global: it
persists as the active map across every effect, not just while entry 5 is selected.

`ImagingDisplay` draws via an offscreen `nx × ny` canvas + `putImageData` + one scaled
`drawImage`, not per-cell `fillRect` — at 100 × 1024 bins the latter is tens of thousands of
fills per frame. Non-finite cells (short coherence windows, masked bins) render as a dark grey
no colormap produces, so they are never mistaken for data.

### Verification

Effect math was checked head-first from node against a synthetic two-target scene: peak bins
land within one bin of the true range (0.22 / 0.60 / 1.00 m → 0.2196 / 0.6002 / 1.0003 m at
zero-pad ×8, 4.9 mm bins). The full export → import → validate → render chain was exercised
with the verbatim export payload, and all 11 effects were rendered in a real browser to
confirm the canvas output. There is no test runner in this repo, so those checks were
throwaway scripts rather than committed tests — worth rebuilding as real tests if
`imagingEffects.js` grows.

## Sweep Timing (measured 2026-08-20)

**Measured sweep times** at 151 steps (20 MHz spacing, 2–5 GHz):
- Mean: 548 ms, effective rate 1.82 Hz.
- Per-step time: 3.63 ms (10 settle buffers × 4096 samples / 2 Msps = 20.5 ms settle
  + 1 capture buffer, but the real wall time per step is 3.63 ms because RX callbacks
  overlap — the settle wait is for *new* callbacks arriving, not elapsed time).

The per-step wait is `settle_count` RX buffer callbacks in `_sweep_core`, now a
user-controlled `SFCWEngine` param (default 10, exposed in the panel as "Settle",
same param family as `num_buffers`/"Buffers") rather than hardcoded. Sweep RX buffers
are 4096 samples at the 10 Msps set in `_configure_hardware`, i.e. 0.41 ms per buffer —
`BUFFER_SAMPLES` / `SAMPLE_RATE` in `SfcwPanel.jsx` mirror those two numbers and must
track the engine. `num_buffers` genuinely averages that many post-settle captures per
step now (see Quick-tune master table below) — the panel's per-step estimate is
`(settle_count + num_buffers) * 0.41ms`.

**Regression, 2026-08-20 to 2026-08-23 (fixed): do not drop `settle_count` below 10
without a real per-step validation.** An optimization pass (`407e205`, `510a9fe`) cut
the quick-tune `settle_count` from 10 to 7, gated behind an experimental
`sweep_mode='fast'` flag with an explicit "reduced if Test C proves it safe" caveat —
then the very next commit merged it in as the unconditional default and rewrote the
caveat into an unsubstantiated "validated over 50 sweeps" claim, with no test artifact
in the repo. Symptom: intermittent fully-garbled sweeps (good scans mostly,
occasionally one random-looking sweep, rarely two in a row) — one step retuning late
means its capture still holds the previous frequency's IQ, and since the range profile
is one IFFT across all steps, a single bad bin corrupts the whole sweep rather than
just that bin. Default reverted to 10. If it ever needs to drop again, validate with a
per-step check (flag/log which step index was corrupted), not just an aggregate
correlation over whole sweeps — an aggregate metric is exactly what let this ship
unnoticed. `benchmark_sweep.py` is a leftover from that pass and is currently broken
(references `_sweep_core_fast`/`sweep_mode`/`_qt_profiles_rx`, all since removed, and
unpacks `_sweep_core` as a 2-tuple when it has returned `(h_cal, dropped_steps, adc_peak)`
since 2026-08-29) — needs a rewrite against the current `_sweep_core`/master-table API
before it's useful again.

**The same 2-tuple slip was live in the engine itself until 2026-08-31.**
`_sweep_core`'s early `if stop_event.is_set(): return None, 0` was missed when
`adc_peak` was added, so **every stop mid-sweep** raised
`ValueError: not enough values to unpack (expected 3, got 2)` in `_perform_sweep` /
`_perform_sweep_raw`. It presented as a harmless recurring
`[sfcw] Sweep error: not enough values to unpack (expected 3, got 2)` because
`_sweep_loop`'s broad `except` falls straight into a `finally` that stops TX/RX —
which is what stopping was about to do anyway — so the shutdown still happened, just
via the exception path. It was not harmless: it pushed a bogus `{'error': ...}` to
the groundstation on every stop, and it trained the operator to ignore the one line
a genuine sweep failure would print. Now returns `None, 0, None`; every consumer
already guards a null `adc_peak` (`_warn_if_adc_hot`'s `if not adc_peak`). **If a
fourth value is ever added to `_sweep_core`, that early return is the one to
remember** — it is the only path that does not fall through to the bottom.

**Regression, 2026-08-20 to 2026-08-23 (fixed): `num_buffers` default silently dropped
from 4 to 1, killing per-step noise averaging.** The `c33b0ce` "clean up" commit (same
day as the `settle_count` regression above) trimmed `sfcwParams`/`SFCWEngine` defaults
and dropped `numBuffers` from 4 to 1 — with no discussion, apparently just collateral
from tidying the defaults block. It went unnoticed at the time because the multi-buffer
averaging in `_sweep_core` was *itself* separately broken by the `407e205`/`510a9fe`
optimization pass: `num_buffers` only extended the settle wait but the code always
grabbed the single latest RX buffer regardless of its value, so for a few days the
setting had no effect at any value. `f98e208` (2026-08-23) fixed the averaging to
actually capture and mean `num_buffers` fresh buffers per step — but the default was
already 1, so the fix's benefit stayed invisible (1 buffer averaged with itself is a
no-op) until the default was corrected back. Symptom: sweep-to-sweep correlation stays
high (scene/multipath structure is unchanged) but per-sweep amplitude/phase noise is
visibly higher than before, burying fainter returns — because each step went from
averaging 4 captures (~6 dB of free SNR, `10*log10(4)`) down to 1. Confirmed live on
2026-08-23: 15-sweep static-scene comparison via the running `sdr_server`, mean
complex-domain deviation between sweeps was 0.0055 at `num_buffers=1` vs 0.0034 at
`num_buffers=4` (~39% reduction). Default restored to 4 in both `App.jsx` and
`SFCWEngine.__init__`. If `num_buffers` is ever dropped for speed again, check the
*current* live-sweep wobble against a static scene first, not just correlation —
correlation is insensitive to this because it doesn't wreck sweep structure, only
buries weak signal in noise.

## FPGA tuning mode kills the RX stream on the bladeRF 2.0 — do not re-enable (2026-08-28)

**Symptom:** RF Calib panel works fine, but starting an SFCW sweep gives
`[ERROR @ .../libusb.c:1089] Transfer timed out for RX buffer ...` +
`[bladerf] RX dual error: Operation timed out`, and no sweep is produced at all.

**Cause:** `SFCWEngine._configure_hardware()` called `driver.set_tuning_mode_fpga()`
(`bladerf_set_tuning_mode(BLADERF_TUNING_MODE_FPGA)`). On the bladeRF 2.0 micro that call
*succeeds* (`rc=0`, prints "Tuning mode set to FPGA") and then silently breaks the RX_X2
data path: `sync_rx()` starts throwing `TimeoutError` about 8 buffers later. Because
`_rx_loop_dual` catches the exception and exits, `_rx_seq` stops advancing, so every step of
`_sweep_core` falls through its `rx_cond.wait(timeout=1.0)` and the sweep returns nothing.

**Bisected on hardware** (device free, 10 Msps, RX_X2, same `sync_config` the driver uses):

| test | result |
|---|---|
| stream only | OK, 60/60 buffers |
| `set_tuning_mode(FPGA)` only | **FAILS after 8 buffers** |
| quick-tune master table only (151 profiles, no FPGA tuning) | OK, 60/60 buffers |
| both | **FAILS after 8 buffers** |

So the quick-tune table is innocent — it was *only* the tuning mode. Note the failure happens
before any `bladerf_schedule_retune()` call, so it is not a retune problem either.

**Not an FPGA-image problem.** Reproduced identically with the flashed image (0.16.0, "configured
from SPI flash") *and* with Nuand's official `v0.16.0/hostedxA9.rbf` downloaded and loaded into
RAM (`bladeRF-cli -l`, reports "configured by USB host"). Reflashing does not help — don't.
Test FPGA images with `-l` (RAM, reverts on power cycle), not `-L` (SPI flash), when
diagnosing; it is free to undo.

**Why it was never going to work:** libbladeRF's own `default_tuning_mode()`
(`host/libraries/libbladeRF/src/board/bladerf2/common.c`) opens with an unconditional
`mode = BLADERF_TUNING_MODE_HOST;`, and the `if (BLADERF_TUNING_MODE_FPGA == mode && ...)`
errata check immediately after it is dead code that can never run. FPGA tuning on bladerf2 is
reachable *only* via `BLADERF_DEFAULT_TUNING_MODE=fpga`, and the errata text it guards refers
to "errata related to FPGA-based tuning". Nuand does not default this board to FPGA tuning.

**Fix shipped:** the `set_tuning_mode_fpga()` call is removed from `_configure_hardware()`
(the comment there explains why — keep it). `driver.set_tuning_mode_fpga()` itself is left in
`bladerf_driver.py` but is now uncalled; `_fpga_tuning` was a write-only flag nothing ever
read, and is now just set False.

**It costs nothing.** Quick-tune still works in host tuning mode: `bladerf_schedule_retune()`
returns `rc=0` for every step, and a 51-step sweep measured **230 ms (4.35 Hz)**, inside the
3–6 Hz band this panel has always run at. Verified end-to-end through `SFCWEngine` itself:
3/3 sweeps, 51 steps each, no errors, sweep-to-sweep correlation **0.9984**.

**Caveat left open:** those verification sweeps ran with the antennas pointed at open room, and
reported `phase_std ≈ 1.44 rad` -> `coherent=False` (the Pi's cut is 0.3). Sweep-to-sweep
correlation of 0.9984 says this is repeatable structure, not the retune-timing corruption that
check exists to catch (corrupted sweeps do not repeat). Still worth re-confirming against a
known target that the range profile looks right.

## Quick-tune master table (2026-08-23)

Per-grid quick-tune profile caching is gone. `SFCWEngine._ensure_master_quick_tune_table()`
generates one fixed table spanning `QT_MASTER_START_FREQ`–`QT_MASTER_STOP_FREQ` (2–5 GHz)
at `QT_MASTER_STEP` (20 MHz) once per device connection — 151 profiles, paying the full
per-frequency VCO-cal cost (`bladerf_set_frequency` + `bladerf_get_quick_tune`) only that
once, ~6s total. `set_params()` snaps `start_freq`/`stop_freq` to the nearest 20 MHz and
clamps them into that range, and snaps `step_size` to a 20 MHz multiple (`_snap_freq`/
`_snap_step`), so every sweep's frequencies are guaranteed to land exactly on master grid
points. `_build_sweep_grid()` then just indexes into the cached table — no regeneration,
no device reset — so start/stop/step can change freely mid-session, live, with no
interruption.

This replaced the old scheme: profiles were cached per-`(start, stop, step)` combo, and
changing any of those three flipped `_freq_grid_dirty`, which forced a full
`driver.reset()` + reconfigure + restream on the next sweep (or mid-sweep, via
`_reconfigure_for_new_grid()`). That reset path was unreliable in practice — bladeRF
errors on the reopen — which is why it's gone rather than fixed. The master table only
needs invalidating (`SFCWEngine.invalidate_quick_tune_table()`) after an explicit
`device_reset` from the panel; `sdr_server.py`'s `device_reset` handler calls it.

**The table is the UNION of a 20 MHz and a 50 MHz grid (2026-08-31), not a single
uniform grid.** 20 alone could not represent a 50 MHz step: `set_params` snapped
50 -> 40 and the panel then described a sweep that was not the one running (61 steps
and 1.0 m of range against the 76 steps and 1.37 m actually swept, with nothing on
screen saying so). Cost against the 256 ceiling: 20 MHz -> 151 points, 50 MHz -> 61,
overlap (multiples of 100) -> 31, **union 181, leaving 75 spare**. Adding a third
family is not free -- check the union against the cap first.

Two consequences that are easy to get wrong:

- **A single sweep must stay inside ONE base family.** Mixing is not safe: starting
  at 2020 (on the 20 grid) and stepping 50 visits 2070, which is on *neither*
  family and is not in the table at all. `_snap_sweep()` therefore picks one base --
  whichever represents the requested STEP most closely, ties to the finest -- and
  snaps start, stop **and** step to multiples of it, which makes every visited
  frequency a multiple of that base and so present by construction. Because the
  base depends on the step, the three cannot be snapped independently;
  `_apply_freq_grid()` re-snaps all three from the values that were *requested*
  (`_req_start/_req_stop/_req_step`), so the result does not depend on the order
  the panel sets them in and does not drift when re-snapped.
- **`_build_sweep_grid` now looks up BY FREQUENCY, not by arithmetic.** It used to
  compute `start_idx + i * (step / QT_MASTER_STEP)`, which is only valid on a
  uniform table. Against the union grid that silently addresses the wrong
  profiles -- retuning each step to some other frequency while reporting the one
  asked for, the same class of failure the profile-cap check exists to prevent. It
  is `np.searchsorted` plus an **exact-match assertion that raises**: a frequency
  not in the table fails loudly rather than retuning to its neighbour.

**Rounding is half-up on both sides, deliberately.** Python's `round()` is
banker's and JavaScript's `Math.round` is half-up, so the two disagreed on exactly
the `.5` cases (50/20 -> 2 on the Pi, 3 in the browser). `_round_half_up()` in
`sfcw_engine.py` makes them identical; `master_grid_freqs()` and `_snap_sweep()`
are pure and can be checked without hardware.

**The groundstation mirrors all of this in `lib/sfcwGrid.js`.** The Pi never
reports its parameters back -- the panel is the source of truth and pushes -- but
`set_params` silently snaps, so `SfcwPanel` was computing R max, step count and
sweep time from what was typed rather than what would run. It now snaps the whole
triple on commit (`commitSweep`, mirroring `_apply_freq_grid`) so the field shows
what will actually run, and derives every readout from the snapped values as a
backstop. **Keep `sfcwGrid.js` in sync with `QT_MASTER_STEPS` / `_snap_sweep` /
`_round_half_up`** -- verified by generating 2500 cases from the Python and
asserting the JS reproduces all three outputs exactly, plus that every snapped
sweep lands entirely on the union grid.

**Hard ceiling: `MAX_QUICK_TUNE_PROFILES = 256`, do not exceed it.** The first version of
this table tried 1–6 GHz at 10 MHz spacing (501 profiles) and it was broken: verified
against libbladeRF's own source on the Pi
(`~/bladerf-src/host/libraries/libbladeRF/src/board/bladerf2/bladerf2.c:1419-1513`),
`bladerf_get_quick_tune()` is not a stateless read — every call *writes* a new fastlock
profile into a fixed-size on-device table (`board_data->quick_tune_tx/rx_profile`, capped
at `NUM_BBP_FASTLOCK_PROFILES = 256` in `fpga_common/include/bladerf2_common.h`, one shared
counter per direction across both TX/RX sub-channels). That counter only resets on a full
`bladerf_open()`. Past 256 calls it returns `BLADERF_ERR_UNEXPECTED` and leaves the profile
struct unpopulated — the original code didn't check the return code, so it silently stored
zeroed/garbage profiles for every frequency past the 256th, which `bladerf_schedule_retune()`
would then happily retune to the wrong RF state. Symptom on stdout: a wall of
`[ERROR @ .../bladerf2.c:1427/1456] Reached maximum number of TX/RX quick tune profiles.`
repeated once per frequency past the cap, on every `start.py` run. `_ensure_master_quick_tune_table()`
now raises immediately if `len(freqs) > MAX_QUICK_TUNE_PROFILES` (compile-time check) or if
`bladerf_get_quick_tune()` ever returns nonzero (runtime check) — fail loud, never store an
unchecked profile. 2–5 GHz at 20 MHz is 151 profiles, comfortably under 256.

Consequence: the sweep range is hard-bounded to 2–5 GHz (panel Start/Stop min/max 2000/5000
MHz) — anything requested outside that gets clamped, and step size floors at 20 MHz. Steps
that are a multiple of 20 or of 50 MHz are exact; anything else snaps to the nearest of
those (30→40, 45→40, 55→60, 90→100). Widening
either means trading against the 256-profile ceiling (span_MHz / step_MHz + 1 ≤ 256) — there's
no way to have both a wide range and fine resolution simultaneously on this hardware without a
different strategy (e.g. a lazy per-frequency cache with a reset-triggered eviction, discussed
and deferred 2026-08-23 in favor of just picking a range/step that fits).

**Default step size is 60 MHz (51 steps, 2–5 GHz)** — `sfcwParams.stepSize` in
`App.jsx` and `SFCWEngine.step_size` both carry it, and the groundstation pushes its
value to the Pi on connect (see the param-push note above).

## C-Scan Panel — 2D Raster (replaced the B-scan panel, 2026-08-20)

The B-scan panel is gone; `CscanPanel.jsx` + `CscanDisplay.jsx` + `lib/cscanGrid.js`
replace it. Panel id is `cscan` (was `bscan`). App-level state keeps its `bscan*` names
(`bscanData`, `bscanParams`, …) because the underlying record is still one B-scan trace
per position — only the panel and its geometry changed.

**Grid.** `bscanParams` is now `{ hCount, hStep, vCount, vStep, gateStart, gateEnd,
metric }` (it carried a `maxDepth` until 2026-08-31; see the C-scan imaging section). `stepSize` / `numPositions` are gone; SAR and the 2D Map are 1D and
read `stepSize: hStep` (injected in `sarParams` / `mapStepSize`) with the position count
taken from the data length as before. The Scan Grid section sits between Session and
Capture so the rectangle is described before any sweep is tagged.

**Snake raster order** (`lib/cscanGrid.js` `cellForIndex`). Capture starts at the
bottom-left cell, sweeps the bottom row left→right, steps up one row, sweeps right→left,
steps up, and repeats. Verified: a 3×2 grid captures (0,0) (4,0) (8,0) (8,6) (4,6) (0,6)
for hStep 4 / vStep 6. Every position stores `grid_ix`, `grid_iy`, `x_cm`, `y_cm`,
resolved from the capture index at capture time in the `sfcw_result` handler (via
`bscanParamsRef`), so editing the grid afterwards never relabels existing cells. Lidar
standoff is captured per cell exactly as before.

**Display.** The viewport is Live Sweep (top) over the C-Scan Grid, which holds the
whole remaining area on its own; clicking a cell opens that row's B-scan UNDER it,
rotated 90 degrees anticlockwise and aligned to the grid's columns (2026-09-06, see
"C-scan plan view" below). The grid is a plan view holding the physical aspect ratio, colour =
`gatedIntensity()` over the depth gate (peak / energy / mean), drawn live as cells fill.
Uncaptured cells are outlined and empty; a cell captured with no range bin inside the gate
is mid-grey, distinct from uncaptured. The next target pulses cyan, the snake path is
dashed over the captured cells, and clicking a cell picks the row shown in the B-scan pane
(that pane sorts the row by `grid_ix`, so a right→left row still reads left→right).

**Colour scaling** is one `{ dynamic, min, max }` object shared by both panes. Dynamic
tracks the captured cells; switching to manual seeds the sliders from the current dynamic
limits so colours do not jump, then the two dB sliders drive both images live. The sliders
are disabled and dimmed while dynamic is on, and the colour bar turns amber and reads
MANUAL when it is off.

**Export is v6** (`cscan_<ts>.json`): grid params (now including `scanMode` and the rover
origin offsets as provenance) plus per-position `grid_ix` / `grid_iy` / `x_cm` / `y_cm`, and
for rover-driven cells the reported and commanded rover position. Import accepts v3–v6; a v4
(or earlier) linear scan maps onto a one-row grid (`hCount = numPositions`,
`hStep = stepSize`, `vCount = 1`). `scanMode` is deliberately not restored on import.

**Capture order is mode-dependent** (2026-08-29): by hand it snakes up from the bottom-left
as described above; under the rover it snakes down from the top-left. Cell indices are the
same either way — only the order the cells are visited differs. See "Rover-driven C-scan
raster".

**Known limitation:** SAR and the 2D Map still treat the capture sequence as a single line.
With `vCount = 1` that is exactly the old behaviour; with more rows their input is a
zig-zag path and the reconstruction is not meaningful until they are made grid-aware.

## BG Model — Capture Protocol and Findings

**Capture protocol (as of 2026-08-18).** One capture = N sweeps at a **static** standoff
(N configurable in the BG Model panel, default 40, persisted to `localStorage.bgmodel_sweeps`).
Positions are hand-placed and deliberately **irregular**; irregular beats uniform, because
uniform undersampling folds alias energy coherently onto a single wrong spatial frequency
while irregular spacing scatters it. Target: ~30 positions over the widest span the bench
allows (150 mm+).

`bgCaptureStats.computeCaptureStats()` runs at capture completion and stores, per position:
coherent complex mean (`h_mean_real/imag` — this is the training target), per-frequency noise
variance, per-sweep and post-averaging SNR, sweep-pair correlation, standoff mean/std, and
`radarRangeM` (range of the dominant return from the coherent mean, sub-bin interpolated).
`radarRangeM` is **diagnostic only** — nothing consumes it. It exists so the dataset carries an
independent standoff estimate to check the lidar against.

Training now uses **one sample per position** (the coherent mean), not every raw sweep. Replicas
measure the same standoff repeatedly, so feeding them individually adds no information — MSE
regresses to this mean anyway, at N× the epochs.

**Spacing limits** (`spacingLimits()`). An echo with path multiplier α oscillates in standoff
with period `c / (2·f·(α−1))`; worst case is α=3 (triple bounce) at the top of the band. At
5 GHz that period is 15 mm, so:
- ≤ 5 mm gaps — well sampled
- 5–7.5 mm — coarse but unaliased
- Above 7.5 mm — α=3 folds onto a wrong spatial frequency and *corrupts* a fit rather than missing detail

**Span sets echo resolution:** `Δα = c / (2·f_c·span)`. At 3.5 GHz, 85 mm span → Δα = 0.50;
150 mm → 0.29. Widest possible span is the single biggest accuracy lever.

**Export format v2** (`bgmodel_<N>pos_<ts>.json`): hoists `common` (num_steps, step_size,
range_offset) out of the per-sweep repetition and stores per-capture `stats` + column arrays
(`standoffs`, `real`, `imag`). ~7 MB for 30 positions × 40 sweeps. Import accepts v1 and v2 and
backfills stats when absent.

**Analysis of the existing MLP** (1 → 64 → 64 → 302 ReLU, 23,918 params, `bgmodel.worker.js`):
- Output is effectively **rank ~5** — SVD over the input domain puts 96% of energy in 5 PCs,
  in near-equal quadrature pairs (the signature of complex sinusoids in `d`). 19,328 of its
  parameters describe a rank-5 map.
- Only 13/64 first-layer knots land inside the input domain; 32/64 L1 and 17/64 L2 units are
  dead across the whole domain.
- Per-frequency residual magnitude spans **20 dB**, so pooled scalar target normalization makes
  MSE a silently power-weighted loss that starves the weak bins.
- `finalLoss` is training MSE with no held-out split anywhere. Param:data ratio was 0.32:1.
- Inference is 19.3 µs (~52k/s), ~1700× headroom at 30 fps. Sweeps run at 3–6 Hz, so the model
  is nowhere near the bottleneck — **data, not compute, is the constraint.**

**Lidar precision is the hard ceiling.** Two-way phase is `4πfd/c`, so at 5 GHz **1 mm of
standoff error = 12° of phase error**. 20 dB of coherent suppression needs the standoff to
~0.5 mm; the TF-LC02 is a ±few-mm sensor. Comparing `radarRangeM` against `standoffMm` across
the new dataset is the cheap test of whether a radar-derived standoff beats the lidar.

**Result on the 30-position bench set (2026-08-18) — the MLP was replaced.**
Leave-one-position-out suppression, `10*log10(signal/error)` on each held-out position's
measured spectrum, 30 positions over 155.8 mm, median gap 5.5 mm, 15 sweeps each:

| estimator | LOO suppression |
|---|---|
| **Akima interpolation, unwind α=0.80** (shipped) | **20.2 dB** (median 20.3, worst 4.0) |
| cubic spline, α=0.80 | 20.3 dB — best mean, but −12.3 dB on a bad knot |
| physics model, K=5 echoes, free A(f) | 18.7 dB |
| linear interpolation | 12.4 dB |
| Fourier-feature MLP (tanh, k=8..64) | 11.9 dB |
| nearest position | 7.4 dB |
| physics model, K=3, Chebyshev A(f) | 6.8 dB |
| **old 1-64-64-302 MLP** | **4.9 dB** |
| global mean | 0.9 dB |

The captures are dense relative to how fast the background varies, so interpolation wins
outright and needs no parameters. `bgModelInterp.js` ships Akima: it gives up 0.6 dB of mean
for a 16 dB better worst case, because it does not propagate a bad capture into neighbouring
intervals. Inference is 3.1 µs (320k/s, ~10,000× headroom at 30 fps); model file ~360 KB.
Models are `type: 'interp'`; `bgModelInfer.js` keeps the MLP path for previously saved files.

**Things that turned out differently than expected:**
- **The old MLP was underfitting, not overfitting.** 2000 full-batch epochs reached only
  7.97 dB in-sample; 10k → 12.0 dB, 40k → 13.3 dB. Its `finalLoss` looked small only because
  targets were normalized by a single pooled scalar. Its loss curve was still falling 7.4%
  per 100 epochs at epoch 1999. Verified by scoring the saved `models/model 3.json` weights
  directly: 8.6 dB in-sample, matching the numpy re-implementation used for the LOO sweep.
- **The unwind is better with α ≈ 0.80 than α = 1.0** (20.5 dB vs 19.1 dB), a broad plateau
  over 0.70–0.85. Unwinding removes fast phase but injects the lidar's own error into the
  target; 0.8 is the trade-off point. The α matched filter puts the wall echo at 0.93–0.95,
  consistent with the lidar over-reporting standoff *change* by 5–20%. Worth a calibration
  check, but not required — the interpolator absorbs it.
- **The `radarRangeM` diagnostic is unusable**: correlation 0.36 with lidar standoff, 39.9 mm
  scatter after a linear fit. Dominant-peak picking hops between echoes in the near field.
  Radar-derived standoff is not a usable input; the near-field skepticism was correct.
- **Echo structure is dominated by two components**: α≈0.0 (static cable/coupling reflection,
  strongest) and α≈0.93 (wall face, −3.4 dB). Everything else is ≥13 dB down. But a smooth
  (Chebyshev) `A_k(f)` caps the physics model at ~7 dB; with `A_k(f)` free per frequency it
  reaches 18.7 dB. The unmodelled echoes get absorbed into `A_k(f)` as fast frequency
  structure, so `A_k(f)` is *not* smooth.
- **A physics + spline hybrid gives exactly no gain** over the spline alone (20.60 vs 20.59 dB).
- **Measurement noise is not the limit.** The 15-sweep coherent mean sits 47.1 dB below signal.
  Position density is the limit.

**Position density is the dominant lever** (cleaned 22-position set, subsampled):

| median gap | LOO suppression |
|---|---|
| 5.9 mm | 19.3 dB |
| 11.8 mm | 6.9 dB |
| 17.7 mm | −3.3 dB |

Roughly 12 dB lost per doubling of gap. Capture as densely as patience allows; this matters
far more than any modelling choice.

**Range gating cannot separate in-wall targets from the wall face at this bandwidth.** The
entire background sits within 2–6 cm of range, and 3 GHz of bandwidth gives ~50 mm range
resolution. The "gated" metric therefore tracks the full-band metric closely. Separating a
target from the face needs more bandwidth or aperture, not better background subtraction.

## BG model continuous capture: wave the module, bin by standoff (2026-09-07)

Manual BG-model capture used to be park / press Capture / hold still for 40 sweeps /
move / repeat. That protocol existed because a sweep was ~550 ms, so any motion during
one smeared it across frequency. At **36 Hz a sweep is 27.5 ms**, so the constraint has
inverted: the positions can be swept continuously and hand-placement -- which was capping
median gap at ~5 mm, and density is the dominant accuracy lever at ~12 dB of LOO
suppression per doubling of gap -- stops being the bottleneck.

**Continuous Capture** toggle in the BG Model panel's Capture section, manual mode only.
Start it, sweep the module slowly across the span, stop it. Each sweep is filed under the
standoff it was actually taken at into a fixed bin, and **each occupied bin becomes exactly
one "capture" in the existing `{samples, stats}` shape** -- so coverage analysis, export
v2, `buildInterpModel`, `evaluateLoo` and the trainer are all untouched and cannot tell a
continuous position from a hand-placed one. `lib/bgContinuous.js` (pure),
`createContinuousAccum`; App state is `bgContinuousRef` / `bgContinuousActive` /
`bgContinuousStats`.

### Standoff is INTERPOLATED from the lidar track, and this is the whole accuracy story

The TF-LC02 measures at 11-17 Hz against 36 Hz sweeps, so most sweeps contain no new
measurement and `App.jsx` carries the last one forward (`LIDAR_CARRY_MS`, 1 s) so the live
display does not strobe. Stapling that carried reading to a MOVING sweep is a pure lag,
and therefore a **direction-dependent bias** -- the sign flips when the pass reverses, so
an out-and-back wave lays the same physical standoff down in two places, which is exactly
what a coherent background model cannot absorb.

Measured on a simulated 60 s out-and-back pass at 25 mm/s (14 Hz lidar with 0.4 mm noise,
36 Hz sweeps, scored against known truth):

| standoff from | rms error | out-and-back bias | sweeps kept |
|---|---|---|---|
| carried reading, unfiltered | 0.851 mm | **1.100 mm** | 100% |
| fresh-reading filter (`lidar_n > 0`) | 0.445 mm | 0.016 mm | **38%** |
| **interpolated (shipped)** | **0.322 mm** | 0.041 mm | **99%** |

**The fresh-reading filter is not a bad answer and it is worth understanding why, because
it is not obvious:** a measurement that landed inside the sweep's own window is on average
at that sweep's midpoint, so requiring one gives an UNBIASED standoff, not merely a
bounded-lag one. What it costs is that only ~38% of sweeps have one, plus +/- half a sweep
period of jitter on the survivors. Interpolating between the measurement before the sweep
and the one after is unbiased as well, keeps ~99% of sweeps, and is quieter on top because
it averages two measurements where the filter takes one. On the same simulation the
resulting model's LOO suppression went **39.8 -> 46.2 dB**.

The first version of this panel shipped the fresh-reading filter. Both are correct; the
interpolation is 2.6x the looks per bin and 28% less standoff error for the same run.

**What is deliberately NOT corrected: the sensor's own publication lag** -- the fixed
offset between the middle of its integration window and the value appearing on the wire.
That is a constant time offset, so it is again a direction-dependent position bias, and it
has never been measured. Rather than guess it, every accepted sweep records
`lidar_v_mm_s` (SIGNED), so an out-and-back run contains both directions at the same
standoff and the lag can be solved for offline from an export: find the tau that makes the
outbound and return knots agree.

### Why the Pi now polls the lidar at 200 Hz, and why that is NOT "more measurements"

Asked 2026-09-07: why not raise `LIDAR_POLL_HZ` from 20 to 40 to get more data? **You
cannot -- 11-17 Hz is the sensor's own measurement cadence.** Already measured directly:
polling at 584 Hz gives a **median run of 34 identical consecutive polls** (584/34 = 17 Hz
of real measurements), and Phase 1.1 measured **17.2 Hz at 165 mm, 11.5 Hz at 262 mm,
11.5 Hz at 340 mm**. That it gets SLOWER with distance is the tell: adaptive integration
time, not a settable frame clock. There is no register to write and no way to ask for more
photons.

What a fast poll DOES buy is a tight **timestamp**, which is what the interpolation needs.
At 20 Hz we learned a measurement existed up to 50 ms late (1.25 mm at 25 mm/s); at 200 Hz
it is 5 ms. So `LIDAR_POLL_HZ = 200`, and it is free -- measured 2026-08-27 at 584 Hz:
broadcast 48.35 vs 48.79 Hz, IMU rate slightly BETTER at 33.83 vs 32.66 Hz.

**The change that makes that safe is that `lidar_seq` now counts MEASUREMENTS, not reads.**
It advances only when the value CHANGES (or when a stable value ages past
`LIDAR_STABLE_REPUBLISH_S = 0.25`). Publishing 200 reads/s of a 14 Hz value would have made
`App.jsx`'s `lidar_n` count duplicates and `lidar_std` measure the spread of a repeated
number -- the "repeats deflate the spread" fiction the old 20 Hz cap existed to avoid. The
new counter is also more honest than the old one WAS at 20 Hz, where 20-40% of reads were
already repeats.

Value-change detection is unreliable on a static target (1 mm quantisation against
0.66-0.78 mm raw sigma, so ~40% of consecutive measurements land on the same integer) --
hence the republish timeout, chosen well above the slowest observed internal period (~87 ms)
so it can never fire between two genuinely-new measurements. Where it fires, the true
spread over the window really is ~zero, so the repeat is not a lie.

### The two filters that remain

1. **NOT BRACKETED.** No interpolant exists if the sweep's time is not spanned by two
   measurements within `MAX_BRACKET_GAP_S = 0.25`. The lidar going quiet is real (bursts of
   invalid returns at a poor target angle are documented at 30-40% of reads on this bench),
   and a straight line across the hole would invent a trajectory. Dropped, never
   extrapolated -- including the last sweep or two of every run, which have no measurement
   after them.
2. **TOO FAST.** Frequency steps are sequential, so standoff changing DURING a sweep is a
   phase ramp across the band -- a smear interpolation cannot fix either, because the sweep
   genuinely does not describe one position. 40 mm/s at 27.5 ms is 1.1 mm. **Speed is a
   least-squares slope over a 350 ms window of the track, not a consecutive difference** --
   0.4 mm of lidar noise across a 70 ms gap is ~6 mm/s of phantom speed on its own.
   Verified: a static rig with realistic noise gives zero motion rejects at a 40 mm/s limit.
   `0` disables the gate.

### Wave speed sets PER-PASS granularity; passes then fill the gaps

Within one pass a measurement lands every `v * lidar_period`. Measured: a single 12 mm/s
pass leaves a **1 mm** hole, a single 40 mm/s pass leaves **13 mm**. But over many passes
it fills anyway -- the lidar cadence and the pass timing are incommensurate, so each pass
samples different phases, and a 60 s run at 40 mm/s closes to a 1 mm hole just like the
slow one. **A fast wave is not broken, it just needs more passes.** Watch Hole, not Span;
Span only says how far the pass reached.

### Numbers and the knob that is not obvious

Simulated 60 s pass, 25 mm/s over 120 mm: **2184 sweeps -> 2152 kept (99%) -> 121 bins at
1 mm, largest hole 1 mm**, median bracket 71 ms, against ~30 hand-placed positions at
~5 mm. Build 7 ms, `evaluateLoo` 179 ms, model JSON 0.50 MB (n^2*S, so watch it if bin
width ever goes far below 1 mm over a wide span).

**Bin width floors at 0.5 mm because `bgModelInterp.js` `MERGE_MM` is 0.5** -- finer bins
cannot make a finer model, they just split the same looks across knots the interpolator
then re-merges with fewer sweeps each. Note the knot count can also come out **below** the
bin count: a knot sits at the MEAN of its bin's samples, not at the bin centre, so two
adjacent bins can land inside 0.5 mm of each other and get merged. Harmless.

**The trade against static capture is looks per knot, and it is worth taking.** A static
position gets 40 sweeps; a bin in the run above gets ~18. That costs `10*log10(40/18)` =
3.5 dB off a measurement-noise term worth only ~5 dB in the first place (the 2026-08-28
regime decomposition: single-sweep noise 5.16 dB, standoff noise 0.37 dB), while buying 2+
doublings of density at ~12 dB each. If a run comes out thin, pass again -- do not raise
the cap expecting it to fill bins that were never visited.

### Wiring notes

- **Two websockets, one clock.** The lidar track arrives on 9001 and the sweeps on 9003,
  and they are matched on the Pi's `time.time()` -- `lidar_ts` from `stream.py` and
  `sfcw_result.timestamp` from `sfcw_engine.py` are the same clock. Do not switch either
  to `time.monotonic()` without fixing the other.
- **The sweep's own timestamp is stamped at its END**, so the interpolation asks for the
  standoff at `timestamp - period/2`, with the period a running median of adjacent sweep
  intervals (median, not mean, so one stalled frame does not move it -- same choice
  `Viewport.jsx`'s `useSweepRate` makes). 14 ms at 36 Hz, i.e. 0.35 mm at 25 mm/s -- the
  same order as the lidar's own noise, so worth removing rather than ignoring.
- **A run's first sweeps must NOT fall through to the legacy path.** The track is empty
  until the first measurement lands, ~14 sweeps at 36 Hz, and filing those by their carried
  standoff is the exact error this module exists to remove. Sweeps are held pending, and
  the legacy path latches only after `LEGACY_DECIDE_S = 1.5` of sweeps with no measurement
  at all (or at flush), which is a Pi that does not publish `lidar_ts`. The panel says so
  when it happens.
- The accumulator is a **ref**, and the panel is fed by a 250 ms interval, because a
  per-sweep `setState` would re-render the sidebar 36 times a second to move a counter.
  Same reason `sfcwDynamicScale` and the C-scan layout are refs.
- **The run is harvested on ANY end** -- the toggle, the session stopping, a sweep error
  (all three collapse to `sfcwRunning` going false) -- not only on the toggle. A minute of
  waving is expensive to redo and a dropped session is exactly when losing it would hurt.
- Continuous captures carry a `batch` id and **Undo Last drops the whole run**, since
  undoing a 120-bin harvest one bin at a time is not a control anyone would use.
- Continuous and the static per-position capture are mutually exclusive, both in the UI
  and guarded in `handleBgModelAction`.
- Each stored sample keeps `lidar_standoff_live_mm` (what the live path would have said)
  beside the interpolated `lidar_standoff_mm`, plus `lidar_v_mm_s` and `lidar_bracket_s`.
- `analyzeCoverage` is memoized in the panel and the per-position row list is capped at 80
  rows: the panel re-renders at the LIDAR rate (the live standoff readout), and a
  continuous run turns 30 rows into a few hundred.
- Rover mode is unchanged; continuous is manual-only (the rover already places positions
  precisely, which is the problem continuous exists to solve).

### The per-bin dB number, and why some bins read 330 dB or negative (2026-09-07)

The number beside each position in the Coverage list is `snrDbAveraged` from
`bgCaptureStats.computeCaptureStats`: the coherent (complex) mean of that bin's sweeps
against the scatter about it, plus `10*log10(n)` for the averaging. Roughly 30 dB at n=2
rising to 44 dB at n=40 on a healthy bin. Two ways it went wrong, both found from a live
run and both now fixed.

**330 dB was a bin with exactly ONE sweep.** With n=1 the variance about the mean is
exactly zero -- the sample IS the mean -- so the score is 0/0 and the `|| 1e-30` guard
turned it into `10*log10(sigPow/1e-30)` = **317-330 dB** depending on `|h_cal|`. Coherence
came out exactly 1.0 with it, so the panel painted those bins GREEN. The least trustworthy
position in the set was displaying as the best one, and `BgModelDisplay`'s SNR axis scaled
itself to 330 dB, flattening every real bar into the bottom eighth of the chart. Static
capture never produced an n=1 position, so this could not happen before continuous capture;
now it happens wherever the pass was moving fastest. `computeCaptureStats` returns **null**
for `snrDbPerSweep` / `snrDbAveraged` / `coherence` when `n < 2` -- undefined, not
infinite. Both consumers already handled a null SNR; the chart now paints an unscoreable
position neutral grey, and the panel shows `-` plus the sweep count. **The sweep count
(`xN`) is now displayed next to every position**, which is the number that explains the
score.

**Negative dB was a thin bin containing a CORRUPTED sweep.** The radar throws the odd
garbled sweep -- 0.46% idle and 2.05% under client load on the 2026-09-06 measurements,
plus the NIOS path's ~1.4% fallbacks -- so a 60 s run at 36 Hz (~2200 sweeps) contains
tens of them. The static protocol diluted one across 40 good sweeps; a continuous bin
holding 2 or 3 does not. Measured with one garbage sweep injected:

| bin size | 2 | 3 | 5 | 10 | 18 | 40 |
|---|---|---|---|---|---|---|
| score with one corrupted sweep | **-0.1 dB** | 3.7 | 10.6 | 16.8 | 21.9 | 29.1 |

so the damage is worst exactly where continuous capture is thinnest, and the bin's
coherent mean becomes a corrupted KNOT -- which is what the leave-one-out scoring reports
as a weakest knot, and what Akima was chosen to stop propagating into its neighbours.

`bgContinuous.toCaptures()` now screens each bin: every sweep is scored by its **median**
complex correlation against the others and dropped below `BIN_AGREE_MIN = 0.90`.

- **Median against the others, not correlation against their mean** -- a mean is dragged
  by the very outlier being looked for, a median is not.
- **0.90 sits in a very wide empty gap.** Sweeps of the same scene inside one 1 mm bin
  correlate >0.99 (the wall term rotates only ~12 deg per mm at 5 GHz, single-sweep SNR is
  ~21 dB), while a garbled sweep has random phase per step and correlates ~1/sqrt(51) =
  0.14. Verified that genuine within-bin standoff spread is never screened.
- **n < 3 is left alone.** With two sweeps that disagree there is no way to say which is
  wrong, so both are kept and the bin's own (negative) score is left to report it rather
  than the code guessing.
- **A bin where nothing agrees with anything is kept whole.** That is not one outlier, and
  silently deleting the position would put a hole in the model instead of a visibly bad
  knot.

Measured on a simulated 60 s run with 1.5% corruption injected: **34 of 34 corrupted
sweeps caught, 0 negative bins, worst bin 37.8 dB against a median of 39.3.** The count is
reported in the harvest line.

### Wave speed: 40 mm/s was too conservative, the default is now 100

The first default came from a smear budget of ~1 mm per sweep, picked before the cost of
smear had been worked out. Working it through: a sweep steps frequency sequentially, so
motion during it puts both a quadratic phase term (defocus) and a linear one (an apparent
range shift) on the echo. Defocus is negligible -- it does not reach the classical pi/4
until ~6.7 mm of motion -- so the binding term is the range shift, which is
direction-dependent like every other lag in this system.

Measured by synthesising a sweep with a per-step standoff and finding the static standoff
whose spectrum best matches it:

| speed | 20 | 40 | 60 | 100 | 150 | 250 | 400 mm/s |
|---|---|---|---|---|---|---|---|
| motion during one sweep | 0.55 | 1.10 | 1.65 | 2.75 | 4.12 | 6.87 | 10.99 mm |
| **apparent standoff error** | 0.08 | **0.15** | 0.23 | **0.38** | 0.56 | 0.93 | 1.48 mm |
| match to the static background | 40.6 | 34.6 | 31.0 | 26.6 | 23.1 | 18.8 | 14.8 dB |

The lidar interpolation's own residual is 0.32 mm, so **anything under ~100 mm/s is not
the limiting term**; 150+ starts to be, and the "match" column is a ceiling on what a
model built from moving sweeps can achieve (bench LOO is 20-26 dB, so 100 mm/s does not
bind and 250 would). Default raised 40 -> 100 mm/s.

**The sweep-MIDPOINT labelling is what makes that affordable.** Labelled by the Pi's
end-of-sweep stamp instead, the same table reads 0.40 mm at 40 mm/s and 1.00 mm at 100 --
2.7x worse. The two corrections compound: interpolating the lidar track fixes where the
sweep was, and the midpoint fixes when.

The localStorage key is versioned (`bgmodel_cont_max_speed_v2`) so browsers that already
ran the panel pick up the new default rather than keeping a value chosen on a wrong basis.

**Speed still sets PER-PASS granularity** and that is unchanged: a measurement lands every
`v * lidar_period`, so one 100 mm/s pass spaces them ~7 mm apart and cannot fill 1 mm bins.
Further passes do, because the lidar cadence and the pass timing are incommensurate. Watch
Hole; a fast wave is not broken, it just needs more passes.


### Verification

`lib/bgContinuous.js` is pure and was exercised head-first from node (53 checks: the
interpolant against hand-computed values, both no-extrapolation directions, refusal to
interpolate across a quiet lidar, the sweep-midpoint correction, the motion gate at 200 vs
20 mm/s and its signed velocity, a static rig with 0.4 mm lidar noise giving zero false
motion rejects, binning and the cap, negative standoffs, capture ordering, hole detection
distinct from span, the legacy latch and that a run's start is NOT given to it, the
bin-width floor, the three-arm accuracy comparison above, per-pass vs multi-pass hole
filling, and a full 60 s simulated pass built through `buildInterpModel` + `evaluateLoo`).
There is still no test runner in this repo, so these were throwaway scripts. `vite build`
passes and `stream.py` parses.

**Not yet run on hardware.** Three things to check on the bench: that the 200 Hz poll and
measurement-counting `lidar_seq` behave as expected in the live stream (watch the panel's
Lidar readout -- median bracket should sit at 60-90 ms), that "no bracket" rejects stay
near zero, and that a hand pass can be held under 40 mm/s. If the motion reject count is
large, slow down before raising the limit: it is a smear budget, not a preference.

## Background subtraction: standoff instrumentation and the false-target hunt (2026-08-28)

Investigating false targets (spurious returns where there is nothing) from the Akima
interpolating background model (`lib/bgModelInterp.js`), which scores 20.2 dB
leave-one-position-out on the bench but misbehaves live.

### `LIDAR_ANTENNA_OFFSET_MM` was 315 mm and that is wrong for this mounting — now 160 mm, and user-editable

**Measured on the bench 2026-08-28:** with the antenna aperture at the wall (true zero
standoff) the TF-LC02 reads **164.83 mm ± 0.68**. So the lidar→antenna offset is ~165 mm,
not 315 mm. The default is now **160 mm** (measured − 5 mm, so a real zero-standoff pose
reports slightly positive rather than negative), it lives in App.jsx state persisted to
`localStorage.lidar_antenna_offset_mm`, and it is editable in the SFCW panel's Standoff
section. **It is a per-mounting quantity — re-measure it after any re-mount** by putting
the aperture against the wall and reading the lidar.

Consequences worth understanding, because they are not all the same:
- A *constant* offset error **cancels exactly** for a model trained and used under that
  same offset: the unwind factor is common to every knot, factors through the linear
  interpolation, and is undone by the rewind. So the wrong 315 did not, by itself, break a
  freshly-trained model — which is consistent with the reported observation that fresh
  models fail the same way. Do not expect fixing the offset alone to fix false targets.
- What it *did* break is every standoff number being unphysical (150 mm behind the actual
  aperture), and any model built under a *different* offset being silently mis-indexed.
  `models/4th model.json` has knots spanning 11–167 mm; under the 315 offset the operating
  standoff is `lidar − 315`, and since the lidar reads ~165–315 mm in real use, that is
  −150…0 mm — **entirely below the model's span, so it clamped on every single sweep**,
  subtracting a background measured somewhere the rig never goes. That is a genuine
  false-target mechanism, and it was completely invisible: `inferInterpModel` clamps
  silently and the live SFCW path had no span check at all.

**The brief's premise that the operating range is 326–482 mm was wrong**, and so was the
claim that the earlier 164 mm noise characterization was "measured at the wrong distance".
164 mm *is* the zero-standoff position. Real operation is lidar ≈ **165–315 mm**.

### Phase 0 — instrumentation (no compensation math was changed)

`pi/sensors/stream.py`:
- `lidar_poll_loop` is capped at `LIDAR_POLL_HZ = 20` (was uncapped, measured **584 Hz** for
  a sensor whose internal measurement only updates at ~11–17 Hz). `--lidar-rate 0` restores
  the old uncapped behaviour for comparison. Measured effect: broadcast rate unchanged
  (48.79 → 48.35 Hz), IMU update rate unchanged/slightly better (**32.66 → 33.83 Hz**).
- Packet now carries `lidar_seq` (increments per *successful read*) and `lidar_ts`. At
  20 Hz the seq sequence seen by a client is contiguous — every reading reaches a packet.

**SUPERSEDED 2026-09-07 on both counts: `LIDAR_POLL_HZ` is now 200, and `lidar_seq`
increments per distinct MEASUREMENT rather than per read.** The reasoning above is still
correct as far as it goes — polling faster genuinely cannot produce more measurements — but
it treated the poll rate as buying only data, when it also buys the measurement's
TIMESTAMP, which is what continuous BG capture interpolates against. Publishing every read
at 200 Hz would have reintroduced exactly the `lidar_n`/`lidar_std` fiction this section
describes, which is why the counter had to change with it. See "BG model continuous
capture" below.

`App.jsx`:
- `lidarAccumRef` dedupes by `lidar_seq` before averaging. Measured against live packets:
  **13.01 → 5.27** accumulated samples per 250 ms sweep. Without this, `lidar_std` would be
  fiction (repeats deflate the spread) and readings would be weighted by how long they
  happened to be held.
- Every sweep record, C-scan cell and BG-model sample now carries `lidar_n`, `lidar_std`,
  `lidar_offset_mm`, `roll_deg`, `pitch_deg` via one shared `provenance` object, so the
  three record types cannot drift apart. Pose is tilt-from-gravity (accel is body-frame
  [forward, left, up]); no yaw, which gravity cannot observe.
- `processedSfcwResult` became `sfcwProcessed = { result, diag }`. Every path that declines
  to subtract now reports a reason, the out-of-span/clamp case is detected and reported
  (matching `CscanPanel.jsx`), and a running clamp fraction is kept. The SFCW panel shows
  "BG applied: YES / YES (CLAMPED) / NO" plus the reason — **"a model is loaded" and "the
  model was applied" are different statements** and only the second is now visible.
- Models record a `geometry` stamp (`lidarAntennaOffsetMm`, full `sfcwParams`, `builtAt`)
  in `bgmodel.worker.js`; the panel warns visibly when a loaded model's stamp disagrees
  with current settings, and says so distinctly for pre-stamp models where it cannot tell.

### Phase 1.1 — LiDAR noise across the real operating range

`pi/sensors/lidar_noise_char.py` (keepable tool). 40 s per distance, 584 Hz polling,
**100% valid reads (`error_code=0`) at every distance**, 1 mm quantisation:

| lidar reads | σ(τ=250 ms, one sweep) | internal update | autocorr half-life | raw σ |
|---|---|---|---|---|
| 164.8 mm (standoff 0) | **0.396 mm** | 17.2 Hz | 37 ms | 0.68 mm |
| 261.7 mm (standoff ~100) | **0.433 mm** | 11.5 Hz | 45 ms | 0.66 mm |
| 339.7 mm (standoff ~180) | **0.560 mm** | 11.5 Hz | 58 ms | 0.78 mm |

σ degrades only mildly with distance. Averaging follows σ ∝ τ^−0.12…−0.30, far shallower
than white noise's τ^−0.5, and plateaus by ~2 s — so **longer averaging does not rescue
it**; there is a correlated/drift floor around 0.15–0.33 mm.

### Phase 1.2 — the oracle test says this is NOT standoff-limited

Reconstructed the 29 training spectra from `models/4th model.json` by rewinding its stored
unwound knots, then for each position built a leave-one-out model and searched standoff
over ±15 mm (0.05 mm grid; ±15 mm is the unambiguous window, two-way λ/2 at 5 GHz = 30 mm)
for the standoff maximising suppression. The numpy port reproduces the browser's own stored
LOO numbers to **1.1e-14 dB**, so the port is not the variable.

- Suppression at the recorded lidar standoff: **20.22 dB** mean.
- Suppression at the *oracle* standoff: **23.19 dB** mean. **The oracle buys only 3.0 dB.**
- `d_oracle − d_lidar` is **zero-mean** (−0.10 mm, σ 1.88 mm, t = −0.30 on 28 df) with no
  trend against position (r = −0.26). No constant bias → not a geometry/offset error at
  capture depth. No drift → not thermal/mechanical creep.

The ±1.88 mm scatter is **not** lidar error: these knots are 40-sweep coherent means whose
standoffs average to σ ≈ 0.05 mm, and a genuine 1.9 mm standoff error would cap suppression
at ~8 dB, not the 20 dB actually observed. The oracle offset is a free parameter absorbing
*model* error, not recovering a true standoff.

**Measured standoff sensitivity is far gentler than the analytic single-echo table**, which
is the key physical result. Deliberately offsetting the inference standoff by ε (LOO, real
data, mean over 29 positions):

| ε | 0.25 mm | 0.5 mm | 1 mm | 2 mm | 3 mm | 5 mm | 10 mm |
|---|---|---|---|---|---|---|---|
| analytic (single echo, α=0.93) | 26.2 | 20.2 | 14.2 | 8.2 | 4.8 | 0.6 | −4.4 |
| **measured** | **19.9** | **19.5** | **18.5** | **15.8** | **13.3** | **9.6** | **4.2** |

The reason is in CLAUDE.md's own echo decomposition: the **dominant** background component
sits at **α ≈ 0 — a static cable/coupling reflection that does not depend on standoff at
all** (confirmed here: the background range-profile peak sits at 0.53–0.54 m and moves by
σ 0.022 m across a 156 mm standoff span, i.e. it does not move). Only the weaker α ≈ 0.93
wall face is standoff-sensitive. So the analytic table, which assumes *all* energy is at
α = 0.93, is structurally pessimistic — **do not use it to predict suppression.** The
SFCW panel deliberately shows no suppression-ceiling tile for this reason: an early draft
had one and it pointed straight at the wrong suspect. Only σ and n are shown, as
measurements rather than predictions.

Monte-Carlo over the real data, adding Gaussian standoff noise at inference:

| σ | 0.05 | 0.25 | 0.43 | 1.0 | 2.0 | 5.0 mm |
|---|---|---|---|---|---|---|
| suppression | 20.19 | 19.99 | **19.74** | 18.80 | 16.78 | 12.58 dB |

At the measured per-sweep σ = 0.43 mm the penalty is **0.5 dB**, not the predicted ~15 dB.

**Where the residual actually goes (the false-target mechanism).** The LOO residual peaks
at −21 dB relative to the background peak, with peak/rms ≈ 5.0 (a flat noise-like residual
gives 3–4; a discrete false target gives ≫10). Its location clusters in two places: right
at the background peak (0.51–0.66 m) and a short-range group at 0.07–0.12 m. At the larger
standoffs the residual peak sits 8–12 cm *beyond* the background peak — and since
subtraction removes the true wall return, that residual becomes the largest feature left on
screen. So the false targets are **the model's own incompletely-cancelled wall/coupling
residual, re-ranked to the top by the subtraction**, not a standoff-noise artifact.

### Phase 1.3 — the regime gap is 5.3 dB, and standoff owns 0.4 dB of it

Fresh 24-position set captured 2026-08-28 under the corrected 160 mm offset
(`data/bgmodel_pass1.json`, gitignored): span 101.2 mm, **median gap 4.1 mm** (inside the
≤5 mm "well sampled" band), 40 sweeps each, SNR 21.3 dB/sweep, pose stable to ±0.04°.
Per-sweep standoff scatter within a static capture measured **0.388 mm**, independently
confirming Phase 1.1's σ(250 ms) of 0.40–0.43 mm.

Four scorings on the same data (`scratchpad/regime_gap.py`), each one step closer to what
live operation actually does:

| | spectrum | standoff | mean suppression |
|---|---|---|---|
| A | 40-sweep mean | capture mean | **24.27 dB** ← what `evaluateLoo` reports |
| B | 40-sweep mean | per-sweep | 23.90 dB |
| C | single sweep | capture mean | 19.11 dB |
| D | single sweep | per-sweep | **18.99 dB** ← what live operation gets |

**Regime gap D−A = 5.3 dB, not the predicted ~15 dB.** Decomposed: standoff noise costs
**0.37 dB** (A−B), single-sweep measurement noise costs **5.16 dB** (A−C). The 0.37 dB
matches the Phase 1.2 Monte-Carlo prediction of 0.48 dB at this σ. **The leading hypothesis
is falsified on both counts** — the gap is 3× smaller than predicted and the mechanism it
named contributes almost none of it. C is bounded by per-sweep SNR itself (21.3 dB): no
subtraction of a single sweep can beat its own noise floor, whatever the model does.

### The actual false-target mechanism: querying the model OUTSIDE its captured span

This is the finding that matters. On the fresh set, leave-one-out splits cleanly by whether
the held-out position is bracketed by other knots:

- **interior (interpolated): 25.98 dB** mean, worst 19.35
- **endpoints (clamped): 5.43 dB** mean
- **penalty for being outside the span: 20.55 dB**

How fast it falls off just past the edge (query below the model's lowest knot, scored
against the nearest real capture):

| outside by | 1 mm | 2 mm | 5 mm | 10 mm | 20 mm | 40 mm |
|---|---|---|---|---|---|---|
| suppression | 20.6 dB | 14.6 dB | 6.8 dB | 1.1 dB | **−3.5 dB** | **−5.2 dB** |

Negative means **the subtraction adds more energy than it removes** — it manufactures a
return where there is nothing. That is the false-target mechanism, and `inferInterpModel`
enters it silently: it clamps to the nearest knot and returns a confident-looking spectrum.

**Why this fired constantly with the old 315 mm offset.** Standoff = `lidar − offset`. The
lidar reads ~165–315 mm in real operation (measured), so under offset 315 every live query
was `−150…0 mm`, while `models/4th model.json` spans 11–167 mm. **Every single sweep was
clamped, by 11 to 161 mm** — i.e. essentially always in the energy-adding regime of the
table above. A model trained under a *different* mounting is the case where the otherwise
exact offset cancellation does not apply.

Note this also explains why *freshly* trained models failed the same way, which had been
taken as ruling the geometry out: a fresh model trained and used under the same offset does
cancel, but it only covers the span the operator actually swept. Pressing the aperture
closer than the nearest training knot puts the query outside the span at the near edge,
where 5 mm already costs 19 dB. Span coverage, not offset, is the thing to check.

**Residual shape confirms it.** On interior positions of the fresh set the residual sits
−28 dB below the background peak with peak/rms **2.58** — genuinely noise-like (a discrete
false target would be ≫10). So a correctly-queried model leaves no false target at all.

**Verdict: not standoff-limited, and not really model-limited either — span-limited.**
Ranked by cost: clamping outside the span **20.6 dB**, single-sweep SNR **5.2 dB**,
standoff noise **0.4 dB**. Chasing lidar precision would buy at most a few tenths of a dB.

### Phase 2 — the live traverse (2026-08-28): span-clamp CONFIRMED, but the model went stale

`span_confirm.py --seconds 120` -> `data/span_confirm_20260828-161212.json`, 377 sweeps,
267 in span / 110 outside, scored against `bgmodel_pass1.json` by `span_analyze.py`.

| bin | n | measured | Phase 1 offline LOO | resid pk/rms |
|---|---|---|---|---|
| in span | 267 | **8.14 dB** | 25.98 | 2.39 |
| 0-1 mm out | 7 | 9.40 | 20.6 | 1.77 |
| 1-2 mm out | 16 | 8.91 | 14.6 | 1.87 |
| 2-5 mm out | 7 | 7.22 | 6.8 | 2.50 |
| 5-10 mm out | 22 | 5.21 | 1.1 | 2.53 |
| 10-20 mm out | 2 | -0.55 | -3.5 | 2.50 |
| >20 mm out | 56 | **-3.32** | | 2.46 |

**Span-clamp mechanism confirmed live.** Suppression falls monotonically with distance
outside the span and goes *negative* past 10 mm — the subtraction adds more energy than it
removes, exactly as Phase 1 predicted offline (-3.32 measured vs -3.5 predicted at >20 mm).
Phase 1's central claim survives contact with live data.

**But no discrete false target was reproduced.** Residual peak/rms is 1.77-2.53 in *every*
bin, in span and far outside it alike — flat, noise-like, never the >>10 that marks a
phantom. So the out-of-span regime degrades suppression and injects energy broadband; this
traverse did not show it manufacturing a discrete peak. The original symptom is still not
reproduced live. Do not treat the false-target mechanism as fully closed.

**The 8.14 dB in-span is a STALE MODEL, not a new mechanism.** Ruled out in order:

- *Not geometry/offset.* Sweeping an inference-standoff offset over +/-20 mm peaks at
  **+3.3 mm for 8.76 dB** — 0.62 dB over doing nothing. Same shape as Phase 1.2's oracle
  test: the free standoff parameter absorbs model error, it does not recover a true standoff.
- *Not configuration.* Training and traverse `sfcwParams` are identical field-for-field
  (2000-5000 MHz, 60 MHz step, tx1/rx1 50/25, tx2/rx2 50/25, settle 10, buffers 4) and both
  ran at `lidarAntennaOffsetMm = 160`.
- *Not hand motion during the traverse.* A plausible confound, since the traverse moves
  while the training captures were static, and a sweep that moves mid-sweep smears its own
  frequency-vs-phase relationship. Stratifying the 267 in-span sweeps by `lidar_std` (a
  motion proxy) kills it: stillest quartile (0.35 mm, effectively static) gives **8.06 dB**,
  fastest quartile (2.12 mm) gives **8.01 dB** — indistinguishable. Whatever costs the
  17.8 dB is present even when the rig is holding still, so it is not a motion artifact.
- *Not the measurement.* Traverse-vs-traverse at <0.5 mm separation gives **17.96 dB,
  coherence 0.9914** (n=1031 pairs) — today's sweeps predict each other well, and 17.96 dB
  matches Phase 1.3's regime-D single-sweep figure of 18.99 dB. The radar is fine.
- *It is the training set.* Traverse-vs-training complex coherence is **0.9338**, and
  `-10*log10(1-rho^2)` for rho=0.9338 is **8.93 dB** — essentially the 8.14 dB observed. The
  measured spectrum has decorrelated from the trained background by ~6.6% of its energy.
  Per-step `|h|` ratio now/training runs **0.60 to 2.17 (mean 1.267)** — strongly
  frequency-dependent, so not a gain change.

**Most likely cause: the bench was physically disturbed between the two sessions.**
`bgmodel_pass1.json` was captured 00:38; the traverse ran at 16:12, after a day of bladeRF
USB troubleshooting (repeated replugging, power cycles, a move to a USB 2.0 port and back,
FPGA reloads). CLAUDE.md's own echo decomposition says the *dominant* background component
is the alpha ~ 0 static cable/coupling reflection — precisely the term that moving cables and
connectors changes. A frequency-dependent 0.6-2.2x amplitude change is what a re-seated
connector or shifted cable dress looks like.

**Operational consequence: a background model has a shelf life bounded by the bench staying
untouched.** Any RF cable, connector, or antenna disturbance invalidates it, and the failure
is silent — the model still interpolates confidently and still reports "BG applied: YES".
Retrain after any hardware work, and treat a sudden in-span suppression drop as a staleness
signal rather than a modelling problem. Cheap staleness check, no recapture needed: score
traverse-vs-traverse coherence against traverse-vs-model coherence; if the first is ~0.99
and the second is well below it, the model is stale, not wrong.

### Phase 3 — fresh model closes the staleness gap (2026-08-28)

Two 30-position sets captured 5 min apart (`bgmodel_pass2_*`, `bgmodel_pass3_*`, 15 sweeps
each, span 5-160 mm), then the traverse re-run against pass3.

**Shelf life measured for the first time.** Cross-session scoring (build from A, score on B's
measured spectra, interior only):

| model -> data | elapsed | suppression |
|---|---|---|
| pass2 -> pass3 | ~5 min | **21.21 dB** |
| pass3 -> pass2 | ~5 min | **21.35 dB** |
| pass1 -> pass2/3 | ~16 h | **7.90 / 8.76 dB** |

The ~8 dB at 16 h independently reproduces the traverse's 8.14 dB against pass1 by a
different route, confirming that shortfall was staleness. **Caveat: two time points are not
a curve** — this cannot yet distinguish gradual drift from a step change caused by the day's
bladeRF USB/FPGA work in between, and those imply very different retraining cadences. Leaving
a model overnight with the bench untouched and re-scoring would separate them.

**Live traverse against the fresh model: in span 8.14 -> 17.70 dB.** Falloff outside the span
confirmed again (-3.45 dB at >20 mm out vs -3.5 predicted). 17.70 dB combines single-sweep SNR (21.7 dB) with
cross-session model error (~21 dB) for a predicted 18.4 dB, which matches.

**Corrected 2026-08-28 — in-span is MODEL limited, not SNR limited.** Measured directly by
coherently averaging K consecutive sweeps of an 87-sweep static capture: K=1 gives 19.28 dB,
K=16 gives 21.95 dB — **+2.83 dB against an ideal +12.0**, plateauing at ~22 dB. Averaging
removes only the sweep-noise term; what remains is the model floor. So sweep noise is worth
~3 dB of the total and no more, and **raising `num_buffers` cannot buy more than that same
~3 dB** while costing sweep rate. The plateau (~22 dB) sits right at pass3's own LOO
(23.57 dB), so the binding constraint is **interpolation error at the achieved knot density**,
not background drift over minutes and not the estimator choice.

**Do not merge capture sessions.** Merging pass2+pass3 (51 knots, 3.3 mm median gap) scores
22.40 dB mean — *worse* than pass3 alone (23.57). The density gain is cancelled by the 21 dB
inter-session disagreement being injected into the interpolation. Even 5 minutes of elapsed
time is enough that combining sessions does not pay.

**Hand-placement scatter costs 6-7 dB and is now the largest capture-side lever.** The
scheduler asked for 3.8-6.8 mm gaps; pass2 achieved 0.6-13.7 mm. Held-out positions in the
tightest third of brackets scored 24.37 dB vs 17.14 dB in the widest third (pass2), 26.31 vs
20.46 (pass3). `capture_bgmodel.py --span-lo/--span-hi` now prints a per-position target, but
its move window still counts down blindly and captures wherever the operator happens to be —
gating capture on `|error| < 2 mm` would recover most of that.

**The false target has still never been reproduced** — but see the target A/B below: the
peak/rms metric used to reach that statement is now known to be incapable of detecting a
target at all, so this conclusion carries no weight and needs redoing with the magnitude-vs-
reference detector. **A separate remaining hypothesis
is the display, not the physics:** in the 0-30 cm window the residual's dynamic range is
**23.1 dB vs the raw profile's 20.6 dB**, so a dynamic colour scale stretches flat post-
subtraction noise across the full colormap exactly as it did real structure beforehand. Test
it by pinning `sfcwScaleRange` to manual at the pre-subtraction limits and seeing whether the
"targets" survive.

### Target A/B (2026-08-28): peak/rms is not a target detector, and what is

Static bed, standoff ~24 mm, target placed then removed with nothing else changed. 126 sweeps
with, 87 without, ~7 min apart, both scored against `bgmodel_pass3`.

**The target is unambiguous**: magnitude change **+4.4 dB peaked at 21.2 cm**, against a
**0.23 dB** noise floor measured in the 0-10 cm wall/coupling region, which the target leaves
completely undisturbed. Complex signature is 19.3 dB above the coherent-mean noise floor.

**Both detection statistics in use scored it BELOW target-free background:**

| | target present | target-free |
|---|---|---|
| residual peak/rms | **1.52** | 1.75-1.91 |
| peak excess over median | **3.80 dB** | 6.36-8.37 dB |

A target that is extended by range resolution (~50 mm at 3 GHz) plus sidelobes lifts the
residual *floor* rather than spiking one bin. peak/rms is self-normalised, so a raised floor
raises the RMS and the ratio falls. **Any self-referential peakiness measure is blind to a
real target, and blind in the wrong direction.** Do not use peak/rms, or excess-over-median,
to decide whether something is there.

**What works: magnitude range profile vs a target-free reference at matched standoff.**
Calibrated threshold from this data: a magnitude change **> ~0.7 dB** (3x the 0.23 dB control
region) indicates a target.

**The LiDAR has a slow ZERO-DRIFT of ~1 mm over minutes, and within-capture noise statistics
are blind to it.** The lidar reported the standoff moving 1.03 mm between the two target A/B
captures. It had not: range-gating the complex difference to the wall/coupling region (0-10 cm)
gives **-40.1 dB**, where an actual 1.03 mm move would give **-14.0 dB** -- 26 dB below, i.e. the
true geometry held to **~0.05 mm** while the lidar's reading wandered by a millimetre. Use the
wall-gate phase, not the lidar, to decide whether the rig moved; the radar is ~20x the better
position sensor at this scale.

Independently confirmed on the training sets: a constant-bias search across the pass2/pass3
cross-session pair wants **-1.35 mm** one way and **+1.45 mm** the other. Equal-and-opposite is
the signature of a real zero-drift between sessions, not a fitting artifact.

**Cost is real but modest: ~2 dB** (pass2->pass3 21.21 -> 23.15 dB when the bias is corrected).
Far less than the single-echo table predicts for 1.4 mm (14 dB) because the dominant background
term is the alpha~0 static coupling, which does not depend on standoff at all -- the same reason
Phase 1.2's measured falloff was much gentler than the analytic one. A 1-parameter bias search
at inference is therefore a cheap ~2 dB, and being a slowly-tracked global constant it cannot
absorb a target the way a per-sweep standoff search could.

**This does NOT explain the staleness.** The same search on the 16 h pair (pass1->pass3) recovers
only **+0.69 dB**, so the overnight decorrelation is genuine background change, not lidar drift.

**Magnitude and complex tolerate very different amounts of this.** The magnitude range profile
was unaffected -- the 0-10 cm control stayed at 0.23 dB whether or not the standoffs were
matched -- because a sub-millimetre shift is a small fraction of a range bin. The complex
difference is not: at the (spurious) 1.03 mm the shift term would have swamped the target. So
**target detection can use magnitude and tolerate ~1 mm of standoff error; background
subtraction needs coherent cancellation and is sensitive to it.**

**Without compensation the target sits 16.6 dB below the wall return** (-51.4 vs -34.8 dB) --
a small bump on the skirt of a much larger feature, which is precisely the case background
subtraction exists to fix.

### Tooling added

- `pi/sensors/lidar_noise_char.py` — noise vs averaging window at a given distance.
- `pi/radar/capture_bgmodel.py` — captures a `bgmodel_training_data` v2 set headlessly
  (same format the BG Model panel exports, plus per-sweep `lidar_n`/`lidar_std`/pose
  columns). **The SDR socket must be drained continuously**: `sfcw_start` free-runs, so a
  move window that does not read the socket lets sweeps pile up, and the capture then
  drains the backlog with several sweeps sharing one instant — every standoff after the
  first came back `None` in the first version. The reader task now pairs each sweep with
  the lidar samples that arrived since the previous one, at arrival time.
- `pi/radar/bgmodel_interp.py` — numpy port of `bgModelInterp.js` + `rangeProfile.js`
  (build / infer / range profile / LOO). Reproduces the browser's own numbers exactly on
  `data/bgmodel_pass1.json`: interior LOO 25.98 dB mean / 19.35 worst, clamped 5.43 dB.
  It deliberately preserves `inferInterpModel`'s asymmetry — interpolating at the
  *clamped* standoff while rewinding phase at the *unclamped* one — because that is the
  failure being measured; a "tidier" port would not reproduce it. Written because
  CLAUDE.md's reference to `scratchpad/regime_gap.py` is dead (that file was in a session
  scratchpad and no longer exists), so the port now lives in the repo instead.
- `pi/radar/span_confirm.py` + `pi/radar/span_analyze.py` — **live** confirmation of the
  span-clamp mechanism, which Phase 1 established only offline (its own caveat: "I never
  observed a false target live in the app"). `span_confirm.py` records a continuous
  standoff traverse through and past both span edges — **aim at a blank wall**, the method
  rests on every residual peak being false by construction. `span_analyze.py` applies the
  model at each sweep's own standoff and bins suppression + residual peak/rms by
  mm-outside-span, against Phase 1's offline falloff (1 mm → 20.6 dB, 5 → 6.8, 20 → −3.5).
  `span_analyze.py` reports residual **peak/rms**, which is NOT a target detector — see the
  target A/B below. It is only a coarse "is the residual spiky" indicator; do not read a low
  value as absence of a target.

## Sweep-to-sweep variability is set by the REFERENCE channel's level (2026-08-29)

Investigating "a static rig on a static scene gives range profiles whose shape correlates
highly but whose values move by multiple dB, worst at particular ranges". Measured on the
bench with `sdr_server` stopped, driving `SFCWEngine` directly so `h_signal` and
`h_reference` could be kept separately (the wire only carries their ratio).

### The symptom is a level effect, not a range effect — dB is the wrong lens

Across 100 static sweeps the **linear** std of the range profile is essentially flat with
range (-41.9 to -34.9 dBr, a 7 dB spread) while the **dB** std spans 0.11 to 6.08 dB, and
`corr(dB-std, -mean level) = 0.878`. There is one flat additive complex noise floor across
the whole profile; wherever the profile dips toward it, the dB reading swings wildly, and
where it is strong the dB reading is rock solid (0.12 dB at the peak). So "variability
depends on position" is entirely "how far is this bin above the floor" — **the floor is the
only number worth tracking, and it is one number for the whole profile.**

### It is not thermal noise, not drift, and not settling

| measurement | result |
|---|---|
| within a step (4 buffers, 0.4 ms apart) | 0.13-0.22% -> ~54 dB |
| sweep to sweep (same step, ~300 ms apart) | 5.3% -> 25.5 dB, **29x worse** |
| lag-1..50 correlation of the residual | 0.01-0.06 (white) |
| first-half vs second-half mean of 100 sweeps | 35.4 dB (no drift) |
| removing a per-sweep complex scalar | 21.41 -> 21.91 dB (nothing) |
| removing a per-sweep delay/range shift | -> 21.98 dB (nothing) |
| error vs step signal level | corr 0.011 (**multiplicative, not additive**) |
| error across adjacent frequency steps | corr 0.08 (white in f -> flat in range) |

Averaging more buffers cannot help (the fast noise is already 29x below), and a 6x longer
settle does not help either. Paired A/B at one frequency isolates the trigger:

| | scatter vs baseline |
|---|---|
| capture again with **no** retune in between | 2.4% |
| retune to the **same** frequency, then capture | 6.4% |
| retune 1 GHz away and back | 6.5% |
| retune, then settle 60 buffers instead of 10 | 6.7% |

So it is the retune that re-randomises it, and it is not a settling transient.

### Root cause: RX2 was ~76% of ADC full scale, i.e. in compression

Magnitudes are immune to the LO phase, so they separate the two paths cleanly:

| | sweep-to-sweep | within-step |
|---|---|---|
| `|h_signal|` | 1.19% | 0.020% |
| `|h_reference|` | **5.62%** | 0.118% |
| `|h_cal|` | 5.44% | 0.133% |

**The reference — the thing whose entire job is to be the stable standard — is 4.7x less
stable than the antenna channel, and h_cal inherits it essentially untouched.** Because it
divides every step, its noise is *multiplicative*, which is exactly why the scatter is
independent of each step's own signal level (a step at 26 ADC counts and one at 571 are
equally noisy in relative terms).

It is a level problem. Sweeping TX2/RX2 gain gives a textbook compression curve
(60-80 sweeps per point, `|S|` cv stays ~1.0-1.2% throughout, so this is purely the
reference path):

| rx2 ADC peak (of 2047) | 1567 | 896 | 530 | 425 | 307 | 169 | 105 | 51 | 27 |
|---|---|---|---|---|---|---|---|---|---|
| `|R|` cv | 4.7% | 2.2% | 1.3% | 0.82% | 0.81% | 0.92% | 1.06% | 1.38% | 6.17% |
| h_cal | 28.4 dB | 37.9 | 39.7 | 43.6 | 43.6 | 45.0 | 42.6 | 39.8 | 29.7 |

**Target the reference at roughly 150-400 counts peak (5-20% of full scale).** Above that
the RX2 front end compresses; below ~50 it runs out of SNR. (These counts, and the table
above, are a *mean* of the per-step maxima. `adc_peak` on the wire is a *max over the
sweep*, which for RX2 runs ~1.1x higher and for RX1 ~4x higher -- do not compare the two
statistics directly. The post-fix numbers further down are all max-over-sweep.) End to
end, 80 sweeps each:

| | h_cal | noise floor | dB std median | worst | @0.4 m |
|---|---|---|---|---|---|
| tx2=50 rx2=25 | 26.2 dB | -38.2 dBr | 0.55 dB | 6.64 | 0.98 |
| tx2=30 rx2=20 (engine default) | 42.2 dB | -44.4 dBr | 0.16 dB | 1.13 | 0.17 |
| tx2=45 rx2=10, rx1=20 | **44.0 dB** | **-50.4 dBr** | **0.06 dB** | 0.62 | 0.07 |

**With the reference correctly levelled the radar is extremely repeatable**: two 40-sweep
means taken minutes apart on a static scene give complex coherence **1.0000** and 41.5 dB
suppression. There is no mystery drift; nearly all the observed variability was this.

The remaining floor is `|h_signal|`'s own 1.1% per-retune magnitude wobble (~39 dB), which
is what caps h_cal at ~44 dB. TX runs at `amplitude=0.9` of DAC full scale, which is the
obvious next suspect, but it has not been tested.

### The reference gain is invisible, unreachable, and STICKY — this is the real trap

- `App.jsx` `sfcwParams` has **no** `tx2Gain`/`rx2Gain`, so `sendSfcwParams()` never sends
  them. The panel therefore is *not* the source of truth for these two, contrary to the
  invariant stated in the SFCW params section above.
- `SFCWEngine` keeps whatever was last set for the **life of the `sdr_server` process**, and
  `_configure_hardware()` re-pushes it before every sweep. `capture_bgmodel.py` and
  `span_confirm.py` (`SFCW_PARAMS`) send **tx2=50 rx2=25**. So running either tool once
  silently moves every subsequent browser sweep into the compressed 26 dB regime until
  `sdr_server` is restarted — with nothing on screen indicating it. That is the most likely
  explanation for the symptom appearing intermittently across sessions.

### Reference gain also RE-CALIBRATES h_cal, so it invalidates background models

Changing only TX2/RX2 gain is **not** a constant scaling of h_cal. Measured on a static
scene (40-sweep means):

| | coherence | suppression |
|---|---|---|
| 30/20 vs 30/20 (control) | 1.0000 | 41.5 dB |
| 30/20 vs 50/25 | 0.8807 | **6.49 dB** |

Per-step `|h_cal|` ratio runs **0.007 to 1.840** with 46 deg of phase scatter — a strongly
frequency-dependent recalibration, because different AD9361 gain settings distribute gain
differently across LNA/mixer/PGA and each has its own frequency response.

**Consequence: a background model is only valid at the reference gain it was captured at,
and nothing records or checks that.** Models built by `capture_bgmodel.py` (50/25) applied
to browser sweeps (30/20) would be mismatched by construction. This is worth re-examining
against the Phase 2 "stale model" finding above: its signature was a per-step `|h|` ratio of
0.60-2.17, "strongly frequency-dependent, so not a gain change" — which is exactly the
signature a reference-gain change produces. The `geometry` stamp added in Phase 0 records
`sfcwParams`, but since `sfcwParams` does not contain tx2/rx2 it cannot catch this.

### Separate bug: `sync_rx` in RX_X2 delivers HALF the samples the code assumes

`_rx_loop_dual` calls `sync_rx(buf, num_samples)` with `num_samples=4096` and a buffer sized
for 4096 samples *per channel*. In `RX_X2`, libbladeRF counts `num_samples` as the **total**
across both channels. Verified by poisoning the buffer with `0xAA` before the call: **the
upper 50% is never written**, and throughput is 4886 calls/s at 10 Msps = 2047 per-channel
samples per call (not 2441 calls/s / 4096 samples).

`buf` is allocated once outside the loop, so every capture is 2048 fresh samples followed by
2048 samples that are one buffer old. Steady-state harm is small — the stale half comes back
rotated by `exp(-j*2*pi*100e3*4096/10e6)`, costing 0.8% amplitude and a constant 7.2 deg that
cancels in the ratio — but:

- **A buffer carried 0.205 ms of signal, not 0.41 ms**, so `settle_count = 10` bought
  2.05 ms of *settled signal* rather than the 4.10 ms `SfcwPanel.jsx`'s
  `BUFFER_SAMPLES`/`SAMPLE_RATE` and CLAUDE.md's own sweep-timing section both claim. That
  bears on the `settle_count` 10 -> 7 regression documented above: it was really 1.43 ms.
- **The wall clock did NOT halve with it, and that is the confusing part.** Measured
  retune -> settle-satisfied is **4.40 ms** (p10 4.28, p90 4.50), not 2.05 ms, and it is
  not buffer loss -- arrivals run at 4882/s against an ideal 4883/s both idle and under
  sweep load, i.e. exactly real time with nothing dropped. The cause is that `_sweep_core`
  holds `_rx_cond`'s lock across the whole settle-plus-capture block, so `_rx_capture`
  blocks on it, the RX thread stalls, buffers back up in the 16-deep ring, and it catches
  up in the gap between steps (`seqd` counts ~14 arrivals per step inside the block while
  ~29 actually occur). So the *elapsed* time was roughly what the repo assumed while the
  *settled signal* was half, and the true settling sat somewhere between those two bounds
  depending on ring backlog -- unknowable, which is itself the problem. With the fix a
  buffer is genuinely 4096 samples / 0.41 ms and the ambiguity is gone.
- Consecutive buffers overlapped 50% in content, so `num_buffers` averaging was over fewer
  independent captures than it looked.

Fix is to request `2 * n` from `sync_rx` (or size the buffer for what actually arrives) and
to check the delivered count rather than assuming it.


### Fixes shipped and re-measured, same evening (2026-08-29)

Changed: `sync_rx` request corrected in `_rx_loop_dual`; `tx2_gain`/`rx2_gain` added to
`App.jsx` `sfcwParams` + `sendSfcwParams()` and to `SfcwPanel.jsx`'s Gains section;
`capture_bgmodel.py` `SFCW_PARAMS` brought into line; `adc_peak` + `gains` added to every
`sfcw_result` with a headroom bar in the panel and a hysteretic stdout warning;
`geometryMismatch()` now compares `tx2Gain`/`rx2Gain`.

100 sweeps per row through the real `_perform_sweep()`, static scene:

| | Hz | h_cal | floor | dB std med | worst | rx1 pk | rx2 pk |
|---|---|---|---|---|---|---|---|
| shipped, tx2/rx2 = 30/20 | 2.22 | **45.3 dB** | -44.2 dBr | **0.15 dB** | 1.29 | 873 | 373 |
| repeat of the same config | 2.22 | 45.1 dB | -44.5 dBr | 0.14 dB | 1.17 | 871 | 393 |
| what the capture tools forced, 50/25 | 2.22 | **34.0 dB** | -43.7 dBr | 0.25 dB | 3.69 | 857 | 1817 |

The two identical rows agreeing to 0.2 dB is the run-to-run error bar for every number
here. Against the 50/25 a session inherited after running `capture_bgmodel.py` this is
**+11.3 dB**; against the same 30/20 measured before the `sync_rx` fix (42.2 dB) the fix
alone is worth **+3.1 dB**; against the original measured baseline (50/25 with the
half-buffer bug, 25.5 dB) the total is **~20 dB**.

**The `sync_rx` fix costs sweep rate: 3.16 -> 2.22 Hz** (-30%), because a buffer now really
is 4096 samples / 0.41 ms instead of 2048 / 0.205 ms. What it buys is that `settle_count`
means what it says -- settling went from 2.05 ms to a genuine 4.10 ms. If the rate is
wanted back, `settle_count = 5` restores ~3.1 Hz at exactly the 2.05 ms of settling the
system has actually been running with all along; that is a knowing trade, not a free one,
and per the `settle_count` regression note above it needs a per-step validation first.

**`tx2/rx2 = 45/10` was shipped for part of this session and then reverted to 30/20.** It
came from a gain scan run before the `sync_rx` fix; the fix moved the optimum, and 45/10
measures 45.8 dB post-fix against 30/20's 46.2-47.1. The Pi-side default therefore ends up
unchanged -- **the engine default was never the bug.** The bugs were that the panel could
not set it and that the headless tools silently could.

**The ADC warning needs hysteresis, and this is not a detail.** RX1's per-sweep peak sits
right on any sensible threshold in normal operation -- measured flipping between 78% and
100% FS from one sweep to the next -- so a plain threshold test printed a warning and a
recovery every couple of sweeps. With `ADC_HOT_SWEEPS_TO_WARN = 8` /
`ADC_CLEAN_SWEEPS_TO_CLEAR = 30` the same 300 sweeps produce **exactly one line**, on the
50/25 run, naming RX2 at 90% FS. Also note RX1 and RX2 need *different* thresholds (0.75
vs 0.40) because `adc_peak` is a max: RX2's reference is flat across the band so its max
represents every step, while RX1's max is whichever single frequency the scene is
strongest at and says nothing about the other fifty.

**RX1 genuinely clips intermittently at `rx1_gain = 25`** -- peak hits the 2048 rail on
0-8% of sweeps in this scene (18% at one gain setting), which nothing could see before
`adc_peak` existed. It is not currently costing anything measurable (`|h_signal|` cv stays
~1.1% at rx1 20 / 25 / 30), so it has been left alone rather than changed blind, per the
"retest via RF Calib at the exact new numbers" rule above. Watch the panel's RX1 bar; if
it sits red on a strong target, drop `rx1Gain` and re-measure.

### The `coherent` flag does not measure what its name suggests

Over 100 sweeps per configuration it reads **`coherent = False` 100% of the time in every
configuration, including the good ones** -- and it did so before any of these changes, so
nothing here broke it. `_process_h_cal` computes `phase_std` as the residual of a *linear*
fit to unwrapped phase vs step index, which is only small when the scene is a single
dominant reflector. A real multi-target scene is not linear in frequency and never will
be, so against the fixed 0.3 rad cut the flag is pinned False regardless of hardware
health. Measured: 1.39 rad at 30/20, 3.90 rad at 50/25.

**What is diagnostic is the sweep-to-sweep spread of `phase_std`, not its value.** The
structure repeats almost exactly when the hardware is healthy and stops repeating when it
is not:

| | mean phase_std | sd across 100 sweeps |
|---|---|---|
| 30/20 | 1.3897 rad | **0.0047** |
| 30/20, repeat | 1.3915 rad | 0.0048 |
| 50/25 | 3.9029 rad | 0.0078 |

A retune-timing corruption -- the thing this check exists to catch -- would move `phase_std`
sweep to sweep, because corrupted sweeps do not repeat. So the useful test is
`std(phase_std)` over a window, or a comparison against the previous sweep's phase, not a
fixed absolute cut on one sweep. The flag as shipped is a scene detector wearing a
hardware-health label; treat it accordingly until it is reworked.

### What a bin AT the floor does, and the FLOOR overlay (2026-08-29)

A bin's dB wobble is `~8.686 * sigma / A` -- sigma fixed, `A` spanning 40+ dB across the
profile -- so the *same* error reads as 0.1 dB on the peak and tens of dB in a null. Bins
grouped by headroom above the floor, 200 static sweeps at the shipped config:

| headroom | dB std | worst dip | worst spike |
|---|---|---|---|
| >30 dB | 0.14 | 0.4 | 0.4 |
| 20-30 | 0.69 | 2.0 | 1.7 |
| 15-20 | 1.64 | 4.9 | 3.3 |
| 10-15 | 2.22 | 8.0 | 4.2 |

**The dips grow faster than the spikes, and that asymmetry is the fingerprint of a bin at
the floor**: a noise phasor can very nearly cancel the signal (-> -inf dB) but can at most
double it (-> +6 dB). A bin reported as "sits at -50 dB, drops to -65, jumps to -45" is
therefore not a fault and not a contradiction of the 0.72 dB worst-case quoted from a
different scene -- it is a bin with ~0 dB of headroom, i.e. no measurement at all. **Any
"worst-case wobble" figure is only meaningful together with the headroom range it was
measured over**; the number above was scoped to a window whose weakest bin was 22 dB up.

`SfcwDisplay` has a **FLOOR** toggle (next to CFAR) drawing the measured floor: per-bin sd
of LINEAR amplitude over the last `FLOOR_WINDOW = 16` sweeps, smoothed +/-10 bins, scaled by
`1/sqrt(avgCount)` (exact, since the error is white sweep-to-sweep). Linear, not dB, because
the error is additive in amplitude and flat in range -- and it follows the R^n gain
automatically since the stored rows are already range-compensated. Validated against
200 sweeps: predicted wobble `8.686 * floor/level` vs measured, at 0.10 / 0.30 / 0.39 /
0.50 / 0.70 m -> 0.09/0.10, 0.11/0.11, 0.19/0.19, 0.57/0.60, 0.29/0.30 dB. The line itself
is stable to 0.82 dB frame to frame. Suppressed in the zeroed trace modes, where an
absolute floor would be meaningless.

**Averaging works and follows 10*log10(N).** Measured floor: N=1 -44.5 dBr, N=4 -49.6,
N=8 -52.7, N=32 -60.9, with dB std median 0.171 -> 0.091 -> 0.058 -> 0.023. The display's
existing Avg control averages *magnitudes* (incoherent) rather than complex `h_cal`;
measured, the two are identical to three decimals on this scene because nothing gets
within 22 dB of the floor, and they only diverge inside ~6-10 dB of it. Worth switching for
deep-null work, not urgent.

### settle_count: 10 -> 3 (2026-08-29), validated per step

Once `sync_rx` was fixed a buffer is 0.41 ms again, and `settle_count` turned out not to
discriminate at all. 100 sweeps at each value, plus 400 each at the two finalists. "bad
steps" counts `(sweep, step)` cells more than 8 robust sigmas off that step's own median --
a step that retuned late holds the previous frequency's IQ and lands nowhere near it. This
is the **per-step** check the regression note above demands; an aggregate correlation is
what let the last regression ship.

| settle | Hz | h_cal | phase_std | ps sd | bad steps | worst z |
|---|---|---|---|---|---|---|
| 10 | 2.22 | 47.1 dB | 1.3615 | 0.0051 | 0/5100 | 2.5 |
| 5 | 2.88 | 47.3 | 1.3578 | 0.0048 | 0/5100 | 2.9 |
| 4 | 3.10 | 46.7 | 1.3575 | 0.0054 | 0/5100 | 2.2 |
| 3 | 3.27 | 47.3 | 1.3581 | 0.0040 | 0/5100 | 3.5 |
| 2 | 3.52 | 48.0 | 1.3566 | 0.0050 | 0/5100 | 2.9 |
| 1 | 3.80 | 48.6 | 1.3549 | 0.0039 | 0/5100 | 2.4 |

400-sweep confirmation: **settle=3 -> 3.35 Hz, 0/20400 bad, worst z 2.9**; settle=1 ->
3.90 Hz, 0/20400 bad, **worst z 7.6**. Gaussian expectation for 20,400 samples is ~4.1, so
settle=1 threw a genuine tail excursion and settle=3 did not. **3 is chosen for margin, not
for speed** -- it takes 51% of the rate back (2.22 -> 3.35 Hz) and the last 16% is not worth
the exact intermittent tail that caused the earlier regression.

Note the `coherent` flag was False 100% of the time at *every* settle value, so it could not
have picked a winner -- see the section on why it is a scene detector, not a health check.

### The per-retune magnitude wobble: what actually limits h_cal now

With the reference levelled, the binding term is that `|h_signal|` at a fixed frequency
changes between sweeps even though the scene does not. Measured over 120 sweeps at the
shipped config, keeping both channels separately:

| | sweep-to-sweep | within a step (4 buffers, 0.4 ms) |
|---|---|---|
| `|h_signal|` | 0.912% | 0.025% |
| `|h_reference|` | 0.731% | 0.011% |
| `|h_cal|` | 0.815% | **0.029% (70.8 dB)** |

**The instantaneous measurement is superb and the retune is what costs everything** -- 30x
worse between sweeps than within one, frozen for the duration of a step and re-drawn at the
next retune. So more `num_buffers` cannot help; the noise it averages is already 30x below
the limit.

Decomposing by how much the two channels move together (`rho = 0.562` between their
fractional magnitude fluctuations):

| component | size | cancelled by the ratio? |
|---|---|---|
| common to both channels | 0.593% | yes, entirely |
| signal-channel specific | 0.694% | **no** |
| reference-channel specific | 0.427% | **no** |

**Only about half of it is common-mode, and the signal channel carries the largest
uncancelled share.** That is the number to attack, and it points at what is different about
the TX1 -> antenna -> RX1 path: TX1 runs at 50 dB against TX2's 30 dB (20 dB more drive,
much closer to TX compression), the TX DAC sits at `amplitude = 0.9` of full scale, and RX1
sees a 43 dB spread of level across the band and hits the 2048 rail at the strong end.
Amplitude-dependent gain is exactly the mechanism that was costing 11 dB on the reference.

Untested experiments, in order: (1) sweep `tx_amplitude` 0.9 -> 0.3 and `tx1_gain` 50 -> 40;
(2) sweep `rx1_gain` 25 -> 10 watching clip% and the signal-specific term; (3) **equalise the
two chains' operating points** (same gains, a pad on the loopback to match levels) so more
of the wobble becomes common-mode and cancels -- structurally the right fix, since the
reference can only cancel what both paths share.

Caveat on the absolute numbers: this run reports `|h_cal|` at 41.8 dB where runs minutes
earlier gave 47-48 dB on the complex metric. Part is the metric (magnitude-only cv vs
complex residual, worth ~1 dB) and the rest is that the bench was being handled between
runs. **The decomposition is a ratio of terms measured within one run and is the robust
part; do not quote 41.8 dB as the system figure.**

### Three gain experiments against one metric (2026-08-29)

**The metric, and why the earlier ones were not good enough.** `S_repeat`, single-sweep
repeatability:

    S_repeat = 10*log10( sum_i <|H[k,i]|^2>_k / sum_i <|H[k,i] - H[k-1,i]|^2>_k / 2 )

signal energy over the energy of the ADJACENT-SWEEP difference. It is immune to slow drift
during a capture (deviation-from-the-mean is not -- that is what made one run read 41.8 dB
where runs minutes earlier gave 47-48), the /2 corrects for a difference of two independent
samples having 2x the variance, and being a ratio computed within each configuration it
stays comparable even though changing any gain re-calibrates h_cal's shape. Every run below
repeats the baseline config at the START and END; the three controls agreed to **0.2 dB**,
which is the error bar on everything here.

| experiment | result |
|---|---|
| **E1** TX DAC `amplitude` 0.9 -> 0.7 -> 0.5 -> 0.3 | 27.8 / 27.9 / 28.0 / 28.1 dB -- **no effect**, hypothesis falsified. Within-step SNR degrades 72.4 -> 66.2 dB, so it costs and buys nothing. Note `amplitude` is shared by both TX chains, so it is a common-mode change and cancels in the ratio. |
| **E2** `rx1_gain` 25 -> 20 -> 15 -> 10 | 28.1 / 28.5 / 28.6 dB -- **no effect**. rx1=20 removed RX1 clipping entirely (0% vs 12%) and gained nothing, confirming the clipping is not currently costing anything. |
| **E3a** `tx1_gain` 50 -> 45 -> 40 -> 35, RX1 compensating | 31.2 / 30.9 / 30.6 vs control 28.1 -- a real **+3 dB**, but see below: it does not combine. |
| **E3b** `tx2_gain` toward TX1 at ~constant reference level | 20/30 -> **19.7**, 30/20 -> **28.1**, 40/10 -> **36.7**, 45/5 -> **38.6 dB**. Monotonic across 19 dB. |

**E3b is the result.** Confirmed on the operational metric too, same bracketed run:

| | S_repeat | range-profile floor | dB std median | worst |
|---|---|---|---|---|
| tx2/rx2 = 30/20 (control x3) | 28.1 dB | -45.8 dBr | 0.196 | 2.2 |
| **tx2/rx2 = 45/5** | **38.6 dB** | **-53.2 dBr** | **0.065** | **0.84** |

**It is not a level effect.** 45/5 sits at 342 RX2 counts and 45/10 at 585 -- both 38.6 dB --
while the control at 391 counts, in between them, is 28.1 dB. Holding the level and moving
only the TX2/RX2 split is what changes it.

**But the mechanism is NOT confirmed, and the obvious story is wrong.** "Match the two
chains so more of the per-retune error is common-mode" predicts that tx1=45 with tx2=45
should be best; measured, it is **34.8 dB, worse** than tx1=50 with tx2=45 (38.7). The
magnitude-correlation statistic `rho` was too noisy to arbitrate (two identical controls
gave 0.570 and -0.043), and `|R|cv` is unchanged across all of these (0.33-0.38), so the
improvement is not in reference *magnitude* stability -- it is in phase. Most likely an
empirical property of where the AD9361 TX gain table lands at this frequency plan.
**Re-measure after any RF hardware change instead of assuming it transfers**, and note that
E3a's +3 dB does NOT add to E3b: 45/5 alone beats the combination by 3.9 dB. `tx1_gain`/
`rx1_gain` therefore stay at the bench-validated 50/25.

### num_buffers 4 -> 1, and the sweep-rate readout (2026-08-30)

`num_buffers` averages that many post-settle captures per step, so it can only attack noise
that changes WITHIN a step. Measured 2026-08-29 that term is **0.029% (70.8 dB)** while the
binding limit -- the per-retune wobble -- is **38.6 dB**. Averaging 4 buffers therefore
changes the total by `10*log10(1 + 10^-3.2)` = **0.003 dB** while costing 3 buffer-times per
step. Set to 1 in `SFCWEngine`, `App.jsx` and `capture_bgmodel.py`.

**This reverses the 2026-08-23 restoration of 4 documented above, and that restoration was
correct at the time** -- the reference was compressed then and the within-step term sat much
closer to the limit. The justification here is entirely the 32 dB gap between the two, so if
the RF chain ever regresses this needs re-deriving, not assuming. A bench A/B against
S_repeat with bracketed controls is still outstanding (the device was in use); the argument
above is arithmetic from a measurement, not a measured A/B.

`Viewport.jsx` gained `useSweepRate()` -- median of the adjacent differences of the Pi's own
`sfcw_result.timestamp` over a 12-sweep window, shown in the SFCW pane header as
`<ms> ms / sweep - <hz> Hz`. Median, not mean, so one stalled or dropped frame does not move
it; from the Pi's timestamps, not render timing, so it reports what the radar is doing
rather than how fast the browser redrew. The hook is called unconditionally at the top of
`Viewport` because the per-panel branches are early returns.

### Complex vs magnitude background subtraction (2026-08-30)

**The complex/magnitude toggle is back, and it must not be deleted again.** It was removed
once on the reasoning that complex was the only correct mode. The 2026-08-28 target A/B
showed the two do different jobs and both are needed:

| | what it is | what it is for | tolerance to standoff error |
|---|---|---|---|
| **complex** | vector difference of `h_cal` | removing the wall/coupling return, so a target 16.6 dB beneath it is not buried | poor -- 1 mm = 12 deg at 5 GHz |
| **magnitude** | `\|profile\|` minus `\|reference profile\|`, in dB | the detection DECISION -- this is the statistic that actually found the target (+4.4 dB at 21.2 cm against a 0.23 dB control) | good -- survives ~1 mm, which the complex difference does not |

Complex is for seeing; magnitude is for deciding. Neither is a better version of the other.

**Where each happens, and why they differ.** Complex subtraction stays in `App.jsx`
`sfcwProcessed` and writes back into `h_cal_real/imag` (it has to -- `SfcwDisplay`
recomputes its own profile from those, so anything replacing only `magnitudes` is
discarded). Magnitude subtraction *cannot* be expressed as a modified `h_cal`, so App
instead passes the background spectrum through as `bg_h_cal_real/imag` with
`bg_sub_mode: 'magnitude'`, and `SfcwDisplay` transforms both with whatever window is
currently selected and differences the results. Doing it there rather than in App keeps the
window / zero-pad controls live and guarantees both profiles are built identically, which
is the only way their difference means anything.

Consequences worth knowing:
- **dB and LINEAR are two DIFFERENT quantities here, not two views of one** (2026-08-30).
  dB gives `20log10|P| - 20log10|P_bg|`, a *ratio*: "by what fraction did this bin change",
  level-independent, and therefore amplifying noise wherever the profile nears the floor
  exactly as an ordinary dB trace does. LINEAR gives `|P| - |P_bg|`, an absolute
  *amplitude* difference: "how much energy was actually added here", so a bin sitting on
  the noise floor contributes almost nothing however wildly its ratio swings. Neither is
  the other rescaled, so the choice is made in the recompute (which now depends on
  `scaleMode`) and NOT by converting at draw time -- the usual `10^(x/20)` step is skipped
  in diff mode or it would be applied twice. The +/-0.7 dB detection band is drawn only on
  the dB flavour, because a relative cut has no single linear value.
- **R^n is disabled in magnitude mode.** Range compensation applies the same gain to both
  profiles, so it cancels exactly; leaving it live would be a control that does nothing.
- **The waterfall is cleared on a mode change**, because rows already in it are absolute dB
  in one mode and a ratio in the other. It refills at the sweep rate (~30 s for 100 rows).
  Making the toggle re-render the existing history instead would need the display to hold
  genuinely raw `h_cal` in both modes -- possible (App could pass the background in complex
  mode too, letting the display reconstruct `raw = result + bg`) but not done.
- **The FLOOR overlay is suppressed** in magnitude mode, and its estimator now skips the
  buffer entirely there: it converts stored rows with `10^(x/20)`, which is wrong for a dB
  ratio and wrong again for a linear difference.
- **The waterfall's wf transforms (CFAR-relative etc.) are bypassed** on a difference --
  they are defined against an absolute dB profile, and a difference is already referenced
  to something.
- A **+/- 0.7 dB detection band** is drawn instead, from `DETECT_THRESHOLD_DB`. That is 3x
  the 0.23 dB target-free control region from the A/B. **It is provisional** -- the control
  was measured before the reference-gain and sync_rx fixes dropped the floor ~15 dB, so the
  real threshold is now probably lower and re-running the A/B would buy sensitivity.

### Tooling

`scratchpad` probes only (not committed). If this needs redoing: drive `SFCWEngine`
directly with `sdr_server` stopped and keep `h_signal`/`h_reference` separately — the
websocket only carries `h_cal`, and the whole diagnosis turns on being able to tell the two
channels apart. Also record `max|I|,|Q|` per channel per step; ADC headroom is still
unguarded anywhere in `sfcw_engine.py`/`bladerf_driver.py`, and it was the entire answer here.

## RF Calib panel gains are NOT the SFCW sweep's gains (2026-08-25)

Easy to conflate since both transmit the same 100 kHz-offset CW tone (`set_waveform('cw',
offset=100_000, ...)`), but they carry **independent** gain state. RF Calib panel drives
`BladeRFDriver.tx_gain`/`rx_gain` directly (defaulting to 50 dB / 25 dB — see the RF Calib
defaults change above). `SFCWEngine._configure_hardware()` (`sfcw_engine.py:443-450`)
overwrites those same driver fields from its own `tx1_gain`/`rx1_gain`/`tx2_gain`/`rx2_gain`
and `amplitude=0.9` right before every sweep — these are set **independently** in both
`App.jsx` (`sfcwParams.tx1Gain`/`rx1Gain`) and `sfcw_engine.py`'s own `__init__` defaults,
and must be kept in sync manually; there's no shared source between the two.

**Verified 2026-08-25: user bench-tested the RF Calib panel at 60 dB TX / 90% amplitude /
40 dB RX (SFCW's gain point at the time) per the recommendation below, and confirmed the
result acceptable.** SFCW's own `tx1_gain`/`rx1_gain` defaults were then dropped from
60/40 to **50/25** (both `App.jsx` `sfcwParams` and `SFCWEngine.__init__`) to match the RF
Calib panel's defaults, since 50/25 was the tested-good operating point. `tx2_gain`/
`rx2_gain` (reference channel) were untouched. If SFCW's gains are ever changed again,
retest via the RF Calib panel at the *exact* new tx1/rx1 numbers first — testing at
whatever the RF Calib panel happens to default to does not characterize the sweep unless
the two are known to match, which is why they were brought into alignment here.

**Why harmonics of that 100 kHz tone (seen on the RF Calib panel's live FFT as spurs at
odd multiples — ~3×, ~5× — of the 100 kHz offset, tens of dB down) mostly don't reach the
SFCW range profile.** The RF Calib panel's FFT is a wideband capture — it shows everything
in the passband, harmonics included. `SFCWEngine._sweep_core` (`sfcw_engine.py:598-601`)
never does a wideband FFT at all: it demodulates by multiplying the raw RX IQ against
`exp(-j*2*pi*cw_offset*t)` and taking the mean over n=4096 samples — a single-frequency-bin
coherent extraction (matched filter) at exactly the 100 kHz reference frequency, not a
spectrum. Bin spacing at n=4096/10 Msps is ~2.44 kHz; a harmonic ~200-400 kHz away sits
roughly 80-165 bins off-target, which a rectangular-window single-bin DFT rejects by very
roughly another 45-55 dB beyond whatever level it already sits at in the wideband FFT. That
headroom is why the specific spurs found on the RF Calib panel are not expected to be a
first-order concern for h_cal quality — confirmed adequate at the 60/90/40 bench test above.

**What can actually corrupt h_cal, and isn't checked in software:** (1) TX compression at
the fundamental itself (100 kHz offset) — amplitude/phase nonlinearity right at the
frequency being measured isn't filtered out by the coherent extraction the way a harmonic
is, though it partially cancels through the `h_signal / h_reference` ratio if TX1/TX2
compress similarly; (2) RX ADC clipping from RX gain pushed too high — confirmed by grep,
there is no clipping/saturation check anywhere in `sfcw_engine.py` or `bladerf_driver.py`
(`_process_h_cal`'s phase-coherence check catches retune-timing corruption, not amplitude
clipping). Both are real, unguarded failure modes; the odd-harmonic spurs from the RF Calib
panel are, by contrast, structurally rejected by the demod and a lower-priority concern.

## Rover C-scans are background-gradient limited, not motion limited (2026-08-30)

Three 12x3 rover-driven C-scans (`3row`, `3row2`, `3row3`, 50 mm pitch, one pipe near
the scan centre; `3row` with no background, the other two with a corner `bgRef`) showed
nothing on the GUI, against a static rig that works consistently. Diagnosed offline from
the exported v6 JSON. **The target is not detectable in any of the three**, and the reason
is not the rover moving.

**Note `hStep`/`vStep` are in CENTIMETRES.** `hStep: 5` is a 50 mm cell pitch, and the
rover positions confirm it (x steps of 50.0 mm). Easy to misread as 5 mm and conclude the
gantry is mis-scaled.

### The dominant error is a smooth background gradient locked to ABSOLUTE rail position

`|gain|` of each cell against a common reference falls monotonically from ~1.12 at
x = 750 mm to ~0.80 at x = 1550 mm -- a ~30% amplitude ramp across the scan, plus a phase
ramp worth ~0.6-1 mm of apparent standoff. It is not drift and not noise:

- **It is spatial, not temporal.** The rover snake captures the middle row RIGHT-TO-LEFT
  and the outer two LEFT-TO-RIGHT. All nine rows across the three scans have the
  same-sign `ix` gradient (-0.006 to -0.020 per cell). A drift in time would flip the
  sign on the three reversed rows. It does not. **Regression cannot settle this** -- in a
  snake, capture index is a deterministic function of `(ix, iy)`, so "t adds nothing on
  top of x,y" is vacuous. The direction-reversal test is the only clean discriminator;
  use it.
- **It reproduces.** `3row2` and `3row3` overlap over 350 mm of rail and agree to ~0.03
  in `|gain|` at matched absolute x. Same position -> same background.
- **It lives at the WALL, not in the coupling.** Band-resolved swing across a row:
  0-6 cm (the alpha~0 coupling) **0.55 dB**, 6-10 cm 1.05 dB, **10-16 cm 6.3 dB**,
  16-30 cm 1.7 dB. So this is NOT the cable/coupling term CLAUDE.md's staleness section
  blames elsewhere -- that term is rock stable here. It is the wall return itself.
- **The standoff is fine.** The wall peak stays at 13.3-14.5 cm across the whole scan
  (<1 mm of movement), so the rail is parallel to the wall and this is not a range shift.

**The mechanism is a TILTED WALL changing the standoff, and it is anisotropic
(established 2026-08-30 from `row4`, which had LiDAR; supersedes an earlier
"coherent speckle" reading of the same data that was WRONG).** Two hypotheses were tested
and rejected first, do not re-run them: (1) beam/illumination change -- rejected because the
top-vs-bottom difference *reverses sign* across the band (+5.1 dB at 2-3 GHz, -2.7 at 3-4,
+1.5 at 4-5, same in all three scans); a real amplitude effect cannot do that. (2) a
two-echo relative path shift -- modelling `h(top) = a*NEAR(bot) + b*exp(-j2pi f tau)*FAR(bot)`
railed `tau` at the search boundary and bought 0.6-1.1 dB.

**The decorrelation is strongly anisotropic, and that is the whole tell:**

| separation | 50 mm | 100 mm | 150 mm | 200 mm |
|---|---|---|---|---|
| **horizontal** (same row) | 20.1-21.9 dB | 17.3-20.6 | 14.6-19.2 | 12.4-18.4 |
| **vertical** (same column) | 10.2-10.8 dB | 3.5-4.9 | 0.3 | -- |
| `row4` standoff change, horizontal | 1.2 mm | 1.8 | 2.2 | 2.4 |
| `row4` standoff change, vertical | 3.4 mm | 7.7 | 10.2 | -- |

Moving 200 mm sideways costs a few dB; moving 150 mm up destroys the background entirely.
The LiDAR says why: sideways changes the standoff by ~2 mm, upwards by ~10 mm. **Suppression
tracks standoff change, not distance travelled**, and the numbers sit close to CLAUDE.md's
own measured standoff-sensitivity table (5 mm -> 9.6 dB, 10 mm -> 4.2 dB). The same
anisotropy is present in the LiDAR-less `3row*` scans, so the tilt was there too.

**Methodological warning that produced the wrong first answer:** the original decorrelation
sweep matched cells on x, so *every* pair it measured was vertically separated. It probed
one axis and the conclusion "isotropic speckle, decorrelates in ~20 mm, cut the pitch"
was drawn from it. **Always measure both axes before calling a spatial effect isotropic.**
The pitch was never the problem -- horizontally, 50 mm sampling is fine.

**This is the explanation for "static works, moving does not".** Held still the background
is stable to ~20 dB and a +4.4 dB target is easy. Drive the rover vertically and the
standoff walks by ~7 mm per 100 mm of travel, which alone costs ~15 dB. The false target
seen while driving is the standoff-mismatched background failing to cancel.

**Consequence: a single captured `bgRef` cannot work on a rover raster.** Subtracting the
corner reference gives only 14-18 dB, and the best-matching cells are scattered randomly
over the grid with no spatial structure -- the residual left on screen is the gradient,
not the scene. A 6.3 dB position-dependent swing at exactly the wall range sits on top of
the **+4.4 dB** a real target produced in the 2026-08-28 static A/B.

### Per-cell repeatability drops ~18 dB under the rover

Revisiting the same physical (x,y) one minute apart (`3row2` vs `3row3`, 24 matched cells)
gives **20.3 dB** suppression / coherence 0.9943, against 38.6 dB single-sweep `S_repeat`
and 41.5 dB on the static bench. Magnitude-domain detector noise floor is **0.70-1.13 dB**
versus the static A/B's **0.23 dB** control region -- 3-5x worse.

**Settling is NOT the cause and is ruled out.** The first cell of each row follows a slow
50 mm Y move, the rest follow fast X moves; after removing a smooth 2D fit their residuals
are indistinguishable (-26.8 dB row-start vs -25.6 dB mean for the others, inside the
scatter). So the 100 ms `roverSettleMs` used here was not leaving the structure ringing.

### Adjacent cells are independent, so no image can form

Residual patches correlate **+0.79** between scans at the same absolute position, but only
**+0.11 to +0.23** between rows 50 mm apart within one scan. Each cell is individually
repeatable while its neighbour 50 mm away is an independent sample -- so the plan view is
a field of uncorrelated cells regardless of colour scale. No hyperbola appears in any
B-scan under any of four background strategies (raw, corner `bgRef`, per-row mean
subtraction, 2D polynomial detrend), and after detrending, residual bumps of 1-4 dB sit at
random x and repeat neither between rows nor between scans.

### Also: these scans have NO LiDAR at all

`lidar_standoff_mm` is `null` and `lidar_n` is `0` for all 36 cells in all three files.
So `bgForStandoff()`'s phase alignment was the identity and the BG-model path would have
been dead on arrival (`inferBgModel` needs a standoff). Harmless for a fixed-standoff rail
raster, but it means a model-based background was never an option for these captures --
check `lidar_n` before blaming the model.

### What to try next, in order

1. **Level the rig against the wall.** This is the root cause and by far the cheapest fix:
   `row4` measured a 17 mm standoff span (40.4 mm bottom-left to 23.2 mm top-right) over a
   700 x 150 mm grid. Get that under ~2 mm and the vertical axis behaves like the
   horizontal one already does. The 50 mm pitch is NOT the problem.
2. **Reference per row, not per scan.** Even untilted, a single `bgRef` only holds while
   the standoff does. Capturing one reference per row costs almost nothing and removes the
   dominant residual term.
3. **Or self-reference along the scan line**, the standard GPR move: subtract the per-row
   mean, or SVD out the leading components (`lib/svd.js` still exists and the Aligned /
   SAR / 2D Map panels already do this; it was removed from the C-scan panel). This needs
   no reference capture but will absorb any target broad enough to look like trend, which
   is the likely reason the polynomial detrends here found nothing.
3. Re-run the 2026-08-28 target A/B **on the rail** (target in / target out at one fixed
   cell) before scanning again. It is the only measurement that has ever detected this
   target, it costs two captures, and it separates "the target is invisible to the sensor"
   from "the raster is destroying it".

## `bscanBg.js` phase-alignment has an INVERTED SIGN and is net-harmful (2026-08-30)

Found on `row4` -- a 15x4 C-scan of an EMPTY wall (no target, so every detection is false by
construction) captured with the LiDAR working, background taken at the top-left corner.
Reported symptom: "the bottom rows came out near clean but the upper rows had detections."

### The sign is backwards

`bgForStandoff()` in `groundstation/frontend/src/lib/bscanBg.js` multiplies the reference by
`exp(+j*2*pi*2*deltaD*f/c)` where `deltaD = standoff_cell - standoff_ref`. An echo at
distance `d` is `exp(-j*2*pi*2*d*f/c)`, so that factor moves the background the **wrong way**.
Verified empirically: a synthetic echo placed at 100 mm, given `deltaD = +10 mm`, moves to
**90 mm** when it must move to 110 mm. **The correction therefore applies `-deltaD` instead
of `+deltaD`, doubling the standoff error to `2*deltaD` rather than removing it.**

### It costs 6.5 dB and drives suppression NEGATIVE

Mean suppression over `row4`'s 60 cells, sweeping an alignment strength `alpha` on `deltaD`:

| alpha | -1.0 (sign flipped) | -0.5 | **-0.25 (optimum)** | **0 (no alignment)** | +0.5 | **+1.0 (shipped)** |
|---|---|---|---|---|---|---|
| suppression | 6.41 dB | 10.44 | **11.88** | **10.90** | 6.96 | **4.38** |

Per row with the shipped code, top to bottom: **-0.2, 1.2, 6.6, 10.0 dB** -- the top two rows
go *negative*, i.e. the subtraction adds more energy than it removes. Without alignment the
same rows give 7.6, 9.7, 15.6, 10.6 dB. Even the reference cell itself drops 29.2 -> 20.3 dB,
because its own `deltaD` of 0.8 mm gets doubled to 1.6 mm.

**Fixing the sign is NOT enough and is not the recommended change.** A correctly-signed full
alignment (`alpha = -1`) still scores 6.41 dB, worse than doing nothing (10.90). The reason is
CLAUDE.md's own echo decomposition: the dominant background component sits at alpha ~ 0, a
static coupling reflection that does not move with standoff at all, so shifting the *whole*
spectrum corrupts the largest term in either direction. The optimum `alpha = -0.25` is the
fraction of background energy that actually tracks standoff, and it only buys 1.0 dB over
disabling alignment entirely. **Recommended: disable the alignment (or gate it behind a small
tuned alpha), do not merely flip the sign.**

### Why the top rows and not the bottom

The wall is tilted. LiDAR standoff runs **40.4 mm at bottom-left to 23.2 mm at top-right**;
row means bottom-to-top are 37.2 / 34.5 / 29.2 / 27.0 mm. The reference was captured at
**37.6 mm**, which matches the BOTTOM rows -- so the bottom rows are near-zero mismatch and
clean, while the top rows are 10-14 mm out. Regressing aligned suppression on standoff
mismatch and on lateral distance from the reference cell gives **-1.256 dB per mm of
mismatch, R^2 = 0.827** (correlation -0.910), with lateral distance contributing
**+0.0001 dB/mm, i.e. nothing**. Standoff mismatch is the entire story in this scan.

Note the top-left reference cell is an outlier for its own row (36.8 mm against 23-25 mm
across the rest of it), so "top-left corner" happened to pick a standoff representative of
the far side of the grid. Picking a corner is not a neutral choice on a tilted wall.

## C-scan pipeline changes (2026-08-30)

Three changes, all in the direction of "the pipeline does what the UI says it does".

**1. The captured-reference phase alignment is GONE** (`lib/bscanBg.js` `bgForStandoff`).
It is not a toggle and never was -- it applied itself silently whenever both the cell and
the `bgRef` carried a LiDAR standoff, which is why it only surfaced once the LiDAR was
fixed. The `3row*` scans predate that and were never aligned; `row4` was. See the sign-bug
section above for the measurements. `bgForStandoff` no longer takes `freqs`, and the
now-unused `SPEED_OF_LIGHT` came out of that file with it.

**2. Gate/depth defaults raised to 70 cm** (`App.jsx` `bscanParams`): `gateEnd` 15 -> 70 and
`maxDepth` 30 -> **70**. `maxDepth` was raised deliberately alongside it, not incidentally --
the Max Depth field's own `onChange` clamped `gateEnd` to `maxDepth`, so leaving it at 30
would have silently snapped the new 70 cm gate back to 30 the first time anyone touched that
field. **SUPERSEDED 2026-08-31: `maxDepth` no longer exists in `bscanParams`** -- see the
C-scan imaging section below. The coupling it describes is gone with it; SAR's depth is now
`sarMaxDepth` on the SAR panel.

**3. Rover session is now ARM then SCAN, two presses** (`hooks/useRoverScan.js`,
`CscanPanel.jsx`, `App.jsx` `handleBscanAction`). Start Session starts the sweep and drives
to the grid origin, then parks in a new `'ready'` phase and waits. A separate **Start Scan**
button begins the raster (`roverScan.beginRaster()`, action `'start_raster'`). The reason is
that a background reference is only valid near the position it was taken at, and the old
flow began rastering immediately, so there was no moment at a known position -- with the
sweep already running -- to capture one. `beginRaster()` re-reads `capturedCount` at the
moment it is pressed rather than trusting what arming saw, so capturing or undoing while
parked cannot desync the start index. It is a no-op unless the phase is exactly `'ready'`.

The `'ready'` phase keeps the machine and its 40 ms tick alive, so the link-lost and e-stop
checks at the top of `tick()` still run while parked -- that is the whole reason it does not
just halt. Verified headlessly (React shimmed to four functions, timers stubbed, fake clock):
arming parks at `ready` and stays there through 5 s of ticks without self-starting; Start
Scan then snakes a 3x2 grid top-left downwards in the correct order and finishes `done` with
6 cells; `beginRaster()` during `homing` is a no-op; e-stop and link-loss while parked both
abort and stop the sweep.

### Known hidden behaviour still in the C-scan path (audited 2026-08-30, NOT changed)

- ~~`alignShifts` dead code~~ **REMOVED 2026-08-30** (see below). Everything else in this
  list was audited and deliberately left alone.
- **The C-scan recomputes its own range profiles and throws the Pi's away.**
  `applyBscanBg` calls `computeRangeProfile` for every cell *even when background
  subtraction is off*, replacing `magnitudes`/`distances` from the wire. That profile is a
  **rectangular-windowed, 4x zero-padded IFFT with no range compensation and no averaging**
  -- so the C-scan and its B-scan pane do not match the SFCW panel's live display, whose
  window / Kaiser beta / R^n / Avg controls do not exist here.
- **The rover raster silently discards one sweep per cell** (`skip: 1`), because a sweep in
  flight when the settle expires started while the gantry was still moving. Costs ~250 ms a
  cell and is invisible on screen.
- **The BG *model* path still does a phase unwind** -- `lib/bgModelInterp.js`
  `UNWIND_ALPHA = 0.80`, applied on build and rewound on inference. This is a different
  animal from the deleted `bgRef` alignment (it is fitted across many knots rather than
  extrapolating one capture, and it measured 20.2 dB LOO) but it is equally invisible, and
  `inferBgModel` still **clamps silently** outside the model's standoff span.
- **`metric: 'energy'` is a mean, not a sum** (`cscanGrid.js` `gatedIntensity` returns
  `10*log10(sumLin/count)`), so it does not scale with gate width the way the name implies.

## C-scan imaging: one shared scale, per-cell BG status, magnitude mode, Super Fit (2026-08-31)

### The two panes were scaled to different things

Audit finding, now fixed. The C-scan grid took dynamic colour limits from the
**min/max of the gated cell values over the whole grid**; the B-scan pane took
them from **min/max of every bin in the SELECTED ROW ONLY** -- and included the
unsubtracted BG reference row in that. Consequences: the same colour meant a
different dB in two images shown side by side, clicking to another row silently
re-scaled the right-hand one, and with a background loaded the BG row (20-30 dB
above every residual) set `dbMax` on its own and crushed the actual data into the
bottom few percent of the colormap -- a **working subtraction looked empty**.

`computeSharedScale()` (`lib/cscanGrid.js`) now computes **one** pair of limits
from every bin of every valid cell -- exactly the pixels the B-scan pane draws --
and both displays use it. The BG row is still drawn but no longer votes.

**Limits are percentiles (p1 / p99.9), not min/max.** A range profile has deep
interference nulls and a subtracted one has more; a single bin at -140 dB would
otherwise set the bottom of the scale and flatten everything above it. A full
min/max stretch of a flat residual field is exactly the mechanism that
manufactures rainbow structure out of noise (see the display hypothesis in the
target A/B section above). There is a degenerate guard: subtracting a Super Fit
reference from the grid it was taken from gives exactly zero in every bin, which
is a useful "same data" signal, not an error.

### A cell whose background fails is INVALID, not zero

`applyBscanBg` used to fall through silently when `bgForStandoff` returned null
(no lidar standoff, `numSteps` mismatch), leaving that cell **un-subtracted in a
subtracted grid** -- 20-30 dB above its neighbours, so it both read as the
strongest target in the scan and single-handedly set the dynamic colour limits.
There was no diagnostic anywhere in the C-scan path; the SFCW panel got
`sfcwProcessed.diag` in Phase 0 and this never did. Recall the `3row*` scans had
`lidar_n: 0` on all 36 cells, so a model background would have failed on every
one of them.

Every position now carries a `bg_status` (`BG_STATUS` in `cscanGrid.js`):
`off` / `ok` / `clamped` / `no_standoff` / `no_ref` / `size_mismatch` /
`no_superfit_cell`. Invalid cells draw as a red cross on a dark red ground (a
colour no colormap produces), are excluded from every scale, and are counted in
an Applied / Clamped / Invalid readout in the panel.

**`clamped` is new information too.** `inferInterpModel` clamps to the nearest
knot and returns a confident-looking spectrum; the model span was previously
only checked against the *live* lidar, never against what a cell was actually
captured at. Clamped cells are drawn but carry an amber corner.

### Complex vs magnitude, in the C-scan

The toggle the SFCW panel already had. Complex is for **seeing** (removes the
wall so a target 16.6 dB beneath it is not buried); magnitude is for
**deciding** (+4.4 dB at 21.2 cm against a 0.23 dB control in the target A/B,
and it survives ~1 mm of standoff error, which the complex difference does not).
Neither is a better version of the other -- do not delete one again.

- Magnitude mode transforms BOTH spectra and differences the dB profiles.
  `h_cal_real/imag` are left **raw**, because a dB difference is not a spectrum
   -- so **SAR must stay on complex**, and it does: `processedBscanData` is
  complex-only and feeds SAR and the 2D Map, while `cscanProcessedData` carries
  the mode and feeds only the two C-scan panes (it aliases the complex result
  when the mode is complex, so nothing is computed twice).
- `gatedIntensity` needed **no change**: `lin*lin` with `lin = 10^(db/20)` is
  exactly `10^(db/10)`, so the same expression is a mean power in absolute mode
  and a mean **power ratio** in difference mode.
- The linear colour warp is bypassed in difference mode (it maps an amplitude;
  a dB ratio has none) and the colour bar gets a zero line and signed labels.
- Measured on a synthetic two-echo scene: **the largest |Δ| does not land
  bin-exactly on the target and is often NEGATIVE.** A target on the skirt of a
  much larger wall return interferes with it, so the peak lands where that
  interference is strongest -- 0.330 m for a target at 0.300 m, within the
  50 mm range resolution. Read |Δ| against a threshold, not the sign, and do not
  expect ranging from it.

### Super Fit: a whole reference GRID, matched cell for cell

A single captured reference is only right at one position. The 2026-08-30 rover
diagnosis measured a **17 mm standoff span over one 700x150 mm grid** (the rig is
not parallel to the wall), a 6.3 dB position-dependent swing at exactly the wall
range, and only 14-18 dB from a corner reference. Super Fit stores every cell of
a completed grid and subtracts each new capture from **the reference at its own
(grid_ix, grid_iy)**, so a standoff that varies across the grid is matched rather
than extrapolated.

Workflow: scan (or import) the bare wall, press **Super Fit This Grid**, clear
the grid, rescan the same wall from the same origin.

- **Keyed by cell index, never by capture order.** Manual snakes up from the
  bottom-left and the rover snakes down from the top-left, so the two orders
  visit the same cells in different sequences; matching on order would subtract
  every cell against the wrong patch of wall. Verified both orders produce an
  identical grid.
- **Grid geometry is locked while a Super Fit is loaded**, for the same reason --
  changing a count or a step silently re-keys every cell. The panel also warns if
  the geometry no longer matches what was captured.
- Mutually exclusive with the captured reference and the model, like they are
  with each other. `bscanBgDisplay` is deliberately **null** under Super Fit:
  its reference is a different spectrum per cell, so no single BG row represents
  it.
- Requires a **full** grid. A partial reference would leave cells with no
  background, and those are now refused rather than passed through raw.

Measured on a synthetic tilted wall (3x2 grid, wall face walking 4 mm per column
and 10 mm per row, one target 22 dB below the wall face in one cell):

| background | target cell | brightest other cell |
|---|---|---|
| corner captured reference | -23.2 dB | **-13.2 dB** (target is not the brightest) |
| **Super Fit** | -40.0 dB | **-101.7 dB** (61 dB of contrast) |

### The Live Sweep controls bar now drives the C-scan (2026-08-31)

The bar on top of the C-scan viewport used to affect only that pane -- its Window
and Avg settings never reached the grid, so the panel showed a range profile
processed differently from the two images under it. It is now the C-scan's
processing surface. `SfcwDisplay` gained optional `procParams` /
`onProcParamsChange` (controlled `{windowType, kaiserBeta, avgCount, avgMode}`),
`procLocked`, and `hideRangeComp` / `hideFloor` / `hideCfar` / `hideYMode`. Omit
them all and the component behaves exactly as before, which is what the SFCW
panel's own instance does.

**Four controls were removed from the C-scan's instance**, each because it could
only disagree with the image beside it:
- **R^n** applies the same gain to every cell and to the background alike, so it
  cancels out of every comparison a C-scan makes.
- **FLOOR** is estimated from this pane's own rolling sweep history, which
  describes the live sweep, not the recorded cell being drawn.
- **CFAR** is a per-trace detector nothing in the grid pipeline reads.
- **Y session/frame**: 'session' extremes accumulated over a whole raster would
  leave the axis set by whichever cell was loudest. Pinned to 'frame'.

Hidden controls are forced OFF rather than merely not rendered, so a stale
default cannot keep applying itself.

**The bar locks while a session runs** (`sfcwRunning || roverScan.active`).
`avgCount` genuinely cannot change part-way through a raster -- different cells
would hold different numbers of sweeps -- and the window is locked with it so
every cell in one grid is processed identically. Everything unlocks when the
session stops and then re-derives the whole grid live.

### Windowing is a display parameter; Avg is a capture parameter

- **Window / Kaiser beta** re-window every stored cell on change, so they can be
  moved freely over already-captured or imported data. `rangeProfile.js`
  `computeRangeProfile` takes an optional taper (from `imagingEffects.js`
  `windowFn`, the same one the SFCW display and Imaging Bench use). Measured on a
  single synthetic echo: sidelobes rel. peak **rect -18.0 dB, Kaiser beta 3 -29.1,
  Hanning -31.5**, with -3 dB mainlobes of **5 / 5 / 7 bins**. Rectangular stays
  the default -- Hanning's wider mainlobe would swallow a target 7 cm from the
  wall face, which is exactly the case here.
- **Avg** is how many sweeps are taken at each grid cell, so it only affects
  captures made after it is set.

### Every sweep of a cell is stored, so coh/inc stays live

A cell captured with Avg > 1 keeps **all** its sweeps in `pos.sweeps`, not just
the average, because coherent-vs-incoherent is a *display* choice and has to
remain flippable against recorded data. `pos.h_cal_real/imag` is the **coherent
mean** (not the last sweep -- that was a bug in the first draft), so everything
that reads `h_cal` without knowing about `sweeps` -- SAR, the BG-model trainer,
Super Fit, `svdFilter`, the export -- sees the averaged cell. `cellSweeps()`
falls back to the single spectrum, so a pre-v7 record is exactly an N=1 cell;
verified byte-identical output.

**Order of operations is deliberate: the background is subtracted from each
SWEEP, before averaging, not from the average.** For coherent averaging the two
are identical (both linear); for incoherent they are not -- averaging `|signal|`
first and subtracting a complex background afterwards is not a defined
operation, whereas subtracting per sweep and then averaging magnitudes is
exactly "N independent looks at the residual".

Measured (synthetic, 16 looks): coherent averaging lowers the residual peak by
**-13.7 dB against an ideal -12.0**. At a bin far above the noise floor coherent
and incoherent agree to **0.1 dB**, and at a null sitting at the floor incoherent
reads **1.6 dB high** -- the noise bias, and the entire difference between the
two modes. Note the SIZE of that gap is bounded by how far the null sits below
the single-look floor, and more looks do NOT widen it (checked at N=64): once
coherent has driven its own floor below the null, what remains is fixed by the
incoherent floor. The direction is the invariant, not the magnitude.

Cell-level provenance is pooled over the sweeps actually taken (mean standoff,
summed `lidar_n`), so a multi-sweep cell reports the standoff it was really
measured at rather than whichever sweep landed last -- the BG model is evaluated
at that number.

**SAR is forced to `avgMode: 'coherent'`** regardless of the toggle: it
back-projects complex data, so an incoherently averaged magnitude profile is not
an input it can use. It does follow the window.

**The rover capture watchdog scales with Avg.** `useRoverScan`'s flat
`CAPTURE_TIMEOUT_MS = 20000` was plenty at one sweep per cell and would have
tripped part-way through an Avg of 16; it is now
`20 s + 2 s * (sweepsPerCell - 1)`.

**Export is v7** (`sweeps` + `procParams`). Import restores `windowType`,
`kaiserBeta` and `avgMode`, but reads `avgCount` back from the data rather than
the header -- the sweeps are in the file and their number is whatever was
actually taken.

### Also fixed: Manual scaling seeded from the wrong data

`seedManualRange()` rebuilt the grid from `scanData`, which the Sidebar passes as
the **raw** capture list -- before background subtraction, and computed by the Pi
with a **Hanning window at nfft 204** where the display uses a **rectangular
window at nfft 256** (~4 dB apart for a single tone, on a different bin grid).
The seeded limits were wrong by the full suppression plus that offset, so the
colours jumped hard on every switch to manual -- the exact thing the comment
above it promised they would not. It now reads the shared scale the displays draw
with.

### Still true, and still worth knowing

- **The C-scan recomputes its own range profiles and throws the Pi's away**,
  rectangular / 4x zero-pad / no range compensation / no averaging, even when
  subtraction is off. The SFCW panel's Window / Kaiser / R^n / Avg / CFAR / FLOOR
  controls are `SfcwDisplay` local state and do **not** exist here. Note the
  window trade is not obvious: rectangular has -13 dB sidelobes but a ~9.8 cm
  null-to-null mainlobe, Hanning gets -31 dB sidelobes for a ~19.5 cm mainlobe --
  which would swallow a target 7 cm from the wall. Expose and A/B it against a
  target in/out capture; do not assume Hanning is the upgrade.
- **The Live Sweep pane at the top of the C-scan viewport uses the SFCW panel's
  background** (`sfcwBgModel`/`sfcwBgRef`), not the C-scan's. The two can
  disagree silently.
- **`maxDepth` is gone from the C-scan panel (2026-08-31).** It did two unrelated
  jobs: clipping the B-scan pane's display, and bounding SAR's reconstruction
  grid. The first was pointless -- the default clipped 70 cm off a ~74 cm record,
  so it hid the far end of the data and bought nothing, while looking like a
  depth control next to the Depth Slice gate, which is the actual one. The B-scan
  pane and the shared scale now cover the whole profile unconditionally. The
  second is a real parameter and moved to the **SAR panel** as `sarMaxDepth`
  (same 70 cm default), since it sets the extent and cost of the reconstruction
  rather than what a display shows. The Depth Slice gate's upper bound is now
  derived from the record itself (`c/(2*step)/2 - range_offset`, read off a
  captured profile) instead of tracking a second field. Import still reads a v3
  `wallThickness` / v4+ `maxDepth` and restores it into `sarMaxDepth`.
- Default gate is 2-70 cm with `metric: 'peak'`. With the wall at 13-14 cm,
  `max()` over that gate picks the wall in every cell -- the plan view is then a
  wall-strength map, which is precisely the gradient the rover scans showed.
  Narrow the gate around the expected target depth and prefer `energy`.
- `metric: 'energy'` is a mean, not a sum, so it does not scale with gate width.

### Verification

`lib/cscanGrid.js` and `lib/bscanBg.js` are pure and were exercised head-first
from node (21 checks: Super Fit self-subtraction exact-zero, target isolation
against a tilted wall, capture-order independence, magnitude-mode difference and
range, all six `bg_status` paths, invalid-cell exclusion from the shared scale,
percentile clipping, degenerate guard). There is no test runner in this repo, so
those were throwaway scripts -- worth rebuilding as real tests if this grows.

**Fixture trap worth remembering:** synthetic echoes must be placed at
`depth + range_offset` (0.5 m by default). Placing them at the intended display
depth puts them at negative distance, where `computeRangeProfile` drops them, and
every subsequent measurement is of sidelobes only -- which still looks plausible.

### The third standoff-alignment path, removed 2026-08-30

Separate from the `bgRef` phase ramp: `App.jsx` carried a ~45-line `alignShifts` `useMemo`
computing per-position range-bin shifts from LiDAR standoff, handed to `Viewport` as
`bscanAlignShifts`, declared as a prop there and **read by nothing**. Its consumer half
lived in `BscanDisplay` -- a per-frame lerp toward `targetShifts`, which `Viewport.jsx` fed
`rowData.map(() => 0)`, i.e. hard-wired to zero. So the display animated toward zero forever
and `getRowPixelOffset()` always returned 0.

The whole path is gone: the `useMemo`, both props, `getRowPixelOffset`, the `pxOffset` terms
in the two x-coordinate expressions, the two shift refs and the lerp. **Provably
behaviour-neutral** -- the offsets were always exactly 0.

Two things worth keeping in mind about what was left behind:
- **The rAF loop in `BscanDisplay` stays, deliberately.** With the lerp gone there is
  nothing animated, so a one-shot draw looks tempting -- but `drawBscan` sizes itself from
  `getBoundingClientRect()`, and redrawing every frame is what makes the canvas track a
  panel resize. Replacing it with a draw-on-change effect needs a ResizeObserver first.
- It also fixed a latent bug: `targetShifts={rowData.map(() => 0)}` built a fresh array
  every render, so that effect's dependency changed identity every render and tore down and
  restarted the rAF loop each time. It now re-runs only when something real changes.

## C-scan plan view: full-screen grid, rotated row detail, to-scale projection (2026-09-06)

Three changes aimed at projecting the plan view back onto the wall it was swept
over.

### The grid owns the viewport; the B-scan is a detail view you open

`selectedCell` (local to `Viewport.jsx`) starts null and **no longer falls back
to the last captured cell**, so the plan view holds the whole area until a cell
is clicked. Clicking opens the row; clicking the same cell again, or the X in
the pane header (`PaneHeader` gained an optional `action`), closes it. Losing
the selection off the edge of a shrunk grid closes it too.

The empty-state text in that pane changed with it: it now says "Row not
captured yet", because the pane can only be open on a chosen row, and "No scan
data" was describing a state it can no longer be in.

### The row's B-scan opens BELOW, rotated 90 degrees anticlockwise

Not beside. Rotating anticlockwise sends the old left edge (bin 0) to the bottom
and the old top edge (position 0) to the left, so **depth runs bottom-to-top and
position runs left-to-right** -- the same axis, same direction, and (see below)
the same pixels as the grid's horizontal axis directly above it. Stacked rather
than side-by-side because a raster is usually far wider than it is tall: the
detail view then costs a strip of height (38%) instead of a third of the width,
and the grid keeps its scale.

**`BscanDisplay` is now written against two slot functions rather than two
painters.** `makeGeom()` returns `binSlot` / `rowSlot` plus `cell` / `rowBand` /
`binBand` / `binLine` / `rowLine` / `profilePoint`, and every draw call goes
through them; `orientation` picks the mapping. Duplicating the painter was the
obvious alternative and was rejected -- the two images would have drifted apart
on the next change. Two consequences that are easy to get wrong if this is
edited:

- **`profilePoint` is orientation-independent by construction.** The
  anticlockwise rotation sends "up" to "left", so `perp = slot.a + span -
  norm*span` is the value axis in BOTH orientations. Do not "fix" the vertical
  case by negating it.
- **The gate's near end swaps.** Bin 0 is at the bottom when vertical, so the
  gate's START label belongs at the LOWER edge and END at the upper. The shading
  is computed from `min`/`max` over the two end slots rather than assuming which
  is which.

`orientation` defaults to `'horizontal'`, which is byte-for-byte the old image;
the C-scan panel is the only caller and passes `'vertical'`.

### Column alignment: the two panes share one layout, via a ref

The old `layout()` moved out of `CscanDisplay.jsx` into `lib/cscanGrid.js` as
`cscanLayout(w, h, params, projection)` (+ `CSCAN_PAD`). The plan view writes its
computed layout into a ref every frame (`onLayout`), and the B-scan reads it on
its own frame (`alignRef`) and places each position at `originX + grid_ix*cellW`.
**A ref, not state** -- both canvases already redraw at 60 Hz, so re-rendering
the tree to share four numbers would be the expensive way to do it, and it is
the same pattern `sfcwDynamicScale` uses.

Alignment engages only when every drawn position carries a `grid_ix` (an
imported linear scan has none and falls back to even spacing), and the pane says
`ALIGNED` in its title when it is on. Two cases worth knowing:

- **Columns are keyed on `grid_ix`, never on capture order.** A half-captured
  row would otherwise slide left, and manual/rover snake in opposite directions
  anyway.
- **The background reference row gets its own slot just left of the grid**, not
  a column in it -- as row 0 of an evenly-spread list it would shift every real
  column along by one. The plot clip is widened to include it.

### To-scale projection, and explicit placement

`cscanProjection = { toScale, pxPerCm, leftPx, topPx }` in `App.jsx`, persisted
to `localStorage.cscan_to_scale` / `cscan_px_per_cm` / `cscan_left_px` /
`cscan_top_px`, edited in the C-scan panel's **Projection** section (toggle,
px/cm field with -5/-1/+1/+5% trim, Left/Top fields with +-1/+-10 px nudges).
Default off, 8 px/cm at 60, 80 px.

On, the grid is drawn at exactly `pxPerCm` screen pixels per centimetre with its
TOP-LEFT corner at exactly `(leftPx, topPx)`. **The point of both is that the
mapping stops depending on the pane size** -- fitted, centred layout re-derives
itself from the box it is in, so opening a row's B-scan or resizing the window
silently moves everything, which is exactly what makes an aligned projection
drift. The operator tunes scale against the projector's zoom and offset against
its aim until the grid lands on the real geometry, then leaves both.

**`leftPx` / `topPx` are measured from the top-left of the VIEWPORT -- the whole
area right of the sidebar -- not of the C-scan canvas, and that distinction is
the entire reason they hold still.** `cscanLayout` takes a `canvasOffset` (the
canvas's position inside `Viewport`'s root element, passed as `rootRef` and read
per frame from `getBoundingClientRect`) and subtracts it, so when the Live Sweep
pane appears or a row's B-scan opens, the canvas moves under the grid and the
grid does not move on the wall. Measured from the canvas instead, every pane
change would slide the projected image -- the same failure as fitted scaling,
by a different route. Verified: the placement is invariant across a canvas
offset of 30 px and one of 230 px.

The offsets apply **only** to scale; fitted mode ignores them and stays centred.

**Clipping.** To scale the clip box is the WHOLE CANVAS, not the padded plot
box -- reserving axis margins there would silently forbid placements the
operator asked for. Fitted, it is the plot box as before. `L.clip` carries
whichever, and the axis ticks cull against it. **A grid that falls outside is
CLIPPED, not re-fitted**, and the title says
`TO SCALE · n px/cm @ x,y px · CLIPPED`; `overflows` now means "any part is
outside the box", so it catches a grid pushed off an edge by its placement or by
a pane change, not only one that is too big. Re-fitting would be the silent
re-scaling this mode exists to avoid.

**The BG reference column switches sides.** Aligned, it sits just left of the
grid -- unless the grid is placed hard against the left edge, where there is no
room and clamping it into the margin would put it on top of data column 0; it
then goes to the right of the last column instead. The B-scan's plot clip is
widened to whichever side it landed on. Found by the checks below, not by eye.

### Projector output window (2026-09-06)

**There is no browser API that "sends a view to a display".** Screen sharing is
CAPTURE and this is OUTPUT; `getDisplayMedia` is the wrong direction and cannot
help. The closest primitive is the **Window Management API**
(`window.getScreenDetails()`, Chrome, behind a `window-management` permission
prompt that requires a user gesture): it enumerates the attached displays, and a
window can then be opened on one of them and full-screened there.
`components/ProjectorWindow.jsx` exports `listDisplays()` for the enumeration --
called from the panel's click handler, because of the gesture requirement -- and
the component itself owns the window.

Where the API is unavailable (Firefox, Safari, Chrome with the permission
denied) **there is no way to learn a second display exists at all.** That is not
an error path to fix; `listDisplays()` returns `null`, a normal popup opens on
the current screen, and the panel says to drag it across and press F11.

**The content is a React PORTAL, not a second app.** The projector reads the
same props as the panel -- same grid, same colour limits (`planViewScales()` is
shared by both so a third copy of that choice cannot drift), same to-scale
placement -- so there is no message channel, no serialisation of the grid, and
no way for the wall to disagree with the monitor. Everything the operator
changes appears on the wall on the next frame. The popup document gets a clone
of the app's `<style>` / `<link rel=stylesheet>` nodes, cloned rather than
re-linked because in dev Vite injects styles with no URL to point at.

Three things that are easy to get wrong and are already handled:

- **`devicePixelRatio` must come from the CANVAS's window, not `window`.** The
  projector can be on a display with a different ratio, and reading the control
  window's would size the backing store wrongly. `drawCscan` now reads
  `canvas.ownerDocument.defaultView.devicePixelRatio`.
- **So must `requestAnimationFrame`.** A browser throttles rAF on a page it
  considers hidden, so driving the projected image from the control window would
  freeze the wall the moment the operator switched tabs or minimised -- which
  they will do mid-session. `CscanDisplay`'s loop schedules on the canvas's own
  window and bails if that window has closed.
- **The offsets measure from the PROJECTOR's corner there.** `rootRef` is the
  projector window's own container, so `leftPx` / `topPx` place the grid inside
  the projector window exactly as they place it inside the viewport on the
  monitor. Same numbers, same meaning, different surface.

`chromeless` on `CscanDisplay` is the projected image: cells, the frame that
bounds them, and the next-cell marker. Axes, titles, the colour bar, the capture
path, the START marker and the hover readout are instruments for reading the
plan view on a monitor -- projected they would be light falling on brick beside
the measurement, and their positions are meaningless once the grid is placed by
hand anyway. That instance also has no pointer interaction and uses inline
styles rather than utility classes, since it renders into a document whose
stylesheet is a clone.

State lives in `App.jsx` (`cscanProjector`), **not in `Viewport`**, so switching
to another panel does not tear down a window that is currently lighting a wall.
A blocked popup comes back through the same `onClose` channel flagged
`'blocked'` rather than needing a second prop.

**A POPUP DOES NOT SURVIVE StrictMode's double-invoke, and this broke the whole
feature under `npm run dev` while the production build worked (fixed
2026-09-06).** `main.jsx` wraps the app in `<StrictMode>`, so in development
React mounts every effect, tears it down, and mounts it again. Naively that is
open → close → open, and **the second open is refused**: the click's user
activation is spent on the first one. Instrumented in a real Chrome:

    window.open #1 -> a window
    window.open #2 -> null          // popup blocker
    panel -> "The browser blocked the popup"

So the projector never opened at all in dev, and the panel blamed the browser's
popup settings -- which is what made it look like a random browser problem
rather than a bug here, and why it did not show up in the production-build
tests. **Anything opening a window, requesting a device, or taking a
one-shot user gesture in an effect has this hazard; test it against the DEV
server, not just `vite build`.**

Fixed by never closing across a remount: the window is held in a module-scope
record (module scope so it outlives both the remount and an HMR module reload),
the effect *reclaims* it instead of opening a second, and the close is deferred
by a tick so a remount inside that tick cancels it. A genuine unmount has no
remount to cancel it, so the window still closes -- verified close-then-reopen
does exactly two `window.open` calls for two sessions, with none blocked.

Two related hardenings went in with it, both cases where a throw would have left
an empty black window with no way to close it from the panel:

- **`setContainer` now happens BEFORE the fullscreen request.**
  `requestFullscreen` documents a rejected promise, but a bad `screen` member is
  a synchronous TypeError, and a throw there aborted the effect with the portal
  never mounted and no cleanup registered.
- **Fullscreen falls back.** `{screen}` is tried first (that is what puts it on
  the projector rather than on whichever display the window touches); on any
  failure, plain fullscreen still lands on the display the window was opened on.
- **A window opened by NAME can be one that already exists** -- after an HMR
  reload the module record is gone but the window is not -- so the document is
  furnished only if it has no `[data-projector-root]` yet. Without that it
  collected a second root and another copy of the stylesheet on every hot
  reload.

**Relative controls must use the updater form.** `setCscanProjection` accepts a
value OR a function and composes updaters within a tick through a ref. The nudge
buttons are relative, so a burst of clicks before React re-renders would
otherwise all read the same stale value: measured, **four +10 px presses moved
the grid 10 px, not 40**, before this. localStorage is written in the setter
rather than inside a state updater, which React is free to call twice.

### START and the capture path come from the DATA, not from `scanMode`

`CscanDisplay` used to draw the START marker and the dashed raster path by
re-deriving the visit order from the panel's current `scanMode`. That is wrong
for any record whose capture mode is not the one currently selected -- **which
is the normal case for imported data, because import deliberately does not
restore `scanMode` (it is a live control, not data).** A rover grid reviewed in
the default manual mode therefore had its path drawn backwards and its START
marker on the BOTTOM-left corner when the raster had really begun at the
top-left.

Both now read each cell's own capture index (`order`, already on every cell from
`buildCscanGrid`): START is the cell with the lowest one, the path is the cells
sorted by it. That is ground truth rather than an inference, and it survives a
hole left by an undo. `scanMode` still drives the pulsing NEXT-cell marker,
which is a statement about a capture that has not happened yet and so has no
data to read.

`cellForIndex` (manual, bottom-left) and `roverCellForIndex` (rover, top-left)
are unchanged -- the raster orders were never the problem, only the display's
guess at which one produced the record on screen.

### Verification

`cscanLayout` and `makeGeom` are pure and were exercised head-first from node
(70 checks: fit mode reproduces the original arithmetic; to-scale is exact and
survives a pane-height change while fit mode does not; overflow is flagged not
shrunk; bin 0 lands at the bottom and row 0 at the left with bins tiling to
1e-9; the horizontal mapping is unchanged; every aligned column lands on its
grid cell to 1e-9, including a partly-captured row and one with a BG row; a
non-grid record refuses to align; crosshair inversion round-trips in both
orientations; to-scale placement lands exactly where asked and is invariant to
the canvas moving while fitted mode ignores it; overflow flags a grid pushed off
any edge, including by a pane change; the BG column clears every data column on
both sides; and START/path land on the true first capture for rover and manual
data alike, in a partial raster and with a hole in it).

The projector is browser plumbing that no head-first check can reach, so it was
driven in a real headless Chrome over the DevTools protocol (17 checks: the
button is gated on to-scale; clicking it opens a window titled `C-Scan
Projection`; the portal mounts a canvas there, with the stylesheet cloned in and
the backing store matching THAT window's `devicePixelRatio`; the grid is
actually painted -- 30,450 non-black pixels, read back with `getImageData`, not
merely a canvas being present; the far corner stays black, i.e. the colour bar
and axis titles really are gone; nudging Left on the panel moves the projected
image by exactly the same number of pixels; closing from the panel closes the
window; and no console errors throughout). **That live-drive check is what
caught the stale-closure nudge bug** -- it read +10 where +40 was asked for.

The same harness, pointed at a running `vite` dev server with
`--screen-info={0,0 1600x900}{1600,0 1280x720}` and CDP
`Browser.grantPermissions(['windowManagement'])`, is what reproduced the
StrictMode popup failure and confirmed the fix -- **two emulated displays plus a
real dev server is the configuration that finds these; the dist build with one
screen finds none of them.** A real 147-position export
(`cscan_2026-09-06T06-04-30-909Z.json`, 21x7, v6) was imported through the panel
by attaching it to the file input with `DOM.setFileInputFiles`, and the
projected canvas read back 234,084 colour-mapped pixels, so the check covers
real data reaching the second window and not just an empty grid.

There is still no test runner in this repo, so all of these were throwaway
scripts. `vite build` passes.

## C-scan panel: smoothed plan view, Live Sweep pane removed (2026-09-08)

Three UI changes to the C-Scan panel.

**1. A Smooth/Blocky toggle in the Display section** (`cscanSmooth` in `App.jsx`,
persisted to `localStorage.cscan_smooth`, passed to both `CscanDisplay`
instances including the projector portal). It is a DISPLAY transform only -- no
cell value changes and nothing downstream reads it, which is why it is
deliberately NOT in `bscanParams`: it must not ride along in an export as though
it were a property of the capture.

`drawSmoothField()` builds an ImageData at GRID resolution (one source pixel per
cell), then lets `drawImage` upscale it with `imageSmoothingEnabled`. Two
properties make it honest, and both were checked head-first against the shipped
call: **cell centres survive the resample exactly** (source pixel `i+0.5` maps to
`originX + (i+0.5)*cellW`, which is `cellRect`'s own centre), and **a value
reaches exactly one pitch and no further** -- bilinear only ever mixes two
adjacent source pixels, so a feature can neither move nor grow beyond the
sampling the operator chose. The outer half-cell ring is the edge cell's own
value held flat (drawImage clamps at the source edge), not an extrapolation.
The title carries `· SMOOTH` because the pixels between centres are interpolated
rather than measured.

Cost is `hCount*vCount` per frame, not a pixel of the pane -- 1515 for a 101x15
raster.

**Cells that are not a value are still drawn as sharp squares on top**:
uncaptured, gated-out, and the red-cross background-failed cells. Those are
statements about a cell, not measurements to blend between. Holes are first
given the mean of their KNOWN neighbours in the source image so the ramp INTO
them is not dragged toward a colour nothing measured. **That fill is ONE pass,
deliberately** -- only a hole directly beside a real cell can touch a visible
pixel (the half of the span inside the hole's own cell is overdrawn), and an
iterative flood would fabricate more AND cost passes over the whole grid on
every frame of a mostly-empty raster.

**1b. A colour-map dropdown (jet / viridis / inferno)** in the same section
(`cscanColormap`, `localStorage.cscan_colormap`, default **jet** so every stored
screenshot and habit still reads). It redraws on the next frame -- nothing is
recomputed.

It drives **both panes and the projector**, not just the plan view: they are
scaled off ONE population of bins precisely so that a colour means the same dB
in each, and colouring them differently would break exactly that. So
`CscanDisplay` and `BscanDisplay` both dropped their local `jet` copies and now
import `COLORMAPS` from `lib/imagingEffects.js` -- one implementation, the same
rule CFAR, `windowFn` and the SAFT kernel follow. **The swap is bit-identical**:
the library's `jet` matched both local copies over 100k samples plus NaN /
+-Infinity / -0. (`SfcwDisplay.jsx` still carries its own 9-knot ramp versions of
viridis/inferno for the waterfall -- pre-existing, untouched here.)

**The uncaptured-cell colour had to change, and the reason generalises.** The
sentinel fills are chosen to be colours "no colormap produces", which held while
jet was the only map: jet's bottom is saturated blue. **inferno's bottom is
near-black**, so `EMPTY_FILL` (#0d0d0d) sat **15 RGB units** from a legitimately
low-valued cell -- an uncaptured cell reading as data, on a percentile-clipped
scale that genuinely reaches the bottom of the map. Measured across 2001 samples
of each map, no dark fill fixes it (every candidate under ~#333 stays inside 45)
and #333 itself collides with `GATED_OUT_FILL`. **So the OUTLINE is now the
discriminator**: `EMPTY_STROKE` #1f1f1f -> **#4a4a4a** at 1 px, a mid grey >= 56
units from all three maps, and structurally different from the gated-out cell's
solid grey fill. `INVALID_FILL` is 39 from inferno but carries a bright #ff4d6d
cross (67), so it was left alone. **Check this before adding a fourth map.**

**2. The Live Sweep pane is gone from the C-Scan viewport.** The plan view now
holds the whole area until a row is opened. That pane's controls bar was the
ONLY place `procParams` could be set (see "The Live Sweep controls bar now
drives the C-scan", 2026-08-31), so **Window / Kaiser beta / Avg / coh-inc moved
into the panel's Display section as real controls** rather than the read-only
tiles that used to mirror them; they still lock on `procLocked`
(`sfcwRunning || roverScan.active`) for the same reason. `Viewport` no longer
takes `bscanProcParams` / `onBscanProcParamsChange` / `bscanProcLocked` /
`cscanLiveResult`; `App.jsx` passes them to the Sidebar instead.
`cscanLiveProcessed` survives -- only its `.diag` is consumed now, by the panel's
Background readout.

**3. The explanatory prose blocks were removed** from Depth Slice (gate
markers), Focus, Display, the Window/Avg block, Projection, Scaling, Background
and Super Fit. Status and warning text is untouched -- only the paragraphs
explaining what a control does. The Super Fit "needs a full grid, N of M cells"
line went with them; the Scan Grid section's `Captured` tile already shows that
count.

## C-scan plan-view focusing, per row (2026-09-06)

A **Focus (SAFT)** section on the C-scan panel -- a toggle and an aperture
slider, the same two controls the 2D Map has. It changes how each cell is
reduced to a COLOUR and nothing else: the B-scan pane's traces are drawn exactly
as recorded, focused or not (verified in a browser -- toggling focus changes the
plan view's pixels and leaves the B-scan's image untouched).

**The kernel is shared, not copied.** `lib/saft.js` now holds
`interpMagnitudeAtRange`, `saftFocusedProfile`, `metricOnProfile` and
`gateDepths`, lifted out of `MapDisplay.jsx`; the 2D Map calls the same
functions. This is the same rule CFAR and the window functions follow -- two
copies of a focusing kernel would drift, and the failure would be invisible,
because both images would still look plausible while disagreeing about where a
target is. **The lift is bit-identical**: 945 values compared across
peak/energy/mean x aperture 3..21 x three gates on a real row, worst delta 0.

**Focusing is PER ROW and only along the row.** A C-scan row is a line of
positions at one height, which is the geometry the back-projection assumes; rows
are focused independently and never contribute to each other. That is a physical
decision, not a simplification -- the 2026-08-30 rover diagnosis measured the
two axes to be completely different animals (200 mm sideways costs a few dB of
background correlation, 150 mm up destroys it, because the standoff walks
~10 mm), so summing across rows would combine traces that do not describe the
same wall. Verified: adding 30 dB to one row moves that row's 21 cells and
**zero cells anywhere else**.

Three things that are easy to get wrong and are handled:

- **Neighbours are addressed by GRID COLUMN, not by array position.** A row with
  a hole in it -- an undone cell, a partial raster -- would otherwise close the
  gap up and give every later column the wrong offset. Verified: with two
  columns removed, a cell whose aperture clears the gap is bit-identical to the
  full-row result, and one whose aperture spans it changes.
- **A background-failed cell is excluded from every aperture.** It is
  un-subtracted and sits 20-30 dB above its neighbours, so letting it in would
  smear that error across every cell within half an aperture. Verified: its
  neighbours change (it is dropped) but do not absorb its level.
- **`computeCellValues()` is the single source of the number a cell is coloured
  by**, used by `buildCscanGrid` (which draws them) and `computeGridScales`
  (which sets the limits from them). They each called `gatedIntensity`
  separately before; with focusing in the picture that duplication would let the
  grid be drawn with values the scale was not computed from -- a wrong image
  rather than a crash.

**Focusing forces the plan view onto its own colour scale**, whatever the
linked/unlinked toggle says (`planViewScales(..., focused)` returns an
`effectiveLink` both displays are given). A focused value is a back-projected
SUM over an aperture, not a bin of any profile: measured on the 21x7 bench scan
it runs **12.7 dB above** the unfocused bin-domain maximum, so on the linked
scale every cell would saturate at the top of the colormap the instant focus was
switched on. The B-scan pane is not focused, so the two panes genuinely disagree
and both label it -- the plan view's colour bar reads `OWN SCALE · FOCUSED` and
the title carries `FOCUS ×N`.

`focusEnabled` / `focusAperture` live in `bscanParams` beside `metric` and the
gate -- they are the same kind of setting, "how a record becomes a colour" --
so they ride along in the export and are restored on import.

**Both `CscanDisplay` instances draw with `cscanFocusParams`, not `bscanParams`**
(2026-09-13). It is `bscanParams` plus the window and start frequency the
coherent DAS+CF / DMAS+CF kernels need. When it was added, App passed it to
`<Sidebar>` (which ignores it) instead of `<Viewport>`. So the panel's plan view
got `params = undefined`: `drawCscan` threw on its first frame, the rAF loop
never rescheduled, and **the grid came up completely blank for every scan**,
live or imported, with no on-screen error. The projector window was fine because
App renders that one directly. If the plan view is ever blank, check the console
for a throw in `drawCscan` before suspecting the data.

**What it is not:** incoherent, magnitude-domain back-projection, exactly what
the 2D Map has always done. It reads the magnitude profiles already on screen
and knows nothing about phase, permittivity or refraction, so it is not the SAR
panel's reconstruction and should not be compared to one.

## Five-scan A/B on the new rig: the raster does not see a deep pipe (2026-09-02)

Five 20x1 rover C-scans of one 1 m patch of brick wall, 50 mm pitch, `avgCount: 1`,
`gateEnd` 70/74 cm, no `bgRef` and no model (`data/` not in repo; user's
`Desktop/scans test/aligned scan 1..5.json`, v7). Scans 3 and 4 contain a pipe
~60-70 cm inside the wall at the x = 55 cm mark; 1, 2 and 5 are the empty control.
Ground truth was supplied only AFTER a blind analysis, so the blind result is a real
test of the detector rather than a fit.

**Geometry checks that should be repeated on any multi-scan set.** Absolute
`rover_x_mm` differs by exactly 50 mm per scan (origin re-declaration between
sessions), but `grid_ix` maps to the same physical spot in all five -- confirmed by
standoff-profile correlation (r = 0.92-0.98, peak at lag 0) and by `h_cal` complex
correlation (peak at lag 0). **Match cells on `grid_ix`, never on `rover_x_mm`,
across sessions.**

### The raster's background floor is ~17.5 dB, and that is the whole story

Leave-one-out against the other target-free scans: 19.3 / 14.6 / 14.8 dB. The two
target scans against the mean of all three empties: 19.7 / 14.7 dB -- **no excess
whatsoever**; per-scan residual power is -17.5 dB below signal for the empties and
-17.8 dB for the target scans. The shared-residual correlation ranks the true (3,4)
pairing **4th of 10**. So every ordinary differencing metric says the two sets are
indistinguishable, and no amount of subtraction can recover a target from them.

Against CLAUDE.md's static single-sweep `S_repeat` of 38.6 dB, **the raster loses
~21 dB of reproducibility.** That gap -- not the estimator, not the background model
-- is what stands between these scans and a detection, and it is why the user's
"static radar, move the pipe" test succeeds where the raster fails: that test is a
differential measurement at one fixed position, so it runs at the full ~38 dB.

The dominant term is a **global standoff difference between scans**: mean standoff
per scan is 45.4 / 45.7 / 47.5 / 47.8 / 49.1 mm for scans 4, 2, 3, 1, 5, and the
scan-pair residual-correlation structure orders the scans in *exactly* that sequence
({2,4} vs {1,5}, scan 3 in the middle). A per-frequency complex recalibration
(one scalar per frequency, shared over all 20 positions, so it cannot fabricate or
erase a localized target) recovers 3-5 dB of it -- the drift is up to 7 dB and 36
degrees, frequency-dependent, i.e. the reference-gain recalibration signature. A
global gain+delay fit recovers only ~1 dB, so it is not a simple range shift.

### What DID separate them: along-x high-pass + coherent agreement between the two target scans

The clutter is low-spatial-frequency along the rail; a pipe is not. Subtract a
~5-cell moving average along x per range bin, then compute `Re(E_a . conj(E_b))`
with the background for each pair built from the other three scans (symmetric over
all 10 pairings, so the permutation null is fair).

Across 96 processing variants (calibration on/off x nfft x depth gate x spatial
band) the true (3,4) pairing ranks **1st in 80/96, <=2nd in 93/96**, against a null
of 10/96; mean rank 1.20 vs 5.5. Holds identically under non-circular filters
(moving average w = 3/5/7, polynomial detrend order 4/6), so it is not an FFT edge
artifact. **Scans 3 and 4 genuinely share something the empty three lack.**

It peaks at two positions: **x = 10 cm (won 96/96 variants) and x = 55-60 cm
(84/96)**. Ground truth: the pipe is at 55 cm. **So the detector's STRONGEST peak is
a false alarm and its second is the pipe** -- roughly one false alarm per metre of
scan. Do not treat this detector's ranking as trustworthy; a random peak lands
within one cell of the truth about 15% of the time, so the x match alone is only
suggestive (p ~ 0.28 for two peaks).

### But the shared signature is NOT the pipe's echo, and carries no depth

Range distribution of the shared residual at the pipe column (x = 45-70 cm):

| window | 0-10 cm | 10-20 | 20-30 | 30-40 | 60-70 | 120-130 |
|---|---|---|---|---|---|---|
| share | **42.5%** | 7.9 | 5.6 | 11.4 | **8.1** | 1.3 |

The largest single 5-cm window holds **27.9%**; a genuine point echo puts >60% in
one window (the rectangular mainlobe is ~10 cm). Restricting to the pipe column and
scanning depth windows x sub-bands, (3,4) ranks 1 in essentially *every* window from
0 to 145 cm -- the signature is broadband in range, not a resolvable reflection. It
is also not a per-position gain change: a best-fit complex scalar explains only
15-28% of it.

**An earlier reading of this data placed the target at 5-9 cm; that was wrong** -- an
artifact of gating the search to 0-30 cm. There is no depth information here at all.

Measured floor at 60-70 cm displayed: **-30.9 dB** relative to the wall/coupling
peak, with 19.4 dB of headroom. A pipe 65 cm inside brick is tens of dB below that
(two-way spreading plus 5-20 dB/m of brick over a 1.3 m path plus the cylinder's
scattering width against a specular wall face), so its direct echo was never within
reach of a single-sweep raster.

**Note the C-scan gate bites here.** `gateEnd` was 70/74 cm. If a 60-70 cm *physical*
depth is meant, the displayed range is ~125-145 cm (brick, v ~ c/2) and the grid
metric never looks at it. Both windows were searched; neither holds a localized echo.

### Consequences for capture

- **`avgCount: 1` is the wrong setting for a deep target.** Coherent averaging is
  worth up to `10*log10(N)`; at N=16 that is 12 dB of the missing 21.
- **The split between sweep noise and repositioning noise is unmeasured on this rig
  and is the single most valuable next experiment**: at one fixed cell take N sweeps,
  drive away, come back, retake. Averaging fixes the first and only mechanical work
  fixes the second, so the split decides where the effort goes.
- **50 mm pitch is spatially aliased above ~3 GHz** (`dx <= lambda_min/(4 sin theta)`
  caps the aperture at +-17 deg at 5 GHz, which at 10 cm depth is one cell). SAR
  back-projection on these scans is pure grating-lobe striping. For migration the
  pitch has to come down to ~20 mm; for a deep target in brick, sweeping 2-3 GHz only
  is both better-penetrating and unaliased, at 15 cm range resolution.
- **Merging sessions is still a bad idea** for the reason already documented -- the
  cross-scan disagreement here is larger than the target.

## Second five-scan A/B, 10 mm pitch: invalidated by a rig move (2026-09-02)

Five 101x1 rover C-scans, **10 mm pitch** over 1 m (`hStep: 1`), same wall as the
2026-09-02 set above; 3 empty (`e3`/`e4`/`e5`) + 2 with the pipe (`p1`/`p2`), pipe
again at ~65-70 cm. User's `Desktop/scans test 2/`.

### The pitch change worked; the averaging change did not ship

10 mm pitch un-aliases the aperture (`dx <= lambda_min/(4 sin theta)` now admits
+-48 deg at 5 GHz) and **back-projection migration produces compact, focusable
features for the first time** -- see below. Keep the 10 mm pitch.

But every cell still holds one sweep. **The exports are v6, with no `sweeps` and no
`procParams`** -- and `App.jsx` has exported `version: 7` since `40349a0`
(2026-09-01), the commit that added per-cell `sweeps` and `avgCount`. So the
groundstation build in use on the bench predates that commit. **Check what is
actually deployed before concluding a capture-side setting had no effect**; the
first (2026-09-01) dataset was v7, so this is a regression in what is running,
not in the repo.

### The dataset cannot answer the question: the rig moved between empty and pipe

| scan | standoff mean | tilt across the 1 m scan | geometry group |
|---|---|---|---|
| e5 | 27.2 mm | +2.8 mm | A -- near parallel |
| e3 | 32.7 mm | +5.2 mm | A |
| e4 | 49.9 mm | **+30.6 mm** | B -- tilted |
| p1 | 63.7 mm | **+29.6 mm** | B |
| p2 | **no LiDAR data at all** | -- | B (by correlation with p1) |

It is the same wall patch -- the standoff profiles all correlate 0.83-0.99 near
lag 0 and every scan with LiDAR shows the same surface step at cell ~63. But the
standoff spans **27 to 64 mm across the set**, and both pipe scans sit at one
extreme while two of the three empties sit at the other. Achievable suppression
tracks the standoff difference and nothing else:

| pair | standoff difference | suppression |
|---|---|---|
| e3-e5 (empty-empty) | 5.5 mm | **15.5 dB** |
| e4-p1 | 13.8 mm | 0.6 dB |
| e3-p1 | 31.1 mm | 2.7 dB |
| e5-p1 | 36.5 mm | 3.4 dB |

**Best empty-vs-pipe suppression is 3.4 dB.** The previous set managed 17.5 dB and
that was already too little. Migrated images cluster by geometry, not by pipe
presence: focusing metric e3 4.4 / e5 3.9 (group A) vs e4 1.7 / p1 2.1 / p2 2.1
(group B). The only geometry-matched comparison available (p1 & p2 against e4)
gives a best gap of 41.9 dB against a 37.1 dB empty control -- no separation, and a
flat along-x profile with no localized peak.

**This is now the number-one capture rule, ahead of averaging: do not move, re-mount
or re-level the rig between the empty and the target capture.** If inserting the
target requires disturbing it, capture empty -> target -> empty so the drift is
bracketed and measurable. The LiDAR standoff readout is the go/no-go: mean standoff
within a few mm of the previous scan, and tilt across the scan under ~5 mm. e3 and
e5 met that; e4 and p1 did not.

### One real find, in the scans labelled EMPTY

Migration of e3 and e5 -- the two clean near-parallel scans -- each independently
shows a compact scatterer at **x = 12-16 cm** whose **apparent range stays at
60.4-62.4 cm across the whole eps_r = 2..8 sweep** (the invariance a genuine echo
must show; only the inferred depth moves, as `z = D/sqrt(eps_r)`). -3 dB extent is
~10 cm in x by ~4 cm in depth at eps_r = 4-6. Peak-to-median 16-18 dB.

It is **not** visible in the unmigrated data -- that band at x = 11-17 is a local
*minimum* in every scan (-2.5 to -3.8 dB below median) -- so it is built up
coherently by the migration from a distributed hyperbola. That is migration doing
its job, and it is the first time anything in this project has focused.

~61 cm apparent range is squarely in the 65-70 cm band the pipe is supposed to
occupy, yet this is in `empty_wall_test3` and `empty_wall_test5`. Either it is a
wall feature (rebar, void, joint) at that depth, or those scans were not empty.
Worth resolving before the next A/B, because if it is a wall feature it is a
permanent confuser sitting at the target depth.

### Other data-quality notes

- **`empty_wall_test4_#2` cell 73 carries 123x the scan's median energy** (the
  known-bad trace). Nothing else in any scan exceeds 4x. Repaired by neighbour
  interpolation for this analysis.
- **`2_pipe_test2` has `lidar_standoff_mm: null` on all 101 cells.** Per the
  diagnosis section above, check the sidebar IMU Hz tile to tell "port 9001 stream
  down" from "`read_distance()` returning None".
- No `bgRef` and no model on any of the five.
- Absolute `rover_x_mm` differs by whole metres between scans (0-1000, 1000-2000,
  2000-3000, 2572-3572) purely from origin re-declaration. Match on `grid_ix`.
- Beware fixed-lag correlation searches over a shrinking overlap: correlation rises
  trivially as the overlap shrinks, and a naive argmax parks at the search edge with
  n=25. Slide a **fixed-width** window instead.

### The "two blobs 20 cm apart" reading of that set does not survive (2026-09-02)

`2_pipe_test*` held **two** pipes 20 cm apart, and migrate-then-SVD does show deep
blobs in both pipe scans that are absent from `e3`/`e5`. Three checks against it:

- **20 cm is not a special separation here.** Over 60 (eps_r x SVD-rank x scan)
  combinations, an ~20 cm pair among the top-4 deep blobs appears in **42% of EMPTY
  scans** and only 33% of pipe scans. With 4-6 blobs scattered over a 1 m scan, some
  pair lands near 20 cm most of the time.
- **The empty comparison is the geometry comparison.** `e3`/`e5` sit at 27-33 mm and
  near-parallel; `p1`/`p2` at 64 mm and tilted. `e4` -- the *only* empty sharing the
  pipe scans' geometry -- carries **more** deep structure than either pipe scan.
- **The permutation test picks out geometry pairs, not target pairs.** Gap statistic
  over 16 settings: `(p1,p2)` ranks 1st in 6, but `(e3,e5)` -- two EMPTY scans -- ranks
  1st in the other 10 and wins the explicit "two blobs 20+-3 cm apart" search
  (+16.2 dB vs +13.5). The two top pairings are exactly the two matched-geometry
  pairs, which explains the result with no reference to pipes.

**What does survive is ONE feature, not two.** Averaged over 12 settings (eps_r 3-6 x
SVD rank 1-3), the pipe pair beats all nine control pairings over a single contiguous
stretch, **x = 50.0-64.5 cm, centre 57.2, width 14.5 cm**, margin +8.5 to +11.1 dB
where the control envelope falls to +2.0-3.5. Every other winning stretch is 1-3 cm
wide at ~1 dB. It passes the echo test: **apparent range 97.4-100.7 cm across
eps_r 3-6, a 3.3 cm spread against a 5 cm range cell.**

Three reasons not to call it the pipes yet:
- **It is a single broad peak with no double structure.** Cross-range resolution at
  that depth is ~2 cm, so two pipes 20 cm apart would resolve as two blobs.
- **~99 cm apparent range is past the panel's 74.9 cm display limit**, and past the
  65-70 cm the pipes are meant to occupy. At eps_r = 4 it implies 46 cm below the
  face; reaching 67 cm would need eps_r ~ 1.9, too low for brick.
- **It is not independently visible unmigrated** -- at 90-108 cm the pipe-minus-empty
  gap over x = 50-64 is -0.33 dB. The migration builds it coherently out of
  noise-floor energy, which is legitimate but unverifiable from the raw B-scan.

**Method note worth keeping: with two matched-geometry pairs among five scans, ANY
"what do these two share that the other three lack" statistic will rank the two
matched pairs top, whatever the target does.** Such a statistic is only interpretable
when geometry is held constant across the whole set.

### Ground truth for that set: pipes at x = 60 and 80 cm. One hit, one miss, still confounded

**The standoff drift is a continuous, near-linear gradient measured at all 101 cells,
not an endpoint artifact.** `e4` and `p1` ramp `+30.6` and `+29.6` mm across the metre
with `R^2 = 0.976 / 0.940` about a straight line and 99% / 93% of smoothed steps rising;
per-quarter means climb steadily (`p1`: 54.4 -> 57.8 -> 66.2 -> 76.1 mm). `e3` and `e5`
are flat by comparison (+5.2 / +2.8 mm, `R^2` 0.55 / 0.22 -- i.e. mostly wall surface
texture, no real trend). So the rail sits at a genuine ~3% tilt to the wall in `e4`/`p1`
(and `p2` by correlation), and near-parallel in `e3`/`e5`. All four scans with LiDAR
share a `+4` to `+7 mm` surface step at cell ~63, which is what confirms one patch.

Scoring the migrate->SVD shared-excess profile against the true positions:

| | pipe-pair excess | best control | margin | rank of 201 |
|---|---|---|---|---|
| **x = 60 cm (pipe 1)** | **+9.99 dB** | +4.73 | **+5.25** | **12** |
| **x = 80 cm (pipe 2)** | +2.56 dB | +8.25 | -5.69 | **194** |
| x = 40 (no pipe) | +6.33 | +6.26 | +0.07 | -- |

**Pipe 2 is missed because a strong wall feature saturates x ~ 80 in every scan**
(deep-region level: e3 +8.45, e5 +8.59, e4 +7.70, p1 +7.00, p2 +8.16 dB -- the
*empties are brighter than the pipe scans there*). Any "pipe minus empty" statistic is
structurally blind at such a column. Aperture truncation is only -0.8 dB at x = 80 and
does not explain it.

**The x = 60 hit is real but NOT attributable, because the level there tracks standoff
monotonically:** e5 (27 mm) +2.89, e3 (33) +2.30, e4 (50) +7.59, p1 (64) +9.56,
p2 (~64) +12.36 dB. The pipe scans are also the largest-standoff scans, so "pipe" and
"standoff" are perfectly confounded at that column; the margin against the
geometry-matched `e4` is only ~2-5 dB, not the ~7-9 dB against `e3`/`e5`. Note the
ordering is *not* standoff-ranked at x = 80, so this is not a blanket artifact -- it is
specifically unresolvable here.

Correction to the figure quoted earlier: apparent-range invariance at the **pipe
column** (x = 60 +- 2.5 cm, 30-58 cm depth window) is **5.1 cm** across eps_r 3-6
(95.6 / 100.4 / 99.2 / 100.7 cm), not the 3.3 cm measured over the wider x = 50-64
stretch. Still about one range cell, so it still passes, but 5.1 is the right number.

**Net: the method put its single strongest feature on a real pipe, and that is the best
result this project has had -- but five scans split across two rig geometries cannot
establish it.** One matched-geometry set would settle it outright.

## SAR was reconstructing in AIR, and three other fixes (2026-09-03)

Found while analysing `sartt.json` -- a 60-position, 10 mm-pitch, single-row C-scan of
a 29 cm brick wall with a pipe stuck to the BACK face at x = 56 cm.

### The big one: there was no permittivity anywhere in the SAR path

`sar.worker.js` computed `R = Math.sqrt(dx*dx + depth*depth)` -- the speed of light in
air. Two consequences, both silent: the hyperbola being matched had the wrong
curvature, so nothing focused properly; and the depth axis read `sqrt(er)` times too
deep. `epsilonR` is now a panel field (`sarEpsilonR`, default **4.5**) and the kernel
is `R = standoff_p + n*sqrt(dx^2 + depth^2)`, `n = sqrt(er)`.

**`maxDepth` changed meaning with it: it is TRUE depth below the wall face now, not
apparent range.** Reaching depth z needs apparent range `standoff + n*z`, so the record
bounds the grid; the request is clipped to what the sweep can reach and the panel says
so (`depthClipped`).

**Calibrate er from geometry, not from autofocus.** The backwall echo sat at 63.2 cm of
apparent range and the wall measures 29 cm, giving `sqrt(er) = 62.8/29 = 2.16`,
er = 4.68 (4.31-4.68 over a 0-3 cm standoff range -- the standoff barely matters). A
coherence-vs-er sweep peaked at 3.5 but is broad enough that 4.5 sits 0.05 below its
peak, so the tape measure is the better instrument here.

### Per-position standoff correction is what buys an imprecise rig

The kernel assumed every antenna position sat exactly on the wall face. Each cell's own
recorded `lidar_standoff_mm` is now added to the path. Measured by injecting known
standoff scatter into the real scan and re-migrating both ways -- target coherence:

| injected sigma | 0 | 3 mm | 5 mm | 10 mm | 30 mm |
|---|---|---|---|---|---|
| uncorrected | 0.591 | 0.557 | **0.358** | **0.156** | **0.163** |
| corrected | 0.591 | 0.591 | 0.591 | 0.590 | 0.591 |
| corrected, +0.5 mm lidar noise | 0.594 | 0.591 | 0.593 | 0.592 | 0.591 |

**Uncorrected you need standoff stable to ~3 mm; corrected it is immune out to at least
30 mm, and the lidar is far better than it needs to be.** This is the difference between
needing a precise rig and not. It gained nothing on `sartt.json` itself only because
that scan already held standoff to +/-1.5 mm -- do not read that as "it does not
matter". Caveat: the test models a standoff change as pure extra path delay; moving the
antenna also changes illumination slightly, so the real benefit is somewhat less than
the table.

### Coherence output -- and it MUST be debiased

`|sum_i c_i| / sum_i |c_i|` over the back-projection's own contributions, computed in the
same loop and returned beside the amplitude image. It asks whether the positions agreed
in phase (a scatterer the aperture focused) rather than whether they added up to
something large (clutter that happened to be bright). Absolute 0-1, so the display pins
it to a fixed scale and never dynamically stretches it.

**The raw ratio is NOT comparable across the image and shipping it that way is a bug --
caught in testing.** N contributions with random phases still sum to ~`1/sqrt(N)` of
their incoherent total, and N varies hugely across the grid because deep and off-centre
pixels need an apparent range the sweep does not contain. Raw coherence therefore peaked
at **0.997 in the deepest image corner**, above the real target, on 2-3 contributions.
Fixed with both: a `minContrib = max(5, 0.25*numPositions)` floor (below it, 0), and
rescaling so chance maps to 0 and perfect to 1.

### What it does and does not do, on the one scan tested

Both panes are drawn at once, deliberately -- the reading is the pair. At the backwall
depth, amplitude vs debiased coherence:

| x | 5 cm | 15 | 25 | 35 | 45 | **56 (pipe)** |
|---|---|---|---|---|---|---|
| amplitude (dB rel peak) | -4.6 | -20.9 | -5.3 | -10.4 | -15.9 | **-1.5** |
| coherence | 0.81 | 0.00 | 0.56 | 0.21 | 0.00 | **0.82** |

Coherence pushes the mid-scan lobe down (0.56 against the pipe's 0.82) and zeroes two
others. **It does NOT uniquely pick the pipe** -- a feature at the opposite aperture edge
scores comparably (0.89) and cannot be controlled for without extending the scan past
it. Treat an edge feature with suspicion. Note also this discriminant was validated
knowing where the pipe was; it is physically motivated (a cylinder scatters over a wide
angle, a flat backwall is specular and only returns near normal incidence) but it has
not had a blind test.

### Window is now a parameter, and which one wins is UNSETTLED

Was a hardcoded Hanning. Now `sarWindowType`, default rectangular, options
rectangular / hanning / kaiser b3 (shares `imagingEffects.js` `windowFn` -- one
implementation, as with CFAR). **Two measurements on the same scan disagreed**:
evaluating coherence at one point with the full aperture and no debiasing put
rectangular ahead (separation 0.273 / kaiser 0.248 / hanning 0.234), while running the
shipped pipeline end to end -- reconstruction grid, debiased coherence -- reversed it
(rectangular 0.261 / kaiser 0.314 / **hanning 0.362**). The second is the more relevant
measurement but is still n=1 scan, n=1 target. The control is exposed rather than the
answer baked in; A/B it on a target-in / target-out pair.

### Geometry findings from `sartt.json` worth keeping

- **The rig is level now.** Standoff trend 0.2 mm over the whole 59 cm scan, against the
  30 mm of tilt in the 2026-08-30 rover sets. Whatever was done to the mount, keep it.
- **A target stuck to the backwall cannot be separated by range, ever.** Depth gating,
  time gating and range resolution are all aimed at the wrong axis when the target and
  the interface are at the same delay. The discriminant has to be cross-range structure
  (coherence, migration) or polarization.
- **Aperture: the coherent amplitude saturated at ~15 positions of one-sided aperture**
  (3 cm -> -11.4 dB, 6 -> -6.9, 10 -> -2.3, 15 -> saturated). The pipe at x = 56 with
  data ending at 59 had only 3 cm on its right, so it was reconstructed from about half
  its available aperture. **Overscan 15-20 cm past the region of interest**; a longer
  scan overall is not what is needed.
- **SVD rank 1, not higher.** At rank 1 the peak sits on the pipe; at rank 2-3 it jumps
  to x = 13-14 cm. Over-filtering eats the target.
- **Scan perpendicular to the pipe axis.** A pipe parallel to the scan gives a
  constant-range flat event with no hyperbola and no coherence signature --
  indistinguishable from the backwall.

### Verification

`sar.worker.js` was exercised head-first from node against the real `sartt.json` (shim
`self`, copy `imagingEffects.js` alongside with an explicit extension since the repo
imports extensionless for Vite): 60 positions, `standoffN=60`, 26-36 ms, amplitude peak
at pos 54.8 cm / depth 28.9 cm against a ground truth of 56 cm / 29.8 cm. Also checked
that er actually changes the image, that the incoherent path returns `coherence: null`
rather than a zero field, and `vite build` passes. There is still no test runner in this
repo, so these were throwaway scripts.

## SAR layered refraction: air / wall / air, and the combined view (2026-09-03)

Follow-on to the section above. Two toggles were added, both intended to be TEMPORARY
A/B controls -- once the layered model is confirmed on more than one scan the toggle
should go and it becomes unconditional.

### The straight-ray model was badly wrong at wide angles

The previous kernel was `R = standoff_p + n*sqrt(dx^2 + z^2)`: standoff added as a pure
delay, everything below the face treated as one infinite dielectric, no refraction.
Measured against an exact Fermat solve for a 4.3 mm standoff and a 29 cm wall at er 4.5:

| lateral offset | 5 cm | 10 cm | 15 cm | 20 cm |
|---|---|---|---|---|
| straight-ray path error, as two-way phase at 5 GHz | 3.4 deg | 13.7 deg | **34.8 deg** | **106.2 deg** |

Broadside is fine and the wide angles are wrecked -- and the wide angles are exactly the
contributions cross-range resolution comes from. The mechanism is that Snell turns a
~27 deg ray inside the wall into a ~76 deg ray in the air gap, so the true crossing point
moves centimetres sideways even though the gap is only millimetres thick. **A thin air
gap is not a small ANGULAR perturbation, which is what the old comment assumed.**

### How it is solved: ray-invariant table, not per-pixel root-finding

`buildRayTable()` / `rayLookup()` in `sar.worker.js`. Layers are air(standoff) /
wall(wallThickness) / air(beyond the back face). Parameterised by the ray invariant
`q = n_i*sin(theta_i)`, which Snell holds constant across the stack; sweeping q traces
the ray fan outward from broadside and gives lateral offset `X(q)` and optical length
`L(q)` both monotonic, so ONE table per (standoff, depth) inverts by interpolation for
every lateral pixel in that row. 256 samples, sin-spaced in angle so they crowd towards
grazing where `X(q)` diverges.

**Verified against a brute-force Fermat minimisation over the crossing points: worst
disagreement 0.0012 mm, against a 49 mm range bin.**

**The reconstruction loop is now POSITION-OUTER** so the table is built once per
(position, depth) row rather than per pixel; per-pixel root-finding would have been the
same answer at ~30x the inner-loop cost. Verified the reorder is exact -- with refraction
off the amplitude peak is unchanged at pos 54.83 cm / depth 28.89 cm. Cost 29 ms -> 65 ms
with refraction on, which is nothing against the 300 ms worker debounce.

`rayLookup` returns -1 past the fan's reach and the caller SKIPS that contribution rather
than extrapolating a path no ray takes.

### Wall thickness is an operator input, and it gates the layered model

`sarWallThickness`, cm, default **29 -- that is THIS bench's wall, re-measure for any
other.** Nothing on the rig can infer it. It is what tells the model where the dielectric
stops: beyond the back face it is air again, and a uniform-dielectric model puts anything
back there at the wrong depth with the wrong curvature. 0 disables the layered path and
greys the toggle. Cross-check it against the data: the back-face echo should land at
`standoff + sqrt(er) * thickness` of apparent range.

Note the reachable depth changes with it -- the same record reaches 35.0 cm layered
against 34.46 cm straight, because the beyond-wall leg travels at c rather than c/n.

### What it bought on the one scan tested (`sartt.json`, pipe on the back face at x=56)

| x | straight amp / coh | layered amp / coh |
|---|---|---|
| 5 cm (edge confuser) | -4.58 dB / **0.812** | -4.31 dB / **0.733** |
| 25 cm (clutter) | -5.26 dB / 0.563 | -3.55 dB / 0.516 |
| **56 cm (the pipe)** | -1.48 dB / **0.824** | **-0.36 dB / 0.845** |

Under the straight ray the pipe and the opposite-edge confuser were effectively tied on
coherence (0.824 vs 0.812). Under the layered model they separate (**0.845 vs 0.733**) and
the pipe becomes the brightest pixel outright. The focused depth also moves 28.89 ->
29.34 cm, i.e. onto the 29 cm back face where the pipe physically is -- an independent
consistency check nobody fitted for.

### Combined view: amplitude weighted by coherence

`sarViewMode` = `split` (two panes) or `combined` (one). Combined multiplies LINEAR
amplitude by coherence, i.e. `+20*log10(coh)` in dB, floored at coh 0.01 so a zero
coherence pixel lands at -40 dB instead of -infinity.

Worth understanding: the amplitude image ALREADY contains the raw coherence once, since
`|sum| = coh_raw * sum|.|` by construction. This weights it a second time and by the
DEBIASED figure, which is a different quantity -- so it is not simply squaring what is
there. It is a deliberate display choice to punish bright-but-unfocused clutter.

Measured target-vs-clutter separation (x=56 against x=25): amplitude alone **3.78 dB**
straight / 3.18 dB layered, weighted **7.09 dB** / **7.46 dB**. Roughly doubles it either
way.

### Still open

- Layered refraction is validated on ONE scan with ONE target whose position was known in
  advance. The physics check (Fermat, 0.0012 mm) is solid and target-independent; the
  imaging improvement is not yet blind-tested.
- The layered model is COHERENT-MODE ONLY. The incoherent path sums magnitudes, so there
  is no phase for a path correction to act on; it stays straight-ray and says so.
- The window question from the previous section is still unsettled and untouched by this.

### Ablation: which SAR change actually flipped the image (2026-09-03)

The visible symptom before any of this was that a clutter blob at x = 25 cm dominated the
image and the real pipe at x = 56 cm did not. Amplitude at each lobe, each sampled at its
OWN best depth so a change of velocity model cannot masquerade as a change of contrast.
`PIPE-MID` is the number that decides which blob the eye picks out:

| config | pipe | mid | PIPE-MID | coh pipe/mid | weighted gap |
|---|---|---|---|---|---|
| as it was (er=1, hanning, no standoff, straight) | -25.15 | -20.17 | **-4.98 dB** | 0.14/0.34 | -12.76 dB |
| + er 1 -> 4.5 | -19.08 | -20.15 | **+1.06** | 0.97/0.95 | +1.30 |
| + rectangular window | -11.06 | -12.42 | +1.35 | 0.81/0.81 | +1.28 |
| + per-position standoff | -10.87 | -12.56 | +1.69 | 0.82/0.81 | +1.83 |
| + layered refraction | -10.46 | -12.74 | **+2.28** | **0.89/0.54** | **+6.53** |

Leave-one-out from the final config, same metric: **er back to 1 costs 11.1 dB**
(+2.28 -> -8.83), straight ray costs 0.59 dB of amplitude gap but **4.7 dB of the weighted
gap**, no standoff costs 0.44, hanning costs 0.30.

**er is essentially the entire answer, and the mechanism is worth remembering.** Going
from er 1 to 4.5 moved the PIPE by +6.07 dB and moved the MID BLOB by +0.02 dB -- it did
not respond to the velocity model at all. A compact scatterer focuses, and focusing is
what a correct velocity buys; a layer or a smear does not focus and is therefore
indifferent to velocity. So **sensitivity of a feature to er is itself a discriminant**,
and a cheap one: sweep er and watch which blobs brighten. Confirmed by where the
brightest pixel in the whole image lands -- er=1 puts it at 25.6 cm (the clutter), er=4.5
at 54.8 cm (the pipe).

**Layered refraction is second and it acts on COHERENCE, not amplitude.** It barely moves
the amplitude gap (1.69 -> 2.28 dB) but drops the mid blob's coherence 0.81 -> 0.54 while
raising the pipe's 0.82 -> 0.89, which is what takes the weighted gap from 1.83 to
6.53 dB. Under the straight ray the two lobes were coherence-tied and the combined view
could not separate them.

**Window and standoff are worth a few tenths each on THIS scan** -- the standoff was
already stable to +/-1.5 mm here, so its 0.44 dB is not evidence about a sloppier scan.

**Third measurement now favours HANNING for the weighted gap**: 8.33 dB against
rectangular's 6.53 (while amplitude-only slightly favours rectangular, 2.28 vs 1.98). Two
of three metrics now lean Hanning. The default stays rectangular because that is what was
asked for, but this is worth re-deciding on a target-in / target-out pair.

## FPGA sweep-acceleration roadmap + Phase 0 baseline (2026-09-05)

Prior art lives on **`fpga_branch`** (unmerged, deliberately kept separate): a working
NIOS autonomous sweep, an FPGA patch against Nuand `73ce750b`, a state-machine simulator
(`pi/radar/nios_sim/`) and `docs/nios_sweep.md`. Read that doc before doing FPGA work.

**The bottleneck is the Nios II/e CPU, not USB.** Per step the firmware issues 42 AD9361
SPI transactions at a measured 47.7 us each -- but the transaction itself is 0.6 us on the
40 MHz bus, so ~47 us of each is pure CPU overhead. That is why the autonomous sweep
measured 176 ms against a host-driven 188 ms: both paths ask the same slow CPU to do the
same SPI work. Moving *who issues* the retune was never going to help.

**Quartus edition: the device is `5CEBA9F23C8`, Cyclone V E** (`platform.conf:25`).
Quartus Prime **Pro does not support Cyclone V** (Pro is Agilex / Stratix 10 / Arria 10 /
Cyclone 10 GX). Cyclone V needs **Standard** (Nios II/f) or **Lite** (Nios II/e only).
`fpga/build_sweep_firmware.sh:26` says "Standard or Pro" -- the Pro half is wrong.

**Nios II/f and a hardware SPI sequencer do NOT compound** -- both delete the same ~47 us
of per-transaction CPU overhead. Nios II/f makes the CPU ~6x faster (2.003 -> ~0.35 ms/step);
a sequencer removes the CPU from the path entirely (-> ~0.004 ms/step). Doing both leaves
the sequencer's number, so the sequencer's incremental value over Nios II/f is only ~18 ms
on a sweep that is ~30-50 ms by then. **The sequencer phase was dropped for this reason.**
Nios II/f and FPGA-side demod DO compound -- they attack different terms (retune vs
dwell+host). Plan: `rx.vhd` validation -> Nios II/f -> gate -> FPGA demod only if needed.

### Phase 0 baseline, measured on hardware 2026-09-05

51 steps, 2-5 GHz, 60 MHz, settle=3, num_buffers=1, tx1/rx1=50/25, tx2/rx2=45/5.
Bracketed controls (100 sweeps each, first and last) agreed to **0.1 ms (0.0%)** and
0.3 dB -- that is the error bar; anything above ~1 ms is real.

**210.9 ms/sweep, 4.74 Hz, 4.136 ms/step.** Quality clean: adjacent-sweep correlation
0.99995 (0/99 pairs under the 0.999 bar), **0/5100 cells** beyond 8 robust sigma
(worst z 6.3), S_repeat **41.9 dB**.

| term | ms/step | ms/sweep | share |
|---|---|---|---|
| retune (2x `bladerf_schedule_retune`) | 2.434 | 124.1 | 58.8% |
| settle wait | 0.861 | 43.9 | 20.8% |
| capture wait | 0.409 | 20.9 | 9.9% |
| per-step numpy demod | 0.432 | 22.0 | 10.4% |
| `_process_h_cal` | -- | 0.27 | 0.1% |

Three corrections to earlier assumptions:

- **`_process_h_cal` is 0.27 ms, not the ~8 ms `docs/nios_sweep.md` assumed.** Dead concern.
  What that doc never separated out is the **per-step numpy demod at 22 ms/sweep**: the
  `if sig_bufs:` block allocates float64 arrays, strided-slices into an intermediate complex
  array and means it, once per step. At 10% today it is invisible; after Nios II/f it is
  ~40% of the sweep. It is pure software -- a single `np.dot` against the conjugate tone
  should give 3-5x. Do it BEFORE Phase 2 so Phase 2's number is not polluted by it.
- **`settle_count=3` is not buying 3 buffers of settled signal.** 3 x 0.41 ms should cost
  1.23 ms; measured 0.861 ms = 0.287 ms/buffer. `_sweep_core` holds `_rx_cond` across the
  settle-plus-capture block, so the RX thread stalls, buffers back up in the 16-deep ring,
  and the first arrivals after each 2.4 ms retune are drained backlog, not fresh real-time
  data -- the same "true settling is unknowable" ambiguity documented for the pre-`sync_rx`
  era, reintroduced by a different mechanism. **When the retune shrinks the overlap
  disappears and settle grows back toward 1.23 ms**, so do not subtract the 124 ms naively,
  and re-derive `settle_count` per step at every phase.
- **`num_buffers` 4 -> 1 (2026-08-30) was never re-benchmarked; it is worth ~1.4 Hz.**
  CLAUDE.md's last recorded figure was 3.35 Hz at settle=3 with num_buffers=4; this run
  measures 4.74 Hz at num_buffers=1.

Also stale above: the reference-gain section says the Pi default "ends up unchanged" at
tx2/rx2 = 30/20. Both `SFCWEngine.__init__` and `App.jsx` `sfcwParams` actually carry
**45/5**, and this run's 41.9 dB S_repeat is consistent with 45/5 (CLAUDE.md's own table:
45/5 -> 38.6 dB, 30/20 -> 28.1 dB), not with 30/20.

Benchmark methodology that produced this (rebuild it rather than trusting
`benchmark_sweep.py`, which is still broken -- it references `_sweep_core_fast`/`sweep_mode`
and unpacks `_sweep_core` as a 2-tuple): stop `sdr_server` only (`start.py` does no
supervision, so `stream.py`/`rover_server.py` keep running), drive `SFCWEngine` directly,
bracket the measurement with identical control blocks, and check per-step robust-z rather
than aggregate correlation.

### Demod vectorised: 210.9 -> 195.9 ms (2026-09-05)

`_sweep_core`'s per-step demod produces ONE complex number per channel from a 4096-sample
buffer, and `mean(iq * tone)` **is a dot product**. The old float64 expression
(`(a[:,0::2] + 1j*a[:,1::2]) * tone`, then `.mean()`) allocated five temporaries per
channel per step -- two strided float64 slices, a complex128 from the `1j*Q`, another from
the addition, another from the tone multiply -- about 320 kB of traffic per channel to
produce one number. Now: `sb.astype(np.float32).view(np.complex64)` (one pass; the view is
free, because float32 I,Q pairs already have exactly the complex64 layout) then one
`np.dot` against `self._ref_tone_c64`. `adc_peak` is taken on the int16 directly, via
Python ints so negating a hypothetical -32768 cannot overflow.

Equivalence checked over 200 randomised trials (1/2/4 buffers, 20-2000 ADC counts):
**worst relative error 1.4e-5 = -97.2 dB** against a system limited at ~42 dB S_repeat,
and `adc_peak` matched exactly every time. Measured: **210.9 -> 195.9 ms (-15.0 ms,
-7.1%), 4.74 -> 5.11 Hz**, bracketed controls agreeing to 0.2 ms.

**The isolated micro-benchmark under-predicts this 3.5x** (0.084 ms/step in a warm-cache
loop vs 0.295 ms/step measured in the real sweep). The allocation traffic was competing
with the RX thread, which runs `_rx_loop_dual`'s own numpy deinterleave continuously at
~2440 buffers/s -- so the cost was contention, not just cycles. **Do not size a numpy
optimisation in this loop by timing it in isolation.**

### `settle_count` does NOT control the rare corrupted step, and counts the wrong thing

**Still true as to why the count-based gate could not work, but see the RESOLVED section at
the end of this file for what actually fixed it.**

400 sweeps at each of 8 settle values = **163,200 step-captures** (2026-09-05):

| settle | ms | Hz | S_repeat | corr_min | >8 sigma | worst z |
|---|---|---|---|---|---|---|
| 1 | **153.2** | **6.53** | **44.2** | 0.99993 | 0/20400 | 6.2 |
| 2 | 172.0 | 5.81 | 42.9 | 0.99764 | 2/20400 | **298.6** |
| 3 | 196.5 | 5.09 | 43.7 | 0.99988 | 0/20400 | 5.3 |
| 4 | 219.6 | 4.55 | 43.5 | 0.99994 | 1/20400 | 9.8 |
| 5 | 243.6 | 4.10 | 42.8 | 0.99982 | 1/20400 | 12.6 |
| 6 | 256.7 | 3.90 | 43.0 | 0.99994 | 0/20400 | 3.5 |
| 8 | 298.6 | 3.35 | 42.7 | 0.99988 | 0/20400 | 6.7 |
| 10 | 340.8 | 2.93 | 41.2 | 0.99961 | 0/20400 | 4.1 |

Outlier counts run **0,2,0,1,1,0,0,0** -- no trend, and the worst excursion by two orders
of magnitude sits at settle=2, mid-range. Four events in 163,200 cells is a constant
~1-in-40,000 rate; Poisson at that rate gives P(0)=0.61, P(2)=0.076 per block, so this is
exactly what a settle-INDEPENDENT process looks like. S_repeat is flat at 41-44 dB across
the whole range and is best at settle=1. **Raising settle does not buy margin here.**

**Why: `settle_count` counts buffer DELIVERIES, not elapsed time since the retune.**
`_sweep_core` holds `_rx_cond` across the whole settle-plus-capture block, so the RX thread
blocks in `_rx_capture` and buffers pile up in libbladeRF's 16-deep ring; when the lock
releases during the next retune the RX thread dumps the backlog. Measured directly: 3
buffers of settle take **0.861 ms = 0.287 ms/buffer against 0.41 ms of real time** -- they
arrive faster than real time because they are queued, not fresh, so **some "settle" buffers
were captured during the previous dwell at the previous frequency.** That is the exact
corruption `settle_count` exists to prevent, which is why turning the knob does not help.

Consequences:
- The 2026-08-29 choice of settle=3 over settle=1 (7.6 sigma vs 2.9) looks **over-fit to a
  single 400-sweep sample**. Today settle=1 is among the cleanest (worst z 6.2) and settle=3
  reads 5.3, not 2.9.
- **settle=1 is 43.3 ms faster than settle=3** (196.5 -> 153.2 ms, 5.09 -> 6.53 Hz) at no
  measurable quality cost in this data -- nearly 3x the demod win. Default left at 3 pending
  a proper fix; do not flip it on one dataset given the regression history.
- The real fix is to gate settle on **elapsed wall time since the retune**, or flush the ring
  after retuning, so the parameter means what its name says. Until then, per-step validation
  of any settle value is measuring a quantity that depends on ring backlog, i.e. on the
  previous step's timing, not on settling.
- This also predicts the Phase 2 (Nios II/f) win is smaller than naive subtraction of the
  124 ms retune term suggests: shrink the retune and the backlog that was being drained
  during it disappears, so the settle wait grows back toward its nominal 0.41 ms/buffer.

### Benchmark through the WEBSOCKET, not the engine (2026-09-05)

The Phase 0 / demod numbers above were taken by driving `_perform_sweep()` directly with
`sdr_server` stopped. **That measures a narrower thing than the GUI shows and reads ~7 ms
fast.** `timestamp` is stamped in `_process_h_cal` and `Viewport.jsx` `useSweepRate` takes
the median adjacent difference, so the GUI reports the FULL loop: sweep + `_sfcw_callback`
+ the asyncio task doing `json.dumps` and the websocket broadcast, all competing for CPU
with the sweep thread and the RX thread.

| | ms/sweep, settle=3 |
|---|---|
| engine only, server stopped | 195.9 |
| through the running server, `timestamp` deltas | 202-205 |
| operator's GUI (browser attached as a second client) | ~209 |

Benchmark by connecting a websocket client to `ws://localhost:9003`, sending
`{'cmd':'sfcw_set_params',...}` then `{'cmd':'sfcw_start'}`, and taking median adjacent
`timestamp` differences -- run the FULL stack (`start.py`), because load is a variable
here, not a constant.

### The rare corrupted sweep is CPU CONTENTION, and settle_count was counting the wrong thing

**SUPERSEDED, 2026-09-05 -- see the RESOLVED section at the end of this file. The time gate
described here was right in principle but its lockstep test was one-sided and accepted the
stalest buffer available, and its deadline was one buffer period short. `settle_count` is now
0 by default and the corruption is gone.**

Measured rate of `(sweep, step)` cells >8 robust sigma, same code, three load levels:

| load | rate |
|---|---|
| engine alone, nothing else running | **0 / 25,500** |
| + `stream.py` + `rover_server` | 4 / 163,200 |
| + full server, JSON serialisation, websocket client | 1 / 6,120 |

**Mechanism.** When the asyncio serialisation task starves the RX thread, buffers pile up
in libbladeRF's 16-deep ring. The old gate waited for `settle_count` buffer DELIVERIES --
and consuming backlogged buffers costs ~zero wall time and skips zero history, so every
"settle" buffer AND the capture after them still held pre-retune IQ at the previous
frequency. One such step corrupts the whole sweep, because the range profile is one IFFT
across all steps. This is why 163,200 cells over settle 1..10 showed **no trend**: the knob
could not act on the failure.

**Fix (`_sweep_core`).** Settle is now gated on (1) wall time since the retune,
`settle_count * 4096/sample_rate`, then (2) draining until a buffer's arrival gap proves
the backlog is gone. **The gap is stamped in `_rx_capture`, i.e. in the RX (producer)
thread** -- an earlier version timed the sweep thread's own wait and that is a real hole:
under exactly the contention that causes the bug, a scheduling stall is indistinguishable
from a real-time wait, so a stale buffer gets accepted. Measured from the producer the gap
is a property of the data, not of the consumer's scheduling luck. `MAX_BACKLOG_DRAIN = 24`
bounds the drain past the 16-deep ring; `LOCKSTEP_FRAC = 0.5`. The buffer that ends the
drain is already proven current and is used as the capture rather than waiting for another
(that cost a whole buffer period per step, 21 ms/sweep).

**settle_count now has a real effect, which is itself the evidence the gate works** -- under
the old count-based gate settle=1 was among the CLEANEST; under the time gate it is clearly
too little settling. 400 sweeps per block through the websocket, `vis` = sweeps whose
adjacent correlation fell under the 0.999 bar (what the operator actually sees):

| settle | ms | Hz | S_repeat | >8 sigma | vis corrupt |
|---|---|---|---|---|---|
| 1 | 171.2 | 5.84 | 26.6 | 9/20400 | **18/399** |
| 2 | 189-192 | 5.2-5.3 | 31-38 | 0-4/20400 | **0,0,6,4,0** |
| 3 | 209.6-210.1 | 4.76 | 36.9-38.0 | **0** | **0/947 cumulative** |
| 4 | 234.5 | 4.27 | 37.8 | 0/20400 | 0/399 |

**Default stays `settle_count = 3`** (`SFCWEngine.__init__`, `App.jsx` `settleCount`) --
0 corrupted sweeps in **947** on the final code (0/48,450 cells), against ~1 per 120 before.
settle=2 is 20 ms faster and mostly clean but corrupted 2 of 5 blocks, so it does not meet
the "not one in 100 sweeps" bar. Net cost vs the old code at the same setting is ~+5 ms.

**Confound worth knowing: repeated `sfcw_start`/`sfcw_stop` degrades the device.** After the
5th cycle in one session the stream died outright -- `Failed to receive NIOS II response`,
`Transfer timed out for TX/RX buffer`, `_rfic_host_enable_module ... FPGA operation reported
a failure`, then `13/51 steps had incomplete captures` and `TX/RX stream died unexpectedly`.
Restarting `start.py` recovers it. **A/B blocks late in a long cycling session are therefore
not comparable to early ones**, which is the most likely reason settle=2 looked clean in
some blocks and not others. Bracket with controls, keep sessions short, and restart the
stack between them.

### The 42 ms IS real, contention is genuinely the cause -- but the GIL rounding was not it (2026-09-05)

**SUPERSEDED on the cause, 2026-09-05 -- see "RESOLVED: the 42 ms was two bugs in the settle
gate" at the end of this file. The 42 ms was real and has been taken, but NOT by fixing
contention: the gate had an inverted lockstep test and gated on a buffer's arrival rather
than its contents. The timings and the GIL findings below stand; the diagnosis does not.**

**Correcting the section above.** It argued the time gate pays for USB pipeline latency, so
fixing contention would not release the settle margin. **That was wrong.** Measured
engine-direct with the whole stack stopped -- the best case any contention fix could reach:

| settle | contention-free (engine alone) | through the full server |
|---|---|---|
| 1 | **0/15300 cells, 0/299 sweeps**, worst z 2.8, S_rep 41.3, **168.0 ms** | 9/20400, **18/399**, worst z 318, S_rep 26.6 |
| 2 | **0/15300, 0/299**, worst z 3.2, S_rep 41.4, 188.9 ms | 0-4/20400, 0-6/399 |
| 3 | 0/3060, worst z 7.2, S_rep 40.6, 209.7 ms | 0/947, S_rep 36.9-38.0 |

settle=1 is perfectly clean with nothing competing. **So ~42 ms (209.7 -> 168.0) is available
if and only if contention is fixed**, plus ~2-4 dB of S_repeat. The earlier "4.5% is too
systematic to be scheduling" inference was simply wrong -- do not reuse it.

Note the time gate also made sweep duration **load-independent**: settle=3 reads 209.7 ms
engine-direct and 209.6-210.1 ms through the server. The old count-based gate was faster
under load precisely because it was draining backlog instead of waiting.

**Two GIL fixes shipped, both verified byte-identical, and they were NOT the answer.**
`[round(x, n) for x in ...]` is pure Python and holds the GIL for the whole comprehension:

| site | thread | before | after |
|---|---|---|---|
| `sdr_server.py` broadcast `distances`/`magnitudes` (~512 elts) | asyncio | 2.778 ms | **0.023 ms** (122x) |
| `sfcw_engine.py` `_process_h_cal` `h_cal_real/imag` (102 elts) | sweep | ~0.55 ms | ~0.01 ms |

2.8 ms of held GIL is ~7 RX buffer periods, which looked like an exact match for the
backlog mechanism. **It was not.** settle=1 went 18/399 -> 12/399 -> 10/299 across the two
fixes -- unchanged within noise. What they DID buy is real: **S_repeat at settle=3 went
36.9-38.0 -> 39.1-40.4, now matching the contention-free 40.6**, so the quality gap is
closed even though the timing one is not. Keep both fixes; they are free.

**The dominant contention source is still unidentified.** Untested candidates, in order:
(1) plain CPU competition from `stream.py` / `rover_server.py` -- separate processes, so not
GIL, but 3 processes plus a 34.8%-of-a-core RX thread on 4 cores; bisect by running
`sdr_server` alone. (2) RX thread priority -- `SCHED_FIFO` or core pinning for
`_rx_loop_dual`. (3) websocket/TCP syscall latency in the broadcast.

**Do NOT "optimise" `_rx_loop_dual`'s deinterleave.** The obvious rewrite
(`frombuffer().reshape(-1,4)` then two 2-column `.copy()`) measures **5x SLOWER** -- 0.0728
vs 0.0143 ms/buffer -- because a 2-of-4 column slice is non-contiguous. The current strided
assignment is already the fast path at 34.8% of one core.

**Device degradation got worse this session.** Repeated `sfcw_start`/`stop` cycling produced
`Failed to receive NIOS II response` twice more, once ending in `No devices available` with
the board **re-enumerating on the USB bus under a new device number** (Device 002 -> 003).
Restarting `start.py` after an 8-18 s gap recovers it; a 4 s gap is not enough (the previous
process has not released the device and the new one gets "No devices available"). Budget for
this in any long A/B session.

**Unrelated, noticed in the logs: the BNO085 is failing init** -- `RuntimeError('BNO085:
feature 0x01 was not confirmed enabled')`, so `stream.py` runs without the IMU. Per the
bring-up notes above that signature is the loose-contact/reseat case, not firmware.

### RESOLVED (2026-09-05): the 42 ms was two bugs in the settle gate, not contention

`settle_count` default is now **0** and a sweep is **168.3 ms (5.95 Hz)**, against 210.5 ms
at the old default of 3 -- the full 42 ms, at **better** quality (S_repeat 39.3 dB vs the
36.9-38.0 the previous section records). **5,100 consecutive sweeps with ZERO visibly
corrupted** (adjacent-sweep complex correlation of `h_cal` below 0.999), unloaded and with
four concurrent websocket clients, and one cell beyond 8 robust sigma in **261,142** --
better than the ~1-in-40,000 settle-independent background measured earlier.

The previous section's conclusion -- that ~42 ms is available "if and only if contention is
fixed" -- was **wrong about the cause**. Contention is real and does stall the RX thread, but
the gate was supposed to be immune to that and was not, for two separate reasons. Neither is
about RF settling, which is why 163,200 step-captures over settle 1..10 had shown no trend.
No contention work was needed in the end: nothing was pinned, reniced, or moved off the
asyncio thread.

**Bug 1: the lockstep test was one-sided, and inverted on the case that mattered.** It
accepted a buffer once `_rx_gap >= 0.5 * buf_period`. Write `lag(n)` for a buffer's queueing
delay and `T(n)` for its arrival: `gap(n) = BP + lag(n) - lag(n-1)`, so **the gap measures the
CHANGE in staleness and both directions mean stale.** A large gap means the RX thread was
descheduled and has just handed over the *oldest* buffer in the ring -- precisely the
pre-retune buffer the gate existed to reject -- and the old test read that as proof of
freshness. Measured over 172,901 buffers under load: 96.4% of gaps land in [0.9, 1.1]*BP, and
a >1.5*BP gap is followed by a <0.5*BP one 80.7% of the time (stall, then backlog drain).
`drains` averaged **1.00**, i.e. the drain loop never actually drained. **328 of 21,421 steps
accepted an out-of-band buffer; with the two-sided band [0.8, 1.2]*BP it is 0**, and
`settle_count=1` went from 12/399 corrupted sweeps and S_repeat 26.98 dB to 0/399 and 39.52.

**Do NOT replace the band with a cumulative lag estimate** (`lag += gap - BP`, clamped at 0).
Tried: mean gap measures 0.4097 ms against a nominal 0.4096, and that 24 ppm integrates to a
19 ms phantom lag within seconds. The band is drift-free because it never integrates.

**Bug 2: the deadline gated a buffer's ARRIVAL, not its CONTENTS.** A buffer arriving at `T`
holds the samples captured in `[T - BP, T]`, so `deadline = t_retune + settle_count*BP` let
the capture window start *at* the retune, or straddle it. Measured: implied capture start ran
down to 0.106*BP (43 us) and 11% of steps got under 0.2 ms of settling -- still 2 corrupted
sweeps in 1199 after Bug 1 was fixed. The deadline is now
`t_retune + buf_period + settle_count*buf_period`; **that leading buffer period is structural
and must not be removed.**

**Extra settling then measured to buy nothing, which is why the default is 0.** At
`settle_count=0` over 77,542 steps the tightest capture began **9.7 us** after the retune, and
the 1,803 steps with under 41 us of margin had a worst robust-z of **2.81** against 3.7 for
the run as a whole -- the *least*-settled captures were the cleanest. Margin and corruption
are uncorrelated, as they should be: quick-tune fastlock settles the AD9361 long inside one
buffer period. Cost per unit is 0.41 ms/step = **21 ms/sweep**, so `settle_count=3` now costs
231.1 ms. Sweep time fits `51 * (2.89 ms + (1 + settle_count + num_buffers) * 0.4096 ms)` to
0.2 ms; `SfcwPanel.jsx` uses exactly that (its old estimate omitted the ~2.4 ms/step retune
entirely and read 84 ms against a real 210).

**`settle_count = 0` is the minimum AND the default and does NOT mean "settling off"** -- it
means "capture the first buffer lying entirely after the retune". The panel's minimum is now
0 (`SfcwPanel.jsx`), and `App.jsx` `sfcwParams.settleCount` is 0. **Do not raise it to chase a
corrupted sweep without first checking `SFCW_DIAG`:** if the gate is working the fault is not
settling, and more settling will not fix it.

**`SFCW_DIAG=<prefix>` is the tool that found all of this, and it is kept.** Off unless the
env var is set (one falsy global check per RX buffer when off). It writes `<prefix>NN_gaps.npy`
-- every RX inter-arrival gap -- and `<prefix>NN_steps.npy`, one row per step:
`(step index, drains, accepted gap, retune->accept seconds, backlog drained, locked,
h_cal real, h_cal imag)`. **Recording `h_cal` beside its own timing is what made the
measurement decisive**: per-step robust-z and capture margin come from one file, with no need
to align the diagnostic against the websocket stream.

### The device wedging was OUR bug: `sdr_server` never closed the bladeRF (2026-09-05)

The "repeated `sfcw_start`/`stop` degrades the bladeRF" problem documented above is largely
**unclean shutdown**, and it is fixed. `sdr_server.py` had no signal handling at all: `start()`
awaited `asyncio.Future()` forever, so SIGTERM killed the process with TX and RX still enabled
and USB transfers in flight. `bladerf_close()` never ran, the FPGA kept DMA-ing into an
endpoint that had gone away, and the board was left wedged -- still enumerating, but every
open failing `No devices available`, and **libbladeRF's own USB reset on open does not clear
it.** `start.py` SIGTERMs this process on every restart, so the damage accumulated once per
restart, which is exactly why "restart `start.py` to recover" grew unreliable over a session.

There is now a `_shutdown()` on SIGINT/SIGTERM that stops the sweep, stops both dual streams
and closes the device; it logs `[sdr] device closed`. With it the board reopens cleanly with
no intervention.

**Recovery when it does wedge: `usbreset <bus>/<dev>`** (from `lsusb`, e.g. `usbreset 002/006`),
which is the only thing short of a physical replug that worked -- resting the device, killing
processes and libbladeRF's own reset all failed. Watch for the board re-enumerating under a new
device number in `lsusb`; that is the signature.

### Benchmark harness (rebuild it this way)

`benchmark_sweep.py` is still broken and was not used. What works: a websocket client on
`ws://localhost:9003` that sends `sfcw_set_params` then `sfcw_start`, collects `sfcw_result`,
and reports **median of adjacent differences of `msg['timestamp']`** -- exactly what
`Viewport.jsx` `useSweepRate` shows. Metrics: sweeps whose adjacent-sweep complex correlation
of `h_cal` falls below 0.999 ("visibly corrupted"), per-(sweep, step) robust-z outliers, and
S_repeat. Run the FULL stack via `start.py`; extra idle subscriber clients are a cheap and
realistic load knob (they add a `json.dumps` consumer and a TCP send per sweep in the asyncio
thread). Bracket every A/B with repeated controls -- ours agreed to **0.07-0.2 ms**.

**400 sweeps is NOT enough to qualify a settle change.** The failure rate being chased is
~0.17% of sweeps, so a single 400-sweep block reads 0 most of the time: the identical
configuration gave 2/399 in one block and 0/1499 in another. That is the same trap that let
the 2026-08-23 `settle_count` regression ship. Use >=1200 sweeps, prefer the per-step robust-z
(51x more samples per sweep), and best of all use `SFCW_DIAG` to test the *mechanism* rather
than the rate.

## RX buffer 4096 -> 2048/channel, demod 2000: sweep 85.3 -> 65.5 ms (2026-09-06)

`sfcw_engine.py` now carries TWO constants where one number used to do three jobs:
`RX_BUFFER_SAMPLES = 2048` (per-channel RX buffer -- the clock the settle gate and
the sweep-time arithmetic run on) and `DEMOD_SAMPLES = 2000` (how many of those
samples the demod correlates). Landed and validated: **65.5 ms / 15.3 Hz** at 51
steps, settle 0, num_buffers 1 (was 85.3), timing brackets 0.08 ms. The long comment
above the constants is the authoritative version of everything below.

**Why 2000 is demodulated, not 2048.** The demod is a rectangular-window correlation,
so rejection of anything off-tone is a sinc with nulls every sample_rate/N. At
N=2000, `cw_offset*N/sample_rate = 20.000` exactly -- DC (LO leakage) and every odd
harmonic land ON nulls. N=2048 puts DC almost exactly BETWEEN nulls (~24 dB worse),
and 4096's -60 dB was luck (40.96 cycles). Verified at runtime before changing:
`cw_offset` is exactly 100000 and `sample_rate` exactly 10000000 on the wire. Any
future N must keep `cw_offset*N/sample_rate` an integer (multiples of 100 at this
plan). The 48 unused samples cost 0.10 dB of processing gain -- nothing.

**Why the buffer is 2048 and a direct n=2000 was catastrophic (tried twice now, do
not try again).** libbladeRF's sync layer serves `sync_rx` requests out of whole DMA
buffers and carries the remainder forward. `sync_config(buffer_size=4096)` counts
TOTAL samples across both RX_X2 channels -- **measured: the DMA quantum is 2048
samples/channel (0.2048 ms), pinned by the RX gap mode sitting at 0.2046-0.2048 ms
when n=2000's computed buf_period said 0.2000.** A request that does not divide the
DMA buffer (4000 total vs 4096) leaves a leftover that walks 96 samples per call, so
the returned data lags its own ARRIVAL time by up to a full buffer period -- and
arrival time is the only thing the settle gate can see. The gate's core invariant
("gap ~= BP proves the buffer is fresh, because a non-empty ring cannot produce a
full-period gap") is simply void under misalignment: the gate read locked=100% and
margin-never-negative while accepting stale pre-retune IQ. Measured signature of the
naive n=2000: 65.9 ms (timing perfect), S_repeat 16.5 dB, 42/499 visibly corrupted,
worst z 451, corrupted cells' margins indistinguishable from clean ones -- and only
28.2% of gaps within 2% of the computed buf_period vs 79.3% at n=4096. **More
settle_count can never fix this class of failure; raising it to chase a corruption
that SFCW_DIAG shows margin-clean is chasing the wrong mechanism.** Rule:
`RX_BUFFER_SAMPLES` must stay a multiple of 2048 (request a whole number of DMA
buffers), and `buf_period` in `_sweep_core` derives from `_rx_buffer_samples`, never
a literal.

**Aligned-build validation (2x1200 + 2x1200, bracketed by stock 4096 pairs).** Gate:
gaps unimodal at exactly 0.2048 ms, 95% in the lockstep band (96.3% at 4096), locked
99.98-100%, capture margin min +8.0 to +11.6 us and 0.00% negative (stock: +9.2 us).
Quality: see the caveat below for why aggregate S_repeat could not be used; on the
episode-robust floor metric the aligned blocks read 34.4/35.3/34.5/35.7 dB against
stock 35.2/35.3 (before) and 36.0/36.8 (after) -- a ~0.8 dB mean gap inside the
stock floor's own 1.6 dB same-session drift. Discrete corruption after the same
trim: aligned 0.020-0.043% of cells in the final pair, better than every stock block
that day (0.00-0.16%). `SfcwPanel.jsx` carries `BUFFER_SAMPLES = 2048`,
`DEMOD_SAMPLES = 2000`, and `PER_STEP_OVERHEAD_MS` re-fitted 2.89 -> 0.85 (the 2.89
predates the Nios II/f firmware and read 189 ms against a real 85).

**The TX2->RX2 loopback was NOT healthy during any of this, and aggregate S_repeat
was unusable all session -- the brief's own >=35 dB-stable precondition never held.**
Whole-block S_repeat wandered 12.6-35.1 dB across every configuration INCLUDING
stock 4096, driven by discrete episodes: for seconds at a time ONE frequency step
carries 94-99.9% of the sweep-to-sweep difference energy (step 13 / 2.78 GHz twice
in stock controls; step 7 / 2.42 GHz -- ISM band -- in the worst aligned block;
step 45 / 4.7 GHz once), with gate diagnostics pristine throughout. One 100-sweep
window at 3.9 dB drags a whole 1200-sweep block's energy-weighted aggregate into the
teens while the other 1600 sweeps sit at 33-36 dB. **Metric that survives this:
windowed S_repeat (100 sweeps) with the 2 worst steps per window excluded, plus
robust-z rates under the same trim.** Bench action outstanding: reseat/replace the
loopback and re-run a stock-vs-2048 A/B on a healthy reference before trusting any
absolute S_repeat from 2026-09-06.

**The flapping "standoff is stale" warning was sweep-rate arithmetic, not a lidar
fault -- fixed in App.jsx.** The warning fired on `lidar_n === 0` (no fresh
`lidar_seq` during that sweep). The TF-LC02 updates internally at 11-17 Hz (61-90 ms
period, 16.2 Hz measured healthy during the flapping, zero seq gaps); once the sweep
period dropped to 65-85 ms, whether a sweep window catches a fresh reading is a phase
race, so the flag strobed at the sweep rate -- and worse, those sweeps recorded a
NULL standoff, which would strobe the BG-model inference on and off. Fix: the last
fresh reading is carried forward for up to `LIDAR_CARRY_MS = 400` ms when a sweep
sees none, `lidar_n` stays an honest 0 for such sweeps (provenance counts fresh
readings only, and "check lidar_n before blaming the model" still works), and the
panel warning now fires on `lidar_standoff_mm === null` -- i.e. several missed lidar
periods, an actually-quiet sensor -- instead of on every unlucky sweep window.

## The 15 Hz -> 7 Hz dips were an asyncio thread-safety bug, not the radar (2026-09-06)

**Symptom:** after the RX buffer change took the sweep to 15.3 Hz, the GUI mostly
read 15 Hz but "randomly kept dropping to 7 Hz for a bit before recovering", and
occasional corrupted sweeps persisted.

**Root cause: `sdr_server.py` fed `asyncio.Queue` from worker THREADS.**
`_sfcw_callback` runs on the SFCW sweep thread and `_rx_callback` on the driver's
RX thread; both did a bare `put_nowait`. `asyncio.Queue` is not thread-safe, and
the part that bites is not a corrupted queue -- **a put from a foreign thread
never WAKES the event loop.** The waiting `get()` future is completed only through
the loop's own `call_soon`, so the loop stayed asleep in its selector and
`_sfcw_broadcast_loop` was advanced only by its own
`wait_for(..., timeout=0.1)` -- i.e. **the broadcast ran at ~10 Hz regardless of
sweep rate**, and the 8-deep drop-oldest queue silently discarded the surplus.

Measured with the engine at 15.57 Hz, using a client that did **no JSON parsing at
all** (so client backpressure and the 2.6 KB payload are both excluded):
received **10.90 sweeps/s, 30.0% lost, 42.7% of deltas an exact 2x multiple** (the
signature of a dropped sweep). A run of dropped sweeps halves the GUI's 12-sweep
rolling median -- which is exactly the "drops to 7 Hz" report (worst window 7.8 Hz,
203/636 windows >1.5x base).

**Why it appeared only now:** at the old 85 ms/sweep the engine ran at 11.7 Hz,
close enough to the ~10 Hz poll that the loss was small. The buffer change to
15.3 Hz opened the gap and made it obvious. **The bug was always there.**

**Fix:** `_post()` hands items to the loop with `loop.call_soon_threadsafe`, which
writes the loop's self-pipe and wakes it immediately; the drop-oldest `_offer()`
then runs on the loop thread where the queue is actually safe. Both callbacks use
it. Measured after: **15.54/s received, 0.5% lost, 0.0% dropped, p90 64.9 ms
against a 64.3 ms median, 0/899 slow rolling windows.** The dips are gone.

**Any future producer feeding these queues from a thread must use `_post`, never
`put_nowait`.** The failure is silent and looks like a radar problem.

### Residual corruption: the gate could still capture an unproven buffer

Separately, `_sweep_core`'s drain loop was bounded by a COUNT
(`MAX_BACKLOG_DRAIN = 24`) and, on exhausting it, **fell through and captured
`_rx_latest` anyway** -- a buffer it had just failed to prove current, i.e. the
stale pre-retune IQ the gate exists to reject. Measured on this rig, the RX thread
is descheduled for up to **50.9 ms** at a time; the stall-then-drain signature is
exact (a stall of N buffer periods is followed by N near-zero-gap buffers emptying
libbladeRF's 16-deep ring), and a sustained starvation burst can burn 24 drains
across several stall/drain cycles without ever catching a clean full-period gap.

**Waiting longer is always safe here** -- the retune has already happened, so a
late buffer is still at the correct frequency; only an EARLY one is wrong. So the
drain is now bounded by wall time (`STALL_GIVEUP_S = 0.25`, 5x the worst stall
observed) instead of a buffer count, converting a rare corrupt step into a rare
slow one. `MAX_BACKLOG_DRAIN` is retained only as the reference backlog depth and
is deliberately no longer a loop bound.

Measured over 70 s per stage, both fixes in (corrupted = adjacent-sweep complex
correlation < 0.999):

| | before | after |
|---|---|---|
| alone | 5.32% corrupted, worst z 155, 172/758 slow windows | **0.46%, worst z 26, 0/1072** |
| +3 clients | 3.64%, worst z 665, 160/758 slow windows | **2.05%, worst z 249, 0/1063** |

Note the dropped sweeps were also INFLATING the corruption metric: with 30% lost,
two "adjacent" received sweeps were often two sweeps apart in time, so they
decorrelated more and tripped the 0.999 bar. Worst z 26 alone means no hard
retune corruption at all. The residual under client load is concentrated in the
known RF-flaky steps 11-16 (2.66-3.20 GHz) and is the marginal TX2->RX2 loopback,
not the gate -- reseat it before chasing this further.

### UI cannot override the RX buffer size -- checked

Asked whether a stale groundstation build could push 4096 back. It cannot:
`sendSfcwParams()` sends only `start/stop/step`, `num_buffers`, `settle_count`,
the four gains and `range_offset`, and `SFCWEngine.set_params` has no buffer-size
key at all. **`num_buffers` is the COUNT of buffers averaged per step (default 1),
not their size** -- an easy misread. `RX_BUFFER_SAMPLES` is Pi-side only, so a
stale UI is purely cosmetic (a wrong "x4096 smp" label and sweep-time estimate).

### Lidar stale warning: no longer shifts the layout, and fires far less

The warning slot is now ALWAYS rendered at a fixed height, so the warning
appearing can never reflow the controls beneath it -- a warning that shifts the
layout at the sweep rate makes the whole panel flicker, which is worse than the
condition it reports. It is also debounced (`STALE_DEBOUNCE_MS = 2000`) on top of
the carry window (`LIDAR_CARRY_MS`, raised 400 -> 1000 ms), so a brief burst of
invalid returns at a poor target angle -- documented at 30-40% of TF-LC02 reads on
this bench -- no longer surfaces at all. Only a standoff that has been null
continuously for ~3 s is reported.

## Nios II/f FPGA image + autonomous sweep: VALIDATED, PORTED, DEFAULT (2026-09-07)

The II/f image (`~/bladerf-src/build_output/hosted_niosII_f_sweep_ts.rbf`, Quartus Prime
**Standard** 18.1, `NIOS_REV=Fast`, rx.vhd timestamp fix + `fpga_branch` sweep firmware)
is validated, and the Pi-side autonomous-sweep driver is ported from `fpga_branch` onto
the current `sfcw_engine.py`. Confirmed working on the GUI by the operator, including the
target-in / target-out case that broke an earlier draft (see "the resolver that had to
go" below). **The image is committed at `fpga/images/hostedxA9_niosIIf_sweep_ts_v1.rbf`**
(sha256 `3449d1af...`, provenance + load instructions in `fpga/images/README.md`).
**FLASHED TO SPI 2026-09-11, so it now survives a power cycle and needs no host
action.** It was RAM-loaded only (`-l`) until then, which cost a silent 2x regression
every power cycle -- see "The 18 Hz regression" below. `bladeRF-cli -L
fpga/images/hostedxA9_niosIIf_sweep_ts_v1.rbf` is what flashed it; the stock 0.16.0
image is no longer on the board, so reverting means re-downloading it from Nuand.

**THE DIAGNOSTIC INVERTED WHEN IT WAS FLASHED, and this is the trap.** `bladeRF-cli -e
info` reporting *"configured from SPI flash"* used to mean the STOCK image and was the
signature of the fault; it now means the II/f image loaded correctly and is the HEALTHY
state. *"configured by USB host"* means someone `-l`-loaded something over the top.
**The string is no longer diagnostic on its own** -- the only reliable check is
behavioural: run a sweep and read `sweep_core` on `sfcw_result` (`nios` = working,
`standard` = the latch tripped), or just look at the rate. If the sample counter is ever
dead again the engine prints one line ("NIOS autonomous sweep unavailable on this FPGA
image") and runs the standard sweep for the session: the capability latch
(`_nios_unavailable`) detects it at the first EXEC, so a stock image degrades to exactly
the old behaviour rather than churning. `docs/nios_sweep.md` (copied
from `fpga_branch`, plus a 2026-09-07 II/f addendum) holds the protocol and firmware side.

Measured through the full stack (`start.py` + one websocket client), 51 steps, settle 0:

| | ms/sweep | Hz | S_repeat (windowed, worst-2 steps trimmed) | mis-sliced |
|---|---|---|---|---|
| old II/e image, host-driven | 65.5 | 15.3 | -- | -- |
| II/f image, host-driven (`'standard'`) | 55.3-56.2 | 17.8-18.1 | 36.0-36.4 dB | 0.00% |
| **II/f image, autonomous (`'nios'`) -- DEFAULT** | **27.1-27.5** | **36.4-36.8** | **33.9-37.4 dB** | **0.00%** |

2500-sweep continuous soak on the shipped code: **27.5 ms flat (36.4 Hz), 0.00% rotated,
S_repeat 33.1-34.8 dB across all 24 windows with no drift, 1.0% fallbacks.**

- **The II/f image alone bought ~10 ms with no host change** -- the Nios services
  host-driven retune packets too, and the II/e's ~47.7 us/SPI-transaction CPU cost is the
  term that shrank. Even `sweep_mode='standard'` now beats the documented 65.5 ms.
- **Gate 2, the II/f step floor: ~303 us (~3030 samples)** -- 6.6x the II/e's 2.003 ms
  rail and better than the ~490 us prediction, so the profile preload genuinely hides
  under the dwell. Ask for less and the firmware steps at ~3030 regardless.

### Controls (via `sfcw_set_params`; the GUI does not send them, so it gets the defaults)

`sweep_mode` = `'nios'` (default) | `'standard'` (the host-driven core, untouched -- **one
set_params reverts everything**); `nios_dwell` (samples/step, min = default = 4096);
`nios_settle` (default 1024); `nios_pipeline` (default True). `benchmark_sweep.py --mode
nios [--dwell N --nios-settle N --no-pipeline]`. **Every failure inside `_sweep_core_nios`
falls back to ONE standard sweep and prints why** -- a fallback is a correct slower sweep,
not a lost one. Every `sfcw_result` carries `sweep_core` (`nios` / `fallback` / `standard`)
and, in nios mode, a `nios_diag`. **Any block metric that ignores `sweep_core` is
measuring a mixture of two sweep flavours and will read far worse than either.**

### T0 is anchored STRUCTURALLY, and the gate fails closed

The firmware fires steps 1..n-1 on the dwell grid (step 0 is activated by EXEC itself,
off-grid), so a complete transient lattice holds n-1 boundaries spanning exactly **n-2
periods**. When that holds, the first member *must* be step 1 and the last *must* be step
n-1 -- the front anchor (`first - period`) and the end anchor (`last - (n-1)*period`)
become algebraically the same number and T0 is certain. Measured over 199 sweeps: span was
n-2 on **197**, short by one period on **1** (that is the one-step rotation), and wildly
short on **1** broken capture.

A short span is the ambiguous case, and **nothing inside a single sweep can resolve it**:
both channels shift together, so every capture window is still clean CW -- just of the
neighbouring frequency -- and h_cal comes out a perfectly valid measurement rotated by one
step. In-window reference magnitude is identical either way (measured). So the gate
**refuses the sweep** rather than guessing. Costs ~1% of sweeps, removes rotation entirely.

**INVARIANT, enforced and commented in `_nios_refine_offset`: alignment is derived from
the REFERENCE channel (`ref_all`) only.** RX2 is a cable loopback, so nothing in front of
the antenna can change it -- that is what makes slicing immune to the scene. `sig_all` is
touched only for the ADC peak and the final division. Never feed the signal channel,
h_cal, or anything from a previous sweep into the alignment decision.

### The resolver that had to go (2026-09-07) -- do NOT reintroduce it

An intermediate version anchored on the END of the lattice and repaired rotations by
correlating h_cal against the previous sweep, then against a decayed template of accepted
sweeps. Both are unfixable by construction, and the operator found the failure on the GUI:

- **Bistable against the previous sweep.** Once one rotated sweep became `prev`, rotated
  sweeps agreed with each other and correct ones looked wrong. Under load it flapped
  between the two locks and **43% of sweeps came out rotated**.
- **The template version confuses a SCENE CHANGE with a mis-slice.** Inserting a target
  drops agreement exactly as a mis-slice does, so the resolver rotated correctly-aligned
  sweeps; re-seeding the template on one of those latched the error, and **removing the
  target did not recover it** -- only stopping and restarting the sweep (which clears the
  template) did. That is the exact symptom reported.
- Note the metric itself is also weak: a one-step rotation of a smooth spectrum still
  correlates ~0.96 in the frequency domain, so it is high in absolute terms.

Alignment must not depend on scene stability. The span gate replaced all of it.

### The pipelined capture must be BOUNDED, or it feeds back

With `nios_pipeline`, sweep N+1's capture is opened before sweep N is processed, so it
accumulates for as long as processing takes -- and processing is dominated by
`np.concatenate` over that buffer list. That is a positive feedback loop: slower
processing -> more buffers -> slower concatenate -> slower still. Measured with only the
1220-buffer / 0.25 s hard cap in place (~10x what a sweep needs), the sweep **drifted
28 -> 44 ms over a 1200-sweep run and dragged 4.8% of sweeps into misalignment**.
`_bulk_start(max_buffers)` now sizes the cap from what the sweep actually needs (~112
buffers), refined once `round_trip` is known. That alone took it to 27.3 ms flat with 0.1%
rotated; the span gate then removed the last of it.

### What the II/f broke in fpga_branch's alignment (all in `sfcw_engine.py`)

1. **Transients are 16-33 samples wide** (vs hundreds on II/e): detection boxcar k
   256 -> 64, or only ~20 of 51 boundaries are found and every sweep falls back.
2. **EXEC front matter is NOT on the T0 grid**: a distinctive pair ~1940 samples apart,
   then ~11,120 samples to the first regular boundary -- **3.190 periods, std 0.0055**.
   On the II/e the dwell was 6x longer and this latency rounded away.
3. **The period can run LONG** (4096 -> up to 4107; +0.65% at 4928), not only short:
   period gate 0.5% -> 1.5%, and the stride is no longer clamped to the dwell.
4. **Dwell 3456 is unstable** (period wobble +/-14 samples, S_repeat 13-19 dB) even though
   the rail is ~3030 -- hence `NIOS_MIN_DWELL = 4096`. With the pipeline the sweep is
   PROCESSING-bound (~27 ms against ~21 ms of stepping), so a shorter dwell buys nothing.
5. **`_nios_period_hist` is cleared on a dwell change** -- the steady-median override
   otherwise carries the old dwell's period into the new grid and slices garbage.
6. **A stale capture head is normal** -- back-to-back captures open on ring backlog holding
   the PREVIOUS sweep's tail, also period-spaced. The lattice keeps only the trailing
   (num_steps-2)-period window. Do NOT trim the capture to a tail window before aligning:
   with an empty ring the train sits at the FRONT and the trim cuts its head off (tried,
   broke every sweep).

### Sample loss / delivery lag under load

A continuous capture is sliceable only if it is gapless. Under full-stack load the RX
thread stalls (50.9 ms worst on record); the old 16-buffer sync ring gave 3.3 ms of
tolerance and overflow DROPS samples with no flag in SC16_Q11.

- **RX sync ring 16 -> 256 buffers** (`bladerf_driver.py` `RX_RING_DEPTH`, 52 ms of stall
  tolerance, 4 MB). Also helps the standard sweep: converts rare loss into delay, which the
  lockstep settle gate already handles.
- **Harvest lag gate**: `_nios_capture_lag` (hardware-clock elapsed minus delivered) vs 75%
  of the ring, before slicing. NOTE this is delivery LAG, not loss -- 2-7 ms is ordinary
  backlog at 36 Hz. An earlier gate that read it as "loss" at a 0.5% threshold **rejected
  every sweep**; do not lower it without understanding that distinction.

### Fallbacks are EXPECTED, and must not re-prime or spam (2026-09-07)

Measured on the shipped code over 2500 sweeps: **1.36% of sweeps fall back**, essentially
all of them the span gate refusing a lattice that came up one boundary short. That is the
gate working -- each one produces a correct standard sweep -- and the operator sees no
corruption. Two things about that path were wrong and are fixed:

- **A transient failure must NOT invalidate the priming.** `fallback()` used to always set
  `_nios_primed = False` (inherited from `fpga_branch`, where the only failure it
  contemplated was "this firmware has no sweep support"). The NIOS still holds a perfectly
  good copy of the grid after a mis-aligned capture, so re-priming is waste -- and worse,
  it walks 51 retunes over USB, which disturbs the very next capture and turned single
  fallbacks into RUNS of them. That is what the operator saw as three-in-a-row. `fallback()`
  now takes `reprime=` and only the CAPABILITY failures (EXEC rejected / counter dead /
  prime refused / no profiles) set it. Measured after: **34 fallbacks in 2500 sweeps, run
  lengths all exactly 1 -- the cascade is gone.**
- **The log is rate-limited** (`_log_nios_fallback`, `NIOS_FALLBACK_LOG_PERIOD_S = 30`).
  At 36 Hz a 1.4% rate is a line every 3 s, which buries the one message a real failure
  would print -- the same trap the `_sweep_core` unpack bug fell into, where the operator
  learned to ignore a recurring line. First of a run prints in full; the rest are
  summarised every 30 s with a rate. Verified against a fake clock: 45 fallbacks over 90 s
  produce 3 lines, not 90.

Residual mis-slice rate, split by flavour over 1800 sweeps: **nios 1770/1771 correctly
aligned, fallback 29/29**. The single outlier is not a clean rotation -- its best
correlation is 0.83 where a genuine one-step rotation scores ~0.999 -- so it is one
disturbed capture, not an alignment error.

**If the fallback rate ever needs lowering**, the cause is a missing boundary at one END of
the lattice, and the recovery is already measured but NOT implemented: the EXEC front
matter (the ~1940-sample pair) sits 3.190 periods ahead of step 1 with std 0.0055, and is
detectable in ~90% of sweeps, so it can identify the first lattice member's absolute step
index even when the span is short. It is worth ~1% of throughput, so it was left out to
keep the shipped path small; anything added there must fail safe (recover or fall back,
never guess).

### Still open / cautions

- The GUI's sweep-time estimate and Settle field describe the standard sweep; in nios mode
  they are cosmetic. GUI awareness of `sweep_mode` (and a toggle) is future work.
- `nios_settle = 1024` was chosen with wide margin over the ~30-sample transients, not by
  A/B. The correlation window auto-trims to a multiple of 100 samples so LO leakage stays
  on a sinc null (same rule as `DEMOD_SAMPLES`).
- **The TX2->RX2 loopback is still flaky** and is now the dominant quality term: raw
  whole-block S_repeat runs 26-34 dB in BOTH modes, with one step (0, 8 or 12) carrying
  14-60% of the difference energy. Reseat it before trusting any absolute S_repeat. Use
  windowed+trimmed S_repeat, not whole-block, whenever raw is under ~32 dB (the 0.999 corr
  bar IS the noise floor there).
- **Run ONE benchmark client at a time.** Two clients issuing `sfcw_start`/`sfcw_stop`
  corrupted several blocks during this session and cost real debugging time; repeated
  start/stop cycling also still degrades the device (recover by restarting `start.py`
  after a 15-20 s gap, or `usbreset` if it wedges).

### The 18 Hz regression: the FPGA image silently reverted (2026-09-11)

Reported as "the sweeps are running at 18fps, from the 37 we had already achieved".
Nothing had slowed down -- **the NIOS autonomous sweep was not running at all**, and
18 Hz is simply what the II/f image does host-driven. The bench had been power-cycled
while the LiDAR was rewired back to the TF-LC02, the image was RAM-loaded only, so the
FPGA reverted to the stock SPI image and the capability latch tripped at the first EXEC.
Fixed by flashing the image to SPI (`-L`), verified 35.9 Hz with 0.75-1.00% fallbacks.

**18 Hz is a DIAGNOSIS, not just a number, and the rate table above is the lookup.**
The three regimes are far enough apart to identify the cause from the rate alone:
~37 Hz = NIOS autonomous; **~18 Hz = II/f image present but NIOS not running**;
~15 Hz = the old II/e image. So ~18 Hz specifically means the sweep firmware is
unreachable while the II/f image is loaded -- look at the FPGA image and the latch,
never at `settle_count` or the host path.

**Confirm it with `sweep_core` on `sfcw_result`, which names the cause directly**
(`nios` / `fallback` / `standard`) -- that field exists precisely so this does not have
to be inferred from a rate. A 100% `standard` block is the latch; a 100% `fallback`
block is the span gate refusing every sweep, which is a different fault with the same
rate.

### There were TWO 18 Hz faults, and they masked each other (2026-09-11)

After the FPGA was reflashed and the wire measured **35.9 Hz**, the browser still
read 18 -- because the SFCW pane header was reporting the DISPLAY rate while
claiming to report the radar's, and the two numbers collide almost exactly.

`Viewport.jsx`'s `useSweepRate` derived the rate from the `sfcwResult` STATE, but
`App.jsx` only sets that inside the ~20 Hz live-display throttle added on
2026-09-10 (the slow-client fix). A fixed 50 ms gate against a 27.9 ms sweep
passes **exactly every other sweep**, so the header read the doubled period:

| real sweep | what the header USED to say | what it says now |
|---|---|---|
| 27.9 ms (35.87 Hz, NIOS, II/f) | **17.93 Hz** | 35.87 Hz |
| 55.5 ms (18.02 Hz, stock image) | **18.02 Hz** | 18.02 Hz |
| 65.5 ms (15.27 Hz, old II/e) | 15.27 Hz | 15.27 Hz |

**17.93 against 18.02 is not a distinguishable difference on a readout**, so the
header showed ~18 Hz whether the radar was healthy or the FPGA had reverted --
and it had shown ~18 ever since the throttle landed, which is why the rate looked
like it "dropped from 37" long after the throttle actually took it there. Fixing
the FPGA moved the wire from 18 to 36 and moved the readout not at all.

**Fixed by deriving the header from the measurement `App.jsx` already takes above
the throttle** (`sweepPeriodMs`, median of adjacent Pi timestamps over 12 sweeps),
which the C-scan panel was already using correctly for its traverse-sampling
arithmetic. `useSweepRate` is deleted; do not reintroduce a rate derived from
`sfcwResult`, and note that the throttle means **any** state gated behind it is
unsafe to measure timing from.

The general lesson is the one this file keeps relearning: **an instrument fed from
a throttled, decimated, or averaged copy of the data reports on the copy.** Same
class as `lidar_seq` counting reads rather than measurements, and as the C-scan
recomputing its own range profiles while the panel beside it showed the Pi's.

**The failure is quiet by design and that is the real cost here.** Degrading to the
standard sweep is the right behaviour -- it is a correct, slower sweep, not a broken one
-- but it announces itself with a single stdout line at startup that nobody is watching,
and the GUI's rate readout is the only other evidence. A halving of throughput should
probably be louder than one line; it went unnoticed long enough to be reported as a
mystery. Note `start.py` still does not touch the FPGA, so the flash is now the only
thing keeping this from recurring.

## The sweep "stuck in websocket": one slow client froze every client (2026-09-10)

Integrated from the `balls` branch (`cb077ea`). Symptom: the GUI stops receiving
sweeps entirely and stays stopped, while the Pi is plainly still sweeping -- the engine
thread, the NIOS capture and the stdout are all healthy. Restarting the browser tab
recovers it.

**Root cause: `client.send()` has no timeout, and the broadcast was SEQUENTIAL.** All
five broadcast sites in `sdr_server.py` did

    for client in self.clients:
        await client.send(msg)

`websockets.send()` awaits until the frame reaches the transport. A client that is not
draining -- a browser whose main thread is wedged, or a half-open TCP connection with no
FIN/RST -- fills the writer buffer and **that await never returns.** It blocks
`_sfcw_broadcast_loop` itself, so `sfcw_queue` (8-deep, drop-oldest) just churns and
**every other client goes dark with it.** One bad client freezes the whole server's
output. Note this is the same class of bug as the `put_nowait` one above and lives in the
same loop, but it is a different mechanism: that one throttled the broadcast to ~10 Hz,
this one stops it dead.

**Fix: `_send_to_all(msg, timeout=0.5)`**, now the only way anything is broadcast.
`asyncio.gather` over all clients concurrently, each wrapped in
`wait_for(..., timeout=0.5)`, and a client that times out is dropped as dead alongside
`ConnectionClosed`/`OSError`. **`RECONNECT_INTERVAL` in `useWebSocket.js` dropped
3000 -> 500 ms as a direct consequence** -- the Pi now evicts a slow client, so it has to
come back quickly. Those two changes are coupled; do not raise one without the other.

**The loop can also DIE, and used to do it silently.** `_sfcw_broadcast_loop` is a bare
`while True` and nothing awaited its task, so any exception inside it (a malformed dict,
a JSON failure) killed the task permanently with no output at all -- identical symptom,
different cause. The message-build and send are now wrapped in `try/except` that logs and
continues, and both broadcast tasks carry an `add_done_callback` that prints a traceback
if they die or are cancelled. A `_heartbeat()` reports
`broadcast/callbacks/drops/clients/qsize` on a 30 s tick, which is what tells the two cases
apart: **callbacks climbing while broadcast is flat = a stuck send; both flat = the loop
is dead.** `callbacks` is the load-bearing one -- it increments in `_sfcw_callback` before
any queue, client or send exists, so it separates "the engine is not producing" from "the
engine is fine and the send is stuck". Both of those now print their own `***` warning.

**The heartbeat is SILENT when idle, deliberately (2026-09-10).** It first shipped printing
unconditionally, and on an idle server that is a line every 30 s reading `broadcast=0
callbacks=0` with a client count that flaps on its own -- a tab closed abruptly lingers up
to ~40 s on `websockets.serve`'s 20/20 keepalive default, so `clients=5/4/5/4` is normal
and means nothing. That is the exact trap this file already records for the `_sweep_core`
2-tuple error: a recurring benign line trains the operator to ignore the one line a real
failure would print. So: **silence means idle; any output means a counter moved or a sweep
is running.** A running sweep always prints even with flat counters, because "running but
nothing moving" is the freeze the instrumentation exists to catch. Going idle prints one
line and then stops, so a quiet server stays distinguishable from a dead one. Client churn
alone is never worth a line. Counters are reported as deltas plus a rate, not bare
cumulative totals nobody can difference by eye.

**The client half: the browser WAS the slow client.** At the 36 Hz NIOS sweep rate every
sweep triggered the full re-render cascade (IFFTs, model inference, waterfall canvas), so
the main thread could not keep up with its own socket. `App.jsx` now throttles the live
display to ~20 Hz. **Only the React state driving the display is gated** -- every capture
path reads the local `msg`/`provenance` and still sees every sweep -- and the throttle is
bypassed outright while any capture is armed (`bscanCaptureRef`, `sfcwBgCaptureRef`,
`bscanBgCaptureRef`, `bgModelAccumRef`, `bgModelTestRef`). `setSfcwLidarProvenance` is
inside the gate deliberately: it feeds only the Sidebar readout, so at 36 Hz it was
re-rendering the sidebar for nothing.

**Not integrated from that branch, deliberately: the Capon / semblance wiring.** The same
commit bundles half of an unrelated beamforming feature -- an
`import { useCaponWorker } from './hooks/useCaponWorker'`, six new `bscanParams` fields, a
third argument to `computeGridScales`, and `caponValues`/`precomputedValues`/
`sarSemblanceEnabled` props. **`useCaponWorker.js` does not exist on any branch or in any
commit in this repo's history**, so `origin/balls` cannot build. The other half-wired
pieces are no-ops here anyway (`computeGridScales` takes two arguments; the new props have
no consumer). If that feature is wanted, it needs the worker file from wherever it was
written, not this commit.

**Residual gap, known and left alone:** only `_sfcw_broadcast_loop` has the `try/except`.
`_broadcast_loop` (rx/fft) and `_broadcast_status` can still die on an unexpected
exception -- strictly better than before, since `add_done_callback` now makes it loud
rather than silent, but they are not yet self-healing.

### The same bug was in `rover_server.py`, and the 500 ms reconnect set it off (2026-09-10)

Immediately after the above shipped: `RuntimeError: Set changed size during iteration`
in `_fanout`, repeatedly, killing the `board_handler` and so taking the BOARD link down
with it.

**The repeated `[rover] rover controller connected` lines in that log are NOT the fault --
they are the Arduino's own reconnect working.** The board noticed its socket was gone and
rejoined by itself, every time, with no intervention. That firmware behaviour is tracked
SEPARATELY from this Pi-side fix; do not assume the two ship together. Behaviourally, per
the operator: a board that dropped off used to require restarting the ROUTER to come back,
and now it simply reconnects on its own.

Worth keeping as a diagnostic lesson: **the firmware's reconnect MASKS how bad a Pi-side
bug like this is.** A crash that kills the board link presents as harmless-looking link
flapping, because the board keeps coming straight back. So a board reconnecting over and
over is evidence that something keeps DROPPING it -- look at the Pi, not the network, and
do not read self-recovery as "the link is fine".

`rover_server.py` `_fanout` had the identical `for c in self.clients: await c.send(msg)`,
and it carried **both** failure modes:

- **Mutate-during-iterate.** `client_handler` does `clients.add()` on connect and
  `.discard()` in its `finally`, on this same event loop, so every `await` inside the
  loop is a yield point at which the set changes underneath the iterator. This one is
  worse than the sdr_server case: `broadcast()` is called from `board_handler` at 20 Hz,
  so the exception propagates out of the **board** handler, not a client handler. The
  `except websockets.ConnectionClosed` there does not catch `RuntimeError`, so it fell
  into the `finally`, which calls `broadcast()` again and raised again -- that is the
  "During handling of the above exception, another exception occurred" chain in the log.
- **No timeout, sequential sends.** Same as sdr_server: one client that is not draining
  blocks the loop and `broadcast()` never returns at all.

**The reconnect change is what made it constant, not what caused it.** The race was
always there; dropping `RECONNECT_INTERVAL` 3000 -> 500 ms made clients churn 6x more
often, so a 20 Hz broadcast started landing inside the add/discard window routinely.
Expect this whenever reconnect timing is tightened.

Fixed the same way as `_send_to_all`: iterate a **snapshot**, `gather` concurrently, each
send under `wait_for(timeout=0.5)`, drop dead/slow clients. Plus a deliberate **catch-all**
in the per-client coroutine that `sdr_server._send_to_all` does not have -- here anything
escaping takes the board link down, so a client whose send raises *anything* is dropped
(printed, not `_note()`d, because that would re-enter `broadcast_log` -> `_fanout`).

Verified by extracting the SHIPPED `_fanout` from the file with `ast` (not a retyped copy)
and driving it: 400 broadcasts against a client churning connect/disconnect gives
**0 RuntimeErrors** post-fix and one per broadcast pre-fix; a stalled client is evicted
after 0.5 s with the healthy clients still delivered and retained, where **pre-fix
`_fanout` never returns at all** (confirmed hung past a 3 s watchdog -- so every
*subsequent* broadcast never happens either, and the raster's `STATUS_STALE_MS` = 4 s
watchdog would abort the scan); and an unexpected send exception is contained rather than
escaping. Throwaway scripts, as usual.

**`pi/sensors/stream.py` was checked and is SAFE** -- its
`gather(*(c.send(msg) for c in clients))` unpacks the generator to completion *before* the
first await, so the set is never iterated across a yield point. It has no send timeout, so
the slow-client stall is latent there, but it cannot raise this RuntimeError. It is the
only other websocket fan-out on the Pi; `sdr_server.py` and `rover_server.py` are now both
fixed.

## Standoff dependence of the background is ~linear in phase; LiDAR offset is stale (2026-09-13)

Asked whether near-field coupling and a non-linear alignment make a linear-phase
along-track background fit wrong. Measured offline on `groundstation/models/gw2.json`
(122 knots, 1 mm spacing, 2026-09-12, current gains) by rewinding its unwound knots
(`h = u * exp(-j*4*pi*f*0.8*d/c)`) and scoring per-frequency complex least-squares
fits under guarded leave-one-out: neighbours within 2 mm of the held-out knot
excluded, so a model cannot score by copying its nearest knot. Throwaway scripts.

| window | mean | const + exp(-j*a*phi) | + 2nd bounce | + wall amplitude slope | 6 terms |
|---|---|---|---|---|---|
| +-10 mm | 14.3 | 20.6 | 22.3 | 22.4 | 20.9 |
| +-20 mm | 6.9 | 18.3 | 18.7 | 20.5 | 15.0 |
| +-40 mm | 3.2 | 17.9 | 18.5 | 17.8 | 20.8 |

Shipped Akima model under the SAME 2 mm guard: **20.5 dB** (25.6 as stored is unguarded).

- **Alignment is linear.** Best alpha is flat from 0.75 to 1.05 (within 0.2 dB); local
  alpha wanders 0.75-1.0 across the span with no trend. Not a curving delay.
- **Coupling is nearly constant.** Its fitted spectrum correlates 0.988-0.998 between
  adjacent 10 mm windows, 0.987+ against the 40 mm window, i.e. changes ~17 dB below
  itself. Irrelevant for a 15 dB target, binding past ~20 dB.
- **What is non-linear is amplitude and multi-bounce.** Wall term falls ~5 dB over the
  span; the second antenna-wall bounce is -5.7 dB of total at the closest window and
  -21 to -30 dB mid-range. Modelling them buys 2-3 dB. Nothing exceeds ~22 dB guarded.
- **The ceiling is data at specific standoffs, not model form.** Every model, Akima
  included, drops to 15-17 dB at gw2 standoffs 10-30 mm and 80-90 mm. Untested lead:
  hand tilt during the wave; check pose spread in those bins on the next capture.
- pass3 (2026-08-28, 30 static knots, an OLDER bench) agrees: linear phase 21-24 dB, + 2nd bounce
  23-27 dB, correct sign 24.2 dB vs wrong sign 7.1 dB (a wrong sign fails safe).

**LiDAR->antenna offset on the gw2 bench: 131.475 mm (set 2026-09-13).** gw2's nearest
knot was captured with the antenna FLUSH on the wall (operator) and read -28.525 mm under
the 160 mm offset then in use, so flush = 131.475. Note the code default was already 132
(bench-measured 2026-09-07 as 136-138 minus a 5 mm buffer); the 160 came from the
operator's browser localStorage, which always beats the default. Fixed by moving the
setting to a VERSIONED key, `lidar_antenna_offset_mm_v2`, defaulting to 131.475 with no
buffer. Re-measure after any re-mount: antenna flush on the wall, read the LiDAR.
- **gw2.json was migrated to 131.475 EXACTLY, not rebuilt.** Every knot `d` +28.525 mm,
  and `uRe/uIm` AND the Akima slopes `sRe/sIm` rotated by `exp(+j*4*pi*f*alpha*28.525mm/c)`.
  Rotating the slopes (not recomputing Akima, which is nonlinear per real/imag part) makes
  inference identical: old model at x vs new at x+28.525 differ by 2.7e-15 over 997
  standoffs. `quality.per[].d` shifted too, `geometry.lidarAntennaOffsetMm` = 131.475, and
  `geometry.offsetMigration` records it. Original kept as
  `groundstation/models/gw2.offset160-backup.json`. **The models folder is gitignored**, so
  this lives only on the PC that holds it -- migrate any other copy the same way.
- Other models in that folder are other benches and keep their own offsets; loading one
  now shows the geometry-mismatch warning, which is correct.

**SAR used to clamp a negative standoff to zero in the layered model -- FIXED 2026-09-13.**
`buildRayTable` only added the air layer `if (dA1 > 0)`, so a cell at standoff <= 0 was
reconstructed flush with the wall while its neighbours kept their gap. A negative value
is now kept as a pure broadside delay (what the straight-ray branch always did), the
worker reports `standoffNegativeN`, and the SAR panel warns that the LiDAR offset is too
large by at least the most negative value.

## rod1 SAR scan: the settings decide whether anything focuses (2026-09-13)

`rod1.json` (operator's Downloads, 2026-09-12) is the one current SAR scan on the gw2
bench: 1 rover row, 66 columns at 5 mm, **64 captured (columns 36-37 missing)**,
continuous traverse at 100 mm/s, so only 1-3 sweeps per cell. Analysed offline by
driving the SHIPPED `applyBscanBg` + `sar.worker.js` from Node: copy `src/lib` to a
scratch dir, add `.js` to relative imports, `{"type":"module"}` package.json, shim
`globalThis.self`, call `self.onmessage` synchronously and collect `postMessage`.
Worker `image` is in **dB** (negative), not linear amplitude.

- **Every cell recorded `range_offset` 0.5, while the panel and the repo's Pi default
  are 0.378 -- the Pi that took it was running the old default.** The raw profile's
  dominant echo sits at 0.41 m of raw range: 0.5 would put the wall face at -9 cm,
  0.378 puts it at 32 mm, consistent with the gw2 offset finding (true standoff ~30 mm).
  SAR reads the per-cell value, so a stale Pi mis-ranges every reconstruction.
- **Wall permittivity ~5.5, not the panel's 4.5.** Back-face echo at 0.761 m raw, 35 cm
  of apparent range behind the face, so n = 2.34 for the 15 cm wall. The SAR panel's
  wall-thickness default is 29 (an older bench) -- set 15 here.
- **The SAR worker placed positions by ARRAY INDEX, not `grid_ix` -- FIXED 2026-09-13.**
  A missing column shifted every later cell by a pitch. On rod1 every cell after the
  gap sat 10 mm off and the image ended 1 cm short; the rod is before the gap and moved
  only 0.1 dB at the calibrated settings. (An earlier ~1 dB figure was from the guarded
  fit at er 4.5, a different configuration.)
- **Along-track reference is valid over tens of mm.** Repeatability 32 dB within a cell
  and between adjacent cells; the raw spectrum decorrelates only to 25 dB at 20 mm,
  21 dB at 50 mm, 18 dB at 200 mm.
- **gw2 subtraction adds nothing once an along-track step is present.** It helps only
  with no along-track removal; after rank-1 SVD, along-track mean or the guarded fit it
  scores 0 to -2 dB against no model on rod1's feature.
- **A compact scatterer at x ~14.5 cm, 17-18 cm deep (er 5.5), i.e. ~2.5 cm behind the
  15 cm wall's back face, passed every falsification test** at the calibrated settings
  (range offset 0.378, standoff +28.5 mm, gap filled, refraction on, rank-1 SVD):
  17.2 dB over the image median, coherence 0.72; unchanged with 6 columns trimmed from
  either end (16.8 / 17.8 dB); present in both halves of the band (2-3.5 GHz 16.6 dB,
  3.5-5 GHz 12.1 dB, weaker high as concrete attenuation predicts). Ground truth for the
  rod's position was NOT known when this was found -- confirm before relying on it.
  The next distinct peak 5 cm left at the same depth (~13.5 dB) may be its own sidelobe.
- **A second strong feature sits on the LAST column at back-face depth (x 32.5 cm,
  15.2 cm) and cannot be resolved from this scan.** The guarded fit makes it the
  strongest peak, but it is NOT a simple one-sided-window artefact: trimming 6 end
  columns leaves the new end only 8-12 dB, so it does not follow the edge. It lies at or
  past the end of the aperture (a brick edge would look like this). Overscan past it.
- **Combined amplitude x coherence with NO along-track removal peaks in the deepest
  image rows** (coherence ~0.9 from few contributors). Misleading as a detector there.
- With the as-recorded settings (0.5 offset, uncorrected standoff, gap by index) the
  image is dominated by a flat band at ~12.6 cm depth -- the back face mis-placed.

## SAR panel: permittivity suggestion, grid positions, range-offset guard (2026-09-13)

Implemented after rod1.json's ground truth was confirmed: the rod was ~15 cm along
the scan, immediately behind the 15 cm wall, exactly where the reconstruction put it
at er 5.5, range offset 0.378 and the standoff corrected for the stale LiDAR offset.

### Permittivity suggested from the back wall (`lib/permittivityEstimate.js`)

Shown directly under the SAR panel's εr field. It only SUGGESTS: a "Use" button copies
the value into the field, and every other candidate echo is a clickable chip. The field
stays the operator's.

- **Method.** Coherent mean of the RAW `h_cal` of every cell (never the background-
  subtracted input, since a model removes exactly the wall echoes needed), Hanning
  window, zero-padded IFFT at range offset 0, log-parabolic peak interpolation. The
  strongest peak is taken as the front face; each later peak implies
  `er = (separation / wall thickness)^2`. Candidates between er 1.5 and 16 and within
  30 dB of the face are returned, strongest first.
- **Offset-free by construction.** It uses a separation, so the range offset and the
  LiDAR offset cancel. Verified: identical er at offset 0.5 and 0.378.
- **Why the highlighted pick is restricted to er 3-10, not the strongest echo.** On
  rod1 the candidates are er 2.4 at -6 dB, 5.5 at -14 dB, 9.8 at -17 dB and 15.7 at -28 dB.
  The strongest, 2.4, is a RIG echo: it sits in the gw2 model at every standoff (its
  peak range moves with slope ~0.08 against the ~1 a wall echo must show) and repeats
  at an even ~23 cm spacing. Nothing in one scan separates rig from wall -- a per-
  frequency constant-plus-standoff-rotating regression over gw2 did not separate them
  either -- so the strongest echo would have suggested the wrong answer on this bench.
  The dry masonry range excludes it; the chip keeps it available for a wall that
  really is ~2.4 (aerated block).
- **It needs the wall thickness.** 0 shows a prompt instead. A wrong thickness gives a
  confident wrong answer (rod1 at 29 cm suggests 4.2), so check it first.

### Grid-column aperture positions and negative standoffs (`sar.worker.js`)

Positions come from `grid_ix` (now in `SAR_INPUT_FIELDS`), so a missing column is a gap
rather than a slide. Falls back to the array index when `grid_ix` is absent or repeats
(a multi-row capture), and the result carries `positionSource`, `missingColumns` and
`duplicateColumns`; the panel notes gaps and warns on the fallback. Negative standoffs:
see the FIXED note in the section above.

### Range offset: 0.378, and a guard against a Pi that ignores it

- **0.5 is wrong; 0.378 is the calibrated value** (tuned for targets in air, confirmed
  by the rod1 face echo). `SFCWEngine` defaults to 0.378 on this branch and now logs
  any change pushed to it. **`main` still carries -0.13, and `fpga_branch`,
  `imaging-stuffs`, `imaging-things`, `tight_packing` and `tight_packing_clean` carry
  0.5.** The Pi that recorded rod1 was running one of those, or unpushed code; it was
  unreachable over SSH (`sfrpi`, `sfrpieth`, `sfrpiFRMLAPTOP` all timed out) so its
  branch is unconfirmed. Deploy this branch's engine to the Pi.
- **Groundstation guard (App.jsx, top of the `sfcw_result` handler).** If a result's
  `range_offset` differs from the panel's, the panel's value is stamped onto the result
  (the Pi's kept as `range_offset_pi`), params are re-pushed at most every 5 s, a console
  warning is printed once per distinct pair, and the SFCW panel shows an amber banner
  under Range Offset. Safe because `h_cal` does not depend on the offset -- it only labels
  the range axis -- and consistent with the rule that the panel is the source of truth.
  Records captured while the banner shows are therefore correct.

### Where rod1's 0.5 came from, and the corrected file

- **Not the export.** A C-scan cell takes `range_offset` from the Pi's `sfcw_result`, which
  copies `SFCWEngine.range_offset`; the export writes the cells verbatim. rod1's own Pi
  profile confirms the Pi swept at 0.5: its first distance is 0.0021 m, which 0.5 produces
  and 0.378 (0.0016 m) does not.
- **The Pi runs this branch (operator, 2026-09-13), so the 0.5 was PUSHED to it.** Saved
  scans bracket when: `temp.json` (09-08) header 0.378 / cells 0.378; `one&zero.json`
  (09-11) and rod1 (09-12) header 0.378 / cells **0.5**; `rebar_air_b_scan.json` (09-13)
  0.378 / 0.378. Every scan saved before 09-07 has 0.5 in its HEADER. The Pi's
  `set_params` has no failure path before the offset, and no code touched the push
  between 09-08 and 09-11. Two routes on this branch put 0.5 on the Pi, both FIXED:
  1. **C-scan import restored `rangeOffset` from the file header** (since `9b51962`,
     09-04). Importing any pre-09-07 scan set the panel to 0.5, which the panel then
     pushed. The gains were already deliberately NOT restored for this exact reason; the
     offset now is not either. Imported cells keep their own per-cell value.
  2. **Every tab pushed its full param set on every (re)connect, even mid-sweep.** Since
     `b0dd95c` (09-10) the Pi evicts a client that stops draining and the browser
     reconnects in 500 ms, so a throttled background tab re-pushed ITS panel over another
     tab's running sweep, repeatedly. A tab holding 0.5 (old build or imported old scan)
     explains the 09-11 and 09-12 files, and 09-10 is exactly where the window opens.
     Gains and settle were exposed the same way. Now the connect push happens only when
     the first `sfcw_status` after connecting says the Pi is idle; whoever starts a sweep
     still pushes first. The guard's 5 s re-push is limited to the tab that started the
     sweep (`sfcwOwnerRef`, set at every `sfcw_start` including the SFCW panel's button via
     `sendSdrTracked`, cleared only on a running->stopped TRANSITION of `sfcw_status`: the
     Pi answers the params push that precedes every start with `running:false`, which
     arrives after the tab has claimed ownership, so a plain `!running` test clears it at
     once -- that bug was in the first version and caught in review).
  Not proven which route fired: the Pi was unreachable. The engine now prints
  `[sfcw] range_offset A -> B m` on any change, so the Pi's stdout will name the next one.
- **What hid it: the export header is the panel's state AT EXPORT, the cells are what the
  Pi swept with.** rod1's header said 0.378 over 64 cells at 0.5. Every sweep-record site
  in App.jsx now also copies `range_offset_pi` (set only when the guard corrected a
  result), and `buildCellRecord` carries it into C-scan cells, so an export shows the
  disagreement. `JSON.stringify` drops it when undefined, so clean scans are unchanged.
- **rod1.json was corrected in place (operator's request):** every cell `range_offset`
  0.5 -> 0.378, the Pi profile's `distances` shifted +0.122 m (same bins, relabelled),
  `range_offset_pi: 0.5` added per cell. Then every cell AND sweep `lidar_standoff_mm`
  +28.525 mm and `lidar_offset_mm` / header 160 -> 131.475, recorded in
  `lidarOffsetCorrection`. Standoffs now 27.5-34.0 mm. Original kept as
  `Downloads/rod1.original-range-offset-0.5.json`. With AUTO standoff and the new SAR
  defaults the brightest pixel is on the rod: 14.4 cm along, 17.7 cm deep, coherence 0.72
  (SVD k 1, BG off); with gw2 subtraction all 64 cells apply unclamped, coherence 0.66.

### Verification

Node harness driving the shipped `permittivityEstimate.js` and `sar.worker.js` on
rod1.json (the copy-lib-and-add-`.js` method above): estimator 5.5 at 15 cm, prompt at
0 cm, offset-invariant; grid positioning keeps the gap (aperture 32.5 cm, 2 missing)
and still focuses the rod at 16.9 dB / coherence 0.70; a scan shifted entirely negative
reconstructs with finite values and counts all 64; repeated columns fall back to the
index. `vite build` passes; `sfcw_engine.py` compiles. **Not driven in a browser** and
**not deployed to the Pi**. The SAR panel's own defaults (εr 4.5, wall 29 cm) are
unchanged -- set 15 cm for the gw2 bench.

### SAR image orientation and per-row SAR on multi-row grids (2026-09-13)

- **The SAR image is drawn like the C-scan's row B-scan now**: lateral position left to
  right, depth INCREASING bottom to top (wall face on the bottom edge). It used to put depth
  on the x axis and position down the y axis. `SarDisplay.jsx` `blit` writes image row
  `pixelsZ-1-zi`, column `xi`; the ticks, axis titles and crosshair follow. The worker's
  data layout (`vals[zi*pixelsX + xi]`) is unchanged. The lateral axis starts at the
  worker's new `apertureStart` (first captured column x pitch), so a row that begins part
  way into the grid reads the same x as the C-scan.
- **SAR reconstructs ONE row of a multi-row C-scan: the row selected on the C-scan.**
  Before, it fed every cell of every row to the 1-D back-projection, which fell back to
  capture order (`duplicateColumns`) and produced a meaningless zig-zag aperture. The C-scan
  selection (`cscanSelectedCell`) moved from `Viewport` local state to `App.jsx` for this.
  `sarRowIy` is kept separately: closing the C-scan row pane does not change the SAR row, and
  a missing row (new scan, import) falls back to the lowest row that holds data. `sarRowData`
  filters BEFORE `applyBscanBg` (a per-cell map, so the result is identical and cheaper).
- **Row stepper**: a footer at the bottom right of the SAR viewport, only when more than one
  row holds data. It walks the rows that hold data, stops at either end (no wrap), and moves
  an open C-scan row pane with it so the two panels always agree. Rows are numbered
  `iy + 1`, same as the C-scan's B-scan pane (row 1 = bottom row).
- The permittivity suggestion still reads the WHOLE grid (a better coherent mean), not just
  the active row. The 2D Map is unchanged and still treats the capture as one line.

### SAR panel defaults for the gw2 bench (2026-09-13)

`sarWallThickness` 29 -> **15.2 cm**, `sarEpsilonR` 4.5 -> **5.4**, `sarRefraction` false ->
**true** (layered ray), `sarMaxDepth` 70 -> **40 cm** (**20 cm since 2026-09-14**, operator's choice, matching the 5-20 cm detection band) (the auto-fit only pulls a clipped
request down, and 40 is well inside the ~60 cm a sweep reaches on this bench). Not persisted, so they take effect on reload. 5.4 agrees with the
back-wall suggestion on rod1 at 15.2 cm (5.36). Layered is on by default because the
straight ray loses the rod entirely on rod1. The negative-standoff warning now counts
cells below **-2 mm**, not below 0: with a correct offset a flush antenna reads 0 +/- 0.7 mm
and a strict test would warn on every legitimate flush scan.

## 2rods1pipe.json: blind multi-row analysis (2026-09-13)

6-row x 140-column rover C-scan (5 mm pitch, rows 1 cm apart, 70 cm wide) recorded with
the corrected offsets (range 0.378, LiDAR 131.475). Rows 0 and 2 have long gaps (~37-53
and ~27-37 cm) and row 0 has 25 cells without a standoff. Back-wall suggestion 5.5-5.85
per row (5.66 overall) at 15.2 cm, agreeing with the 5.4 default.

**Method worth reusing: treat every row as an independent measurement.** Per-row SAR
through the shipped worker (layered, er 5.4, wall 15.2, Auto standoff), each row's
amplitude x coherence normalised to its own median and resampled onto one lateral axis,
then a feature counts only if it (1) appears in most rows, (2) survives both clutter
removals (rank-1 SVD and the guarded along-track fit), (3) holds its x across the
2-3.5 and 3.5-5 GHz halves -- a sidelobe's offset scales with wavelength, a scatterer's
position does not -- and (4) stays put when 8 columns are trimmed from either end.

**Result, blind (ground truth not yet given):** three scatterers ~1-2 cm behind the back
face, at scan x ~12.0, ~20.5 and ~54.0 cm (+-0.5 cm across bands and methods), depth
14.5-17 cm at er 5.4. Weaker peaks at 7 and 24 cm move between band halves (sidelobes);
16.5 cm sits exactly midway between 12 and 20.5 and is weaker (cross-term). Features
below 26 cm depth changed with the clutter method (SVD: 9 and 14.5 cm; guarded fit: 30
and 45.5 cm) and are not counted.

**The last column carries a bright feature at back-face depth in BOTH rod1.json and this
scan, and it is not a target inside the aperture.** In neither scan does it follow the
edge when the end is trimmed, and here nothing appears at 62-65 cm once the end moves to
65.5 cm. Treat a peak on the final column of a continuous rover row as a raster-end
artefact unless the scan overruns it by 15-20 cm. Cause not investigated.

A raw-data check without SAR (along-track residual energy just behind the wall) was
dominated by the back-face echo at the same range and by one-sided references at the
ends; it disagreed with SAR and is not a usable detector at this geometry.

### Why the C-scan plan view of 2rods1pipe.json does not show straight pipes (2026-09-13)

Reported: a plan view of straight vertical pipes, where every row should look alike,
does not. **The rows are not misregistered; the plan view is not measuring the pipes.**

- **Not a snake/latency zigzag.** Rows alternate direction at 7.5 cm/s with
  `roverLatencyMs` 0, but per-row SAR puts each target in the same place in every row
  (11.5-12, 18.5-21, 53-54.5 cm), and L->R minus R->L differs by <= 1.3 cm with a sign
  that flips between targets and methods -- a latency bias would move them all one way.
  Row 0's third target at 56-56.5 cm is the exception, and it sits just past that row's
  37-53 cm gap where it has only half an aperture.
- **The file's plan-view settings map the wall.** Gate 0-70 cm with `metric: 'peak'` puts
  the median cell's peak at **2.2 cm depth** (face + coupling). No target clears its
  row's median by 3 dB in any row.
- **The pipes sit ~1.5 cm behind the 15.2 cm back face, inside one 5 cm range cell of
  it**, so no gate separates them from the back-face echo, and the plan view's per-cell
  reduction (a gated metric of an unfocused profile) cannot either. Measured, rows agree
  at Pearson r and targets 12 / 20.5 / 54 clear +3 dB in N of 6 rows:

| plan view | row r | targets |
|---|---|---|
| file: gate 0-70, peak, no BG | 0.46 | 0 / 0 / 0 |
| gw2 model, gate 0-70, peak | 0.00 | 2 / 1 / 3 (+47 invalid cells) |
| gw2 model, gate 38-48, energy | 0.71 | 5 / 0 / 0 (+47 invalid) |
| same + Focus (SAFT) | 0.65 | 4 / 2 / 0 (+47 invalid) |
| **per-row SAR, rank-1 SVD, amp x coherence, 14-24 cm** | **0.70** | **4 / 6 / 5** |
| per-row SAR, guarded fit | 0.39 | 4 / 6 / 6 |

  The 47 invalid cells under the model are the cells with no LiDAR standoff, drawn as red
  crosses. **What shows the pipes is focusing plus clutter removal:** a plan view built
  from per-row SAR (depth slice of amplitude x coherence after rank-1 SVD). The C-scan
  panel has no such mode today; its Focus is magnitude-domain SAFT without SVD or
  coherence, and measured here it does not recover them.

### Why the six per-row SAR images of 2rods1pipe.json differ and show far more than 3 targets (2026-09-13)

The three target positions (12, 20.5, 54 cm) were CONFIRMED correct by the operator. The
operator's complaint was the SAR images themselves: six rows of straight vertical pipes
should look alike, and each shows many extra features. Measured at the panel defaults
(er 5.4, wall 15.2, layered, depth 40, SVD OFF, rectangular):

- **Each image has 86-125 local peaks inside its 20 dB colour window**; the targets are a
  handful of them. The display's per-image autoscale (vMax = own max, vMin = vMax - 20) is
  NOT why rows look different: every row's max is within 2.4 dB of the brightest, and
  similarity is identical on a common scale.
- **Most extra features are full-width horizontal bands from echoes that are the same at
  every position.** Rig-locked echoes do not move when the wall does -- rod1 (standoff
  30.5 mm) vs this scan (55.2 mm): 26.1 -> 26.8, 38.3 -> 38.4, 62.5 -> 62.3 cm apparent --
  and mapped through the layered model at this scan's standoff they land exactly on the
  image bands: **9.2 cm (the brightest thing in every row with SVD off), 14.1 cm and
  36.7 cm**. A fourth echo, 50.0 -> 52.6 cm, DID move with the wall (47 cm behind the face
  in both): a real reflector ~12 cm behind the back face, band at 27 cm. A 12.7 cm echo
  (band at ~3 cm) is likely the antenna-face double bounce. A 30 cm band appears with the
  rectangular window only (range sidelobe). The rig echo at 26 cm is the same one that
  poses as a back wall at er ~2.4 in the permittivity suggestion.
- **Rows differ mainly because of gaps.** Rows 0 and 2 miss 33 and 31 columns. Gap-free
  rows (1,3,4,5) agree at r 0.79; pairs with row 0 or 2 at 0.59, rising to 0.79 once gap
  columns are masked. Standoff differences between rows do not matter (corr ~0). Rows
  1 cm apart agree better (0.76) than rows 3-5 cm apart (0.61), so the scene also changes
  genuinely with height. Rank-1 SVD is estimated per row and gaps change what it removes,
  so SVD ON lowers row similarity (0.55).
- **Cleanup options, tested on all six rows (Hanning, depth 40).** Band level is the
  width-averaged image at that depth relative to the image max; targets = rows where each
  of 12 / 20.5 / 54 cm is within 6 dB of the image max.

| processing | peaks/row | 9 cm rig | 27 cm behind-wall | 37 cm rig | targets | brightest is a target | row r |
|---|---|---|---|---|---|---|---|
| SVD off (panel default) | 53 | -4.5 | -11.2 | -16.0 | 0/0/0 | 0/6 | 0.84 |
| **SVD k1** | 65 | -15.9 | -12.5 | -9.0 | 5/6/6 | **6/6** | 0.52 |
| SVD k2 | 71 | -17.2 | -14.8 | -10.4 | 6/6/3 | 4/6 | 0.43 |
| SVD k3 | 78 | -15.9 | -16.9 | -15.2 | 6/6/**0** | 6/6 | 0.51 |
| row mean removed | 62 | -9.1 | -11.5 | -10.7 | 5/6/5 | 1/6 | 0.39 |
| row mean + SVD k1 | 66 | -17.0 | -13.8 | -9.4 | 6/6/5 | 6/6 | 0.49 |

  With SVD off the rows look ALIKE for the wrong reason: every row is the same rig band.
  **Use SVD k1 with Hanning** -- the brightest pixel is then a target in every row. k2/k3
  eat the 54 cm target (k3 removes it in all six rows), the same over-filtering first seen
  on sartt.json. No usable setting removes the 37 cm rig band, which sits below all three
  targets, so **Max Depth ~30 cm** crops it out. The lasting fix is to remove the rig
  echoes at the source (absorber, cable dress) or with a measured rig reference.
- **The gaps in rows 0 and 2 are a FROZEN rover position, not lost sweeps.** Every row got
  283-294 sweeps over ~9 s with no timestamp hole (largest ~80 ms). Instead each big gap sits
  right after an overloaded cell in the direction of travel -- row 0 (R->L) columns 106-110
  hold 68 sweeps (~2 s) before the empty 73-105; row 2 (R->L) columns 75-76 hold 44 (~1.3 s)
  before the empty 55-74; smaller cases in rows 3 and 4 -- and the overloaded cells' sweep
  time spans match the time needed to cross each gap at 7.5 cm/s, with their assigned
  positions spread LESS than a normal cell's. So the reported position stopped advancing
  while the gantry kept moving: every sweep in that window was filed under the last column
  before the freeze, and the columns driven over stayed empty. Not yet traced to whether the
  rover status stream stalled or repeated a stale position (both lead here). A raster should
  reject sweeps assigned while the position track is flat and the gantry is commanded to move.

## Blind detection on the 2026-09-13 evening set: 3rods / 2pipes / 1pipe / 2pipeasagain / 4pipes (2026-09-14)

Five 6x140 rover C-scans plus `empty gw.json`, an EMPTY-WALL control of the same bench
(all in the operator's Downloads, all gap-free, standoff 30-72 mm, corrected offsets).
Same per-row SAR pipeline as 2rods1pipe (Hanning, rank-1 SVD, er 5.4, wall 15.2,
layered, Auto standoff) scored blind. Positions are scan-relative cm from column 0;
ground truth NOT yet given.

| scan | confirmed-grade targets (x cm, depth cm, dB over median, rows) | probable | unresolved |
|---|---|---|---|
| 4pipes | 18.5 (17), 33.0 (19.5), 36.5 (17), 58.5 (17) -- 10.6/10.9/11.4/9.0 dB, 6/6 rows | -- | ~3 cm start feature |
| 3rods | 11.5 (17.5) 10.4 dB, 55.0 (17.5) 10.6 dB, 6/6 | -- | ~4 cm start feature |
| 2pipes | 57.5 (17.5-18) 8.8 dB, 6/6 | -- | ~3.5 cm start feature |
| 2pipeasagain | 17.5 (17.5) 11.9 dB, 6/6 | 36 (16.5) 7.7 dB, 5/6 | ~3 cm start feature |
| 1pipe | -- | 35.5 (16) 6.8 dB, 5/6 | ~3.5 cm start feature |

- **"Confirmed-grade"** = passes all six tests (>=4 rows above +6 dB, guarded fit agrees,
  low and high band halves agree, both end-trims agree, absent from the empty scan) with
  lateral prominence >= 8 dB over +-4..12 cm neighbours at its depth. **"Probable"** fails
  only the half-band tests, which halve the SNR -- the same 36 cm spot is confirmed-grade
  at 11.4 dB in 4pipes, so it is a real place a pipe was put and a weak target there is
  plausible. The filename counts are matched exactly IF the start feature is a target in
  3rods and 2pipes only, which the data cannot decide (see below).
- **A feature at x 3-4 cm, depth 14.5-15, 7-9 dB, appears in ALL FIVE target scans and in
  none of the empty scan's rows at that depth.** Prominence only 2-6 dB, half-band tests
  mostly fail, and the aperture is truncated there, so it cannot be told from a
  start-of-row artefact. **Overscan 15-20 cm past both ends**; a target placed at x < 5 cm
  is unresolvable by construction.
- **The empty control is load-bearing.** Its end-of-row feature (x 66.5, depth 14.5,
  11 dB, 6/6 rows) passes every one of the other six tests. Only the control rejects it.
  Any deployed detector needs either an empty-wall reference of the bench or a hard
  exclusion of the last ~5 cm of a row.
- **Depth-band choice matters.** Searching 12-40 cm pulls in the full-width bands (the
  27 cm behind-wall reflector and the 37 cm rig echo, both present in every scan
  including the empty one); a compact target has prominence >= 8 dB over its lateral
  neighbours at the same depth, a band ~0-4. Search 12-26 cm for targets against this
  wall, and always report lateral prominence beside amplitude.
- Scripts: scratchpad `multi.mjs` (runs the shipped worker per row over pre x band x trim)
  and `detect.py` (scoring). Throwaway; the rules above are the deliverable.

### Ground truth for that set (operator, 2026-09-14): every filename overstates the count by one

True positions: 4pipes 17 / 32 / 58; 3rods 12 / 54; 2pipes 54; 2pipeasagain 17;
**1pipe has NO target** (a second empty control, taken among the target scans).

- **Recall 7/7.** Errors +1.5, +1, +0.5, -0.5, +1, +3.5, +0.5 cm: a consistent **+1 cm bias**
  (every scan's rows agree with each other to 0.5 cm, so it is not a snake/latency
  zigzag -- most likely the column-0 origin vs where the tape was zeroed) and one
  **+3.5 cm miss, 2pipes' 54 cm pipe imaged at 56.5-57 in all five rows that see it**. The
  same pipe position imaged at 55 in 3rods and 58.5 in 4pipes (truth 54 and 58), so the
  2pipes error is specific to that scan and unexplained -- check that scan's origin.
- **Start-of-row features (3-4 cm) were correctly held as unresolved: none was a target.**
- **One false positive, at x ~36 cm, confirmed-grade in 4pipes (11.4 dB, 6/6 rows,
  passed all six tests), probable in 2pipeasagain and 1pipe.** It is a REAL reflector,
  not processing: absent (<= 4.3 dB) from 3rods, 2pipes and `empty gw`, present in the
  three scans taken last (19:28-19:34). Something entered the scene at x ~36 between
  19:27 and 19:28 -- and in 4pipes it split rows 3-5 toward 33 cm, merging with the true
  32 cm pipe. Operator to say what it was.
- **Lesson for the pipeline: the empty control must be from the SAME session and setup.**
  `empty gw` (recorded 15:48, 3.5 h earlier, at 56 mm standoff vs 45 mm) did not
  contain the 36 cm reflector; `1pipe`, taken among the target scans, does, and using it as the
  control would have removed all three false positives. Take an empty scan immediately
  before and after a target session, and diff against the nearest one in time.

## SAR panel target detection: markers, six tests, empty reference, ends toggle (2026-09-14)

Shipped from the pipeline validated on the labelled bench sets. Files:
`lib/sarReconstruct.js` (the reconstruction, split out of `sar.worker.js` -- verified
identical image, coherence and every scalar on 4pipes row 2; the worker is now a thin
wrapper), `lib/sarDetect.js` (pure detector), `lib/sarDetect.worker.js`,
`hooks/useSarDetect.js`, plus wiring in App / Sidebar / Viewport / SarPanel / SarDisplay.

**How it runs.** On every scan or geometry change (800 ms debounce) the detect worker
takes the WHOLE scan -- all rows, RAW h_cal, independent of the display's SVD / window /
BG toggles -- and reconstructs each row six ways with a FIXED chain (rank-1 complex SVD,
Hanning, coherent, layered ray, Auto standoff, εr / wall thickness from the panel). The
six variants are the six tests; see the header of `sarDetect.js` for their definitions
and the three gates (prominence, edge, reference). Search depth band = **5-20 cm below the
wall face** (`searchMinDepthCm` / `searchMaxDepthCm`, since 2026-09-14; was wall thickness
-3 .. +11 cm -- see "Seepage test" below for what the change cost). ~1.1 s for a 6-row scan in the browser since 2026-09-14 (was ~7 s); see
"Detection speed" below. The panel shows progress.

**Ratings.** confirmed = 6/6 tests and >= 8 dB prominence; probable = >= 4/6 including
the row-support test and >= 4 dB, dropped if within 6 cm of a stronger confirmed
(Hanning sidelobe); reference = a line of the loaded empty scan is assigned to it
one-to-one (see "line search" below); unresolved = inside `endExcludeCm` (6) of
either scan end, applied only while Handle ends is on (`effectiveRating`, so the toggle
costs no recompute). Rows test needs >= 60% of rows (1 for a single-row scan, where
probable ratings are weaker and the panel says so).

**Markers.** One per rated target on every pane, at the ACTIVE ROW's own peak when that
row saw it (full opacity) else at the cross-row consensus (faint). The ellipse's diameter
is the target's measured -6 dB width in BOTH axes, so it is to scale on the image (floor
6 px); `sizeEstCm` deconvolves the ~3.2 cm resolution and floors at 1 cm -- approximate,
shown as "est." only. Green solid = confirmed, amber dashed = probable, grey dotted =
unresolved, faint grey = reference-matched (no label). Labels stagger below the circle
for a neighbour closer than 10 cm. End zones are hatched when Handle ends is on.

**Empty reference.** `Load empty reference` takes a C-scan export (any version with
`data`), held in App state for the session only (not persisted, not exported). Its rows
go through the base variant and its peaks veto candidates. It MUST be from the same
session and setup: `empty gw` (3.5 h earlier, different standoff) missed the crevice
that `1pipe` (taken among the target scans) catches. Ends handling adds nothing to the
raster automatically -- the operator overscans.

**Verified.** Node harness on the labelled sets through the shipped `runDetection`:
11/11 targets (4pipes 18.5/33/58.5, 3rods 11.5/55, 2pipes 57, 2pipeasagain 17.5,
2rods1pipe 12(probable)/20/54, rod1 14.5) against truth 17/32/58, 12/54, 54, 17,
12/20.5/54, 15; 2 false positives -- the crevice in `1pipe` when it is not its own
reference, and one probable sidelobe in single-row rod1. Then the BUILT app driven in
headless Chrome over CDP (scratchpad `ui_drive.mjs`: opens the SAR panel by the button's
title, imports 4pipes through the panel's own Import button by parking the app's
on-the-fly file input in the DOM, loads 1pipe as the reference, toggles Handle ends,
reads the Detection section back, counts marker pixels, screenshots): 4 confirmed
without a reference, **3 confirmed with it and "3 features matched the empty
reference"**, green marker pixels on both panes, no console errors. Note `innerText`
returns headings CSS-uppercased. Not run on the dev server; `vite build` passes.

**Known limits.** Positions read ~+1 cm high (origin, not processing). The 36 cm crevice
in the gw2 wall reads 6-11 dB and is confirmed-grade without a reference. Detection
re-runs from scratch on any εr / thickness / standoff change. No per-row detection for a
row that has fewer than 2 cells.

## SAR panel 3D view: wall digital twin (2026-09-14)

A `3D view` toggle in the SAR viewport's footer, beside the row arrows, OFF by default
(Viewport-local state; the footer now shows whenever there is an image or a detection,
and the row arrows are disabled while 3D is on because the twin uses every row).
`components/SarWall3D.jsx` is lazy-loaded (`React.lazy`), so three.js (already a
dependency, used by ImuDisplay) is a separate 28 kB chunk fetched only on first open.

- **Model (`lib/wallTwin.js`, pure).** Cuboid = the scanned patch to scale in cm:
  width = scan columns x hStep, height = scanned rows x vStep (from `bscanParams.vStep`),
  thickness = the wall thickness the detection ran with (`detection.wallThicknessCm`,
  added to `runDetection`'s result). Front face = operator side. One cylinder per
  CONFIRMED target (a "confirmed only / showing probable too" button adds probables),
  spanning the scanned height. Diameter = the deconvolved size estimate bounded by the
  measured width, floored at 1.5 cm -- approximate, the ~3.2 cm resolution limits it.
- **Pipes need not be vertical.** x(height) and depth(height) are fitted by power-weighted
  least squares over the rows that saw the target. A lean is kept only when the change
  across the scanned height exceeds `TILT_MIN_CHANGE_CM` = 3.2 cm (the chain's lateral
  resolution) AND 3 standard errors of the slope. The first version used 1 cm / 2x
  residual and gave the STRAIGHT bench pipes 11-18 degree leans: over 5 cm of height the
  per-row peaks drift 1.4-1.9 cm (half-pixel quantisation and the offset between rows
  driven in opposite directions). With the resolution floor the bench scans render
  vertical, a synthetic 4 cm lean is kept (38.7 deg), and the view states the smallest
  measurable lean (`atan(3.2 / height)`, 28 deg on a 6 cm-tall scan) -- scan taller to
  measure leans.
- **View.** OrbitControls about the cuboid centre, left-drag rotates, wheel zooms, pan
  OFF. Translucent wall with edges, scanned rows as faint lines on the front face, 10 cm
  ticks, pipe labels, and an overlay with the patch dimensions plus a list (position, depth, "behind
  wall", diameter, lean, rows seen). Renderer and controls live for the component's
  lifetime; scene content is rebuilt when the twin changes. DPR and rAF come from the
  host element's own window.
- **Verified** in headless Chrome over CDP on the built app (scratchpad `ui3d.mjs`, needs
  `--use-angle=swiftshader --enable-unsafe-swiftshader` for WebGL): 4pipes + 1pipe
  reference -> toggle -> WebGL canvas, overlay 70.0 x 6.0 x 15.2 cm with pipes 18.4 /
  33.0 / 58.4 cm vertical; real CDP mouse drag and wheel both change the rendered frame
  (screenshot hash, since WebGL canvases cannot be read with getImageData); toggling back
  restores the SAR image; no console errors.

## SAR detection: line (Hough) search, so slanted pipes are found (2026-09-14)

The detector used to average each column across rows, which only finds VERTICAL pipes: a
pipe leaning 20 cm over a tall scan smears across columns. `sarDetect.js` now keeps each
row's own peak profile and scores every straight line through the rows, a position at
mid-height plus a slope, by mean linear power along it (`houghLines`). Slope 0 scores
exactly what the column average did, so vertical pipes behave as before. Slopes run to
`maxLeanDeg` 45 in steps of half a pixel of drift across the scan. Each target carries
`slope`, `driftCm`, `leanDeg`, `xBottom`, `xTop`, and per-row `xPred` (where the line
crosses that row). App passes `vStep`; SarDisplay puts an unseen row's marker at `xPred`;
the panel card shows a lean only when the drift exceeds 3.2 cm (the lateral resolution).

- **Lines are compared by MEAN LATERAL DISTANCE over the rows**, everywhere: merging
  (`nmsXCm` 3.2), the six tests (`lineMatchCm` 2), the reference and sidelobe removal. The
  first version compared mid-height x plus drift, and steep lines threading from a pipe to
  a feature 3-4 cm away escaped every check on the 5 cm-tall bench scans (FP 2 -> 5).
- **A slanted line needs +2 dB prominence to rate probable** (`slantedExtraProminenceDb`).
  Searching many slopes lets a line thread clutter by chance; those scored 4-5 dB, real
  slanted pipes 10-18.
- **The empty reference is matched ONE-TO-ONE**, cheapest first by
  `(distance/refMatchCm)^2 + (depth diff/refMatchDepthCm)^2`, with `refMatchCm` 2.5,
  `refMatchDepthCm` 3, `refMatchMarginDb` 5.5. Independent per-line matching broke on a
  tall slanted scan: a weak empty-scan line 4.0 cm shallower vetoed the real 33 cm pipe
  while the crevice's own line escaped by 0.1 cm. One-to-one lets the crevice line take
  the crevice's reference. Chosen from a 648-rule grid re-rated offline from cached
  results, then the neighbourhood checked: 35 of 60 nearby settings keep every target
  (independent matching: 20). Its edges are a 7 dB margin (vetoes the 18.5 cm pipe, which
  reads 6.3 dB above a weak empty line; the crevice reads 4.5-4.7 dB above its own) and a
  4 cm depth tolerance. These thresholds are tuned on ONE bench -- re-check on another wall.

**Verified** through the shipped `runDetection`: bench 11/11 targets, 2 false positives
(both in `1pipe`, which is the empty scan and has no reference to veto them). Tall
synthetic test (no tall scan of a slanted pipe exists yet): 30 rows 2 cm apart, each a
real 4pipes row sheared laterally, with the 1pipe reference sheared the same way. All
three pipes found with the right drift at 0, 6, 12 and 20 cm of drift over 58 cm, no
extras; the old column detector fell to 0/3 at 20 cm. The built app in headless Chrome
(scratchpad `ui_drive.mjs`): 4pipes + 1pipe reference -> 3 confirmed, 4 features matched
the reference, marker pixels on both panes. ~5.7 s for a 6-row scan, ~28 s for 30 rows.
**Not yet run on a real tall scan of a leaning pipe** -- that is the test that matters.

## Detection speed: worker pool, shared ray tables, cached reference (2026-09-14)

**Why it was slow.** Profiled on 4pipes + 1pipe reference: detection did 42 SAR
reconstructions (6 rows x 6 variants + 6 reference rows), each the same ~150 ms as the one
image the panel shows, one after another in one worker. Reconstruction was 97% of the time
(back-projection 66%, layered ray tables 30%); resampling, the clutter fit, the line search
and scoring together were 3%.

**Three changes, all bit-identical in output** (every bench scan's full detection result,
the tall synthetic scan, and `reconstruct()` across eight configurations -- SVD on/off,
straight/layered, incoherent, gaps, duplicate columns, missing and manual standoff --
compared by JSON against the pre-change code):

1. **Worker pool.** `sarDetect.worker.js` is now a coordinator: `planDetection` ->
   one task per row to a pool of `sarDetectRow.worker.js` (`reconstructRowVariants`) ->
   `finishDetection`. Pool = min(tasks, hardwareConcurrency - 1, `MAX_WORKERS` 12). A row
   worker failing or not starting falls back to `runDetection` in the coordinator. Nested
   `?worker` imports work under both `vite build` and the dev server (checked in headless
   Chrome on both). The coordinator and its pool are still terminated and respawned on
   every detection, which is how a stale run is cancelled; that respawn is most of the
   ~0.4 s gap between the browser and a warm Node pool.
2. **Shared ray tables.** `sarReconstruct.js` is split into `prepare` / `backProject` /
   `finalizeCoherent` / `toResult`; `reconstruct()` composes them for one image and
   `reconstructMany()` back-projects several together, walking grid columns so a
   (column, depth) ray table is built once for every variant holding that column. Tables
   are shared only on EXACT standoff/depth/thickness/index equality and each variant adds
   its contributions in the same order, which is why it is bit-identical. A single
   reconstruction keeps array order, so the panel image is unchanged. Alternative
   rejected: caching tables instead costs ~55 MB per row per worker.
3. **Cached empty reference.** The worker returns the reference's lines with
   `emptyReferenceKey(plan)` (panel params, detector options, target grid and sweep plan);
   `useSarDetect` keeps them for the same empty-scan object and sends them back, and the
   worker skips the reference rows when the key matches. Verified hitting in the browser
   when importing another scan with the reference kept.

| | before | after |
|---|---|---|
| Node, 4pipes + ref, one thread | 5.83 s | 3.83 s (shared tables, x1.5) |
| Node, 4pipes + ref, 8-worker pool (warm / + cached ref) | | 0.77 / 0.68 s (x7.6 / x8.6) |
| Node, 30-row tall scan + ref, one thread | 28.5 s | 18.6 s (x1.5) |
| Node, 30-row, pool of 4 / 8 / 12 / 16 | | 7.6 / 5.3 / 4.6 / 4.1 s |
| Node, 30-row, 8 workers + cached ref | | 4.1 s (x7.0) |
| Browser build, import 4pipes / load ref / import 3rods / 4pipes again | 7.1 / 8.0 / 9.0 / 9.9 s | 1.5 / 1.2 / 1.2 / 1.9 s |
| Browser dev server, same steps | | 1.1 / 1.2 / 1.2 / 1.1 s |

Browser figures time "Detecting..." on screen (scratchpad `ui_timing.mjs`), excluding the
800 ms debounce; the laptop is a 24-thread i7-14650HX. **The reference cache saves little
wall time on a 6-row scan** -- with 12 workers the reference rows already run beside the
target rows -- and matters once rows outnumber workers (30 rows: 5.3 -> 4.1 s). Each
detection logs `[sar-detect] {"ms","workers","referenceCached"}` at console debug level.

Not done, from the same profile: reconstructing only the depths detection reads (38% of
depth rows are shallower than the search band; changes normalisation slightly, needs the
bench regression re-run), a persistent coordinator (saves the per-run respawn), per-row
caching during a live raster, and progressive results.

## Seepage test: water in a brick joint, and why the detector misses it (2026-09-14)

Operator's `Desktop/seepage test/`: `empty.json` (bare wall) and `seepage.json` (water between
bricks at x ~37 cm, 5-12 cm deep), both 140 x 10 rover rasters, 0.5 cm columns, 1 cm rows,
17 min apart, standoff 37-43 mm. Analysed offline with the shipped detector and
`sarReconstruct.js` (scratchpad `seep_*.mjs`). Ground truth is the operator's description.

- **The empty scan's "confirmed" (x 32, 15.8 cm deep, 10/10 rows, 6/6 tests) is a real fixed
  reflector at the back face.** It is in the seepage scan too (x 31, probable). Loading the
  empty scan as the reference removes it; nothing in a single scan can.
- **The seepage scan's probable at x 36, 16.9 cm is the back face behind the wet joint, not
  the water.** Raw back-face echo (display range 36-44 cm), seepage / empty at the same cell,
  is weakest at x 40-41.5 in rows 0-8: -7.1 to -3.3 dB against the row median, fading up the
  wall (bottom row -5.2 dB, top row -0.4 dB) -- water absorbs, and it pools low.
- **The water itself shows inside the wall where it should,** in the detector's SAR chain
  (SVD k1, Hanning, layered, er 5.4, wall 15.2): in 9 of 10 seepage rows the strongest spot
  in x 33-41 sits at x 33.7-35, ~9 cm deep (rows 4-8) or ~5 cm (rows 1-3), +4 dB amplitude /
  +8 dB amplitude x coherence over the row; the empty scan has nothing there (+0.5 dB). In a
  3-10.5 cm, x 8-62 window the row's top in-wall amplitude peak is at x 33-38 in 7/10
  seepage rows and 0/10 empty rows (empty's tops sit at x 16-17 and 8, ~9 cm deep).
- **The detector cannot see it by design**: the search band is wall thickness -3 to +11 cm
  (12.2-26.2 here), built for pipes behind the wall.
- **Moving the band inside the wall is NOT a fix.** With `depthAboveWallCm: 12,
  depthBelowWallCm: -3.2` the empty scan gets a confirmed at x 29.5, 12.0 cm (the back-face
  reflector leaking up to the band edge) and probables near the row start; the seepage run's
  scores blow up to ~150 dB. Cause: in-wall pixels mostly have debiased coherence exactly 0,
  so `gridWeight`'s median normaliser is ~0. The same trap hit ad-hoc contrast scripts that
  normalised by a median of amp x coh or of a mostly-empty band.
- **"The concrete looks uniformly dark" is mostly coherence clamped to 0**, not flat
  amplitude: in-wall amplitude varies ~+-5 dB along the empty scan. The rig echo at 27 cm of
  range lands ~9-10 cm deep, exactly the seepage depth; SVD removes it along the row but its
  residual shows at the row ends (x ~6, ~9.4 cm deep, in both scans).
- **Registration:** rover x of column 0 differs by 20.6 mm between the scans, yet wall features
  sit at the same grid columns (reflector 32 vs 31; along-track residual correlates best at
  lag 0) -- the origin was re-declared. Match on grid column. Raw pass-to-pass subtraction
  gives only 12.6 dB (per-cell standoff differs by sd 3.3 mm) and is dominated by the face
  echo, so it is not a usable in-wall detector; compare in the SAR domain instead.

What an in-wall mode would need (not built): a band that stops ~4-5 cm above the back face,
ends excluded by ~8 cm, amplitude or zero-aware normalisation, a same-session empty reference,
and the back-face shadow directly behind as a corroborating test.

### Band set to 5-20 cm (operator, 2026-09-14): what it cost, and the zero-coherence normaliser

Detection band is now a fixed 5-20 cm and the SAR panel's Max Depth defaults to 20. Scored with
the harness (bench truth, the seepage pair, the 30-row tall synthetic at 20 cm drift):

| | bench FP (11/11 found) | tall scan | seepage in-wall |
|---|---|---|---|
| old band 12.2-26.2, median of all pixels | 2 | 3/3, no extras | out of band |
| **5-20, median of all pixels (shipped)** | **6** | **33 cm MISSED**, 3 extras | not flagged |
| 5-20, median of NON-ZERO pixels (scratch only) | 2 | 3/3, 1 extra | not flagged |
| old band, median of non-zero pixels (scratch only) | 2 (but 3rods 12 cm missed) | 3/3 | out of band |

**Why the wider band broke the reference matching: normalisation, not geometry.** `gridWeight`
divides each scan's amplitude x coherence by its own median over depths >= band start, and
debiased coherence is exactly 0 on many pixels -- by depth, 4pipes 65% (0-5 cm) / 44% (5-12) /
22% (12-20) / 35% (20-26); seepage 70 / 66 / 15 / 17%. Starting the band at 5 cm pulls those
zeros in, the median drops, and every score rises -- by a DIFFERENT amount in the target and
the reference scan. On 4pipes the crevice line went 13.4 -> 16.8 dB but its reference line only
8.8 -> 11.2, so the gap grew 4.6 -> 5.6 dB, past `refMatchMarginDb` 5.5: the crevice escaped and
became a probable. On the tall scan the crevice's reference line, now unclaimed by the crevice,
was assigned to the real 33 cm pipe (dz exactly 3.0) and vetoed it.

**The blow-up point is 50% zeros**, where the median itself becomes 0. The whole 0-26 cm image
is ~33% zeros, so 5-20 survives; an in-wall-only normaliser (3.2-18 cm) crossed it and scored
~150 dB. Median of the NON-ZERO pixels makes the normaliser independent of how many pixels
failed the coherence test, which is what restored the table above; it was not shipped because
it also moved the old-band result (3rods 12 cm became reference-matched), so it needs the same
robustness check the reference rules had before it replaces the current normaliser.

**The 5-20 band still does not detect the seepage**, because each row's profile is the MAX over
the band and the back-face echoes (13-20 cm) are ~20 dB stronger than the water at 5-10 cm.

### Non-zero median SHIPPED (2026-09-14), after a neighbourhood test

`gridWeight` now normalises by the median of the non-zero pixels. Both normalisers were cached
over bench, the tall synthetic at 0/6/12/20 cm drift and the seepage pair, then re-rated at the
shipped thresholds and over 243 neighbouring settings (ref tol 2-3, depth tol 2.5-3.5, margin
4.5-6.5, confirmed prominence 7-9, probable 3-5):

| | all-pixel median | **non-zero median** |
|---|---|---|
| shipped thresholds: bench | 11/11, 6 FP | **11/11, 2 FP** (1pipe 35.5, 2rods1pipe 35.5, both without a reference) |
| shipped thresholds: tall, 4 drifts | 11/12, 6 extras | **12/12, 1 extra** |
| settings finding all 23 targets with bench FP <= 2 and tall extras <= 1 | 0 of 243 | **27 of 243** |
| median over the 243: bench FP / tall extras | 6 / 4 | **2 / 2** |
| worst over the 243: bench missed / tall missed | 2 / 4 | **1 / 2** |

Only cost seen: the seepage scan with its empty reference now rates one probable (x 61.5).
The scratch variant differed from the shipped file by that one line.

### Seepage is not a point target: it loses to aperture, a pipe gains from it

Operator's observation: seepage spots are visible with amp x coherence OFF and absent from the
empty scan; hypothesis: water in concrete is a volumetric blob, not a coherent point or line.

- **The amplitude rise only shows with clutter removal on.** Detection chain (SVD k1, Hanning):
  a +3 dB region of 18.5 cm2 at x 37-40, 3-10.5 cm deep, peak +7.7 dB over the empty scan;
  x 32-40 is +2.6 dB mean (5/10 rows > +3) while controls at x 12-20 and 46-54 read -2.3 and
  -3.0. With the PANEL DEFAULTS (SVD off, rectangular) the same place is -1 to -2 dB -- the
  rig echo and face coupling dominate the in-wall amplitude.
- **Its coherence is low**: 0.09 at the brightest pixel against 0.32-0.37 for the 4pipes pipes
  in the same chain, and 36% of its pixels are exactly 0. amp x coherence costs it ~12 dB
  relative to a pipe.
- **Aperture test** (full-row complex mean removed, then only cells within a window
  reconstructed, SVD off; median over rows of the brightest pixel, dB over the empty scan at
  the same window):

  | aperture | 4 cm | 8 cm | 16 cm | full row |
  |---|---|---|---|---|
  | seepage x 38, 4-11 cm | +10.4 | +7.6 | +5.7 | +4.9 |
  | pipe 18.5 cm | +0.2 | +1.5 | +4.5 | +6.0 |
  | pipe 58.5 cm | -1.6 | -0.6 | +1.1 | +3.1 |

  A compact scatterer gains as positions focus onto it; the water is strongest seen from
  directly above and is diluted by wide angles (specular or diffuse, not point-like).
  **Coherence itself does NOT separate them**: debiased coherence is 0.87-0.99 for every case
  at 4-8 cm, including the empty wall (little chance correction with ~9-17 contributions), and
  0.07-0.17 for every case over the full row. Use the aperture dependence of amplitude, not
  coherence.

Implication for an in-wall detector (not built): short-aperture or unfocused amplitude against
a same-session empty reference, a 2-D blob rather than a line across rows, no coherence
weighting.

### In-wall patch prototype (offline, 2026-09-14): finds the seepage, not yet trustworthy

Scratchpad `inwall_proto.mjs` / `inwall_lib.mjs` / `inwall_proto2.mjs`. Nothing in the app uses it.

**Signal.** Per row, subtract the row's complex mean from `h_cal` (removes face, rig echoes,
anything constant along the row). Per cell, Hanning matched filter straight down at apparent
range `standoff + sqrt(er) * z` for z = 2-14 cm, the cell's own standoff (row median if null).
Power smoothed +-1 cm in x and +-0.5 cm in z. No aperture, no coherence.

**What did NOT work: per-cell dB against the empty pass.** Pass-to-pass noise is too large for
a signal this weak (the raw passes suppress each other by only 12.6 dB; per-cell standoff sd
3.3 mm). Seepage vs empty did give a patch centred ~40 cm, but SWAPPED (empty vs seepage) gave
patches just as strong (+17.8 dB), and 4pipes / 3rods / 2pipes vs 1pipe gave +9 to +25 dB
patches, none of them real.

**What did: patches found in each scan on its own, vetoed by the empty scan's own map.** Score
= dB over the median of the same (row, depth) across the row; column score = max over 3-12 cm;
patch = 8-connected cells above threshold spanning >= 3 rows and >= 2 cm, x 8-62 cm. A patch is
cancelled when the empty scan's own map is also >= (threshold - 3) on most of its cells.

| pair | patches at +5 / +6 / +7 dB that survive the veto |
|---|---|
| **seepage vs empty** | **x 36.6-36.8, ~9 cm deep, rows 0-4 (0-6 at +5) -- the seepage**; x 18 and x 60 cancelled (93-100% of cells also bright in empty) |
| empty vs seepage (swapped) | none (all cancelled) |
| 4pipes, 2pipes, 2pipeasagain vs 1pipe; 1pipe vs 4pipes | none |
| **3rods vs 1pipe** | **x ~28, 5.5-8.5 cm -- unexplained, 0% bright in 1pipe** |
| **2rods1pipe vs 1pipe (other session)** | **x ~27, 10.5 cm -- unexplained, 0% bright in 1pipe** |

The seepage patch's empty-scan cells are 26-33% bright; the fixed wall features 72-100%, so
the veto separates them at all three thresholds. Both false alarms are the two ROD scans at
x ~27-28 -- ask the operator what was there. Back-face shadow (target / reference back-face
echo over the patch's columns, vs the scan's median ratio): seepage -1.1 / -1.8 / -2.3 dB,
false alarms -0.2 / -0.1 / -0.9 (3rods) and +0.6 / +0.7 / +0.7 (2rods1pipe) -- separates them,
but by as little as 0.2 dB. One real target, so every threshold here is a fit, not a validation.

### SHIPPED: Pipes / Seepage detection modes in the SAR panel (2026-09-14)

The Detection section has a **Pipes | Seepage** switch (`sarDetectMode` in App.jsx, not
persisted). Pipes is the existing detector, unchanged. Seepage runs `lib/seepageDetect.js`,
the prototype above ported with every threshold named in `SEEPAGE_DEFAULTS`: in-wall band 3 cm
below the face to 3 cm above the back face, +6 dB lateral contrast, >= 3 rows and >= 2 cm,
8 cm ignored at each end, empty-scan veto at >= threshold - 3 dB on >= 50% of the patch.

- **Plumbing.** `useSarDetect(..., mode)` posts the mode; `sarDetect.worker.js` runs seepage in
  its own thread (no pool, no reference cache: 40-440 ms) and clears the other mode's result on a
  switch. The result has `mode: 'seepage'`, `patches`, and `targets: []` so pipe consumers cannot
  crash on it.
- **Ratings.** `moisture` (survived the empty check, shown as "possible moisture"), `reference`
  (the empty scan has it too; hidden, counted), `unverified` (no empty reference loaded; shown
  amber with a warning that fixed wall features look identical).
- **Panel.** Tiles for possible moisture / matched empty, one card per patch: columns, rows
  (numbered iy + 1), depth and its range, dB over the row, the empty scan's bright fraction, and
  the back-face shadow. Handle ends is hidden in seepage mode (the ends are never searched).
- **Image.** `SarDisplay` draws patches as rectangles: the active row's own extent at full
  strength (sky blue = moisture, amber dashed = unverified, grey dotted = reference), a patch not
  on this row faint at its overall extent; dotted lines mark the searched depth band; the
  unsearched ends are hatched (shared `hatchEndZones`).
- **3D view.** `buildWallTwin` returns `moisture` boxes (columns x rows x depth range); `SarWall3D`
  draws them translucent with an outline, label and overlay list, and hides the pipe
  confirmed/probable toggle in seepage mode.
- **Back-face window generalised.** The prototype used display range 0.36-0.44 m (gw2-specific);
  the module centres +-4 cm on `standoff + sqrt(er) * wall thickness` per cell. Shadow values moved
  by <= 0.4 dB (seepage -1.6 vs -1.8 at +6 dB); every patch position, row span, depth, mean dB and
  veto fraction reproduced the prototype exactly on all 11 test pairs at +5/+6/+7 dB.

**Verified in the built app** (headless Chrome, scratchpad `ui_seepage.mjs`): import seepage.json,
load empty.json as reference -> Pipes shows 1 probable (61.5 cm, the known non-zero-median cost)
and 5 reference-matched; Seepage shows **1 possible moisture, 31.5-42.0 cm, rows 1-5, ~9 cm deep
(3.5-10), +7.9 dB, empty bright on 26%, back face -1.6 dB**, 2 matched empty; 1303 patch-outline
pixels drawn; the 3D overlay lists the box; switching back to Pipes restores the pipe result; no
console errors. **Known false alarm:** the rod scans' x ~27-28 cm patch rates "possible moisture"
against 1pipe -- unexplained, ask the operator.

## Continuous raster holes: positions are now timed by the board's clock (2026-09-14)

Reported: continuous C-scans "relatively frequently" leave grid cells empty. Diagnosed
from the per-sweep timestamps in three 2026-09-13 exports (`2rods1pipe.json`,
`empty gw.json`, `rod1.json`: 5 mm pitch, 75-100 mm/s). At 75 mm/s and a 29.8 ms sweep,
sweeps land 2.2 mm apart, so evenly spaced sweeps can never leave a hole -- every empty
cell has a cause. For each hole, the gap between the sweeps on either side of it:

| scan | empty cells | neighbours ONE sweep apart | sweeps missing | row edge |
|---|---|---|---|---|
| 2rods1pipe (6x140) | 90 | 43 | 45 | 2 |
| empty gw (6x140) | 29 | 13 | 16 | 0 |
| rod1 (1x66) | 2 | 2 | 0 | 0 |

**Cause 1, fixed here: positions were timed on ARRIVAL.** The track keyed each position
on `last_status_at`, the Pi's `time.time()` when it processed the board frame. The R4's
WiFi delivers frames late and in bursts, and `board_handler` awaits `_yaw_tick`, `pump`
and `broadcast` (up to 0.5 s per slow client) between frames, so a burst lands with
near-identical stamps and bends the x-vs-time curve. Signatures: two sweeps 30 ms apart
filed on opposite sides of a 5 mm cell (>= 2.2x the commanded speed); and at scale, a
~1.3 s stall piling **43 sweeps into one cell** followed by **30 empty columns** in the
direction of travel (2rods1pipe rows iy=0 and iy=2). Velocity is NOT assumed constant
anywhere -- positions are linearly interpolated between adjacent frames ~50-90 ms apart,
which is fine; the label on each frame was the error.

**Fix.** The board already sends `ms` (the step ISR's tick clock) on every status frame.
`rover_server.py` now forwards it as `board_ms` beside `last_status_at` (kept consistent
as a pair, not cleared on disconnect). `lib/roverTrack.js`:

- `createBoardClock()` fits Pi receipt time against board time over a 30 s window. A
  frame's `recv - board` is the offset PLUS its delay, and delay is never negative, so the
  mapping is the LOWER boundary of those points, not their mean: the lower convex hull
  edge spanning the window's mean time (Moon, Skelly & Towsley 1999 -- the line under
  every point with least total gap). A late frame lies above the hull and changes nothing,
  which is why stalls cannot move it. Fits rate difference too (clamped at 1%, else
  offset-only). NOTE the fitted `skew` is the slope of the offset against board time,
  i.e. `-rate/(1+rate)` for a board clock running fast by `rate`.
- `createTrack()` keys samples on board seconds and converts each sweep's Pi timestamp
  to board time before interpolating. A board clock going backwards (restart, or a u32
  wrap after 49.7 days) clears the track; a re-broadcast of the same frame is a duplicate;
  losing or regaining `board_ms` clears rather than mixing clocks. With no `board_ms` it
  is exactly the old receipt-timed behaviour (checked identical to HEAD).
- Residual: positions land one MINIMUM link delay (a few ms on a LAN, ~0.3 mm at 75 mm/s)
  after truth -- a constant, absorbed by `roverLatencyMs`, which is still unmeasured.
- The row readout in the C-scan panel goes amber with `no board clock: arrival-timed`
  when the fallback is in force, i.e. the Pi or firmware is not sending `board_ms`.

**Verified** (throwaway, scratchpad `track_test.mjs`, shipped file vs `git show HEAD`): a
simulated 140x5 mm row at 75 mm/s with 25 ms mean exponential delay, 1.3 s stalls every
4 s and +0.4% clock skew -- HEAD 38/140 holes, max 44 sweeps/cell, p99 position error
94 mm; new 0 holes, max 3, p99 0.37 mm. Jitter only: HEAD 1 hole / p99 7.6 mm, new 0 /
0.37. 80 ms mean delay, -0.6% skew: HEAD 54 holes, new 0 / p99 0.39 mm. Plus unit checks
(duplicate, restart, timebase switch, exact inversion under constant delay, a 2 s late
frame changing nothing, bounded window) -- 19/19. End to end: `rover_server.py` driven
locally against `rover_sim.py` (signal handlers stubbed for Windows, `--no-persist`)
delivers `board_ms` as strictly increasing ints. `vite build` passes. **Not yet run on
the rig**: confirm the row readout does NOT say `arrival-timed`, then re-scan and check
for holes and 40+ sweep pile-ups.

**Cause 2, NOT fixed: NIOS fallback sweeps.** The other half of the holes are real gaps
in sampling. Sweep intervals show a consistent ~80 ms then ~53 ms pair, 45-52 times per
~1700 sweeps (~3%, double the bench's 1.4%): the failed autonomous capture (~27 ms) plus
the standard sweep that replaces it (~55 ms), then a NIOS sweep that starts with no
pipelined capture because `fallback()` discarded it via `_nios_discard_inflight()`. Each
event is ~133 ms for two sweeps -- ~5.5 mm unsampled at 75 mm/s, one hole at 5 mm pitch.
Options: relaunch the pipelined capture straight after a fallback sweep; find why the rate
doubles during a raster; implement the documented short-lattice front-matter recovery; or
simply scan with more margin (sweeps/cell = pitch / (v * T_sweep); ~4 absorbs one
fallback, e.g. 5 mm at 40 mm/s or 10 mm at 75 mm/s).

## On-FPGA DSP sweep path (`sweep_mode='dsp'`) and the v15 image (merged 2026-09-14)

Squash-merged from `origin/sfcw-dsp-100hz` @ `f36c98b` (Himanshu Singh). The full
commit history -- including the v2..v13 images and the reasoning behind each FPGA
build -- stays on that branch; only **v15** was brought into this repo. The FPGA
source (VHDL, Nios firmware) is NOT in this repo: it lives in `bladerf-src`, branch
`fifo-256` @ `ba105a3c`. `fpga/images/*v15*.PROVENANCE.txt` has the build details.

### What it is

Three sweep cores now exist, selected by `sweep_mode` (default **`nios`**, unchanged):

| core | who retunes | who demodulates and divides | Pi receives | 51-step rate |
|---|---|---|---|---|
| `standard` | Pi, over USB, per step | Pi | raw IQ | ~18 Hz |
| `nios` | Nios firmware, from a primed table | Pi | raw IQ, sliced by the Pi | ~36 Hz |
| `dsp` | FPGA logic (`sweep_stepper`) at an exact 80 MHz tick | FPGA (`rx.vhd`) | one burst of results per sweep | ~100 Hz |

In `dsp` mode, per step, the FPGA discards **FLUSH 512** samples (settling),
averages **ACCUM 1200** samples of both channels (12 whole cycles of the 100 kHz
tone, so LO leakage cancels), divides antenna by reference and writes one 8-byte
result. When the sweep is complete it releases the FIFO and the Pi reads one USB
transfer: `2*num_steps` 32-bit words, the rest of the transfer padded with the
last word repeated. **Dwell 1856 samples per step** (512 + 1200 + 144 guard);
51 x 1856 / 10 MS/s = 9.5 ms of acquisition. The next sweep's EXEC goes out the
moment a burst lands (`DSP_PIPELINE_EXEC`), so the Pi's decode/IFFT/broadcast
overlaps the next sweep rather than adding to it.

- **Step count on v15: 2..255** (`DSP_SWEEP_WORDS = 255`), limited in practice to
  151 by the quick-tune table over 2-5 GHz. Rate scales with it: 151 steps ~36 Hz,
  76 ~71 Hz, 51 ~100 Hz, 26 ~190 Hz, 16 ~280 Hz (v15 provenance; same 5 cm
  resolution). Fewer steps shortens the unambiguous range.
- **`num_steps`** in `sfcw_set_params` (and `pi/radar/set_steps.py N`) asks for a
  count and the engine picks the nearest legal step size. The GUI does not send it,
  and the panel pushes its own step size on every Start, which overrides it.
- **Control-register bit 6** selects the DSP FIFO instead of raw samples on the USB
  pipe (reads back on v10+; `check_bit6.py`). Bits 24:22 / 27:25 select FLUSH/ACCUM
  from tables (`dsp_flush_sel` / `dsp_accum_sel`, defaults 2 / 3). Bit 29 hands the
  AD9361 SPI to the FPGA stepper. Commands: `SWLD` loads the table into the FPGA
  once per prime, `SWEF` runs one sweep with the dwell in ticks.
- **The constant-tail check is the proof the DSP path is live.** A buffer whose
  tail is not constant is raw IQ, i.e. bit 6 did not take effect; `dsp_read_sweep`
  says so by name instead of returning garbage.

### Loading the image -- the power-cycle trap

`bladeRF-cli -l fpga/images/hostedxA9_niosIIf_sweep_dsp_v15_fifo256_signaltap.rbf`
loads v15 into RAM. **The board's SPI flash still holds
`hostedxA9_niosIIf_sweep_ts_v1`**, so a power cycle silently reverts to v1. On v1
`nios` mode still works at ~36 Hz, but `dsp` mode fails every sweep. Run
`python3 pi/radar/check_bit6.py` after any power cycle before using `dsp`.
`-L` would flash v15 and make it persist; not done as of 2026-09-14. Before
flashing, confirm `nios` mode on v15 too, since flashing removes v1 from the board.

v15 is a SignalTap build (`_signaltap`, with its `.stp` and `.sof`). SignalTap is an
on-chip logic analyser read over JTAG; with no JTAG cable it is idle and does not
affect the data. Removing it means a rebuild in `bladerf-src` and re-validating.

### What `dsp` mode does NOT have

- **No ADC headroom.** `adc_peak` is measured from raw samples and there are none,
  so `_warn_if_adc_hot` never fires and the SFCW panel's headroom bars are absent
  (the panel says so). **Set and check gains in `nios` mode first**, then switch.
- **`settle_count` and `num_buffers` are ignored**; settling and averaging are the
  FPGA's FLUSH/ACCUM counts.
- **No raw IQ**, so `SFCW_DIAG`, `nios_diag` and `measure_settle.py`-style analysis
  need `nios` mode.
- **No graceful fallback.** A failed read cannot fall back to a real sweep (there is
  no raw stream), so the Pi sends an **all-zero sweep tagged `sweep_core:
  'fallback'`** to keep its cadence, and logs the reason every 30 s. A missed burst
  toggles bit 6 to clear the FIFO; five in a row rebuild the RX stream (~1 s).

### Empty sweeps are dropped on the groundstation (2026-09-14)

`App.jsx`'s `sfcw_result` handler drops a result whose `sweep_core` is `'fallback'`
AND whose `h_cal_real`/`h_cal_imag` are all exactly zero, before the display, every
capture path (C-scan, BG capture, BG model, SAR input) and the lidar pairing.
Recorded, such a sweep is a cell of pure zeros that looks like a measurement. The
count for the run shows as an amber banner in the SFCW panel under the Range Offset
field, reset when a sweep starts. A `'fallback'` in `nios` mode is a real standard sweep
with non-zero data and is kept. Not run against a live DSP failure: `vite build`
passes.

### Known hazards, from reading the code (not reproduced on hardware)

- **An EXEC rejected in `dsp` mode can hang the sweep loop.** If `SWEF` returns
  non-zero or the sample counter does not advance, `_sweep_core_dsp` sets
  `_nios_unavailable`, and `_sweep_dispatch` then routes every sweep to the
  `standard` core -- but `_start_tx_rx` opened no raw RX stream in `dsp` mode, so it
  waits ~1.3 s per step for buffers that never arrive. Recover with
  `set_sweep_mode.py nios` and restart the sweep. Not fixed.
- **Stale Python bindings on the Pi.** The installed `bladerf` binding's sample
  format enum is missing `SC16_Q11_META`, so every later member is numbered wrong.
  `bladerf_driver.fmt()` resolves formats by name and substitutes the canonical
  values, printing a warning at import. The real fix is installing the bindings
  from `bladerf-src/host/libraries/libbladeRF_bindings/python`. `diag_formats.py`
  prints the mismatch.
- **TX and RX must agree on timestamps** (one global GPIO bit in libbladeRF). `dsp`
  RX is plain `SC16_Q11`, so TX is started plain too. A leftover timestamped TX once
  made every sweep fail within 3 ms.
- Comments in `sfcw_engine.py` quote 10.24 MS/s; the radio runs at 10.00 MS/s.
  The tick arithmetic reads the real rate, so only the comments are off.

### Tools (all in `pi/radar/`)

`set_sweep_mode.py [dsp|nios|standard]` (sets only; restart the sweep from the GUI),
`check_bit6.py` (which image is loaded; services stopped), `test_dsp_path.py`
(end-to-end pass/fail through sdr_server), `set_steps.py N`, `diag_formats.py`,
`measure_settle.py` (raw `nios` sweep, services stopped), `benchmark_sweep.py --mode
dsp --flush N --accum N --dwell N`. The coherence test is now 100 sweeps and reports
S_repeat and minimum correlation, skipping fallback sweeps. `start.py` runs the
services with `python -u` so their output reaches a log as it happens.

## SDR websocket: binary sweep frames, no Pi range profile on the wire (2026-09-15)

At 100 Hz every `sfcw_result` went to the groundstation as ~2.9 KB of JSON, over half of
it the Pi's own range profile (`distances` / `magnitudes`, a Hanning 4x-zero-pad IFFT)
that the groundstation recomputes anyway. The groundstation now receives each sweep as
**one binary frame of ~1.2 KB** (1192 B measured at 51 steps, against 2841 B of JSON).

- **Opt-in per connection.** The groundstation sends `{cmd: 'sfcw_binary', enabled: true}`
  on every (re)connect (`App.jsx` connect effect); the Pi answers `sfcw_binary_ack`.
  Every other client -- `benchmark_sweep`, `capture_bgmodel`, `span_confirm`,
  `test_dsp_path`, any older GUI build -- keeps getting byte-identical JSON. A Pi that
  predates this ignores the command (the dispatch chain has no `else`) and the socket
  decodes JSON too, so neither side depends on the other being updated. Only
  `sfcw_result` changes format; status, progress, coherence and errors stay JSON.
- **Format** (`pi/radar/sfcw_wire.py`): magic `SFR1`, uint32 header length, a compact
  JSON header with every field of the JSON message except `distances`, `magnitudes`,
  `h_cal_real`, `h_cal_imag` (same order) plus `n`, zero padding to 8 bytes, then 2n
  float64 little-endian: h_cal real parts then imaginary parts at FULL precision.
- **Decoder** (`groundstation/frontend/src/lib/sfcwWire.js`, used by `useWebSocket` via
  `options.decodeBinary`, `binaryType = 'arraybuffer'`): rounds h_cal to 8 decimals exactly
  as `np.round` does, so every consumer and export sees the same numbers as before, and
  rebuilds `distances` / `magnitudes` with the Pi's arithmetic **lazily** -- an enumerable,
  assignable getter computed on first read and cached -- so spread, JSON.stringify and
  structuredClone still see them, and a sweep nothing reads them from never pays.
- **Why full precision, not the 8-decimal values:** the Pi computes its profile from the
  unrounded sweep. Rebuilt from the 8-decimal values, 2064 of 214,740 profile values on
  quiet sweeps come out 0.01 dB off, and numpy disagrees with itself by exactly that much.
  So `_process_h_cal` also returns `h_cal_full` (the unrounded complex array), which
  `_sfcw_result_msg` never puts into JSON and `_send_sfcw_result` hands to the encoder.
- **The profile fields are still needed on the groundstation** even though no display
  draws the Pi's profile: the manual C-scan and continuous raster captures copy
  `msg.magnitudes`/`distances` into cell records and exports, `CscanPanel` derives the
  depth-gate bound from them, SAR detection refuses a scan without them, and
  `SfcwDisplay` guards on them. That is why they are rebuilt rather than dropped.
- The server builds each encoding only if some client needs it, so with only the
  groundstation connected the Pi skips `json.dumps` of the full sweep. Dead or slow
  clients are removed from both client sets.

**Verified** (throwaway scripts): the shipped `_process_h_cal` (AST-extracted) and
`_sfcw_result_msg` against the shipped decoder over 1260 sweeps -- 7 step counts (2 to
151), 6 range offsets, all-zero, partly-zero and normal sweeps, nios and dsp tags: every
message `JSON.stringify`-identical including key order, **0 of 214,740 profile values
different**, h_cal bit-identical, the profile lazy until read, correct under spread /
structuredClone / assignment / a later `range_offset` overwrite, junk frames -> null.
The moved dict literal is whitespace-identical to the old inline one. End to end against
the shipped `SDRServer` (hardware stubbed, real `_sfcw_callback` thread handoff, 100 Hz):
binary and JSON clients side by side with 0 mismatches over 200 sweeps, a plain Python
client receiving only JSON with the profile, opt-out returning a socket to JSON, client
sets empty after disconnect, 0 drops. `vite build` passes. **Not run in a browser against
the Pi**: after deploying both sides, check the SFCW rate and a C-scan capture once.

## Handheld + IMU panel: three LiDAR heads and the BNO085 (2026-09-15)

Panel id `handheld`, label "Handheld + IMU" (`HandheldPanel.jsx`, `HandheldReadouts.jsx`,
`lib/handheldPose.js`). **It replaced the IMU panel** (`ImuPanel.jsx` deleted; `ImuDisplay`
lives on in one of its viewport quadrants). The first version's third-angle canvas
(`HandheldDisplay.jsx`) and its trail are gone; the viewport is text only plus the IMU view:
position from origin | IMU orientation / LiDAR table | IMU values.

### Wiring and the standoff head

**Operator-confirmed 2026-09-15: forward = UART2, right = UART3, down = UART1.** Pin table in
CONTEXT.md. Before this date the single standoff head was UART3, which is now the
RIGHT-facing head.

`pi/sensors/stream.py` is the version that was running on the Pi (written there, uncommitted,
copied into the repo 2026-09-15) with one change: `LIDAR_PORTS_DEFAULT` is now
`['/dev/ttyAMA2', '/dev/ttyAMA3', '/dev/ttyAMA1']`. The FIRST port feeds the legacy `lidar`,
`lidar_seq`, `lidar_ts`, `lidar_err` and `lidar_last_good_*` fields, and those are what every
standoff consumer reads: App.jsx `lidarMm` (SFCW/C-scan/BG Model readouts),
`bgContinuous.js`, C-scan `lidar_standoff_mm`, SAR standoff correction,
`capture_bgmodel.py`, and `pi/rover/yaw_control.py` (via `rover_server`). So moving the
primary moved all of them; no consumer names a port. `TFLC02.__init__` and
`lidar_noise_char.py --port` default to `/dev/ttyAMA2` to match. **If the forward head's
mounting changed with the re-wire, re-measure `lidar_antenna_offset_mm` and treat BG models
and Super Fit references captured on the old head as suspect.**

**The Pi must run this repo's `stream.py`.** As of this entry the Pi's copy still has UART3
first. The panel shows the Pi's `lidar_primary` and warns when it differs from the forward
UART selected in Wiring.

The packet is `lidars: {uart1, uart2, uart3}`, each `{port, mm, seq, ts, err, last_good_mm,
last_good_age_s}`, plus `lidar_primary`. `readHandheldLidars` also accepts role keys with a
`port` (an intermediate repo version) and the legacy single-head packet.

### Position

Frame X right, Y UP, Z forward (up positive is the operator's choice). Position = distance at
origin - distance now for X and Z, and the reverse for Y (`sign: -1` in `HANDHELD_AXES`),
because the down-facing head's distance grows going up. Origin is
groundstation-only, per axis (`localStorage.handheld_origin_v2`). "Set origin here" accepts
readings up to `ORIGIN_MAX_AGE_S` 0.25 s old; an axis without one keeps its previous origin.
Wiring selectors (`DEFAULT_ASSIGNMENT`, `localStorage.handheld_lidar_assignment_v2`) clear the
origin when changed. The v2 keys exist because v1 shipped a guessed default with forward and
down swapped. Failed reads carry the last good value for `HANDHELD_CARRY_S` 1 s (amber).

### Update rate and averaging (measured 2026-09-15, 60 s, module still)

| head | new values/s | median interval | noise, no averaging |
|---|---|---|---|
| forward uart2 (~250 mm) | 10.9 | 58 ms | 0.7-0.9 mm |
| down uart1 (~27 mm) | 12.8 | 58 ms | 0.9-1.0 mm |
| right uart3 | 1.3 valid, 92% of packets null | | out of range: aim at something within reach |

Intervals reach 175-260 ms because `seq` only advances when the value changes (or after the
0.25 s republish), so "values/s" undercounts a still target. Time-window mean over the 50 Hz
packets (`createLidarHistory`, groundstation-side), same data:

| window | 0 | 100 ms | 250 ms | 500 ms | 1000 ms |
|---|---|---|---|---|---|
| noise | 0.7-1.0 mm | 0.5-0.75 | ~0.5 | 0.35-0.45 | ~0.3 |
| frame-to-frame p95 | 1-2 mm | 0.4-0.6 | ~0.2 | ~0.1 | ~0.05 |
| lag | 0 | 50 ms | 125 ms | 250 ms | 500 ms |

**The TF-LC02 cannot be made to measure faster (checked 2026-09-15, operator wanted >= 30 Hz).**
Its product manual (BP-UM-TF-LC02 V1.1) gives "data acquisition time 33ms" (~30 Hz nominal),
but the UART protocol has only six commands: 0x81 get distance, 0x82 crosstalk correction,
0x83 offset correction, 0x84 reset, 0x85 get factory settings, 0x86 get product info. None
sets a frame rate, integration time or continuous output. **Never send 0x82 or 0x83**: they
run the factory calibration and store the result, needing a dark box and a target. The
11-17 Hz measured here is below the nominal 30 Hz, and polling faster does not help (584 Hz
polling still gives 17 Hz; see the LiDAR sections above). Operator accepted "as fast as it
goes". Getting >= 30 Hz means a different sensor or IMU fusion. The stream still publishes
at 50 Hz, so the display updates at 50 Hz between measurements.

**Default 100 ms** (operator's choice; `DEFAULT_AVERAGE_MS`, selectable Off/100/250/500/1000,
persisted to `localStorage.handheld_average_ms_v2`, v2 so the old 250 ms default does not
stick). 250 ms would remove nearly all visible flicker for ~125 ms of lag.
Past ~500 ms noise barely falls. Averaging applies to the displayed distances, the position
and the origin; `rawMm` keeps the unaveraged reading. It does NOT touch the standoff that
SFCW/C-scan/rover use.

### Not handled yet

A beam crossing a surface edge (reads as a step, not motion), and range: the right head saw
nothing in range on the bench. **Rotation IS handled as of 2026-09-15** -- see the next
section; this entry used to list it.

## Handheld tilt compensation, and the IMU->LiDAR mount calibration (2026-09-15)

`lib/handheldTilt.js` (pure), wired through `handheldPose.js`, with Tilt and Mount
calibration sections in the Handheld panel and a tilt column in the LiDAR readout.
Groundstation-only: the Pi streams distances and the BNO085 quaternion and knows nothing
about any of this, the same rule background subtraction follows.

### The problem, and why it dominates

`pos = origin distance - distance now` is exact only while the module does not ROTATE. A
beam meeting its surface at theta off the normal measures `h/cos(theta)`, so on an 800 mm
reading a hand tilt costs **3.1 mm at 5 deg, 12.3 at 10, 28.2 at 15, 51.3 at 20 and 82.7 at
25** -- against the 0.5-1.0 mm of sensor noise the averaging window was tuned against. It is
systematic, not noise, and hand-held rotation is easily +-15 deg.

### The model

Everything is referenced to the pose the ORIGIN was declared in, which is what makes the
room's own frame drop out of the arithmetic entirely:

    Qr  = q0* (x) q          rotation since the origin, in the body-at-origin frame
    g_k = mu_k . (Qr v_k)    cosine of the incidence angle
    h_k = d_k * g_k          perpendicular distance -- EXACT, not a small-angle form
    pos_k = sign_k * [ (h0_k - h_k) - mu_k . (Qr p_k - p_k) ]

`v_k` is where LiDAR k points in the IMU's own sensor frame (the mount), `mu_k` the surface
normal in the body-at-origin frame, `p_k` an optional lever arm. With Qr = I this collapses
to `sign * (d0 - d)`, so it is a strict drop-in and an axis missing an orientation falls back
to exactly the old number.

Measured, origin set square then rolled and moved straight up 100 mm over a 1000 mm floor:
**100.00 mm at every roll from 0 to 30 deg**, where uncorrected reads 117.0 at 10 deg and
270.2 at 30. It also removes the phantom CROSS-AXIS motion, which is the less obvious win --
roll tilts the right-facing beam too, and uncorrected that invents 108 mm of X travel at
30 deg that never happened.

The correction is applied **per SAMPLE, then averaged**, not to the averaged range: the
window is up to 1 s and the correction depends on the attitude each sample was taken at.
Correcting the mean with the latest attitude puts a whole window of hand rotation onto one
reading (~5 mm at 30 deg/s and a 100 ms window). The per-LiDAR history therefore stamps the
quaternion onto every sample. Verified: a stationary module rotated to 20 deg across a
400 ms window reports **0.00 mm of apparent motion**.

### THE ONE APPROXIMATION: mu = v, and exactly what it costs

`mu_k` is where the surface normal sits relative to the module AT THE ORIGIN, so it is not a
property of the hardware and no mount calibration can supply it. This version assumes the
operator held the module square when declaring the origin. With an origin misalignment alpha
and a later tilt theta the residual is `tan(alpha)*tan(theta)` against `1/cos(theta)-1` for
no correction, so:

**THE CORRECTION HELPS ONLY IF THE ORIGIN POSE IS SQUARE TO BETTER THAN ROUGHLY HALF THE
TILT YOU THEN APPLY.** Each reading is at a MINIMUM when its beam is perpendicular, so aim by
minimising; the panel's per-axis live tilt readout is there for this. Measured: an origin set
with 5 deg of roll, then rolled to 10 deg, reads 117.7 mm for a true 100 mm -- still better
than the 135.0 uncorrected, but not exact. **The residual scales with the STANDOFF, not with
how far you moved** (~15 mm on a 1 m floor distance whether the move was 10 mm or 300).

The proper fix is to fit `mu` at origin time from a deliberate 2 s wobble -- the same linear
half of the solve below, with `v` known. The machinery is there, the UX is not; next step.

### The mount calibration: alternating least squares, not a minimum search

Hold the module in ONE SPOT and tumble it. The perpendicular distance H is then constant
while the measured range is not, so

    1/d_t = (1/H) * mu . (Qr_t v)  =  a . (Qr_t v)

which is BILINEAR in two unknown directions. Alternating least squares splits it into two
3-parameter linear solves, each well conditioned where the joint 9-parameter form
(`1/d = <Qr, a v^T>`, linear in 9 unknowns) is not -- the samples sit near the identity
rotation, so `vec(Qr)` explores barely four of its nine dimensions. The 9-parameter fit is
still run, rank-1 factorised and used as a SECOND starting point, and whichever converges
lower wins: the nominal mount comes from `imu_calibration.py`'s `R_ACCEL` remap, whose
forward/left rows that file itself records as inferred rather than measured, so it must not
be the only way in. **A by-product is that this calibration MEASURES those rows.**

Simulated module (true mount 6.5 deg off nominal, 1 mm quantisation, 300 samples), fitted
direction error vs how the operator moved:

| rotation | translation 0 mm | 3 mm | 10 mm |
|---|---|---|---|
| ~11 deg, two axes | 0.2-0.5 deg | 0.1-1.6 | 1.5-4.6 |
| ~21 deg, two axes | 0.02-0.05 | 0.06-0.34 | 0.4-1.0 |
| ~35 deg, two axes | 0.02 | 0.05-0.12 | 0.1-0.2 |
| any, ONE axis | **3-94 deg** | **3-92** | **73-95** |

**Rotating about a single axis is not merely imprecise, it is a genuine gauge freedom** --
both unknown directions can be spun about that axis with no change in the prediction -- which
is why it produces confident answers up to 95 deg wrong. It is gated on `rotationCoverage()`,
which measures the ROTATIONS (as rotation vectors, eigen-decomposed) and not the fitted beam
directions. An earlier version measured the beam spread and was circular: a badly wrong `v`
traces a wide cone and scores well, reading 6 deg of "coverage" on a run whose answer was
21 deg out. **Measure the input, not the output.** With the rotation-vector metric the
separation is total -- every degenerate case reads 0.0 deg of second axis, every good one
6.8-29.6.

Gates, all from that table: `CAL_MIN_ROT_DEG = 18`, `CAL_MIN_SECOND_AXIS_DEG = 4`,
`CAL_MIN_SAMPLES = 120`, `CAL_MAX_RMS_MM = 6`, `CAL_MAX_MOUNT_DEG = 35`. The panel shows the
same gates LIVE while the operator is still moving, and the result is SHOWN rather than
applied -- `acceptedMount()` then stores only the axes that passed, so a rejected axis falls
back to the nominal mount rather than keeping a fit that failed its own checks. An
independent end-of-run check is that the three fitted beams should be mutually perpendicular
(they are mounted square and nothing in the fit knows that): 0.19 deg on a good simulated run.

### Why the correction runs UNCALIBRATED by default

Worst-case position error on an 800 mm standoff, swept over every direction of mount error
and of tilt:

| mount error | 5 deg tilt | 10 | 15 | 20 | 25 |
|---|---|---|---|---|---|
| 0.5 deg | 0.0 mm | 0.0 | 0.0 | 0.0 | 0.0 |
| 2 deg | 0.0 | 0.0 | 0.0 | 0.1 | 0.1 |
| 5 deg | 0.0 | 0.1 | 0.2 | 0.4 | 0.6 |
| 8 deg | 0.1 | 0.2 | 0.5 | 1.0 | 1.6 |
| **NO CORRECTION** | **3.1** | **12.3** | **28.2** | **51.3** | **82.7** |

The mount enters only to SECOND order -- `g = v.(Qr v)` tilts the assumed normal and the
assumed beam together, so getting `v` wrong mostly cancels. So tilt compensation is ON by
default with the nominal mount and calibration is a refinement, not a precondition. What
calibration is really for is the lever-arm term (first order in `mu`), verifying `R_ACCEL`,
and any future `mu`-at-origin fit.

### Yaw drift costs very little, and the magnetometer must stay OFF

The quaternion is `bno085.py`'s game rotation vector (report `0x08`, accel+gyro only), so
roll and pitch are gravity-referenced and drift-free while yaw free-runs at ~1-2 deg/minute.
Measured with the module physically still and only the reported heading drifting:

| drift | X err | Y err | Z err |
|---|---|---|---|
| 1 deg | 0.11 mm | **0.000** | 0.08 mm |
| 2 deg | 0.43 | **0.000** | 0.31 |
| 5 deg | 2.66 | **0.000** | 1.90 |
| 10 deg | 10.6 | **0.000** | 7.60 |

**Y/height is EXACTLY immune** -- yaw is rotation about the down beam's own axis, and
spinning a LiDAR about its own beam cannot change its range to a perpendicular surface. X and
Z cost `standoff * psi^2/2`, second order, and do NOT scale with travel: the axes are pinned
to the surface normals captured at the origin, so drift corrupts the cosine and not the axis
definition (200 mm of forward travel under 2 deg of drift puts 0.43 mm into X, the same as
standing still). At the real drift rate that is 0.1-0.4 mm over a session, under the sensor's
own noise floor.

**Do not "fix" this with the magnetometer.** The mag-fused rotation vector (`0x05`) is one
constant away, and `bno085.py`'s comment gives the rover's reason for avoiding it (four
stepper motors). The handheld has a better one: this instrument images REBAR, so a
magnetometer aimed at reinforced concrete is pulled by exactly the thing being looked for and
the heading error would correlate with the target. Conduit, steel studs and wiring make
indoor heading untrustworthy generally. The payoff would be a few tenths of a millimetre.

### Details that are load-bearing

- **The origin stores a quaternion PER AXIS**, not one for the whole origin. "Set origin"
  refreshes only the axes with a fresh reading and leaves the others on a reference taken in
  an earlier pose; one shared quaternion would be wrong for those. `localStorage` key bumped
  to `handheld_origin_v3` -- a v2 origin carries no attitude, and reusing it would reference
  the correction to whatever pose the module happens to be in at page load.
- **The origin stores the RAW reading, not the corrected one.** The origin is what the
  correction is measured FROM, so at the origin attitude it is the identity by construction;
  storing a corrected value double-counts the operator's pose.
- **A beam past 90 deg from its surface is REFUSED, not extrapolated** (`cos > 0.05`). That
  axis reports `grazing` and falls back rather than returning an explosive or negative
  perpendicular distance.
- **`corrected` is reported per axis and means what was DONE, not what was asked for** --
  false whenever any link in the chain (no IMU quaternion, no origin attitude, grazing, tilt
  switched off) made it fall back. The viewport says "tilt corrected" / "no tilt corr" from
  that, never from the toggle.
- **Rotating a LiDAR about its OWN beam axis changes nothing**, which the geometry reproduces
  exactly and is a free sanity check: a 20 deg rotation about the forward beam's axis moves X
  by -18.4 mm, Y by -29.0 mm and Z by 0.000 mm.
- **Lever arms are implemented and tested but not exposed.** They are each LiDAR emitter's
  offset from whatever point you want the reported position to refer to (the antenna
  aperture, say) -- without them each axis reports ITS OWN emitter's position, which only
  diverges once you rotate. Measured: a down head 50 mm to the side reads 8.7 mm low at
  10 deg of roll (`r*sin(roll)`), and the term is exact when supplied. No UI, because it is
  9 numbers and beyond what was asked for.
- The calibration sample buffer is capped at `CAL_MAX_SAMPLES = 6000` per axis (2 min at
  50 Hz); a run has no natural length and the panel can be walked away from.
- `lidarsByUart()` is exported from `handheldPose.js` and shared with App's calibration feed
  rather than copied -- the drift hazard this file already records for CFAR, the SAFT kernel
  and the TF-LC02 parsers.

### Verification

`handheldTilt.js` and `handheldPose.js` are pure and were exercised head-first from node
(73 checks across three scripts: quaternion algebra; mount recovery to 0.05-0.19 deg against
a known truth with realistic noise; the degenerate single-axis run refused on all three axes;
the correction exact to 4e-13 mm over 5-20 deg of tilt where uncorrected is 101 mm out; the
lever-arm term exact; the `tan(alpha)tan(theta)` residual matching the derivation; per-sample
averaging holding a rotating-but-stationary module to 0.00 mm; grazing refusal; the partial
origin keeping each axis's own reference attitude; `acceptedMount` dropping failed axes and
falling back to nominal; the sample cap; and malformed stored state). The roll-then-lift and
yaw-drift tables above came from driving the SHIPPED `computeHandheldPosition` against a
simulated module, not from the formulas.

The panel and all three viewport readouts were then SERVER-RENDERED through Vite's own
transform in 14 states -- uncalibrated, calibrated, tilt off, calibration running with and
without coverage, result shown, no origin, no IMU orientation, a legacy Pi with no `lidars`,
and disconnected -- which is the check that catches a field that does not exist, the class of
bug that silently blanked the C-scan plan view. There is still no test runner in this repo,
so these were throwaway scripts. `vite build` passes.

**NOT run on hardware, and there is no browser on this Pi so the panel was never driven
live.** What to check on the bench, in order: (1) the Tilt readouts move sensibly when the
module is tilted by hand and read ~0 when held in the origin pose; (2) a calibration run
passes its gates with a real tumble and the three fitted beams come out near-perpendicular --
if `orthoDeg` is large the run was bad even where the per-axis checks passed; (3) the fitted
mount agrees with `imu_calibration.py`'s `R_ACCEL`, which would be the first real measurement
of its forward/left rows; (4) whether the position genuinely holds still under deliberate
tilt, which is the whole point.

## C-scan projection source: SAR detections (2026-09-15)

The C-scan panel's Projection section has a **Grid | SAR detections** switch
(`cscanProjection.source`, persisted to `localStorage.cscan_projection_source`). It drives
BOTH the monitor plan view and the projector window, so the to-scale px/cm and Left/Top
calibration is shared -- the rig is calibrated once whatever is projected.

**SAR detections draws:** captured cells as flat dark grey (`SCANNED_FILL`), uncaptured
cells exactly as the grid view does, and each **confirmed** pipe as a white band. No
colormap, no colour bar, no depth. Probable targets and seepage patches are deliberately
NOT drawn yet (operator's choice); a SAR panel in Seepage mode draws nothing and says so.

`lib/detectionOverlay.js` `confirmedPipeOverlay()` (pure) is the whole mapping:

- **Rating = `effectiveRating(t, sarHandleEnds)`**, the same one the SAR panel shows, so a
  confirmed target inside the end zones is hidden while Handle ends is on (counted as
  "at the scan ends not shown").
- **No prediction.** A band is drawn only for rows the detection used (`rowIys`), and in
  each only if the grid cell under the line was captured.
- **Half-cell offset.** Detection x = `grid_ix * hStep` is an antenna position, the CENTRE
  of plan-view cell ix, which spans `[ix, ix+1]`; `cellUnitsX` adds the half cell (and the
  draw uses the row's own cell edges vertically). Without it every pipe lands half a cell
  left and low.
- **A drift under `TILT_MIN_CHANGE_CM` (3.2 cm) is drawn vertical**, same rule as the 3D
  view. 4pipes' straight 58.5 cm pipe fits slope 0.2 (1 cm drift) and would otherwise be
  projected leaning.
- Band width = measured -6 dB width, floored at one column. A result whose pitch differs
  from the grid's is not drawn (it is replaced by the re-run the change triggers).

**It updates per ROW, not per cell.** Detection is whole-scan, debounced 800 ms, and the
live raster flushes every 250 ms, so it runs at row changes and at the end (~1 s for 6 rows,
~4 s for 30). The scanned-cell fill still grows live; the title and panel show
`rows k/N` so a stale result is visible. Early rows rate weakly and pipes can appear or
vanish as rows are added.

**Without an empty reference the gw2 crevice rates confirmed**, so the panel warns in amber
when none is loaded -- projected on the wall it is a confident false pipe.

Verified head-first through the shipped `runDetection` on `4pipes.json` + `1pipe.json`
reference (Node, lib copied with `.js` imports, scratchpad `overlay_test`): 3 confirmed at
18.5 / 33 / 58.5, every band centre in the column of its antenna position, 17 bands (one of
18 pipe-rows sits on an uncaptured cell and is correctly skipped), uncaptured rows skipped,
seepage and pitch mismatch draw nothing, end-zone hiding follows the toggle, slanted row
segments meet at the shared edge. 15 checks.

Then the BUILT app in headless Chrome over CDP (scratchpad `ui_proj/drive.mjs`: C-Scan
Import of 4pipes, SAR panel Load empty reference with 1pipe, Source = SAR detections, then
To scale + Open projector view). A script `.click()` has no user activation, so Chrome opens
no file chooser; the script parks the app's on-the-fly `input[type=file]` in the DOM and
sets the file with `DOM.setFileInputFiles` on that node. Panel read "3 confirmed pipes ·
rows 6 of 6", no console errors. **Projector at the default 8 px/cm @ 60,80: band centres
exactly 210 / 326 / 530 px, widths 28 / 20 / 20 px** (= 60 + (x + hStep/2) * 8 for 18.5 / 33
/ 58.5 cm), the 58.5 cm band absent on one 8 px row (the uncaptured cell). Monitor plan
view (fitted): the three band centres lie on one line at 16.5 px/cm. Switching back to Grid
restores colour-mapped cells and no white on both. Not yet run on the dev server or
against a live raster.

### Probable pipes toggle (2026-09-15)

Under the Grid | SAR detections switch (shown only with SAR detections selected) a **Show
probable pipes** toggle (`cscanProjection.showProbable`, persisted to
`localStorage.cscan_projection_probable`, default off) adds the SAR panel's PROBABLE pipes as
**amber** bands (`#fbbf24`, the SAR panel's probable colour) beside the white confirmed ones.
`detectionOverlay.js` is now `pipeOverlay(detection, params, handleEnds, capturedAt,
{ includeProbable })`; every segment carries `rating`, and `probable` is counted whether or
not it is drawn. Probable bands are drawn FIRST so a confirmed band is never painted over.
Same rules as confirmed: `effectiveRating` (end-zone probables hidden with Handle ends; the
detector already rated sidelobe probables 'none'), no prediction, sub-resolution drift drawn
vertical. The title and panel status add "· N probable" while it is on.

Verified: Node (19 checks, incl. probable counted-not-drawn by default, drawn on every row
when included, end-zone probable hidden, confirmed bands unchanged). Built app in headless
Chrome on `2rods1pipe.json` with NO reference (confirmed 20.0 / 54.0, probable 12.0 / 35.5):
projector at 8 px/cm @ 60,80 draws **amber at exactly 158 and 346 px (20 px wide)** and white
at 222 (16 px) and 494 (24 px), the 35.5 cm band absent on one row; toggling off removes every
amber pixel and leaves the white unchanged; localStorage follows the toggle; no console errors.
Note 2rods1pipe has no reference, so its probables include the known 35.5 cm crevice.

## Projector Demo panel (2026-09-15)

Panel id `projdemo`, label "Projector Demo", last in `PANELS`. Three modes switched at the top
of the panel: **Draw**, **Rover**, **Handheld**. Files: `lib/projectorDemo.js` (pure: grid,
resize, painting, file format), `hooks/useProjectorDemo.js` (state, called in App so an open
projector survives switching panels), `components/ProjectorDemoPanel.jsx`,
`components/ProjectorDemoDisplay.jsx`.

- **Grid frame is the C-scan's**: ix 0 = left column, iy 0 = BOTTOM row, steps in cm, colour at
  `iy * hCount + ix`. Layout, cell snapping and to-scale placement use the same
  `cscanLayout` / `layoutCellRect` / `layoutCellAt` / `canvasOffsetIn` as the C-scan plan view
  (the last three moved from `CscanDisplay.jsx` into `lib/cscanGrid.js`, unchanged).
- **Draw**: H/V cell counts and steps (limits 1-200, 0.5-50 cm, same as the C-scan grid).
  Left click/drag paints the selected colour, right-drag or the Erase tool erases; a fast drag
  fills every cell on the line between pointer events. Changing a count keeps the colours still
  inside the grid. The drawing is saved to `localStorage.projector_demo_draw_v1`. Draw mode is
  drawn at the shared projection scale and placement, and has a projector too (2026-09-16):
  it shows the whole Draw image with grid lines, so the projector can be aligned to the wall and
  the drawing matched to it. Switching mode keeps the one projector window open; it follows the mode.
- **Rover / Handheld**: each has its own imported grid (session only) and they share one
  projection calibration (`localStorage.projdemo_*`, seeded from the C-scan's `cscan_*` values
  the first time). The monitor shows the colours, drawn at the projection's scale and placement;
  **the projector shows only the empty grid (grey lines, no colours)**. Filling it in on the
  projector is still to be specified.
- **Unpainted cells are navy** (`GRID_BACKGROUND` `#0b1a3d` in `lib/projectorDemo.js`) wherever
  colours are shown: a new grid, a full clear, an erased cell. It is a display default for colour
  `null`; files stay sparse and do not store it.
- **Rover mode (2026-09-15)** -- `hooks/useRoverPaint.js`, created in App next to `useRoverScan`.
  The Rover mode button is disabled unless the rover controller is linked, and Rover mode is never
  restored from localStorage at page load. The loaded image is drawn DULL on the monitor; Start
  drives the grid and each cell returns to full colour once the rover is in front of it. The
  projector shows ONLY the covered cells, in their colours (unpainted ones navy); the rest stays
  dark with grid lines. Coverage stays after the run until "Reset coverage" or a new grid.
  - Geometry: where the rover stands at Start is the CENTRE of the top-left cell. Rows go down from
    the top in a snake (first row left to right). Each row is ONE `rover_move_abs` at the panel's
    Speed (1-300 mm/s, default 300, `localStorage.projdemo_rover_speed_v2`, pushed as `x_max_speed`
    and restored on every exit, like the C-scan raster). Each row change is one vertical move at the
    row-end column.
  - **Vertical neighbours (N, default 1, `localStorage.projdemo_rover_vneighbours`):** a pass lights
    its row plus N rows above and below (`columnCells`), and passes are 2N+1 rows apart
    (`paintRows`), so neighbouring bands touch without overlapping. The first pass runs N rows below
    the top (the rover steps down before its first traverse) so its upper band covers the top row;
    the last is clamped to the bottom row so the rover never drives below the grid, and its band
    may overlap the previous one. N = 0 reproduces the original one-pass-per-row legs exactly.
  - Coverage comes from the rover's REPORTED position (cell = nearest centre in both axes), not the
    plan. Every cell on the line from the previous cell is marked too, because status arrives at
    ~11 Hz and a fast rover can pass a whole cell between frames.
  - Safety is the C-scan raster's, shared rather than copied: `useRoverScan.js` now exports
    `moveCompletion()` (token, then `moves_done`, then timer), `clampTarget()` and the timing
    constants, and its own tick calls `moveCompletion()`. Start is refused if the rover is moving,
    e-stopped, another rover scan is active, or the grid does not fit the soft limits. A move ending
    as anything but `completed`, a timeout, or stopping off target aborts WITH an e-stop. Link loss or
    a latched e-stop ends the run. The operator's Stop sends `rover_stop` (decelerate, NOT a latch),
    then restores the speed. Mode buttons and Import/Unload are locked while running.
  - Tested against `rover_sim.py`, not on the rig: 32 of 33 checks passed (full run in 9.8 s,
    cells lit in snake order, x speed held at the set 100 mm/s, row changes only at row ends, speed
    restored, Stop keeps partial coverage without latching). The one failure was the test itself
    (it sampled the monitor with the fitted layout after To scale was switched on).
  - **Two traps for testing this on the Windows groundstation PC:** (1) VS Code (its port
    forwarding) listens on `127.0.0.1:9002` and `127.0.0.1:8765`, which wins over a local
    `rover_server.py` bound to `0.0.0.0`, so `localhost` may reach the REAL rover through a tunnel.
    Use `127.0.0.2` for both the Pi IP and `rover_sim.py --host`. (2) `rover_sim.py` runs ~19x slow
    on Windows: it advances a fixed 1 ms per loop but `asyncio.sleep(0.001)` takes ~15 ms, so a
    100 mm move took 18.4 s and status came every ~780 ms. Any timeout-guarded client then aborts
    correctly. Driving `Sim.tick` from measured wall time made the same move take 1.00 s.
- **Handheld mode (2026-09-15)** -- `hooks/useHandheldPaint.js`, created in App. The Handheld
  button is enabled only when all three handheld LiDARs are in the sensor stream
  (`allHandheldLidarsPresent()` in `lib/handheldPose.js`: every assigned head present, not
  'absent'; a head out of range still counts). The page always opens in Draw mode, because neither
  the rover link nor the LiDARs exist at load. Drawing matches rover mode: the monitor shows the
  image dull and a reached cell in full colour (the cell in front of the module is outlined), and
  the projector shows only the reached cells.
  - Position is the Handheld + IMU panel's own `computeHandheldPosition` (same origin, wiring and
    averaging). The demo's Set origin uses `originFromPose` and writes the SHARED
    `handheld_origin_v2`, so it also moves the Handheld panel's origin. The origin is the centre of
    the top-left cell; X right and Y up map to a cell through `cellAtOffsetMm()`
    (`lib/projectorDemo.js`), which rover mode now uses too.
  - Session: Start session (clears coverage, starts PAUSED) -> Set origin -> Play/Pause -> End
    session. Cells are marked only while playing and only with an X and Y position (origin set,
    readings live or held). Play is disabled until X and Y both have an origin. Coverage stays after
    End until Reset coverage or a new grid; mode and Import/Unload are locked during a session.
  - **Brush:** each reached cell lights every cell within `HANDHELD_BRUSH_RADIUS` = 5 cells (was 3 until 2026-09-16) of it
    (`brushCells`, a disc counted in cells, so an ellipse on the wall when hStep != vStep).
  - **Path recording (2026-09-16):** while playing, every pose update (one per sensor packet, deduped
    on the Pi timestamp) is recorded as `[t_s, x_mm, y_mm, z_mm, ix, iy]`: Pi time, the Handheld panel's
    position from the origin (tilt-corrected when enabled) and the cell under it (null off the grid).
    A new segment starts on every Play and on an origin change (each segment stores the origin
    distances it was measured from); a brief position loss does not split one. Export path writes
    `handheld_path_<ts>.json` (`type: 'projector_demo_handheld_path'`, v1, with `columns`, `grid`,
    `segments[{ started_s, origin_mm, points }]`). Points are kept in a ref, never in props (see
    the React dev-build Performance-timeline section); the count on screen refreshes at <= 4 Hz.
    Start session clears the path; End keeps it; "Reset cells + path" clears both.
  - Gap fill is limited to jumps of `HANDHELD_FILL_MAX_CELLS` = 2 cells (rover mode fills any gap).
    A longer jump is more likely a beam sliding off a surface edge, a reposition, or an origin
    change, and bridging it would light cells the module never passed. Pause, losing the position,
    leaving the grid and changing the origin all break the trail.
  - Not run on the hardware or in a browser yet; `vite build` only.
- **Radar look (2026-09-15) -- Draw mode now paints PIPE and SEEPAGE, not colours.**
  `lib/radarLook.js` (pure) renders the drawing as an SFCW-scan-like image, one viridis colour per
  cell (dark = no detection, bright = detection): a seeded Perlin fBm "rolling" background with a
  per-row offset and speckle; pipes as a soft Gaussian cross-section of a width in cm (max over the
  stroke, so peak brightness does not depend on cell size) with brightness varying along the stroke
  and a faint wide halo; seepage as the painted region blurred wide and noise-modulated. Features are
  screen-blended (v + (1 - v) f). Default background Level 0.12 (0.20 until 2026-09-16, darkened on
  request); a saved drawing keeps its own look until Reset look. Look settings are sliders (`LOOK_CONTROLS`, grouped Background /
  Pipes / Seepage) plus New background (new seed) and Reset look. Brush: Pipe (one cell wide),
  Seepage and Erase (disc of Brush size cells), Strength 0.05-1. The Draw lattice is hidden so the
  image reads as a scan.
  - **Exact import:** export v2 writes EVERY cell's rendered colour (what Rover and Handheld show,
    unchanged by any later renderer change) plus a `radar` block: `{ seed, look, pipe: [[ix, iy, s]],
    seepage: [...] }`. Draw re-imports from `radar` and re-renders; strengths are 0.05 steps written
    to 3 dp, so they round-trip bit-identically. v1 (colour) files still load in Rover/Handheld and
    are refused in Draw. Draw is saved as `projector_demo_draw_v2` (layers only); an old v1 drawing
    is not carried over. The navy background below applies only to v1 files now.
- **File** (`projector_grid_<ts>.json`): `{ version: 1, type: 'projector_demo_grid', timestamp,
  grid: { hCount, hStep, vCount, vStep }, cells: [{ ix, iy, color: '#rrggbb' }] }`, painted cells
  only. Import refuses (with a message) a wrong type/version, out-of-range geometry, a cell
  outside the grid or a bad colour, rather than clamping.
- **Shared code pulled out of CscanPanel**: `components/ProjectionControls.jsx` (To scale,
  px/cm and trims, Left/Top and nudges, projector open/close/display picker) and
  `components/EditableField.jsx`. Both panels use them.
- **`ProjectorWindow` takes `name` and `title`** (defaults are the C-scan's) and keeps its
  StrictMode reclaim record per name, so the C-scan projector and the demo projector can be open
  at the same time without reclaiming or closing each other.

Verified on the vite DEV server in headless Chrome over CDP (throwaway scripts, 30 checks):
drag, click, right-click erase and resize through the panel field, canvas pixels matching the
painted colours, export content, bad-file refusal, import into Draw and Rover, the Rover monitor
showing colours, the projector opened by a real click drawing only grey lines exactly 320 x 240 px
at 60,80 for an 8 x 6 grid at 5 cm and 8 px/cm, four fast +10 nudges moving it 40 px, Handheld
with no grid giving a blank projector, Draw closing it, the C-scan projection controls still
rendering, both projector windows open together, and no console errors. `vite build` passes.
**Not run on the real projector or on a second physical display.**

## Dev-server tab running out of memory: React 19.2's Performance-timeline props diffs (2026-09-16)

Reported: painting in Projector Demo Draw mode made the browser tab run out of memory.

**Not the drawing code, and not the JS heap.** Measured in headless Chrome on the vite DEV server,
200x200 Draw grid, continuous pipe strokes: renderer private memory 84 MB -> 4.7 GB in 60 s
(~8.5 MB per brush event) while the JS heap after forced GC stayed at 12-17 MB and DOM nodes and
canvases stayed constant. Bisected with isolated experiments, each flat: canvas redraws alone
(hovering, ~1,300 full redraws), `renderRadarLook` x300 with no canvas, a bare canvas with 40k
coloured fillRects per frame, and the same with FRESH colour strings every frame. A memory-infra
dump (CDP `Tracing.requestMemoryDump`, the chrome://tracing data) named the allocator: the
renderer's `partition_alloc/partitions/buffer` grew 17 -> 1,924 MB in 20 s; GPU, Skia and cc tile
memory did not grow.

**Cause: React 19.2's development build records every component render with
`performance.measure`, attaching a diff of the changed props** (`logComponentRender` /
`addObjectDiffToProperties` in `react-dom-client.development.js`, gated only on
`supportsUserTiming`). The browser keeps those entries until cleared. Props carrying the drawing's
40k-cell layers and colours made each render megabytes: after 198 brush events there were 3,382
measures holding 642 MB of detail JSON, the largest a single 2 MB `Sidebar` entry.
`performance.clearMeasures()` + GC dropped the buffer partition from 1,487 MB back to 22 MB.

**It is dev-only and app-wide.** The production React build contains no `performance.measure`
recording. Any long dev session whose renders carry big props grows the same way -- this is almost
certainly the unexplained "`performance.measure` OOM" in the 2026-09-08 long-scan section above.

**Fix:** `src/main.jsx` installs, in development only, a `PerformanceObserver` on 'measure' that
calls `performance.clearMeasures()` as entries arrive. Nothing in `src/` reads the timeline
(grepped), and Chrome's Performance panel records React's tracks through tracing, not this buffer.
Verified: 353 brush events in 30 s, buffer partition 20 -> 17 MB, zero measures left.

What it does NOT remove: React still builds each props diff in dev before the entry is cleared, which
is real CPU and allocation work and likely why brushing runs at only ~10-12 events/s on the dev
server. The production build does none of it (its brush rate has not been measured).

## Handheld Capture panel: raw recording of hand-held patch scans (2026-09-17)

Panel id `hhcapture`, label "Handheld Capture", last in `PANELS`. For site work: scan a wall patch
by hand and record **everything, raw**, for post-processing. Nothing is averaged, binned or dropped
(operator's requirement). Files: `lib/handheldCapture.js` (pure: per-axis position tracks, record
builders, names, format notes), `lib/captureWriter.js` (rolling-segment disk writer),
`lib/dirHandleStore.js` (folder handle in IndexedDB), `hooks/useHandheldCapture.js` (created in App),
`components/HandheldCapturePanel.jsx`, `components/HandheldCaptureDisplay.jsx`.

A first version (same day) averaged sweeps per cell into a C-scan-shaped file. It was replaced before
use: coherent averaging across hand-held standoff and lateral spread destroys signal (12 deg per mm
at 5 GHz; the rover work measured up to 15.6 dB lost over a 50 mm aperture), and it threw the raw
sweeps away. Do not reintroduce averaging at capture time; do it in post-processing.

- **Workflow.** Choose a folder, type a session name -> Start session (creates `<folder>/<name>/`;
  refused while anything of that name exists, re-checked at Start / on typing / on window focus;
  starts the SFCW sweep if not running) -> hold the module at the patch's **TOP-LEFT CORNER** and Set
  origin -> Play / Pause -> End session (final write, stops the sweep only if this session started it,
  bumps a trailing number in the name). Start needs a writable folder, a free name, the SDR connected
  and all three LiDARs in the stream. Set origin is disabled while playing.
- **Recording is Start to End, playing or not**; Play/Pause only decides which sweeps go on the
  coverage map, and is itself logged. Layout: `session.json` (manifest: config at start, counters,
  segment list, coverage counts, and a `format` block describing every record kind) plus
  `stream_NNNNNN.jsonl` (one JSON object per line, concatenate in order). Record kinds (`k`):
  - `sweep`: every `sfcw_result` exactly as received, logged at the TOP of App's SDR handler, before
    the range-offset guard and the empty-DSP-sweep drop (so `range_offset` is the Pi's own and empty
    sweeps are kept). Omits `distances`/`magnitudes` (a function of h_cal/step/offset). `h_cal` is
    **full float64** from binary frames (`h_cal_precision: 'float64'`): `decodeSfcwBinary` now also
    attaches non-enumerable copies `h_cal_full_real/_imag` -- spread, JSON and structuredClone of the
    message are unchanged, and the lazy profile getters are never invoked by the recorder.
  - `sensor`: every sensor packet as received (all heads' mm/seq/ts/err, quat, accel, gyro, yaw).
  - `sdr`: every other SDR message except RF Calib's rx_data/rx_fft.
  - `place`: DERIVED position (x/y/z mm) and cell at the sweep midpoint, while playing.
  - `event`: session_start (full config), origin_set, play, pause, config changes, sfcw start/stop
    requests, session_end. Every line has `rx_ms` (browser Date.now()); Pi times are `timestamp`/`ts`.
- **Disk / memory.** Segments close at 4 MB or 30 s. The open segment is rewritten whole about once a
  second; `createWritable()` swaps in a complete file on close, so a crash loses at most ~1 s. Memory
  is bounded by one segment; a closed segment's text is released after its final write succeeds. A
  failed write keeps the data and retries every second; the error stays shown until that write
  succeeds (a later success on another file must not clear it -- a bug caught by the tests) and the
  panel alarms past 64 MB unsaved. A failed final save keeps the session open for another End.
  ~90 records/s at 36 Hz sweeps is ~100 kB/s (~6 MB/min); at 100 Hz DSP sweeps expect ~3x that.
- **Position (coverage map and `place` only).** The feeds come straight from App's websocket handlers
  (`onSensor`, `onSdr`), NOT from a React render -- renders can coalesce packets under load, which
  was the earlier position-update bug. Each axis is its own track built only from NEW measurements
  (a head's `seq` advancing), stamped with that head's own `ts` minus the panel's **LiDAR Latency**
  (default 0, unmeasured), tilt-corrected per measurement by `handheldPose.axisPositionMm` (same
  arithmetic as `computeHandheldPosition`, verified equal). This (1) removes the lag of timing by the
  packet, which repeats a measurement for up to ~90 ms (simulated: -6.7 mm bias at 200 mm/s -> 0),
  (2) refuses sweeps while a head is not measuring instead of filing them at a carried, frozen value
  (simulated: 60 mm off), and (3) uses no averaging window. Interpolation only, gap limit
  `AXIS_GAP_MAX_S` 0.35 s (a still head republishes every 0.25 s). A change of origin, wiring, mount,
  tilt or latency clears the tracks. Measure the latency with an out-and-back pass (the two
  directions disagree by 2 v tau); the raw data allows refitting it later anyway.
- **Viewport, two views** (Status | Rough output, switch in the pane header and at the top of the
  panel, persisted). **Status**: coverage map of placed sweeps per cell (dark none, amber < Min Sweeps,
  green >=, counts). The module dot, outlined cell and the panel's X/Y/Cell tiles come from the
  capture's OWN measurement-timed position (`livePosition()`: both axes at the older of their newest
  measurements; dropped when > 0.5 s behind the newest packet), read from a ref every frame -- they
  used to show the Handheld panel's averaged, packet-timed position and could lag the cells filling.
- **Rough output** (`hooks/useHandheldRoughView.js`, settings in `handheld_capture_rough_v1`): the
  FIRST sweep placed in each cell (kept in memory, one per cell, reset at Start) as a C-scan record,
  background-subtracted with a BG model the panel loads from `/api/models` (not persisted), drawn
  with `CscanDisplay`. Everything is the C-scan's own code -- `applyBscanBg` (complex/magnitude,
  window), `computeCellValues` via the grid (gate, metric, SAFT/DAS+CF/DMAS+CF focus),
  `planViewScales` (dynamic/manual, linked/gated), colormap, smooth -- so it cannot disagree with a
  C-scan of the same cells. Computed only while showing. The cell's standoff is the forward head's
  RAW distance (`fwdMm` track, no origin needed) interpolated at the sweep midpoint minus the
  antenna offset; range_offset is the panel's. **Placement waits up to `FWD_WAIT_MS` 400 ms for the
  forward head's next measurement** once X and Y bracket a sweep: without it a third of cells had no
  standoff and drew invalid (found in the browser test), because the heads measure at different
  moments. `place` lines now also carry `fwd_mm`.

**Verified:** 30 node checks (writer: order across segments, byte and time rotation, failure + retry
with nothing lost, on-disk file always a complete earlier version, 420 MB streamed with peak held
text 3.99 MB; tracks: interpolation, gap, seq dedupe, latency; lag and freeze simulations above;
`axisPositionMm` == panel; recorder keeps float64 exactly, never triggers the profile getters,
keeps the Pi's range_offset; decoder keys/spread/clone unchanged). Then the dev server in headless
Chrome against a fake Pi (binary SFR1 frames with a ground-truth cell per sweep, three heads each
measuring at 14 Hz with their own seq/ts) and the browser's private file system standing in for the
picker (23 checks, 25 s and 70 s runs): folder + manifest at Start, records on disk while scanning,
**JS heap 17.8 -> 18.0 MB over 70 s**, manifest complete and matching the segments, every counted
message on disk, float64 h_cal, raw sensor packets, all events, SDR status lines, collision refused,
no console errors. Placement disagreed with the fake's own label on ~1% of sweeps, every one within
1.3 mm of a cell edge (the fake's own sleep jitter on Windows). **Not run with the real folder
picker, a real Pi, or after a reload (Reconnect path).** In the headless dev run the app's auto-
connect did not fire and Connect had to be clicked; not investigated.
Rough view / live position (same day): 12 node checks (live position at the older axis, forward raw
track without an origin, first-sweep records through `applyBscanBg` with the real `gw2.json` model in
complex and magnitude mode, clamped and missing-standoff cells flagged, focused scales) and 26 browser
checks against the fake Pi plus the Flask model API (dot drawn from the capture position, raw rough grid,
gw2 loaded from the panel, 48/48 cells subtracted after the forward-wait fix vs 32/48 before, magnitude +
DAS+CF + manual scaling drawn, cells keep filling, no console errors).

## The per-retune wobble was RX1 running too hot: rx1_gain 25 -> 12, +10 dB (2026-09-19)

Investigating the "flat error pedestal ~40 dB below the strongest return" that capped
S_repeat. **`rx1_gain` default is now 12 (was 25)**, in `SFCWEngine.__init__` and
`App.jsx` `sfcwParams` -- both, because the panel is the source of truth and pushes.

| config | core | sweeps each | S_repeat | adj cv \|h_cal\| | RX1 ADC peak |
|---|---|---|---|---|---|
| **rx1 = 25 (old default)** | standard | 1300 | **31.7 dB** | 1.70% | 2048 (railed) |
| **rx1 = 12 (new default)** | standard | 1300 | **41.4 dB** | 0.98% | 840 |
| rx1 = 8 | standard | 1300 | 41.8 dB | 1.13% | 518 |
| rx1 = 25 | nios | 900 | 31.8 dB | 1.59% | -- |
| **rx1 = 12** | nios | 900 | **41.7 / 41.9 dB** (duplicate control) | 0.66% | 758 / 876 |

Control spread (the error bar): **0.2 dB** between the duplicate pair in each session.
Paired per interleave chunk, rx1=12 beat rx1=25 in **33 of 33 chunks**, +8.3 dB mean,
t = +15.6. rx1=8 vs rx1=12 is **+0.18 dB, t = +0.3, 22/33** -- indistinguishable, so 12
is taken for the 4 dB more signal it keeps. Per-step robust-z stayed clean throughout
(2/66,300 cells beyond 8 sigma at rx1=12, worst z 8.2), so this is not buying
repeatability by quietly losing steps.

**THIS INVALIDATES EVERY BG MODEL, SUPER FIT REFERENCE AND CAPTURED bgRef.** A gain
change re-calibrates h_cal and is not a scalar: |h_cal| at rx1=12 over rx1=25 runs
**0.176 to 0.263 across 2-5 GHz**, a 1.5:1 frequency-dependent change. Recapture
`gw2.json` and any Super Fit grid before trusting a subtraction.

### It is the same failure the REFERENCE channel had in 2026-08-29, on the other channel

That investigation found RX2 at ~76% of full scale, fixed the reference, and never
re-checked RX1 against a hot scene. RX1 was left at 25 dB, and:

- **The per-sweep RX1 ADC peak predicts that sweep's own error.** `corr(peak, per-sweep
  deviation)` = **+0.24 to +0.39 at rx1=25** across three separate control blocks, and
  **+0.07 at rx1=12**. That is a within-block test, so no drift between blocks can
  produce it.
- **The damage is a CONTINUOUS level dependence, not the rail.** Railing happens on only
  2-5% of sweeps and those sweeps are only 1.07-1.12x noisier -- nothing like enough to
  explain 10 dB. What matters is how hard the front end is being driven on average.
- **The tell is WHERE the excess sits.** Grouping steps by |h_cal| at rx1=25, the hottest
  quarter of the profile wobbles **1.95%** against **1.28-1.32%** for the other three
  quarters; at rx1=12 all four quartiles collapse onto **0.48-0.54%**. The |h_cal|
  dependence disappears entirely once the gain comes down.
- Across steps the residual scales with |h_cal| (corr +0.96 to +0.98, log-log slope
  1.2), i.e. **multiplicative, not additive** -- which is what falsifies external
  interference, a spur, or thermal noise as the cause.

**`_warn_if_adc_hot` could never have caught this** and still cannot: it needs
`ADC_HOT_SWEEPS_TO_WARN = 8` CONSECUTIVE hot sweeps, and the railing is a few percent of
sweeps scattered at random. The hysteresis is right for what it was built for (RX1's
per-sweep peak sits on any sensible threshold in ordinary operation) but it is blind to
this. **Watch the panel's RX1 headroom bar and aim RX1 at a few hundred counts peak --
the same band the reference is held in.** There is no automatic warning.

### Falsified. Do NOT spend time on these again

Every one bracketed, all at rx1=12 unless noted, control spread 0.3 dB in that session.

| hypothesis | result |
|---|---|
| **AD9361 RX quadrature tracking re-converging after each retune** | **No effect.** Freezing the coefficients (0x169 bits 0/1 clear) gives 41.0 dB, disabling the correction entirely (bits 6/7) 41.2, both off 41.1, against controls 40.9-41.2. |
| **AD9361 DC offset tracking** | **Not the cause, and load-bearing -- leave it ON.** Disabling BB+RF DC tracking (0x18B bits 3/5) gives **22.4 dB**, i.e. -18.8 dB, and wrecks the reference channel too (cvR 0.14% -> 3.65%). |
| **quick-tune / fastlock vs a full per-step tune** | **Falsified in the opposite direction.** A full `bladerf_set_frequency` per step gives **30.1 dB against 41.2**, and runs at 0.9 Hz instead of 18. Quick-tune is much better, not the problem. |
| **TX1 compression / TX drive** | **No effect.** tx1 = 50 / 44 / 38 / 26 / off all give adj cv 1.65-1.73%. With TX1 **completely off** the wobble is unchanged -- so it is not the transmitter. |
| **Something still settling inside the dwell** | **Nothing is.** Re-demodulating one raw capture at 10 window positions inside each dwell: from 110 us onward the trend is flat to 4 decimal places (|S| rel 0.99424 -> 1.00000, phase +-0.1 mrad) and **the sweep-to-sweep cv does not fall** (1.881 -> 1.872%). More dwell time cannot help. |
| **Reference gain split (E3b)** | **Still real, still 45/5.** At rx1=12: 45/5 = **42.1 / 41.9 dB** (duplicate control), 40/10 = 40.3, 30/20 = 33.3. No change needed. |

AGC was never a suspect: `_configure_channels_dual` already sets MGC on both RX.

### What remains, and it is the SIZE OF THE FREQUENCY STEP, not the retune

The received wisdom in this file was that the retune event re-randomises the
measurement. **At the corrected gain that is wrong.** Retuning 51 times to the SAME
frequency is nearly free; it is changing frequency that costs. Adjacent-sweep cv of
h_cal, standard core, rx1=12, all one session:

| grid | adj cv \|h_cal\| | S_repeat |
|---|---|---|
| 51 retunes to 3500 MHz (no frequency change) | **0.156%** | **54.6 dB** |
| alternate 3500 / 3560 (60 MHz jump) | 0.482% | 48.1 |
| six frequencies 3350-3650 in 60 MHz steps | 0.609% | 43.0 |
| alternate 3350 / 3650 (300 MHz jump) | 0.776% | 40.4 |
| full 2-5 GHz sweep, 60 MHz steps | 0.80-1.30% | 40.8 |
| alternate 3000 / 4000 (1 GHz jump) | **2.978%** | 29.7 |

Monotonic in the jump size. Note the 300 MHz span walked in 60 MHz steps (0.609%) beats
a single 300 MHz jump (0.776%), so it is the **per-step jump**, not the span.

**Most of it is common-mode and the reference is already removing it.** At the 1 GHz
jump both channels wobble on their own -- |S| 5.6%, |R| 4.9% -- and h_cal is left with
3.0%. At 60 MHz: |S| 2.10%, |R| 2.02%, h_cal 0.48%. So the loopback reference is doing
exactly the job it exists for, and what survives is the part the two chains do not
share.

**A settle_count ladder against the 1 GHz jump was run and is INCONCLUSIVE, not
negative** -- that session's controls disagreed by 2.7 dB and its reference channel
changed by 6x partway through (the loopback episodes below). Do not cite it either way.
The dwell-position test above does say nothing settles between 110 and 313 us.

### Method: INTERLEAVE, or the bench will score the experiment for you

Block-sequential A/B is not safe on this rig. Measured control spreads in this
investigation: **0.3 dB** in a good session, **1.8 dB** in another, **2.7 dB with the
reference channel moving 6x mid-session** in a third. The TX2->RX2 loopback throws
episodes lasting tens of seconds, so whichever config happens to run during one is
scored for the bench rather than for itself.

`probe_wobble.py --interleave N` rotates the configs every N sweeps instead of running
each block to completion. That turns an episode from a bias into noise the control
spread then reports honestly. **Every number quoted above with a 0.2 dB error bar came
from an interleaved run with a duplicated control config.**

**Trap that cost several dB: S_repeat is an ADJACENT-sweep metric, so on interleaved
data it must not difference across a chunk boundary.** The stored sweeps of one config
are chunks that were seconds apart; `np.diff` over the concatenation pairs sweeps that
were never adjacent. Measured on the 1300-sweep validation: **36.4 dB across the
concatenation against 41.4 dB within chunks, same data.** `analyze_wobble.py` now splits
on time gaps (`contiguous_runs`) before differencing. Same class as everything else in
this file: an instrument fed a re-timed copy reports on the copy.

### 'dsp' mode: do not touch the RFIC while a sweep is in flight (2026-09-19)

Root cause, from the FPGA source (`bladerf-src` branch `fifo-256` @ `ba105a3c`, the
v15 tree): `bladerf-hosted.vhd` muxes the AD9361 SPI pins to the `sweep_stepper`
whenever `stp_owner` is high, with no arbiter and no back-pressure on the Nios SPI
master. Host RFIC accesses (gain set/get, register pokes) therefore race the
stepper's ~51 retune bursts per 10 ms sweep, and with `DSP_PIPELINE_EXEC` a sweep is
in flight almost always. A racing write is dropped or lands as a corrupted word.

Bracketed hardware A/B, 9 live gain changes per block: mid-flight writes landed
correctly only 3/9 then 5/9 times (stuck, or at wrong levels). Draining the in-flight
sweep first: 9/9, at levels matching standard-mode physics to 1-3%.

Fix shipped host-side: `_sweep_loop` drains via `_dsp_cancel_pending()` before
`_apply_gains()` in dsp mode (the sequence re-priming already used), ~10 ms per gain
change; `probe_wobble.py` `apply_cfg` does the same. Proper fix is an SPI arbiter in
the FPGA or a Nios-firmware lock. Related: gain READBACK during a dsp sweep returns
garbage (111 / InvalError) -- check the level, not the readback; and the range-offset
guard's 5 s full-param re-push was re-rolling this dice during stale-offset sessions.

Otherwise dsp mode is healthy: 1500 uninterrupted sweeps show a per-sweep common
scalar of 0.990-1.017 (arg sd 0.003 rad), S_repeat 39.3 dB at 100 Hz vs nios 40.1 dB
at 35 Hz, `complex_div` is a plain Q14 divide with no hidden normalisation, and the
accumulator-skew race its comments describe is already fixed (`dsp_sample_v` AND) in
the flashed image. rx1 25 -> 12 is worth +2.6 dB in dsp (jump-free segments,
35.7/37.3 vs 39.1/39.0, duplicate control 0.1 dB).

Two earlier readings of this data were WRONG and are retracted: the "+18 dB per-sweep
scalar defect" (measured across the acquisition restarts and gain re-pushes my own
interleaved probe forced -- continuous operation shows +0.1 dB) and the "power-of-two
output normaliser" (an artifact of octave-folding the levels, which forces ratios of
~1 by construction; the level families were really the session's OTHER gain settings
landing via corrupted writes: 5.2x and 0.72x observed vs 5.03 and 0.66 physical).
Traps to keep: interleaving is wrong for anything reconfigured per chunk over a bus
that races, and folding data into one octave proves nothing about lattices.

### Tooling, kept in pi/radar/ because all of it is reusable

- **`probe_wobble.py`** -- drives `SFCWEngine` directly (stop `sdr_server` first) and
  records `h_signal` and `h_reference` SEPARATELY per step per sweep; the wire only
  carries their ratio. `--interleave N`, `--mode nios|standard|dsp`, per-block gain /
  `settle_count` / RFIC-tracking / grid overrides, `--keep-captures` for raw IQ.
  `freq_list` builds constant-frequency and fixed-jump grids: `[f]` retunes to the same
  frequency every step, `[f1,f2]` makes every step a jump of exactly f2-f1.
- **`analyze_wobble.py`** -- windowed worst-2-steps-trimmed S_repeat, adjacent-sweep and
  about-the-mean cv per channel, the common / signal-only / reference-only split, the
  additive-vs-multiplicative test, per-step robust-z, drift and lag-1.
- **`analyze_dwell.py`** -- re-demodulates sub-windows INSIDE each dwell from one stored
  capture, so "is anything still settling" is answered on identical data at every window
  position instead of across runs.
- **`analyze_adc.py`** -- what actually arrives at each ADC: DC, rms, peak, at-rail
  fraction, spectrum. `adc_peak` on the wire is one max over a whole sweep and says
  nothing about how often or at what frequency.
- **`rfic_regs.py`** -- direct AD9361 register access via `bladerf_get/set_rfic_register`
  (both ARE in the Python binding). libbladeRF enables every tracking calibration at
  init and exposes no way to change it; this reaches 0x169 and 0x18B. Baseline on this
  board is **0x169 = 0xCF, 0x18B = 0xAD** (everything on). `probe_wobble.py` snapshots
  and restores them, and rewrites the baseline before every block so a control cannot
  inherit the previous block's state.

`SFCWEngine` gained two default-OFF diagnostic flags for this, costing one bool test per
sweep when off: `keep_raw_channels` (leaves the per-step `(sig, ref)` in
`_last_channels`, before the division) and `keep_full_capture` (leaves the whole sliced
nios capture in `_last_capture`, ~8 MB/sweep). nios and standard only -- dsp divides on
the FPGA, so the halves do not exist on the host.

### Caveats

- **Nothing on the bench was touched.** The loopback could not be reseated and the
  antennas could not be re-aimed, so "the loopback cable/connector itself" was only
  tested by inference: at its best the reference reaches adj cv **0.014%** and at its
  worst 2.3%, and it is the session-to-session variable. When healthy it is not the
  binding term; when it episodes it is.
- **The numbers are scene-dependent.** The same rx1=12 config measured 41.4 dB in a
  quiet session and 35.0 dB in a disturbed one. The rx1 25-vs-12 DIFFERENCE is what
  interleaving protects and it held at +8.3 to +10 dB in every session that measured it.
- Phase and magnitude contribute about equally at the corrected gain (adj cv of |h_cal|
  0.98%, phase sd 0.058 rad), so this is not the magnitude-dominated effect it was
  assumed to be.
- The residual has a slow multi-sweep component (lag-1 of the fractional residual +0.7
  to +0.88), which is why deviation-about-the-block-mean reads ~5% where the
  adjacent-sweep number reads ~1%. S_repeat is insensitive to it by construction; a
  session lasting minutes is not.

## dsp FLUSH is 4x larger than it needs to be: 100 -> 136 Hz free (2026-09-20)

The dsp step is FLUSH (settle discard) + ACCUM (measurement) + guard. The default
`dsp_flush_sel = 2` picks FLUSH 512 samples (51.2 us). Measured: nothing is still
settling anywhere near that far past a retune, so most of it is dead time.

**FLUSH ladder, dsp mode, interleaved (40-sweep rotation), rx1=12, 800 sweeps each,
dwell held at 1728 to isolate the FLUSH quality floor from the rate:**

| FLUSH | S_repeat | corrupt | z>8 | zmax |
|---|---|---|---|---|
| 512 (default, x2 controls) | 40.2 / 40.1 dB | 0/780 | 0 | 5.1 |
| 384 | 40.1 | 0/780 | 0 | 5.4 |
| 256 | 40.1 | 0/780 | 0 | 5.1 |
| 192 | 40.1 | 0/780 | 0 | 6.0 |
| **128** | **39.9** | **0/780** | **0** | 5.5 |
| 64 | 39.9 | 0/780 | 1 | 8.2 |

Flat from 512 to 128 (0.3 dB, inside the control spread); 64 is where it starts to
soften (first z>8 cell, zmax 8.2). **FLUSH 128 is the settling floor** with a full
margin; 512 was 4x more than the AD9361 fastlock needs. Corruption is zero the whole
way down -- this does NOT reintroduce the retune-timing corruption `settle_count`
guards against in the host cores, because the FPGA gate releases the FIFO only on a
whole sweep.

**Rate, with dwell shrunk to match** (FLUSH 128 + ACCUM 1200 + 16 guard = dwell 1344):
**135.7 Hz at 39.9 dB, 0/1399 corrupt, 1/71400 robust-z cells (zmax 8.3)** over a
1400-sweep sequential confirmation. That is **+35% fps over the 100 Hz default at
unchanged quality**, and it costs nothing -- it is settling allowance that was never
being used.

**Shipping this means changing `DSP_DEFAULT_FLUSH_SEL` 2 -> 6 and `DSP_DEFAULT_DWELL`
1856 -> 1344** in `sfcw_engine.py` (both are the FLUSH-128 operating point). NOT done
yet -- wants the on-rig target-in/target-out check first, since FLUSH is settling and
this repo's history says settle changes ship quietly and regress (the 2026-08-23
`settle_count` 10->7). The per-step robust-z here is the right gate and it passed; the
target check is belt-and-braces.

**ACCUM is the OTHER knob and it is NOT free** -- it is coherent samples per step, so
halving it (sel 3->5, 1200->600) is -3 dB of per-step SNR for another ~1.35x rate. FLUSH
is the free one; ACCUM trades fps against dB. Fewer steps (`set_steps.py`) trades fps
against range resolution/ambiguity. All three are runtime (control bits 24:22 / 27:25 /
the step count), no reflash.

### Two guard bugs found while doing this (in `_sweep_core_dsp`, worth fixing)

Both make a dwell-vs-chain mismatch fail SILENTLY as a wall of fallbacks rather than
loudly, and both bit this investigation before the runs above were clean:

1. **The dwell guard runs BEFORE the chain is applied, against the STALE applied
   counts.** `need = sum(self._dsp_chain_counts())` at the top of the core returns
   `_dsp_chain_applied` -- the PREVIOUS chain still on the FPGA -- so lowering dwell and
   FLUSH together in one `set_params` is rejected against the old (larger) FLUSH+ACCUM,
   even though the new pair would fit. The chain is only re-applied further down, after
   the guard has already forced a fallback. Workaround used here: apply the new FLUSH at
   a high dwell FIRST (a short "warm" block), so `_dsp_chain_applied` is current, THEN
   drop the dwell. A real fix computes `need` from the pending selection
   (`DSP_*_TABLE[dsp_*_sel]`), not from the last-applied pair.
2. **A dwell below the chain does not warn once -- it fallbacks EVERY sweep**, at the
   full sweep rate, so the stream still "runs" (155 kHz of fallback sweeps in the probe)
   while producing 100% all-zero `h_cal`. The rate-limited log (30 s) is right for a
   transient but a permanent geometry error should latch and say so, the same way a
   too-long cfg does. Symptom to recognise: `sweep_core` all `fallback`, `h_cal` all
   zero, "dwell N is below the M the FPGA DSP chain needs" in stream.log.

### Probe support

`probe_wobble.py` blocks now take `dsp_flush_sel` (0-7), `dsp_accum_sel` (0-7) and
`dsp_dwell`, routed through `set_params` so the engine owns the rounding and the guard.
`scratchpad`-style scoring: rate from contiguous-run median dt, corrupt = adjacent
complex correlation < 0.999 within runs, plus per-step robust-z. Remember the FLUSH
tables: FLUSH sel 0..7 = 1088/768/512/384/256/192/128/64, ACCUM sel 0..7 =
2400/2000/1600/1200/1000/800/600/400, and dwell must be >= FLUSH+ACCUM (a multiple of
64, floor 1024 with the stepper).

## The Pi can host the groundstation: benchmarked under full load (2026-09-20)

Measured on the Pi 5 (4 cores) with the full stack (`start.py`) and a live sweep, to
answer whether a separate PC-side groundstation is necessary. **It is not, for
serving.** The groundstation is a browser app: the PC's only jobs were serving the
built frontend and running the browser. Serving moves to the Pi for free; the heavy
compute (SAR workers, IFFTs) runs in whichever CLIENT browser opens the page, never
on the Pi.

Sweep ran in **dsp mode at 135 Hz** throughout (the FLUSH-128 point is live). Rates
are median adjacent Pi-timestamp deltas from a binary websocket client, ~45 s each:

| condition | sweep rate | sdr_server CPU | system idle (of 4 cores) |
|---|---|---|---|
| stack + sweep + 1 GUI-like client | 134.94 Hz | 47% of one core | 83.6% |
| + continuous full app page-loads over HTTP | 135.18 Hz | 45% | 80.6% |
| + 3 concurrent binary websocket clients | 134.67 Hz | 58% | 77.5% |
| + full `vite build` running mid-sweep | 134.81 Hz | -- | -- |

- Serving is noise: `dist` is 1.4 MB total, one cold page load costs 36 ms of CPU
  time over loopback, and hammering ~2 app-loads/s moved nothing. (The initial
  benchmark used a throwaway `python3 -m http.server`; the shipped path below is
  Flask on port 5000 and re-measured the same: 135.17 Hz with all four services.)
- Each extra binary websocket client costs ~5% of one core at 135 Hz (encode+send in
  sdr_server).
- `vite build` on the Pi takes **9.2 s** and does not disturb the sweep, so the Pi
  can even be the dev machine for the frontend.
- Client-side compute is fine even on weak devices: one SAR reconstruction (66 pos,
  layered + SVD k1, Hanning, the detection-chain config) measures **154 ms in Node
  on this Pi** -- the same ~150 ms CLAUDE.md records for the i7 laptop, because a
  single reconstruction is single-threaded. Detection (42 reconstructions, pooled)
  scales with the client's core count: ~1.2 s on the laptop, ~2-3 s on a Pi-class
  client.
- App.jsx already defaults the Pi IP to 10.42.0.1, so a client joining `sfr-pi` and
  opening `http://10.42.0.1:5000` needs no configuration.

**SHIPPED same day: `start.py` now runs `groundstation/app.py` as its FOURTH
service.** The Flask app serves `frontend/dist` AND the `/api/models` BG-model
store on port 5000; every panel's model fetch is a RELATIVE `/api/models`, so
nothing frontend-side knows which machine Flask is on. Details that matter:

- **`app.py` debug is OPT-IN via `--debug` now** (was unconditionally `debug=True`).
  `run.py` passes it, so GS development keeps the Flask auto-reloader; `start.py`
  does not, because the reloader forks a child its `terminate()` would orphan and
  an unattended service must not restart itself on a half-saved edit.
- Flask 3.1.3 installed on the Pi via `pip3 install --break-system-packages`
  (same route as the adafruit libs; not in any Pi requirements file).
- Verified end to end on the Pi: all four ports up (5000/9001/9002/9003), index +
  hashed assets served with correct content types, `/api/models` list / POST /
  readback / 404 round trip, sweep at **135.17 Hz** alongside, and one SIGTERM
  stops all four with `[sdr] device closed` printed.
- **`groundstation/models/` on the Pi is now the canonical model store** shared by
  every client device -- it fixes the "models live only on the PC that saved them"
  problem this file records under the gw2 migration. The Pi's copy currently holds
  three older models; **`gw2.json` (offset-migrated) still needs its one-time copy
  from the PC.**
- Frontend dev workflow on the Pi: edit over VS Code Remote-SSH, `npm run dev --
  --host` (5173, HMR over LAN, `/api` proxied to Flask), deploy = `npm run build`
  (9.2 s) + refresh. The PC needs only a browser.
- The home screen (no panel open) has a **Fullscreen button** under the
  Groundstation title, for phones/tablets that have no F11. Its state tracks the
  `fullscreenchange` event, not the click, so leaving via the system gesture keeps
  the label honest. **On iPhone Safari the button is deliberately absent, not
  broken** -- iOS has no Fullscreen API for anything but `<video>`; Add to Home
  Screen is the fullscreen route there.
- Shell trap that bit during testing: `pkill -f 'python3 -u start.py'` matches the
  CALLING shell's own command line (the pattern is in it) and kills it mid-command.
  Use `pkill -TERM -f 'start[.]py'`-style bracketed patterns or kill the known PID.

## Pi-hosted WiFi network: the Pi IS the access point (2026-09-20)

The lab router / phone hotspot are no longer load-bearing. A TP-Link TL-WN823N v2/v3
USB dongle (RTL8192EU, in-kernel `rtl8xxxu`, AP mode confirmed on kernel 6.18) hosts
the network **`sfr-pi`** directly from the Pi; the Pi's built-in radio (`wlan0`)
stays an ordinary client for whatever upstream exists.

- **SSID `sfr-pi`, WPA2-PSK, channel 11, Pi fixed at `10.42.0.1`**, DHCP for clients
  at 10.42.0.10-254. The password is NOT in this repo (same rule as `rover/secrets.h`);
  read it with `nmcli -s -g 802-11-wireless-security.psk con show sfr-pi-ap` on the Pi.
- One NetworkManager profile, **`sfr-pi-ap`**, does everything: `802-11-wireless.mode
  ap` + `ipv4.method shared` gives the SSID, DHCP (NM's own dnsmasq) and NAT from
  wlan0, with no hostapd/dnsmasq/iptables config anywhere to maintain. Autoconnect
  priority 100, secret stored on disk (`psk-flags 0`), so it comes up headless at boot.
- **The profile is bound to the dongle's MAC (`20:E1:5D:3D:8D:C1`), not to the name
  `wlan1`** — a boot-order rename can never start the AP on the internal radio, and a
  missing dongle just means no AP rather than a hijacked wlan0. Keep it that way; if
  the dongle is ever replaced, update `802-11-wireless.mac-address`.
- **Field:** no upstream, nothing changes — join `sfr-pi`, `ssh sfr@10.42.0.1` (sshd
  listens on 0.0.0.0, same keys as always; `sfr.local` also resolves, avahi is up),
  groundstation Pi IP = `10.42.0.1` (now the App.jsx default when localStorage is
  empty). **Lab:** wlan0 joins the lab WiFi as before (192.168.1.x profiles untouched)
  and NM's masquerade rule gives every `sfr-pi` client internet through it.
- The AP subnet 10.42.0.0/24 was chosen to never collide with the lab's 192.168.1.0/24.
  If a future upstream ever uses 10.42.0.x, change `ipv4.addresses` on the profile.
- Recovery / inspection: `nmcli con up sfr-pi-ap`, `iw dev wlan1 info` (must say
  `type AP`), `pgrep -af dnsmasq` for the DHCP server, leases in
  `/var/lib/NetworkManager/dnsmasq-wlan1.leases`.
- **Range (estimated from live link stats, 2026-09-20): ~10-15 m line of sight, ~5-8 m
  through one wall; reported as unreliable beyond close range.** The dongle is a nano
  device with a PCB antenna; `txpower 30 dBm` on wlan1 is fiction (its own phy table
  caps at 20, realistic EIRP ~13-17 dBm), AP mode runs one spatial stream (all clients
  pin at MCS7 / 65 Mbit -- still 50x the 135 Hz sweep stream's need, so range not
  throughput is the limit). Measured failure point: a client at -57 avg / -68 dBm at
  the AP had already fallen back to 6 Mbit -- this receiver gives up around -60 to -65
  where a good AP works to -75. **Prime suspect for the early failure: USB3 desense
  from the bladeRF** (5 Gbps SuperSpeed radiates broadband noise at exactly 2.4 GHz,
  the documented Intel USB3/WiFi problem), sitting centimetres from the dongle and
  worst mid-sweep (nios mode streams ~80 MB/s of raw IQ; dsp mode is far lighter).
  **An extension cable for the dongle is ruled out by the enclosure** (operator,
  2026-09-20), so the available mitigations are: dress the bladeRF's USB3 cable away
  from the dongle / ferrite or better-shielded cable on the BLADERF side (fixes the
  source), and note a port swap for the 823N is electrically neutral -- it is a
  USB2-only device, only the centimetres change. `rtl8xxxu` does not report a noise
  floor (`iw survey dump` is empty), so score any change behaviourally: fixed-spot
  phone, sweep running, watch `rx bitrate` holding + `rx drop misc` growth in
  `iw dev wlan1 station dump` -- NOT `signal avg`, which desense does not move.
- **INSTALLED 2026-09-20: the AP now runs on a TP-Link Archer T3U Plus** (5 dBi
  external whip; USB id 2357:0138, RTL8812BU, in-kernel `rtw88_8822bu`, firmware
  27.2.0). It enumerated on the USB 2 bus at 480M -- deliberate, a USB3 device on
  a USB2 port cannot self-desense and 480 Mbps is ~50x the traffic -- `iw phy`
  lists AP mode, and `sfr-pi-ap` was repointed with one command
  (`802-11-wireless.mac-address` -> **78:20:51:AC:83:4E**); SSID, password, DHCP,
  NAT, 10.42.0.1 and autoconnect all carried over, beaconing verified on channel
  11. One `write register 0xc4 failed with -71` (EPROTO) in dmesg during first
  init, not repeated after the firmware re-init -- watch for it recurring before
  blaming anything else if the AP misbehaves. The 823N is unplugged and kept as
  the spare (MAC 20:E1:5D:3D:8D:C1; reverting is the same one-line MAC change).
  The T3U Plus also offers 5 GHz (ch 36-48 on its phy) -- the fallback if 2.4 GHz
  stays noisy next to the bladeRF, at the cost of wall penetration. Expected range
  roughly 2x the 823N (~25-40 m LOS, ~12-20 m one wall); **walk test with a phone
  still pending**, keep the whip vertical. Needing more than ~20-40 m honestly
  means mt76-class hardware (Alfa AWUS036ACM) or a travel router on Ethernet; the
  NM profile approach carries over either way.
- **Verified live 2026-09-20:** a laptop associated to `sfr-pi` (-36 dBm), took DHCP
  10.42.0.206, and held an SSH session to 10.42.0.1 alongside the old lab-network
  session. Reboot persistence is configured (autoconnect, secret on disk) but not yet
  exercised by an actual reboot.
- **Rover moved to `sfr-pi` (2026-09-20, code done, REFLASH PENDING).** `rover/secrets.h`
  on the Pi now carries `sfr-pi` / `PI_HOST "10.42.0.1"`, and `config.h`'s dormant
  `STATIC_*` fallback was moved off the stale 192.168.1.x values (pool is .10-254, so
  static picks .5). `build_check.sh` passes on the Pi (41/41 net checks, type check
  clean); `rover_server.py` binds 0.0.0.0 so 10.42.0.1:8765 needs no server change. The
  Pi is then ALWAYS at 10.42.0.1 for the board, lab or field. Note the firmware's
  recovery ladder pings the gateway, which on this network IS the Pi itself: "gateway
  answers" then means the Pi host is up, not that any router is — still separates
  "radio wedged" from "rover_server not running", which is what the ladder needs.
  After flashing, confirm the board's log shows a connect to 10.42.0.1 and that a
  `rover_server.py` restart still reconnects in ~10 s.

## Detection benchmark: `npm run bench`, and the first labelled set at rx1=12 (2026-09-20)

`groundstation/frontend/bench/` -- `corpus.json` (ground truth), `run.mjs` (scoring),
`register.mjs` + `resolve-ext.mjs` (a Node ESM resolve hook supplying the `.js` extension
Vite resolves for us). It drives the SHIPPED `lib/sarDetect.js` **in place** -- no copying
the lib to a scratch dir and rewriting its imports, which is how every previous check in
this file ended up measuring a copy free to drift. `projectRowsForDetect` moved from
`hooks/useSarDetect.js` into `lib/sarDetect.js` for the same reason: the harness splits a
saved scan into rows with the app's own function.

**Why it exists.** Every threshold in `DETECT_DEFAULTS` was fitted on the 2026-09-14
evening's scans at `rx1_gain = 25`, which 2026-09-19 showed was compressed (rx1=12 is
+8-10 dB of S_repeat). Gates stated in dB over a clutter median cannot survive a 10 dB
change in the clutter without being re-measured.

Scans are NOT committed (9 MB each): `--dir` says where they are, defaulting to the
corpus entry. `npm run bench -- --only 3pipe --ref "empty 2.json" --handle-ends --json
out.json`, plus `--opt k=v` and `--sweep k=a,b,c`. Reconstructions are cached per scan and
the empty reference's lines per (empty, plan), so a threshold sweep is `finishDetection`
only -- the whole 8-scan set is 12 s and each further sweep point is milliseconds.
`RECON_OPTS` lists the options that DO invalidate that cache (the depth band, the
guarded-fit window, `trimCols`); every other option is pure scoring.

### THE SCANS ARE NOT LATERALLY REGISTERED TO EACH OTHER, and nothing in the app knows

The first finding, and it invalidates the naive reading of any multi-scan set. The
operator jogs the rover to the start of each raster by hand, so **column 0 sits somewhere
different on the rail every time** -- this set spans 9 cm (`rover_x` at column 0 runs
2037.8 .. 2046.8 cm). Worse, **the rover's origin was re-declared mid-session**, so
`empty.json` and `1 pipe 12cm.json` (18:08, 18:12) are in a different odometer frame from
everything after 18:16 and read ~4.5-5 cm high. Confirmed independently: within a frame
the along-track radar residual correlates **0.94-0.99** at the lag the rail predicts,
across frames 0.72-0.89 at a lag that does not fit.

Consequences:

- **The empty reference is matched column-for-column, so it is applied in the wrong
  place.** `empty.json` scored against `empty 2.json` -- two scans of the same bare wall
  21 minutes apart -- still yields a **confirmed 10.4 dB "target" at x 32 and a probable
  at x 61**, because the 8 cm frame offset puts every reference line past `refMatchCm`
  (2.5 cm). Registered (`empty 2` against the later targets, same frame, within 2 cm) the
  veto works: the wall feature at rail ~2073.8 cm, confirmed at 8-12 dB in EVERY scan of
  this set, is cancelled in each of them.
- **A rail coordinate is available and free**: every cell already carries `rover_x_mm`,
  and `railOriginCm()` in the harness fits `x = a + hStep*grid_ix` over all 420 cells to
  get column 0's rail position. Registering an empty reference by that (with a
  cross-correlation fallback) is a small change with a large payoff -- see next steps.
- **Do not cross-correlate masonry to register scans without a sanity check.** Brick
  courses are quasi-periodic at ~15-23 cm; `empty` vs `empty 2` peaked at +7 cm where the
  rail says -8, i.e. one course out. A fixed-width window is mandatory too (the
  shrinking-overlap trap this file already records).

Ground truth is a tape on the wall, so the corpus maps a label to a column through
`label + tapeZeroRailCm[frame] - railX0Cm(scan)`. **`tapeZeroRailCm` is ONE fitted number
per frame, and it has to be fitted against CONFIRMED detections only** -- a first attempt
fitted it against every detection above 5 dB, which are dense enough that some detection
matches any offset, and it produced a confident "the rover x axis is 10% out" that is not
there. Residual +-1.5 cm; the same labelled position lands up to 3 cm apart in different
scans, so **the truth is +-3 cm and the position metric is limited by the tape, not the
detector.**

### What the detector actually does on this set

8 scans, 70 columns x 1 cm, 6 rows x 2 cm, rover continuous at 100 mm/s, rx1=12,
range_offset 0.378, empties bracketing the session. Defaults, raw ratings:

| reference | rated | present | false alarms |
|---|---|---|---|
| none | 8/12 | **12/12** | 17 (2.13/scan), 7 of them at the row ends |
| `empty.json` (wrong frame, 8 cm off) | 8/12 | 12/12 | 6 (0.86/scan) |
| `empty 2.json` (registered) | 7/12 | 12/12 | 5 (0.71/scan), 3 on target scans |

- **Every one of the 12 labelled pipes produces a detection within 1-2 cm. The sensing is
  not the problem; the RATING is.** Position bias is **+0.04 cm** and median |dx| **1.0 cm**
  against a +-3 cm truth, so nothing here supports the old set's "+1 cm bias" being real.
- **The misses are all the far pipes (x 46-64 cm) and they fail the `rows` test**, seen in
  2-4 of the 6 rows rather than the 4 required: 6.1 dB/3 rows, 8.7 dB/2 rows, 5.9 dB/4
  rows, 10.6 dB/2 rows. Not prominence -- relaxing `confirmedProminenceDb` does nothing.
- **`rowSupportDb` is the binding gate, and it was set at the old gain.** Swept against the
  registered reference: **6 dB (shipped) 7/12 at 0.50 false/scan on target scans; 5 dB
  8/12; 4 dB 11/12 at 1.00 false/scan, every new false alarm a `probable` at 6.1-8.2 dB.**
  `rowSupportFrac` 0.6 -> 0.3 is a weaker version of the same trade (10/12). **Left at the
  default**: 12 targets on one wall is exactly the sample size that produced the thresholds
  now being corrected. It wants a second labelled set first.
- **The same physical position rates differently depending on what else is in the scan**:
  the far pipe is confirmed 6/6 at 8.6 dB in `1 pipe 48cm` and rates 2-3/6 at the same
  place in the multi-pipe scans. Suspect the clutter removal -- rank-1 SVD and the guarded
  fit (20-column window, 6-column guard) both have a neighbouring pipe 15-19 cm away inside
  their support. Untested.
- **Sidelobe suppression ate a real pipe** in an earlier run: a 9.2 dB / 5-of-6 line 5 cm
  from a stronger confirmed was dropped by `sidelobeCm = 6`. Turning it off costs 5 extra
  false alarms on this set, so it earns its keep -- but it is a fixed 6 cm rule sitting at
  roughly the spacing pipes are actually placed at here.
- The standoff falls **14-28 mm across the 70 cm** of every scan (the rail is ~1-2 deg off
  parallel). SAR corrects standoff per cell, but the along-track clutter models do not: the
  wall echo rotates ~12 deg/mm at 5 GHz, i.e. several turns across a row.

### Next, in order

1. ~~**Register the empty reference to the scan**~~ -- **DROPPED on the operator's
   instruction (2026-09-20): the rover start moving a few cm between rasters is expected,
   and a scan's detection must be self-contained.** The registration measurement stands and
   is why any cross-scan work needs the rail coordinate, but the empty reference is no
   longer the mechanism the detector leans on for false alarms; the depth class below is.
2. **A second labelled set** before touching `rowSupportDb`: same protocol (bracketing
   empties, tape on the wall, positions recorded) on a different wall or a moved rig, so
   the thresholds answer to more than one geometry.
3. **Check the rover x scale against a tape** (jog 600 mm, measure it). The label residuals
   do NOT show a scale error, but the wheel calibration is empirical, it sets the SAR
   aperture scale, and it has never been checked against anything but itself.

### Second round on that set: DEPTH separates a pipe from a wall feature (2026-09-20)

The corpus now carries both labelled sets -- `sfr-2026-09-20` (8 scans, 70 x 1 cm, 6 rows
x 2 cm, rx1=12) and `gw2-2026-09-13` (7 scans, 140 x 0.5 cm, 6 rows x 1 cm, rx1=25, the set
the current thresholds were fitted on, labels in scan coordinates) -- so nothing is changed
on the evidence of one geometry again. `--set gw2-2026-09-13` runs the older one.

**The operator's corrections to the first round, which the corpus now encodes.** The rover
start position moving a few cm between rasters is normal and expected; a scan is
self-contained and the detector must not depend on cross-scan registration. An empty scan
is "good enough" if it produces no detections of its own, whether or not it lines up with
anything else. And the feature at **36 cm is a REAL wall defect, the only one** -- present
in every scan including both empties, not a target and not a false alarm. `knownFeatures`
in the corpus holds it, and the harness counts a rated detection there separately.

### Targets sit BEHIND the back face; wall features sit inside it

The measurement, over every rated detection of the 2026-09-20 set with no reference:

| | depth |
|---|---|
| on a labelled pipe (n=9) | **16.0 - 19.4 cm** |
| everything else, defect included (n=9) | **12.2 - 15.9 cm** |

**PARTLY SUPERSEDED the same day**: this was measured at er 5.4, and an in-wall echo maps to
`(R-s)/n` while a beyond-wall one maps to `T + (R-s-nT)`, so the gap between them grows with
n whatever is really there. At the calibrated er 4.84 it shrinks to 1.6 cm. See "Third
round" below; report `depthBelowWallCm`, do not lean on the `behindWall` boolean.

against a 15.2 cm wall. The split is clean and it is not a fitted threshold -- it is the
back face. Widened to every detection above 4 dB (n=71), depth >= the wall thickness keeps
21 of 23 pipe detections and rejects 39 of 48 of the rest.

So every target now carries **`depthBelowWallCm`** and **`behindWall`** (margin
`behindWallMarginCm`, 0.2 cm). **Reported, not gated**: the defect is worth seeing, and
gating the search band to 15-20 cm loses it in half the scans (known-feature hits 7/8 ->
4/8 on the new set, 5/7 -> 1/7 on the old one) while buying the same false-alarm reduction
the class gives for free. The benchmark reports false alarms split by it; on the new set 3
of the 4 are inside the wall, on the old set 0 of 2.

### This is also the answer to "why does the 36 cm defect image at the back of the wall"

It images at **12.2-15.9 cm in every scan**, i.e. at the back face, which on a 20 cm depth
axis is the top of the picture. It is not at the end LATERALLY -- it sits at x 32-36 cm of
a 70 cm scan, mid-image, exactly where the tape says.

Measured at its own column with SVD off, it has **no excess at all in the near surface**:
at 0-2 cm depth that column reads 9-13 dB BELOW its neighbours, and its excess appears
only from ~12 cm. So the radar sees no reflecting discontinuity where the defect meets the
front face. That is what a plane roughly parallel to the beam does -- a crack or joint
scatters almost nothing broadside along its length, and what returns comes from where it
meets an interface. The front-face end also sits inside the coupling band that the
along-track clutter removal takes out. If it is a void, the faster propagation through it
also puts its image slightly in front of the true back face, which matches the 12-15 cm
reading against a 15.2 cm wall.

### Where the remaining misses are, and the rank experiment

At the shipped defaults, no reference, ends handled: **new set 8/12 rated, 12/12 present,
4 false alarms (0.50/scan, 1 behind the wall); old set 10/10 rated, 2 false alarms
(0.29/scan)**. Position bias +0.04 cm on the new set, median |dx| 1.0 cm.

All four misses are the far pipes (x 46-64 cm), all failing the `rows` test, and the reason
is visible per row: the near pipes hold 9-13 dB over their row median in **all six** rows
while the far ones fade upward -- 6.3, 7.4, 8.8, 4.5, 1.2, -4.8 dB from the bottom row to
the top. Same physical position, `1 pipe 48cm.json`, single pipe: 11.5 down to 7.9, no fade.
So it depends on what ELSE is in the scan, which points at the clutter removal.

**`svdK` is now an option (default 1) because rank 2 is what recovers them -- on ONE of the
two sets.** Per-row dB at the far pipe, 2026-09-20: rank 1 gives 16.8, 7.9, 3.8, 0.0, -9.4,
-11.7; rank 2 gives 14.6, 9.1, 13.0, 8.8, 9.8, 7.0. End to end, rank 2 takes the new set to
11/12 (12/12 with the band at 15-20) -- **and takes the old set from 2 false alarms to 6**,
with no recall gain. Rank 3 collapses both (20 false alarms, position error 3 cm), matching
the 2026-09-03 sartt.json note. The obvious explanation, that a standoff ramp makes the
wall echo higher-rank, does NOT hold: both sets ramp by the same 4-29 mm. **Do not ship a
fixed rank on this evidence.** What the two sets say is that the right number of components
varies, so the fix is a clutter model that chooses -- an adaptive rank from the singular
value spectrum, or an explicit fit of the wall term -- not a constant.

**`sidelobeVsAnyRating` (default 0, i.e. unchanged) records the other near miss.** With the
band at 15-20 and rank 2, all six residual false alarms were 3-8 cm from a detected pipe and
about 2 cm shallower, i.e. its sidelobes -- and none was suppressed, because the rule only
lets a CONFIRMED neighbour suppress and those pipes rated `probable`. Letting any stronger
line suppress kills 4 of the 6 **and 2 real pipes with them**: a sidelobe can outscore the
pipe it belongs to (8.9 dB against 7.4). Suppression needs a better rule than "stronger" --
prefer the deeper one, or merge the pair and keep the more target-like member.

### The guarded fit's window is in CENTIMETRES now, not columns

`trimCols` 8 and `guardedWindowCols`/`guardedGuardCols` 20/6 became `trimCm` 4 and
`guardedWindowCm`/`guardedGuardCm` 10/3, converted with the scan's own pitch. At 0.5 cm they
reproduce the old column counts exactly, so the 2026-09-13 set is bit-identical; at the
1 cm pitch the operator now uses, the old constants silently doubled the physical support --
a different clutter model for the same wall. Neutral on this set's score (it picks the known
defect up in one more scan) but it removes a way for the detector to change behaviour when
someone changes the pitch.

### Third round: the wall's permittivity and the integration aperture (2026-09-20)

Two changes shipped, both physical constants rather than thresholds, both measured on BOTH
labelled sets. Score at the shipped defaults (er 4.84, 45 degree aperture), ends handled:

| | rated | present | false alarms, no reference | with a reference | bias | median \|dx\| |
|---|---|---|---|---|---|---|
| 2026-09-20, 8 scans / 12 pipes | **11/12** | 12/12 | **0.25/scan** | 0.14/scan | -0.98 cm | 1.04 cm |
| 2026-09-13, 7 scans / 10 pipes | **10/10** | 10/10 | 0.29/scan | 0.17/scan | +0.50 cm | 0.50-1.00 cm |

against 8/12 and 10/10 at the start of the day. **Both empty scans produce no false alarms
at all without any reference**, and the only two false alarms in the whole newer set are
`probable` lines 4 and 7 cm from a detected pipe in one scan -- its sidelobes. **The
rightmost pipe, 2 cm from the end of the scan, is now confirmed** (11.5 dB, 6/6, -3.0 cm),
where it was unrated before and a total miss at er 7.

### er = 4.84 (n = 2.2), air = 1

The operator's own calculation, and it is inside the band three independent measurements
agree on. The benchmark cannot separate 4.6 from 5.2 -- every value in that range gives
11/12 and 10/10 -- so the derived number is taken rather than the score-optimal one.

1. **The back-face echo.** `permittivityEstimate` returns a COMB of candidates at
   separations of ~24, 34, 48 and 60 cm -- a multiple-reflection train, not one wall answer.
   The 33-36 cm line is the wall: er 4.8-5.8 at a 15.2 cm wall. n*T = 2.2 * 15.2 = 33.4 cm
   lands on it.
2. **The operator's criterion**, that the defect image inside the wall and the pipes behind
   it -- but see the correction below on how much that can carry.
3. **Detection score over both sets**, which has a peak because a correct velocity is what
   focuses a hyperbola: er 4 -> 10/12, **4.6-5.2 -> 11/12 and 10/10**, 5.4 -> 9/12,
   6 -> 9/12 and 9/10, 7 -> 9/12 and **7/10**, 8 -> 6/10.

**er 7 costs 3 of the 10 targets on the 2026-09-13 set** and doubles the false alarms.
`sarEpsilonR` now defaults to 4.84 (was 5.4). **er and wall thickness are degenerate**:
what the data measures is n*T = 33.4 cm, which with n = 2.2 gives T = 15.18 cm, matching the
measured 15.2 -- the geometry is self-consistent.

**CORRECTION to the second round's depth claim.** That round measured, at er 5.4, pipes at
16.0-19.4 cm and every other rated detection at 12.2-15.9, and called the split clean. Part
of that gap was the velocity: a feature INSIDE the wall maps to `(R - s)/n` and one BEYOND
it to `T + (R - s - nT)`, so the gap between an in-wall and a beyond-wall echo grows with n
by construction. At the calibrated 4.84 the picture is:

| | depth |
|---|---|
| pipes (n=11) | median **16.9** cm, 15.1-17.7 |
| the 36 cm defect (n=7) | median **15.3** cm, 14.1-16.4 |

i.e. the defect sits ON the back face and the pipes about **1.6 cm** behind it -- which is
physically right for pipes taped to the far side (the scattering centre of a 3 cm pipe sits
about a radius behind the face) and for a void that reaches the back face. But 1.6 cm is far
inside one 5 cm range cell, so **depth alone is NOT a reliable classifier at this
bandwidth**, and `behindWall` at the default 0.2 cm margin puts the defect on the wrong side.
Keep `depthBelowWallCm` as the reported measurement; do not lean on the boolean. The
apparently clean separation at er 5.4-7 was the wrong velocity stretching the axis, which is
also why the defect "looks" further inside the wall the larger er is set.

### The back-projection now integrates a bounded angle, and that is what found the end pipe

`accumulateRow` summed EVERY position into every pixel. On a 70 cm scan a pixel 17 cm deep
was therefore integrated over +-35 cm of aperture, i.e. **out to 64 degrees**, where the
antenna barely illuminates and the refracted ray is near grazing: little signal, full
clutter. `apertureAngleDeg` (default **45**) limits it to `tan(theta) * (depth + standoff)`;
0 restores the old behaviour. Measured at er 5, both sets:

| half-angle | new set | old set | median \|dx\| new / old |
|---|---|---|---|
| unlimited | 11/12, 0.38 fa/scan | 10/10, 0.29 | 1.46 / 1.00 cm |
| 60 | 11/12, 0.38 | 10/10, 0.14 | 1.04 / 1.00 |
| **45** | **11/12, 0.38** | **10/10, 0.29** | **1.04 / 0.50** |
| 40 | 10/12, 0.63 | 10/10, 0.43 | 1.46 / 0.50 |
| 20 | 3/12, 0.13 | 7/10, 0.00 | collapses |

The false-alarm column jitters by +-2 events, which on 19 targets is noise; what moves
consistently is the **position error, which halves on both sets**. 45 degrees is also
roughly where the beam physically is, so it is the value taken rather than the FP-optimal
one. The SAR panel's own image uses the same limit, so the picture and the markers are built
from the same contributions.

### Three things that were tried and REJECTED by the second set

Each is kept as an option, defaulting to the old behaviour, with its measurement -- so the
next labelled set can re-test them cheaply instead of rediscovering them.

- **`apertureNormalize`** (divide the sum by the number of contributions). Motivated by the
  end pipe being dim for want of aperture. Measured: **no effect at all** with the angle
  limit off, because every pixel in the search band is reached by every position, so the
  divisor is a constant. With the limit on it HURTS (11/12 -> 9/12): it boosts exactly the
  thin-support pixels whose sums are noisiest. The end pipe's problem is not fewer
  contributions but a ONE-SIDED aperture, which no scaling fixes.
- **`svdAdaptive` / `spreadFraction`** -- choose the clutter rank per scan by removing
  components while their spatial pattern is delocalised along the scan (participation ratio
  of the left singular vector over the aperture: a wall is at every position, a scatterer is
  seen from `2 z tan(theta)` of it). The statistic works, but **noise is delocalised too**,
  so it keeps removing: 11/12 -> 7/12 with the detections themselves gone (present 12/12 ->
  8/12). An energy gate does not rescue it -- measured per component, the share of the
  REMAINING energy stays at 60-90% out to component 5, and only the share of the ORIGINAL
  energy knees (about 80% / 18% / 1.4% / 0.3%), which picks rank 2 everywhere, and fixed
  rank 2 is what the old set rejects (2 -> 12 false alarms).
- **`baseClutter: 'gfit'`** -- promote the physical along-track fit (coupling + a wall term
  driven by the measured LiDAR standoff) from cross-check to primary, on the reasoning that
  it models a non-parallel rail where an SVD cannot. Same recall on both sets, more false
  alarms (new 3 -> 5, old 2 -> 11). The SVD stays the base and the fit stays the
  cross-check, which is the test that asks whether two different clutter models agree.

**The one target still unrated** is the 50 cm pipe of `3 pipe 15cm 31cm 50cm.json`: present
at 7.5 dB with 3 of 6 tests, failing the `rows` gate. The same physical position is
confirmed in three other scans, so this is not a sensing limit; it is the clutter removal
being contaminated by the other two pipes in that row. That is the next thing worth
attacking, and it wants a clutter model that is told where the targets are NOT (the guarded
fit's idea, with a guard that adapts) rather than a different rank.

## Measured permittivity of the bench wall materials (2026-09-20)

Method (operator's, and it is the good one): antennas touching the wall, capture a
background, then introduce a METAL PLATE flat against the far face. The plate is the only
thing that changed, so the differenced profile holds one unambiguous echo, and its apparent
range is `sqrt(er) * thickness`. Better than reading a back-face echo, which on a
low-permittivity block is weak and easily confused with whatever is behind it.

| wall | thickness | plate apparent range | er (raw) | er (slant-corrected) | expected dry |
|---|---|---|---|---|---|
| cement | 15 cm | 33 cm | 4.84 | **4.68** | 4.5-6.5 |
| red clay brick | 21.5 cm | 51 cm | 5.63 | **5.55** | 4.5-6 |
| AAC block | 15 cm | 36 cm | 5.76 | **5.60** | **1.8-2.5 -- WET, see below** |

**The AAC reading is moisture, not a measurement error.** Two of the three materials land on
their textbook values by the same method, so the method is sound. AAC leaves the autoclave at
20-35% moisture by weight and takes months to reach its ~5% equilibrium; er = 5.6 needs about
14% water by volume, i.e. ~28% by weight on a 500 kg/m3 block. Weigh it (dry AAC is
400-700 kg/m3), dry it, and re-measure -- the drying curve is er vs moisture content for AAC
on this bench, which is exactly what the seepage detector wants. Note **dry AAC at er ~2 will
never be the estimator's highlighted pick** (`ER_PLAUSIBLE_MIN = 3` in
`permittivityEstimate.js`); it appears only as a chip. Do not widen that window: er ~2.4 is
where the rig echo poses as a back wall.

**Slant-path correction.** TX and RX are separated, so the path is two slant legs, not
straight down and back: `R = n*z + (d/2)^2 / (2*z*n)`. The table above assumes a 12 cm
baseline; it is only a few percent. **Measure it instead of assuming**: put the plate at a
known distance in AIR and read what the UI reports (a 12 cm baseline at 15 cm reads 16.2 cm,
not 15). That one capture calibrates the baseline and any residual range-offset error at once.
Better still, measure two thicknesses and take the SLOPE, which needs no offset at all.

**Attenuation, corrected 2026-09-20 -- an earlier note in this conversation doubled it** by
multiplying a two-way-per-cm figure by the round-trip path as well. One-way
`alpha[dB/m] = 8.686 * pi * f * sqrt(er) * tan d / c`; two-way loss through thickness t is
`2 * alpha * t`. At 3.5 GHz: cement (tan d 0.05) 0.74 dB/cm two-way -> **11 dB** through
15 cm; red brick (0.04) 0.60 dB/cm -> **13 dB** through 21.5 cm; dry AAC (0.02) 0.18 dB/cm ->
**2.8 dB** through 15 cm. So a dry AAC block should return the plate about **8 dB** stronger
than the cement one under identical gains -- an independent wet/dry test needing no new
capture. Consequence for the "use 5-10 GHz" question: the extra loss from moving the centre
3.5 -> 7.5 GHz is ~13 dB through 15 cm of cement, not ~26, which IS inside the 16 dB of
transmit headroom. The answer is still no, but on the clutter argument alone (clutter scales
with power, and texture scattering grows with frequency), not on the loss arithmetic.

**Set `sarEpsilonR` per material** -- 4.7 cement, 5.6 red brick, ~2 for dry AAC. A wrong er
was measured at **11 dB** of lost target contrast in the 2026-09-03 ablation, more than every
other SAR parameter combined.

**AAC confirmed WET (2026-09-20).** Block is 60x15x20 cm = 0.018 m3 at **12.1 kg = 672
kg/m3**. Solving the mixing model at er 5.6 gives **538 kg/m3 dry skeleton + 134 kg/m3 water**,
i.e. an ordinary **grade-550 block at ~25% moisture by weight** -- what a block fresh from the
autoclave or stored damp looks like. **Density alone could not have shown this** (it says
nothing about what fills the pores); two things did. (1) **Offsets cannot explain the
reading**, because the cement and AAC blocks are BOTH 15 cm thick in the same geometry, so
range offset, cable delay and the slant term all cancel in the difference:
`sqrt(er)_AAC - sqrt(er)_cement = (36-33)/15 = 0.20` whatever they are. (2) **The plate echo is
much weaker through the AAC than through the cement** -- the wet branch of the 20 dB fork
above (dry would be ~8 dB STRONGER, wet ~12 dB weaker).

Note the block is still easy to lift while the cement one is barely liftable. Lightness is
density; permittivity follows what fills the PORES. At 13.4% water by volume the water
contributes 1.18 of the 2.37 total sqrt(er), MORE than the 22% solid skeleton's 0.53 -- so wet
AAC and dense cement read nearly the same er by opposite routes.

Drying curve (`sqrt(er) = 1.312 + 7.85*theta`, theta = water by volume; mass = (538 +
1000*theta)*0.018). Worth logging as it dries: it is the er-vs-moisture calibration the
seepage detector needs, and weight and apparent range must move TOGETHER or the model is wrong.

| water (vol) | weight | er | plate at, 15 cm |
|---|---|---|---|
| 13.4% (now) | 12.1 kg | 5.6 | 35.4 cm (measured 36) |
| 10% | 11.5 kg | 4.4 | 31.5 cm |
| 5% | 10.6 kg | 2.9 | 25.6 cm |
| 2.7% (= 5% by weight) | 10.2 kg | 2.3 | 22.9 cm |
| 0% (oven dry) | 9.7 kg | 1.7 | 19.7 cm |

**~4-6% by weight (~10.2 kg) is AAC's indoor equilibrium**, so that -- not the oven-dry 9.7 kg
-- is the realistic target, and there is ~2.4 kg of water to lose. **Do not use this block as
the "clean low-loss test bed" until it is dry**: wet it is the lossiest of the three walls,
not the least.
