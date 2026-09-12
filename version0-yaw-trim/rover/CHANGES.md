# rover firmware 2.4.1 — `trim` command

Adds `{"c":"trim","yaw":N,"seq":..}` → `ack`: sets the yaw trim on its own,
~40 bytes instead of a full `cfg`, so the Pi's closed loop can adjust it a
few times a second while moving. `cfg` still carries `yaw` as well. Nothing
else changed from 2.4.0.

# rover firmware 2.4.0 — yaw trim (differential rear wheels)

Built on the firmware currently running on the rig (2.3.0 + your pin map,
V_DIR_INVERT false, per-wheel inverts Y/Z true, A false). Those settings are
untouched. Networking untouched.

## What it does
The three horizontal wheels no longer share one step pulse. The horizontal
axis still generates ONE base step rate -- that drives the front wheel (Y)
and the position count exactly as before. Each rear wheel now has its own
accumulator fed with the base rate scaled by (1 -/+ trim):

    yaw > 0  ->  left rear (A) faster, right rear (Z) slower  ->  nose turns RIGHT
    yaw < 0  ->  the opposite                                  ->  nose turns LEFT

Verified from the real ISR (rover/test not needed -- see numbers):
    trim   front Y   right Z   left A     Z/Y      A/Y
       0    20000     19999    19999   1.0000   1.0000
      +5    20000     18984    20996   0.9492   1.0498
     -5     20000     20996    18984   1.0498   0.9492
     +30    20000     13984    25996   0.6992   1.2998
     +45 -> clamped to +30
    reverse direction keeps the ratio; idle emits nothing; vertical unaffected.

If the nose turns the wrong way for the sign, set YAW_TRIM_INVERT true in
config.h. Range is +/-30 % (YAW_TRIM_MAX_PCT), clamped in firmware, Pi and panel.

## Where the value lives
The Pi owns it: `yaw_trim_pct` in DEFAULT_CONFIG / CONFIG_BOUNDS, saved in
rover_state.json, pushed to the board in every `cfg` as `yaw`. The board
applies it and echoes it in `hello` and `status` as `yaw`. A board power
cycle therefore comes back with the trim the Pi last had. The board itself
does not persist it.

## Protocol
`cfg` gains an optional integer `yaw`. Everything else identical. RX buffer
raised 256 -> 320 (config.h) and the Pi's BOARD_RX_LIMIT to match: a cfg at
the extreme of every bound plus yaw is 264 bytes; the everyday cfg is ~210.

## Files in this zip
    rover/                                       firmware 2.4.0 (flash this)
    pi/rover/rover_server.py                     replaces the one on the Pi
    groundstation/frontend/src/components/RoverPanel.jsx   replaces the panel

## How to tune
1. Flash 2.4.0, restart rover_server.py, reload the groundstation.
2. New "Steering Trim" section in the rover panel, under Jog.
3. Jog along the whiteboard at a steady distance. Watch the gap.
   Gap closes (drifting toward the wall)  -> steer AWAY from the wall.
   Gap opens  (drifting away)             -> steer TOWARD the wall.
   Which button that is depends on which side the wall is on; try one tap,
   watch, reverse if it got worse. +/-1 per tap, +/-5 with the double arrows.
4. When the gap holds over a full traverse, that is the value. It is saved.

## Physical note
The front wheel is driven at the base rate and cannot steer, so while the
rear pair turns the chassis it scrubs sideways a little. At the few percent
a drift correction needs that is negligible; at 30 % it is not, and 30 %
is a ceiling, not a working value.

## About the networking (what was actually wrong)
The random mid-scan disconnects were NEVER in the firmware. The Pi's
`_fanout()` -- the 20 Hz broadcast to groundstation browsers -- iterated the
live client set while browsers connected/disconnected, raised
`RuntimeError: Set changed size during iteration`, and because it runs
inside `board_handler` the exception killed the BOARD socket. It became
constant once the groundstation's reconnect dropped to 500 ms. The repo's
current rover_server.py fixes it (snapshot the set, send concurrently with
a timeout). That fix is preserved in the rover_server.py shipped here.

That also explains every 2.1.x/2.2.x log: "our side dropped it, WiFi fine,
back in 3 s" -- the Pi's TCP went away without a WebSocket close frame.
The firmware was reporting the truth; the cause was upstream.

NOTE: the repo's rover/rover.ino is a DIFFERENT lineage from what the rig
runs -- it has a rewritten "network recovery ladder" (ping, gateway check,
self-reboot, idle driver disable). This 2.4.0 is built on the 2.3.0 you are
actually running, not on that. Do not flash the repo's rover.ino over this
without deciding which networking you want; they are not the same code.
