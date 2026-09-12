"""Closed-loop yaw trim ("alpha") from the BNO085 heading.

The rover has one driven front wheel and two driven rear wheels on separate
axles; nothing steers. The firmware runs the rear pair at (1 -/+ alpha) of the
base rate, which yaws the chassis. Open-loop, alpha is a number the operator
tunes by eye (`yaw_trim_pct`). This module produces it from the IMU instead.

    heading error  e = wrap(yaw - yaw_ref)          degrees, CCW positive
    alpha          = Kp * e * dir + bias            percent, clamped
    bias          += Ki * e * dir * dt              slow integral, learns the standing drift

`dir` is the sign of horizontal travel. It matters: the same alpha turns the
nose one way going right and the other way going left (see rover/config.h,
"Yaw trim"), so the correction has to flip with it. While the rover is not
moving horizontally nothing is learned and alpha is held.

Pure Python, no I/O: `YawController` is fed samples and asked for alpha, so it
is unit-testable without a rover or an IMU. `run_yaw_feed()` below is the only
asynchronous piece and just pumps the sensor stream into it.

Sign check on the rig: engage auto, jog along the wall. If the gap gets WORSE,
flip `yaw_invert` in the rover config. Everything else stays the same.
"""

import asyncio
import json
import math
import time

try:
    import websockets
except ImportError:            # unit tests run without it
    websockets = None


def wrap_deg(a):
    """Wrap to (-180, 180]."""
    a = (a + 180.0) % 360.0 - 180.0
    return 180.0 if a == -180.0 else a


class YawController:
    ALPHA_MAX = 30.0           # mirrors YAW_TRIM_MAX_PCT in rover/config.h

    def __init__(self, kp=2.0, ki=0.2, invert=False, stale_s=1.0, min_speed_mm_s=2.0,
                 deadband_deg=0.15, send_interval_s=0.25):
        self.kp = float(kp)            # percent per degree of heading error
        self.ki = float(ki)            # percent per degree per second
        self.invert = bool(invert)
        self.stale_s = float(stale_s)
        self.min_speed = float(min_speed_mm_s)
        # Below this the error is treated as zero: the BNO085's heading jitters
        # by a few hundredths of a degree and the board only takes integers.
        self.deadband = float(deadband_deg)
        # A `trim` command is ~40 bytes and the board acks each one; at 4 Hz
        # that is nothing, at 50 Hz it competes with the status stream.
        self.send_interval = float(send_interval_s)
        self._last_sent = None
        self._last_sent_ts = None

        self.enabled = False
        self.yaw_ref = None            # degrees; "this heading is parallel"
        self.yaw = None                # last heading seen
        self.yaw_ts = None             # monotonic time of that sample
        self.bias = 0.0                # learned standing correction, percent
        self.alpha = 0.0               # last output, percent (float; sent as int)
        self.error = 0.0               # last heading error, degrees
        self._last_update = None

    # ---- inputs ----

    def feed(self, yaw_deg, ts=None):
        """New heading sample from the IMU. Ignored if None."""
        if yaw_deg is None:
            return
        self.yaw = float(yaw_deg)
        self.yaw_ts = time.monotonic() if ts is None else ts

    def zero(self):
        """Declare the current heading to be 'parallel'. Also the reference is
        taken automatically the first time auto mode engages with a heading
        available."""
        if self.yaw is None:
            return False
        self.yaw_ref = self.yaw
        return True

    def engage(self, seed_alpha=0.0):
        """Switch to auto. `seed_alpha` is the manual trim in force, used as the
        starting bias so the loop does not begin from zero and re-learn what the
        operator already found."""
        self.enabled = True
        self.bias = self._clamp(float(seed_alpha))
        self.alpha = self.bias
        self._last_update = None
        self._last_sent = int(round(self.alpha))
        self._last_sent_ts = None
        if self.yaw_ref is None:
            self.zero()

    def disengage(self):
        self.enabled = False
        self._last_update = None

    # ---- state ----

    def imu_ok(self, now=None):
        if self.yaw_ts is None:
            return False
        now = time.monotonic() if now is None else now
        return (now - self.yaw_ts) <= self.stale_s

    def snapshot(self, now=None):
        return {
            'mode': 'auto' if self.enabled else 'manual',
            'alpha': int(round(self.alpha)),
            'alpha_raw': round(self.alpha, 2),
            'bias': round(self.bias, 2),
            'error_deg': round(self.error, 2),
            'yaw_deg': None if self.yaw is None else round(self.yaw, 2),
            'yaw_ref_deg': None if self.yaw_ref is None else round(self.yaw_ref, 2),
            'imu_ok': self.imu_ok(now),
            'kp': self.kp, 'ki': self.ki, 'invert': self.invert,
        }

    # ---- the loop ----

    def update(self, x_speed_mm_s, now=None):
        """Advance the controller. Returns the integer alpha to send to the
        board, or None if nothing should be sent (not in auto, IMU stale,
        stationary, or unchanged)."""
        if not self.enabled:
            return None
        now = time.monotonic() if now is None else now
        if not self.imu_ok(now) or self.yaw_ref is None:
            # Hold whatever alpha is in force; never steer on a dead sensor.
            self._last_update = None
            return None

        self.error = wrap_deg(self.yaw - self.yaw_ref)
        if abs(x_speed_mm_s) < self.min_speed:
            self._last_update = None      # stationary: hold, learn nothing
            return None

        d = 1.0 if x_speed_mm_s > 0 else -1.0
        if self.invert:
            d = -d
        e = self.error if abs(self.error) > self.deadband else 0.0
        drive = e * d

        if self._last_update is not None:
            dt = max(0.0, min(0.5, now - self._last_update))
            self.bias = self._clamp(self.bias + self.ki * drive * dt)
        self._last_update = now

        self.alpha = self._clamp(self.kp * drive + self.bias)
        out = int(round(self.alpha))
        if out == self._last_sent:
            return None
        if self._last_sent_ts is not None and (now - self._last_sent_ts) < self.send_interval:
            return None
        self._last_sent = out
        self._last_sent_ts = now
        return out

    def mark_sent(self, alpha):
        """Record an alpha that reached the board by another path (e.g. the
        manual value pushed in `cfg`) so the next update() is judged against
        what the board actually holds."""
        self._last_sent = int(round(alpha))

    def _clamp(self, v):
        return max(-self.ALPHA_MAX, min(self.ALPHA_MAX, v))


async def run_yaw_feed(controller, url='ws://127.0.0.1:9001', note=print):
    """Subscribe to the sensor stream and push every heading into the
    controller. Reconnects forever; the controller treats silence as a stale
    IMU and holds alpha, so this task dying is never a safety problem."""
    if websockets is None:
        note("[yaw] websockets module missing; IMU feed disabled")
        return
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(url, ping_interval=None, max_size=1 << 16) as ws:
                note(f"[yaw] IMU feed connected to {url}")
                backoff = 1.0
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    controller.feed(msg.get('yaw_deg'))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            note(f"[yaw] IMU feed down ({exc!r}); retrying in {backoff:.0f}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 15.0)
