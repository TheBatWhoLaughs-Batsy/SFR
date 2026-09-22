# Handheld module — position, tilt, capture

**Purpose** — scan a wall patch by hand instead of on the gantry, with a position good enough to
bin sweeps into a grid.

**Location** — `HandheldPanel.jsx`, `HandheldReadouts.jsx`, `lib/handheldPose.js`,
`lib/handheldTilt.js`; capture in `HandheldCapturePanel.jsx`, `lib/handheldCapture.js`,
`lib/captureWriter.js`, `lib/dirHandleStore.js`, `hooks/useHandheldCapture.js`.

Replaced the IMU panel; `ImuDisplay` survives as one quadrant.

---

## Position from three LiDAR heads

Frame: X right, Y **up**, Z forward. Position = origin distance − current distance for X and Z,
and the reverse for Y, because the down-facing head's distance grows going up.

The origin is groundstation-only and **per axis** — "Set origin" refreshes only the axes with a
fresh reading and leaves the others on a reference taken in an earlier pose. It stores the
**raw** reading, not a tilt-corrected one: the origin is what the correction is measured *from*,
so at the origin attitude it is the identity by construction.

Changing the wiring assignment clears the origin.

Update rate is the sensor's own 11-17 Hz (see `lidar.md`); the stream publishes at 50 Hz, so the
display updates between measurements. Time-window averaging trades noise against lag —
**default 100 ms** (0.5-0.75 mm from 0.7-1.0 mm, 50 ms of lag). Past ~500 ms noise barely falls.
Averaging applies to the display and the origin; it does **not** touch the standoff the radar
uses.

---

## Tilt compensation

`pos = origin − current` is exact only while the module does not **rotate**. A beam meeting its
surface at θ measures `h/cos θ`, so on an 800 mm reading a hand tilt costs 3.1 mm at 5°, 12.3 at
10°, 28.2 at 15°, 51.3 at 20° — against 0.5-1.0 mm of sensor noise. It is systematic, not noise.

Everything is referenced to the pose the origin was declared in, which drops the room's frame out
of the arithmetic entirely. With no rotation the formula collapses to the uncorrected one, so it
is a strict drop-in and an axis missing an orientation falls back exactly.

Measured: origin set square, then rolled and moved straight up 100 mm over a 1000 mm floor —
**100.00 mm at every roll from 0 to 30°**, where uncorrected reads 117.0 at 10° and 270.2 at 30°.
It also removes phantom **cross-axis** motion, which is the less obvious win: roll tilts the
right-facing beam too, inventing 108 mm of X travel at 30° that never happened.

**The correction is applied per SAMPLE, then averaged** — never to the averaged range. The window
is up to 1 s and the correction depends on the attitude each sample was taken at; correcting the
mean with the latest attitude puts a whole window of hand rotation onto one reading. Each sample
carries its own quaternion.

### The one approximation, and exactly what it costs

The surface normal at the origin is assumed to equal the beam direction — i.e. the operator held
the module square. It is not a property of the hardware, so no mount calibration can supply it.

With an origin misalignment α and a later tilt θ the residual is `tan α · tan θ`, against
`1/cos θ − 1` for no correction. **So the correction helps only if the origin pose is square to
better than roughly half the tilt you then apply.** Each reading is at a minimum when its beam is
perpendicular, so aim by minimising; the per-axis live tilt readout exists for this. **The
residual scales with the standoff, not with how far you moved** — ~15 mm on a 1 m floor distance
whether the move was 10 mm or 300.

The proper fix is to fit the normal at origin time from a deliberate 2 s wobble — the same linear
half of the solve below with the beam known. The machinery exists, the UX does not.

### Mount calibration

Hold the module in one spot and tumble it. The perpendicular distance is then constant while the
measured range is not, giving an equation **bilinear in two unknown directions**. Alternating
least squares splits it into two 3-parameter linear solves, each well conditioned where the joint
9-parameter form is not — the samples sit near the identity rotation, so it explores barely four
of its nine dimensions. The 9-parameter fit is still run, factorised, and used as a second
starting point; whichever converges lower wins.

**A by-product is that this MEASURES `imu_calibration.py`'s `R_ACCEL` forward/left rows**, which
that file records as inferred.

**Rotating about a single axis is a genuine gauge freedom**, not merely imprecise — both unknown
directions can be spun about that axis with no change in the prediction — so it produces
confident answers up to 95° wrong. Gated on coverage measured from the **rotations**, as rotation
vectors. An earlier version measured the spread of the fitted **beams** and was circular: a badly
wrong answer traces a wide cone and scores well. **Measure the input, not the output.**

