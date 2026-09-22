# GOAL

## Purpose

A stepped-frequency continuous-wave (SFCW) radar that images the **inside** of a wall —
rebar, pipes, voids, studs — and projects what it finds back onto the wall itself.

The instrument is two halves over a LAN: a Raspberry Pi carrying the radio and sensors, and
a browser groundstation carrying the UI and the heavy reconstruction. The Pi can host that
groundstation itself, so the system needs no second computer in the field.

## Done looks like

- An operator scans a wall patch — by hand or on the rover gantry — and gets a plan view and
  a 3D model showing where targets are, how deep, and how confident.
- Detections are reported with a rating, not just a picture: confirmed / probable, with the
  tests that passed and the false-alarm risk stated.
- Findings are projected onto the real wall at true scale, so the operator marks the wall
  without reading a screen.
- The whole thing runs off the Pi's own access point with no external network.

## Non-goals

- **Seeing beyond the wall.** Everything past the back face is out of scope.
- Anything below the sensor's own physics: the TF-LC02 measures at 11-17 Hz and cannot be
  made faster; ~50 mm range resolution at 3 GHz of bandwidth cannot separate a target from
  a wall face at the same delay.
- A general-purpose GPR. This is one bench, a handful of wall materials, known geometry.
- Magnetometer-based heading. The instrument images rebar; a magnetometer would be pulled
  by the thing being looked for.

## Settled constraints

- **2-5 GHz sweep, hard-bounded** by the bladeRF's 256-profile quick-tune ceiling.
- Steps must land on the 20 MHz / 50 MHz union grid, and one sweep stays inside one family.
- **No endstops on the rover.** Soft limits enforced on both the Pi and the board are the
  only protection; the board's copy must survive the Pi crashing.
- Background subtraction is groundstation-side only; the wire carries raw `h_cal`.
- A background model is valid only at the RF gains, mounting and bench state it was captured
  at. Any of those changing silently invalidates it.
- The FPGA image is the throughput: ~136 Hz on the v15 DSP path, ~36 Hz autonomous NIOS,
  ~18 Hz host-driven.

## Open questions

- Should the v15 DSP FPGA image be flashed to SPI? Flash still holds the v1 sweep image, so
  every power cycle silently reverts the board and halves throughput.
- Is there a clutter model that finds the far pipes without the false alarms that fixed
  rank-2 SVD brings? Rank 1 misses them, rank 2 doubles false alarms on the older corpus.
- What separates a wall defect from a target without an empty-wall reference from the same
  session? Depth alone does not, at this bandwidth.
