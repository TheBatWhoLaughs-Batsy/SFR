# Background subtraction

**Purpose** — remove the wall face and the static coupling so a target beneath them is visible.
Without it a target sits 16.6 dB below the wall return, on its skirt.

**Location** — `App.jsx` `sfcwProcessed` (live display), `lib/bscanBg.js` `applyBscanBg()`
(C-scan, SAR, 2D Map, Aligned), `lib/bgModelInterp.js`, `lib/bgModelInfer.js`,
`lib/bgContinuous.js`, `lib/bgCaptureStats.js`, trainer in `bgmodel.worker.js`.

**All of it is groundstation-side.** The Pi ships raw `h_cal` and holds no background state —
see `.harness/DECISIONS.md`. The commands `sfcw_capture_bg`, `sfcw_clear_bg`, `bscan_capture`
and friends no longer exist; a "capture" tags the next sweep to arrive.

---

## Three mutually exclusive sources

| | valid where | use |
|---|---|---|
| **captured reference** | near the standoff it was taken at | quick single-position work |
| **interpolating model** | across the standoff span it was captured over | a hand-held or varying standoff |
| **Super Fit** | the exact grid it was captured on, cell for cell | a rover raster on a non-parallel wall |

Selecting one clears the others.

**The model path is strictly better for B-scans.** A captured reference is valid only near one
standoff; a model is evaluated at *each position's own* standoff, so no alignment is needed.

**Super Fit** stores every cell of a completed grid and subtracts each new capture from the
reference at its own `(grid_ix, grid_iy)`. It exists because a 700 × 150 mm grid measured a
17 mm standoff span — the rig is not parallel to the wall — and a corner reference only managed
14-18 dB. Keyed by cell index, never capture order; grid geometry is locked while one is loaded;
it requires a **full** grid. On a synthetic tilted wall it gave 61 dB of contrast against a
corner reference that did not even make the target the brightest cell.

## Complex and magnitude are different jobs

| | what | for | standoff tolerance |
|---|---|---|---|
| **complex** | vector difference of `h_cal` | *seeing* — removing the wall | poor: 1 mm = 12° at 5 GHz |
| **magnitude** | dB or linear difference of the profiles | *deciding* — this is the statistic that has detected a target | good: survives ~1 mm |

Neither is a better version of the other. **This was deleted once and must not be again.**

Complex subtraction must write back into `h_cal_real/imag` — `SfcwDisplay` recomputes its own
profile from those, so anything replacing only `magnitudes` is silently discarded. Magnitude
subtraction cannot be expressed as a modified `h_cal` at all, so the background spectrum is
passed through and differenced in the display, which keeps the window controls live and
guarantees both profiles are built identically.

**In magnitude mode, dB and LINEAR are two different quantities, not two views of one.** dB is a
*ratio* — level-independent, amplifying noise wherever the profile nears the floor. Linear is an
absolute amplitude difference, so a bin on the noise floor contributes almost nothing however
wildly its ratio swings. Range compensation is disabled in magnitude mode (it cancels exactly),
and the waterfall is cleared on a mode change because existing rows are a different quantity.

## The interpolating model

Akima over the captured knots, with a phase **unwind** at `α = 0.80` applied on build and
rewound on inference. Leave-one-out on a 30-position bench set: Akima 20.2 dB, cubic spline
20.3 dB but −12.3 dB on a bad knot, a 1-64-64-302 MLP 4.9 dB, nearest position 7.4 dB.

α = 0.80 beats α = 1.0 (20.5 against 19.1 dB) over a broad plateau. Unwinding removes fast phase
but injects the LiDAR's own error into the target; 0.8 is the trade-off point.

**Position density is the dominant lever** — roughly 12 dB lost per doubling of median gap
(5.9 mm → 19.3 dB, 11.8 mm → 6.9, 17.7 mm → −3.3). Capture as densely as patience allows; this
matters far more than any modelling choice.

