"""Raspberry Pi (or any Linux board): send the CPU temperature to KoduDB every 10 seconds, and print commands
for this device the moment they are inserted.

    cp sdk/embedded/python/kodudb.py .   then: python3 pi_telemetry.py
Tables: see sdk/embedded/README.md (readings, commands).
"""
import os
import socket
import time

from kodudb import KoduDB, KoduDBError

API_URL = os.environ.get("KODUDB_URL", "https://api.example.com")
PUBLIC_KEY = os.environ["KODUDB_PUBLIC_KEY"]
DEVICE = socket.gethostname()
EMAIL = os.environ["KODUDB_DEVICE_EMAIL"]          # this device's own user
PASSWORD = os.environ["KODUDB_DEVICE_PASSWORD"]


def cpu_celsius():
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        return int(f.read()) / 1000


db = KoduDB(API_URL, PUBLIC_KEY)
db.sign_in(EMAIL, PASSWORD)
db.realtime.subscribe("commands", lambda e: e["type"] == "INSERT" and print("command:", e["record"]))

next_send = 0
while True:
    if time.time() >= next_send:
        next_send = time.time() + 10
        try:
            db.insert("readings", {"device": DEVICE, "celsius": cpu_celsius()})
        except KoduDBError as e:          # keep running through network hiccups
            print("insert failed:", e)
    db.realtime.poll(1.0)
