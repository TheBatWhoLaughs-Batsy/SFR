// Native tests for the Arduino firmware's pure-C++ cores.
//
//   g++ -std=c++17 -O2 -Wall -o /tmp/test_core rover/test/test_core.cpp && /tmp/test_core
//
// There is no Arduino toolchain on the Pi, so the firmware cannot be compiled,
// let alone run, on the machine it is developed on. Everything in motion_core.h
// and protocol_core.h is therefore kept free of Arduino headers so that the
// parts that can actually be wrong -- ramp arithmetic, limit handling, JSON
// scanning -- are exercised here before the sketch ever reaches the rig. The
// remaining unverified surface is the thin glue in rover.ino: pins, timer, WiFi.
#include "../motion_core.h"
#include "../protocol_core.h"

#include <cstdio>
#include <cmath>
#include <string>

static int failures = 0;
static int checks = 0;

static void ok(bool cond, const std::string& what) {
    ++checks;
    if (!cond) { ++failures; printf("  FAIL  %s\n", what.c_str()); }
}

static void near(float a, float b, float tol, const std::string& what) {
    ++checks;
    if (std::fabs(a - b) > tol) {
        ++failures;
        printf("  FAIL  %s  (%.6f vs %.6f, tol %.6f)\n", what.c_str(), a, b, tol);
    }
}

static void section(const char* name) { printf("\n%s\n", name); }

// ── harness ────────────────────────────────────────────────────────────────

static const float ISR = 20000.0f;
static const float RAMP = 1000.0f;

struct Sim {
    Axis ax;
    uint32_t tick_count = 0;
    int32_t steps_emitted = 0;
    float peak_speed = 0.0f;
    int32_t min_pos = 0, max_pos = 0;

    void setup(float steps_per_mm, float max_speed, float jog_speed, float accel,
               int32_t lo, int32_t hi, bool limits) {
        ax.p = { steps_per_mm, max_speed, jog_speed, accel, lo, hi, limits };
        ax.begin(ISR, RAMP, 20.0f);
    }

    uint32_t nowMs() const { return (uint32_t)(tick_count / (ISR / 1000.0f)); }

    // One ISR tick, mirroring what rover.ino's handler does.
    void step() {
        if (ax.tick(nowMs())) ++steps_emitted;
        ++tick_count;
        const float s = std::fabs(ax.speed);
        if (s > peak_speed) peak_speed = s;
        if (ax.position < min_pos) min_pos = ax.position;
        if (ax.position > max_pos) max_pos = ax.position;
    }

    // Runs until idle or the budget expires. Returns false on timeout, which is
    // itself a failure worth reporting -- an axis that never stops is a bug.
    bool runUntilIdle(float max_seconds = 60.0f) {
        const uint32_t budget = (uint32_t)(max_seconds * ISR);
        uint32_t spent = 0;
        while (ax.isMoving() && spent < budget) { step(); ++spent; }
        return !ax.isMoving();
    }

    void runSeconds(float secs) {
        const uint32_t n = (uint32_t)(secs * ISR);
        for (uint32_t i = 0; i < n; ++i) step();
    }
};

// Real rig parameters, so the tests exercise the numbers that will actually ship.
// Vertical: leadscrew, 200 steps/mm, 25 mm/s, 100 mm/s^2.
// Horizontal: 66 mm wheels, 7.7166 steps/mm, 150 mm/s, 500 mm/s^2.
static const float V_SPM = 200.0f;
static const float H_SPM = 1600.0f / (3.14159265f * 66.0f);

// ── motion tests ───────────────────────────────────────────────────────────

