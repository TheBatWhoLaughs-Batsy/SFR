"""BNO085 IMU driver over I2C (SHTP / SH-2 protocol).

Raw SHTP implementation over smbus2 rather than adafruit-blinka: this repo's other
sensor drivers (mpu6500.py, tflc02.py) are direct register/byte-protocol drivers with
no framework dependency, and adafruit_bno08x has a real bug conflating host-TX and
device-RX sequence numbers per channel (see its __init__.py `_sequence_number` TODO) —
harmless here since we track our own independently, but not something to depend on
unreviewed.

Two things worth knowing if this needs debugging on the bench again:
  - The SH-2 app firmware must actually be running for feature reports to work.
    Product ID queries (the control-channel handshake) succeed even when it isn't —
    that got mistaken for "communication is fine" once already. If enable_feature()
    starts timing out again with product ID queries still working, don't re-chase
    protocol bugs — power-cycle the board first.
  - Every I2C transaction here is a single `i2c_rdwr` read of a fixed-size buffer
    (`_read`), never a header-peek followed by a separate body read. SHTP-over-I2C
    re-presents a pending packet from byte 0 on every new transaction, so splitting
    header and body reads into two transactions silently desyncs them.
"""

import math
import struct
import time

import smbus2

ADDR = 0x4A

_CHAN_SHTP_COMMAND = 0
_CHAN_EXE = 1
_CHAN_CONTROL = 2
_CHAN_INPUT_REPORTS = 3

_PRODUCT_ID_REQUEST = 0xF9
_PRODUCT_ID_RESPONSE = 0xF8
_SET_FEATURE_COMMAND = 0xFD
_GET_FEATURE_RESPONSE = 0xFC
_BASE_TIMESTAMP = 0xFB
_TIMESTAMP_REBASE = 0xFA

REPORT_ACCELEROMETER = 0x01
REPORT_GYROSCOPE = 0x02
# On-chip fusion, gyro + accel ONLY -- no magnetometer, so it is immune to the
# four stepper motors it sits next to. Heading is relative (zero is wherever the
# chip was pointing at reset) and drifts slowly, which is fine for holding a
# heading across one pass and re-zeroing between them. Used for yaw trim.
REPORT_GAME_ROTATION_VECTOR = 0x08

# report_id -> total record length in bytes, for splitting a batched packet.
_REPORT_LENGTHS = {
    _BASE_TIMESTAMP: 5,
    _TIMESTAMP_REBASE: 5,
    REPORT_ACCELEROMETER: 10,
    REPORT_GYROSCOPE: 10,
    REPORT_GAME_ROTATION_VECTOR: 12,
}

_ACCEL_SCALE = 2**-8  # Q8, m/s^2
_GYRO_SCALE = 2**-9  # Q9, rad/s
_QUAT_SCALE = 2**-14  # Q14, unit quaternion
_MS2_TO_G = 1.0 / 9.80665
_RAD_TO_DEG = 180.0 / 3.141592653589793

# Deliberately small: a full-size I2C transaction costs real time (128 bytes at
# 100kHz is ~12ms; 48 bytes is ~4ms, measured on this Pi) and read_all() below
# drains in a loop, so oversizing this directly slows every poll. 64 bytes covers
# a base-timestamp record plus all three reports batched together
# (5+10+10+12=37) with headroom, as long as the reports don't pile up faster
# than we drain them — see the interval choice below.
_MAX_PACKET = 64

# How many times the whole reset -> product ID -> enable sequence is attempted
# before giving up. The observed failure on this rig (2026-09-10) was product ID
# answering and the feature enable timing out, which is the sensor's SH-2 app not
# (yet) running -- a longer settle and a second reset usually clears it; a power
# cycle of the SENSOR always does (a `sudo reboot` does not cut its 3V3).
_INIT_ATTEMPTS = 3


