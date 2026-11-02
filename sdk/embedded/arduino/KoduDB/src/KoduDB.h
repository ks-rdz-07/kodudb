// KoduDB client for ESP32 and ESP8266 (Arduino core, Arduino IDE or PlatformIO).
// REST (insert, select, update, delete, upsert, RPC), sign-in with automatic token refresh, and realtime row
// changes over WebSocket, filtered by the device user's row security policies.
//
// Dependencies: ArduinoJson (7.x) and WebSockets by Markus Sattler (2.6+).
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <functional>

#if defined(ESP32)
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#elif defined(ESP8266)
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#else
#error "KoduDB supports ESP32 and ESP8266 boards"
#endif

#define KODUDB_VERSION "0.1.0"

// One row change: type is "INSERT", "UPDATE" or "DELETE"; record is the row (old_record for UPDATE).
struct KoduDBChange {
  const char* table;
  const char* type;
  JsonObjectConst record;
  JsonObjectConst oldRecord;
};

class KoduDB {
 public:
  using ChangeHandler = std::function<void(const KoduDBChange&)>;

  // url: API address (https://api.example.com, with /p/<project> for another project).
  // apiKey: the project's public key. Never put the secret key on a device.
  void begin(const String& url, const String& apiKey);
  // PEM root certificate for HTTPS. Without it HTTPS requests are refused unless setInsecure() is called.
  void setCACert(const char* pem);
  // Skips certificate checks. For development on a trusted network only.
  void setInsecure();
  void setTimeout(uint16_t ms) { _timeout = ms; }

  // Sign in as the device's user (one user per device; row security decides what it may read and write).
  bool signIn(const String& email, const String& password);
  bool refresh();
  bool signedIn() const { return _access.length() > 0; }

  // REST. Results go into `out` (a JSON array of rows, or the function's result for rpc).
  // filters use the KoduDB query syntax, e.g. "device=eq.sensor-17&celsius=gte.20".
  bool insert(const char* table, JsonVariantConst rows, JsonDocument* out = nullptr);
  bool upsert(const char* table, JsonVariantConst rows, const char* onConflict, JsonDocument* out = nullptr);
  bool select(const char* table, const String& filters, JsonDocument& out, const char* columns = "*");
  bool update(const char* table, JsonVariantConst values, const String& filters, JsonDocument* out = nullptr);
  bool remove(const char* table, const String& filters);
  // Call a Postgres function; everything it does commits or rolls back together.
  bool rpc(const char* function, JsonVariantConst args, JsonDocument* out = nullptr);

  // HTTP status of the last request (0: no connection) and its error message.
  int lastStatus() const { return _status; }
  const String& lastError() const { return _error; }

  // Realtime: call subscribe() for each table ("*" for all), then call loop() from your loop().
  void subscribe(const char* table, ChangeHandler handler);
  void loop();
  bool realtimeConnected() const { return _wsConnected; }

  // Percent-encode one filter value, e.g. "device=eq." + KoduDB::encode(name) when it may contain & = or spaces.
  static String encode(const String& value);

 private:
  static String encodeQuery(const String& query);  // keeps the = and & that separate filters
  bool request(const char* method, const String& path, const String& query, const String* body,
               JsonDocument* out, const char* prefer = nullptr, bool auth = true);
  void refreshIfNeeded();
  void connectRealtime();
  void onSocket(WStype_t type, uint8_t* payload, size_t length);
  bool storeSession(JsonDocument& doc);

  String _url, _apiKey, _host, _base, _access, _refresh, _error;
  uint16_t _port = 443;
  bool _tls = true, _insecure = false;
  const char* _ca = nullptr;
  uint16_t _timeout = 15000;
  int _status = 0;
  uint32_t _expiresAtMs = 0;

  WebSocketsClient _ws;
  bool _wsStarted = false, _wsConnected = false;
  String _wsToken;
  struct Sub {
    String table;
    ChangeHandler handler;
  };
  Sub _subs[8];
  uint8_t _subCount = 0;
};
