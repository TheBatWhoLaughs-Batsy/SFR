// Stub of Links2004/arduinoWebSockets. Only the members rover.ino actually uses
// are declared -- so a compile error here can mean either a genuine mistake in
// the sketch OR a member missing from this stub. Check the real library's header
// before "fixing" the sketch.
#pragma once
#include "Arduino.h"
enum WStype_t {
    WStype_ERROR, WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT,
    WStype_BIN, WStype_PING, WStype_PONG,
};
typedef void (*WSEvent)(WStype_t, uint8_t*, size_t);
struct WebSocketsClient {
    void begin(const char*, uint16_t, const char*) {}
    void onEvent(WSEvent) {}
    void setReconnectInterval(unsigned long) {}
    void enableHeartbeat(uint32_t, uint32_t, uint8_t) {}
    void loop() {}
    void disconnect() {}
    bool sendTXT(const char*) { return true; }
};
