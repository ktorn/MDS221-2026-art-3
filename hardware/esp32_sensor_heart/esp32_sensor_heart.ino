#include <WiFi.h>
#include <WebSocketsServer.h>
#include "sensor_code.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <cstring>
#include <esp_wifi.h>

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#ifndef REGISTER_BASE_URL
#define REGISTER_BASE_URL ""
#endif
#ifndef REGISTER_SECRET
#define REGISTER_SECRET ""
#endif
#ifndef DEVICE_CODE_ID
#define DEVICE_CODE_ID ""
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

// Serial over built-in USB: Tools -> USB CDC On Boot -> Enabled (ESP32-S3).
// WPA2 Personal (PSK). ESP32-S3 Wi-Fi is 2.4 GHz only — set WIFI_SSID / WIFI_PASSWORD in secrets.h.

// Do not use GPIO19/20 as UART — they are USB D-/D+ and will break the USB port.

// --- WiFi + cloud registry: copy secrets.example.h -> secrets.h (gitignored). ---

#ifndef WIFI_TX_POWER
#define WIFI_TX_POWER WIFI_POWER_8_5dBm
#endif

#ifndef WIFI_COUNTRY_CC
#define WIFI_COUNTRY_CC "US"
#endif

#ifndef USE_ESP_WIFI_TUNING
#define USE_ESP_WIFI_TUNING 1
#endif

static const unsigned long REGISTER_INTERVAL_MS = 5UL * 60UL * 1000UL;
static const unsigned long BPM_SEND_INTERVAL_MS = 200;
static unsigned long gLastRegistryPostMs = 0;

WebSocketsServer webSocket(81);
static WiFiClientSecure sTls;
static bool sTlsReady = false;

static const char* wlReason(int s) {
  switch (s) {
    case WL_IDLE_STATUS: return "IDLE";
    case WL_NO_SSID_AVAIL: return "NO_SSID_AVAIL";
    case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
    case WL_CONNECTED: return "CONNECTED";
    case WL_CONNECT_FAILED: return "CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED: return "DISCONNECTED";
    default: return "UNKNOWN";
  }
}

static void applyCountryAndProtocol() {
#if USE_ESP_WIFI_TUNING
  wifi_country_t country = {};
  strncpy(country.cc, WIFI_COUNTRY_CC, sizeof(country.cc));
  country.cc[sizeof(country.cc) - 1] = '\0';
  country.schan = 1;
  country.nchan = (strcmp(country.cc, "US") == 0) ? 11 : 13;
  country.policy = WIFI_COUNTRY_POLICY_MANUAL;
  esp_err_t err = esp_wifi_set_country(&country);
  if (err != ESP_OK) {
    Serial.printf("[WiFi] esp_wifi_set_country: %s\n", esp_err_to_name(err));
  }
  esp_wifi_set_protocol(WIFI_IF_STA,
                        WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
#endif
}

static void prepareStaStack() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(100);
  WiFi.setSleep(false);
  WiFi.setTxPower(WIFI_TX_POWER);
  applyCountryAndProtocol();
}

static void scanForTargetSsid() {
  Serial.println("[WiFi] scanning...");
  int n = WiFi.scanNetworks(false, true);
  if (n < 0) {
    Serial.printf("[WiFi] scan failed (%d)\n", n);
    return;
  }
  bool seen = false;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) != WIFI_SSID) continue;
    seen = true;
    Serial.printf("  \"%s\"  RSSI=%d dBm  ch=%u  enc=%d\n", WIFI_SSID, WiFi.RSSI(i),
                  WiFi.channel(i), (int)WiFi.encryptionType(i));
  }
  if (!seen) {
    Serial.println(
        "[WiFi] target SSID not seen - check SSID, 2.4 GHz, distance, antenna.");
  }
}

static bool connectWifi() {
  Serial.printf("Connecting to \"%s\" (WPA2 Personal)...\n", WIFI_SSID);
  Serial.flush();

  prepareStaStack();
  scanForTargetSsid();

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t timeoutMs = 60000;
  uint32_t start = millis();
  int last = -1;

  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > timeoutMs) {
      Serial.println("\nTimeout - not connected. Last status:");
      Serial.println(wlReason(WiFi.status()));
      return false;
    }

    int st = WiFi.status();
    if (st != last) {
      last = st;
      Serial.printf("\n[WiFi] %s (%d)\n", wlReason(st), st);
    } else {
      Serial.print(".");
    }
    delay(500);
  }

  Serial.println();
  Serial.print("Connected, IP: ");
  Serial.println(WiFi.localIP());
  Serial.printf("[WiFi] TX power (getTxPower): %d\n", (int)WiFi.getTxPower());
  Serial.println("WebSocket server on port 81 (ws://<this-ip>:81/)");
  return true;
}

static String jsonQuoted(const char* raw) {
  String out = "\"";
  if (!raw) raw = "";
  for (const char* p = raw; *p; p++) {
    if (*p == '"' || *p == '\\') {
      out += '\\';
      out += *p;
    } else if ((unsigned char)*p < 0x20U) {
      continue;
    } else {
      out += *p;
    }
  }
  out += '"';
  return out;
}

static void registerWithCloud() {
  if (!REGISTER_BASE_URL || !REGISTER_BASE_URL[0]) return;
  if (!REGISTER_SECRET || !REGISTER_SECRET[0]) return;
  if (WiFi.status() != WL_CONNECTED) return;

  if (!sTlsReady) {
    sTls.setInsecure();
    sTlsReady = true;
  }

  HTTPClient http;
  String url = String(REGISTER_BASE_URL) + "/register";
  if (!http.begin(sTls, url)) {
    Serial.println("[Registry] http.begin failed");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + REGISTER_SECRET);

  String mac = WiFi.macAddress();
  String body = String("{\"mac\":\"") + mac + "\",\"device_id\":" + jsonQuoted(DEVICE_CODE_ID) +
                ",\"wifi_ssid\":" + jsonQuoted(WIFI_SSID) + ",\"lan_ip\":\"" +
                WiFi.localIP().toString() + "\"}";

  int code = http.POST(body);
  Serial.printf("[Registry] POST /register -> HTTP %d\n", code);
  if (code > 0) {
    Serial.println(http.getString());
  }
  http.end();
}

static void broadcastBpm(int bpm) {
  if (bpm <= 0) return;
  String msg = String("{\"bpm\":") + bpm + ",\"source\":\"esp32\",\"ts\":" + millis() + "}";
  webSocket.broadcastTXT(msg);
  Serial.print("BPM: ");
  Serial.println(bpm);
}

void setup() {
  delay(1000);
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32 WiFi + WebSocket streamer");

  sensorCodeBegin();

  if (!connectWifi()) {
    Serial.println("Rebooting in 10 s...");
    delay(10000);
    ESP.restart();
  }

  webSocket.begin();
  registerWithCloud();
  gLastRegistryPostMs = millis();
}

void loop() {
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] lost connection, reconnecting...");
    if (connectWifi()) {
      registerWithCloud();
      gLastRegistryPostMs = millis();
    }
    return;
  }

  sensorCodeUpdate();

  static unsigned long lastSend = 0;
  if (millis() - lastSend > BPM_SEND_INTERVAL_MS) {
    lastSend = millis();
    broadcastBpm(sensorCodeGetBpm());
  }

  if (REGISTER_BASE_URL && REGISTER_BASE_URL[0] && REGISTER_SECRET &&
      REGISTER_SECRET[0] &&
      millis() - gLastRegistryPostMs > REGISTER_INTERVAL_MS) {
    gLastRegistryPostMs = millis();
    registerWithCloud();
  }
}
