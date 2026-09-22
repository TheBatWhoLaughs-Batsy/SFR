---
name: pi-deploy
description: Deploy to the Raspberry Pi, restart the stack, and confirm it actually came up. Use when Pi code changed, when the groundstation frontend needs rebuilding on the Pi, after a power cycle, or when something that worked yesterday does not today. Encodes the four-service check, the FPGA-reverts-on-power-cycle trap and the device-wedge recovery.
---

# pi-deploy — getting a change onto the Pi and proving it landed

The Pi is `sfr@10.42.0.1` on its own access point `sfr-pi`, lab or field. It is always that
address; the rover's `PI_HOST` depends on it.

## Deploy

Pull on the Pi — it is a normal clone. Frontend changes need a rebuild there:

```bash
cd groundstation/frontend && npm run build    # ~9 s on the Pi
```

Flask serves `frontend/dist`, so a rebuild plus a browser refresh is the whole deploy. No restart
needed for a frontend-only change.

For Pi Python changes, restart the stack:

```bash
python3 -u start.py      # -u so output reaches a log as it happens
```

## Four services must come up

| port | service |
|---|---|
| 5000 | Flask — the frontend and `/api/models` |
| 9001 | sensors |
| 9002 | rover |
| 9003 | SDR |

`start.py` does **no supervision**, so a service that dies stays dead and the others keep
running. Check all four, not just the one you changed.

Stopping: one SIGTERM stops all four and `sdr_server` prints `[sdr] device closed`. **If you do
not see that line, the bladeRF was not closed cleanly** — see below.

To stop only the SDR for a bench measurement, kill that process; the others are unaffected.

**Shell trap:** `pkill -f 'python3 -u start.py'` matches the calling shell's own command line and
kills it mid-command. Use a bracketed pattern (`start[.]py`) or the known PID.

## After any power cycle: check the FPGA

**The v15 DSP image is RAM-loaded only. SPI flash holds the v1 sweep image, so a power cycle
silently halves throughput and `dsp` mode fails every sweep.**

```bash
python3 pi/radar/check_bit6.py                                    # services stopped
bladeRF-cli -l fpga/images/hostedxA9_niosIIf_sweep_dsp_v15_*.rbf  # into RAM
```

Confirm behaviourally, not from `bladeRF-cli -e info` — that string is no longer diagnostic:

- `sweep_core` on `sfcw_result` — `nios` / `fallback` / `standard`
- the sweep rate: ~136 Hz healthy, ~36 Hz NIOS, **~18 Hz means NIOS unreachable**, ~15 Hz the old
  image

Read that rate from the Pi's own timestamps. A 20 Hz display throttle once made a healthy 36 Hz
radar read 17.9 Hz in the UI, which is indistinguishable from a reverted image.

## When the bladeRF wedges

Symptom: `No devices available` on open, or `Failed to receive NIOS II response`, or transfer
timeouts. Usually an unclean shutdown left TX/RX enabled with transfers in flight.

1. Restart `start.py` after a **15-20 s gap**. A 4 s gap is not enough — the previous process has
   not released the device.
2. If that fails: `lsusb`, then `usbreset <bus>/<dev>`. Nothing short of this worked once —
   resting the device, killing processes and libbladeRF's own reset on open all failed.
3. Watch for the board re-enumerating under a **new device number**; that is the signature.

## Other things that revert or drift

- **The AP profile** is `sfr-pi-ap`, bound to the dongle's MAC. `nmcli con up sfr-pi-ap`;
  `iw dev wlan1 info` must say `type AP`. Leases in
  `/var/lib/NetworkManager/dnsmasq-wlan1.leases`.
- **`set_config` persists on the Pi**, so a raster that did not restore the rail speed quietly
  slows every later nudge and jog.
- **SFCW parameters are pushed, never read back.** A stale browser tab can push its own over a
  running sweep — that is how a wrong `range_offset` got into recorded scans.
- **The rover board has not been flashed** with the `sfr-pi` credentials. `build_check.sh` passes;
  flashing is a separate, confirm-first step.

## Confirm it landed

Do not report a deploy from the fact that a command ran. Confirm:

- all four ports listening;
- a sweep arriving at the expected rate with the expected `sweep_core`;
- the sensor stream's IMU Hz tile live in the UI;
- for a frontend change, the change visible after a hard refresh — the browser caches `dist`.
