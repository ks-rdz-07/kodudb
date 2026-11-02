# KoduDB for devices

Connect sensors, controllers and edge devices straight to KoduDB: write readings over REST, receive row changes the
moment they happen over WebSocket, and let row-level security decide what each device may read and write.

| SDK | Boards | Language |
|---|---|---|
| [`python/kodudb.py`](python/kodudb.py) | Raspberry Pi and other Linux boards (CPython 3.8+); Raspberry Pi Pico W and ESP32 (MicroPython 1.22+) | Python, one file, no dependencies |
| [`arduino/KoduDB`](arduino/KoduDB) | ESP32, ESP8266 (Arduino IDE or PlatformIO) | C++ (needs ArduinoJson 7 and WebSockets 2.6) |

Both cover the same operations:

| Operation | Python | Arduino |
|---|---|---|
| Sign in, automatic token refresh | `sign_in()`, `refresh()` | `signIn()`, `refresh()` |
| Write live data | `insert()` (one row or a batch), `upsert()` | `insert()`, `upsert()` |
| Read | `select(table, {"col": "eq.value"}, order=, limit=)` | `select(table, "col=eq.value", out)` |
| Change and delete | `update()`, `delete()` (filters required) | `update()`, `remove()` |
| Transactions | `rpc("function", args)`: a Postgres function commits or rolls back as a whole | `rpc()` |
| Realtime | `realtime.subscribe(table, handler)` + `realtime.poll()` | `subscribe(table, handler)` + `loop()` |

Realtime keeps itself alive with pings, reconnects after Wi-Fi drops, resubscribes, and uses the refreshed token.
Each device only receives rows its row security policies allow.

## Quick start

**Raspberry Pi / Linux:** copy `python/kodudb.py` next to your script. See
[`python/examples/pi_telemetry.py`](python/examples/pi_telemetry.py).

**MicroPython (Pico W, ESP32):** `mpremote cp sdk/embedded/python/kodudb.py :` then run
[`python/examples/pico_relay.py`](python/examples/pico_relay.py).

**ESP32 / ESP8266:** in PlatformIO, add the library folder and its dependencies to `platformio.ini`:

```ini
lib_deps =
  bblanchon/ArduinoJson@^7.0.0
  links2004/WebSockets@^2.6.0
  symlink:///path/to/kodudb/sdk/embedded/arduino/KoduDB
```

In the Arduino IDE, zip `arduino/KoduDB` and use Sketch → Include Library → Add .ZIP Library. Examples:
[`Telemetry`](arduino/KoduDB/examples/Telemetry/Telemetry.ino) and
[`RealtimeRelay`](arduino/KoduDB/examples/RealtimeRelay/RealtimeRelay.ino).

## Example tables

```sql
create table readings (
  id bigint generated always as identity primary key,
  device text not null,
  celsius numeric not null,
  owner uuid not null default auth.uid(),
  created_at timestamptz default now()
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
-- live events for commands (or switch them on for the table in the console)
create trigger kodudb_realtime after insert or update or delete on commands
  for each row execute function realtime.broadcast_change();
```

## Security on devices

- **One user per device.** Create a user for each device and write policies on `auth.uid()`; a stolen device only
  exposes its own rows. Disable or delete the user to cut a device off.
- **Public key only.** Never flash the secret key; it skips row security.
- **Verify TLS (1.2 or newer).** Pass the server's root certificate: `setCACert()` on Arduino and `ca_data=` on
  MicroPython. Both refuse HTTPS without it unless you opt out explicitly for development (`setInsecure()`,
  `insecure=True`). CPython verifies against the system store.
- **Two-factor** users cannot sign in from devices; use device users without it.

## Limits

- No offline buffer yet: a reading taken while the network is down is lost unless your code keeps it and retries.
- Realtime delivers table changes only; there are no broadcast messages that skip the database.
- ESP32 flash: with TLS, HTTP and WebSocket the RealtimeRelay example uses about 97% of the default 1.3 MB app
  partition. Choose a larger app partition (for example `board_build.partitions = huge_app.csv`) for bigger sketches.
- Rows are limited by the realtime payload size: rows wider than about 8 KB arrive as `{"id": ...}` with
  `truncated: true`; fetch the full row with `select()`.

## Tests

`python sdk/embedded/python/test_kodudb.py` runs the Python client against a local stack (REST, transactions,
token refresh, realtime with row security and reconnects). `smoke_micropython.py` runs the same file under
MicroPython. The Arduino examples are compiled for ESP32 and ESP8266 in CI.
