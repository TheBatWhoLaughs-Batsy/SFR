"""Steering for the rover: heading from the IMU, standoff from the LiDAR.

The rover has one driven front wheel and two driven rear wheels on separate
axles; nothing steers. The firmware runs the rear pair at (1 -/+ alpha) of the
base rate, which yaws the chassis. This module decides alpha.

Three modes, each strictly more capable than the last:

  manual   alpha is a number the operator tuned by eye.

  heading  Hold the IMU heading at a reference. Fixes travelling SLANTED.
           It cannot fix being in the wrong PLACE: heading is unobservable in
           position, so any disturbance that shoves the rover sideways leaves
           it running perfectly parallel along a NEW line, permanently offset.
           That is the observed behaviour and it is inherent, not a bug.

  track    Cascade. The LiDAR standoff drives a small heading OFFSET, and the
           heading loop holds that offset. Being too far from the wall becomes
           a request to point very slightly at it, which the inner loop then
           flies. Standoff error is now closed, so the line comes back.

            d_err   = standoff - standoff_ref                    mm, + is too far
            psi     = clamp(-Kd * d_err * dir * s, +/-psi_max)   deg, heading offset
            e       = wrap(yaw - (yaw_ref + psi))                deg
            alpha   = clamp(Kp * e * dir + bias)                 percent
            bias   += Ki * e * dir * dt

`dir` is the sign of horizontal travel, and it appears TWICE for different
reasons. In the inner loop because the same alpha yaws the chassis the opposite
way in reverse. In the outer loop because a given heading moves the rover
sideways the opposite way in reverse (driving backwards, velocity is opposite
to where the nose points). Both are automatic; neither is an operator setting.

The outer loop is P-only on purpose. The plant from heading to lateral position
is an integrator, so proportional control already drives the standoff error to
zero at equilibrium, and a second integrator would only fight the inner loop's
bias term for authority over the same steady-state.

Degradation is deliberate. A stale IMU holds alpha and steers nothing. A stale
or implausible LiDAR drops `track` to `heading` behaviour -- straight, but not
distance-corrected -- rather than steering on a bad range.

Pure Python, no I/O: `YawController` is fed samples and asked for alpha, so it
is unit-testable without a rover, an IMU or a LiDAR. `run_yaw_feed()` is the
only asynchronous piece and just pumps the sensor stream into it.

Two sign checks on the rig, both one flag, both documented in the panel:
  * engage `heading`; if the drift gets WORSE, flip `yaw_invert`.
  * engage `track` offset from the wall; if it drives further away or into the
    wall instead of returning, flip `standoff_invert`.
"""

import asyncio
import json
import time

try:
    import websockets
except ImportError:                      # unit tests run without it
    websockets = None

MODE_MANUAL = 'manual'
MODE_HEADING = 'heading'
MODE_TRACK = 'track'
MODES = (MODE_MANUAL, MODE_HEADING, MODE_TRACK)


