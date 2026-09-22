# Sensor stream — port 9001

**Purpose** — publish LiDAR and IMU to every groundstation client at a steady rate.

**Location** — `pi/sensors/stream.py`, launched by `pi/start.py`.

---

## Architecture

Three independent parts, and the independence is the design:

- `imu_poll_loop` — polls the BNO085 in its own task via `run_in_executor`, publishing the
  latest reading into a shared dict.
- `lidar_poll_loop` — one per head, same pattern, at `LIDAR_POLL_HZ = 200`.
- the broadcast loop — reads those dicts at `--rate` (default 50 Hz) and never awaits a sensor.

**A sensor must never be awaited inline in the broadcast loop.** A silent LiDAR blocks on a
100 ms UART timeout, which used to throttle the *entire* stream — IMU included — to ~10 Hz
regardless of `--rate`. Reported as "the IMU feels choppy". After the split, a still-dead LiDAR
left the IMU at 48 Hz.

## Failure independence

Every sensor is guarded **at construction and at every per-iteration read**, separately.

Init-time protection alone was not enough: a device that enumerates fine can drop off the bus
later, and then raises on *every* loop iteration. That exception escaped, hit the task-exception
handler, and called `request_stop()` — killing the whole process, so port 9001 went dead and
every panel's standoff read `—` while the SDR panel on 9003 kept working. Which looks like a
LiDAR bug and is the IMU killing the shared stream.

After `IMU_FAIL_LIMIT = 20` consecutive failures the IMU is disabled, because each failing read
costs an I2C timeout that would otherwise throttle the LiDAR rate. The LiDAR read is guarded
the same way. A failed sensor streams `null`.

## Broadcast

`BROADCAST_TIMEOUT_S = 0.5` per client, gathered concurrently, with slow clients dropped.
Without it one client that stops draining freezes every other client — measured, a healthy
client alongside a non-draining one went from a 10,000 ms worst gap to 503 ms.

This file's `gather` unpacks its generator to completion *before* the first await, so unlike
the other two servers it was never exposed to the set-mutation variant of that bug.

**Each browser tab opens three sockets** — 9001 sensors, 9002 rover, 9003 SDR — drained by the
same main thread, so rover-panel rendering competes with draining the LiDAR socket. Worst
during a rover-driven C-scan. Check `ss -tn | grep :9001` during an incident: closed tabs
linger up to ~40 s on the 20 s keepalive, so a client count that flaps is normal.

## The packet

Legacy fields (`lidar`, `lidar_seq`, `lidar_ts`, `lidar_err`, `lidar_last_good_mm`,
`lidar_last_good_age_s`) mirror **the first configured head**, plus `lidar_primary` naming it.
Then `lidars: {uart1, uart2, uart3}` with a full record each, and `accel` / `gyro` / `temp` /
quaternion / yaw from the IMU.

`lidar_ts` and `sfcw_result.timestamp` are **the same `time.time()` clock**, which is what
makes continuous background capture able to pair a sweep with the standoff it was taken at.
Do not switch either to `time.monotonic()` without fixing the other.

## Change history

- Poll rate went uncapped to 20 Hz to 200 Hz, and `lidar_seq` changed from counting reads to
  counting distinct measurements at the same time — the two changes are coupled. See
  `lidar.md`.
- Grew from one LiDAR head to three on 2026-09-15.
