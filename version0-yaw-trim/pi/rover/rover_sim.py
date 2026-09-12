"""Rover controller simulator -- stands in for the Arduino.

    python3 pi/rover/rover_sim.py [--host 127.0.0.1] [--port 8765]

Dials into rover_server.py exactly as the real board does and speaks the same
JSON protocol, running the same trapezoidal ramp in Python. It exists because:

* The firmware cannot be compiled, let alone run, on the Pi -- there is no
  Arduino toolchain here -- so without this there is no way to exercise the
  server or the groundstation panel end to end at all.
* Working on the UI should not require the rig powered and connected.
* Failure modes that are awkward to produce on real hardware (a limit hit at
  speed, a dead-man expiry, an E-stop mid-move) are one flag away here.

It deliberately mirrors rover/motion_core.h rather than sharing code with it:
the point is to check that the two agree. Where it is knowingly NOT faithful:
there is no step-pulse timing, no missed steps, and no wheel slip -- it is a
kinematic model of a perfect machine, so it validates protocol and control flow,
never mechanical accuracy.
"""

import argparse
import asyncio
import json
import math
import time

import websockets

FW = "sim-2.0.0"
RAMP_HZ = 1000.0
STATUS_HZ = 20.0
MIN_SPEED = 20.0          # steps/s, matches MIN_SPEED_STEPS_S
JOG_WATCHDOG_MS = 500

MODE_IDLE, MODE_MOVE, MODE_JOG, MODE_STOPPING = 0, 1, 2, 3
(STOP_NONE, STOP_COMPLETED, STOP_REQUESTED,
 STOP_LIMIT, STOP_WATCHDOG, STOP_ESTOP) = range(6)


class SimAxis:
    def __init__(self, steps_per_mm, max_speed, jog_speed, accel, lo, hi):
        self.steps_per_mm = steps_per_mm
        self.max_speed = max_speed      # steps/s
        self.jog_speed = jog_speed
        self.accel = accel              # steps/s^2
        self.min_limit = lo
        self.max_limit = hi
        self.limits_enabled = True

        self.position = 0
        self.target = 0
        self.speed = 0.0
        self.mode = MODE_IDLE
        self.jog_dir = 0
        self.jog_deadline = 0.0
        self.stop_reason = STOP_NONE
        self.done = False
        self._phase = 0.0
        self.estopped = False

    def clamp(self, v):
        if not self.limits_enabled:
            return v
        return max(self.min_limit, min(self.max_limit, v))

    def move_to(self, t):
        if self.estopped:
            return
        self.target = self.clamp(t)
        if self.target == self.position:
            self.mode = MODE_IDLE
            self.speed = 0.0
            self.done = True
            self.stop_reason = STOP_COMPLETED
        else:
            self.mode = MODE_MOVE

    def jog(self, direction, deadline):
        if self.estopped:
            return
        self.jog_dir = 1 if direction > 0 else -1
        self.jog_deadline = deadline
        self.mode = MODE_JOG

    def refresh(self, deadline):
        if self.mode == MODE_JOG:
            self.jog_deadline = deadline

    def request_stop(self, why=STOP_REQUESTED):
        if self.mode != MODE_IDLE:
            self.mode = MODE_STOPPING
            self.stop_reason = why

    def emergency_stop(self):
        self.speed = 0.0
        self.mode = MODE_IDLE
        self.jog_dir = 0
        self.estopped = True
        self.stop_reason = STOP_ESTOP

    def clear_estop(self):
        self.estopped = False
        self.stop_reason = STOP_NONE

    def set_position(self, p):
        self.position = p
        self.target = p
        if self.mode == MODE_MOVE:
            self.mode = MODE_IDLE
            self.speed = 0.0

    def moving(self):
        return self.mode != MODE_IDLE

    def update(self, dt, now):
        """One ramp tick, mirroring Axis::updateRamp plus the stepping in tick()."""
        want = 0.0

        if self.mode == MODE_IDLE:
            self.speed = 0.0
            return
        if self.mode == MODE_MOVE:
            remaining = self.target - self.position
            if remaining == 0:
                self.speed = 0.0
                self.mode = MODE_IDLE
                self.done = True
                self.stop_reason = STOP_COMPLETED
                return
            d = 1 if remaining > 0 else -1
            want = d * self.max_speed
            v_stop = math.sqrt(2.0 * self.accel * abs(remaining))
            if abs(want) > v_stop:
                want = d * v_stop
            if abs(want) < MIN_SPEED:
                want = d * MIN_SPEED
        elif self.mode == MODE_JOG:
            if now >= self.jog_deadline:
                self.mode = MODE_STOPPING
                self.stop_reason = STOP_WATCHDOG
                want = 0.0
            else:
                want = self.jog_dir * self.jog_speed
                if self.limits_enabled:
                    room = (self.max_limit - self.position) if self.jog_dir > 0 \
                        else (self.position - self.min_limit)
                    if room <= 0:
                        self.speed = 0.0
                        self.mode = MODE_IDLE
                        self.stop_reason = STOP_LIMIT
                        return
                    v_stop = math.sqrt(2.0 * self.accel * room)
                    if abs(want) > v_stop:
                        want = self.jog_dir * v_stop
                    if abs(want) < MIN_SPEED:
                        self.speed = 0.0
                        self.mode = MODE_IDLE
                        self.stop_reason = STOP_LIMIT
                        return

        step = self.accel * dt
        if self.speed < want:
            self.speed = min(self.speed + step, want)
        elif self.speed > want:
            self.speed = max(self.speed - step, want)

        if self.mode == MODE_STOPPING and abs(self.speed) <= MIN_SPEED:
            self.speed = 0.0
            self.mode = MODE_IDLE
            self.jog_dir = 0
            return

        # Advance whole steps, so the reported position is an integer step count
        # exactly as the firmware's is.
        self._phase += self.speed * dt
        while abs(self._phase) >= 1.0:
            d = 1 if self._phase > 0 else -1
            nxt = self.position + d
            if self.limits_enabled and not (self.min_limit <= nxt <= self.max_limit):
                self.speed = 0.0
                self._phase = 0.0
                self.mode = MODE_IDLE
                self.stop_reason = STOP_LIMIT
                return
            self.position = nxt
            self._phase -= d
            if self.mode == MODE_MOVE and self.position == self.target:
                self.speed = 0.0
                self._phase = 0.0
                self.mode = MODE_IDLE
                self.done = True
                self.stop_reason = STOP_COMPLETED
                return


