#include "KoduDB.h"

void KoduDB::begin(const String& url, const String& apiKey) {
  _url = url;
  while (_url.endsWith("/")) _url.remove(_url.length() - 1);
  _apiKey = apiKey;
  String rest = _url;
  if (rest.startsWith("https://")) {
    _tls = true;
    _port = 443;
    rest = rest.substring(8);
  } else {
    _tls = false;
    _port = 80;
    rest = rest.substring(rest.startsWith("http://") ? 7 : 0);
  }
  int slash = rest.indexOf('/');
  String hostport = slash < 0 ? rest : rest.substring(0, slash);
  _base = slash < 0 ? "" : rest.substring(slash);
  int colon = hostport.indexOf(':');
  _host = colon < 0 ? hostport : hostport.substring(0, colon);
  if (colon >= 0) _port = hostport.substring(colon + 1).toInt();
}

void KoduDB::setCACert(const char* pem) { _ca = pem; }
void KoduDB::setInsecure() { _insecure = true; }

static String percentEncode(const String& value, bool keepSeparators) {
  static const char* hex = "0123456789ABCDEF";
  String out;
  for (size_t i = 0; i < value.length(); i++) {
    uint8_t c = value[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || (keepSeparators && (c == '=' || c == '&'))) {
      out += (char)c;
    } else {
      out += '%';
      out += hex[c >> 4];
      out += hex[c & 15];
    }
  }
  return out;
}

String KoduDB::encode(const String& value) { return percentEncode(value, false); }
String KoduDB::encodeQuery(const String& query) { return percentEncode(query, true); }

bool KoduDB::request(const char* method, const String& path, const String& query, const String* body,
                     JsonDocument* out, const char* prefer, bool auth) {
  if (auth) refreshIfNeeded();
  _status = 0;
  _error = "";
  if (_tls && !_ca && !_insecure) {
    _error = "HTTPS needs setCACert() (or setInsecure() for development)";
    return false;
  }
  String url = _url + path + (query.length() ? "?" + query : "");
  HTTPClient http;
  http.setTimeout(_timeout);
  http.setReuse(false);
#if defined(ESP32)
  WiFiClientSecure secure;
  WiFiClient plain;
  if (_tls) {
    if (_insecure) secure.setInsecure(); else secure.setCACert(_ca);
    if (!http.begin(secure, url)) { _error = "bad URL"; return false; }
  } else if (!http.begin(plain, url)) { _error = "bad URL"; return false; }
#else
  BearSSL::WiFiClientSecure secure;
  WiFiClient plain;
  BearSSL::X509List* anchors = nullptr;
  if (_tls) {
    if (_insecure) {
      secure.setInsecure();
    } else {
      anchors = new BearSSL::X509List(_ca);
      secure.setTrustAnchors(anchors);
    }
    if (!http.begin(secure, url)) { delete anchors; _error = "bad URL"; return false; }
  } else if (!http.begin(plain, url)) { _error = "bad URL"; return false; }
#endif
  http.addHeader("apikey", _apiKey);
  http.addHeader("Accept", "application/json");
  http.addHeader("User-Agent", "kodudb-arduino/" KODUDB_VERSION);
  if (auth && _access.length()) http.addHeader("Authorization", "Bearer " + _access);
  if (prefer) http.addHeader("Prefer", prefer);
  if (body) http.addHeader("Content-Type", "application/json");
  _status = http.sendRequest(method, body ? (uint8_t*)body->c_str() : (uint8_t*)nullptr, body ? body->length() : 0);
  bool ok = _status >= 200 && _status < 300;
  if (_status <= 0) {
    _error = http.errorToString(_status);
    _status = 0;
  } else {
    String payload = http.getString();
    if (!ok) {
      JsonDocument err;
      _error = deserializeJson(err, payload) == DeserializationError::Ok && err["error"].is<const char*>()
                   ? String((const char*)err["error"]) : payload;
    } else if (out && payload.length()) {
      DeserializationError e = deserializeJson(*out, payload);
      if (e) { _error = String("JSON: ") + e.c_str(); ok = false; }
    }
  }
  http.end();
#if defined(ESP8266)
  delete anchors;
#endif
  return ok;
}

bool KoduDB::storeSession(JsonDocument& doc) {
  if (!doc["access_token"].is<const char*>()) {
    _error = "this user needs a two-factor code; devices should use users without two-factor";
    return false;
  }
  _access = (const char*)doc["access_token"];
  _refresh = (const char*)doc["refresh_token"];
  uint32_t ttl = doc["expires_in"] | 3600;
  _expiresAtMs = millis() + (ttl > 120 ? ttl - 120 : ttl) * 1000UL;  // refresh two minutes early
  return true;
}

bool KoduDB::signIn(const String& email, const String& password) {
  JsonDocument req, res;
  req["email"] = email;
  req["password"] = password;
  String body;
  serializeJson(req, body);
  return request("POST", "/auth/v1/token", "grant_type=password", &body, &res, nullptr, false) && storeSession(res);
}

