# WebSockets — the three sockets and the wire format

**Purpose** — everything between the Pi and the browser.

| port | server | carries |
|---|---|---|
| 5000 | `groundstation/app.py` (Flask) | the built frontend and `/api/models` |
| 9001 | `pi/sensors/stream.py` | LiDAR + IMU at ~50 Hz — see `sensor-stream.md` |
| 9002 | `pi/rover/rover_server.py` | rover status at ~11-20 Hz, commands — see `rover-server.md` |
| 9003 | `pi/radar/sdr_server.py` | sweeps, RF Calib, status |

The rover controller dials **in** to 9002 on port 8765; the Pi is the server.

---

## Three rules that every fan-out here must follow

All three were violated, each with a different and confusing symptom.

### 1. Never feed an asyncio queue from a worker thread

`asyncio.Queue` is not thread-safe, and the part that bites is not corruption — **a put from a
foreign thread never wakes the loop.** The waiting `get()` future is completed only through the
loop's own `call_soon`, so the loop stays asleep in its selector and the consumer advances only
on its own `wait_for` timeout.

Measured with the engine at 15.6 Hz: 10.9 sweeps/s received, 30% lost, 42.7% of intervals an
exact 2x multiple. `_post()` uses `loop.call_soon_threadsafe`; the drop-oldest offer then runs
on the loop thread where the queue is safe. **Any future producer must use `_post`.**

It only became visible when the sweep got faster than the ~10 Hz poll. The bug was always there.

### 2. Never send sequentially, and never without a timeout

`websockets.send()` awaits until the frame reaches the transport, so a client that is not
draining — a wedged browser main thread, or a half-open TCP connection with no FIN or RST —
blocks the broadcast loop and **every other client goes dark with it**.

`_send_to_all(msg, timeout=0.5)` gathers over a snapshot, wraps each send in `wait_for`, and
drops the clients that time out. `RECONNECT_INTERVAL` in `useWebSocket.js` was dropped from
3000 to 500 ms as a direct consequence — the Pi now evicts a slow client, so it has to come
back quickly. **Those two numbers are coupled.**

### 3. Iterate a snapshot

A handler adding or discarding itself on the same loop makes every `await` inside a `for c in
self.clients` a yield point. In `rover_server` this raised `Set changed size during iteration`
out of the **board** handler, not a client handler, taking the controller link down — and the
firmware's own reconnect masked how bad it was. **A board reconnecting over and over is
evidence that something keeps dropping it; look at the Pi, not the network.**

Tightening the reconnect interval is what made a latent race constant. Expect that.

---

## The broadcast loop can die silently

A bare `while True` whose task nobody awaits dies permanently on any exception, with no output
— the same symptom as a stuck send, a different cause. Both broadcast tasks now carry an
`add_done_callback` that prints a traceback, and the message build and send are wrapped.

A `_heartbeat()` on a 30 s tick reports broadcast / callbacks / drops / clients / qsize.
`callbacks` is the load-bearing counter — it increments before any queue, client or send
exists, so it separates "the engine is not producing" from "the engine is fine and the send is
stuck".

**The heartbeat is silent when idle, deliberately.** A recurring benign line is what trains an
operator to ignore the one line a real failure prints. Silence means idle; any output means a
counter moved or a sweep is running. A running sweep always prints even with flat counters,
because "running but nothing moving" is the freeze the instrumentation exists to catch. Client
churn alone is never worth a line.

Residual gap: only the SFCW broadcast loop is self-healing. The rx/fft and status loops are
loud on death but not restarted.

---

## Binary sweep frames

**Location** — `pi/radar/sfcw_wire.py`, decoded by
`groundstation/frontend/src/lib/sfcwWire.js` through `useWebSocket`'s `decodeBinary`.

At 100 Hz every `sfcw_result` was ~2.9 KB of JSON, over half of it a range profile the
groundstation recomputes anyway. Binary is ~1.2 KB.

Format: magic `SFR1`, a uint32 header length, a compact JSON header holding every field of the
JSON message except the four array fields, padding to 8 bytes, then `2n` **float64**
little-endian — real parts then imaginary.

- **Opt-in per connection.** The groundstation sends `sfcw_binary` on every reconnect; a Pi
  that predates it ignores the command and the client decodes JSON anyway. Every other client —
  the benchmark, the capture tools, an older build — keeps getting byte-identical JSON. Only
  `sfcw_result` changes format.
- **Full precision on the wire, rounding in the decoder.** The Pi computes its profile from the
  *unrounded* sweep; rebuilt from the 8-decimal values, thousands of profile values come out
  0.01 dB off. So `_process_h_cal` returns an unrounded array that never enters JSON, and the
  decoder rounds to 8 decimals exactly as numpy does.
- **The profile is rebuilt lazily** as an enumerable, assignable getter, so spread, JSON and
  `structuredClone` still see it and a sweep nothing reads it from pays nothing.
- **The profile fields are still needed** even though no display draws the Pi's version: C-scan
  captures copy them into cell records and exports, the panel derives the depth-gate bound from
  them, and SAR detection refuses a scan without them.

The server builds each encoding only if some client needs it.

## Change history

The `put_nowait` bug, the untimed sequential send and the set-mutation race were all found
within days of each other in 2026-09-10, in two different servers, and are the reason the three
rules above are written as rules rather than as incidents.
