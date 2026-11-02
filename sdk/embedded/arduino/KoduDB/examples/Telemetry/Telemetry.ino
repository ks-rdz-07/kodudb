// Sends a sensor reading to KoduDB every 10 seconds.
// Table: create table readings (id bigint generated always as identity primary key, device text not null,
//   celsius numeric not null, owner uuid not null default auth.uid(), created_at timestamptz default now());
//   alter table readings enable row level security;
//   create policy "own readings" on readings for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
#include <KoduDB.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASSWORD = "your-wifi-password";
const char* API_URL = "https://api.example.com";
const char* PUBLIC_KEY = "your-project-public-key";
const char* DEVICE_EMAIL = "sensor-17@example.com";      // the device's own KoduDB user
const char* DEVICE_PASSWORD = "device-password";
// Root certificate of your API's TLS certificate (PEM). For Let's Encrypt, ISRG Root X1.
const char* ROOT_CA = R"(-----BEGIN CERTIFICATE-----
...paste the PEM here...
-----END CERTIFICATE-----)";

KoduDB db;
uint32_t lastSend = 0;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  db.begin(API_URL, PUBLIC_KEY);
  db.setCACert(ROOT_CA);
  if (!db.signIn(DEVICE_EMAIL, DEVICE_PASSWORD)) {
    Serial.printf("sign-in failed (%d): %s\n", db.lastStatus(), db.lastError().c_str());
  }
}

float readCelsius() { return 20.0 + random(0, 100) / 20.0; }  // replace with your sensor

void loop() {
  if (millis() - lastSend < 10000) return;
  lastSend = millis();
  JsonDocument row;
  row["device"] = "sensor-17";
  row["celsius"] = readCelsius();
  if (db.insert("readings", row)) {
    Serial.println("reading stored");
  } else {
    Serial.printf("insert failed (%d): %s\n", db.lastStatus(), db.lastError().c_str());
  }
}
