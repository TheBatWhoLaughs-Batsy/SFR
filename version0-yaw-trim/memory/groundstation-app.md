# Groundstation app

**Purpose** — the React UI, and the Flask server that hosts it.

**Location** — `groundstation/frontend/` (Vite + React, plain JS), `groundstation/app.py`
(Flask), `groundstation/run.py` (dev entry).

---

## Hosting

`app.py` serves `frontend/dist` and the `/api/models` background-model store on **port 5000**,
and `pi/start.py` runs it as a fourth service alongside the three websocket servers.

**`--debug` is opt-in.** `run.py` passes it so GS development keeps the auto-reloader;
`start.py` does not, because the reloader forks a child that a `terminate()` would orphan, and
an unattended service must not restart itself on a half-saved edit.

Every panel's model fetch is a **relative** `/api/models`, so nothing frontend-side knows which
machine Flask is on.

Serving costs nothing measurable: a 135 Hz sweep held while the app was served continuously, and
one cold page load is 36 ms of CPU over loopback. The heavy compute — SAR, detection — runs in
whichever client browser opens the page, and scales with *that* machine's core count.

`groundstation/models/` on the Pi is therefore the canonical shared model store. It is
gitignored, so a model saved anywhere else lives only on that machine.

Frontend workflow on the Pi: edit over SSH, `npm run dev -- --host` (5173, HMR over LAN, `/api`
proxied), deploy is `npm run build` (~9 s) plus a refresh.

The home screen has a **Fullscreen** button whose state tracks the `fullscreenchange` event, not
the click, so leaving via a system gesture keeps the label honest. **On iPhone Safari it is
deliberately absent** — iOS has no Fullscreen API for anything but `<video>`; Add to Home Screen
is the route there.

---

## Panels

`PANELS` in order: RF Calib, SFCW, Imaging Bench, C-Scan, Rover Scan, SAR, 2D Map, BG Model,
Handheld + IMU, Handheld Capture, Projector Demo. **Every subsystem must have a debug panel.**

Both RF panels share port 9003 — starting an SFCW sweep auto-stops any active TX/RX in RF Calib.

### Imaging Bench

Entirely **offline**: it reads a `waterfall_snapshot` JSON exported from the live waterfall and
re-processes it through 11 selectable effects, so processing chains can be A/B'd against
identical recorded data. It never touches the SDR socket.

**All effect math lives in `lib/imagingEffects.js` as pure `(snapshot, params)` functions**; the
display contains no signal processing. That split is what makes the effects testable head-first
from node with no React, and it is also where CFAR, the window functions and the colormaps live
for the whole app.

`prepare()` does the windowing and IFFTs once and is memoized, so switching effects or dragging a
slider never redoes them.

Two things in there must not be "simplified":

- **`computeCFAR` accumulates in a side-then-k order** that looks redundant next to the per-half
  accumulators the GO/SO variants need. Float addition is not associative, and the obvious rewrite
  shifts the threshold by ~3e-14 dB — the current form is what keeps the live display
  bit-identical to what it produced before CFAR was lifted out of the display.
- **CFAR runs on the full profile and clips afterwards**, so a range zoom's edges do not get a
  one-sided training window.

Effects needing multiple sweeps return a message on a one-sweep snapshot rather than rendering
garbage. Integration is done in the **range** domain, because averaging complex `h_cal` and then
transforming is identical, while a mean of magnitudes only means anything after the transform.

Canvas drawing goes through an offscreen `nx × ny` image plus one scaled `drawImage`, not
per-cell fills — at 100 × 1024 bins the latter is tens of thousands of fills per frame.
Non-finite cells render as a grey no colormap produces.

### SFCW amplitude scaling

`sfcwScaleRange = { dynamic, min, max, isDb }`. The live limits are computed **inside** the
display, so the display publishes them every frame into an App-level **ref** — a ref, not state,
so a fast sweep does not re-render the sidebar — and the panel reads it at the moment the toggle
is clicked, so switching to manual never makes the colours jump.

`isDb` records which units the pinned numbers are in; flipping dB/LIN hands the scale back to
dynamic, because dB limits are meaningless on a linear trace.

---

## Throttling, and its cost

The live display is throttled to ~20 Hz because at 36 Hz every sweep triggered the full
re-render cascade and the main thread could not keep up with its own socket — the browser *was*
the slow client the Pi now evicts.

**Only the React state driving the display is gated.** Every capture path reads the local message
and still sees every sweep, and the throttle is bypassed outright while any capture is armed.

**Anything measured from state behind that throttle reports on the throttle.** A fixed 50 ms gate
against a 27.9 ms sweep passes exactly every other sweep, so a rate derived from `sfcwResult`
read half the true rate — 17.93 Hz against a genuinely-degraded image's 18.02 Hz, which is not a
distinguishable difference on a readout. The header now derives from a measurement taken **above**
the throttle. Do not reintroduce a rate derived from throttled state.

Refs, not state, wherever a fast stream drives something the sidebar does not need to re-render
for: the dynamic scale, the C-scan layout shared with the row pane, the continuous-capture
accumulator, the rough-view point buffer.

## Dev-only memory growth

**React 19.2's development build records every component render with `performance.measure` and
attaches a diff of the changed props.** The browser keeps those entries. Props carrying a large
drawing made each render megabytes: 198 brush events produced 3,382 measures holding 642 MB, and
renderer memory grew 84 MB → 4.7 GB in 60 s while the JS heap after GC stayed at 12-17 MB.

`main.jsx` installs, **in development only**, a `PerformanceObserver` on 'measure' that clears
the buffer as entries arrive. Nothing in `src/` reads the timeline.

It is dev-only and app-wide. Any long dev session whose renders carry big props grows the same
way — this is almost certainly the unexplained `performance.measure` OOM seen during long scans.
What it does not remove is React still *building* each diff, which is real CPU.

## Long-scan memory

`postMessage` structured-clones, which is a synchronous deep copy on the main thread. Sending the
whole C-scan record list to the SAR worker cost **282 MB and 3.2 s** on a large grid, because
every cell carries every raw sweep and the worker reads none of them.

`SAR_INPUT_FIELDS` + `projectForSar()` trim the payload **in the hook, not at the call site**, so
a future caller cannot re-widen it — 5.5-17x less memory, 11-45x faster, with the full image and
every scalar bit-identical. A field that is not projected arrives as `undefined` rather than
raising, which is why the worker carries a matching comment.

`bscanData` itself still reaches 32-83 MB on a large grid. That is the data; it bounds how long a
scan can get in one tab.

## Verification, given there is no test runner

Pure `lib/` modules are driven head-first from node against the shipped file. UI is driven in
headless Chrome over CDP against the **dev server**, with two emulated displays where the feature
needs them. See `.claude/skills/` for both procedures — they encode traps that cost real time,
including the StrictMode popup failure that a dist build with one screen cannot find.

`vite build` is the gate and must pass before any change lands.
