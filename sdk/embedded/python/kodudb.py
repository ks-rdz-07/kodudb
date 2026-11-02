"""KoduDB client for devices: Raspberry Pi and other Linux boards (CPython 3.8+), and MicroPython boards
(Raspberry Pi Pico W, ESP32). One file, standard library only.

    from kodudb import KoduDB
    db = KoduDB("https://api.example.com", "<public key>")
    db.sign_in("device-17@example.com", "device password")      # the device's own user; row security applies
    db.insert("readings", {"device": "device-17", "celsius": 21.5})
    rows = db.select("commands", {"device": "eq.device-17", "done": "is.false"}, order="created_at")
    db.update("commands", {"done": True}, {"id": "eq." + rows[0]["id"]})
    db.rpc("record_reading", {"device": "device-17", "celsius": 21.5})  # a Postgres function = one transaction

    def on_change(event):            # {"type": "INSERT"|"UPDATE"|"DELETE", "table": ..., "record": {...}, ...}
        print(event["type"], event["record"])
    db.realtime.subscribe("commands", on_change)
    while True:
        db.realtime.poll(1.0)        # handles pings, reconnects and token refresh; returns after the timeout
"""
import json
import sys
import time

MICROPYTHON = sys.implementation.name == "micropython"
try:  # CPython and MicroPython 1.20+ share these names
    import binascii
    import os
    import select
    import socket
    import ssl
except ImportError:  # older MicroPython firmware only has the u-prefixed modules
    import ubinascii as binascii
    import uos as os
    import uselect as select
    import usocket as socket
    import ussl as ssl

__version__ = "0.1.0"


class KoduDBError(Exception):
    """An HTTP error from KoduDB (status and message) or a connection problem (status 0)."""

    def __init__(self, status, message):
        super().__init__("%s: %s" % (status, message))
        self.status = status
        self.message = message


def quote(s):
    """Percent-encode a query value (MicroPython has no urllib)."""
    safe = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~"
    out = []
    for b in str(s).encode():
        out.append(chr(b) if b in safe else "%%%02X" % b)
    return "".join(out)


def query_string(params):
    return "&".join("%s=%s" % (quote(k), quote(v)) for k, v in params.items() if v is not None)


def parse_url(url):
    """https://host:port/base -> (tls, host, port, base_path)."""
    if url.startswith("https://"):
        tls, rest = True, url[8:]
    elif url.startswith("http://"):
        tls, rest = False, url[7:]
    else:
        raise ValueError("URL must start with http:// or https://")
    hostport, _, path = rest.partition("/")
    host, _, port = hostport.partition(":")
    return tls, host, int(port) if port else (443 if tls else 80), ("/" + path).rstrip("/")


def _now():
    return time.time()


def _tls_wrap(sock, host, ca_file, ca_data, insecure):
    """TLS 1.2 or newer; the server certificate is verified unless insecure=True was passed explicitly."""
    if MICROPYTHON:
        if not hasattr(ssl, "SSLContext"):
            raise KoduDBError(0, "this MicroPython firmware cannot verify TLS certificates; update to 1.22 or newer")
        # MicroPython's ssl has no protocol-version settings; it is built on mbedTLS 3.x, which no longer
        # implements TLS 1.0 or 1.1, so connections are always TLS 1.2 or newer.
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        if ca_data:
            ctx.load_verify_locations(cadata=ca_data)
    else:
        ctx = ssl.create_default_context(cafile=ca_file, cadata=ca_data)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if insecure:
        if hasattr(ctx, "check_hostname"):
            ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    else:
        ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx.wrap_socket(sock, server_hostname=host)


