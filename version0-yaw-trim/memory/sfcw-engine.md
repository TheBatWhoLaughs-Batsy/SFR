# SFCW sweep engine

**Purpose** — step the radio across 2-5 GHz, measure the complex transfer function at each
step, and publish one calibrated sweep.

**Location** — `pi/radar/sfcw_engine.py`, on top of `pi/radar/bladerf_driver.py` (HAL),
published by `pi/radar/sdr_server.py` on port 9003.

**Output** — `h_cal = h_signal / h_reference`, one complex value per frequency step. The
antenna path is TX1 to RX1; the reference is a TX2-to-RX2 cable loopback that divides out
everything the two paths share.

---

## Three sweep cores

`sweep_mode` is a runtime `sfcw_set_params` field. Every `sfcw_result` carries `sweep_core`
naming what actually ran — `nios`, `fallback`, `standard` or the dsp equivalent. **Any metric
computed without splitting on that field is measuring a mixture of two sweep flavours.**

| mode | who retunes | who demodulates | 51-step rate |
|---|---|---|---|
| `standard` | the host, over USB, per step | the host | ~18 Hz |
| `nios` | FPGA firmware, from a primed profile table | the host, slicing a continuous capture | ~36 Hz |
| `dsp` (**default**) | FPGA logic at an exact 80 MHz tick | the FPGA | ~136 Hz |

The rate is diagnostic on its own — see `fpga-images.md`, where ~18 Hz means something
specific and is not merely "slow".

### `nios`: slicing a continuous capture

The firmware fires steps on a dwell grid and the host finds the step boundaries in the
**reference** channel, then slices. Three things are load-bearing:

- **Alignment is derived from the reference channel only.** RX2 is a cable loopback, so
  nothing in front of the antenna can change it — that is what makes slicing immune to the
  scene. Never feed the signal channel, `h_cal`, or a previous sweep into the decision.
- **T0 is anchored structurally.** A complete transient lattice spans exactly `n-2` periods,
  which makes the first member provably step 1. A lattice one period short is ambiguous and
  **nothing inside a single sweep can resolve it** — both channels shift together, so the
  result is a valid measurement of the neighbouring frequency. The gate refuses that sweep.
- **A resolver that compares against a previous sweep or a template cannot work** and was
  removed. Against the previous sweep it is bistable; against a template it confuses a scene
  change with a mis-slice, so inserting a target makes it rotate correct sweeps and latch.

Fallbacks run ~1.4% of sweeps and each produces a correct `standard` sweep. A transient
failure must **not** re-prime — re-priming walks 51 retunes over USB and disturbs the next
capture, which turns single fallbacks into runs. Only capability failures re-prime. The
fallback log is rate-limited to one line per 30 s, because at 36 Hz an unlimited 1.4% is a
line every 3 s and buries the one message a real failure would print.

The pipelined capture must be **bounded by what the sweep needs**, not by a large hard cap —
an oversized cap feeds back, because processing time grows with the buffer it accumulated.

### `dsp`: the FPGA divides

Per step the FPGA discards FLUSH samples, averages ACCUM samples of both channels, divides,
and writes one 8-byte result. The host reads one burst per sweep. Control-register bit 6
selects the DSP FIFO instead of raw samples; a buffer whose tail is **not** constant means
bit 6 did not take, and the read says so rather than returning garbage.

What `dsp` does not have: no `adc_peak` (no raw samples, so the headroom bars are absent —
**set and check gains in `nios` mode first**), no raw IQ for diagnostics, no `settle_count` or
`num_buffers`, and **no graceful fallback** — a failed read emits an all-zero sweep tagged
`fallback`, which the groundstation drops.

**Never touch the RFIC while a dsp sweep is in flight.** The FPGA muxes the AD9361 SPI to the
sweep stepper with no arbiter, so a host gain write races ~51 retune bursts per sweep and is
dropped or corrupted — measured 3 of 9 landing correctly mid-flight against 9 of 9 after
draining. The host drains before applying gains; gain *readback* during a sweep still returns
garbage, so check the level, not the readback.

---

## Shipped defaults (verify in source before quoting)

`RX_BUFFER_SAMPLES 2048`, `DEMOD_SAMPLES 2000`, `settle_count 0`, `range_offset 0.378`,
`tx1 50 / rx1 12 / tx2 45 / rx2 5`, `DSP_DEFAULT_FLUSH_SEL 6` (128 samples),
`DSP_DEFAULT_ACCUM_SEL 3` (1200), `DSP_DEFAULT_DWELL 1344`, `sweep_mode 'dsp'`.

FLUSH and DWELL are **one operating point** — changing either alone breaks the other.

`DEMOD_SAMPLES` must keep `cw_offset * N / sample_rate` an integer, so DC and the odd
harmonics land on sinc nulls. 2000 does; 2048 is ~24 dB worse.

`RX_BUFFER_SAMPLES` must stay a multiple of **2048**, the DMA quantum. A request that does not
divide it leaves a walking remainder, so data lags its own arrival timestamp — which voids the
settle gate while every timing diagnostic still reads perfect.

---

## The settle gate

`settle_count = 0` is the minimum, the default, and **does not mean settling is off**. It means
"capture the first buffer lying entirely after the retune". Each unit costs ~21 ms per sweep
and buys nothing measurable: over 77,542 steps the least-settled captures were the cleanest.