static void testMoveLandsExactly() {
    section("move: lands on the exact target step");
    // A long move (full trapezoid) and a short one (triangular, never reaches
    // cruise) are different code paths through the sqrt(2ad) cap.
    const int32_t cases[] = { 1, 2, 7, 200, 2000, 20000, -1, -37, -5000 };
    for (int32_t d : cases) {
        Sim s;
        s.setup(V_SPM, 25.0f * V_SPM, 5.0f * V_SPM, 100.0f * V_SPM,
                -1000000, 1000000, true);
        s.ax.moveBy(d);
        const bool finished = s.runUntilIdle();
        ok(finished, "move of " + std::to_string(d) + " steps terminates");
        ok(s.ax.position == d,
           "move of " + std::to_string(d) + " lands exactly (got " +
           std::to_string(s.ax.position) + ")");
        ok(s.steps_emitted == std::abs((long)d),
           "move of " + std::to_string(d) + " emits exactly |d| pulses (got " +
           std::to_string(s.steps_emitted) + ")");
        ok(s.ax.done_flag, "move of " + std::to_string(d) + " raises done");
        ok(s.ax.stop_reason == STOP_COMPLETED,
           "move of " + std::to_string(d) + " reports COMPLETED");
    }
}

static void testMoveRespectsMaxSpeed() {
    section("move: never exceeds max speed, and does reach it when long enough");
    Sim s;
    const float vmax = 25.0f * V_SPM;
    s.setup(V_SPM, vmax, 5.0f * V_SPM, 100.0f * V_SPM, -1000000, 1000000, true);
    s.ax.moveBy(40000);           // 200 mm, plenty of room to reach cruise
    ok(s.runUntilIdle(), "long move terminates");
    ok(s.peak_speed <= vmax + 1.0f, "peak speed does not exceed max");
    near(s.peak_speed, vmax, vmax * 0.02f, "long move reaches cruise speed");
}

static void testShortMoveStaysTriangular() {
    section("move: a short move never reaches cruise");
    Sim s;
    const float vmax = 150.0f * H_SPM;
    const float accel = 500.0f * H_SPM;
    s.setup(H_SPM, vmax, 20.0f * H_SPM, accel, -1000000, 1000000, true);
    // 1 mm horizontal -- the scan-raster case. Peak should be ~sqrt(a*d).
    const int32_t d = (int32_t)lroundf(1.0f * H_SPM);
    s.ax.moveBy(d);
    ok(s.runUntilIdle(), "1 mm move terminates");
    ok(s.ax.position == d, "1 mm move lands exactly");
    const float expect = std::sqrt(accel * (float)d);
    ok(s.peak_speed < vmax, "1 mm move stays well under cruise speed");
    near(s.peak_speed, expect, expect * 0.35f, "1 mm move peaks near sqrt(a*d)");
}

static void testMoveClampedToLimits() {
    section("move: a target outside the envelope is clamped, not refused");
    Sim s;
    s.setup(V_SPM, 25.0f * V_SPM, 5.0f * V_SPM, 100.0f * V_SPM, 0, 1000, true);
    s.ax.setPosition(900);
    s.ax.moveBy(500);                       // would land at 1400
    ok(s.ax.target == 1000, "target clamped to the max limit");
    ok(s.runUntilIdle(), "clamped move terminates");
    ok(s.ax.position == 1000, "lands exactly on the limit");
    ok(s.max_pos <= 1000, "never steps past the limit");
}

static void testDirectionReversal() {
    section("move: reversing mid-motion decelerates through zero");
    Sim s;
    s.setup(V_SPM, 25.0f * V_SPM, 5.0f * V_SPM, 100.0f * V_SPM,
            -1000000, 1000000, true);
    s.ax.moveBy(20000);
    s.runSeconds(0.5f);                     // get up to speed
    ok(s.ax.speed > 0.0f, "moving forward before the reversal");
    const float before = s.ax.speed;
    s.ax.moveTo(-5000);                     // reverse target
    // It must not teleport to negative speed; it has to ramp down through zero.
    s.step();
    ok(std::fabs(s.ax.speed - before) <= s.ax.p.accel / RAMP + 1.0f,
       "speed changes by at most one ramp increment");
    ok(s.runUntilIdle(), "reversed move terminates");
    ok(s.ax.position == -5000, "reversed move lands exactly");
}

