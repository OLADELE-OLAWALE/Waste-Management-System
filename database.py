"""
Stage 3 - Database (SQLite, file: bins.db).

Tables
  zones    campus areas (classrooms, hostels, cafeteria...) with foot traffic
  bins     every waste bin: position, capacity, status (ok / full / damaged)
  reports  student reports: no_bin / overflowing / damaged
  settings assumptions used by the intelligence layer (editable)
"""
import json
import math
import os
import random
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).with_name("bins.db")
_lock = threading.RLock()  # one shared connection: serialise all access

# Centre of the LASU Epe Campus compound (off SOA Road, Iwaye, Epe): OpenStreetMap
# "Lasu epe Building" point, cross-checked against Esri satellite imagery.
CAMPUS_CENTER = (6.5930, 3.9972)

DEFAULT_SETTINGS = {
    # From the Team Alpha field report
    "campus_waste_kg_day": 70,          # "over 70 kg/day"
    "collection_interval_days": 7,      # "weekly waste collection"
    "bin_capacity_l": 111,              # 0.45 m diameter x 0.70 m height = 111 L
    # Assumptions (tune these)
    "waste_density_kg_per_l": 0.10,     # loose mixed campus waste ~100 kg/m3
    "fill_factor": 0.8,                 # a bin is "full" at ~80% of its volume
    "report_half_life_days": 7,         # a report loses half its weight each week
    "analysis_window_days": 30,
    "no_bin_reports_trigger": 3,        # >= this many "no bin" reports forces a recommendation
    "recommend_min_score": 25,
    "walking_speed_mps": 1.3,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, radius_m REAL NOT NULL,
  foot_traffic INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bins (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, zone_id INTEGER REFERENCES zones(id),
  capacity_l REAL NOT NULL DEFAULT 111,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','full','damaged')),
  last_emptied REAL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('no_bin','overflowing','damaged')),
  lat REAL NOT NULL, lng REAL NOT NULL,
  bin_id INTEGER REFERENCES bins(id), zone_id INTEGER REFERENCES zones(id),
  nearest_bin_m REAL, note TEXT, reporter TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at REAL NOT NULL, resolved_at REAL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def connect():
    """Hosted Turso database when configured (deployment), local SQLite file otherwise.

    Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to use Turso; with neither set,
    `python server.py` keeps working offline exactly as before.
    """
    url, token = os.environ.get("TURSO_DATABASE_URL"), os.environ.get("TURSO_AUTH_TOKEN")
    if url and token:
        from turso import TursoConnection
        return TursoConnection(url, token)
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def rows(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def get_settings(con):
    s = dict(DEFAULT_SETTINGS)
    for r in con.execute("SELECT key, value FROM settings"):
        s[r["key"]] = json.loads(r["value"])
    return s


def offset(lat, lng, east_m, north_m):
    return (lat + north_m / 111320.0,
            lng + east_m / (111320.0 * math.cos(math.radians(lat))))


# Representative layout. Each zone is placed on a building cluster visible in satellite
# imagery, but WHICH building is the library, hostel, etc. is a guess: correct names and
# positions in the dashboard (Demo > Edit mode) after walking the campus.
ZONES = [
    # name, type, lat, lng, radius_m, foot_traffic (people/day)
    ("Engineering Lecture Theatre", "classroom", 6.59221, 3.99680, 45, 700),
    ("Classroom Block A", "classroom", 6.59280, 3.99630, 45, 550),
    ("Classroom Block B", "classroom", 6.59271, 3.99782, 50, 500),
    ("Faculty Library", "library", 6.59330, 3.99658, 35, 300),
    ("Cafeteria & Food Vendors", "food", 6.59318, 3.99730, 35, 900),
    ("Workshops & Labs", "lab", 6.59415, 3.99827, 40, 350),
    ("School of Agriculture Block", "classroom", 6.59271, 3.99905, 50, 400),
    ("Administrative Block", "admin", 6.59338, 3.99556, 35, 250),
    ("Male Hostel", "hostel", 6.59388, 3.99744, 55, 450),
    ("Female Hostel", "hostel", 6.59383, 3.99943, 65, 450),
    ("Main Gate & Car Park", "gate", 6.59180, 3.99480, 45, 600),
    ("Sports Courts", "open", 6.59213, 3.99577, 40, 150),
]

# 16 observed bins, 8 of them overflowing, none inside classrooms (from the field report).
BINS = [
    # zone index, east offset, north offset from zone centre, status
    (4, -15, 10, "full"), (4, 20, -5, "full"), (4, 0, -30, "full"),
    (8, -20, 15, "full"), (8, 25, -10, "ok"),
    (9, 15, 20, "full"), (9, -25, -5, "ok"),
    (10, -20, 0, "full"), (10, 30, 20, "ok"),
    (7, 10, 15, "ok"), (7, -20, -10, "damaged"),
    (5, 0, 25, "full"),
    (3, -10, -20, "ok"),
    (11, -40, 0, "ok"),
    (6, 45, 35, "full"),
    (0, 55, -40, "ok"),
]

# Historical reports over the last 14 days: (zone index, type, count)
HISTORY = [
    (0, "no_bin", 7), (1, "no_bin", 5), (2, "no_bin", 4), (6, "no_bin", 3),
    (4, "overflowing", 8), (4, "no_bin", 2), (8, "overflowing", 3), (9, "overflowing", 3),
    (10, "overflowing", 2), (5, "overflowing", 2), (7, "damaged", 2), (3, "no_bin", 1),
]


def batch(con, statements):
    """Run many statements in one round trip where the backend supports it."""
    if hasattr(con, "batch"):
        return con.batch(statements)
    for sql, args in statements:
        con.execute(sql, args)


def reset(con, seed_history=True):
    """Rebuild the demo data set.

    Rows carry explicit ids and everything is sent in a few batches, because over a
    hosted database (Turso) one statement per row would mean hundreds of round trips.
    """
    from intelligence import nearest
    with _lock:
        con.executescript("DROP TABLE IF EXISTS reports; DROP TABLE IF EXISTS bins;"
                          "DROP TABLE IF EXISTS zones; DROP TABLE IF EXISTS settings;")
        con.executescript(SCHEMA)
        now = time.time()
        rnd = random.Random(10)

        zones, stmts = [], []
        for i, (name, typ, lat, lng, rad, traffic) in enumerate(ZONES, 1):
            zones.append({"id": i, "name": name, "lat": lat, "lng": lng, "radius_m": rad})
            stmts.append(("INSERT INTO zones (id,name,type,lat,lng,radius_m,foot_traffic) "
                          "VALUES (?,?,?,?,?,?,?)", (i, name, typ, lat, lng, rad, traffic)))

        bins = []
        for i, (zi, e, n, status) in enumerate(BINS, 1):
            z = zones[zi]
            lat, lng = offset(z["lat"], z["lng"], e * 0.6, n * 0.6)
            bins.append({"id": i, "lat": lat, "lng": lng, "zone_id": z["id"], "status": status})
            stmts.append(("INSERT INTO bins (id,name,lat,lng,zone_id,capacity_l,status,last_emptied,created_at) "
                          "VALUES (?,?,?,?,?,?,?,?,?)",
                          (i, f"BIN-{i:02d} {z['name']}", lat, lng, z["id"], 111, status,
                           now - rnd.uniform(1, 7) * 86400, now - 90 * 86400)))
        batch(con, stmts)

        if seed_history:
            stmts, rid = [], 0
            for zi, typ, count in HISTORY:
                z = zones[zi]
                zbins = [b for b in bins if b["zone_id"] == z["id"]]
                for _ in range(count):
                    age = rnd.uniform(0.2, 14) * 86400
                    if typ != "no_bin" and zbins:
                        b = rnd.choice(zbins)
                        lat, lng = offset(b["lat"], b["lng"], rnd.uniform(-4, 4), rnd.uniform(-4, 4))
                        bin_id = b["id"]
                    else:
                        lat, lng = offset(z["lat"], z["lng"],
                                          rnd.gauss(0, z["radius_m"] / 3), rnd.gauss(0, z["radius_m"] / 3))
                        bin_id = None
                    _, nb_d = nearest(bins, lat, lng, lambda b: b["status"] != "damaged")
                    rid += 1
                    stmts.append((
                        "INSERT INTO reports (id,type,lat,lng,bin_id,zone_id,nearest_bin_m,note,reporter,"
                        "status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (rid, typ, lat, lng, bin_id, z["id"],
                         None if nb_d == float("inf") else round(nb_d, 1),
                         "", "seed", "open", now - age)))
            batch(con, stmts)
        con.commit()


def insert_report(con, typ, lat, lng, bin_id, reporter, note, created_at=None, apply_status=True):
    from intelligence import nearest
    zones = rows(con, "SELECT * FROM zones")
    bins = rows(con, "SELECT * FROM bins")
    zone, _ = nearest(zones, lat, lng)
    _, nb_d = nearest(bins, lat, lng, lambda b: b["status"] != "damaged")
    if bin_id is not None:
        b = next((b for b in bins if b["id"] == bin_id), None)
        if b is None:
            raise ValueError("unknown bin")
        zone = next(z for z in zones if z["id"] == b["zone_id"])
    cur = con.execute(
        "INSERT INTO reports (type,lat,lng,bin_id,zone_id,nearest_bin_m,note,reporter,status,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (typ, lat, lng, bin_id, zone["id"] if zone else None,
         None if nb_d == float("inf") else round(nb_d, 1),
         note, reporter, "open", created_at or time.time()))
    if apply_status and bin_id is not None:
        con.execute("UPDATE bins SET status=? WHERE id=?",
                    ("full" if typ == "overflowing" else "damaged", bin_id))
    return cur.lastrowid


def ensure(con):
    exists = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bins'").fetchone()
    if not exists:
        reset(con)
