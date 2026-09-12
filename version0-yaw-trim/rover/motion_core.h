// Motion core -- trapezoidal ramp, soft limits, jog watchdog, step generation.
//
// DELIBERATELY FREE OF ARDUINO HEADERS. This file is compiled twice: once by the
// sketch, and once by rover/test/test_core.cpp with plain g++ on the Pi. There
// is no Arduino toolchain on the Pi, so keeping the parts that can actually be
// wrong -- the ramp arithmetic and the limit logic -- testable natively is the
// only way any of it gets verified before it reaches the rig. Anything needing
// a pin, a timer or a socket belongs in rover.ino, not here.
//
// Why not AccelStepper: it is built around "move to a target". What this rover
// needs is a jog with no target that can be retargeted or stopped mid-motion and
// must decelerate to land exactly on a soft limit. Layering that onto move()
// means computing the ramp anyway, so the ramp is written out here instead.
//
// Concurrency contract: tick() and updateRamp() run in the timer ISR. Every
// public mutator below is called from the main loop and MUST be wrapped in a
// critical section by the caller, because they touch several fields that the ISR
// reads together. Single 32-bit reads (position, mode) are atomic on Cortex-M
// and are safe to sample without one.
#pragma once

#include <stdint.h>
#include <math.h>
#include <stdlib.h>

enum AxisMode : uint8_t {
    MODE_IDLE = 0,
    MODE_MOVE,      // running to `target`
    MODE_JOG,       // running until stopped, watchdog-refreshed
    MODE_STOPPING,  // decelerating to a halt, then IDLE
};

// Why a stop happened, so the groundstation can say something useful rather
// than just showing motion ending.
enum StopReason : uint8_t {
    STOP_NONE = 0,
    STOP_COMPLETED,   // move reached its target
    STOP_REQUESTED,   // operator or Pi asked
    STOP_LIMIT,       // ran into a soft limit
    STOP_WATCHDOG,    // jog refreshes stopped arriving
    STOP_ESTOP,
};

struct AxisParams {
    float steps_per_mm;
    float max_speed;     // steps/s, for moves
    float jog_speed;     // steps/s, for held-key jogging
    float accel;         // steps/s^2
    int32_t min_limit;   // steps, inclusive
    int32_t max_limit;   // steps, inclusive
    bool limits_enabled;
};

// One step per PHASE_ONE of accumulated phase. 2^24 leaves plenty of headroom:
// at 20 kHz the increment for the fastest axis (5000 steps/s) is 2^24/4, so the
// accumulator is nowhere near overflowing within a tick.
static const uint32_t PHASE_ONE = 1UL << 24;

class Axis {
public:
    AxisParams p;

    // --- state the ISR owns ---
    int32_t position = 0;      // steps; THE authoritative position
    int32_t target = 0;
    float speed = 0.0f;        // signed steps/s
    AxisMode mode = MODE_IDLE;

    // --- edge flags, set by the ISR and drained by the main loop ---
    bool done_flag = false;    // a MOVE finished
    StopReason stop_reason = STOP_NONE;

    // --- internal ---
    uint32_t phase = 0;
    uint32_t phase_inc = 0;    // recomputed once per ramp tick, not per step
    int8_t jog_dir = 0;
    int8_t dir_level = 1;      // +1 / -1, what the DIR pin should express
    uint32_t jog_deadline_ms = 0;
    uint16_t ramp_counter = 0;
    uint16_t ramp_div = 1;
    float isr_hz = 20000.0f;
    float ramp_dt = 0.001f;
    float min_speed = 20.0f;
    bool estopped = false;

    void begin(float isr_hz_, float ramp_hz_, float min_speed_) {
        isr_hz = isr_hz_;
        ramp_div = (uint16_t)(isr_hz_ / ramp_hz_);
        if (ramp_div < 1) ramp_div = 1;
        ramp_dt = (float)ramp_div / isr_hz_;
        min_speed = min_speed_;
    }

    // ── commands (main loop; wrap in a critical section) ────────────────────

    void moveTo(int32_t t) {
        if (estopped) return;
        target = clampToLimits(t);
        mode = (target == position) ? MODE_IDLE : MODE_MOVE;
        if (mode == MODE_IDLE) { speed = 0.0f; done_flag = true; stop_reason = STOP_COMPLETED; }
    }

    void moveBy(int32_t delta) { moveTo(position + delta); }

    void jog(int8_t dir, uint32_t deadline_ms) {
        if (estopped || dir == 0) return;
        jog_dir = dir > 0 ? 1 : -1;
        jog_deadline_ms = deadline_ms;
        mode = MODE_JOG;
    }

    // Refreshes the dead-man without restarting the ramp, so a held key stays
    // smooth instead of re-accelerating on every heartbeat.
    void refreshJog(uint32_t deadline_ms) {
        if (mode == MODE_JOG) jog_deadline_ms = deadline_ms;
    }

    // Decelerate to a halt. Cannot be instant: a moving axis has momentum, and
    // cutting the step train at speed is how a stepper loses its position.
    void requestStop(StopReason why = STOP_REQUESTED) {
        if (mode == MODE_IDLE) return;
        mode = MODE_STOPPING;
        stop_reason = why;
    }

    // Emergency: drop the step train immediately and latch. This CAN lose
    // position if the axis was moving fast, which is the accepted trade -- the
    // point of an E-stop is that it beats position integrity.
    void emergencyStop() {
        speed = 0.0f;
        phase = 0;
        phase_inc = 0;
        mode = MODE_IDLE;
        jog_dir = 0;
        estopped = true;
        stop_reason = STOP_ESTOP;
    }

    void clearEstop() {
        estopped = false;
        stop_reason = STOP_NONE;
    }