Gates: ≥18° total rotation, ≥4° on a second axis, ≥120 samples, ≤6 mm rms, ≤35° mount error. They
are shown **live** while the operator is still moving, and the result is **shown, not applied** —
only axes that passed are stored, so a rejected axis falls back to the nominal mount. An
independent end-of-run check: the three fitted beams should be mutually perpendicular, which
nothing in the fit knows.

### Why it runs uncalibrated by default

The mount enters only to **second order** — getting the beam direction wrong tilts the assumed
normal and the assumed beam together, so it mostly cancels. Worst-case position error on an
800 mm standoff at 15° of tilt: 0.0 mm at 0.5° of mount error, 0.2 at 5°, 0.5 at 8°, against
**28.2 mm with no correction at all**.

So tilt compensation is on by default with the nominal mount, and calibration is a refinement.
What calibration is really for is the lever-arm term (first order), verifying the axis remap, and
any future normal-at-origin fit.

**Lever arms are implemented and tested but not exposed** — each emitter's offset from the point
the reported position should refer to. Without them each axis reports its own emitter's position,
which only diverges once you rotate: a down head 50 mm to the side reads 8.7 mm low at 10° of
roll. No UI, because it is nine numbers.

### Details

- **A beam past 90° from its surface is REFUSED, not extrapolated.** That axis reports `grazing`
  and falls back.
- **`corrected` is per axis and means what was DONE, not what was asked for** — false whenever any
  link in the chain made it fall back. The viewport reads it, never the toggle.
- Rotating a head about its **own** beam axis changes nothing, which the geometry reproduces
  exactly and is a free sanity check.
- Yaw drift is second order and height is exactly immune — see `imu.md`.
- `localStorage` keys are versioned (`_v2`, `_v3`) wherever a default or a stored shape changed,
  so a browser that already ran the panel does not keep a value chosen on a wrong basis.

---

## Handheld Capture

Records **everything, raw**, for post-processing. An earlier version averaged sweeps per cell into
a C-scan-shaped file and was replaced before use: coherent averaging across hand-held standoff
and lateral spread destroys signal, and it threw the raw sweeps away. **Do not reintroduce
averaging at capture time.**

Layout: `session.json` (manifest, counters, segment list, and a `format` block describing every
record kind) plus `stream_NNNNNN.jsonl`, concatenated in order. Record kinds:

- `sweep` — every `sfcw_result` as received, logged at the **top** of the SDR handler, before the
  range-offset guard and before empty DSP sweeps are dropped, so `range_offset` is the Pi's own.
  Omits the profile (a function of the rest). `h_cal` is **full float64** from binary frames.
- `sensor` — every sensor packet as received.
- `sdr` — every other SDR message except RF Calib's bulk data.
- `place` — derived position and cell at the sweep midpoint, while playing.
- `event` — session start with the full config, origin set, play, pause, config changes, session
  end.

**Recording runs from Start to End, playing or not**; Play/Pause only decides what goes on the
coverage map, and is itself logged.

Segments close at 4 MB or 30 s; the open segment is rewritten whole about once a second, so a
crash loses at most ~1 s. A failed write keeps the data and retries, and **the error stays shown
until that write succeeds** — a later success on another file must not clear it. Memory is bounded
by one segment; ~90 records/s is ~6 MB/min.

### Position here is NOT the panel's averaged position

The feeds come straight from the websocket handlers, not from a render — renders coalesce packets
under load. Each axis is its own track built only from **new** measurements, stamped with that
head's own timestamp minus a **LiDAR Latency** parameter (default 0, unmeasured), tilt-corrected
per measurement.

This (1) removes the lag of timing by the packet, which repeats a measurement for up to ~90 ms —
simulated, −6.7 mm of bias at 200 mm/s becomes 0; (2) **refuses** sweeps while a head is not
measuring, instead of filing them at a carried, frozen value — simulated, 60 mm off; and (3) uses
no averaging window. Interpolation only, with a 0.35 s gap limit.

Measure the latency with an out-and-back pass; the raw data allows refitting it offline anyway.

**Placement waits up to 400 ms for the forward head's next measurement** once X and Y bracket a
sweep. Without that, a third of cells had no standoff and drew invalid, because the heads measure
at different moments.

### Rough output

The **first** sweep placed in each cell, kept in memory, drawn through the C-scan's own code —
`applyBscanBg`, `computeCellValues`, `planViewScales`, the same colormap and smoothing — so it
cannot disagree with a C-scan of the same cells. Background models are fetched from `/api/models`.
Computed only while showing.
