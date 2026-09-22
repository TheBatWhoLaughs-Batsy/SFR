# Rover server — port 9002

**Purpose** — the Pi half of the gantry. Converts millimetres to the board's frame, flow-controls
its queue, times its position stream, and closes the steering loop.

**Location** — `pi/rover/rover_server.py`, `pi/rover/yaw_control.py`, simulator
`pi/rover/rover_sim.py`. The board dials in on 8765; groundstation clients connect on 9002.

---

## Position is measured, not dead reckoned

The board reports its own step counter and the Pi converts to millimetres. One frame end to end
— steps, positive is up and right, origin where the operator last declared it — so there are no
offsets to keep in sync. Direction sense lives in the **firmware**, not here.

Remaining error sources, all honest:

- **Quantisation**, bounded at ≤ half a step (65 µm on X, 2.5 µm on Y) *however many moves have
  been made*.
- **Calibration**, the dominant X term. X rolls on wheels so its steps/mm is empirical;
  `rover_calibrate` takes a commanded and a measured distance and scales, refusing corrections
  beyond 0.5x-2x as a mis-entry. Y is a leadscrew at exactly 200 steps/mm.
- **Slip and missed steps**, unobservable. Reported as `travel_mm`, the odometer since the last
  declared position — that is the exposure.

### `ideal_mm` is what makes quantisation bounded, and it is subtle

It is the commanded trajectory in millimetres, kept **unrounded**; every step target is
`round(ideal * steps_per_mm)`. Computing a relative move as `current_mm + delta` does not work
and reproduces the original bug exactly: the current position is a whole number of steps, so the
rounding falls the same way every time and compounds. Measured that way, 40 × 1 mm came out
+3.67%.

It is resynced only on explicit events — a `done` whose reason is not `completed`, an E-stop, a
jog ending, `set_position`.

**Do not resync it by comparing ideal against actual position.** The board acknowledges a move
*before* dispatching it from its queue, so every move passes through a window reporting "new
sequence, idle, old position" — indistinguishable from a move cut short. An attempt to do this
destroyed the ideal on every move and brought the drift straight back.

**Clamp on the Pi, before updating the ideal.** The board also clamps, inside `moveTo()`, and
then reports `completed` — so nothing told the Pi the target had been unreachable and the ideal
stayed outside the envelope. Symptom: from 792 with a limit at 850, a +100 nudge correctly
stopped at 850 and the following -100 went to 792 instead of 750.

### The 3.67% bug was invisible in testing

The old firmware rounded per relative move and discarded the remainder. At 1 mm that is 8 steps
= 1.0367 mm; at 500 mm it is 0.008%. The rig had been jogged at a 500 mm step, so it was
correctly reported as "barely any drift" **while being 3.67% wrong at the step size a raster
actually uses.**

---

## Flow control and arrival

Moves are held in the Pi's own `_outbox` and released only while the board has room, refusing
loudly past `OUTBOX_MAX`. Before that, 400 rapid 1 mm moves tracked 34 mm short.

`_link_configured` guards the cfg-hello loop structurally, so no firmware can induce it.

**Arrival is reported exactly, by token.** `rover_move_abs` accepts an opaque `token`, carried
through the outbox, mapped onto the board sequence the move is actually sent with, and echoed as
`last_done_token` when *that* move's `done` arrives. Waiting for your own token back is immune
to every other mover on the link and needs no timer.

Why a counter is not enough: `moves_done` advancing does not mean *our* move finished. A `done`
for an operator nudge still in flight makes the snapshot stale by one, and arrival then collapses
onto position alone — the exact ack-before-dispatch window the counter exists to close. It also
lets a latched `last_done_reason` from a previous session abort a scan on its first move.

Fallbacks, in order: token, then `moves_done` plus a `MOVE_ACK_FLOOR_MS = 300` floor that no
genuine completion can beat, then a plain timer.

`dict.setdefault` evaluates its default eagerly, so `cmd.setdefault('seq', self.next_seq())`
burned a sequence number on every jog heartbeat.

## The board clock

Status carries `board_ms`, the step ISR's tick clock, alongside `last_status_at`.

**`last_status_at` is when the Pi *received* a frame, not when it was measured**, and the R4's
WiFi delivers frames late and in bursts. Keying positions on it bends the position-versus-time
curve: a ~1.3 s stall piled 43 sweeps into one cell and left 30 empty columns after it.

`createBoardClock()` on the groundstation fits receipt time against board time over a 30 s
window. A frame's `recv - board` is the offset **plus** its delay, and delay is never negative,
so the mapping is the **lower boundary** of those points — the lower convex hull, not their
mean. A late frame lies above the hull and changes nothing, which is why stalls cannot move it.

Residual is one minimum link delay, a constant, absorbed by the latency parameter.

## Config serialisation

`cfg` serialised to 258 bytes against a 320-byte buffer only after a fix. `x_steps_per_mm` is
`1600/(π·66)`, so every derived speed serialised at full 17-digit double precision. **The
overflow is data-dependent**, which is why it appeared only once X had been calibrated to an
awkward number.

Two fixes, both needed: 3-decimal rounding on the six float fields (~0.0004 mm/s, orders below
what the mechanism can express) and compact JSON separators. Verified against the firmware's own
parser compiled natively — it terminates a bare value on `,`/`}`/`]`/whitespace, so spaced and
compact parse identically.

An oversized command is logged **by name** rather than leaving a bare `too_long` in the board log
to be correlated by hand. It still sends: the board's refusal is the authority.

## Steering (`yaw_control.py`)

Pure, and exercised head-first with 38 checks plus a closed-loop simulation.

The outer loop is **P-only on purpose**: heading to lateral position is an integrator, so P
already drives standoff error to zero at equilibrium, and a second integrator would only fight
the inner loop's bias for authority over the same steady state.

`dir` appears **twice** in the control law for different reasons — the inner loop because the
same alpha yaws the chassis the opposite way in reverse, the outer because a given heading moves
the rover sideways the opposite way in reverse.

Degradation is deliberate: a stale IMU holds alpha and steers nothing; a stale or implausible
LiDAR drops `track` to `heading` behaviour rather than steering on a bad range. LiDAR samples
are deduped by `lidar_seq` (which counts measurements, not polls), gated to 40-2000 mm,
EMA-filtered, and a single >120 mm jump is rejected unless three arrive in a row.

**Heading hold cannot recover the line and that is inherent** — see `.harness/DECISIONS.md`.

## Testing

`pi/rover/rover_sim.py` speaks the board protocol over the real socket. Every flow-control and
arrival bug above was found by it. It models a *perfect* machine, so it validates protocol and
control flow and never mechanical accuracy.

Two traps when running it on the Windows groundstation PC:

1. **VS Code's port forwarding listens on `127.0.0.1:9002` and `:8765`** and wins over a local
   server bound to `0.0.0.0` — so `localhost` may reach the *real* rover through a tunnel. Use
   `127.0.0.2` for both.
2. **The simulator runs ~19x slow on Windows**: it advances a fixed 1 ms per loop but
   `asyncio.sleep(0.001)` takes ~15 ms. Drive its tick from measured wall time instead.
