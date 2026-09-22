# C-scan panel — 2D raster and plan view

**Purpose** — raster a grid of positions over a wall patch and show the result as a plan view.

**Location** — `CscanPanel.jsx`, `CscanDisplay.jsx`, `BscanDisplay.jsx`, `lib/cscanGrid.js`,
`lib/bscanBg.js`, `hooks/useRoverScan.js`. Replaced a B-scan panel; app state keeps its
`bscan*` names because the underlying record is still one trace per position.

`bscanParams` = `{ hCount, hStep, vCount, vStep, gateStart, gateEnd, metric, focusEnabled,
focusAperture }`. **`hStep` and `vStep` are in CENTIMETRES** — `hStep: 5` is a 50 mm pitch.
Easy to misread as 5 mm and conclude the gantry is mis-scaled.

---

## Two raster orders, one cell frame

Manual snakes **up from the bottom-left**; rover snakes **down from the top-left**, because
that is the natural way to drive a gantry. Both write the same `grid_ix` / `grid_iy` with
`iy = 0` still the bottom row, so everything downstream is order-agnostic.

**Cells are keyed on position or index, never on arrival order.** A partial row, an undone cell
and the two snake directions all break order-based reasoning.

The capture tag is an **object**, not a boolean — the rover raster has to say which cell a sweep
belongs to, because its capture index is not the manual snake's.

**START and the capture path are read from the DATA**, from each cell's own capture index — not
re-derived from the current `scanMode`. Import deliberately does not restore `scanMode`, so a
rover grid reviewed in manual mode used to have its path drawn backwards and its START marker in
the wrong corner.

## Locating the grid

There is no way to point at the wall, so the operator declares **the head's current position
relative to the grid origin** (the top-left corner). The rover then drives there in one move on
both axes.

- **A grid that does not fit the soft limits is refused, not clamped.** There are no endstops,
  and a clamped move still reports `completed` — so a grid hanging over the end of a rail would
  raster a rectangle that is not the one on screen, with duplicate cells at the limit.
- **The origin is anchored once per scan and reused by every later session on that grid.** The
  offsets describe where the head was standing *when they were measured*; after a stop the rig is
  parked wherever the abandoned row left it, so re-deriving anchors the grid somewhere the
  operator never measured. An anchor whose geometry no longer matches is refused, because
  changing a count or a step re-keys every cell.
- **Start is refused while the rover is moving.** The origin is only meaningful at rest.

## Continuous versus stepped

`continuous` (the default) drives a whole row in one move and bins the sweeps by the position
they were taken at. `stepped` stops at every cell. Both walk the grid in the same order.

The stepped flow was designed around a 550 ms sweep, where any motion smeared a sweep across
frequency. At a ~28 ms sweep the per-cell cost was ~93% overhead, and the sweeps that used to be
thrown away between cells become free coherent averaging.

### Smear is not the limit any more — spatial sampling is

Motion during a sweep is bilinear in step index and velocity. The linear term is range-Doppler
coupling, an apparent range *shift*; the quadratic term is the actual defocus. At 150 mm/s —
the X axis maximum — the shift is 2.05 mm against a 50 mm range cell and the quadratic term is
0.39 rad against the ~0.79 where defocus starts to matter. **Both are inside budget at any speed
this rail can reach.**

What binds instead is **`sweep spacing = v × T_sweep`**. A grid pitch finer than that leaves
cells empty however long the scan runs; those sweeps were never taken. So **pitch, speed and
averaging depth are ONE resource**: `sweeps/cell = pitch / (v × T_sweep)`. Pick two.

**Finer is not better past a point.** Spatial Nyquist for the imaging is 15-21 mm at 5 GHz, so
5 mm already carries 3x margin; below that, halving the pitch buys no resolution and costs 3 dB
of per-cell SNR.

### Details that are load-bearing

- **The traverse overruns both ends of every row**, and the overrun **floors at half a pitch
  plus a margin**. Cells are keyed by rounding to the nearest column, so everything within half a
  pitch of column 0's centre lands in column 0 — including the rig standing still at the row
  entry and the whole acceleration ramp, which is what the overrun exists to exclude. Both the
  hook and the panel must pass the pitch, or they refuse or admit different grids.
- **There is no static settle, and none is needed.** The traverse starts outside the grid, so the
  rig spends the whole run-up accelerating — 400-500 ms, all of it outside the cells. That is
  strictly better than standing still for 200 ms.
