# Rover firmware — Arduino UNO R4 WiFi

**Purpose** — drive the two-axis stepper gantry, and the wheeled chassis that carries it.

**Location** — `rover/` (`rover.ino`, `motion_core.h`, `protocol_core.h`, `types.h`,
`config.h`, `secrets.h`), tests in `rover/test/`.

Two axes only: **X = left/right, Y = up/down**. There is no standoff axis.

---

## Steps come from an ISR, and the board is never deaf

Step generation is a 20 kHz `FspTimer` ISR; the main loop only talks. The first firmware ran
steppers from `loop()` and refused to service WiFi while moving, so **the board was deaf for
the duration of every move** — it could not be stopped, could not be queried, and silently
discarded anything arriving mid-move. Everything the Pi used to do to work around that is gone
and must not come back.

`motion_core.h` replaces AccelStepper: that library is built around "move to a target", and a
jog with no target that must decelerate onto a soft limit means writing the ramp anyway.

## There are no endstops

Soft limits are the only thing between a jog and the end of the rail, so they are enforced
**on the board as well as on the Pi** — the Pi can crash, the board cannot. A jog caps its
speed at `sqrt(2*a*room)` and coasts onto the limit.

**Stopping distance is `v²/2a`, and it bit the original tuning.** Both axes shared one speed in
steps/s, which was 10 mm/s vertically but 259 mm/s horizontally — a 129.6 mm stopping distance
on a rig whose scans span ~100 mm. Speeds and accelerations are per-axis in mm and runtime
configurable.

| | steps/mm | max | jog | accel | soft limits |
|---|---|---|---|---|---|
| Y vertical, leadscrew | 200.0 exact | 25 mm/s | 15 mm/s | 100 mm/s² | 150-850 mm |
| X horizontal, 66 mm wheels | 7.7166 | 150 mm/s | 60 mm/s | 500 mm/s² | 0-3900 mm |

E-stop is software, latched, and works during motion. Clearing it marks the position invalid,
because cutting the step train at speed is exactly where a stepper loses steps.

A **jog dead-man** lives on the board: the panel refreshes every 150 ms and the board
decelerates after 500 ms of silence, so a dropped link cannot leave the rover driving.

**Idle-disable defaults OFF** (`idle_disable_s = 0`). With no endstop and no encoder, an axis
that creeps while de-energised is silently in the wrong place and nothing can detect it.
`wakeDrivers()` re-energises and waits before any move.

Standstill whine is the drivers chopping to hold position, not the firmware — the ISR touches
no pin while idle. Lower the driver Vref, enable idle-disable, or fit TMC2208/2209.

---

## Steering: the chassis has no steering

One driven front wheel and two driven rear wheels on separate axles. **Nothing steers.** The
chassis yaws when the rear pair run at different rates, and that is the only steering authority
there is. Yaw trim is applied in the ISR.

Three modes, each strictly more capable — `manual`, `heading` (hold the BNO085 heading, fixes
travelling slanted), `track` (cascade the LiDAR standoff into the heading reference, also fixes
being on the wrong line). Mode is a **command, never persisted**, because the references do not
survive a restart either; the gains are config and are persisted.

`+alpha` turns the nose RIGHT, and `bno085.yaw_deg` is CCW-positive, so `+alpha` must *decrease*
`yaw_deg`. A wrong sign is loud, not subtle — in simulation the wrong invert diverges to
+185 deg in 20 s where open loop reaches +12. **Still verify both signs on the rig**; the
simulation validates the arithmetic, not the wiring.

---

## The network recovery ladder

Replaces the earlier `ensureNetwork()` / `ensureSocket()` pair, which deadlocked: the socket
layer deferred unconditionally to `linkReady()`, and `WiFi.status()` / `localIP()` are the
**modem's opinion of itself**, which latches. After an AP disappears without a clean deauth,
`status()` can sit at connected with a stale address indefinitely — so the one piece of hard
evidence available, a socket that will not come back, was never allowed to act on the layer
below it.

| down for | action |
|---|---|
| 0-10 s | nothing; the library's own reconnect gets its chance |
| 10 s | restart the websocket client |
| ~30 s | **ask the gateway** |
| 5 min | `NVIC_SystemReset()` — refused unless the rig is parked |

**The gateway ping is the load-bearing idea.** It is the only question in that file whose answer
does not come from the modem. It separates "the radio is lying, tear it down" from "the radio is
fine, the Pi is simply not running" — and a Pi that is off is an everyday state, so escalating
on it would reboot the board every 5 minutes during ordinary development.

`NET_USE_PING 0` compiles it out, and the fallback returns **false**, never `linkReady()` —
answering "should I believe the modem?" with the modem's own opinion would reinstate the
deadlock.

Note: on the `sfr-pi` network the gateway *is* the Pi. "Gateway answers" then means the Pi host
is up, not that a router is — which still separates the two cases the ladder needs.

Other details that were each a hole:

- **`WiFi.end()`, not just `disconnect()`.** `disconnect()` drops the association; `end()` stops
  the stack in the modem, releasing the sockets it is holding. The first re-association attempt
  is a plain re-associate; every attempt after it is a full teardown.
- **`send()` uses `sendTXT()`'s return value.** A half-open TCP connection keeps the library
  reporting connected for ~36 s. A failed write is the earliest unambiguous evidence there is.
