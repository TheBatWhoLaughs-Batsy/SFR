# MISTAKES

Reusable lessons from things that actually went wrong here. `SCOPE: global-rule` records are
injected every session and cost context forever — be sparing. Everything else is on demand.

Each record needs a concrete referent. "Be careful with X" is rejected by validation.
`STATUS: retired` retires a record with a reason; never delete one because the code changed.

---

## an RF gain change silently invalidates every stored background

TRIGGER: before changing tx1/rx1/tx2/rx2 gain, or after any RF cabling or mounting change
RULE: treat every background model, Super Fit grid and captured reference as void; recapture before trusting a subtraction
CONSEQUENCE: subtraction still reports "BG applied: YES" while cancelling against a background that no longer describes the scene, and the residual is read as a target
SCOPE: global-rule
EVIDENCE: changing only tx2/rx2 dropped suppression from 41.5 dB to 6.49 dB with per-step |h_cal| ratios spanning 0.007-1.840 — a frequency-dependent recalibration, not a scalar. Different AD9361 gain settings distribute gain differently across LNA/mixer/PGA, each with its own frequency response.
MATCH: tx1_gain|rx1_gain|tx2_gain|rx2_gain|lidar_antenna_offset

## changing a numeric default in the RF path without a per-step measurement

TRIGGER: before changing settle_count, num_buffers, dwell, FLUSH/ACCUM, or any other sweep-timing default
RULE: measure per-(sweep, step) robust-z over at least 1200 sweeps, bracketed by identical control blocks; an aggregate sweep-to-sweep correlation is not evidence
CONSEQUENCE: a one-step-in-40,000 corruption ships unnoticed, and because the range profile is a single IFFT across all steps, one bad step corrupts the whole sweep rather than one bin
SCOPE: global-rule
EVIDENCE: settle_count 10 to 7 and num_buffers 4 to 1 both shipped as "cleanup" with an unsubstantiated validation claim and no test artifact; each cost real signal quality for days. A single 400-sweep block of the identical configuration read 2/399 once and 0/1499 another time.
MATCH: settle_count|num_buffers|DSP_DEFAULT_|_DWELL

## verifying a module against a retyped or copied version of itself

TRIGGER: before writing any verification script for a shipped module
RULE: import the shipped file in place — add a resolve hook for the extension if the bundler supplies it — and never copy the module into a scratch directory first
CONSEQUENCE: the copy is free to drift from the shipped code, so the check passes while the shipped path is broken, and nothing ever reports the divergence
SCOPE: global-rule
EVIDENCE: the firmware network harness includes rover.ino directly for exactly this reason. Earlier checks that copied src/lib into a scratch directory were measuring the copy; bench/register.mjs with resolve-ext.mjs is the pattern that fixed it.

## an instrument fed a throttled, decimated or re-timed copy reports on the copy

TRIGGER: whenever measuring a rate, an age, or a position from data that passed through a throttle, a queue, an average, or another machine's clock
RULE: derive the measurement from the producer's own timestamp, above any throttling, and state which clock it is on
CONSEQUENCE: the readout tracks consumer load rather than the physical quantity, and the two can coincide closely enough to look correct
SCOPE: global-rule
EVIDENCE: four separate instances — a 20 Hz display throttle made a 36 Hz radar read 18 Hz, which collided with the rate of a genuinely-degraded FPGA image; staleness timed on the browser clock measured main-thread load, not sensor age; lidar_seq counted reads rather than measurements; rover positions keyed on arrival time rather than the board clock left holes in a raster.

## benchmarking this bench block-sequentially

TRIGGER: before any A/B measurement on the radio or the rig
RULE: interleave the configurations in short rotations, duplicate one configuration as its own control, and never difference adjacent samples across a rotation boundary
CONSEQUENCE: the bench's own episodes — the loopback throws them for tens of seconds — are scored as if they were the configuration under test, and adjacent-sample metrics computed across a boundary pair samples that were never adjacent
SCOPE: global-rule
EVIDENCE: control blocks of the identical configuration disagreed by 0.3 dB in one session, 1.8 dB in another, and 2.7 dB in a third. Differencing S_repeat across the concatenation of interleaved chunks read 36.4 dB against 41.4 dB on the same data.

---

## a peripheral can fail in one direction only

TRIGGER: a sensor that returns nothing, when wiring, voltage and driver have all checked out
RULE: prove the host's own receive path before suspecting the device — loopback the port and read the driver's own counters, not just whether bytes arrive
CONSEQUENCE: days spent on cables and connectors for a fault that is inside the host
SCOPE: project-incident
EVIDENCE: UART0's receive path was dead on this Pi's RP1 while its transmit counter climbed into the hundreds of thousands. A bit-banged GPIO test passed, a continuity meter passed, and a second UART loopbacked perfectly — only TIOCGICOUNT showed rx pinned at exactly 0.

## one sensor's failure taking down another's stream

TRIGGER: adding or editing a loop that reads more than one device
RULE: guard construction and every per-iteration read separately, publish nulls on failure, and disable a repeatedly-failing device rather than letting its timeout throttle the loop
CONSEQUENCE: a disconnected device presents as a different, healthy device being broken, and the whole stream process dies
SCOPE: project-incident
EVIDENCE: a dead IMU killed sensor_loop before the LiDAR was ever constructed, so it was reported as "the lidar isn't working". Later the same IMU dropping off the bus mid-run raised on every iteration, killed the process, and took port 9001 down with it.