- **The row change is purely vertical**, and vertical is the slow axis. A snake ends row N and
  starts row N+1 at the same X. Any row pitch under 6.25 mm is a triangular move that never
  reaches full speed. On a narrow grid (short rows, many of them) the row change dominates.
- **The per-cell cap DECIMATES, it does not truncate.** Truncating kept the sweeps taken over the
  leading part of the cell, biasing every cell's reported position in the direction of travel —
  and therefore oppositely on alternate rows of a snake, which is the same signature as an
  uncorrected latency and just as invisible.
- **A partial row is harvested on ANY end** — completion, operator stop, e-stop, link loss, or
  the sweep dying. A row is a minute of driving.
- **Resume is by the first row that is not FULL**, not by a count of rows holding anything. A row
  stopped mid-traverse counted as done, so the next session drove past it and left a half-empty
  row in the middle of the grid with nothing on screen saying so.
- **Re-driving a row REPLACES its columns**, or one cell ends up with two records — which the
  plan view resolves by drawing the last one while the export, SAR and the colour scales see
  both.
- **The scan speed is the rail's max speed for the duration**, pushed at the start and restored
  on every exit path including unmount. `set_config` persists on the Pi, so failing to restore
  quietly slows every later nudge and jog.
- **Watch the HOLE, not the fill count** — the largest run of consecutive empty columns is what
  decides whether a row is usable.
- **Stop Session is an E-stop in rover mode**, deliberately: it is the only control on screen
  while the gantry moves on its own.

`roverLatencyMs` is the one remaining constant and is **0 until measured**. It is a BIAS, not
noise — its sign follows the direction of travel, so in a snake it displaces alternate rows
oppositely and a straight feature comes out as a zigzag of `2·v·τ`. Measure it from one
out-and-back pass over a row; the spatial lag between the two directions is exactly that.

## The plan view

Colour is `computeCellValues()` — **the single source of the number a cell is coloured by**,
used both by the grid that draws them and by the scale that sets the limits. They called the
metric separately before, which with focusing in the picture let the grid be drawn with values
the scale was not computed from.

- **One shared scale across both panes**, computed from every bin of every valid cell — the
  pixels the B-scan pane actually draws. Limits are **percentiles (p1 / p99.9), not min/max**: a
  single deep interference null would otherwise set the bottom of the scale and flatten
  everything, and a full min/max stretch of a flat residual field is exactly what manufactures
  rainbow structure out of noise.
- **A cell whose background fails is INVALID, not zero.** It draws as a red cross, is excluded
  from every scale, and is counted in the panel. Previously it fell through un-subtracted in a
  subtracted grid, 20-30 dB above its neighbours, so it both read as the strongest target and
  single-handedly set the colour limits. `bg_status` is one of `off` / `ok` / `clamped` /
  `no_standoff` / `no_ref` / `size_mismatch` / `no_superfit_cell`.
- **Cell rectangles snap by rounding the cell BOUNDARY**, so column ix's right edge and column
  ix+1's left edge are the same expression and therefore the same pixel. Rounding a position plus
  a width overdrew neighbours by up to 1.5 px — 11.6% of a cell on a 101-column raster.
- **The row's B-scan opens BELOW the grid, rotated 90° anticlockwise**, so depth runs
  bottom-to-top and position runs left-to-right, on the same pixels as the grid's horizontal axis
  directly above it. Column alignment is shared through a **ref**, not state, because both
  canvases already redraw at 60 Hz.
- The background reference row gets its own slot beside the grid, not a column in it — as row 0
  of an evenly-spread list it would shift every real column along by one.
- Smooth mode resamples at **grid** resolution so a value reaches exactly one pitch and no
  further, and cell centres survive the resample exactly. Cells that are not a value — uncaptured,
  gated out, background-failed — are still drawn as sharp squares on top.
- **Colormaps come from `lib/imagingEffects.js`**, one implementation shared with the Imaging
  Bench and CFAR. Adding a fourth map means re-checking the sentinel fill colours: inferno's
  bottom is near-black, which put the uncaptured-cell fill 15 RGB units from a legitimately
  low-valued cell. The **outline** is now the discriminator.

## Focusing

A magnitude-domain SAFT toggle that changes how each cell is reduced to a colour and nothing
else — the B-scan pane's traces are drawn exactly as recorded either way.

- **The kernel is shared with the 2D Map** (`lib/saft.js`), not copied. Two copies of a focusing
  kernel would drift, and both images would stay plausible while disagreeing about where a target
  is.
