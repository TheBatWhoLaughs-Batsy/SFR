# DECISIONS

Choices that are settled, why, and what evidence would reverse them. Superseded entries are
marked, not removed.

---

## Background subtraction lives on the groundstation, never on the Pi

The Pi ships raw `h_cal` and holds no background state. Pi-side subtraction ran before
transmission, so it silently contaminated C-scan captures, SAR input and background-model
*training* data, all of which read the same fields. Keeping the wire raw means only the live
display is ever affected.

Reverses if: the wire ever becomes the bottleneck in a way subtraction would relieve — it
does not today, binary frames are ~1.2 KB.

## The groundstation panel is the source of truth for radar parameters

Parameters are pushed to the Pi and never read back. The Pi carries its own defaults purely
as a cold-start fallback. A fresh page load used to leave the Pi sweeping at its defaults
while the panel displayed and derived everything from different ones.

Consequence to keep in mind: a new parameter that is not in `sendSfcwParams()` never reaches
the Pi, and the panel will still confidently describe a sweep that is not the one running.

## Both complex and magnitude background subtraction exist, and neither is redundant

Complex is for *seeing* — it removes the wall return so a target 16.6 dB beneath it is not
buried. Magnitude is for *deciding* — it is the statistic that has actually detected a
target (+4.4 dB against a 0.23 dB control), and it tolerates ~1 mm of standoff error, which
the complex difference does not.

This was deleted once on the reasoning that complex was the only correct mode. Do not delete
either again.

## Akima interpolation over a learned model for the background

Leave-one-out on a 30-position bench set: Akima 20.2 dB, cubic spline 20.3 dB but -12.3 dB on
a bad knot, the previous 1-64-64-302 MLP 4.9 dB. Akima gives up 0.6 dB of mean for a 16 dB
better worst case, because it does not propagate a bad capture into neighbouring intervals.

Reverses if: captures ever become sparse relative to how fast the background varies. Density
is the dominant lever — roughly 12 dB lost per doubling of position gap.

## FPGA tuning mode stays HOST, not FPGA

`bladerf_set_tuning_mode(FPGA)` returns success on the bladeRF 2.0 micro and then silently
breaks the RX_X2 data path — the stream times out about 8 buffers in. Bisected on hardware.
libbladeRF's own default for this board is unconditionally HOST, and the errata check for FPGA
tuning is dead code that can never run.

It costs nothing: quick-tune works fine in host mode.

## The step-frequency table is one master union grid, not a per-sweep cache

Generated once per device connection over 2-5 GHz as the union of a 20 MHz and a 50 MHz
family, 181 profiles against a hard 256-profile hardware ceiling. Per-sweep caching required a
full device reset whenever start/stop/step changed, and that reset path was unreliable.

One sweep must stay inside one base family, because mixing visits frequencies that are on
neither. Adding a third family means re-checking the union against 256 first.

## The rover generates steps in an ISR, and the Pi dead-reckons nothing

The board reports its own step counter and the Pi converts to millimetres — one frame, no
offsets to keep in sync. The previous firmware ran steppers from `loop()` and refused to
service WiFi while moving, so the board was deaf for the duration of every move; everything
the Pi used to do was a workaround for that and is gone.

Quantisation is now bounded at half a step however many moves are made, provided the
commanded trajectory is kept unrounded in millimetres. Computing a relative move from the
current position instead reproduces the original compounding drift exactly.

## Rover soft limits are enforced on the board as well as the Pi

There are no endstops. The Pi can crash or lose its link; the board cannot. The Pi clamps
first so its own idea of the commanded position can never point outside the envelope, and the
board clamps as the backstop.

## Idle-disable on the stepper drivers defaults OFF

With no endstop and no encoder, an axis that creeps while de-energised is silently in the
wrong place and nothing can detect it. That risk is worse than the standstill whine, so it is
opt-in from the panel.

## Heading-hold steering cannot recover the line, by design

Heading is unobservable in position, so a disturbance that shoves the rover sideways leaves it
running perfectly parallel along a new, permanently offset line. That is inherent, not a bug —
it is the whole reason the LiDAR-cascaded `track` mode exists. Do not "fix" heading mode.

## Firmware recovery escalates from a gateway ping, not from the modem's own status

