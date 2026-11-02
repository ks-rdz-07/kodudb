# MicroPython smoke test (runs the same kodudb.py the boards use) against a running stack.
#   micropython smoke_micropython.py <api url> <public key> <email> <password> <table>
import sys
import time

from kodudb import MICROPYTHON, KoduDB, parse_url, quote

url, key, email, password, table = sys.argv[1:6]
assert MICROPYTHON, "run this with MicroPython"
assert quote("eq.a b") == "eq.a%20b"
assert parse_url("http://h:1/p/x") == (False, "h", 1, "/p/x")

db = KoduDB(url, key)
db.sign_in(email, password)
row = db.insert(table, {"device": "pico-1", "celsius": 20})[0]
assert row["device"] == "pico-1", row
assert len(db.select(table, {"device": "eq.pico-1"})) == 1

events = []
db.realtime.subscribe(table, events.append)
db.realtime.poll(1)
assert db.realtime.conn is not None, "realtime connected"
db.update(table, {"celsius": 21}, {"device": "eq.pico-1"})
deadline = time.time() + 10
while time.time() < deadline and not events:
    db.realtime.poll(0.5)
assert events and events[0]["type"] == "UPDATE", events
db.delete(table, {"device": "eq.pico-1"})
db.realtime.close()
print("micropython smoke ok:", len(events), "event(s)")