- **Focusing is PER ROW and only along the row.** A C-scan row is a line of positions at one
  height, which is the geometry the back-projection assumes. That is physical, not a
  simplification: the two axes are completely different animals — moving 200 mm sideways costs a
  few dB of background correlation, moving 150 mm up destroys it, because the standoff walks.
- **Neighbours are addressed by grid COLUMN**, not array position, so a hole does not close up
  and give every later column the wrong offset.
- **A background-failed cell is excluded from every aperture.**
- Focusing forces the plan view onto its **own** colour scale — a focused value is a
  back-projected sum, measured 12.7 dB above the unfocused maximum, so on a linked scale every
  cell would saturate the instant focus was switched on.

**Known transient:** while a row is filling, a leading-edge cell has neighbours on one side only
and reads dim, brightening as the row completes. The same truncated-aperture effect permanently
applies at the two ends of every finished row. The final image is unaffected.

## Live fill

The plan view fills **during** a row, not at the end of one — a 1 m row at 25 mm/s used to sit
blank for ~25 s and then fill in one jump, and the plan view is the only thing on screen that
says the scan is working.

`liveRow()` reads the open bin without closing it. **The live flush and the end-of-row harvest go
through ONE function** — the replace-by-(ix,iy) merge that already existed for resume. That is
what makes it safe to call repeatedly, and why there is no separate preview record shape to keep
in step.

- **The flush is skipped unless the bin's kept count changed.** Rewriting identical cells churns
  every downstream memo for no visible change.
- **4 Hz is a considered rate.** The cost is the whole derive chain re-running — measured on the
  Pi at 32 ms for a 147-cell grid and 52 ms for 303 cells, ~13-21% of one core. If it ever needs
  to go faster, **memoise the background subtraction per cell first** (it is a pure per-cell map,
  so a WeakMap keyed on the record works); do not just lower the interval.
- The SAR worker's 300 ms debounce therefore never fires during a traverse, deliberately.

## Processing controls

Window, Kaiser beta, Avg and coherent/incoherent live in the panel's Display section and **lock
while a session runs** — `avgCount` genuinely cannot change part-way through a raster, and the
window is locked with it so every cell in one grid is processed identically.

- **Window is a display parameter** and re-windows every stored cell on change. Rectangular stays
  the default: Hanning's wider mainlobe would swallow a target 7 cm from the wall face.
- **Avg is a capture parameter** and only affects cells captured after it is set.
- **Every sweep of a cell is stored** in `pos.sweeps`, because coherent-versus-incoherent is a
  *display* choice that has to remain flippable against recorded data. `h_cal` is the **coherent
  mean**, so everything that reads it without knowing about `sweeps` — SAR, the model trainer,
  Super Fit, the export — sees the averaged cell.
- **The background is subtracted from each SWEEP, before averaging.** For coherent averaging the
  two are identical; for incoherent they are not, and subtracting a complex background from an
  averaged magnitude is not a defined operation.
- **SAR is forced to coherent** regardless of the toggle, since it back-projects complex data.
- The rover capture watchdog scales with Avg.

## Export

**v7** (`sweeps` + `procParams`); import accepts v3-v7 and maps an old linear scan onto a
one-row grid. Import restores window, Kaiser beta and coherent/incoherent, but reads `avgCount`
back from the data — the sweeps are in the file and their number is whatever was actually taken.

Import deliberately does **not** restore `scanMode`, the rover offsets, the origin anchor, or
`range_offset`: those are live properties of the rig, not data. Restoring `range_offset` from a
file header is how a stale 0.5 got pushed to the Pi and into later scans.

## Still true, and worth knowing

- **The C-scan recomputes its own range profiles** and throws the Pi's away — rectangular, 4x
  zero-pad, no range compensation — even when subtraction is off.
- **The Live Sweep pane used the SFCW panel's background**, not the C-scan's. The pane is gone;
  the coupling is worth remembering if it returns.
- **`metric: 'energy'` is a mean, not a sum**, so it does not scale with gate width.
- Default gate is 2-70 cm with `metric: 'peak'`. With the wall at 13-14 cm, `max()` over that gate
  picks the wall in every cell — the plan view is then a wall-strength map. **Narrow the gate
  around the expected target depth and prefer `energy`.**
- **Fixture trap:** synthetic echoes must be placed at `depth + range_offset`. Placing them at
  the intended display depth puts them at negative distance where they are dropped, and every
  subsequent measurement is of sidelobes only — which still looks plausible.
