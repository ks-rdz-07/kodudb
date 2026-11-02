"""End-to-end tests for the device client against a running KoduDB stack (CPython).
    python sdk/embedded/python/test_kodudb.py          (reads PUBLIC_KEY and SECRET_KEY from the repository's .env)
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kodudb import KoduDB, KoduDBError, parse_url, quote  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ENV = {}
with open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
    for line in f:
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            ENV[k.strip()] = v.strip()
API = os.environ.get("KODUDB_URL", "http://127.0.0.1:8787")
RUN = str(int(time.time() * 1000))
TABLE = "device_readings_" + RUN
PASSWORD = "device-password-" + RUN


def sql(service, query):
    return service.request("POST", "/meta/v1/query", {"query": query})


class Helpers(unittest.TestCase):
    def test_quote_and_url(self):
        self.assertEqual(quote("eq.a b&c/é"), "eq.a%20b%26c%2F%C3%A9")
        self.assertEqual(parse_url("https://api.example.com/p/shop"), (True, "api.example.com", 443, "/p/shop"))
        self.assertEqual(parse_url("http://10.0.0.5:8787"), (False, "10.0.0.5", 8787, ""))
        with self.assertRaises(ValueError):
            parse_url("ftp://x")


class Device(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = KoduDB(API, ENV["SECRET_KEY"])  # admin key, test setup only
        sql(cls.service, f"""
            create table public.{TABLE} (id bigint generated always as identity primary key, device text not null unique,
              celsius numeric not null, owner uuid not null default auth.uid(), created_at timestamptz default now());
            alter table public.{TABLE} enable row level security;
            create policy own on public.{TABLE} for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
            create trigger kodudb_realtime after insert or update or delete on public.{TABLE}
              for each row execute function realtime.broadcast_change();
            create function public.record_{TABLE}(d text, c numeric) returns bigint language sql as $$
              insert into public.{TABLE} (device, celsius) values (d, c) returning id $$;""")
        anon = KoduDB(API, ENV["PUBLIC_KEY"])
        for who in ("a", "b"):
            anon.request("POST", "/auth/v1/signup", {"email": f"device-{who}-{RUN}@example.com", "password": PASSWORD}, auth=False)
        cls.a = KoduDB(API, ENV["PUBLIC_KEY"])
        cls.a.sign_in(f"device-a-{RUN}@example.com", PASSWORD)
        cls.b = KoduDB(API, ENV["PUBLIC_KEY"])
        cls.b.sign_in(f"device-b-{RUN}@example.com", PASSWORD)

    @classmethod
    def tearDownClass(cls):
        sql(cls.service, f"drop table if exists public.{TABLE} cascade; drop function if exists public.record_{TABLE}")

    def test_1_crud(self):
        row = self.a.insert(TABLE, {"device": "sensor-1", "celsius": 21.5})[0]
        self.assertEqual(row["device"], "sensor-1")
        many = self.a.insert(TABLE, [{"device": "sensor-2", "celsius": 1}, {"device": "sensor-3", "celsius": 2}])
        self.assertEqual(len(many), 2)
        rows = self.a.select(TABLE, {"celsius": "gte.1"}, select="device,celsius", order="device")
        self.assertEqual([r["device"] for r in rows], ["sensor-1", "sensor-2", "sensor-3"])
        self.assertEqual(self.b.select(TABLE), [], "row security: another device sees nothing")
        self.a.update(TABLE, {"celsius": 22}, {"device": "eq.sensor-1"})
        self.assertEqual(float(self.a.select(TABLE, {"device": "eq.sensor-1"})[0]["celsius"]), 22)
        up = self.a.upsert(TABLE, {"device": "sensor-1", "celsius": 30}, on_conflict="device")
        self.assertEqual(float(up[0]["celsius"]), 30)
        self.a.delete(TABLE, {"device": "in.(sensor-2,sensor-3)"})
        self.assertEqual(len(self.a.select(TABLE)), 1)
        with self.assertRaises(ValueError):
            self.a.update(TABLE, {"celsius": 0}, {})

    def test_2_rpc_is_one_transaction(self):
        new_id = self.a.rpc(f"record_{TABLE}", {"d": "sensor-rpc", "c": 5})
        self.assertIsInstance(new_id, int)
        with self.assertRaises(KoduDBError) as e:  # duplicate device: the function's insert rolls back
            self.a.rpc(f"record_{TABLE}", {"d": "sensor-rpc", "c": 6})
        self.assertEqual(e.exception.status, 409)
        self.assertEqual(len(self.a.select(TABLE, {"device": "eq.sensor-rpc"})), 1)

    def test_3_errors(self):
        with self.assertRaises(KoduDBError) as e:
            self.a.select("no_such_table_" + RUN)
        self.assertIn(e.exception.status, (400, 404))
        with self.assertRaises(KoduDBError) as e:
            KoduDB(API, ENV["PUBLIC_KEY"]).sign_in(f"device-a-{RUN}@example.com", "wrong-password")
        self.assertEqual(e.exception.status, 400)
        with self.assertRaises(KoduDBError) as e:
            KoduDB("http://127.0.0.1:1", ENV["PUBLIC_KEY"], timeout=2).select(TABLE)
        self.assertEqual(e.exception.status, 0)

    def test_4_refresh(self):
        old = self.a.session["access_token"]
        time.sleep(1.1)  # tokens carry a whole-second issue time
        self.a.refresh()
        self.assertNotEqual(self.a.session["access_token"], old)
        self.assertIsInstance(self.a.select(TABLE), list)
        self.a._expires_at = 0  # an expired token is refreshed before the next request
        self.a.select(TABLE)
        self.assertGreater(self.a._expires_at, time.time())

    def test_5_realtime_respects_row_security(self):
        seen_a, seen_b = [], []
        self.a.realtime.subscribe(TABLE, seen_a.append)
        self.b.realtime.subscribe(TABLE, seen_b.append)
        self.a.realtime.poll(1)
        self.b.realtime.poll(1)
        self.assertIsNotNone(self.a.realtime.conn, "connected")
        self.a.insert(TABLE, {"device": "sensor-live", "celsius": 18})
        self.a.update(TABLE, {"celsius": 19}, {"device": "eq.sensor-live"})
        deadline = time.time() + 10
        while time.time() < deadline and len(seen_a) < 2:
            self.a.realtime.poll(0.5)
            self.b.realtime.poll(0.1)
        self.assertEqual([e["type"] for e in seen_a], ["INSERT", "UPDATE"])
        self.assertEqual(seen_a[0]["record"]["device"], "sensor-live")
        self.assertEqual(float(seen_a[1]["record"]["celsius"]), 19)
        self.assertEqual(seen_b, [], "another device's rows are not delivered")

    def test_6_realtime_reconnects(self):
        seen = []
        self.a.realtime.subscribe(TABLE, seen.append)
        self.a.realtime.poll(0.5)
        self.a.realtime.conn.close()  # simulate a dropped connection (Wi-Fi loss)
        self.a.realtime.conn.sock = None
        self.a.realtime.poll(0.5)  # notices the drop
        self.a.realtime._retry_at = 0
        self.a.realtime.poll(1)  # reconnects and resubscribes
        self.assertIsNotNone(self.a.realtime.conn)
        self.a.insert(TABLE, {"device": "sensor-after-drop", "celsius": 1})
        deadline = time.time() + 10
        while time.time() < deadline and not any(e["record"].get("device") == "sensor-after-drop" for e in seen):
            self.a.realtime.poll(0.5)
        self.assertTrue(any(e["record"].get("device") == "sensor-after-drop" for e in seen))
        self.a.realtime.close()
        self.b.realtime.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
