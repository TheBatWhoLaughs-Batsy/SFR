# Projection — putting the result back on the wall

**Purpose** — project the plan view, or the detected pipes, onto the real wall at true scale, so
the operator marks the wall without reading a screen.

**Location** — `components/ProjectorWindow.jsx`, `lib/detectionOverlay.js`,
`lib/cscanGrid.js` (`cscanLayout`, `layoutCellRect`, `layoutCellAt`, `canvasOffsetIn`),
`components/ProjectionControls.jsx`, plus the Projector Demo panel
(`ProjectorDemoPanel.jsx`, `lib/projectorDemo.js`, `lib/radarLook.js`,
`hooks/useRoverPaint.js`, `hooks/useHandheldPaint.js`).

---

## There is no API for "send this view to a display"

Screen sharing is **capture**; this is **output**. `getDisplayMedia` is the wrong direction and
cannot help. The closest primitive is the **Window Management API**
(`window.getScreenDetails()`, Chrome, behind a permission prompt that requires a user gesture):
it enumerates the displays, and a window can then be opened on one and full-screened there.

`listDisplays()` is called from the click handler because of that gesture requirement.

**Where the API is unavailable — Firefox, Safari, Chrome with the permission denied — there is
no way to learn a second display exists at all.** That is not an error path to fix. A normal
popup opens on the current screen and the panel says to drag it across and press F11.

## The content is a React PORTAL, not a second app

The projector reads the same props as the panel — same grid, same colour limits, same placement —
so there is no message channel, no serialisation, and no way for the wall to disagree with the
monitor. The popup document gets a **clone** of the app's style nodes, cloned rather than
re-linked because in dev Vite injects styles with no URL to point at.

Three things are easy to get wrong and are handled:

- **`devicePixelRatio` must come from the CANVAS's window**, not the global. The projector can be
  on a display with a different ratio.
- **So must `requestAnimationFrame`.** A browser throttles rAF on a page it considers hidden, so
  driving the projected image from the control window would freeze the wall the moment the
  operator switched tabs — which they will do mid-session. The loop also bails if its window has
  closed.
- **The offsets measure from the PROJECTOR's own corner there.** Same numbers, same meaning,
  different surface.

State lives in `App.jsx`, not in `Viewport`, so switching panels does not tear down a window that
is currently lighting a wall. `ProjectorWindow` takes a `name`, and keeps its reclaim record per
name, so the C-scan projector and the demo projector can be open at once.

## To-scale placement is the point

Fitted, centred layout re-derives itself from the box it is in, so opening a row pane or resizing
the window silently moves everything — which is exactly what makes an aligned projection drift.
To scale, the grid is drawn at exactly `pxPerCm` with its top-left corner at exactly
`(leftPx, topPx)`.

**Those offsets are measured from the top-left of the VIEWPORT — the whole area right of the
sidebar — not of the canvas**, and that distinction is the entire reason they hold still.
`cscanLayout` subtracts the canvas's own position inside the viewport, so when a pane appears the
canvas moves under the grid and the grid does not move on the wall. Verified across a canvas
offset of 30 px and one of 230 px.

**A grid that falls outside is CLIPPED, not re-fitted**, and says so. Re-fitting would be the
silent re-scaling this mode exists to avoid. To scale, the clip box is the whole canvas — axis
margins would forbid placements the operator asked for.

**Relative controls must use the updater form.** A burst of nudge clicks before React re-renders
otherwise all read the same stale value: measured, four +10 px presses moved the grid 10 px.

## The projected image is chromeless

Cells, the frame, and the next-cell marker. Axes, titles, the colour bar, the capture path and
the hover readout are instruments for reading a plan view on a monitor — projected they would be
light falling on brick beside the measurement, and their positions are meaningless once the grid
is placed by hand.

## StrictMode kills popups, and only on the dev server

`main.jsx` wraps the app in `StrictMode`, so in development React mounts every effect, tears it
down and mounts it again. Naively that is open → close → open, and **the second open is refused**
— the click's user activation was spent on the first. So the projector never opened under
`npm run dev` while the production build worked, and the panel blamed the browser's popup
blocker.

**Anything that opens a window, requests a device, or consumes a one-shot user gesture in an
effect has this hazard. Test it against the DEV server, not just `vite build`.**

Fixed by never closing across a remount: the window is held in a **module-scope** record (so it
outlives both the remount and an HMR module reload), the effect *reclaims* it, and the close is
deferred by a tick so a remount cancels it.

Two hardenings went in with it, both cases where a throw left an empty black window with no way
to close it: the portal container is set **before** the fullscreen request (a bad screen member
is a synchronous TypeError, which aborted the effect with no cleanup registered), and fullscreen
falls back to plain fullscreen on any failure. A window opened by **name** can be one that
already exists after an HMR reload, so the document is furnished only if it has no root yet.

## Detection overlay

`cscanProjection.source` switches **Grid | SAR detections**, driving both the monitor plan view
and the projector, so the to-scale calibration is shared — the rig is calibrated once.

SAR detections draws captured cells flat dark grey, uncaptured cells as the grid view does, and
each **confirmed** pipe as a white band. Probable pipes are an opt-in amber toggle, drawn
**first** so a confirmed band is never painted over.

`confirmedPipeOverlay()` / `pipeOverlay()` in `lib/detectionOverlay.js` is the whole mapping:

- rating comes from the same `effectiveRating` the panel shows, so an end-zone target is hidden
  while Handle ends is on;
- **no prediction** — a band is drawn only for rows the detection used, and only where the cell
  under the line was captured;
- **half-cell offset** — a detection's x is an antenna position, the *centre* of a cell, so the
  draw adds half a cell;
- a drift under the lateral resolution is drawn **vertical**;
- a result whose pitch differs from the grid's is not drawn.

**It updates per ROW, not per cell** — detection is whole-scan and debounced, so it runs at row
changes and at the end. The scanned-cell fill still grows live, and the title shows `rows k/N` so
a stale result is visible. Early rows rate weakly, so pipes can appear and vanish as rows are
added.

**Without an empty reference the panel warns in amber**: on this bench a real wall crevice rates
confirmed on its own, and projected that is a confident false pipe.

## Projector Demo panel

Three modes — **Draw**, **Rover**, **Handheld** — sharing one projection calibration, seeded from
the C-scan's the first time.

Draw paints PIPE and SEEPAGE strokes and renders them through `lib/radarLook.js` as an
SFCW-scan-like image (seeded Perlin background, Gaussian pipe cross-sections, blurred
noise-modulated seepage, screen-blended). Export v2 writes **every cell's rendered colour** —
what Rover and Handheld show, unchanged by any later renderer change — plus the layers, so Draw
re-imports exactly.

Rover mode drives the grid and lights each cell as the rover reaches it; the projector shows only
the covered cells. Coverage comes from the **reported** position, and every cell on the line from
the previous one is marked too, because status arrives at ~11 Hz and a fast rover can cross a
whole cell between frames. Safety is the C-scan raster's, **shared rather than copied** —
`useRoverScan.js` exports `moveCompletion()`, `clampTarget()` and the timing constants.

Handheld mode is the same idea from the handheld position, with a brush radius, and a gap fill
limited to 2 cells: a longer jump is more likely a beam sliding off a surface edge or a
reposition, and bridging it would light cells the module never passed.
