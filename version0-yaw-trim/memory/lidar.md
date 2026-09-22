# LiDAR — TF-LC02, three heads

**Purpose** — standoff (antenna to wall) for the radar, and three-axis position for the
handheld module.

**Location** — driver `pi/sensors/tflc02.py`, polled by `pi/sensors/stream.py`.
Wiring and pinouts in `CONTEXT.md`.

---

## The three heads

| role | port | feeds |
|---|---|---|
| **forward** | `/dev/ttyAMA2` | the standoff every radar consumer reads |
| right | `/dev/ttyAMA3` | handheld X |
| down | `/dev/ttyAMA1` | handheld Y |

`LIDAR_PORTS_DEFAULT` is that list in that order, and **the first port feeds the legacy
`lidar`, `lidar_seq`, `lidar_ts`, `lidar_err` and `lidar_last_good_*` fields**. Every standoff
consumer reads those — the SFCW, C-scan and BG Model readouts, continuous BG capture, SAR's
per-cell correction, `capture_bgmodel.py`, and the rover's `track` steering. **No consumer
names a port**, so reordering that list moves all of them at once.

The packet also carries `lidars: {uart1, uart2, uart3}` with a full record per head, and
`lidar_primary` naming which one the legacy fields mirror.

**UART0 is dead on this Pi** — its receive path specifically, inside the RP1. Transmit works,
the pins are fine, a bare loopback on another UART is fine, but `TIOCGICOUNT` shows rx pinned
at exactly 0 with no frame or overrun errors. `uart0-pi5` is commented out in
`/boot/firmware/config.txt`. Do not move a head back to `/dev/serial0`.

If the forward head's mounting changed in the three-head rewire, **re-measure
`lidar_antenna_offset_mm`** and treat background models captured on the old head as suspect.

---

## The sensor measures at 11-17 Hz and cannot be made faster

Confirmed two ways: polling at 584 Hz gives a median run of 34 identical consecutive reads, and
the internal rate falls with distance (17.2 Hz at 165 mm, 11.5 Hz at 340 mm) — adaptive
integration time, not a settable frame clock.

The UART protocol has six commands: get distance, crosstalk correction, offset correction,
reset, get factory settings, get product info. None sets a rate or an integration time.
**Never send crosstalk or offset correction** — they run the factory calibration and store the
result, and need a dark box and a target.

Getting ≥30 Hz means a different sensor or IMU fusion.

## Why it is polled at 200 Hz anyway

`LIDAR_POLL_HZ = 200`. Polling faster cannot produce more measurements — what it buys is a
**tight timestamp**, which continuous background capture and the handheld position track
interpolate against. At 20 Hz a measurement was learned up to 50 ms late; at 200 Hz, 5 ms.
It is free: measured at 584 Hz the broadcast rate was unchanged and the IMU rate slightly
better.

**What makes that safe is that `lidar_seq` counts MEASUREMENTS, not reads.** It advances only
when the value changes, or when a stable value ages past `LIDAR_STABLE_REPUBLISH_S = 0.25`.
Publishing 200 reads/s of a 14 Hz value would make `lidar_n` count duplicates and `lidar_std`
measure the spread of a repeated number.

The republish timeout exists because value-change detection is unreliable on a static target —
1 mm quantisation against ~0.7 mm of raw sigma means ~40% of consecutive measurements land on
the same integer. 0.25 s sits well above the slowest observed internal period (~87 ms), so it
can never fire between two genuinely new measurements.

## Noise

σ over a 250 ms window is 0.40 mm at 165 mm, 0.43 at 262, 0.56 at 340. Raw σ ~0.66-0.78 mm,
1 mm quantisation. Averaging follows τ^-0.12 to τ^-0.30, far shallower than white noise, and
plateaus by ~2 s — **longer averaging does not rescue it**; there is a correlated floor around
0.15-0.33 mm.

There is also a slow **zero-drift of ~1 mm over minutes**, invisible to within-capture
statistics. The radar is the better position sensor at this scale: range-gating the complex
difference to the wall region resolves ~0.05 mm where the LiDAR's reading wandered a
millimetre. Use the wall-gate phase, not the LiDAR, to decide whether the rig moved.

`pi/sensors/lidar_noise_char.py` measures this at a given distance.

---

## Dropouts are the sensor refusing to range, not the link

A dropout is the module **answering every command** with a non-zero `error_code` and a literal
distance of **8888** — its out-of-range sentinel. Measured: 33,825 rejected reads, all exactly
8888, without exception. So nothing usable is discarded by rejecting them, and returning 8888
would put the standoff at 8.888 m and destroy any background model.

The UART underneath is spotless: a clean 1:1 of commands to replies, zero frame, parity,
overrun or break errors over 100 s.

Short range is flawless — 37,211 consecutive reads at 300 mm with zero failures, at three times
the rate `stream.py` polls. **Polling hard does not break it.** During a real C-scan the
standoff is 130-400 mm, where the module is measurably perfect.

`error_code` is a **bitfield**, not an enum. An isolated miss is almost always bare `4`; a
sustained out-of-range run raises bits 1, 4 and 5 as well, giving 4 / 6 / 20 / 22 together in
the hundreds. Useful as a signature, but both carry 8888, so the difference is in how the
module grades its own failure.

`read_distance_detail()` reports `oor:<code>` (distance was 8888) separately from
`sensor:<code>` (non-zero code with a plausible distance — never yet observed) and `link:*`
(the module did not answer at all). `is_link_reason()` separates the two classes, which demand
opposite responses: aim versus power and wiring.

There is **one parse path** — `_read_response` returns `(dist, error_code, reason)` and the
three public methods are thin wrappers. It used to carry two hand-copied parsers.

`stream.py` logs a dropout in plain words, and **the rate limiting is load-bearing**: nothing
prints below `LIDAR_DROPOUT_WARN_S = 1.0`, which is exactly the moment the standoff actually
goes null in the UI, and a persisting dropout repeats only every
`LIDAR_DROPOUT_REPEAT_S = 15`. A healthy stream and a 40%-scattered-invalid stream are both
completely silent. That silence is the point.

---

## Diagnosing a missing standoff

1. **Sidebar IMU Hz tile blank** — the sensor stream on port 9001 is down. Check `stream.py`'s
   stdout on the Pi.
2. **Hz live but standoff `—`** — the stream is up and `read_distance()` is returning None.
   The packet carries `lidar_err` naming the cause; read it rather than guessing.
3. **Runs of adjacent invalid cells plus a dropout line in the Pi log** — the sensor could not
   range. Re-aim.
4. **Isolated invalid cells and the Pi log SILENT** — it is not the LiDAR. A transport fault is
   invisible to the sensor's own log by construction.

**Do not re-run the 2026-08-24 wiring investigation.** It was real and is fully resolved (the
dead UART0 receiver). Every later dropout is a different failure with the same symptom.

## Change history

- `read_distance()` used to return 8888 as a real reading, because the `error_code` byte was
  computed and never checked.
- A dead LiDAR used to cap the whole sensor stream at ~10 Hz, because its 100 ms timeout was
  awaited inline in the broadcast loop. Each sensor now polls in its own task.
- Three heads replaced one on 2026-09-15; the forward head moved from `ttyAMA3` to `ttyAMA2`.