bool KoduDB::refresh() {
  if (!_refresh.length()) { _error = "not signed in"; return false; }
  JsonDocument req, res;
  req["refresh_token"] = _refresh;
  String body;
  serializeJson(req, body);
  return request("POST", "/auth/v1/token", "grant_type=refresh_token", &body, &res, nullptr, false) && storeSession(res);
}

void KoduDB::refreshIfNeeded() {
  if (_refresh.length() && (int32_t)(millis() - _expiresAtMs) >= 0) refresh();
}

bool KoduDB::insert(const char* table, JsonVariantConst rows, JsonDocument* out) {
  String body;
  serializeJson(rows, body);
  return request("POST", String("/rest/v1/") + table, "", &body, out);
}

bool KoduDB::upsert(const char* table, JsonVariantConst rows, const char* onConflict, JsonDocument* out) {
  String body;
  serializeJson(rows, body);
  return request("POST", String("/rest/v1/") + table, "on_conflict=" + encode(onConflict), &body, out,
                 "resolution=merge-duplicates");
}

bool KoduDB::select(const char* table, const String& filters, JsonDocument& out, const char* columns) {
  String q = "select=" + encode(columns);
  if (filters.length()) q += "&" + encodeQuery(filters);
  return request("GET", String("/rest/v1/") + table, q, nullptr, &out);
}

bool KoduDB::update(const char* table, JsonVariantConst values, const String& filters, JsonDocument* out) {
  if (!filters.length()) { _error = "update needs filters"; return false; }  // never update every row by accident
  String body;
  serializeJson(values, body);
  return request("PATCH", String("/rest/v1/") + table, encodeQuery(filters), &body, out);
}

bool KoduDB::remove(const char* table, const String& filters) {
  if (!filters.length()) { _error = "remove needs filters"; return false; }
  return request("DELETE", String("/rest/v1/") + table, encodeQuery(filters), nullptr, nullptr);
}

bool KoduDB::rpc(const char* function, JsonVariantConst args, JsonDocument* out) {
  String body;
  if (args.isNull()) body = "{}"; else serializeJson(args, body);
  return request("POST", String("/rest/v1/rpc/") + function, "", &body, out);
}

// ---------- realtime ----------

void KoduDB::subscribe(const char* table, ChangeHandler handler) {
  if (_subCount < sizeof(_subs) / sizeof(_subs[0])) _subs[_subCount++] = {String(table), handler};
  if (_wsConnected) {
    String msg = String("{\"type\":\"subscribe\",\"table\":\"") + table + "\"}";
    _ws.sendTXT(msg);
  }
}

void KoduDB::connectRealtime() {
  refreshIfNeeded();
  _wsToken = _access;
  String path = _base + "/realtime/v1/websocket?apikey=" + encode(_apiKey);
  if (_access.length()) path += "&token=" + encode(_access);
  if (_tls) {
    if (_insecure) {
      _ws.beginSSL(_host.c_str(), _port, path.c_str());
    } else {
      _ws.beginSslWithCA(_host.c_str(), _port, path.c_str(), _ca);
    }
  } else {
    _ws.begin(_host.c_str(), _port, path.c_str());
  }
  _ws.onEvent([this](WStype_t type, uint8_t* payload, size_t length) { onSocket(type, payload, length); });
  _ws.setReconnectInterval(5000);
  _ws.enableHeartbeat(25000, 5000, 2);  // ping every 25 s; drop and reconnect after two missed pongs
  _wsStarted = true;
}

void KoduDB::loop() {
  if (!_subCount) return;
  if (!_wsStarted) {
    if (_tls && !_ca && !_insecure) return;
    connectRealtime();
  }
  // A refreshed token takes effect on the next connection: reconnect so the server sees the current user.
  if (_wsConnected && _wsToken != _access) _ws.disconnect();
  _ws.loop();
}

void KoduDB::onSocket(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      _wsConnected = true;
      for (uint8_t i = 0; i < _subCount; i++) {
        String msg = "{\"type\":\"subscribe\",\"table\":\"" + _subs[i].table + "\"}";
        _ws.sendTXT(msg);
      }
      break;
    case WStype_DISCONNECTED:
      _wsConnected = false;
      if (_wsToken != _access) {  // reconnect with the new token
        _wsStarted = false;
      }
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;
      if (!doc["record"].is<JsonObjectConst>()) return;  // subscribe acknowledgements
      KoduDBChange change{doc["table"] | "", doc["type"] | "", doc["record"].as<JsonObjectConst>(),
                          doc["old_record"].as<JsonObjectConst>()};
      for (uint8_t i = 0; i < _subCount; i++) {
        if (_subs[i].table == "*" || _subs[i].table == change.table) _subs[i].handler(change);
      }
      break;
    }
    default:
      break;
  }
}
