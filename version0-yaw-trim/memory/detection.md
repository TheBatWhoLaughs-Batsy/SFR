# Detection — pipes and seepage

**Purpose** — turn a reconstructed scan into rated findings, not a picture to squint at.

**Location** — `lib/sarDetect.js` (pure), `lib/seepageDetect.js` (pure),
`lib/sarDetect.worker.js` (coordinator), `sarDetectRow.worker.js` (pool member),
`hooks/useSarDetect.js`, benchmark in `groundstation/frontend/bench/`.

`sarDetectMode` switches **Pipes | Seepage** in the SAR panel. They are different detectors with
different bands and different verdict vocabularies.

---

## Pipes

On every scan or geometry change (800 ms debounce) the whole scan is reconstructed **six ways
per row** with a FIXED chain — rank-1 complex SVD, Hanning, coherent, layered ray, auto standoff,
εr and thickness from the panel — independent of the display's own toggles. The six variants are
the six tests; `sarDetect.js`'s header holds their definitions.

Search band **5-20 cm** below the wall face.

### Ratings

- **confirmed** — 6/6 tests and ≥ 8 dB prominence
- **probable** — ≥ 4/6 including the row-support test and ≥ 4 dB; dropped if within 6 cm of a
  stronger confirmed (Hanning sidelobe)
- **reference** — a line of the loaded empty scan is matched to it one-to-one
- **unresolved** — inside `endExcludeCm` of either end, applied only while Handle ends is on, via
  `effectiveRating` so the toggle costs no recompute

The rows test needs ≥ 60% of rows. A single-row scan rates weakly and the panel says so.

### Line search, not column averaging

Averaging each column across rows only finds **vertical** pipes; a leaning one smears. Each row
keeps its own peak profile and every straight line through the rows is scored by mean linear
power along it. Slope 0 reproduces the column average exactly.

- **Lines are compared by MEAN LATERAL DISTANCE over the rows**, everywhere — merging, the six
  tests, reference matching, sidelobe removal. Comparing mid-height x plus drift let steep lines
  thread from a pipe to a feature 3-4 cm away and escape every check.
- **A slanted line needs +2 dB more prominence to rate probable.** Searching many slopes lets a
  line thread clutter by chance; those score 4-5 dB where real slanted pipes score 10-18.

### The empty reference is matched one-to-one

Cheapest first, by a combined distance-and-depth cost. Independent per-line matching broke on a
tall slanted scan: a weak empty-scan line 4 cm shallower vetoed a real pipe while the wall
crevice's own line escaped by 0.1 cm. One-to-one lets the crevice take the crevice's reference.

**The reference must be from the same session and setup.** An empty scan 3.5 h earlier at a
different standoff did not contain a wall feature that a scan taken *among* the target scans did
— and using the latter as the control removed every false alarm.

Take an empty scan immediately before and after a target session and diff against the nearest in
time. Loading no reference is allowed and the panel warns: on this bench a real wall crevice
rates **confirmed** on its own, and projected on a wall that is a confident false pipe.

### Normalisation, and the 50%-zeros cliff

`gridWeight` divides each scan's amplitude × coherence by the median of its **non-zero** pixels.

Debiased coherence is exactly 0 on many pixels — by depth, 15-70% depending on band and scan. A
median over *all* pixels therefore moves with how many pixels failed the coherence test, and by a
different amount in the target and reference scans, which silently shifts reference matching.
Widening the band from 12-26 cm to 5-20 cm that way cost 4 targets and doubled false alarms.

**Past 50% zeros the all-pixel median is itself 0** and scores blow up to ~150 dB. An
in-wall-only band crosses that. The non-zero median is independent of the zero fraction; it was
chosen after re-rating 243 neighbouring threshold settings, where it kept every target in 27
settings against 0 for the alternative.

### Clutter removal

Rank-1 SVD is the base, with the physical along-track fit as a **cross-check** — the test that
asks whether two different clutter models agree. Promoting the fit to primary gives the same
recall with more false alarms. See `sar.md` for why rank 2 and adaptive rank both fail.

The guarded-fit window is in **centimetres**, converted with the scan's own pitch. It was in
columns, which silently doubled the physical support when the pitch changed — a different clutter
model for the same wall.

### Speed

42 reconstructions per 6-row scan. Three changes took it from ~7 s to ~1.2 s in the browser, all
bit-identical:

1. **Worker pool** — one task per row, pool size `min(tasks, hardwareConcurrency − 1, 12)`. A row
   worker that fails or will not start falls back to running in the coordinator. Nested `?worker`
   imports work under both `vite build` and the dev server.
2. **Shared ray tables** — `reconstructMany()` walks grid columns so a (column, depth) table is
   built once for every variant holding that column. Shared only on **exact** equality, and each
   variant adds contributions in the same order, which is why it is bit-identical. Caching tables
   instead would cost ~55 MB per row per worker.
