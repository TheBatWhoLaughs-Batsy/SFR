#pragma once
#include "Arduino.h"
struct timer_callback_args_t { void* p_context; };
typedef void (*GPTimerCbk_t)(timer_callback_args_t*);
enum timer_mode_t { TIMER_MODE_PERIODIC, TIMER_MODE_ONE_SHOT, TIMER_MODE_PWM };
struct FspTimer {
    static int8_t get_available_timer(uint8_t& type, bool force = false) { type = 0; (void)force; return 0; }
    static void force_use_of_pwm_reserved_timer() {}
    bool begin(timer_mode_t, uint8_t, uint8_t, float, float, GPTimerCbk_t, void* ctx = nullptr) { (void)ctx; return true; }
    bool setup_overflow_irq() { return true; }
    bool open() { return true; }
    bool start() { return true; }
};
