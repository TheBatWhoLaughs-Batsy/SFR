# SAR reconstruction

**Purpose** — back-project one row of a C-scan into an image of the wall's interior.

**Location** — `lib/sarReconstruct.js` (the kernel), `sar.worker.js` (a thin wrapper),
`SarPanel.jsx`, `SarDisplay.jsx`, `lib/permittivityEstimate.js`, `components/SarWall3D.jsx`.

The kernel was split out of the worker so the benchmark and the detector can drive it directly;
the split was verified to produce an identical image, coherence and every scalar.

---

## Geometry

`R = standoff_p + n·√(dx² + depth²)` refracted through a layered **air / wall / air** stack,
`n = √εr`. There was no permittivity anywhere in this path at all once — it reconstructed in
air, so the hyperbola had the wrong curvature and the depth axis read √εr too deep. Restoring it
was worth **11 dB** of target contrast, more than every other parameter combined.

**`maxDepth` is true depth below the wall face, not apparent range.** Reaching depth z needs
apparent range `standoff + n·z`, so the record bounds the grid; the request is clipped and the
panel says so.

### Per-position standoff correction

Each cell's own recorded standoff is added to the path. Measured by injecting known standoff
scatter and re-migrating — target coherence:

| injected σ | 0 | 3 mm | 5 mm | 10 mm | 30 mm |
|---|---|---|---|---|---|
| uncorrected | 0.591 | 0.557 | 0.358 | 0.156 | 0.163 |
| corrected | 0.591 | 0.591 | 0.591 | 0.590 | 0.591 |

**Uncorrected you need standoff stable to ~3 mm; corrected it is immune out to at least 30 mm.**
That is the difference between needing a precise rig and not. It gained nothing on a scan that
already held standoff to ±1.5 mm — do not read that as "it does not matter".

A **negative** standoff is kept as a pure broadside delay, not clamped to zero — clamping
reconstructed that one cell flush with the wall while its neighbours kept their gap. The worker
reports the count and the panel warns that the LiDAR offset is too large.

### Layered refraction

The straight-ray model is fine broadside and badly wrong at the wide angles that carry the
cross-range resolution:

| lateral offset | 5 cm | 10 cm | 15 cm | 20 cm |
|---|---|---|---|---|
| two-way phase error at 5 GHz | 3.4° | 13.7° | 34.8° | **106.2°** |

**A thin air gap is not a small angular perturbation** — Snell turns a ~27° ray inside the wall
into a ~76° ray in the air gap, so the true crossing point moves centimetres sideways even
though the gap is millimetres thick.

Solved by a **ray-invariant table**, not per-pixel root-finding. Sweeping the Snell invariant
traces the ray fan outward from broadside; lateral offset and optical length are both monotonic
in it, so one table per (position, depth) inverts by interpolation for every pixel in that row.
256 samples, sin-spaced so they crowd towards grazing. Verified against a brute-force Fermat
minimisation: worst disagreement 0.0012 mm against a 49 mm range bin.

**The loop is position-outer** so the table is built once per row. A lookup past the fan's reach
returns a miss and the caller **skips** that contribution rather than extrapolating a path no ray
takes.

Layered refraction is **coherent-mode only** — the incoherent path sums magnitudes, so there is
no phase for a path correction to act on.

It acts mainly on **coherence, not amplitude**: on the one scan where it was ablated it barely
moved the amplitude gap but dropped a clutter lobe's coherence from 0.81 to 0.54 while raising
the target's from 0.82 to 0.89.

### Aperture limit

`apertureAngleDeg`, default **45**. Summing every position into every pixel integrated a 17 cm
pixel over ±35 cm of aperture — out to 64°, where the antenna barely illuminates and the
refracted ray is near grazing: little signal, full clutter. Position error **halved on both
labelled corpora**. 45° is also roughly where the beam physically is, so it was chosen over the
false-alarm-optimal value.

`apertureNormalize` (divide by contribution count) exists and is **off**: with the angle limit on
it boosts exactly the thin-support pixels whose sums are noisiest, and costs recall. The problem
at a scan's end is a **one-sided** aperture, which no scaling fixes.

## Coherence, and why it must be debiased

`|Σ c| / Σ|c|` over the back-projection's own contributions, computed in the same loop. It asks
whether the positions agreed in phase rather than whether they summed to something large.

**The raw ratio is not comparable across the image and shipping it that way is a bug.** N random
phases still sum to ~`1/√N` of their incoherent total, and N varies hugely because deep and
off-centre pixels need an apparent range the sweep does not contain. Raw coherence peaked at
0.997 in the deepest image corner, on 2-3 contributions, above the real target. Fixed with both a
minimum-contribution floor and a rescaling so chance maps to 0.

**Both panes are drawn at once, deliberately — the reading is the pair.** Coherence does *not*
uniquely pick a target: a feature at the opposite aperture edge can score comparably and cannot
be controlled for without extending the scan past it. **Treat an edge feature with suspicion.**

The combined view multiplies linear amplitude by coherence. Note the amplitude image already
contains the *raw* coherence once by construction, so this weights it a second time and by the
*debiased* figure — a deliberate display choice to punish bright-but-unfocused clutter. Roughly
doubles target-versus-clutter separation.

