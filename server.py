"""
Digital Bin Availability System - Team Alpha PoC server.

Run:  python server.py            (then open http://localhost:8000)
      python server.py --reset    (restore the representative demo data)

Uses only the Python standard library: no pip install needed.
"""
import argparse
import hmac
import json
import mimetypes
import os
import re
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import database as db
import intelligence

# Page files live in public/ because that is what Vercel serves as static assets.
STATIC = Path(__file__).with_name("public")
con = db.connect()

# When ADMIN_PASSWORD is set (deployment), dashboard actions that change or erase data
# need it. Unset locally, so `python server.py` needs no password.
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

REPORT_TYPES = ("no_bin", "overflowing", "damaged")
BIN_STATUSES = ("ok", "full", "damaged")


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def need(body, key, kind=float):
    if key not in body:
        raise ApiError(400, f"missing field: {key}")
    try:
        return kind(body[key])
    except (TypeError, ValueError):
        raise ApiError(400, f"invalid field: {key}")


def analytics():
    s = db.get_settings(con)
    bins = db.rows(con, "SELECT * FROM bins")
    zones = db.rows(con, "SELECT * FROM zones")
    reports = db.rows(con, "SELECT * FROM reports")
    result = intelligence.analyse(bins, zones, reports, s)
    day_ago = time.time() - 86400
    result["kpis"] = {
        "bins": len(bins),
        "bins_ok": sum(b["status"] == "ok" for b in bins),
        "bins_full": sum(b["status"] == "full" for b in bins),
        "bins_damaged": sum(b["status"] == "damaged" for b in bins),
        "bins_required": sum(z["bins_required"] for z in result["zones"]),
        "open_reports": sum(r["status"] == "open" for r in reports),
        "reports_24h": sum(r["created_at"] >= day_ago for r in reports),
        "reports_total": len(reports),
        "bins_to_add": sum(r["add_bins"] for r in result["recommendations"]),
    }
    # What-if: the same demand if bins were collected every 2 days instead.
    alt = dict(s, collection_interval_days=2)
    total_traffic = sum(z["foot_traffic"] for z in zones)
    result["kpis"]["bins_required_2day"] = sum(
        intelligence.required_bins(z, total_traffic, alt) for z in zones)
    result["settings"] = s
    return result


# ---- route handlers: (method, regex, admin_only) -> fn(match, body) -------------
ROUTES = []


def route(method, pattern, admin=False):
    def deco(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn, admin))
        return fn
    return deco


@route("GET", "/api/health")
def health(m, body):
    """Quick check that a deployment is wired up: open /api/ in a browser."""
    return {
        "ok": True,
        "database": "turso (hosted)" if type(con).__name__ == "TursoConnection" else "local sqlite file",
        "bins": con.execute("SELECT COUNT(*) FROM bins").fetchone()[0],
        "reports": con.execute("SELECT COUNT(*) FROM reports").fetchone()[0],
        "admin_protected": bool(ADMIN_PASSWORD),
    }


@route("GET", "/api/campus")
def get_campus(m, body):
    return {"center": db.CAMPUS_CENTER, "settings": db.get_settings(con)}


@route("GET", "/api/bins")
def list_bins(m, body):
    return db.rows(con, "SELECT b.*, z.name AS zone FROM bins b LEFT JOIN zones z ON z.id=b.zone_id")


@route("POST", "/api/bins", admin=True)
def add_bin(m, body):
    lat, lng = need(body, "lat"), need(body, "lng")
    zone, _ = intelligence.nearest(db.rows(con, "SELECT * FROM zones"), lat, lng)
    with db._lock:
        n = con.execute("SELECT COALESCE(MAX(id),0)+1 FROM bins").fetchone()[0]
        cur = con.execute(
            "INSERT INTO bins (name,lat,lng,zone_id,capacity_l,status,last_emptied,created_at) "
            "VALUES (?,?,?,?,?,'ok',?,?)",
            (body.get("name") or f"BIN-{n:02d} {zone['name'] if zone else ''}".strip(),
             lat, lng, zone["id"] if zone else None,
             float(body.get("capacity_l", db.get_settings(con)["bin_capacity_l"])),
             time.time(), time.time()))
        con.commit()
    return {"id": cur.lastrowid}


