# FPGA images

## `hostedxA9_niosIIf_sweep_ts_v1.rbf`

The image the SFCW autonomous sweep (`sweep_mode='nios'`) requires. It is the
FALLBACK image now -- `dsp` is the default mode and needs v15 below.
Validated on hardware 2026-09-07 — see CLAUDE.md, "Nios II/f FPGA image +
autonomous sweep".

    sha256  3449d1af4275fa704e108ff1853d543e7660a6eae138180dc81bdf38a2d24df1

Built from Nuand upstream `73ce750` plus three modified files (`rx.vhd`,
`devices.c`, `pkt_retune2.c`) — full build parameters, tool versions and
per-file hashes are in the `.PROVENANCE.txt` beside it. Two things it adds over
stock:

- **Nios II/f** (`NIOS_REV=Fast`, needs Quartus Prime **Standard** — Lite gives
  only Nios II/e, and Pro does not support Cyclone V at all). Cuts the per-step
  AD9361 SPI cost ~6x. This alone speeds up the ordinary host-driven sweep from
  65.5 ms to ~55.5 ms with no host-side change.
- **The autonomous sweep firmware + the `rx.vhd` timestamp fix.** Upstream
  releases the RX time tamer's reset on `meta_en` alone, so the sample counter
  is pegged at 0 in plain `SC16_Q11` and nothing can be scheduled against it.

Together these take the 51-step sweep to **27.5 ms (36.4 Hz)**.

## Loading it

**This image is FLASHED TO SPI as of 2026-09-11, so the board autoloads it and
nothing needs doing after a power cycle.** It was RAM-loaded (`-l`) until then,
which meant every power cycle silently halved the sweep rate — that is exactly
how it was lost on 2026-09-11, while the LiDAR was being rewired. The stock
0.16.0 image is no longer on the board; reverting means re-downloading it from
Nuand.

    bladeRF-cli -L fpga/images/hostedxA9_niosIIf_sweep_ts_v1.rbf   # flash, persists
    bladeRF-cli -l fpga/images/hostedxA9_niosIIf_sweep_ts_v1.rbf   # RAM, for testing

**Do not verify with the "configured by ..." string — its meaning flipped when
this was flashed.** *"configured from SPI flash"* used to mean the stock image
and was the signature of the fault; it now means this image loaded correctly.
*"configured by USB host"* now means something was `-l`-loaded over the top.

**Verify behaviourally instead:** run a sweep and read `sweep_core` on
`sfcw_result` — `nios` is working, `standard` means the capability latch tripped.
The rate alone also identifies it: ~37 Hz autonomous, **~18 Hz = this image but
no NIOS sweep**, ~15 Hz = the old II/e image.

If the sample counter is ever dead, nothing breaks: `SFCWEngine` detects it at
the first EXEC, prints

    [sfcw] NIOS autonomous sweep unavailable on this FPGA image ...

and runs the standard host-driven sweep for the rest of the session (~18 Hz).

## `hostedxA9_niosIIf_sweep_dsp_v15_fifo256_signaltap.rbf`

The image the on-FPGA DSP sweep (`sweep_mode='dsp'`) requires. Run on hardware
2026-09-14. Merged from `sfcw-dsp-100hz`; it is the only DSP image in this repo
(v2..v13 stay on that branch). See CLAUDE.md, "On-FPGA DSP sweep path".

    md5     323bc69b38b7fb44a9faa348f7ecf9bb
    sha256  25ded2025148728daa38451c5c4377e547f2f33ac20c0edfee2bb432bdba91f6

On top of the v1 image's Nios sweep, the FPGA itself steps the AD9361 at an exact
clock tick (`sweep_stepper`) and mixes, averages and divides each step (`rx.vhd`),
so the Pi reads one small burst per sweep: ~100 Hz at 51 steps, any length
2..255 steps. Built from `bladerf-src` `fifo-256` @ `ba105a3c`; details in the
`.PROVENANCE.txt`. A SignalTap build (`.stp` + `.sof` included): harmless without a
JTAG cable attached.

**It is NOT in flash.** Load it into RAM, from the repo root, with services stopped:

    bladeRF-cli -l fpga/images/hostedxA9_niosIIf_sweep_dsp_v15_fifo256_signaltap.rbf
    python3 pi/radar/check_bit6.py        # bit 6 must read back
    python3 pi/radar/set_sweep_mode.py dsp   # then stop/start the sweep in the GUI

A power cycle reverts the board to the v1 image in flash. `nios` mode keeps
working there; `dsp` mode fails every sweep, and the SFCW panel shows empty DSP
sweeps being dropped. `bladeRF-cli -L` would flash v15 instead, replacing v1 on
the board.
