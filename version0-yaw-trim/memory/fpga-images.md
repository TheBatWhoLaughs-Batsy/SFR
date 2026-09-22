# FPGA images

**Purpose** — the FPGA image decides the sweep rate. Which one is on the board is an
operational fact that changes silently on a power cycle, so it is the first thing to check
when throughput surprises you.

**Location** — `fpga/images/` (the `.rbf` plus a `.PROVENANCE.txt` and checksums for each),
`fpga/README.md`, `docs/nios_sweep.md` for the protocol and firmware side.

The FPGA **source** is not in this repo. It lives in a `bladerf-src` checkout; each image's
provenance file names the branch and commit it was built from.

---

## The images

| image | what it gives | notes |
|---|---|---|
| Nuand stock | host-driven only, ~15 Hz | the II/e CPU is the bottleneck |
| `hostedxA9_niosIIf_sweep_ts_v1` | Nios II/f + sweep firmware — ~18 Hz host-driven, ~36 Hz autonomous | **currently in SPI flash** |
| `hostedxA9_niosIIf_sweep_dsp_v15_fifo256_signaltap` | adds the on-FPGA DSP path — ~136 Hz | **RAM-load only; reverts on power cycle** |

Quartus edition matters: the device is a Cyclone V E, which **Quartus Prime Pro does not
support**. Standard (Nios II/f) or Lite (Nios II/e only).

The v15 build carries SignalTap, an on-chip logic analyser. With no JTAG cable attached it is
idle and does not affect the data. Removing it means a rebuild and a re-validation.

---

## Loading, and the trap

```bash
bladeRF-cli -l fpga/images/<image>.rbf   # into RAM — reverts on power cycle
bladeRF-cli -L fpga/images/<image>.rbf   # into SPI flash — persists
```

Diagnose with `-l` while investigating; it is free to undo. `-L` removes the previous image
from the board, so confirm the new one works in every mode you rely on first.

**`bladeRF-cli -e info` is not a reliable diagnostic here.** "configured from SPI flash" means
whichever image is flashed, and what is flashed has changed over time — the string once
indicated the fault and now indicates health. The only reliable checks are behavioural:

- `python3 pi/radar/check_bit6.py` — which image is loaded (services stopped)
- the `sweep_core` field on `sfcw_result` — `nios` / `fallback` / `standard`
- the sweep rate itself

## The rate is the diagnosis

| rate | means |
|---|---|
| ~136 Hz | v15 DSP path, healthy |
| ~36 Hz | II/f image, NIOS autonomous sweep running |
| **~18 Hz** | **II/f image present but NIOS unreachable** — the capability latch tripped |
| ~15 Hz | the old II/e image |

~18 Hz specifically means the sweep firmware is unreachable while the II/f image is loaded.
Look at the image and the latch; never at `settle_count` or the host path.

A 100% `standard` block is the latch. A 100% `fallback` block is a different fault with a
similar rate — the alignment gate refusing every sweep.

**The failure is quiet by design, and that is its real cost.** Degrading to the standard sweep
is correct behaviour — a correct slower sweep, not a broken one — but it announces itself with
one stdout line at startup. A halving of throughput went unnoticed long enough to be reported
as a mystery. `start.py` does not touch the FPGA, so flashing is the only thing that prevents
a recurrence.

**Beware a second instrument colliding on the same number:** a 20 Hz display throttle once made
a healthy 36 Hz radar read 17.9 Hz in the UI, which is indistinguishable from the 18.0 Hz of a
reverted image. Confirm the rate from the Pi's own timestamps.

## Repo weight

The `.rbf`, `.sof` and `.stp` files are ~49 MB of binaries in git history. If clone time
becomes a problem, the `.sof` and `.stp` are the rebuild-only artefacts and are the ones to
move out first; the `.rbf` is what the Pi actually loads.

## Change history

- Stock to II/f: ~10 ms per sweep with no host change — the Nios services host-driven retunes
  too, and the II/e's ~47.7 us of CPU overhead per SPI transaction was the term that shrank.
- A hardware SPI sequencer was planned and **dropped**: it and Nios II/f delete the same
  overhead, so they do not compound.
- v15 added the DSP path. Its known gap is the missing SPI arbiter — see `sfcw-engine.md`.