class Sim:
    def __init__(self, pos_valid=False):
        v_spmm = 200.0
        h_spmm = 1600.0 / (math.pi * 66.0)
        self.v = SimAxis(v_spmm, 25.0 * v_spmm, 5.0 * v_spmm, 100.0 * v_spmm,
                         0, round(900.0 * v_spmm))
        self.h = SimAxis(h_spmm, 150.0 * h_spmm, 20.0 * h_spmm, 500.0 * h_spmm,
                         0, round(3900.0 * h_spmm))
        self.estop = False
        self.enabled = True
        self.last_seq = 0
        self.in_flight_seq = 0
        self.move_pending = False
        self.queue = []
        self.pos_valid = pos_valid
        self.idle_ms = 0
        self.last_motion_ms = 0
        self.t0 = time.monotonic()

    def ms(self):
        return int((time.monotonic() - self.t0) * 1000)

    def hello(self):
        return {
            't': 'hello', 'fw': FW,
            'v_spmm': round(self.v.steps_per_mm, 4),
            'h_spmm': round(self.h.steps_per_mm, 4),
            'v_pos': self.v.position, 'h_pos': self.h.position,
            'v_lo': self.v.min_limit, 'v_hi': self.v.max_limit,
            'h_lo': self.h.min_limit, 'h_hi': self.h.max_limit,
            'v_speed': self.v.max_speed, 'v_jog': self.v.jog_speed,
            'v_accel': self.v.accel,
            'h_speed': self.h.max_speed, 'h_jog': self.h.jog_speed,
            'h_accel': self.h.accel,
            'limits': self.v.limits_enabled,
            'pos_valid': self.pos_valid, 'idle_ms': self.idle_ms, 'estop': self.estop, 'ms': self.ms(),
        }

    def status(self):
        return {
            't': 'status', 'seq': self.last_seq,
            'v_pos': self.v.position, 'h_pos': self.h.position,
            'v_spd': round(self.v.speed, 1), 'h_spd': round(self.h.speed, 1),
            'v_mode': self.v.mode, 'h_mode': self.h.mode,
            'v_stop': self.v.stop_reason, 'h_stop': self.h.stop_reason,
            'moving': self.v.moving() or self.h.moving(),
            'estop': self.estop, 'en': self.enabled,
            'pos_valid': self.pos_valid, 'idle_ms': self.idle_ms,
            'q': len(self.queue), 'ms': self.ms(),
        }

    def axis(self, name):
        return self.v if name == 'v' else self.h

    def handle(self, msg):
        """Returns a list of reply dicts."""
        c = msg.get('c')
        seq = int(msg.get('seq', 0) or 0)
        out = []

        is_hold = (c == 'jog_hold')
        if seq and seq == self.last_seq and not is_hold:
            return [{'t': 'ack', 'seq': seq}]
        # Holds must not advance last_seq -- see the same note in rover.ino.
        if not is_hold:
            self.last_seq = seq

        if self.estop and c not in ('clear_estop', 'ping', 'status', 'jog_hold'):
            return [{'t': 'err', 'seq': seq, 'code': 'estop',
                     'msg': 'latched; clear the E-stop first'}]

        if c == 'move':
            rel = bool(msg.get('rel', True))
            entry = {'seq': seq, 'rel': rel,
                     'v': msg.get('v'), 'h': msg.get('h')}
            if entry['v'] is None and entry['h'] is None:
                return [{'t': 'err', 'seq': seq, 'code': 'bad_msg',
                         'msg': 'move needs v and/or h'}]
            if len(self.queue) >= 4:
                return [{'t': 'err', 'seq': seq, 'code': 'full',
                         'msg': 'move queue is full'}]
            if not self.estop:
                self.enabled = True
            self.queue.append(entry)
            out.append({'t': 'ack', 'seq': seq})
        elif c == 'jog':
            if not self.estop:
                self.enabled = True
            self.queue.clear()
            self.move_pending = False
            hold = int(msg.get('hold_ms', JOG_WATCHDOG_MS))
            self.axis(msg.get('axis', 'h')).jog(int(msg.get('dir', 1)),
                                                self.ms() + hold)
            out.append({'t': 'ack', 'seq': seq})
        elif c == 'jog_hold':
            hold = int(msg.get('hold_ms', JOG_WATCHDOG_MS))
            self.v.refresh(self.ms() + hold)
            self.h.refresh(self.ms() + hold)
        elif c == 'stop':
            self.queue.clear()
            self.move_pending = False
            self.v.request_stop()
            self.h.request_stop()
            out.append({'t': 'ack', 'seq': seq})
        elif c == 'estop':
            self.queue.clear()
            self.move_pending = False
            self.v.emergency_stop()
            self.h.emergency_stop()
            self.estop = True
            self.enabled = False
            out += [{'t': 'ack', 'seq': seq}, self.status()]
        elif c == 'clear_estop':
            self.v.clear_estop()
            self.h.clear_estop()
            self.estop = False
            self.enabled = True
            self.pos_valid = False
            out += [{'t': 'ack', 'seq': seq}, self.status()]
        elif c == 'set_pos':
            if msg.get('v') is not None:
                self.v.set_position(int(msg['v']))
            if msg.get('h') is not None:
                self.h.set_position(int(msg['h']))
            self.pos_valid = True
            out += [{'t': 'ack', 'seq': seq}, self.status()]
        elif c == 'cfg':
            for ax, pre in ((self.v, 'v'), (self.h, 'h')):
                if msg.get(f'{pre}_speed'):
                    ax.max_speed = float(msg[f'{pre}_speed'])
                if msg.get(f'{pre}_jog'):
                    ax.jog_speed = float(msg[f'{pre}_jog'])
                if msg.get(f'{pre}_accel'):
                    ax.accel = float(msg[f'{pre}_accel'])
                if msg.get(f'{pre}_lo') is not None:
                    ax.min_limit = int(msg[f'{pre}_lo'])
                if msg.get(f'{pre}_hi') is not None:
                    ax.max_limit = int(msg[f'{pre}_hi'])
                if ax.min_limit > ax.max_limit:
                    ax.min_limit, ax.max_limit = ax.max_limit, ax.min_limit
                if msg.get('limits') is not None:
                    ax.limits_enabled = bool(msg['limits'])
            if msg.get('idle_ms') is not None:
                self.idle_ms = int(msg['idle_ms'])
                if self.idle_ms == 0 and not self.estop:
                    self.enabled = True     # see the note in rover.ino's cfg handler
            # status, never hello -- see the note in rover.ino's cfg handler.
            out += [{'t': 'ack', 'seq': seq}, self.status()]
        elif c == 'enable':
            self.enabled = bool(msg.get('on', True))
            out += [{'t': 'ack', 'seq': seq}, self.status()]
        elif c == 'ping':
            out.append({'t': 'ack', 'seq': seq})
        elif c == 'status':
            out.append(self.status())
        else:
            out.append({'t': 'err', 'seq': seq, 'code': 'unknown', 'msg': str(c)})
        return out

    def dispatch_queue(self):
        if not self.queue or self.estop:
            return
        if self.v.moving() or self.h.moving():
            return
        m = self.queue.pop(0)
        self.in_flight_seq = m['seq']
        self.move_pending = True
        if m['v'] is not None:
            self.v.move_to(self.v.position + int(m['v']) if m['rel'] else int(m['v']))
        if m['h'] is not None:
            self.h.move_to(self.h.position + int(m['h']) if m['rel'] else int(m['h']))

    def tick(self, dt):
        """Advance motion; returns any `done` message that fell due."""
        now = self.ms()
        if self.v.moving() or self.h.moving():
            self.last_motion_ms = now
        elif (self.idle_ms > 0 and self.enabled and not self.estop
              and not self.queue and now - self.last_motion_ms > self.idle_ms):
            self.enabled = False
        if self.enabled:
            self.v.update(dt, now)
            self.h.update(dt, now)
        self.dispatch_queue()
        if self.move_pending and not self.v.moving() and not self.h.moving():
            self.move_pending = False
            self.v.done = self.h.done = False
            reason = (STOP_LIMIT
                      if STOP_LIMIT in (self.v.stop_reason, self.h.stop_reason)
                      else (self.v.stop_reason or self.h.stop_reason))
            return {'t': 'done', 'seq': self.in_flight_seq,
                    'v_pos': self.v.position, 'h_pos': self.h.position,
                    'reason': reason, 'ms': now}
        return None