class _Conn:
    """A TCP or TLS connection with a small read buffer, the same on CPython and MicroPython."""

    def __init__(self, tls, host, port, timeout, ca_file=None, ca_data=None, insecure=False):
        if tls and MICROPYTHON and not ca_data and not insecure:
            # MicroPython has no system certificate store: without a CA it cannot verify the server.
            raise KoduDBError(0, "HTTPS on MicroPython needs ca_data (or insecure=True for development)")
        s, last_error = None, None
        # Try each resolved address with its own family: many hosts (localhost included) resolve to IPv6 first.
        for family, kind, proto, _, addr in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
            try:
                s = socket.socket(family, kind, proto)
                s.settimeout(timeout)
                s.connect(addr)
                break
            except OSError as e:
                if s:
                    s.close()
                s, last_error = None, e
        if s is None:
            raise last_error or OSError("no address for %s" % host)
        if tls:
            try:
                s = _tls_wrap(s, host, ca_file, ca_data, insecure)
            except Exception:
                s.close()
                raise
        self.sock = s
        self.buf = b""

    def write(self, data):
        if MICROPYTHON:
            mv, sent = memoryview(data), 0
            while sent < len(data):
                n = self.sock.write(mv[sent:])
                sent += n or 0
        else:
            self.sock.sendall(data)

    def _fill(self, want):
        # recv() returns what has arrived. MicroPython's stream read(n) blocks until n bytes or EOF, which never
        # comes on an open WebSocket, so without recv() (some TLS sockets) read exactly the bytes still needed.
        if hasattr(self.sock, "recv"):
            chunk = self.sock.recv(4096)
        else:
            chunk = self.sock.read(max(1, want))
        if not chunk:
            raise KoduDBError(0, "connection closed")
        self.buf += chunk

    def read(self, n):
        while len(self.buf) < n:
            self._fill(n - len(self.buf))
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def readline(self):
        while b"\r\n" not in self.buf:
            self._fill(1)
        i = self.buf.index(b"\r\n") + 2
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def read_all(self):
        try:
            while True:
                self._fill(1024)
        except KoduDBError:
            pass
        out, self.buf = self.buf, b""
        return out

    def readable(self, timeout):
        """True when a read will not block: buffered bytes, TLS-buffered bytes or socket data."""
        if self.buf:
            return True
        if not MICROPYTHON and hasattr(self.sock, "pending") and self.sock.pending():
            return True
        if MICROPYTHON:
            p = select.poll()
            p.register(self.sock, select.POLLIN)
            return bool(p.poll(int(timeout * 1000)))
        r, _, _ = select.select([self.sock], [], [], timeout)
        return bool(r)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class KoduDB:
    def __init__(self, url, api_key, timeout=15, ca_file=None, ca_data=None, insecure=False):
        """url: API address, with /p/<project> for a project other than the default one.
        api_key: the project's public key (never put the secret key on a device).
        ca_file / ca_data: CA certificate for TLS verification (ca_data is PEM text; required on MicroPython).
        insecure: skip certificate checks. Development on a trusted network only."""
        self.url = url.rstrip("/")
        self.tls, self.host, self.port, self.base = parse_url(self.url)
        self.api_key = api_key
        self.timeout = timeout
        self.ca_file, self.ca_data, self.insecure = ca_file, ca_data, insecure
        self.session = None
        self._expires_at = 0
        self.realtime = Realtime(self)

    # ---------- HTTP ----------

    def _connect(self):
        return _Conn(self.tls, self.host, self.port, self.timeout, self.ca_file, self.ca_data, self.insecure)

    def request(self, method, path, body=None, params=None, headers=None, auth=True):
        """Send one request and return the decoded JSON (or None). Raises KoduDBError on HTTP errors."""
        if auth:
            self._refresh_if_needed()
        target = self.base + path + ("?" + query_string(params) if params else "")
        data = b"" if body is None else json.dumps(body).encode()
        h = {"Host": self.host, "apikey": self.api_key, "Connection": "close", "Content-Length": str(len(data)),
             "User-Agent": "kodudb-device/" + __version__, "Accept": "application/json"}
        if body is not None:
            h["Content-Type"] = "application/json"
        if auth and self.session:
            h["Authorization"] = "Bearer " + self.session["access_token"]
        if headers:
            h.update(headers)
        head = "%s %s HTTP/1.1\r\n%s\r\n" % (method, target, "".join("%s: %s\r\n" % kv for kv in h.items()))
        try:
            c = self._connect()
        except OSError as e:
            raise KoduDBError(0, "cannot connect to %s:%s (%s)" % (self.host, self.port, e))
        try:
            c.write(head.encode() + data)
            status = int(c.readline().split(b" ", 2)[1])
            length, chunked = None, False
            while True:
                line = c.readline()
                if line == b"\r\n":
                    break
                k, _, v = line.decode().partition(":")
                k, v = k.strip().lower(), v.strip()
                if k == "content-length":
                    length = int(v)
                elif k == "transfer-encoding" and "chunked" in v.lower():
                    chunked = True
            if chunked:
                raw = b""
                while True:
                    size = int(c.readline().strip().split(b";")[0], 16)
                    if size == 0:
                        break
                    raw += c.read(size)
                    c.read(2)
            elif length is not None:
                raw = c.read(length)
            else:
                raw = c.read_all()
        except OSError as e:
            raise KoduDBError(0, "request to %s failed (%s)" % (path, e))
        finally:
            c.close()
        payload = None
        if raw:
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = raw.decode()
        if status >= 400:
            msg = payload.get("error", payload) if isinstance(payload, dict) else payload
            raise KoduDBError(status, msg)
        return payload

    # ---------- auth ----------

    def _store(self, session):
        self.session = session
        self._expires_at = _now() + int(session.get("expires_in", 3600))
        return session

    def sign_in(self, email, password):
        """Sign in as a user (use one user per device and row security policies)."""
        s = self.request("POST", "/auth/v1/token", {"email": email, "password": password},
                         params={"grant_type": "password"}, auth=False)
        if "access_token" not in s:
            raise KoduDBError(400, "this user needs a two-factor code; devices should use users without two-factor")
        return self._store(s)

    def refresh(self):
        if not self.session:
            raise KoduDBError(401, "not signed in")
        s = self.request("POST", "/auth/v1/token", {"refresh_token": self.session["refresh_token"]},
                         params={"grant_type": "refresh_token"}, auth=False)
        return self._store(s)

    def _refresh_if_needed(self):
        if self.session and _now() > self._expires_at - 120:
            self.refresh()

    def sign_out(self):
        self.session = None
        self.realtime.close()

    # ---------- REST ----------

    def select(self, table, filters=None, select="*", order=None, limit=None, offset=None):
        """filters: {"column": "eq.value", ...} with eq neq gt gte lt lte like ilike is in not."""
        params = dict(filters or {})
        params.update({"select": select, "order": order, "limit": limit, "offset": offset})
        return self.request("GET", "/rest/v1/" + table, params=params)

    def insert(self, table, rows):
        """Insert one row (dict) or many (list); returns the inserted rows."""
        return self.request("POST", "/rest/v1/" + table, rows)

    def upsert(self, table, rows, on_conflict):
        """Insert, or update the row that has the same value in on_conflict (a unique column list)."""
        return self.request("POST", "/rest/v1/" + table, rows, params={"on_conflict": on_conflict},
                            headers={"Prefer": "resolution=merge-duplicates"})

    def update(self, table, values, filters):
        """Update the rows matching filters (required, so a typo never updates every row)."""
        if not filters:
            raise ValueError("update needs filters")
        return self.request("PATCH", "/rest/v1/" + table, values, params=filters)

    def delete(self, table, filters):
        if not filters:
            raise ValueError("delete needs filters")
        return self.request("DELETE", "/rest/v1/" + table, params=filters)

    def rpc(self, function, args=None):
        """Call a Postgres function. Everything it does commits or rolls back together."""
        return self.request("POST", "/rest/v1/rpc/" + function, args or {})