def wrap_deg(a):
    """Wrap to (-180, 180]."""
    a = (a + 180.0) % 360.0 - 180.0
    return 180.0 if a == -180.0 else a


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class YawController:
    ALPHA_MAX = 30.0            # mirrors YAW_TRIM_MAX_PCT in rover/config.h

    def __init__(self, kp=2.0, ki=0.2, invert=False,
                 kd=0.05, psi_max_deg=6.0, standoff_invert=False,
                 standoff_deadband_mm=3.0, standoff_min_mm=40.0,
                 standoff_max_mm=2000.0, lidar_ema=0.35, outlier_mm=120.0,
                 stale_s=1.0, lidar_stale_s=1.5, min_speed_mm_s=2.0,
                 deadband_deg=0.15, send_interval_s=0.25):
        # inner loop (IMU heading)
        self.kp = float(kp)                  # percent of trim per degree of error
        self.ki = float(ki)                  # percent per degree per second
        self.invert = bool(invert)
        self.deadband = float(deadband_deg)
        # outer loop (LiDAR standoff)
        self.kd = float(kd)                  # degrees of heading offset per mm of error
        self.psi_max = float(psi_max_deg)    # never point more than this at the wall
        self.standoff_invert = bool(standoff_invert)
        self.standoff_deadband = float(standoff_deadband_mm)
        self.standoff_min = float(standoff_min_mm)
        self.standoff_max = float(standoff_max_mm)
        self.lidar_ema = float(lidar_ema)
        self.outlier_mm = float(outlier_mm)
        # timing / gating
        self.stale_s = float(stale_s)
        self.lidar_stale_s = float(lidar_stale_s)
        self.min_speed = float(min_speed_mm_s)
        self.send_interval = float(send_interval_s)

        self.mode = MODE_MANUAL
        self.yaw = None
        self.yaw_ts = None
        self.yaw_ref = None
        self.standoff = None          # filtered, mm
        self.standoff_raw = None
        self.standoff_ts = None
        self.standoff_ref = None
        self.bias = 0.0
        self.alpha = 0.0
        self.error = 0.0              # heading error actually flown, deg
        self.psi = 0.0                # heading offset the LiDAR is asking for, deg
        self.d_err = 0.0              # standoff error, mm
        self._standoff_seq = None
        self._outliers = 0
        self._last_dir = 1.0          # sign of the last X travel; used while parked
        self.state = 'manual'         # why alpha is / is not moving, for the panel
        self._last_update = None
        self._last_sent = None
        self._last_sent_ts = None

    # ---------------- inputs ----------------

    def feed(self, yaw_deg, ts=None):
        """New heading sample. Ignored if None."""
        if yaw_deg is None:
            return
        self.yaw = float(yaw_deg)
        self.yaw_ts = time.monotonic() if ts is None else ts

    def feed_standoff(self, mm, seq=None, ts=None):
        """New LiDAR range. `seq` identifies the MEASUREMENT (stream.py counts
        measurements, not polls), so repeats of a sample already seen are
        dropped rather than fed to the filter as if they were new."""
        if mm is None:
            return
        if seq is not None and seq == self._standoff_seq:
            return
        self._standoff_seq = seq
        d = float(mm)
        if not (self.standoff_min <= d <= self.standoff_max):
            return                                   # out of the plausible window
        now = time.monotonic() if ts is None else ts
        self.standoff_raw = d
        if self.standoff is None:
            self.standoff = d
        elif abs(d - self.standoff) > self.outlier_mm:
            # One wild sample is a speckle off the wall; three in a row means
            # the rover really did move, so re-acquire rather than stay stuck.
            self._outliers += 1
            if self._outliers < 3:
                return
            self.standoff = d
            self._outliers = 0
        else:
            self._outliers = 0
            self.standoff += self.lidar_ema * (d - self.standoff)
        self.standoff_ts = now

    # ---------------- references ----------------

    def zero(self):
        """Declare the current heading to be 'parallel'."""
        if self.yaw is None:
            return False
        self.yaw_ref = self.yaw
        return True

    def hold_standoff(self, mm=None):
        """Declare the target distance from the wall. Defaults to wherever the
        rover is now."""
        target = self.standoff if mm is None else float(mm)
        if target is None:
            return False
        self.standoff_ref = target
        return True

    def set_mode(self, mode, seed_alpha=0.0, now=None):
        """Returns (ok, reason). `seed_alpha` is the manual trim in force, used
        as the starting bias so an engaged loop does not begin from zero and
        re-learn what the operator already found. `now` is injectable so the
        staleness gates can be exercised against a simulated clock."""
        if mode not in MODES:
            return False, f"unknown mode {mode!r}"
        if mode != MODE_MANUAL:
            if self.yaw is None or not self.imu_ok(now):
                return False, "no heading from the IMU stream"
            if mode == MODE_TRACK and not self.lidar_ok(now):
                return False, "no LiDAR range from the sensor stream"

        if mode == MODE_MANUAL:
            self.mode = MODE_MANUAL
            self._last_update = None
            return True, "manual"

        if self.mode == MODE_MANUAL:
            self.bias = clamp(float(seed_alpha), -self.ALPHA_MAX, self.ALPHA_MAX)
            self.alpha = self.bias
            self._last_sent = int(round(self.alpha))
            self._last_sent_ts = None
        self.mode = mode
        self._last_update = None
        if self.yaw_ref is None:
            self.zero()
        if mode == MODE_TRACK and self.standoff_ref is None:
            self.hold_standoff()
        return True, mode

    # ---------------- state ----------------

    def imu_ok(self, now=None):
        if self.yaw_ts is None:
            return False
        now = time.monotonic() if now is None else now
        return (now - self.yaw_ts) <= self.stale_s

    def lidar_ok(self, now=None):
        if self.standoff_ts is None or self.standoff is None:
            return False
        now = time.monotonic() if now is None else now
        return (now - self.standoff_ts) <= self.lidar_stale_s

    def snapshot(self, now=None):
        return {
            'mode': self.mode,
            'state': self.state if self.mode != MODE_MANUAL else 'manual',
            'alpha': int(round(self.alpha)),
            'alpha_raw': round(self.alpha, 2),
            'bias': round(self.bias, 2),
            'error_deg': round(self.error, 2),
            'psi_deg': round(self.psi, 2),
            'yaw_deg': None if self.yaw is None else round(self.yaw, 2),
            'yaw_ref_deg': None if self.yaw_ref is None else round(self.yaw_ref, 2),
            'standoff_mm': None if self.standoff is None else round(self.standoff, 1),
            'standoff_ref_mm': None if self.standoff_ref is None else round(self.standoff_ref, 1),
            'standoff_err_mm': round(self.d_err, 1),
            'imu_ok': self.imu_ok(now),
            'lidar_ok': self.lidar_ok(now),
            'kp': self.kp, 'ki': self.ki, 'kd': self.kd,
            'psi_max_deg': self.psi_max,
            'invert': self.invert, 'standoff_invert': self.standoff_invert,
        }

    # ---------------- the loop ----------------

    def update(self, x_speed_mm_s, now=None):
        """Advance the controller. Returns the integer alpha to send to the
        board, or None if nothing should be sent (manual, sensor stale,
        unchanged, or inside the send interval).

        Stationary, the error and the proportional term stay LIVE (so alpha
        follows the heading and is already right when the traverse starts), but
        the integrator is frozen: a parked rover cannot turn, so learning bias
        from its error would only wind up. Direction while stationary is the
        last direction travelled (forward before any travel)."""
        if self.mode == MODE_MANUAL:
            self.state = 'manual'
            return None
        now = time.monotonic() if now is None else now
        if not self.imu_ok(now) or self.yaw_ref is None:
            self._last_update = None          # never steer on a dead sensor
            self.state = 'imu_stale' if self.yaw_ref is not None else 'no_reference'
            return None
        moving = abs(x_speed_mm_s) >= self.min_speed
        if moving:
            self._last_dir = 1.0 if x_speed_mm_s > 0 else -1.0
        travel = self._last_dir
        self.state = 'moving' if moving else 'stationary'

        d = -travel if self.invert else travel

        # ---- outer loop: how far off the wall are we, and which way to lean
        self.psi = 0.0
        if self.mode == MODE_TRACK and self.standoff_ref is not None and self.lidar_ok(now):
            self.d_err = self.standoff - self.standoff_ref
            de = self.d_err if abs(self.d_err) > self.standoff_deadband else 0.0
            s = -1.0 if self.standoff_invert else 1.0
            # dir appears here for the heading->lateral relationship, separately
            # from its appearance below for the alpha->heading relationship.
            self.psi = clamp(-self.kd * de * travel * s, -self.psi_max, self.psi_max)
        else:
            self.d_err = 0.0

        # ---- inner loop: fly the (offset) heading
        self.error = wrap_deg(self.yaw - (self.yaw_ref + self.psi))
        e = self.error if abs(self.error) > self.deadband else 0.0
        drive = e * d

        if moving:
            if self._last_update is not None:
                dt = clamp(now - self._last_update, 0.0, 0.5)
                self.bias = clamp(self.bias + self.ki * drive * dt,
                                  -self.ALPHA_MAX, self.ALPHA_MAX)
            self._last_update = now
        else:
            self._last_update = None          # integrator frozen while parked

        self.alpha = clamp(self.kp * drive + self.bias, -self.ALPHA_MAX, self.ALPHA_MAX)
        out = int(round(self.alpha))
        if out == self._last_sent:
            return None
        if self._last_sent_ts is not None and (now - self._last_sent_ts) < self.send_interval:
            return None
        self._last_sent = out
        self._last_sent_ts = now
        return out

    def mark_sent(self, alpha):
        """Record an alpha that reached the board by another path (the manual
        value pushed in `cfg`) so the next update() is judged against what the
        board actually holds."""
        self._last_sent = int(round(alpha))


async def run_yaw_feed(controller, url='ws://127.0.0.1:9001', note=print):
    """Pump the sensor stream into the controller: heading and LiDAR range.
    Reconnects forever; the controller treats silence as stale and holds, so
    this task dying is never a safety problem."""
    if websockets is None:
        note("[yaw] websockets module missing; sensor feed disabled")
        return
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(url, ping_interval=None, max_size=1 << 16) as ws:
                note(f"[yaw] sensor feed connected to {url}")
                backoff = 1.0
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    controller.feed(msg.get('yaw_deg'))
                    controller.feed_standoff(msg.get('lidar'), msg.get('lidar_seq'))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            note(f"[yaw] sensor feed down ({exc!r}); retrying in {backoff:.0f}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 15.0)
