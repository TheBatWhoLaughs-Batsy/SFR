---
name: verify-lib
description: Verify non-trivial logic in this repo head-first, by driving the shipped module from node or python against real or synthetic data. Use when a change touches a pure lib (lib/*.js, a worker, sfcw_engine helpers, roverTrack, bgContinuous, handheldTilt, cscanGrid, sarDetect), when asked to "verify", "check", "prove" or "test" a change, or before claiming a change is correct. There is no test runner in this repo, so this is what verification means here.
---

# verify-lib — head-first verification

There is no test runner. Verification here means writing a throwaway script that drives the
**shipped** module and asserts against values you can defend. This has been done a dozen times;
the traps below each cost real time at least once.

## The one rule

**Import the shipped file in place. Never copy it, never retype it.**

A copy is free to drift from the shipped code, so the check passes while the shipped path is
broken and nothing reports the divergence. This is why `rover/test/test_net.cpp` `#include`s
`rover.ino` directly, and why `projectRowsForDetect` was moved out of `useSarDetect.js` into
`lib/sarDetect.js` — so the benchmark splits a scan into rows with the app's own function.

If a module is not importable head-first, that is a reason to **move the pure part out of the
component**, not a reason to copy it.

## JavaScript

Vite resolves extensionless imports; node does not. Use the resolve hook the benchmark already
has rather than rewriting imports:

```bash
cd groundstation/frontend
node --import ./bench/register.mjs <script>.mjs
```

`bench/register.mjs` + `bench/resolve-ext.mjs` supply the `.js`. Read them before writing
anything new — if the script belongs with the detector, `npm run bench` may already cover it.

For a worker, shim the global and call its handler synchronously:

```js
globalThis.self = { onmessage: null, postMessage: (m) => out.push(m) };
await import('../src/lib/sar.worker.js');
globalThis.self.onmessage({ data: job });
```

`sar.worker.js` is a thin wrapper over `lib/sarReconstruct.js` — prefer the kernel directly.

**Worker `image` values are dB (negative), not linear amplitude.**

To drive React state machines without React, shim the four hooks the module uses (`useRef`,
`useState`, `useEffect`, `useCallback`), stub the timers, and run a fake clock. That is how the
rover raster state machine was exercised against a simulated ramped gantry.

## Python

Drive the engine directly with `sdr_server` stopped. For a function inside a large module,
extract it with `ast` rather than retyping — that is what proved the shipped
`_process_h_cal` and `_sfcw_result_msg` against the JS decoder.

`pi/rover/rover_sim.py` speaks the board protocol over the real socket, so the server and panel
are testable end to end with no rig.

## What to assert

Prefer a property with a defensible answer over a golden output:

- **A refactor is bit-identical.** Compare the full arrays and every scalar, not a spot check.
  That is how the CFAR lift, the `sarReconstruct` split and the binary wire format were landed.
- **A known geometry lands where it should.** Place a synthetic echo and check the peak bin.
  **Place it at `depth + range_offset`** — at the intended display depth it lands at negative
  distance, is dropped, and every later measurement is of sidelobes only, which still looks
  plausible.
- **A degenerate input is refused, not clamped.** Empty rows, one sample, a hole in a grid, a
  mismatched size, `n < 2`.
- **The failure mode you just fixed reproduces on the old code.** Extract the previous version
  with `git show HEAD:<path>` and drive both. A fix with no before-measurement is a guess.
- **Both directions of a snake**, wherever direction can bias a result.

## Finish

1. `cd groundstation/frontend && npm run build` — the gate, always.
2. `bash rover/test/build_check.sh` if firmware changed.
3. `python3 -m py_compile <file>` for Pi code, plus a real run where hardware allows.

## Report

State the number of checks and what they covered, and **say plainly what was not run** —
"not yet run on the rig" is a normal, expected line here and is more useful than silence. Put
the measurements in `docs/engineering-log.md` and the resulting behaviour in `memory/`.

Scripts go in the scratchpad, not the repo. Promote one to `bench/` only if it will be re-run.