static void testJogStopsAtLimit() {
    section("jog: coasts to the soft limit and stops without crossing it");
    Sim s;
    const float accel = 500.0f * H_SPM;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, accel, 0, 3000, true);
    s.ax.setPosition(0);
    s.ax.jog(+1, 0xFFFFFFFF);               // watchdog disabled for this test
    ok(s.runUntilIdle(120.0f), "jog into the limit terminates on its own");
    ok(s.ax.position <= 3000, "never steps past the limit");
    ok(s.max_pos <= 3000, "no intermediate step past the limit either");
    ok(s.ax.stop_reason == STOP_LIMIT, "reports LIMIT as the reason");
    // It should arrive close to the limit, not stop far short.
    ok(s.ax.position > 2990, "stops within 10 steps of the limit (got " +
       std::to_string(s.ax.position) + ")");
    ok(s.ax.speed == 0.0f, "ends at zero speed");
}

static void testJogNegativeLimit() {
    section("jog: same in the negative direction");
    Sim s;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, 500.0f * H_SPM, -500, 500, true);
    s.ax.setPosition(400);
    s.ax.jog(-1, 0xFFFFFFFF);
    ok(s.runUntilIdle(120.0f), "negative jog terminates");
    ok(s.ax.position >= -500, "never steps below the min limit");
    ok(s.min_pos >= -500, "no intermediate step below the min limit");
    ok(s.ax.position < -490, "stops within 10 steps of the min limit");
}

static void testJogWatchdog() {
    section("jog: a stale dead-man decelerates the axis");
    Sim s;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, 500.0f * H_SPM,
            -1000000, 1000000, true);
    // Deadline 200 ms out; then never refreshed.
    s.ax.jog(+1, 200);
    s.runSeconds(0.15f);
    ok(s.ax.mode == MODE_JOG, "still jogging before the deadline");
    ok(s.ax.speed > 0.0f, "has picked up speed");
    ok(s.runUntilIdle(5.0f), "stops itself once the deadline passes");
    ok(s.ax.stop_reason == STOP_WATCHDOG, "reports WATCHDOG as the reason");
    ok(s.ax.speed == 0.0f, "ends at zero speed");
}

static void testJogRefreshKeepsGoing() {
    section("jog: refreshing the dead-man keeps it running smoothly");
    Sim s;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, 500.0f * H_SPM,
            -1000000, 1000000, true);
    s.ax.jog(+1, 200);
    // Refresh every 100 ms of simulated time for a second, as the panel does.
    for (int i = 0; i < 10; ++i) {
        s.runSeconds(0.1f);
        s.ax.refreshJog(s.nowMs() + 200);
    }
    ok(s.ax.mode == MODE_JOG, "still jogging after a second of refreshes");
    near(s.ax.speed, 20.0f * H_SPM, 20.0f * H_SPM * 0.02f,
         "settles at exactly the jog speed");
    s.ax.requestStop();
    ok(s.runUntilIdle(5.0f), "stops when asked");
    ok(s.ax.stop_reason == STOP_REQUESTED, "reports REQUESTED as the reason");
}

static void testEmergencyStop() {
    section("estop: cuts motion immediately and latches");
    Sim s;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, 500.0f * H_SPM,
            -1000000, 1000000, true);
    s.ax.jog(+1, 0xFFFFFFFF);
    s.runSeconds(0.5f);
    ok(s.ax.speed > 0.0f, "moving before the estop");
    s.ax.emergencyStop();
    ok(s.ax.speed == 0.0f, "speed is zero immediately, not after a ramp");
    ok(!s.ax.isMoving(), "no longer moving");
    const int32_t frozen = s.ax.position;
    s.runSeconds(0.5f);
    ok(s.ax.position == frozen, "does not move while latched");
    // Commands must be refused while latched.
    s.ax.moveBy(1000);
    s.ax.jog(+1, 0xFFFFFFFF);
    s.runSeconds(0.2f);
    ok(s.ax.position == frozen, "ignores move and jog while latched");
    s.ax.clearEstop();
    s.ax.moveBy(100);
    ok(s.runUntilIdle(), "moves again once cleared");
    ok(s.ax.position == frozen + 100, "and lands correctly");
}

