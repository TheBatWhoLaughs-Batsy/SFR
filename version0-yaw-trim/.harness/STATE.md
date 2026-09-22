# STATE

verified-at: 2026-09-21 — source inspection plus the checks below, which were run this
session. No bench run; anything marked (unverified on hardware) has never been run on the rig.

## ran this session, on the groundstation PC, no hardware attached

- `bash rover/test/build_check.sh` — **166 checks, 0 failures** (125 motion/protocol core,
  41 network recovery ladder), the `.ino` type check clean both with and without
  `NET_USE_PING`. A C++ toolchain *is* available here (`g++` from msys64), contrary to an
  earlier note that this could only run on the Pi.
- `npm run build` — passes, 1820 modules, 38 s. Warns that the main chunk is 1.29 MB.
- `python -m py_compile` over all 43 Python sources — clean.
- `lib/sarDetect.js` loads and resolves under node through `bench/register.mjs`, all exports
  present, search band 5-20 cm.

- `npm run bench -- --set sfr-2026-09-20 --handle-ends` — **reproduces the recorded
  baseline exactly**: 11/12 targets rated, 12/12 present, position bias -0.98 cm, median
  |dx| 1.04 cm, 20 s. False alarms per scan by reference: `empty.json` 0.29,
  **`empty 2.json` 0.00**, none 0.25.

  The two empties bracket the session (18:08 and 18:29) and **the later one removes every
  false alarm the earlier one leaves** — an independent confirmation, on this set, that the
  reference has to be contemporaneous with the targets.

  Without `--handle-ends` the same run reports 0.43 false/scan, every one of them at a scan
  edge. Quote a benchmark figure with the flag it was measured under.

**The gw2-2026-09-13 set still cannot run — its 7 scans are not on this machine.**

Scan files are not in git (~8.7 MB each, 70 MB for one set). `bench/corpus.json` names the
directory per set. The `sfr-2026-09-20` set lives in a 17 MB rar; `*.rar` is gitignored.
Until the scans sit somewhere shared — the Pi already serves as the shared store for
background models — only the machine holding them can score a detector change.

## works

- **SFCW sweep, three cores.** `sweep_mode` defaults to `dsp` (on-FPGA demod+divide, ~136 Hz
  at 51 steps with the shipped FLUSH-128 / dwell-1344 point). `nios` ~36 Hz, `standard` ~18 Hz.
  Mode is a runtime `sfcw_set_params` field.
- **Shipped engine defaults** (`pi/radar/sfcw_engine.py`, confirmed in source):
  `RX_BUFFER_SAMPLES 2048`, `DEMOD_SAMPLES 2000`, `settle_count 0`, `range_offset 0.378`,
  gains `tx1 50 / rx1 12 / tx2 45 / rx2 5`, `DSP_DEFAULT_FLUSH_SEL 6`, `ACCUM_SEL 3`,
  `DWELL 1344`.
- **Pi hosts the whole groundstation.** `pi/start.py` runs four services — Flask on 5000
  serving `frontend/dist` and `/api/models`, sensors 9001, rover 9002, SDR 9003. Measured:
  serving costs nothing at 135 Hz sweep.
- **Pi is the access point.** NetworkManager profile `sfr-pi-ap`, SSID `sfr-pi`, Pi fixed at
  10.42.0.1, DHCP + NAT from the built-in radio. TP-Link Archer T3U Plus dongle, profile
  bound to its MAC.
- **Binary sweep frames** on the SDR socket (`SFR1`), ~1.2 KB against 2.8 KB of JSON,
  opt-in per connection so older clients still get JSON.
- **Sensor stream** — three TF-LC02 LiDAR heads (forward `ttyAMA2`, right `ttyAMA3`, down
  `ttyAMA1`) plus the BNO085, each independently guarded so one failing cannot stop the other.
- **Rover gantry** — ISR-generated steps, continuous jog, E-stop during motion, soft limits on
  both sides, position from the board's own step counter, closed-loop yaw steering.