    void setPosition(int32_t pos) {
        position = pos;
        target = pos;
        if (mode == MODE_MOVE) { mode = MODE_IDLE; speed = 0.0f; }
    }

    bool isMoving() const { return mode != MODE_IDLE; }

    // ── ISR ────────────────────────────────────────────────────────────────

    // Called every ISR tick. Returns true if a step pulse should be emitted now;
    // the caller reads dir_level to drive the DIR pin immediately beforehand.
    bool tick(uint32_t now_ms) {
        if (++ramp_counter >= ramp_div) {
            ramp_counter = 0;
            updateRamp(now_ms);
        }
        if (phase_inc == 0) return false;

        phase += phase_inc;
        if (phase < PHASE_ONE) return false;
        phase -= PHASE_ONE;

        const int8_t d = (speed >= 0.0f) ? 1 : -1;
        const int32_t next = position + d;

        // Hard clamp, independent of whatever the ramp believes. The ramp aims
        // to stop AT the limit; this guarantees it never steps past one even if
        // the parameters are inconsistent or were changed mid-motion.
        if (p.limits_enabled && (next < p.min_limit || next > p.max_limit)) {
            speed = 0.0f;
            phase_inc = 0;
            mode = MODE_IDLE;
            stop_reason = STOP_LIMIT;
            return false;
        }

        position = next;

        if (mode == MODE_MOVE && position == target) {
            speed = 0.0f;
            phase_inc = 0;
            mode = MODE_IDLE;
            done_flag = true;
            stop_reason = STOP_COMPLETED;
        }
        return true;
    }

    // Trapezoidal ramp. Runs at RAMP_HZ inside the ISR rather than in the main
    // loop, so a WiFi stall cannot leave an axis coasting at speed.
    void updateRamp(uint32_t now_ms) {
        float want = 0.0f;

        switch (mode) {
        case MODE_IDLE:
            speed = 0.0f;
            phase_inc = 0;
            return;

        case MODE_MOVE: {
            const int32_t remaining = target - position;
            if (remaining == 0) {
                speed = 0.0f;
                phase_inc = 0;
                mode = MODE_IDLE;
                done_flag = true;
                stop_reason = STOP_COMPLETED;
                return;
            }
            const int8_t want_dir = (remaining > 0) ? 1 : -1;
            want = want_dir * p.max_speed;
            // sqrt(2*a*d) is exactly the fastest we can still be going and stop
            // within the remaining distance -- capping by it produces the decel
            // side of the trapezoid without tracking phases explicitly.
            const float v_stop = sqrtf(2.0f * p.accel * (float)labs((long)remaining));
            if (fabsf(want) > v_stop) want = want_dir * v_stop;
            // Floor it so the last fraction of a step is actually taken. Without
            // this the cap above decays toward zero and the axis creeps forever
            // instead of landing on the target.
            if (fabsf(want) < min_speed) want = want_dir * min_speed;
            break;
        }

        case MODE_JOG: {
            if (now_ms >= jog_deadline_ms) {
                mode = MODE_STOPPING;
                stop_reason = STOP_WATCHDOG;
                want = 0.0f;
                break;
            }
            want = jog_dir * p.jog_speed;
            if (p.limits_enabled) {
                const int32_t room = (jog_dir > 0)
                    ? (p.max_limit - position)
                    : (position - p.min_limit);
                if (room <= 0) {
                    speed = 0.0f;
                    phase_inc = 0;
                    mode = MODE_IDLE;
                    stop_reason = STOP_LIMIT;
                    return;
                }
                // Same cap as a move, against the distance left before the
                // limit -- this is what makes a jog coast to the edge and halt
                // rather than slam into it. No min-speed floor here: stopping a
                // hair short of a limit is the safe direction to err.
                const float v_stop = sqrtf(2.0f * p.accel * (float)room);
                if (fabsf(want) > v_stop) want = jog_dir * v_stop;
                if (fabsf(want) < min_speed) {
                    speed = 0.0f;
                    phase_inc = 0;
                    mode = MODE_IDLE;
                    stop_reason = STOP_LIMIT;
                    return;
                }
            }
            break;
        }

        case MODE_STOPPING:
            want = 0.0f;
            break;
        }

        // Slew toward the wanted speed. Going through zero handles a direction
        // reversal on its own: it decelerates, crosses, then accelerates back.
        const float step = p.accel * ramp_dt;
        if (speed < want) {
            speed += step;
            if (speed > want) speed = want;
        } else if (speed > want) {
            speed -= step;
            if (speed < want) speed = want;
        }

        if (mode == MODE_STOPPING && fabsf(speed) <= min_speed) {
            speed = 0.0f;
            phase_inc = 0;
            mode = MODE_IDLE;
            jog_dir = 0;
            return;
        }

        dir_level = (speed >= 0.0f) ? 1 : -1;
        // Recomputed here, at RAMP_HZ, so tick() stays integer-only. Doing this
        // float multiply per tick instead would cost ~17% of the CPU at 20 kHz.
        phase_inc = (uint32_t)(fabsf(speed) * (float)PHASE_ONE / isr_hz);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    int32_t clampToLimits(int32_t v) const {
        if (!p.limits_enabled) return v;
        if (v < p.min_limit) return p.min_limit;
        if (v > p.max_limit) return p.max_limit;
        return v;
    }

    float positionMm() const { return position / p.steps_per_mm; }
    float speedMmS() const { return speed / p.steps_per_mm; }

    // Distance this axis needs to stop from its current speed. Reported to the
    // groundstation so an operator can see why a jog started slowing early.
    float stopDistanceSteps() const {
        return (speed * speed) / (2.0f * p.accel);
    }
};
