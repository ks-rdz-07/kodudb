"""Raspberry Pi Pico W / ESP32 with MicroPython: switch a relay the moment a command row is inserted, then mark
the command done. Copy kodudb.py and this file to the board (mpremote cp kodudb.py pico_relay.py :) and run it.
Tables: see sdk/embedded/README.md (commands).
"""
import time

import network
from machine import Pin

from kodudb import KoduDB, KoduDBError

WIFI_SSID, WIFI_PASSWORD = "your-wifi", "your-wifi-password"
API_URL = "https://api.example.com"
PUBLIC_KEY = "your-project-public-key"
EMAIL, PASSWORD = "relay-3@example.com", "device-password"
# PEM root certificate of your API's TLS certificate; MicroPython only verifies the server when this is set.
ROOT_CA = """-----BEGIN CERTIFICATE-----
...paste the PEM here...
-----END CERTIFICATE-----"""

relay = Pin(15, Pin.OUT)
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(WIFI_SSID, WIFI_PASSWORD)
while not wlan.isconnected():
    time.sleep(0.25)

db = KoduDB(API_URL, PUBLIC_KEY, ca_data=ROOT_CA)
db.sign_in(EMAIL, PASSWORD)
pending = []


def on_command(event):
    record = event["record"]
    if event["type"] == "INSERT" and not record.get("done"):
        relay.value(1 if record["relay"] else 0)
        pending.append(record["id"])  # acknowledge outside the handler


db.realtime.subscribe("commands", on_command)
while True:
    db.realtime.poll(1.0)
    while pending:
        try:
            db.update("commands", {"done": True}, {"id": "eq.%s" % pending[0]})
            pending.pop(0)
        except KoduDBError:
            break  # retry on the next pass
