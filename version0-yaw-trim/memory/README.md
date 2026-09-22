# memory/ — how each subsystem works now

Read the relevant file before touching a subsystem. These describe **current behaviour**, not
history. Investigation narrative, measurement tables and falsified hypotheses live in
`docs/engineering-log.md` — grep it for a number, never read it whole, and never trust a claim
there over one here or over the code.

If a file here disagrees with the code, the code wins and the file gets corrected in place.

| File | Covers | Read it before |
|---|---|---|
| `sfcw-engine.md` | The sweep itself: three cores, the settle gate, the quick-tune grid, timing | Touching `pi/radar/sfcw_engine.py` or any sweep parameter |
| `fpga-images.md` | Which FPGA image is on the board, what each one costs, how to load and diagnose | Any throughput surprise, flashing, or `dsp` mode failing |
| `bladerf-rf.md` | Gains, the reference channel, ADC headroom, what limits repeatability | Changing any gain, or chasing sweep-to-sweep noise |
| `lidar.md` | Three TF-LC02 heads, the UART map, dropouts, why a standoff goes null | Standoff problems, or anything reading `lidar_*` |
| `imu.md` | BNO085 over SHTP, the axis remap, calibration, known init failure | IMU orientation or calibration work |
| `sensor-stream.md` | Port 9001: the packet, the poll rates, the independence guarantees | Editing `pi/sensors/stream.py` |
| `websockets.md` | All three sockets, the binary sweep frame, fan-out rules, throttling | Any change to a broadcast, a client, or the wire format |
| `rover-firmware.md` | The Arduino: ISR stepping, protocol, soft limits, network recovery ladder | Any firmware edit, and before flashing |
| `rover-server.md` | Port 9002: the Pi half, outbox flow control, the board clock, steering | Editing `pi/rover/rover_server.py` or `yaw_control.py` |
| `cscan.md` | The C-scan panel: grid, raster modes, plan view, projection, focusing | Any C-scan panel or raster work |
| `bg-subtraction.md` | Captured reference, interpolating model, Super Fit, continuous capture | Anything that subtracts a background |
| `sar.md` | Reconstruction: refraction, standoff correction, coherence, aperture, 3D | SAR panel or `sar.worker.js` / `sarReconstruct.js` |
| `detection.md` | Pipes and seepage detection, the six tests, thresholds, `npm run bench` | Changing any detector threshold or the benchmark |
| `handheld.md` | Three-head position, tilt compensation, mount calibration, capture panel | Handheld panel or capture work |
| `projector.md` | Projecting the plan view and detections onto the wall; the demo panel | Projection or the second window |
| `groundstation-app.md` | The React app: panels, hosting on the Pi, throttling, dev-only traps | Frontend structure, hosting, or a dev-vs-build discrepancy |
| `scans-and-corpus.md` | The labelled scan sets, capture protocol, what each one proved | Capturing a new set, or interpreting an old one |
| `wall-materials.md` | Measured permittivity and attenuation of the test walls | Setting `sarEpsilonR`, or interpreting an unfamiliar wall |

`CONTEXT.md` at the repo root holds hardware, wiring, pinouts and ports. It is the physical
layer; these files are the behavioural one. Its `Current Status` section is superseded by
`.harness/STATE.md` — prefer STATE.

## When to add a file

Only when a component is substantial enough that a future session benefits from reading it
before touching the component. A helper, a single bug, or loose notes go into the existing
relevant file. Prefer several focused files over one large one. Update this table whenever a
file is added, merged or removed.
