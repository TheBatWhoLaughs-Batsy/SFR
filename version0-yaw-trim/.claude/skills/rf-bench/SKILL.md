---
name: rf-bench
description: Measure an A/B on the radio or the rig without the bench scoring it for you. Use before changing any gain, settle count, dwell, FLUSH/ACCUM, buffer size, sweep mode or FPGA image, and whenever asked whether a change helped. Encodes interleaving, the control-block error bar, the metrics that work and the ones that lie.
---

# rf-bench — measuring a change on this rig

Two regressions shipped here because a change was made "for cleanup" and validated with a metric
that could not see the failure. This is the procedure that would have caught both.

## Interleave. Never run blocks sequentially

The TX2→RX2 loopback throws episodes lasting tens of seconds, in which one frequency step carries
almost all of the sweep-to-sweep difference energy. Run blocks back to back and whichever
configuration happens to be running during an episode is scored for the bench.

```bash
python3 pi/radar/probe_wobble.py --interleave 40 ...
```

**Duplicate one configuration as its own control**, and the spread between the two duplicates is
your error bar for everything in that run. Measured spreads: 0.2 dB in a good session, 1.8 dB in
another, 2.7 dB in one where the reference channel moved 6x partway through. If the duplicates
disagree by more than the effect you are claiming, you have measured nothing.

Interleaving is the wrong method when each chunk change is itself unreliable — for example
reconfiguring over a bus that races the sweep. Drain first, or do not interleave.

## Metrics

**`S_repeat`** — signal energy over the energy of the **adjacent-sweep** difference, halved.
Immune to slow drift within a capture, which deviation-from-the-mean is not.

**Never difference across a rotation boundary.** Interleaved chunks of one configuration were
seconds apart; `diff` over the concatenation pairs sweeps that were never adjacent. Measured:
36.4 dB across the concatenation against 41.4 dB within chunks, on the same data. Split on time
gaps first.

Use **windowed, worst-2-steps-trimmed** `S_repeat` whenever the raw figure is under ~32 dB — the
0.999 correlation bar is the noise floor there, and one bad step drags a whole block's aggregate
into the teens while the rest sits at 33-36.

**Per-(sweep, step) robust-z** is the metric that catches the failure an aggregate cannot: a step
that retuned late holds the previous frequency's IQ and lands nowhere near its own median. There
are 51 steps per sweep, so it has 51x the samples. **An aggregate sweep-to-sweep correlation is
what let a 1-in-40,000 corruption ship unnoticed.**

Split every metric on **`sweep_core`**. A block mixing `nios` and `fallback` sweeps reads far
worse than either.

## Sample size

**≥1200 sweeps.** The failure rate being chased is ~0.17% of sweeps, so a 400-sweep block reads
0 most of the time — the identical configuration gave 2/399 in one block and 0/1499 in another.

Better than a rate: test the **mechanism**. `SFCW_DIAG=<prefix>` writes every RX inter-arrival
gap and one row per step — index, drains, accepted gap, retune-to-accept time, backlog, locked,
and that step's own `h_cal`. Recording `h_cal` beside its own timing is what made the settle-gate
measurement decisive, with no need to align a diagnostic against the websocket stream.

## Benchmark through the websocket, not the engine

The engine alone reads ~7 ms fast because it excludes serialisation and broadcast. Connect a
client to `ws://localhost:9003`, send `sfcw_set_params` then `sfcw_start`, and take the **median
adjacent difference of `msg['timestamp']`** — what the GUI shows. Run the full stack via
`start.py`; idle subscriber clients are a cheap, realistic load knob.

**Run one benchmark client at a time.** Two clients issuing start/stop corrupted several blocks
and cost real debugging time.

## Keep the two channels separate

`probe_wobble.py` records `h_signal` and `h_reference` separately per step per sweep. **The wire
only carries their ratio**, and most of the diagnosis turns on telling the two chains apart.
Record ADC headroom per channel per step too — that was the entire answer twice.

`dsp` mode has no raw IQ, so diagnostics need `nios` mode.

## Before you start

- Reseat the loopback, or note that you did not. It is the session-to-session variable.
- Check which FPGA image is loaded — `check_bit6.py`, or the rate (see `memory/fpga-images.md`).
- Set and check gains in `nios` mode; `dsp` has no `adc_peak`.
- Keep sessions short. Repeated start/stop cycling degrades the device; restart `start.py` after
  a 15-20 s gap, `usbreset <bus>/<dev>` if it wedges, and watch for the board re-enumerating.
- Snapshot and restore any RFIC register you touch, and rewrite the baseline before every block
  so a control cannot inherit the previous block's state.

## Report

Quote the control spread first, then the effect. An effect smaller than the spread is not a
result. Say which session, which image, which mode, and what was not reseated.

Numbers go in `docs/engineering-log.md`; the resulting behaviour goes in `memory/`.