**With no clutter removal, combined amplitude × coherence peaks in the deepest image rows** (few
contributors, coherence ~0.9). Misleading as a detector there.

## Permittivity

`lib/permittivityEstimate.js` **suggests**; a button copies the value into the field. Coherent
mean of every cell's **raw** `h_cal` — never the background-subtracted input, since a model
removes exactly the wall echoes needed — Hanning, zero-padded IFFT, log-parabolic peak
interpolation. The strongest peak is the front face; each later peak implies
`εr = (separation / thickness)²`.

**Offset-free by construction**: it uses a separation, so range offset and LiDAR offset cancel.

**It needs the wall thickness.** A wrong thickness gives a confident wrong answer.

**The highlighted pick is restricted to εr 3-10, not the strongest echo**, because the strongest
candidate on this bench is a **rig** echo: it appears in the background model at every standoff
(its peak range barely moves with standoff, slope ~0.08 where a wall echo must show ~1) and
repeats at an even ~23 cm spacing. Nothing in one scan separates rig from wall. The chip keeps it
available for a wall that really is ~2.4.

**εr and wall thickness are degenerate** — what the data measures is `n·T`. Calibrate from
geometry (a tape measure, or a metal plate against the far face) rather than from autofocus.

**Do not read depth as a classifier at this bandwidth.** An in-wall echo maps to `(R−s)/n` and a
beyond-wall one to `T + (R−s−nT)`, so the gap between them grows with n whatever is really
there. At a wrong εr the same data showed a clean 1.6 cm separation stretched into an apparently
decisive one. Report the measured depth; do not lean on a `behindWall` boolean.

## Row selection

**SAR reconstructs ONE row of a multi-row C-scan.** Before that it fed every cell of every row to
a 1-D back-projection, which fell back to capture order and produced a meaningless zig-zag
aperture.

Positions come from **`grid_ix`**, not the array index, so a missing column is a gap rather than
a slide — a missing column used to shift every later cell by a pitch. Falls back to the index
when `grid_ix` is absent or repeats, and the result says which was used.

The row stepper walks only rows holding data and moves an open C-scan row pane with it, so the
two panels always agree. Rows are numbered `iy + 1`.

## Orientation

Lateral position left to right, depth **increasing bottom to top**, wall face on the bottom edge
— matching the C-scan's rotated row pane. The lateral axis starts at the first captured column,
so a row beginning part way into the grid reads the same x as the C-scan.

## Window

`sarWindowType`, default rectangular, sharing `windowFn` with CFAR and the Imaging Bench.
**Which window wins is unsettled** — one measurement favoured rectangular, two later ones
favoured Hanning on the weighted gap. The control is exposed rather than the answer baked in;
A/B it on a target-in / target-out pair.

## SVD clutter removal

**Rank 1.** At rank 1 the peak sits on the target; rank 2 recovers far pipes on one corpus and
triples false alarms on another; rank 3 collapses both and eats the target outright. An adaptive
rank from the singular-value spectrum was tried and **fails because noise is delocalised too** —
it keeps removing until the detections are gone.

## 3D wall twin

`lib/wallTwin.js` (pure) plus a lazily-loaded three.js view. Cuboid to scale; one cylinder per
confirmed target spanning the scanned height; moisture drawn as translucent boxes.

**Pipes need not be vertical**, but a lean is kept only when the change across the scanned
height exceeds the **lateral resolution** (3.2 cm) and 3 standard errors of the slope. A looser
gate gave straight bench pipes 11-18° leans — per-row peaks drift 1.4-1.9 cm from half-pixel
quantisation and the offset between rows driven in opposite directions. The view states the
smallest measurable lean; **scan taller to measure leans.**

Read `devicePixelRatio` and `requestAnimationFrame` from the **host element's own window**, not
the global — a projected window can be on a different display, and a browser throttles rAF on a
page it considers hidden.

## Geometry lessons from the bench

- **A target stuck to the back face cannot be separated by range, ever.** Depth gating, time
  gating and range resolution are all aimed at the wrong axis when the target and the interface
  are at the same delay. The discriminant has to be cross-range structure or polarisation.
- **Coherent amplitude saturates at ~15 positions of one-sided aperture.** A target 3 cm from the
  end of a scan is reconstructed from about half its available aperture. **Overscan 15-20 cm past
  the region of interest**; a longer scan overall is not what is needed.
- **Scan perpendicular to the pipe axis.** A pipe parallel to the scan gives a constant-range flat
  event with no hyperbola and no coherence signature — indistinguishable from the back wall.
- **Sensitivity to εr is itself a discriminant, and a cheap one.** A compact scatterer focuses and
  brightens as the velocity approaches correct; a layer or a smear is indifferent to it. Sweep εr
  and watch which blobs respond.

## Defaults

`sarWallThickness 15.2` cm, `sarEpsilonR 4.84`, `sarRefraction true`, `sarMaxDepth 20` cm,
rectangular window, SVD rank 1. **These are the gw2 bench** — set the thickness and permittivity
for whatever wall is in front of the rig; see `wall-materials.md`.