@route("PUT", r"/api/bins/(\d+)", admin=True)
def update_bin(m, body):
    bid = int(m.group(1))
    b = con.execute("SELECT * FROM bins WHERE id=?", (bid,)).fetchone()
    if not b:
        raise ApiError(404, "bin not found")
    b = dict(b)
    if "lat" in body and "lng" in body:
        b["lat"], b["lng"] = float(body["lat"]), float(body["lng"])
        zone, _ = intelligence.nearest(db.rows(con, "SELECT * FROM zones"), b["lat"], b["lng"])
        b["zone_id"] = zone["id"] if zone else None
    if "status" in body:
        if body["status"] not in BIN_STATUSES:
            raise ApiError(400, "invalid status")
        b["status"] = body["status"]
    if "name" in body:
        b["name"] = str(body["name"])[:80]
    with db._lock:
        con.execute("UPDATE bins SET name=?,lat=?,lng=?,zone_id=?,status=? WHERE id=?",
                    (b["name"], b["lat"], b["lng"], b["zone_id"], b["status"], bid))
        con.commit()
    return {"ok": True}


@route("DELETE", r"/api/bins/(\d+)", admin=True)
def delete_bin(m, body):
    with db._lock:
        con.execute("UPDATE reports SET bin_id=NULL WHERE bin_id=?", (int(m.group(1)),))
        con.execute("DELETE FROM bins WHERE id=?", (int(m.group(1)),))
        con.commit()
    return {"ok": True}


@route("POST", r"/api/bins/(\d+)/empty", admin=True)
def empty_bin(m, body):
    """Collection crew emptied the bin: mark OK and close its overflow reports."""
    bid, now = int(m.group(1)), time.time()
    with db._lock:
        con.execute("UPDATE bins SET status='ok', last_emptied=? WHERE id=? AND status='full'", (now, bid))
        con.execute("UPDATE reports SET status='resolved', resolved_at=? "
                    "WHERE bin_id=? AND type='overflowing' AND status='open'", (now, bid))
        con.commit()
    return {"ok": True}


@route("PUT", r"/api/zones/(\d+)", admin=True)
def update_zone(m, body):
    zid = int(m.group(1))
    z = con.execute("SELECT * FROM zones WHERE id=?", (zid,)).fetchone()
    if not z:
        raise ApiError(404, "zone not found")
    z = dict(z)
    for k, kind in (("lat", float), ("lng", float), ("radius_m", float),
                    ("foot_traffic", int), ("name", str)):
        if k in body:
            z[k] = need(body, k, kind)
    with db._lock:
        con.execute("UPDATE zones SET name=?,lat=?,lng=?,radius_m=?,foot_traffic=? WHERE id=?",
                    (z["name"], z["lat"], z["lng"], z["radius_m"], z["foot_traffic"], zid))
        con.commit()
    return {"ok": True}


@route("GET", "/api/reports")
def list_reports(m, body):
    return db.rows(con, "SELECT r.*, z.name AS zone, b.name AS bin FROM reports r "
                        "LEFT JOIN zones z ON z.id=r.zone_id LEFT JOIN bins b ON b.id=r.bin_id "
                        "ORDER BY r.created_at DESC LIMIT 200")


@route("POST", "/api/reports")
def create_report(m, body):
    typ = body.get("type")
    if typ not in REPORT_TYPES:
        raise ApiError(400, "type must be no_bin, overflowing or damaged")
    lat, lng = need(body, "lat"), need(body, "lng")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ApiError(400, "invalid coordinates")
    bin_id = body.get("bin_id")
    if typ != "no_bin" and bin_id is None:
        raise ApiError(400, "select the bin that is overflowing or damaged")
    note = str(body.get("note", ""))[:500]
    reporter = str(body.get("reporter", "anonymous"))[:60] or "anonymous"
    with db._lock:
        try:
            rid = db.insert_report(con, typ, lat, lng,
                                   int(bin_id) if bin_id is not None else None, reporter, note)
        except ValueError as e:
            raise ApiError(400, str(e))
        con.commit()
    return {"id": rid}


@route("POST", r"/api/reports/(\d+)/resolve", admin=True)
def resolve_report(m, body):
    with db._lock:
        con.execute("UPDATE reports SET status='resolved', resolved_at=? WHERE id=?",
                    (time.time(), int(m.group(1))))
        con.commit()
    return {"ok": True}


@route("GET", "/api/analytics")
def get_analytics(m, body):
    return analytics()


