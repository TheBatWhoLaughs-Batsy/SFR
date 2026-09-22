# Scan sets — capture protocol and what each one proved

**Purpose** — how to capture a scan set that can actually answer a question, and what the
existing labelled sets are good for.

Scans are **not committed** (~9 MB each). `groundstation/frontend/bench/corpus.json` holds the
ground truth and points at them; `--dir` says where they live.

---

## Capture protocol, in order of how much each one costs to get wrong

1. **Do not move, re-mount or re-level the rig between the empty and the target capture.** This is
   the number-one rule, ahead of averaging. One set had standoff spanning 27-64 mm across five
   scans, with both target scans at one extreme and two of three empties at the other — best
   empty-versus-target suppression was **3.4 dB**, and the migrated images clustered by geometry
   rather than by pipe presence. The set could not answer its own question.
   If inserting the target requires disturbing the rig, capture **empty → target → empty** so the
   drift is bracketed and measurable.
2. **Take an empty scan immediately before and after a target session**, and diff against the
   nearest in time. An empty scan from hours earlier at a different standoff will miss a wall
   feature that appeared in between, and that feature then rates confirmed in every target scan.
3. **Level the rig against the wall.** A 17 mm standoff span over a 700 × 150 mm grid is what
   made vertical neighbours useless: **suppression tracks standoff change, not distance
   travelled** — moving 200 mm sideways changes standoff ~2 mm and costs a few dB; moving 150 mm
   up changes it ~10 mm and destroys the background entirely.
4. **Overscan 15-20 cm past both ends.** A target within ~5 cm of a scan's end is unresolvable by
   construction, and a bright feature on the final column is an end artefact until proven
   otherwise — it appeared in two independent scans and did not follow the edge when trimmed.
5. **Record the tape zero and the rover's start position.** Column 0 sits somewhere different on
   the rail every raster, which is expected. Match cells on **`grid_ix`**, never on `rover_x_mm`.
6. **Check the deployed build before concluding a capture setting had no effect.** One set came
   back at v6 with no per-cell sweeps, because the bench was running a groundstation build older
   than the commit that added them.
7. **Check `lidar_n` before blaming a model.** Whole sets have been captured with
   `lidar_standoff_mm: null` on every cell, which makes any model-based background dead on
   arrival.

## Pitch, speed and averaging are one resource

`sweeps/cell = pitch / (v × T_sweep)` — see `cscan.md`. 50 mm pitch is spatially aliased above
~3 GHz and back-projection on it is grating-lobe striping; **10 mm un-aliases the aperture and is
where migration first produced compact, focusable features.** 5 mm carries 3x Nyquist margin.
Below that, halving the pitch costs 3 dB of per-cell SNR for no resolution.

For a deep target in brick, sweeping 2-3 GHz only is both better-penetrating and unaliased, at
15 cm range resolution.

---

## Analysis traps that produced wrong answers

- **Always measure both axes before calling a spatial effect isotropic.** A decorrelation sweep
  that matched cells on x probed only the vertical axis, and "isotropic speckle, cut the pitch"
  was concluded from it. Horizontally, 50 mm sampling was fine all along.
- **Regression cannot separate space from time in a snake**, because capture index is a
  deterministic function of `(ix, iy)`. The **direction-reversal** test is the only clean
  discriminator: a gradient that keeps its sign on rows captured in opposite directions is
  spatial, not drift.
- **With two matched-geometry pairs among five scans, ANY "what do these two share that the other
  three lack" statistic ranks the two matched pairs top**, whatever the target does. Such a
  statistic is only interpretable when geometry is held constant across the whole set.
- **Beware fixed-lag correlation over a shrinking overlap** — correlation rises trivially as the
  overlap shrinks and a naive argmax parks at the search edge. Slide a fixed-width window.
- **Do not cross-correlate masonry to register two scans without a sanity check.** Brick courses
  are quasi-periodic at 15-23 cm, so a peak can be one course out.
- **Folding levels into one octave proves nothing about lattices** — it forces ratios near 1 by
  construction. A "power-of-two normaliser" was inferred that way and retracted.
- **Interleaving is wrong for anything reconfigured per chunk over a bus that races.** It is the
  right method for gain A/Bs and the wrong one when each chunk change is itself unreliable.
- **A single strongest feature landing on a real target is not attribution** if the level at that
  column also tracks standoff monotonically across the set. Both explanations fit.

## What the labelled sets are

Two corpora in `corpus.json`, both scored by `npm run bench`:

| set | shape | notes |
|---|---|---|
| `gw2-2026-09-13` | 7 scans, 140 × 0.5 cm, 6 rows × 1 cm | `rx1_gain = 25` — **compressed**; every original threshold was fitted here |
| `sfr-2026-09-20` | 8 scans, 70 × 1 cm, 6 rows × 2 cm | `rx1_gain = 12`, bracketing empties, tape on the wall |

Current score: 11/12 and 10/10 targets rated, 0.25 and 0.29 false alarms per scan.

**Every filename in the older evening set overstates the pipe count by one**, and one file named
for a pipe contains none — it is a second empty control taken among the target scans. Trust
`corpus.json`, not filenames.

**A real wall defect sits at x ≈ 36 cm on the gw2 bench** — the only one. It is in every scan
including both empties, rates confirmed without a reference, and images **at the back face**
(12-16 cm) because its front-face end has no reflecting discontinuity broadside and sits inside
the coupling band the clutter removal takes out. It is not a false alarm and not a target.

A second reflector entered the gw2 scene at x ≈ 36 cm between two scans taken six minutes apart,
which is why the *contemporaneous* empty control is the one that works.

## Seepage pair

`empty.json` and `seepage.json` — water between bricks at x ≈ 37 cm, 5-12 cm deep, 17 minutes
apart. The water shows in 9 of 10 rows at the right place and depth with clutter removal on, and
shadows the back face behind it by 1-2 dB. See `detection.md` for why it needs its own detector.

## Analysis harness

Drive the shipped worker and libs from node — copy nothing. See `.claude/skills/verify-lib`. Two
mechanics worth remembering: the worker's `image` is in **dB** (negative), not linear amplitude,
and `self` must be shimmed with `onmessage` called synchronously.