**Do not merge capture sessions.** Merging two sets five minutes apart scored *worse* than either
alone — the density gain is cancelled by the 21 dB inter-session disagreement being injected into
the interpolation.

### Querying outside the captured span is the false-target mechanism

`inferInterpModel` **clamps silently** and returns a confident-looking spectrum.

| outside by | 1 mm | 2 mm | 5 mm | 10 mm | 20 mm |
|---|---|---|---|---|---|
| suppression | 20.6 dB | 14.6 | 6.8 | 1.1 | **−3.5** |

Negative means the subtraction **adds more energy than it removes** — it manufactures a return
where there is nothing. Confirmed live: in-span 25.98 dB interior, clamped 5.43 dB, a 20.55 dB
penalty. Ranked by cost: clamping outside the span **20.6 dB**, single-sweep SNR **5.2 dB**,
standoff noise **0.4 dB**.

This fired constantly under a wrong LiDAR offset, because every live query fell below the
model's lowest knot. It also explains why *freshly* trained models failed the same way: a fresh
model covers only the span the operator swept, so pressing the aperture closer than the nearest
knot is already outside it. **Span coverage, not offset, is the thing to check.**

The panel reports `BG applied: YES / YES (CLAMPED) / NO` with a reason. "A model is loaded" and
"the model was applied" are different statements.

### A model has a shelf life

Cross-session scoring: ~5 minutes apart, 21 dB; ~16 hours apart, ~8 dB. **Any RF cable,
connector, antenna or gain disturbance invalidates a model, and the failure is silent** — the
model still interpolates confidently and still reports "BG applied: YES".

**Cheap staleness check, no recapture needed:** score traverse-against-traverse coherence versus
traverse-against-model coherence. If the first is ~0.99 and the second is well below it, the
model is stale, not wrong.

Models record a `geometry` stamp — LiDAR offset, the full sweep parameters including tx2/rx2 —
and the panel warns when a loaded model's stamp disagrees with current settings.

### What the model is limited by

In-span is **model limited, not SNR limited**. Coherently averaging K sweeps of a static capture
gives +2.83 dB from K=1 to K=16 against an ideal +12, plateauing at ~22 dB — right at that set's
own leave-one-out. So sweep noise is worth ~3 dB and no more, and raising `num_buffers` cannot
buy more than that.

**Hand-placement scatter costs 6-7 dB** and is the largest capture-side lever after density.

### Structure, for anyone modelling it

The background is dominated by two components: **α ≈ 0 — a static cable and coupling reflection
that does not depend on standoff at all** — and α ≈ 0.93, the wall face, 3.4 dB down. That is why
the measured standoff sensitivity is far gentler than a single-echo analytic table predicts, and
**why that table must not be used to predict suppression.**

A linear-phase fit reaches 18-22 dB guarded; adding a second bounce and a wall amplitude slope
buys 2-3 dB. Nothing exceeds ~22 dB. The ceiling is data at specific standoffs, not model form.

## Continuous capture

Wave the module slowly across the span; each sweep is filed under the standoff it was actually
taken at into a fixed bin, and **each occupied bin becomes exactly one "capture"** in the
existing shape — so coverage analysis, export, the builder and the trainer are all untouched.

**Standoff is INTERPOLATED from the LiDAR track, and that is the whole accuracy story.** The
sensor measures at 11-17 Hz against much faster sweeps, so stapling a carried reading to a moving
sweep is a pure lag, and therefore a **direction-dependent bias** — an out-and-back wave lays the
same physical standoff down in two places, which is exactly what a coherent model cannot absorb.

| standoff from | rms error | out-and-back bias | sweeps kept |
|---|---|---|---|
| carried reading | 0.851 mm | 1.100 mm | 100% |
| fresh-reading filter | 0.445 mm | 0.016 mm | 38% |
| **interpolated (shipped)** | **0.322 mm** | 0.041 mm | **99%** |

