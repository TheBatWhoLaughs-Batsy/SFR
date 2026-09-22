---
name: ui-drive
description: Drive the groundstation UI in headless Chrome over the DevTools Protocol to verify a panel, an import, a canvas or a projector window. Use when a change touches a React panel, a canvas, a file import, a second window, or anything that cannot be checked head-first from node. Encodes the dev-server-versus-build trap and the file-input and canvas readback mechanics.
---

# ui-drive — driving the app in headless Chrome

For anything that only exists in a browser. Head-first node checks cover the pure libs; this
covers the rest.

## Run it against the DEV SERVER

```bash
cd groundstation/frontend && npm run dev
```

**A production build finds a whole class of bug that the dev server does.** `main.jsx` wraps the
app in `StrictMode`, so in development React mounts every effect, tears it down and mounts it
again. Anything opening a window, requesting a device, or consuming a one-shot user gesture in
an effect fails there and works in `dist` — the projector window never opened under `npm run dev`
for exactly this reason, and reported itself as a browser popup-blocker problem.

Test the dev server. Test `dist` too when the change touches the build.

## Multiple displays

The Window Management API needs real screens. Launch Chrome with:

```
--screen-info={0,0 1600x900}{1600,0 1280x720}
```

and grant the permission over CDP with `Browser.grantPermissions(['windowManagement'])`. **One
screen plus a dist build finds none of the projector bugs.**

WebGL (the 3D wall twin) needs `--use-angle=swiftshader --enable-unsafe-swiftshader`.

## Importing a scan through the panel

A script `.click()` has **no user activation**, so Chrome opens no file chooser. The app creates
its file input on the fly, so park that input in the DOM and set the file on that node:

```js
// evaluate: create/park the input, then
await cdp.send('DOM.setFileInputFiles', { files: [abs], backendNodeId });
```

This is how a real 147-position export was imported and its projected canvas read back.

## Reading a canvas back

- **2D canvas** — `getImageData` and count pixels of the colour you expect. Counting coloured
  pixels proves the grid was *painted*; asserting a canvas exists proves nothing.
- **WebGL** — `getImageData` does not work. Take a screenshot and hash it; a real CDP mouse drag
  or wheel must change the hash.
- To check a projected placement, read exact pixel positions. At 8 px/cm with an offset of
  (60, 80) a feature at x cm must land at `60 + (x + pitch/2) * 8` — that arithmetic is what
  caught a stale-closure nudge bug reading +10 where +40 was asked for.

`innerText` returns headings CSS-uppercased.

## What to check

Whatever the change was, plus: **no console errors**, and that toggling the feature off restores
the previous state. A feature that works and leaves the app broken behind it is not done.

For anything timed, measure what is on screen — the "Detecting…" duration, the header rate —
rather than an internal counter.

## Traps

- **Nothing behind the live-display throttle is safe to measure timing from.** A fixed 50 ms gate
  against a 27.9 ms sweep passes every other sweep, so a rate derived from throttled state reads
  exactly half.
- **A window opened by NAME can be one that already exists** after an HMR reload.
- Two emulated displays plus a real dev server is the configuration that finds these. Say so in
  the report if you did not use it.

Scripts go in the scratchpad. Report the check count and what was *not* covered.