class BNO085:
    # 20ms (50Hz) matches stream.py's default loop rate. This isn't just a nicety:
    # the BNO085 pushes reports on its own schedule regardless of whether the host
    # is draining them, so an interval faster than the host can actually service
    # (one _read() transaction is a few ms, not free) makes the report queue back
    # up without bound — read_all()'s drain loop then hits its cap on every single
    # call, batches grow past _MAX_PACKET and get silently truncated, and
    # calibrate_gyro_bias's 200Hz sampling loop effectively never finishes. Confirmed
    # this exact hang at the old 10ms/100Hz default; don't drop below ~20ms without
    # re-checking read_all()'s per-call read count stays small in steady state.
    def __init__(self, bus_num=1, addr=ADDR, accel_interval_us=20000, gyro_interval_us=20000):
        self.bus = smbus2.SMBus(bus_num)
        self.addr = addr
        self._tx_seq = [0] * 6
        self._latest_accel = (0.0, 0.0, 0.0)
        self._latest_gyro = (0.0, 0.0, 0.0)
        self._latest_quat = None            # (i, j, k, real) or None until the first GRV
        self.has_rotation = False
        self.part_number = None
        # Transport health, surfaced in the init error because it distinguishes a
        # protocol/timing problem from the bus not working at all.
        self.io_errors = 0
        self.bad_headers = 0
        self.oversize_reads = 0

        last_err = None
        for attempt in range(1, _INIT_ATTEMPTS + 1):
            try:
                # Order matters. Silence any features a previous process left
                # running BEFORE resetting, so the reset is not competing with a
                # 100 report/s flood, then drain to genuinely empty.
                self._silence()
                self._soft_reset(settle_s=0.2 + 0.1 * attempt)
                self._check_product_id()
                self._enable_feature(REPORT_ACCELEROMETER, accel_interval_us)
                self._enable_feature(REPORT_GYROSCOPE, gyro_interval_us)
                last_err = None
                break
            except RuntimeError as e:
                last_err = e
                print(f"BNO085: init attempt {attempt}/{_INIT_ATTEMPTS} failed ({e}); "
                      f"{'retrying' if attempt < _INIT_ATTEMPTS else 'giving up'} "
                      f"[io_errors={self.io_errors} bad_headers={self.bad_headers} "
                      f"oversize={self.oversize_reads}]")
        if last_err is not None:
            hint = "run pi/sensors/bno085_diag.py -- it reports which of these it is"
            if self.bad_headers > 4 or self.io_errors > 0:
                hint = ("I2C transfers are failing outright (bad_headers=%d io_errors=%d). "
                        "The BNO08x needs clock stretching, which the Pi's controller does "
                        "badly at speed: add `dtparam=i2c_arm_baudrate=50000` to "
                        "/boot/firmware/config.txt and reboot. Then %s"
                        % (self.bad_headers, self.io_errors, hint))
            raise RuntimeError(f"{last_err} -- {hint}")
        # Rotation is optional: accel/gyro streaming must not depend on it.
        try:
            self._enable_feature(REPORT_GAME_ROTATION_VECTOR, gyro_interval_us)
            self.has_rotation = True
        except RuntimeError as e:
            print(f"BNO085: game rotation vector unavailable ({e}); yaw will be null")

    def who_am_i(self):
        return self.part_number

    def read_all(self):
        """Drain whatever sensor reports are currently pending and return the
        latest accel (g) / gyro (deg/s). Non-blocking: returns immediately once
        the device has nothing left queued, using the last known reading for
        anything that hasn't updated since the previous call."""
        for _ in range(16):
            packet = self._read()
            if packet is None:
                break
            if packet['continued']:
                continue
            if packet['channel'] == _CHAN_INPUT_REPORTS:
                self._handle_input_reports(packet['data'])

        return {
            'accel': self._latest_accel,
            'gyro': self._latest_gyro,
            'temp': None,
            'quat': self._latest_quat,
            'yaw_deg': self.yaw_deg(),
        }

    def yaw_deg(self):
        """Heading from the game rotation vector, degrees, counter-clockwise
        positive about the sensor's +Z, relative to wherever the chip was
        pointing at its last reset. None until a rotation report has arrived."""
        q = self._latest_quat
        if q is None:
            return None
        i, j, k, w = q
        siny_cosp = 2.0 * (w * k + i * j)
        cosy_cosp = 1.0 - 2.0 * (j * j + k * k)
        return math.degrees(math.atan2(siny_cosp, cosy_cosp))

    def close(self):
        self.bus.close()

    # ---------------- SHTP transport ----------------

    def _send(self, channel, data):
        header = struct.pack('<HBB', len(data) + 4, channel, self._tx_seq[channel])
        self._tx_seq[channel] = (self._tx_seq[channel] + 1) % 256
        self.bus.i2c_rdwr(smbus2.i2c_msg.write(self.addr, header + bytes(data)))

    def _read(self, maxlen=_MAX_PACKET):
        """One SHTP packet, or None if the device has nothing queued.

        Three things this has to get right, all of which used to be wrong:

        * A packet LONGER than `maxlen` was silently truncated. `buf[4:4+data_len]`
          does not raise when the buffer is short -- it just returns fewer bytes --
          so an oversized packet became a short one and `_handle_input_reports`
          bailed out mid-batch. The SHTP advertisement the device sends after every
          reset is ~272 bytes, four times the old 48-byte buffer. Now the length is
          read first and, if it does not fit, the packet is re-read at its true size
          in a single transaction (never a header-peek plus a body read -- see the
          module docstring for why splitting them desyncs).
        * `packet_len & 0x7FFF` stripped the continuation bit and then treated the
          fragment as a whole packet. Continuations are now reported so callers can
          drop them rather than parse garbage.
        * A failed transfer (the BNO08x relies on I2C clock stretching, which the
          Pi's controller implements badly) returns 0xFF padding, which decoded as
          a 32763-byte packet on channel 255. Now rejected as no-data.
        """
        try:
            msg = smbus2.i2c_msg.read(self.addr, maxlen)
            self.bus.i2c_rdwr(msg)
            buf = bytes(msg)
        except OSError:
            self.io_errors += 1
            return None
        if len(buf) < 4:
            return None
        raw_len, channel, seq = struct.unpack_from('<HBB', buf)
        continued = bool(raw_len & 0x8000)
        packet_len = raw_len & 0x7FFF
        if packet_len == 0:
            return None
        if packet_len < 4 or packet_len > 0x400 or channel > 5:
            self.bad_headers += 1          # 0xFF padding / a desynced stream
            return None

        if packet_len > maxlen:
            # Re-read the whole thing at its real length, one transaction.
            self.oversize_reads += 1
            try:
                msg = smbus2.i2c_msg.read(self.addr, packet_len)
                self.bus.i2c_rdwr(msg)
                buf = bytes(msg)
            except OSError:
                self.io_errors += 1
                return None
            if len(buf) < 4:
                return None
            raw_len, channel, seq = struct.unpack_from('<HBB', buf)
            continued = bool(raw_len & 0x8000)
            packet_len = raw_len & 0x7FFF
            if packet_len < 4:
                return None

        data = buf[4:packet_len]
        return {'channel': channel, 'seq': seq, 'data': data, 'continued': continued}

    def _await_control(self, want_report_id, want_feature=None, timeout=2.0,
                       on_packet=None):
        """Read until a control-channel report arrives, or `timeout`.

        The loops this replaces slept 20 ms after EVERY read, including reads that
        returned a packet -- capping intake at 50 packets/s. With accel and gyro
        both at 50 Hz the device emits ~100 reports/s, so a sensor already
        streaming (any restart of stream.py that did not cut the sensor's power:
        a crash, Ctrl-C, systemctl restart) produced a queue that grew faster than
        the handshake could drain it. The response was in there; the loop never
        reached it. That is the `feature 0x.. was not confirmed enabled` seen on
        the rig, and it needs no power cycle to explain or to clear.

        Now: read flat out while packets keep coming, and only sleep when the
        device actually reports empty.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            packet = self._read()
            if packet is None:
                time.sleep(0.002)
                continue
            if on_packet is not None:
                on_packet(packet)
            if packet['continued']:
                continue
            data = packet['data']
            if packet['channel'] == _CHAN_CONTROL and data and data[0] == want_report_id:
                if want_feature is None or (len(data) > 1 and data[1] == want_feature):
                    return packet
            if packet['channel'] == _CHAN_INPUT_REPORTS:
                self._handle_input_reports(data)
                # The feature's own data arriving is as good a confirmation as the
                # 0xFC response, and is what Adafruit's driver accepts. A missed
                # response used to fail a sensor that was in fact streaming.
                if want_feature is not None and self._contains_report(data, want_feature):
                    return packet
        return None

    def _drain(self, max_s=1.5, quiet_reads=6):
        """Read until the device is genuinely empty, not until a timer expires.

        The old version slept 10 ms per read, i.e. ~30 reads in its 0.3 s budget,
        against a sensor that can be emitting 100 reports/s. It returned with the
        queue as full as it started. Returns the number of packets consumed.
        """
        drained = 0
        quiet = 0
        deadline = time.monotonic() + max_s
        while time.monotonic() < deadline and quiet < quiet_reads:
            if self._read() is None:
                quiet += 1
                time.sleep(0.002)
            else:
                quiet = 0
                drained += 1
        return drained

    def _silence(self):
        """Ask for every feature we might have left running to stop.

        A Set Feature with interval 0 disables that report. Without this, a
        restart inherits whatever the previous process enabled -- the sensor keeps
        streaming through a soft reset that the host cannot confirm -- and the
        handshake runs against a live flood. This is the fix for the case where
        power-cycling the sensor is NOT the answer.
        """
        for fid in (REPORT_ACCELEROMETER, REPORT_GYROSCOPE, REPORT_GAME_ROTATION_VECTOR):
            report = bytearray(17)
            report[0] = _SET_FEATURE_COMMAND
            report[1] = fid
            struct.pack_into('<I', report, 5, 0)
            try:
                self._send(_CHAN_CONTROL, report)
            except OSError:
                self.io_errors += 1
        time.sleep(0.05)
        return self._drain()

    # ---------------- setup ----------------

    def _soft_reset(self, settle_s=0.3):
        self._send(_CHAN_EXE, [0x01])
        time.sleep(settle_s)
        self._drain(0.3)

    def _check_product_id(self):
        self._send(_CHAN_CONTROL, [_PRODUCT_ID_REQUEST, 0x00])
        packet = self._await_control(_PRODUCT_ID_RESPONSE)
        if packet is None:
            raise RuntimeError('BNO085: no product ID response (is it powered / reset?)')
        if len(packet['data']) >= 8:
            self.part_number = struct.unpack_from('<I', packet['data'], offset=4)[0]

    def _enable_feature(self, feature_id, report_interval_us):
        report = bytearray(17)
        report[0] = _SET_FEATURE_COMMAND
        report[1] = feature_id
        struct.pack_into('<I', report, 5, report_interval_us)
        self._send(_CHAN_CONTROL, report)
        if self._await_control(_GET_FEATURE_RESPONSE, want_feature=feature_id) is None:
            raise RuntimeError(f'BNO085: feature 0x{feature_id:02x} was not confirmed enabled')

    @staticmethod
    def _contains_report(data, report_id):
        i, n = 0, len(data)
        while i < n:
            rid = data[i]
            length = _REPORT_LENGTHS.get(rid)
            if length is None or i + length > n:
                return False
            if rid == report_id:
                return True
            i += length
        return False

    # ---------------- report parsing ----------------

    def _handle_input_reports(self, data):
        i = 0
        n = len(data)
        while i < n:
            report_id = data[i]
            length = _REPORT_LENGTHS.get(report_id)
            if length is None or i + length > n:
                break
            if report_id == REPORT_ACCELEROMETER:
                x, y, z = struct.unpack_from('<hhh', data, offset=i + 4)
                self._latest_accel = (x * _ACCEL_SCALE * _MS2_TO_G,
                                       y * _ACCEL_SCALE * _MS2_TO_G,
                                       z * _ACCEL_SCALE * _MS2_TO_G)
            elif report_id == REPORT_GYROSCOPE:
                x, y, z = struct.unpack_from('<hhh', data, offset=i + 4)
                self._latest_gyro = (x * _GYRO_SCALE * _RAD_TO_DEG,
                                      y * _GYRO_SCALE * _RAD_TO_DEG,
                                      z * _GYRO_SCALE * _RAD_TO_DEG)
            elif report_id == REPORT_GAME_ROTATION_VECTOR:
                qi, qj, qk, qw = struct.unpack_from('<hhhh', data, offset=i + 4)
                self._latest_quat = (qi * _QUAT_SCALE, qj * _QUAT_SCALE,
                                     qk * _QUAT_SCALE, qw * _QUAT_SCALE)
            i += length