The fresh-reading filter is not a bad answer, and why is worth understanding: a measurement
landing inside the sweep's own window is on average at that sweep's midpoint, so requiring one is
*unbiased*, not merely bounded. It just costs 62% of the sweeps. Interpolating is unbiased too,
keeps 99%, and is quieter because it averages two measurements.

Two filters remain:

1. **Not bracketed** — no interpolant exists if the sweep is not spanned by two measurements
   within 0.25 s. Dropped, never extrapolated.
2. **Too fast** — standoff changing *during* a sweep is a phase ramp across the band that
   interpolation cannot fix. Speed is a **least-squares slope over a 350 ms window**, not a
   consecutive difference: 0.4 mm of noise across a 70 ms gap is ~6 mm/s of phantom speed.

**The sweep's own timestamp is stamped at its END**, so the interpolation asks for the standoff
at `timestamp - period/2`, with the period a running median. That midpoint labelling is what
makes a fast wave affordable — labelled by the end stamp, the apparent standoff error is 2.7x
worse.

Default wave speed **100 mm/s**. The binding term is the apparent range shift, 0.38 mm at
100 mm/s against the interpolation's own 0.32 mm residual — so under ~100 mm/s is not the
limiting term. Speed sets **per-pass** granularity only; further passes fill the gaps because the
LiDAR cadence and the pass timing are incommensurate. **Watch Hole, not Span.** A fast wave is
not broken, it just needs more passes.

**Bin width floors at 0.5 mm** because the interpolator merges knots closer than that.

### Two scoring traps in the per-bin dB number

- **A bin with exactly one sweep scores 317-330 dB**, because the variance about the mean is
  exactly zero and a guard turned 0/0 into a huge number. Coherence came out exactly 1.0, so the
  least trustworthy bin in the set painted green and rescaled the whole chart. `n < 2` now
  returns **null** — undefined, not infinite — and the sweep count is displayed beside every
  position.
- **A thin bin containing one corrupted sweep scores negative.** The static protocol diluted one
  garbled sweep across 40 good ones; a bin of 2 or 3 does not. Each bin is screened by the
  **median** complex correlation of each sweep against the others — a median, because a mean is
  dragged by the very outlier being looked for. The 0.90 threshold sits in a very wide empty gap:
  sweeps of the same scene inside one bin correlate >0.99, a garbled sweep ~0.14. `n < 3` is left
  alone, and a bin where nothing agrees with anything is kept whole — that is not one outlier,
  and deleting it would put a hole in the model instead of a visibly bad knot.

## The deleted alignment, and why fixing its sign is not enough

`bgForStandoff()` used to phase-align a captured reference by the standoff difference. It
applied the shift **backwards**, doubling the error rather than removing it, and it was never a
toggle — it applied itself silently whenever both cells carried a standoff.

| alignment | −1.0 | −0.25 | **0 (none)** | +1.0 (as shipped) |
|---|---|---|---|---|
| suppression | 6.41 dB | 11.88 | **10.90** | **4.38** |

Correctly signed full alignment still scores *worse than doing nothing*, because the dominant
background component does not move with standoff at all. The whole thing is removed.

## LiDAR offset

`lidar_antenna_offset_mm`, per mounting, in `localStorage.lidar_antenna_offset_mm_v2`.
**Re-measure after any re-mount**: antenna aperture flush against the wall, read the LiDAR.

A *constant* offset error cancels exactly for a model trained and used under the same offset —
the unwind factor is common to every knot and is undone by the rewind. What it breaks is every
standoff number being unphysical, and any model built under a *different* offset being silently
mis-indexed into the clamping regime above.

A model can be **migrated** between offsets exactly rather than recaptured: shift every knot's
standoff and rotate both the values and the Akima slopes. Rotating the slopes (not recomputing
Akima, which is nonlinear per component) makes inference identical to 2.7e-15.

**`groundstation/models/` is gitignored**, so a model lives only where it was saved — except on
the Pi, which now serves `/api/models` as the shared store.