async def run(host, port, pos_valid, verbose):
    sim = Sim(pos_valid=pos_valid)
    url = f"ws://{host}:{port}"
    while True:
        try:
            async with websockets.connect(url) as ws:
                print(f"[sim] connected to {url}")
                await ws.send(json.dumps(sim.hello()))

                async def rx():
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        if verbose and msg.get('c') != 'jog_hold':
                            print(f"[sim] <- {raw}")
                        for reply in sim.handle(msg):
                            await ws.send(json.dumps(reply))

                async def motion():
                    dt = 1.0 / RAMP_HZ
                    status_every = int(RAMP_HZ / STATUS_HZ)
                    n = 0
                    while True:
                        done = sim.tick(dt)
                        if done:
                            await ws.send(json.dumps(done))
                        n += 1
                        if n >= status_every:
                            n = 0
                            await ws.send(json.dumps(sim.status()))
                        await asyncio.sleep(dt)

                await asyncio.gather(rx(), motion())
        except (OSError, websockets.WebSocketException) as e:
            print(f"[sim] link down ({e}); retrying in 2s")
            await asyncio.sleep(2)


def main():
    ap = argparse.ArgumentParser(description="Simulated rover controller")
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--pos-valid', action='store_true',
                    help='report a valid stored position on connect, as a board '
                         'that had been homed before would')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()
    try:
        asyncio.run(run(args.host, args.port, args.pos_valid, args.verbose))
    except KeyboardInterrupt:
        print("\n[sim] stopped.")


if __name__ == '__main__':
    main()