The gate has two parts, both of which were wrong once and are subtle:

1. **The lockstep test is two-sided.** A buffer is accepted when its arrival gap sits inside
   `[0.8, 1.2]` of a buffer period. The gap measures the *change* in staleness, so a large gap
   means the producer was descheduled and has just handed over the oldest buffer in the ring —
   the exact thing the gate exists to reject. A one-sided test read that as freshness.
   **Do not replace the band with a cumulative lag estimate**: the clock is 24 ppm off, which
   integrates into a phantom lag within seconds. The band never integrates.
2. **The deadline gates the buffer's contents, not its arrival.** A buffer arriving at `T`
   holds samples from `[T - period, T]`, so the deadline carries a leading buffer period.
   That term is structural — removing it lets a capture window straddle the retune.

The gap is stamped in the **producer** thread. Timed in the consumer, a scheduling stall is
indistinguishable from a real wait, under exactly the contention that causes the bug.

**If a sweep is corrupted, check `SFCW_DIAG` before raising `settle_count`.** If the gate is
working, the fault is not settling.

`SFCW_DIAG=<prefix>` writes every RX inter-arrival gap and one row per step — index, drains,
accepted gap, retune-to-accept time, backlog, locked, and that step's own `h_cal`. Recording
`h_cal` beside its own timing is what makes the measurement decisive.

---

## The quick-tune master table

Generated once per device connection: the **union** of a 20 MHz and a 50 MHz grid over
2-5 GHz, 181 profiles against a hard ceiling of **256**.

`bladerf_get_quick_tune()` is not a stateless read — every call writes a fastlock profile into
a fixed on-device table, and the counter resets only on a full device open. Past 256 it
returns an error and leaves the profile unpopulated, which the old code stored and then
retuned to. Both a compile-time count check and a runtime return-code check now raise.

Two consequences that are easy to get wrong:

- **One sweep stays inside one base family.** Starting on the 20 grid and stepping 50 visits
  frequencies on neither. `_snap_sweep()` picks one base from the requested *step*, then snaps
  start, stop and step to multiples of it — so the three cannot be snapped independently.
- **The grid is looked up by frequency, not by arithmetic.** Index arithmetic is only valid on
  a uniform table; against the union it silently addresses the wrong profiles. It is a
  `searchsorted` plus an exact-match assertion that raises.

Rounding is half-up on both sides. Python's `round()` is banker's and JavaScript's is half-up,
so they disagreed on exactly the `.5` cases.

**The groundstation mirrors all of this in `lib/sfcwGrid.js`** and must stay in sync — the Pi
snaps silently, so without the mirror the panel describes a sweep that is not running.

Widening the range or refining the step trades against 256: `span / step + 1 <= 256`.

---

## Parameters

Pushed from the panel, never read back. `sendSfcwParams()` sends start/stop/step,
`num_buffers`, `settle_count`, the four gains and `range_offset`. **A parameter not in that
payload never reaches the Pi.**

The connect-time push happens only when the first status after connecting says the Pi is idle,
and the range-offset guard's re-push is limited to the tab that started the sweep. Without
those, a throttled background tab re-pushed its own stale parameters over another tab's
running sweep — which is how a stale `range_offset` of 0.5 ended up in recorded scans.

`num_buffers` is the *count* of buffers averaged per step, not their size. It defaults to 1:
the within-step noise sits ~32 dB below the binding per-retune term, so averaging changes the
total by 0.003 dB.

---

## Things that are settled, do not re-investigate

- **FPGA tuning mode must stay HOST.** Setting FPGA mode succeeds and then silently breaks the
  RX_X2 path about 8 buffers in. Bisected on hardware; the quick-tune table is innocent.
- **The `coherent` flag is a scene detector, not a health check.** It fits a *line* to unwrapped
  phase, which only holds for a single dominant reflector, so it reads `False` 100% of the time
  in every configuration including healthy ones. What is diagnostic is the sweep-to-sweep
  *spread* of `phase_std` — corrupted sweeps do not repeat.
- **The libbladeRF version INFO lines are harmless.** The bundled compatibility table lags the
  flashed firmware.

## Testing

`pi/radar/benchmark_sweep.py --mode dsp|nios|standard`. Benchmark through the **websocket**,
not the engine — the engine alone reads ~7 ms fast because it excludes serialisation and
broadcast. Take the median adjacent difference of `msg['timestamp']`, which is what the GUI
shows. Run the full stack via `start.py`; idle subscriber clients are a cheap realistic load.

**400 sweeps is not enough** to qualify a change — see `.harness/MISTAKES.md`.

Repeated `sfcw_start` / `sfcw_stop` cycling degrades the device. Restart `start.py` after a
15-20 s gap; `usbreset <bus>/<dev>` if it wedges. Watch for the board re-enumerating under a
new device number. `sdr_server` now closes the device on SIGTERM, which was the main cause.

## Change history

- Sweep went 550 ms to 27.5 ms (nios) to ~7.4 ms (dsp), which inverted several design
  assumptions — most importantly, motion during a sweep stopped being what limits a moving
  raster, and spatial sampling became the limit instead.
- `settle_count` default 10 to 3 to 0, each step with per-step validation.
- Reference-channel level and then RX1 level each turned out to be the dominant noise term in
  turn; see `bladerf-rf.md`.