- **C-scan raster** — manual and rover-driven, stepped and continuous, live plan-view fill,
  to-scale projection onto the wall through a second browser window.
- **SAR** — layered air/wall/air refraction, per-position standoff correction, coherence
  output, 45-degree aperture limit, 3D wall twin.
- **Detection** — pipes (line/Hough search, six tests, empty reference) and seepage (in-wall
  patch contrast). Benchmarked by `npm run bench` against two labelled corpora: 11/12 and
  10/10 targets rated, 0.25 and 0.29 false alarms per scan.
- **Handheld panel** — three-head position from a declared origin, IMU tilt compensation,
  raw capture-to-disk session recorder.

## broken / open

- **The v15 FPGA image lives in RAM only.** SPI flash still holds the v1 sweep image, so every
  power cycle reverts the board and `dsp` mode fails every sweep. `check_bit6.py` after any
  power cycle. **~18 Hz is the diagnosis, not just a rate**: it means the II/f image is up but
  NIOS is unreachable.
- **`dsp` mode has no graceful fallback.** A rejected EXEC sets `_nios_unavailable`, routing to
  the `standard` core which has no raw RX stream open — the sweep loop then waits ~1.3 s per
  step. Recover with `set_sweep_mode.py nios` and restart the sweep.
- **The FPGA has no SPI arbiter.** Host RFIC access races the sweep stepper; the host-side
  workaround drains the in-flight sweep before a gain change. Gain *readback* during a `dsp`
  sweep still returns garbage.
- **NIOS fallback sweeps punch holes in a continuous raster.** ~3% of sweeps during a raster,
  each costing ~133 ms of unsampled travel. Not fixed; scan with ~4 sweeps/cell of margin.
- **Far pipes fail the `rows` test** when other pipes share the row — the clutter removal is
  contaminated by them. Rank-1 SVD misses them; rank 2 doubles false alarms on the older
  corpus. No adaptive rank that survives both corpora.
- **A wall defect rates `confirmed` without an empty reference.** The 36 cm crevice on the gw2
  bench passes all six tests on its own.
- **`rover/secrets.h` is committed** with the live `sfr-pi` PSK, despite claiming otherwise in
  its own header. Rotate the PSK; the value is in the history of a shared remote.
- **The AAC test block is wet** — measured 672 kg/m3, ~25% moisture by weight, er 5.6 against
  a dry 1.8-2.5. It is currently the lossiest of the three test walls, not the cleanest.

## next

- Decide whether to flash v15 to SPI. Confirm `nios` mode works on v15 first — flashing
  removes v1 from the board.
- **Put both scan sets on the Pi**, beside `groundstation/models/`, and point
  `bench/corpus.json` at that path. Attempted this session and blocked: the Pi was not
  reachable — this PC sat on the lab Wi-Fi (192.168.1.20) and a sweep of that subnet found
  no host taking SSH, so the Pi was off or on `sfr-pi` only. The `sfr-2026-09-20` set is
  currently at `~/Desktop/new sfr benchmarking/` on this PC and nowhere else; the
  `gw2-2026-09-13` set is on neither.
- Reflash the rover firmware with the `sfr-pi` credentials already written into
  `rover/secrets.h` and `config.h`. `build_check.sh` passes; the board has not been
  flashed. Then check the pin map and both steering signs on the rig.
- Confirm on the rig (all unverified on hardware): the board-clock fix for continuous-raster
  holes; handheld tilt compensation and the IMU-to-LiDAR mount calibration; the BNO085 init
  fix via `pi/sensors/bno085_diag.py`; binary sweep frames in a real browser against the Pi;
  reboot persistence of the `sfr-pi` AP; a walk test of the T3U Plus range.
- Re-measure `lidar_antenna_offset_mm` if the forward head's mounting changed in the
  three-head rewire; background models captured on the old head are suspect.
- Dry the AAC block and log the weight-vs-permittivity curve as it goes.