static void testLimitsDisabled() {
    section("limits: disabling them removes the clamp entirely");
    Sim s;
    s.setup(V_SPM, 25.0f * V_SPM, 5.0f * V_SPM, 100.0f * V_SPM, 0, 10, false);
    s.ax.moveBy(5000);
    ok(s.ax.target == 5000, "target not clamped when limits are off");
    ok(s.runUntilIdle(), "unclamped move terminates");
    ok(s.ax.position == 5000, "runs past where the limit would have been");
}

static void testSetPosition() {
    section("setPosition: rebases without moving");
    Sim s;
    s.setup(V_SPM, 25.0f * V_SPM, 5.0f * V_SPM, 100.0f * V_SPM,
            -1000000, 1000000, true);
    s.ax.moveBy(500);
    s.runUntilIdle();
    s.ax.setPosition(0);
    ok(s.ax.position == 0, "position rebased");
    ok(!s.ax.isMoving(), "still idle");
    const int32_t emitted = s.steps_emitted;
    s.runSeconds(0.2f);
    ok(s.steps_emitted == emitted, "emits no pulses from rebasing");
}

static void testStepCountIsExact() {
    section("accounting: pulses emitted always equal net displacement");
    // The property the Pi's whole position model rests on.
    Sim s;
    s.setup(H_SPM, 150.0f * H_SPM, 20.0f * H_SPM, 500.0f * H_SPM,
            -1000000, 1000000, true);
    const int32_t legs[] = { 771, -300, 45, -516, 2000, -2000 };
    int32_t expect_travel = 0;
    for (int32_t d : legs) {
        s.ax.moveBy(d);
        ok(s.runUntilIdle(), "leg terminates");
        expect_travel += std::abs((long)d);
    }
    ok(s.ax.position == 0, "legs sum back to zero (got " +
       std::to_string(s.ax.position) + ")");
    ok(s.steps_emitted == expect_travel,
       "total pulses equal total |displacement| (" +
       std::to_string(s.steps_emitted) + " vs " +
       std::to_string(expect_travel) + ")");
}

// ── protocol tests ─────────────────────────────────────────────────────────

static void testJsonScalars() {
    section("json: scalar extraction");
    const char* j = "{\"c\":\"move\",\"seq\":42,\"v\":-1234,\"speed\":12.5,"
                    "\"rel\":true,\"off\":false,\"neg\":-0.25}";
    char buf[32];
    ok(proto::getStr(j, "c", buf, sizeof(buf)) && std::string(buf) == "move",
       "string value");
    int32_t i = 0;
    ok(proto::getInt32(j, "seq", &i) && i == 42, "positive int");
    ok(proto::getInt32(j, "v", &i) && i == -1234, "negative int");
    float f = 0;
    ok(proto::getFloat(j, "speed", &f) && std::fabs(f - 12.5f) < 1e-6f, "float");
    ok(proto::getFloat(j, "neg", &f) && std::fabs(f + 0.25f) < 1e-6f, "negative float");
    bool b = false;
    ok(proto::getBool(j, "rel", &b) && b, "true");
    ok(proto::getBool(j, "off", &b) && !b, "false");
    ok(!proto::getInt32(j, "missing", &i), "missing key reports absent");
}