class Realtime:
    """Row changes over WebSocket. Call poll() regularly; it reconnects and resubscribes after a drop."""

    PING_EVERY = 25

    def __init__(self, db):
        self.db = db
        self.conn = None
        self.handlers = {}
        self._last_ping = 0
        self._retry_at = 0
        self._backoff = 1

    def subscribe(self, table, handler):
        """handler(event) for every insert, update and delete on table ("*" for all tables) the user may see."""
        self.handlers.setdefault(table, []).append(handler)
        if self.conn:
            self._send_json({"type": "subscribe", "table": table})

    def unsubscribe(self, table):
        self.handlers.pop(table, None)
        if self.conn:
            self._send_json({"type": "unsubscribe", "table": table})

    def connect(self):
        db = self.db
        db._refresh_if_needed()
        params = {"apikey": db.api_key}
        if db.session:
            params["token"] = db.session["access_token"]
        key = binascii.b2a_base64(os.urandom(16)).strip().decode()
        head = ("GET %s/realtime/v1/websocket?%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: kodudb-device/%s\r\n\r\n"
                % (db.base, query_string(params), db.host, key, __version__))
        c = db._connect()
        try:
            c.write(head.encode())
            status = int(c.readline().split(b" ", 2)[1])
            while c.readline() != b"\r\n":
                pass
            if status != 101:
                raise KoduDBError(status, "realtime connection refused")
        except Exception:
            c.close()
            raise
        self.conn = c
        self._last_ping = _now()
        self._backoff = 1
        for table in self.handlers:
            self._send_json({"type": "subscribe", "table": table})

    def close(self):
        if self.conn:
            try:
                self._send_frame(0x8, b"")
            except Exception:
                pass
            self.conn.close()
            self.conn = None

    def poll(self, timeout=1.0):
        """Deliver pending events to the handlers, waiting up to timeout seconds. Never raises on network errors."""
        deadline = _now() + timeout
        while True:
            if not self.conn:
                if _now() < self._retry_at:
                    return
                try:
                    self.connect()
                except Exception:
                    self._retry_at = _now() + self._backoff
                    self._backoff = min(self._backoff * 2, 60)
                    return
            try:
                if _now() - self._last_ping > self.PING_EVERY:
                    self._send_frame(0x9, b"kodudb")
                    self._last_ping = _now()
                left = deadline - _now()
                if left <= 0 or not self.conn.readable(max(left, 0)):
                    return
                self._handle(*self._read_frame())
            except Exception:
                if self.conn:
                    self.conn.close()
                self.conn = None
                self._retry_at = _now() + self._backoff

    def run_forever(self):
        while True:
            self.poll(5)

    # ---------- frames ----------

    def _send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def _send_frame(self, opcode, payload):
        """Client frames are always masked (RFC 6455)."""
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126, n >> 8, n & 0xFF])
        else:
            head.append(0x80 | 127)
            head += n.to_bytes(8, "big")
        mask = os.urandom(4)
        body = bytearray(payload)
        for i in range(n):
            body[i] ^= mask[i % 4]
        self.conn.write(bytes(head) + mask + bytes(body))

    def _read_frame(self):
        b0, b1 = self.conn.read(2)
        opcode, n = b0 & 0x0F, b1 & 0x7F
        if n == 126:
            n = int.from_bytes(self.conn.read(2), "big")
        elif n == 127:
            n = int.from_bytes(self.conn.read(8), "big")
        mask = self.conn.read(4) if b1 & 0x80 else None
        data = bytearray(self.conn.read(n)) if n else bytearray()
        if mask:
            for i in range(n):
                data[i] ^= mask[i % 4]
        fin = bool(b0 & 0x80)
        while not fin:  # reassemble fragmented messages
            more_op, more = self._read_frame_raw()
            data += more
            fin = more_op
        return opcode, bytes(data)

    def _read_frame_raw(self):
        b0, b1 = self.conn.read(2)
        n = b1 & 0x7F
        if n == 126:
            n = int.from_bytes(self.conn.read(2), "big")
        elif n == 127:
            n = int.from_bytes(self.conn.read(8), "big")
        return bool(b0 & 0x80), self.conn.read(n) if n else b""

    def _handle(self, opcode, data):
        if opcode == 0x9:  # ping
            self._send_frame(0xA, data)
        elif opcode == 0x8:  # close
            raise KoduDBError(0, "server closed the realtime connection")
        elif opcode == 0x1:
            msg = json.loads(data)
            table = msg.get("table")
            if "record" in msg:
                for h in self.handlers.get(table, []) + self.handlers.get("*", []):
                    h(msg)
