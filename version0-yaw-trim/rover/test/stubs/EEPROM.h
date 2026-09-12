#pragma once
#include "Arduino.h"
struct EEPROMStub {
    template <typename T> T& get(int, T& t) { memset(&t, 0, sizeof(T)); return t; }
    template <typename T> const T& put(int, const T& t) { return t; }
};
extern EEPROMStub EEPROM;
