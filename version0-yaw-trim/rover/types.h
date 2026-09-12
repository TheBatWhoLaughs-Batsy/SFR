// Types used by rover.ino.
//
// These live in a header rather than in the sketch for a mechanical reason: the
// Arduino IDE preprocesses .ino files by auto-generating a prototype for every
// function and inserting those prototypes near the TOP of the file, right after
// the last #include. A prototype naming a type that is defined further down the
// .ino therefore refers to a type that does not exist yet:
//
//     error: 'PersistBlob' does not name a type
//      static uint32_t blobCheck(const PersistBlob& b)
//
// Anything included is visible before the generated prototypes, so putting the
// definitions here fixes it. Note that compiling the .ino as plain C++ (which is
// what rover/test/build_check.sh does, there being no Arduino toolchain on the
// Pi) does NOT reproduce the problem, because that skips the .ino preprocessing
// entirely -- build_check.sh now greps for the pattern instead.
//
// Rule: define no struct, class, enum or typedef inside rover.ino. Put it here.
#pragma once

#include <stdint.h>
#include "config.h"

// Position kept in the board's emulated EEPROM. The Pi is the authoritative
// store; this is a cross-check reported at connect so a disagreement surfaces
// instead of one side silently winning.
struct PersistBlob {
    uint32_t magic;
    int32_t pos[NUM_AXES];
    uint32_t check;
};

// A move waiting its turn. `value` is a delta when `rel` is set and is resolved
// against the position at DISPATCH time, not at receipt -- resolving on receipt
// would measure every queued relative move from the same stale origin.
struct QueuedMove {
    uint32_t seq;
    bool rel;
    bool has[NUM_AXES];
    int32_t value[NUM_AXES];
};
