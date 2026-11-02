// Copy-ready code for the SDKs page: three scenarios in the five most used languages plus the device SDKs.
// Every sample uses the real KoduDB endpoints; `api` and `key` are the current project's address and public key.

export const LANGUAGES = [
  { id: 'js', label: 'JavaScript / TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'arduino', label: 'ESP32 (Arduino)' },
  { id: 'micropython', label: 'MicroPython' },
] as const
export type Lang = (typeof LANGUAGES)[number]['id']

export const SCENARIOS = [
  { id: 'auth', label: 'Authentication', about: 'Sign a user (or device) in, then call the API as that user. Row security decides what they can read and write.' },
  { id: 'devices', label: 'Devices (live)', about: 'Send a sensor reading, and receive commands the moment they are inserted over the realtime WebSocket.' },
  { id: 'stats', label: 'Statistics', about: 'Query recent readings with filters, sorting and paging, and call a Postgres function for aggregates.' },
] as const
export type Scenario = (typeof SCENARIOS)[number]['id']

export const SETUP_SQL = `-- Run once in the Query console. Each device signs in as its own user.
create table readings (
  id bigint generated always as identity primary key,
  device text not null,
  celsius numeric not null,
  owner uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create table commands (
  id bigint generated always as identity primary key,
  device text not null,
  relay boolean not null,
  done boolean not null default false,
  owner uuid not null default auth.uid()
);
alter table readings enable row level security;
alter table commands enable row level security;
create policy "own readings" on readings for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own commands" on commands for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create trigger kodudb_realtime after insert or update or delete on commands
  for each row execute function realtime.broadcast_change();

-- Statistics per device for the signed-in user (row security applies inside the function).
create function device_stats(since timestamptz default now() - interval '24 hours')
returns table (device text, readings bigint, avg_celsius numeric, max_celsius numeric)
language sql stable as $$
  select device, count(*), round(avg(celsius), 2), max(celsius)
  from readings where created_at >= since group by device order by device
$$;`

export function sample(scenario: Scenario, lang: Lang, api: string, key: string): string {
  const ws = api.replace(/^http/, 'ws')
  const s: Record<Scenario, Record<Lang, string>> = {
    auth: {
      js: `const API = '${api}'
const KEY = '${key}'

// Sign in (create users with POST /auth/v1/signup, or in Identity)
const res = await fetch(\`\${API}/auth/v1/token?grant_type=password\`, {
  method: 'POST',
  headers: { apikey: KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'device-17@example.com', password: 'device-password' }),
})
const session = await res.json()          // { access_token, refresh_token, expires_in, user }

// Call the API as that user
const me = await fetch(\`\${API}/auth/v1/user\`, {
  headers: { apikey: KEY, authorization: \`Bearer \${session.access_token}\` },
}).then((r) => r.json())
console.log(me.email)

// Refresh before the access token expires (expires_in seconds)
const renewed = await fetch(\`\${API}/auth/v1/token?grant_type=refresh_token\`, {
  method: 'POST',
  headers: { apikey: KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ refresh_token: session.refresh_token }),
}).then((r) => r.json())`,
      python: `import requests

API = "${api}"
KEY = "${key}"

session = requests.post(f"{API}/auth/v1/token", params={"grant_type": "password"},
                        headers={"apikey": KEY},
                        json={"email": "device-17@example.com", "password": "device-password"}).json()

auth = {"apikey": KEY, "Authorization": f"Bearer {session['access_token']}"}
me = requests.get(f"{API}/auth/v1/user", headers=auth).json()
print(me["email"])

# Refresh before the access token expires (expires_in seconds)
session = requests.post(f"{API}/auth/v1/token", params={"grant_type": "refresh_token"},
                        headers={"apikey": KEY}, json={"refresh_token": session["refresh_token"]}).json()`,
      java: `import java.net.URI;
import java.net.http.*;

public class Auth {
  static final String API = "${api}";
  static final String KEY = "${key}";

  public static void main(String[] args) throws Exception {
    var http = HttpClient.newHttpClient();
    var signIn = HttpRequest.newBuilder(URI.create(API + "/auth/v1/token?grant_type=password"))
        .header("apikey", KEY).header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(
            "{\\"email\\":\\"device-17@example.com\\",\\"password\\":\\"device-password\\"}"))
        .build();
    String session = http.send(signIn, HttpResponse.BodyHandlers.ofString()).body();
    String token = session.replaceAll(".*\\"access_token\\":\\"([^\\"]+)\\".*", "$1"); // use a JSON library in real code

    var me = HttpRequest.newBuilder(URI.create(API + "/auth/v1/user"))
        .header("apikey", KEY).header("authorization", "Bearer " + token).build();
    System.out.println(http.send(me, HttpResponse.BodyHandlers.ofString()).body());
  }
}`,
      csharp: `using System.Net.Http.Json;

const string Api = "${api}";
const string Key = "${key}";

var http = new HttpClient();
http.DefaultRequestHeaders.Add("apikey", Key);

var res = await http.PostAsJsonAsync($"{Api}/auth/v1/token?grant_type=password",
    new { email = "device-17@example.com", password = "device-password" });
var session = await res.Content.ReadFromJsonAsync<Session>();

http.DefaultRequestHeaders.Authorization = new("Bearer", session!.access_token);
Console.WriteLine(await http.GetStringAsync($"{Api}/auth/v1/user"));

record Session(string access_token, string refresh_token, int expires_in);`,
      go: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const api = "${api}"
const key = "${key}"

func main() {
	body, _ := json.Marshal(map[string]string{"email": "device-17@example.com", "password": "device-password"})
	req, _ := http.NewRequest("POST", api+"/auth/v1/token?grant_type=password", bytes.NewReader(body))
	req.Header.Set("apikey", key)
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	var session struct {
		AccessToken  string \`json:"access_token"\`
		RefreshToken string \`json:"refresh_token"\`
	}
	json.NewDecoder(res.Body).Decode(&session)

	me, _ := http.NewRequest("GET", api+"/auth/v1/user", nil)
	me.Header.Set("apikey", key)
	me.Header.Set("authorization", "Bearer "+session.AccessToken)
	r, _ := http.DefaultClient.Do(me)
	out, _ := io.ReadAll(r.Body)
	fmt.Println(string(out))
}`,
      arduino: `#include <KoduDB.h>   // sdk/embedded/arduino/KoduDB

KoduDB db;

void setup() {
  Serial.begin(115200);
  WiFi.begin("your-wifi", "your-wifi-password");
  while (WiFi.status() != WL_CONNECTED) delay(250);

  db.begin("${api}", "${key}");
  db.setCACert(ROOT_CA);                 // PEM root certificate of your API (required for HTTPS)
  if (db.signIn("device-17@example.com", "device-password")) {
    Serial.println("signed in; tokens refresh automatically");
  } else {
    Serial.printf("sign-in failed (%d): %s\\n", db.lastStatus(), db.lastError().c_str());
  }
}

void loop() {}`,
      micropython: `# Copy sdk/embedded/python/kodudb.py to the board first (mpremote cp kodudb.py :)
from kodudb import KoduDB

db = KoduDB("${api}", "${key}", ca_data=ROOT_CA)   # PEM root certificate (required for HTTPS)
db.sign_in("device-17@example.com", "device-password")
print("signed in; the access token refreshes automatically")`,
    },
    devices: {
      js: `const API = '${api}'
const KEY = '${key}'
const token = session.access_token        // from the Authentication sample
const headers = { apikey: KEY, authorization: \`Bearer \${token}\`, 'content-type': 'application/json' }

// Send a reading (returns the inserted row)
await fetch(\`\${API}/rest/v1/readings\`, {
  method: 'POST', headers, body: JSON.stringify({ device: 'sensor-17', celsius: 21.5 }),
})

// Receive commands live
const socket = new WebSocket(\`${ws}/realtime/v1/websocket?apikey=\${KEY}&token=\${token}\`)
socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', table: 'commands' }))
socket.onmessage = async (msg) => {
  const event = JSON.parse(msg.data)       // { type: 'INSERT' | 'UPDATE' | 'DELETE', table, record, old_record }
  if (event.type !== 'INSERT') return
  console.log('switch relay', event.record.relay)
  await fetch(\`\${API}/rest/v1/commands?id=eq.\${event.record.id}\`, {
    method: 'PATCH', headers, body: JSON.stringify({ done: true }),
  })
}`,
      python: `# Raspberry Pi: the device SDK handles sign-in, refresh, reconnects and pings.
# Copy sdk/embedded/python/kodudb.py next to this file (standard library only).
from kodudb import KoduDB

db = KoduDB("${api}", "${key}")
db.sign_in("device-17@example.com", "device-password")

db.insert("readings", {"device": "sensor-17", "celsius": 21.5})

def on_command(event):          # {"type": "INSERT", "table": "commands", "record": {...}}
    if event["type"] == "INSERT":
        print("switch relay", event["record"]["relay"])
        db.update("commands", {"done": True}, {"id": f"eq.{event['record']['id']}"})

db.realtime.subscribe("commands", on_command)
while True:
    db.realtime.poll(1.0)`,
      java: `import java.net.URI;
import java.net.http.*;
import java.util.concurrent.CompletionStage;

public class Devices {
  static final String API = "${api}";
  static final String KEY = "${key}";

  public static void main(String[] args) throws Exception {
    String token = args[0];               // access_token from the Authentication sample
    var http = HttpClient.newHttpClient();

    var insert = HttpRequest.newBuilder(URI.create(API + "/rest/v1/readings"))
        .header("apikey", KEY).header("authorization", "Bearer " + token)
        .header("content-type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString("{\\"device\\":\\"sensor-17\\",\\"celsius\\":21.5}"))
        .build();
    System.out.println(http.send(insert, HttpResponse.BodyHandlers.ofString()).body());

    http.newWebSocketBuilder().buildAsync(
        URI.create("${ws}/realtime/v1/websocket?apikey=" + KEY + "&token=" + token),
        new WebSocket.Listener() {
          public void onOpen(WebSocket ws) {
            ws.sendText("{\\"type\\":\\"subscribe\\",\\"table\\":\\"commands\\"}", true);
            WebSocket.Listener.super.onOpen(ws);
          }
          public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            System.out.println("event: " + data); // { type, table, record, old_record }
            return WebSocket.Listener.super.onText(ws, data, last);
          }
        }).join();
    Thread.currentThread().join();
  }
}`,
      csharp: `using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;

const string Api = "${api}";
const string Key = "${key}";
var token = args[0];                       // access_token from the Authentication sample

var http = new HttpClient();
http.DefaultRequestHeaders.Add("apikey", Key);
http.DefaultRequestHeaders.Authorization = new("Bearer", token);
await http.PostAsJsonAsync($"{Api}/rest/v1/readings", new { device = "sensor-17", celsius = 21.5 });

var ws = new ClientWebSocket();
await ws.ConnectAsync(new Uri($"${ws}/realtime/v1/websocket?apikey={Key}&token={token}"), default);
await ws.SendAsync(Encoding.UTF8.GetBytes("""{"type":"subscribe","table":"commands"}"""),
    WebSocketMessageType.Text, true, default);
var buffer = new byte[16384];
while (ws.State == WebSocketState.Open) {
    var r = await ws.ReceiveAsync(buffer, default);
    Console.WriteLine(Encoding.UTF8.GetString(buffer, 0, r.Count)); // { type, table, record, old_record }
}`,
      go: `package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/coder/websocket"
)

const api = "${api}"
const key = "${key}"

func main() {
	token := os.Args[1] // access_token from the Authentication sample

	req, _ := http.NewRequest("POST", api+"/rest/v1/readings",
		bytes.NewBufferString(\`{"device":"sensor-17","celsius":21.5}\`))
	req.Header.Set("apikey", key)
	req.Header.Set("authorization", "Bearer "+token)
	req.Header.Set("content-type", "application/json")
	if _, err := http.DefaultClient.Do(req); err != nil {
		panic(err)
	}

	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, "${ws}/realtime/v1/websocket?apikey="+key+"&token="+token, nil)
	if err != nil {
		panic(err)
	}
	c.Write(ctx, websocket.MessageText, []byte(\`{"type":"subscribe","table":"commands"}\`))
	for {
		_, msg, err := c.Read(ctx)
		if err != nil {
			panic(err)
		}
		fmt.Println("event:", string(msg)) // { type, table, record, old_record }
	}
}`,
      arduino: `#include <KoduDB.h>

KoduDB db;
volatile long doneId = -1;

void setup() {
  Serial.begin(115200);
  WiFi.begin("your-wifi", "your-wifi-password");
  while (WiFi.status() != WL_CONNECTED) delay(250);
  db.begin("${api}", "${key}");
  db.setCACert(ROOT_CA);
  db.signIn("device-17@example.com", "device-password");

  db.subscribe("commands", [](const KoduDBChange& c) {
    if (strcmp(c.type, "INSERT") != 0) return;
    digitalWrite(2, c.record["relay"] ? HIGH : LOW);
    doneId = c.record["id"] | -1L;
  });
}

uint32_t last = 0;
void loop() {
  db.loop();                               // keeps the realtime connection alive
  if (millis() - last > 10000) {           // a reading every 10 seconds
    last = millis();
    JsonDocument row;
    row["device"] = "sensor-17";
    row["celsius"] = 21.5;
    db.insert("readings", row);
  }
  if (doneId >= 0) {
    JsonDocument done;
    done["done"] = true;
    db.update("commands", done, "id=eq." + String(doneId));
    doneId = -1;
  }
}`,
      micropython: `from kodudb import KoduDB
from machine import Pin

relay = Pin(15, Pin.OUT)
db = KoduDB("${api}", "${key}", ca_data=ROOT_CA)
db.sign_in("device-17@example.com", "device-password")

db.insert("readings", {"device": "sensor-17", "celsius": 21.5})

def on_command(event):
    if event["type"] == "INSERT":
        relay.value(1 if event["record"]["relay"] else 0)

db.realtime.subscribe("commands", on_command)
while True:
    db.realtime.poll(1.0)`,
    },
    stats: {
      js: `const API = '${api}'
const headers = { apikey: '${key}', authorization: \`Bearer \${session.access_token}\` }

// Last 100 readings of one device, newest first, with the total count
const since = new Date(Date.now() - 24 * 3600e3).toISOString()
const res = await fetch(
  \`\${API}/rest/v1/readings?device=eq.sensor-17&created_at=gte.\${since}&order=created_at.desc&limit=100\`,
  { headers: { ...headers, prefer: 'count=exact' } },
)
const rows = await res.json()
console.log(res.headers.get('x-total-count'), 'readings')

// Readings above 30 °C on any of two devices (or= matches any filter)
await fetch(\`\${API}/rest/v1/readings?celsius=gt.30&or=(device.eq.sensor-17,device.eq.sensor-18)\`, { headers })

// Aggregates from the device_stats function (see Setup SQL)
const stats = await fetch(\`\${API}/rest/v1/rpc/device_stats\`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
}).then((r) => r.json())          // [{ device, readings, avg_celsius, max_celsius }]`,
      python: `import requests
from datetime import datetime, timedelta, timezone

API = "${api}"
auth = {"apikey": "${key}", "Authorization": f"Bearer {session['access_token']}"}

since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
res = requests.get(f"{API}/rest/v1/readings", headers={**auth, "Prefer": "count=exact"},
                   params={"device": "eq.sensor-17", "created_at": f"gte.{since}",
                           "order": "created_at.desc", "limit": 100})
print(res.headers["x-total-count"], "readings")

stats = requests.post(f"{API}/rest/v1/rpc/device_stats", headers=auth, json={}).json()
for s in stats:
    print(s["device"], s["readings"], s["avg_celsius"], s["max_celsius"])`,
      java: `var http = HttpClient.newHttpClient();
var recent = HttpRequest.newBuilder(URI.create(
        API + "/rest/v1/readings?device=eq.sensor-17&order=created_at.desc&limit=100"))
    .header("apikey", KEY).header("authorization", "Bearer " + token)
    .header("prefer", "count=exact").build();
var res = http.send(recent, HttpResponse.BodyHandlers.ofString());
System.out.println(res.headers().firstValue("x-total-count").orElse("?") + " readings");

var stats = HttpRequest.newBuilder(URI.create(API + "/rest/v1/rpc/device_stats"))
    .header("apikey", KEY).header("authorization", "Bearer " + token)
    .header("content-type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString("{}")).build();
System.out.println(http.send(stats, HttpResponse.BodyHandlers.ofString()).body());`,
      csharp: `var recent = await http.GetAsync($"{Api}/rest/v1/readings?device=eq.sensor-17&order=created_at.desc&limit=100");
var rows = await recent.Content.ReadFromJsonAsync<List<Reading>>();

var res = await http.PostAsJsonAsync($"{Api}/rest/v1/rpc/device_stats", new { });
foreach (var s in (await res.Content.ReadFromJsonAsync<List<DeviceStats>>())!)
    Console.WriteLine($"{s.device}: {s.readings} readings, avg {s.avg_celsius} °C");

record Reading(long id, string device, decimal celsius, DateTime created_at);
record DeviceStats(string device, long readings, decimal avg_celsius, decimal max_celsius);`,
      go: `req, _ := http.NewRequest("GET", api+"/rest/v1/readings?device=eq.sensor-17&order=created_at.desc&limit=100", nil)
req.Header.Set("apikey", key)
req.Header.Set("authorization", "Bearer "+token)
req.Header.Set("prefer", "count=exact")
res, _ := http.DefaultClient.Do(req)
fmt.Println(res.Header.Get("x-total-count"), "readings")

stats, _ := http.NewRequest("POST", api+"/rest/v1/rpc/device_stats", bytes.NewBufferString("{}"))
stats.Header.Set("apikey", key)
stats.Header.Set("authorization", "Bearer "+token)
stats.Header.Set("content-type", "application/json")
r, _ := http.DefaultClient.Do(stats)
var out []struct {
	Device     string  \`json:"device"\`
	Readings   int64   \`json:"readings"\`
	AvgCelsius float64 \`json:"avg_celsius,string"\`
}
json.NewDecoder(r.Body).Decode(&out)`,
      arduino: `// Latest 10 readings of this device, then the per-device statistics
JsonDocument rows;
if (db.select("readings", "device=eq.sensor-17&order=created_at.desc&limit=10", rows)) {
  for (JsonObject r : rows.as<JsonArray>()) {
    Serial.printf("%s °C\\n", r["celsius"].as<const char*>());
  }
}

JsonDocument stats;
if (db.rpc("device_stats", JsonVariantConst(), &stats)) {
  serializeJsonPretty(stats, Serial);
}`,
      micropython: `rows = db.select("readings", {"device": "eq.sensor-17"}, order="created_at.desc", limit=10)
for r in rows:
    print(r["created_at"], r["celsius"])

for s in db.rpc("device_stats"):
    print(s["device"], s["readings"], s["avg_celsius"])`,
    },
  }
  return s[scenario][lang]
}