`WiFi.status()` and `localIP()` are the modem's opinion of itself, and the modem latches — it
can report connected with a stale address indefinitely after an AP disappears. Pinging the
gateway is the only question in that file whose answer does not come from the modem, and it
separates "the radio is lying, tear it down" from "the radio is fine, the Pi is simply not
running" — which is an everyday state that must never trigger a reset.

Compiling the ping out falls back to `false`, never to the modem's opinion; answering
"should I believe the modem?" with the modem would reinstate the deadlock.

## SAR reconstructs through a layered air/wall/air model

A straight-ray model treating everything below the face as one dielectric is fine broadside
and badly wrong at the wide angles that carry the cross-range resolution — 106 degrees of
two-way phase error at 20 cm of lateral offset. A thin air gap is not a small angular
perturbation: Snell turns a 27-degree ray inside the wall into a 76-degree ray in the gap.

Solved by a ray-invariant table per (position, depth) row rather than per-pixel root-finding,
which is the same answer at a small fraction of the cost.

## Back-projection integrates a bounded aperture angle

Limited to 45 degrees half-angle. Summing every position into every pixel integrated a 17 cm
pixel over 64 degrees, where the antenna barely illuminates and the refracted ray is near
grazing — little signal, full clutter. Position error halved on both labelled corpora.

45 is also roughly where the beam physically is, so it was chosen over the
false-alarm-optimal value.

## Clutter removal stays rank-1 SVD, with the physical fit as a cross-check

Rank 2 recovers the far pipes on the newer corpus and triples false alarms on the older one;
rank 3 collapses both. Promoting the physical along-track fit to primary gives the same recall
with more false alarms. Neither is shippable on the evidence of one geometry.

Reverses if: a third labelled corpus shows an adaptive rank that survives all of them. The
right fix is a clutter model that chooses its own rank, not a different constant.

## Detection thresholds are re-measured per corpus, never tuned on one

Every threshold was originally fitted at `rx1_gain = 25`, which was compressed. Gates stated
in dB over a clutter median cannot survive a 10 dB change in the clutter. `npm run bench`
exists so a threshold change is scored against every labelled set at once.

## The Pi hosts the groundstation

Serving the built frontend costs nothing measurable — 135 Hz sweep held while the app was
served continuously, and one cold page load is 36 ms of CPU. The heavy compute runs in
whichever client browser opens the page, never on the Pi. This also makes
`groundstation/models/` a shared model store instead of living only on the machine that
captured it.

## The Pi is its own access point

A USB dongle hosts SSID `sfr-pi` with the Pi fixed at 10.42.0.1, while the built-in radio
stays an ordinary client for whatever upstream exists. One NetworkManager profile does the
SSID, DHCP and NAT, so there is no hostapd or dnsmasq config to maintain. Field and lab
behave identically and the rover's `PI_HOST` never goes stale again.

The profile is bound to the dongle's MAC rather than to `wlan1`, so a boot-order rename can
never start the AP on the internal radio.

## Project knowledge is split three ways, and the archive is kept

Resident (`CLAUDE.md`, ~100 lines, loaded every session), on demand (`memory/`, one file per
subsystem), and archive (`docs/engineering-log.md`, never loaded). The single file this
replaced was 566 KB and cost roughly 150k tokens at every session start.

The archive is kept rather than distilled and deleted, because the measurements in it —
gain ladders, permittivity tables, falsified hypotheses, the reasoning behind each
threshold — cannot be recovered by re-reading the code, and re-measuring them means bench
time. It is append-only and contains superseded claims, so `memory/` is the authority for
current behaviour and the archive is a reference to grep.

Reverses if: the archive starts being cited as current truth. The fix then is to mark the
superseded sections, not to delete them.

## `.harness/` is committed, not gitignored

The convention is to keep it personal, on the grounds that it is one developer's working
memory. This repo is worked by several people on two machines, so the state, the decisions
and the lessons are shared artefacts — a lesson that only one person's sessions can see has
to be learned again by everyone else.

REVERSED BY: the files becoming per-person scratch rather than shared fact.

## Scan sets stay out of git

~8.7 MB per scan, ~70 MB for one set, and the repo already carries ~49 MB of FPGA images.
`bench/corpus.json` names a directory per set instead.

The cost is that only the machine holding the scans can score a detector change, which is
why putting them on the Pi beside `groundstation/models/` is an open task rather than an
optional nicety.

REVERSED BY: git-lfs being set up for this repo, which would make committing them cheap.