@route("PUT", "/api/settings", admin=True)
def put_settings(m, body):
    with db._lock:
        for k, v in body.items():
            if k in db.DEFAULT_SETTINGS:
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    raise ApiError(400, f"invalid value for {k}")
                if v <= 0 and k not in ("recommend_min_score",):
                    raise ApiError(400, f"{k} must be positive")
                con.execute("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", (k, json.dumps(v)))
        con.commit()
    return db.get_settings(con)


@route("POST", "/api/demo/reset", admin=True)
def demo_reset(m, body):
    db.reset(con, seed_history=body.get("history", True))
    return {"ok": True}


@route("POST", "/api/demo/simulate", admin=True)
def demo_simulate(m, body):
    """Fire a burst of reports around a zone to show a hotspot forming live."""
    import random
    zid, typ, count = need(body, "zone_id", int), body.get("type", "no_bin"), min(need(body, "count", int), 50)
    if typ not in REPORT_TYPES:
        raise ApiError(400, "bad type")
    z = con.execute("SELECT * FROM zones WHERE id=?", (zid,)).fetchone()
    if not z:
        raise ApiError(404, "zone not found")
    zbins = db.rows(con, "SELECT * FROM bins WHERE zone_id=?", (zid,))
    if typ != "no_bin" and not zbins:
        raise ApiError(400, "this zone has no bins to report as overflowing/damaged")
    with db._lock:
        for _ in range(count):
            if typ == "no_bin":
                lat, lng = db.offset(z["lat"], z["lng"], random.gauss(0, z["radius_m"] / 3),
                                     random.gauss(0, z["radius_m"] / 3))
                db.insert_report(con, typ, lat, lng, None, "demo", "simulated")
            else:
                b = random.choice(zbins)
                db.insert_report(con, typ, b["lat"], b["lng"], b["id"], "demo", "simulated")
        con.commit()
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Keep the dashboard's 4-second polling out of the log, but note that
        # log_error passes a status code here, not a request line.
        first = args[0] if args else ""
        if not (isinstance(first, str) and "/api/analytics" in first):
            super().log_message(fmt, *args)

    def send_json(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def request_path(self):
        """The API path being asked for.

        Locally that is simply the URL path. On Vercel this one function serves every
        /api/* URL, so vercel.json rewrites "/api/bins" to "/api?route=bins" and the
        real route is read back from that query parameter.
        """
        parts = urlparse(self.path)
        if parts.path.rstrip("/") in ("/api", "/api/index", "/api/index.py"):
            route = parse_qs(parts.query).get("route", [""])[0].strip("/")
            return "/api/" + (route or "health")
        return parts.path

    def authorised(self):
        if not ADMIN_PASSWORD:
            return True
        return hmac.compare_digest(self.headers.get("X-Admin-Key", ""), ADMIN_PASSWORD)

    def dispatch(self, method):
        path = self.request_path()
        if path.startswith("/api/"):
            body = {}
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                try:
                    body = json.loads(self.rfile.read(length))
                except json.JSONDecodeError:
                    return self.send_json(400, {"error": "invalid JSON"})
            for mth, rx, fn, admin_only in ROUTES:
                match = rx.match(path)
                if match and mth == method:
                    if admin_only and not self.authorised():
                        return self.send_json(401, {"error": "admin key required"})
                    try:
                        with db._lock:
                            result = fn(match, body)
                        return self.send_json(200, result)
                    except ApiError as e:
                        return self.send_json(e.status, {"error": str(e)})
                    except Exception as e:  # never leak a stack trace to the browser
                        self.log_error("%s %s failed: %r", method, path, e)
                        return self.send_json(500, {"error": "server error: " + type(e).__name__})
            return self.send_json(404, {"error": "not found"})
        if method != "GET":
            return self.send_json(405, {"error": "method not allowed"})
        if path in ("/", ""):
            path = "/index.html"
        elif path == "/admin":
            path = "/admin.html"
        f = (STATIC / path.lstrip("/")).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            self.send_error(404)
            return
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--reset", action="store_true", help="reload representative demo data")
    args = ap.parse_args()
    if args.reset:
        db.reset(con)
    db.ensure(con)
    mimetypes.add_type("application/javascript", ".js")
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    ip = lan_ip()
    print(f"Student app:     http://localhost:{args.port}/")
    print(f"Admin dashboard: http://localhost:{args.port}/admin")
    if ip:
        print(f"On the same Wi-Fi (phones): http://{ip}:{args.port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
