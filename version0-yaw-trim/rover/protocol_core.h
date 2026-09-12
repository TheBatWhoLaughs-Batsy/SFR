// Wire protocol -- minimal JSON scan and emit.
//
// ARDUINO-FREE, for the same reason as motion_core.h: this is compiled by the
// sketch and by rover/test/test_core.cpp under plain g++, so the parsing can be
// tested on the Pi where there is no Arduino toolchain.
//
// Why hand-rolled rather than ArduinoJson: the message set is a dozen flat
// objects with known keys and no nesting worth speaking of, and every library
// the sketch needs is one more thing that has to be installed on the machine
// doing the flashing before it will compile. The scanner below is ~80 lines and
// is exercised by the native test, including the malformed cases.
//
// It is a SCANNER, not a parser: it finds "key": at brace depth 1 and reads the
// value after it. It does not build a tree, does not allocate, and does not
// validate the document as a whole. That is sufficient for a fixed message set
// and is why it fits in a few hundred bytes of stack.
#pragma once

#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

namespace proto {

// Locates the value for `key` at the top level of `json`. Returns a pointer to
// the first character of the value and its length, or false if absent.
//
// Nested objects and arrays are skipped rather than searched, so a key inside
// one cannot be mistaken for a top-level key of the same name. Strings are
// tracked so that a brace or a quote inside one is not treated as structure.
inline bool findValue(const char* json, const char* key,
                      const char** out, size_t* out_len) {
    if (!json || !key) return false;
    const size_t key_len = strlen(key);
    int depth = 0;
    bool in_string = false;
    bool escaped = false;

    for (const char* c = json; *c; ++c) {
        if (escaped) { escaped = false; continue; }
        if (in_string) {
            if (*c == '\\') { escaped = true; continue; }
            if (*c == '"') { in_string = false; continue; }
            continue;
        }
        if (*c == '"') {
            // A string opening at depth 1 might be our key.
            if (depth == 1 &&
                strncmp(c + 1, key, key_len) == 0 &&
                c[1 + key_len] == '"') {
                const char* v = c + 2 + key_len;
                while (*v == ' ' || *v == '\t') ++v;
                if (*v != ':') { in_string = true; continue; }
                ++v;
                while (*v == ' ' || *v == '\t') ++v;
                if (!*v) return false;

                const char* start = v;
                if (*v == '"') {
                    // String value: return the contents, without the quotes.
                    ++v;
                    const char* s = v;
                    bool esc = false;
                    while (*v && (esc || *v != '"')) {
                        esc = (!esc && *v == '\\');
                        ++v;
                    }
                    *out = s;
                    *out_len = (size_t)(v - s);
                    return true;
                }
                if (*v == '{' || *v == '[') {
                    // Object/array value: return it whole, brackets included,
                    // so a caller can rescan it if it ever needs to.
                    const char open = *v;
                    const char close = (open == '{') ? '}' : ']';
                    int d = 0;
                    bool str = false, es = false;
                    while (*v) {
                        if (es) { es = false; ++v; continue; }
                        if (str) {
                            if (*v == '\\') es = true;
                            else if (*v == '"') str = false;
                            ++v; continue;
                        }
                        if (*v == '"') str = true;
                        else if (*v == open) ++d;
                        else if (*v == close) { --d; if (d == 0) { ++v; break; } }
                        ++v;
                    }
                    *out = start;
                    *out_len = (size_t)(v - start);
                    return true;
                }
                // Bare value: number, true, false, null.
                while (*v && *v != ',' && *v != '}' && *v != ']' &&
                       *v != ' ' && *v != '\n' && *v != '\r' && *v != '\t') ++v;
                *out = start;
                *out_len = (size_t)(v - start);
                return true;
            }
            in_string = true;
            continue;
        }
        if (*c == '{' || *c == '[') ++depth;
        else if (*c == '}' || *c == ']') --depth;
    }
    return false;
}

inline bool getStr(const char* json, const char* key, char* buf, size_t buf_size) {
    const char* v; size_t n;
    if (!findValue(json, key, &v, &n)) return false;
    if (n >= buf_size) n = buf_size - 1;
    memcpy(buf, v, n);
    buf[n] = '\0';
    return true;
}

inline bool getFloat(const char* json, const char* key, float* out) {
    const char* v; size_t n;
    if (!findValue(json, key, &v, &n)) return false;
    char tmp[32];
    if (n == 0 || n >= sizeof(tmp)) return false;
    memcpy(tmp, v, n);
    tmp[n] = '\0';
    char* end = nullptr;
    const float f = strtof(tmp, &end);
    if (end == tmp) return false;   // "abc" must not silently read as 0
    *out = f;
    return true;
}

inline bool getInt32(const char* json, const char* key, int32_t* out) {
    const char* v; size_t n;
    if (!findValue(json, key, &v, &n)) return false;
    char tmp[32];
    if (n == 0 || n >= sizeof(tmp)) return false;
    memcpy(tmp, v, n);
    tmp[n] = '\0';
    char* end = nullptr;
    const long l = strtol(tmp, &end, 10);
    if (end == tmp) return false;
    *out = (int32_t)l;
    return true;
}

inline bool getBool(const char* json, const char* key, bool* out) {
    const char* v; size_t n;
    if (!findValue(json, key, &v, &n)) return false;
    if (n == 4 && strncmp(v, "true", 4) == 0) { *out = true; return true; }
    if (n == 5 && strncmp(v, "false", 5) == 0) { *out = false; return true; }
    // Tolerate 1/0, which is what a hand-typed test command tends to use.
    if (n == 1 && v[0] == '1') { *out = true; return true; }
    if (n == 1 && v[0] == '0') { *out = false; return true; }
    return false;
}

// ── emit ────────────────────────────────────────────────────────────────────
// A tiny append-only writer. Every write is bounds-checked and sets `overflow`
// rather than truncating silently, so a message that does not fit is dropped
// and reported instead of arriving as malformed JSON.
class Writer {
public:
    Writer(char* buf, size_t size) : buf_(buf), size_(size), len_(0) {
        if (size_) buf_[0] = '\0';
    }