- **The reset check sits BEFORE the escalation branches.** Each branch returns or reschedules,
  so a check placed at the end is never reached by a modem that keeps associating happily onto a
  dead network. Caught by the harness, not by reading.
- **The reset is refused unless the rig is parked**, and persists first — clearing the EEPROM
  magic when the position is invalid, or coming back from a reset would silently re-declare a
  position an E-stop had invalidated. Both branches skip the write when the bytes already match,
  or a board that can never reach the network erases flash every five minutes.
- **The MAC is printed on failure too.** A DHCP reservation is keyed on it, so it is wanted
  exactly when the board is *not* getting on the network.
- **A scan every 4th failed association** — the measurement that separates "the AP is refusing
  this board" from "the AP is not there". Without it, both looked identical in the log, which is
  how this was once diagnosed as "restart the router".

---

## Protocol

Line JSON, flat objects, sequence-numbered.

Pi to board: `move` (absolute or relative, per axis), `jog`, `jog_hold`, `stop`, `estop`,
`clear_estop`, `set_pos`, `cfg`, `enable`, `ping`.
Board to Pi: `hello` (on connect only), `status` (20 Hz), `ack`, `done`, `err`.

A repeated `seq` is re-acknowledged rather than re-executed, so retransmission is safe.
`jog_hold` is exempt and must not advance `lastSeq`.

**`cfg` must never be answered with `hello`.** The Pi pushes its configuration in response to a
hello, so replying to `cfg` with one is an unbounded loop — it saturated the link at 60,727
config pushes in one test, and each hello resynced the Pi's ideal position, silently
reinstating quantisation drift. `cfg` and `clear_estop` reply with `status`.

**The move queue is 4 deep and REJECTS what does not fit**, which is the worst failure
available here: the Pi's ideal position has already advanced past a move that never happened.
The Pi holds moves in its own outbox and releases them only while the board has room.

**`RX_BUFFER_SIZE` and the Pi's `BOARD_RX_LIMIT` must agree** (both 320). `cfg` is what carries
the soft limits, and over the limit the board rejects it silently apart from one line in its
log.

**`stop_reason` is per axis and `moveTo` does not clear it**, so an axis left out of a move
carried whatever ended its previous one. `dispatchQueued` clears it on the axes it commands and
records them, and the done block reads only those. Dormant for a raster, live for nudges, and
one stale byte is a lost scan.

WiFi credentials live in `rover/secrets.h` with `secrets.example.h` committed.
**`secrets.h` is currently tracked in git with a live PSK** — see `.harness/STATE.md`.

---

## The `.ino` preprocessor: define no types in `rover.ino`

The IDE auto-generates a prototype for every function in a `.ino` and inserts them near the
**top** of the file, above anything defined further down. A function taking a type defined in
the same `.ino` therefore fails to compile. `PersistBlob` and `QueuedMove` live in
`rover/types.h` for this reason. The same applies to default arguments on sketch-level
functions.

**`build_check.sh` cannot catch this by compiling** — compiling the `.ino` as plain C++ skips
the `.ino` preprocessing entirely, which is exactly why it got through a type check and only
failed in the IDE. It greps for the pattern instead.

The sketch must be `rover/rover.ino`, matching its folder, or the IDE offers to relocate it and
leave the headers behind.

## Testing, with no Arduino toolchain on the dev machine

There is no *Arduino* toolchain here, but there is a C++ one — `g++` from msys64 — so
`build_check.sh` runs on the groundstation PC as well as on the Pi. Last run 2026-09-21:
166 checks, 0 failures, type check clean with and without `NET_USE_PING`.

- **`motion_core.h` and `protocol_core.h` contain no Arduino headers** and are compiled natively
  by `rover/test/test_core.cpp` — 125 checks: the ramp landing on the exact step, limits,
  watchdog, E-stop, JSON scan and emit. **Keep new logic there, not in `rover.ino`.**
- **`rover/test/test_net.cpp` `#include`s `rover.ino`** so it drives the shipped
  `serviceNetwork()` and its shipped statics. A retyped copy would be free to drift, which for
  this file is the whole point. 41 checks. Two things in its model are load-bearing and must not
  be "simplified": the WiFi model's `latched` flag survives `disconnect()` and is cleared only
  by `end()` (that single behaviour *is* the bug, and a model without it passes the old
  firmware); and the websocket model connects from `loop()`, not from `begin()`, matching the
  real client.
- **`rover/test/build_check.sh`** runs both and then type-checks `rover.ino` as plain C++
  against stubs. A pass means "will probably compile" — it cannot verify the real libraries'
  signatures or anything about hardware. `netstubs/` must come **first** on the include path.
- **`pi/rover/rover_sim.py`** speaks the board protocol over the real socket, so the server and
  panel are testable end to end with no rig. It is a kinematic model of a *perfect* machine —
  no step timing, no missed steps, no slip.

## Change history

Firmware 2.5.0 = the network recovery ladder + yaw trim + the 2026-09-12 wiring. **There are
two divergent `rover.ino` lineages**; a sibling branch carries the same yaw trim on a base with
no ladder. Do not resolve that by blind checkout in either direction.

Current state: `build_check.sh` passes, and the board has **not** been flashed with
the `sfr-pi` credentials. On the bench, in order: `build_check.sh`, nudge each axis 1 mm to
confirm the pin map and all four direction flags against the rig, then the two steering signs.
Direction flags must be confirmed by watching, not by reasoning — both were inferred once from
the old firmware's behaviour and only one survived contact with the rig.