3. **Cached empty reference**, keyed on the panel parameters, detector options, target grid and
   sweep plan. Saves little on a 6-row scan — the reference rows already run beside the target
   rows — and matters once rows outnumber workers.

The coordinator and pool are respawned on every detection, which is how a stale run is cancelled.

Not done, from the same profile: reconstructing only the depths detection reads, a persistent
coordinator, per-row caching during a live raster, progressive results.

---

## Seepage

Different physics, so a different detector. Band: 3 cm below the face to 3 cm above the back
face. Per row, the row's complex mean is removed, then a Hanning matched filter straight down at
each depth, smoothed. Score is dB over the median of the same (row, depth) along the row; a patch
is 8-connected cells above threshold spanning ≥ 3 rows and ≥ 2 cm, with 8 cm ignored at each end.

Ratings: `moisture` (survived the empty check), `reference` (the empty scan has it too, hidden
but counted), `unverified` (no reference loaded — shown amber, because fixed wall features look
identical).

**Water is not a point target, and that is the whole reason it needs its own detector:**

- its coherence is ~0.09 where a pipe is 0.32-0.37, and 36% of its pixels are exactly 0, so
  amplitude × coherence costs it ~12 dB relative to a pipe;
- **it loses from aperture where a pipe gains.** Reconstructed from a 4 cm window a seepage patch
  reads +10.4 dB over the empty scan and a pipe +0.2; over the full row the seepage falls to
  +4.9 and the pipe rises to +6.0. A compact scatterer gains as positions focus onto it; water is
  diluted by wide angles.
- **coherence itself does not separate them** — at short aperture every case including bare wall
  reads 0.87-0.99 (little chance correction with few contributions). Use the aperture dependence
  of amplitude.
- **it only shows with clutter removal on.** At the panel defaults (SVD off, rectangular) the
  same place reads −1 to −2 dB, because the rig echo and face coupling dominate the in-wall
  amplitude.

**Per-cell dB against an empty pass does not work** — pass-to-pass noise is too large for a
signal this weak (raw passes suppress each other by only 12.6 dB). Patches are found in each scan
on its own and **vetoed** by the empty scan's own map.

The back-face window is centred per cell on `standoff + √εr · thickness`, not on a fixed display
range. A wet patch shadows the back face behind it by ~1-2 dB, which corroborates.

**Known false alarm:** a patch at x ≈ 27-28 cm rates possible moisture in two rod scans against
one reference. Unexplained.

---

## The benchmark: `npm run bench`

`groundstation/frontend/bench/` — `corpus.json` (ground truth), `run.mjs`, plus `register.mjs`
and `resolve-ext.mjs`, a Node ESM resolve hook supplying the `.js` extension Vite resolves for
us.

**It drives the shipped `lib/sarDetect.js` in place.** No copying the lib to a scratch directory
and rewriting its imports — which is how earlier checks ended up measuring a copy. This is why
`projectRowsForDetect` moved out of the hook and into the lib: the harness splits a saved scan
into rows with the app's own function.

Scans are **not committed** (~9 MB each); `--dir` says where they are. Flags: `--only`, `--ref`,
`--handle-ends`, `--json`, `--opt k=v`, `--sweep k=a,b,c`. Reconstructions are cached per scan and
the reference's lines per (empty, plan), so a threshold sweep is scoring only — the whole 8-scan
set is 12 s and each further sweep point is milliseconds. **`RECON_OPTS` lists the options that
invalidate that cache.**

Current baseline, `sfr-2026-09-20` with `--handle-ends`, re-run 2026-09-21:
**11/12 targets rated, 12/12 present**, bias -0.98 cm, median |dx| 1.04 cm. False alarms per
scan depend on the reference — `empty.json` 0.29, `empty 2.json` **0.00**, none 0.25. The two
empties bracket the session and the later one removes every alarm the earlier one leaves,
which is the contemporaneous-reference rule showing up in the score.

**Always record the flags beside the number.** The same run without `--handle-ends` reports
0.43 false per scan, every one of them at a scan edge.

The `gw2-2026-09-13` figures (10/10, 0.29) come from the log and have **not** been reproduced
since — those scans are not on any machine here.

**Every threshold was originally fitted at `rx1_gain = 25`, which was compressed.** Gates stated
in dB over a clutter median cannot survive a 10 dB change in the clutter. The benchmark exists so
a threshold change is scored against every labelled set at once. **Never tune on one corpus** —
see `scans-and-corpus.md` for why a single geometry cannot settle anything.

Position accuracy is limited by the tape, not the detector: median |dx| 0.5-1.0 cm against a
±3 cm truth.