    void raw(const char* s) {
        const size_t n = strlen(s);
        if (len_ + n + 1 > size_) { overflow_ = true; return; }
        memcpy(buf_ + len_, s, n);
        len_ += n;
        buf_[len_] = '\0';
    }

    void key(const char* k) {
        if (first_) first_ = false; else raw(",");
        raw("\""); raw(k); raw("\":");
    }

    void begin() { raw("{"); first_ = true; }
    void end()   { raw("}"); }

    void str(const char* k, const char* v)  { key(k); raw("\""); raw(v); raw("\""); }
    void i32(const char* k, int32_t v)      { key(k); num("%ld", (long)v); }
    void u32(const char* k, uint32_t v)     { key(k); num("%lu", (unsigned long)v); }
    void boolean(const char* k, bool v)     { key(k); raw(v ? "true" : "false"); }

    void f(const char* k, float v, int decimals = 3) {
        key(k);
        char fmt[8];
        snprintf(fmt, sizeof(fmt), "%%.%df", decimals);
        char tmp[32];
        snprintf(tmp, sizeof(tmp), fmt, (double)v);
        raw(tmp);
    }

    // Nested object, e.g. obj("pos"); i32("v",..); i32("h",..); endObj();
    void obj(const char* k) { key(k); raw("{"); first_ = true; }
    void endObj()           { raw("}"); first_ = false; }

    const char* c_str() const { return buf_; }
    size_t length() const { return len_; }
    bool overflow() const { return overflow_; }

private:
    void num(const char* fmt, long v) {
        char tmp[24];
        snprintf(tmp, sizeof(tmp), fmt, v);
        raw(tmp);
    }
    void num(const char* fmt, unsigned long v) {
        char tmp[24];
        snprintf(tmp, sizeof(tmp), fmt, v);
        raw(tmp);
    }

    char* buf_;
    size_t size_;
    size_t len_;
    bool first_ = true;
    bool overflow_ = false;
};

}  // namespace proto