## feeding an asyncio primitive from a worker thread

TRIGGER: any queue, event or future touched by a thread that is not the event loop's
RULE: hand it over with loop.call_soon_threadsafe; a bare put_nowait from a foreign thread never wakes the loop
CONSEQUENCE: the consumer advances only on its own timeout, so throughput silently collapses to the timeout rate and the surplus is discarded by a drop-oldest queue
SCOPE: project-incident
EVIDENCE: a 15.5 Hz sweep was delivered at 10.9 Hz with 30% lost and 42.7% of intervals an exact 2x multiple, because the broadcast loop was being advanced only by its own 0.1 s wait_for.
MATCH: put_nowait

## fanning out to websocket clients sequentially, or without a timeout

TRIGGER: writing or editing any broadcast over a set of clients
RULE: iterate a snapshot, gather concurrently, wrap each send in a timeout, and drop the clients that fail
CONSEQUENCE: one client that stops draining freezes every other client, and a set mutated during iteration raises out of whichever handler happened to be broadcasting
SCOPE: project-incident
EVIDENCE: an untimed sequential send left a healthy client at a 10,000 ms worst gap, against 503 ms once a 0.5 s timeout was added. The same pattern in the rover server raised "Set changed size during iteration" out of the board handler, taking the controller link down — and the firmware's own reconnect masked how bad it was.

## reading a self-normalised peakiness metric as a target detector

TRIGGER: deciding whether a target is present in a residual or a reconstruction
RULE: compare magnitude against a target-free reference at matched geometry; never use peak/rms or peak-over-median
CONSEQUENCE: the statistic moves the wrong way — a real target raises the floor it is normalised by — so a present target scores below a target-free scene and is reported as absent
SCOPE: project-incident
EVIDENCE: a target giving an unambiguous +4.4 dB magnitude change against a 0.23 dB control region scored residual peak/rms 1.52 with the target present against 1.75-1.91 with it absent.

## defining a type inside an Arduino .ino

TRIGGER: adding a struct, enum or default argument used by a function in rover.ino
RULE: put it in a header and include it
CONSEQUENCE: the IDE inserts generated prototypes above the definition and the sketch fails to compile — and a plain C++ type check of the .ino cannot catch it, because that skips the .ino preprocessing entirely
SCOPE: project-incident
EVIDENCE: PersistBlob and QueuedMove had to move to rover/types.h; build_check.sh now greps for the pattern because it cannot compile for it.

## taking a window or buffer size that does not divide the DMA quantum

TRIGGER: changing an RX buffer size, a correlation length, or any request served out of a driver's own buffers
RULE: keep the request a whole multiple of the underlying quantum, and keep the demod length an exact integer number of tone cycles
CONSEQUENCE: the leftover walks every call, so returned data lags its own arrival timestamp by up to a full period — which voids any gate that reasons from arrival time, while every timing diagnostic still reads perfect
SCOPE: project-incident
EVIDENCE: requesting 2000 samples against a 2048-sample DMA quantum gave perfect timing, locked at 100%, and never-negative margins while S_repeat collapsed to 16.5 dB with 42/499 sweeps visibly corrupted.
MATCH: RX_BUFFER_SAMPLES|DEMOD_SAMPLES|sync_config

## opening a window or taking a one-shot user gesture inside a React effect

TRIGGER: any effect that calls window.open, requests a device, or consumes user activation
RULE: hold the resource in module scope and reclaim it across a remount; test against the dev server, not only a production build
CONSEQUENCE: StrictMode's double-invoke spends the activation on the first call and the second is refused, so the feature is broken in development only — and the failure reports itself as a browser popup-blocker problem
SCOPE: project-incident
EVIDENCE: the projector window never opened under npm run dev while the production build worked; instrumentation showed window.open returning a window then null.

## quoting a benchmark score without the flags it was measured under

TRIGGER: before recording or comparing any `npm run bench` figure
RULE: record the exact invocation beside the number, and re-run with the same flags before calling a change a regression
CONSEQUENCE: the same code reads as a large regression against its own baseline, and the next session goes looking for a fault that is not there
SCOPE: project-incident
EVIDENCE: `npm run bench --set sfr-2026-09-20` reported 0.43 false alarms per scan against a recorded 0.25. Identical code; the difference was `--handle-ends`, which marks end-zone detections unresolved the way the panel does. All three extra alarms were at a scan edge.
MATCH: npm run bench

## trusting a documented claim about the local toolchain

TRIGGER: before skipping a check because project documentation says this machine cannot run it
RULE: probe for the tool, then correct the document in the same session
CONSEQUENCE: a suite that could have gated every change instead runs only on the one machine the note was written about, and the note keeps a second copy of the claim alive
SCOPE: project-incident
EVIDENCE: the engineering log recorded "no C++ toolchain on this machine", so `rover/test/build_check.sh` was treated as Pi-only. `g++` is present from msys64 and the suite runs here — 166 checks, 0 failures, in seconds.
