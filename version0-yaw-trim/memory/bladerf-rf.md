# bladeRF RF chain: gains, levels, and what limits repeatability

**Purpose** — the analogue side. What the gains do, where the noise actually comes from, and
which knobs have been measured to matter.

**Location** — `pi/radar/bladerf_driver.py` (HAL), gains applied in
`sfcw_engine._configure_hardware()` before every sweep.

**Two chains.** Antenna: TX1 to the Vivaldi, back into RX1. Reference: TX2 straight into RX2
over a cable loopback. `h_cal` is their ratio, so anything both chains share divides out.

---

## The metric

`S_repeat` — signal energy over the energy of the **adjacent-sweep** difference, halved to
correct for differencing two independent samples. It is immune to slow drift within a capture,
which deviation-from-the-mean is not. Being a ratio computed inside one configuration, it stays
comparable even though changing a gain re-calibrates `h_cal`'s shape.

**Never difference across a rotation boundary** when the data is interleaved — see
`.harness/MISTAKES.md`. Use windowed, worst-2-steps-trimmed values whenever the raw figure is
under ~32 dB, because the 0.999 correlation bar is the noise floor there.

## Levels: aim for a few hundred ADC counts, on both channels

Both dominant noise terms in this system's history were a receiver run too hot, found two
months apart on the two different channels.

| | symptom | fix |
|---|---|---|
| reference (RX2) | `|h_reference|` 4.7x less stable than the antenna channel; because it divides every step, its noise is **multiplicative**, so the scatter was independent of each step's own level | level it — the compression curve bottoms around 150-400 counts peak |
| antenna (RX1) | the hottest quarter of the profile wobbled 1.95% against 1.28% for the rest, and the per-sweep ADC peak *predicted* that sweep's own error | `rx1_gain` 25 to 12, worth **+8 to +10 dB** |

**The damage is a continuous level dependence, not the rail.** Railing happened on 2-5% of
sweeps and those were only 1.07-1.12x noisier. What matters is how hard the front end is
driven on average.

**`_warn_if_adc_hot` cannot catch this and still cannot.** It needs 8 *consecutive* hot sweeps,
and the railing is a few percent scattered at random. The hysteresis is right for what it was
built for — RX1's per-sweep peak sits on any sensible threshold in normal operation — but it is
blind to this. Watch the panel's RX1 headroom bar instead.

RX1 and RX2 need **different** thresholds because `adc_peak` is a max over the sweep: RX2's
reference is flat across the band so its max represents every step, while RX1's max is
whichever frequency the scene is strongest at.

## The reference gain split is real and is not a level effect

At a roughly constant reference level, moving only the TX2/RX2 split changes repeatability
monotonically across 19 dB: 20/30 gives 19.7 dB, 30/20 gives 28.1, 40/10 gives 36.7,
**45/5 gives 38.6**. Two settings at 342 and 585 counts both read 38.6 while a setting at 391
counts — in between — read 28.1.

**The obvious mechanism is wrong.** "Match the two chains so more error is common-mode"
predicts tx1=45 with tx2=45 should win; measured, it is 3.9 dB *worse* than tx1=50 with tx2=45.
Most likely an empirical property of where the AD9361 gain table lands at this frequency plan.
**Re-measure after any RF hardware change rather than assuming it transfers.**

## What actually limits `h_cal` now

The binding term is the **per-retune** wobble: `|h_signal|` at a fixed frequency changes between
sweeps though the scene does not, 30x worse between sweeps than within one. It is frozen for
the duration of a step and re-drawn at the next retune, so **more `num_buffers` cannot help** —
the noise it averages is already 30x below the limit.

Only about half is common-mode, and the signal chain carries the largest uncancelled share.

**It scales with the size of the frequency step, not with the retune event.** Retuning 51 times
to the *same* frequency is nearly free (0.156% adjacent cv, 54.6 dB); a 60 MHz step gives
0.482%; a 1 GHz step gives 2.978%. A 300 MHz span walked in 60 MHz steps beats a single 300 MHz
jump, so it is the per-step jump that matters.

## Falsified — do not spend time on these again

Each was bracketed and measured.

- **AD9361 quadrature tracking re-converging after each retune** — freezing or disabling the
  correction changes nothing.
- **DC offset tracking** — not the cause, and **load-bearing: leave it ON.** Disabling it costs
  18.8 dB and wrecks the reference channel too.
- **Quick-tune versus a full per-step tune** — falsified in the opposite direction. A full tune
  per step is 11 dB *worse* and runs at 0.9 Hz.
- **TX1 compression / TX drive** — no effect. With TX1 completely off the wobble is unchanged,
  so it is not the transmitter. `tx_amplitude` is shared by both chains, hence common-mode.
- **Something still settling inside the dwell** — nothing is. From 110 us onward the trend is
  flat to four decimal places, and the sweep-to-sweep cv does not fall.
- **Harmonics of the 100 kHz offset tone** seen on the RF Calib FFT — structurally rejected by
  the demod, which is a single-bin coherent extraction at exactly that frequency, not a
  spectrum.

## RF Calib panel gains are NOT the sweep's gains

Easy to conflate — both transmit the same 100 kHz-offset CW tone. The RF Calib panel drives
`BladeRFDriver.tx_gain`/`rx_gain` directly; `_configure_hardware()` overwrites those from the
engine's own four gains before every sweep. There is no shared source; they are kept aligned by
hand. If the sweep's gains change, retest via RF Calib **at the exact new numbers**.

Headless tools used to force their own gains for the life of the `sdr_server` process, silently
moving every subsequent browser sweep into a compressed regime with nothing on screen to say
so. The panel now carries tx2/rx2 and the tools were brought into line.

## Tooling

In `pi/radar/`, all reusable, all needing `sdr_server` stopped:

- `probe_wobble.py` — drives the engine directly and records `h_signal` and `h_reference`
  **separately** per step per sweep. The wire only carries their ratio, and the whole diagnosis
  turns on telling the two chains apart. `--interleave N` is what makes an A/B trustworthy.
- `analyze_wobble.py` — windowed trimmed `S_repeat`, per-channel cv, the common versus
  channel-specific split, the additive-vs-multiplicative test, per-step robust-z.
- `analyze_dwell.py` — re-demodulates sub-windows *inside* one stored capture, so "is anything
  still settling" is answered on identical data.
- `analyze_adc.py` — what actually arrives at each ADC. `adc_peak` on the wire is one max over
  a whole sweep and says nothing about how often, or at which frequency.
- `rfic_regs.py` — direct AD9361 register access. libbladeRF enables every tracking calibration
  at init and exposes no way to change it. Baseline on this board is `0x169 = 0xCF`,
  `0x18B = 0xAD`.

The engine carries two default-off diagnostic flags: `keep_raw_channels` (the per-step
`(sig, ref)` before division) and `keep_full_capture`. Neither exists in `dsp` mode, where the
division happens on the FPGA.

## Change history

Original baseline 25.5 dB with a compressed reference and a half-length RX buffer, to ~41-44 dB
today. The three changes that did it: the `sync_rx` request length, the reference gain split,
and `rx1_gain` 25 to 12.

**The loopback cable is still the session-to-session variable.** At its best the reference
reaches 0.014% adjacent cv, at its worst 2.3%, and it throws episodes lasting tens of seconds
in which one frequency step carries almost all of the difference energy. Reseat it before
trusting any absolute `S_repeat`.
