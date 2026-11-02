// Switches a relay the moment a command row is inserted, then marks the command done.
// Table: create table commands (id bigint generated always as identity primary key, device text not null,
//   relay boolean not null, done boolean not null default false, owner uuid not null default auth.uid());
//   alter table commands enable row level security;
//   create policy "own commands" on commands for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
//   create trigger kodudb_realtime after insert or update or delete on commands
//     for each row execute function realtime.broadcast_change();   -- or switch on live events in the console
#include <KoduDB.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASSWORD = "your-wifi-password";
const char* API_URL = "https://api.example.com";
const char* PUBLIC_KEY = "your-project-public-key";
const char* DEVICE_EMAIL = "relay-3@example.com";
const char* DEVICE_PASSWORD = "device-password";
const char* ROOT_CA = R"(-----BEGIN CERTIFICATE-----
...paste the PEM here...
-----END CERTIFICATE-----)";
const int RELAY_PIN = 2;

KoduDB db;
volatile long pendingDone = -1;  // set in the realtime handler, handled in loop() (no HTTP inside the handler)

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(250);
  db.begin(API_URL, PUBLIC_KEY);
  db.setCACert(ROOT_CA);
  db.signIn(DEVICE_EMAIL, DEVICE_PASSWORD);

  db.subscribe("commands", [](const KoduDBChange& c) {
    if (strcmp(c.type, "INSERT") != 0 || c.record["done"] == true) return;
    digitalWrite(RELAY_PIN, c.record["relay"] ? HIGH : LOW);
    pendingDone = c.record["id"] | -1L;
    Serial.printf("relay %s (command %ld)\n", c.record["relay"] ? "on" : "off", pendingDone);
  });
}

void loop() {
  db.loop();  // realtime: keeps the connection alive, reconnects and delivers changes
  if (pendingDone >= 0) {
    JsonDocument done;
    done["done"] = true;
    db.update("commands", done, "id=eq." + String(pendingDone));
    pendingDone = -1;
  }
}
