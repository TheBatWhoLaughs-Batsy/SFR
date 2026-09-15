#!/usr/bin/env python3
"""Switch the SFCW engine between sweep cores, with the required restart.

    python3 radar/set_sweep_mode.py dsp        # FPGA DSP result path, v15 image (default)
    python3 radar/set_sweep_mode.py nios       # raw capture, NIOS-stepped
    python3 radar/set_sweep_mode.py standard   # raw capture, host-stepped
    python3 radar/set_sweep_mode.py            # just report the current mode

sweep_mode is only reachable over the sdr_server WebSocket -- there is no
config entry and the GUI does not send it -- which is why this exists.

This only SETS the mode. Stop and start the sweep from the GUI afterwards:
'dsp' opens its RX stream differently (the FIFO mux, one burst per sweep), and
the stream is only rebuilt when a sweep starts, so the new mode does not take
effect on a sweep that is already running; the engine prints a notice.

Watch the server console afterwards. On success 'dsp' prints

    [bladerf] DSP result path selected, sample mode (config_gpio=0x...)

and each sweep result carries sweep_core='dsp'. In 'dsp' mode 'fallback' means
the DSP read failed for that sweep and an EMPTY (all-zero) sweep was sent in
its place -- there is no raw stream to fall back to. The reason is printed
once, then summarised; the groundstation drops those sweeps and says so on the
SFCW panel. (In 'nios' mode 'fallback' is a real standard sweep.)
"""

import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    sys.exit("pip install websockets")

URI = "ws://127.0.0.1:9003"
MODES = ('dsp', 'nios', 'standard')


async def run(mode):
    async with websockets.connect(URI, max_size=None) as ws:

        async def send(payload):
            await ws.send(json.dumps(payload))

        if mode is None:
            await send({'cmd': 'sfcw_get_status'})
            # Status may arrive behind queued broadcasts; take the first frame
            # that actually carries the field.
            for _ in range(20):
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                for blob in (msg, msg.get('data') or {}):
                    if isinstance(blob, dict) and 'sweep_mode' in blob:
                        print("sweep_mode =", blob['sweep_mode'])
                        return 0
            print("could not read sweep_mode from the status reply")
            return 1

        # SET THE MODE ONLY. This used to stop and restart the sweep too, but
        # that fights whatever already drives it -- the GUI starts and stops
        # sweeps on its own, and a stop/start from a second client that then
        # disconnects can leave the engine stopped with nothing printed at all.
        #
        # The restart is still REQUIRED (the sample format is fixed when
        # sync_config runs), it just has to come from the same place that
        # normally starts sweeps.
        print("setting sweep_mode = {}".format(mode))

        # The server pushes an sfcw_status on connect and after every
        # command, on top of answering sfcw_get_status. Anything already
        # queued predates our command, so drain it first, then accept only a
        # status that actually carries the requested mode. Reading the first
        # status in the queue reported 'nios' after a successful switch to
        # 'dsp' (2026-09-11).
        while True:
            try:
                await asyncio.wait_for(ws.recv(), timeout=0.15)
            except asyncio.TimeoutError:
                break

        await send({'cmd': 'sfcw_set_params', 'sweep_mode': mode})
        await send({'cmd': 'sfcw_get_status'})

        got = None
        deadline = asyncio.get_running_loop().time() + 5.0
        while asyncio.get_running_loop().time() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
            except asyncio.TimeoutError:
                continue
            for blob in (msg, msg.get('data') or {}):
                if isinstance(blob, dict) and 'sweep_mode' in blob:
                    got = blob['sweep_mode']
                    if got == mode:
                        print("server now reports sweep_mode =", got)
                        print("\nNow STOP and START the sweep from the GUI for it "
                              "to take effect.")
                        return 0
        if got is None:
            print("mode was set, but the server did not report it back; "
                  "stop and start the sweep from the GUI anyway")
            return 0
        print("server still reports sweep_mode =", got)
        print("WARNING: not the mode requested (no status carried "
              "{!r} within 5 s)".format(mode))
        return 1


def main():
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else None
    if mode is not None and mode not in MODES:
        sys.exit("mode must be one of: {}".format(', '.join(MODES)))
    try:
        return asyncio.run(run(mode))
    except Exception as e:
        sys.exit("failed to talk to {}: {}".format(URI, e))


if __name__ == '__main__':
    sys.exit(main())
