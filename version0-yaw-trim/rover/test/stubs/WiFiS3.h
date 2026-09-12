#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WL_IDLE_STATUS 0
struct WiFiStub {
    void disconnect() {}
    void begin(const char*, const char*) {}
    void config(IPAddress) {}
    void config(IPAddress, IPAddress, IPAddress, IPAddress) {}
    void end() {}
    void setHostname(const char*) {}
    static const char* firmwareVersion() { return "0.0.0-stub"; }
    uint8_t* macAddress(uint8_t* mac) { for (int i = 0; i < 6; ++i) mac[i] = 0; return mac; }
    int status() { return WL_CONNECTED; }
    IPAddress localIP() { return IPAddress(1,2,3,4); }
    IPAddress gatewayIP() { return IPAddress(1,2,3,1); }
    IPAddress subnetMask() { return IPAddress(255,255,255,0); }
    IPAddress dnsIP(int = 0) { return IPAddress(1,2,3,1); }
    long RSSI() { return -50; }
};
extern WiFiStub WiFi;
struct WiFiClient {
    bool connect(IPAddress, uint16_t) { return false; }
    bool connect(const char*, uint16_t) { return false; }
    void stop() {}
};
inline void _serial_print_ip(SerialStub& s, const IPAddress&) { (void)s; }