static void testJsonDoesNotMatchNested() {
    section("json: a nested key is not mistaken for a top-level one");
    // `seq` appears inside `pos`; the top-level `seq` is the one that must win.
    const char* j = "{\"pos\":{\"seq\":999,\"v\":1},\"seq\":7}";
    int32_t i = 0;
    ok(proto::getInt32(j, "seq", &i) && i == 7, "top-level seq wins over nested");
    const char* v = nullptr; size_t n = 0;
    const bool found = proto::findValue(j, "pos", &v, &n);
    ok(found && std::string(v, n) == "{\"seq\":999,\"v\":1}",
       "object value returned whole, brackets included (got \"" +
       (found ? std::string(v, n) : std::string("<none>")) + "\")");
    // And a key that exists ONLY inside the nested object must not be found.
    ok(!proto::getInt32(j, "nope", &i), "absent key still absent");
}

static void testJsonStringContents() {
    section("json: structure inside strings is not treated as structure");
    const char* j = "{\"msg\":\"a{b}c,\\\"d\\\"\",\"seq\":5}";
    int32_t i = 0;
    ok(proto::getInt32(j, "seq", &i) && i == 5,
       "key after a string full of braces and escaped quotes");
    char buf[32];
    ok(proto::getStr(j, "msg", buf, sizeof(buf)), "the string itself extracts");
}

static void testJsonMalformed() {
    section("json: malformed input is rejected, not silently read as zero");
    int32_t i = 0;
    float f = 0;
    ok(!proto::getInt32("{\"a\":\"xyz\"}", "a", &i), "non-numeric int rejected");
    ok(!proto::getFloat("{\"a\":\"xyz\"}", "a", &f), "non-numeric float rejected");
    ok(!proto::getInt32("", "a", &i), "empty document");
    ok(!proto::getInt32("{", "a", &i), "truncated document");
    ok(!proto::getInt32("{\"a\"", "a", &i), "key with no value");
    ok(!proto::getInt32("{\"ab\":1}", "a", &i), "prefix key does not match");
    ok(proto::getInt32("{\"ab\":1}", "ab", &i) && i == 1, "exact key does match");
}

static void testWriter() {
    section("json: writer output");
    char buf[256];
    proto::Writer w(buf, sizeof(buf));
    w.begin();
    w.str("t", "status");
    w.i32("seq", 12);
    w.obj("pos");
    w.i32("v", -5);
    w.i32("h", 900);
    w.endObj();
    w.boolean("moving", true);
    w.f("speed", 1.25f, 2);
    w.end();
    const std::string got = w.c_str();
    const std::string want =
        "{\"t\":\"status\",\"seq\":12,\"pos\":{\"v\":-5,\"h\":900},"
        "\"moving\":true,\"speed\":1.25}";
    ok(got == want, "emits the expected document\n        got:  " + got +
                    "\n        want: " + want);
    ok(!w.overflow(), "no overflow on a message that fits");

    // Round-trip: what we emit must be readable by our own scanner.
    int32_t seq = 0;
    ok(proto::getInt32(got.c_str(), "seq", &seq) && seq == 12, "round-trips");
}

static void testWriterOverflow() {
    section("json: overflow is reported, never truncated silently");
    char buf[16];
    proto::Writer w(buf, sizeof(buf));
    w.begin();
    w.str("key", "a value far too long for this buffer");
    w.end();
    ok(w.overflow(), "overflow flagged");
    ok(strlen(w.c_str()) < sizeof(buf), "buffer not overrun");
}

int main() {
    printf("rover firmware core tests\n");
    testMoveLandsExactly();
    testMoveRespectsMaxSpeed();
    testShortMoveStaysTriangular();
    testMoveClampedToLimits();
    testDirectionReversal();
    testJogStopsAtLimit();
    testJogNegativeLimit();
    testJogWatchdog();
    testJogRefreshKeepsGoing();
    testEmergencyStop();
    testLimitsDisabled();
    testSetPosition();
    testStepCountIsExact();
    testJsonScalars();
    testJsonDoesNotMatchNested();
    testJsonStringContents();
    testJsonMalformed();
    testWriter();
    testWriterOverflow();
    printf("\n%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
