"""
Turso (hosted SQLite) client over its HTTP pipeline API.

Deployment needs a database that outlives a single request: Vercel runs the app as a
serverless function with no permanent disk, so a local .db file would be wiped between
requests. Turso is SQLite, so every query in database.py works unchanged.

This exposes just enough of the sqlite3 connection API for our use:
    con.execute(sql, args) -> Result (.fetchall/.fetchone/iteration/.lastrowid)
    con.executescript(sql) / con.batch([(sql, args), ...])  -> one HTTP round trip
    con.commit()  (no-op: each request is committed on its own)

Only the standard library is used, so there is still nothing to pip install.
"""
import json
import urllib.error
import urllib.request


class TursoError(RuntimeError):
    pass


class Row(dict):
    """dict row that also supports positional access, like sqlite3.Row."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


class Result:
    def __init__(self, cols, rows, lastrowid=None):
        self.cols, self.rows, self.lastrowid = cols, rows, lastrowid

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


def _encode(v):
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": v}
    if isinstance(v, (bytes, bytearray)):
        raise TursoError("blob values are not used by this app")
    return {"type": "text", "value": str(v)}


def _decode(v):
    t = v.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(v["value"])
    if t == "float":
        return float(v["value"])
    return v.get("value")


class TursoConnection:
    def __init__(self, url, token, timeout=20):
        # Accept libsql://host, https://host or bare host.
        host = url.replace("libsql://", "").replace("https://", "").rstrip("/")
        self.endpoint = f"https://{host}/v2/pipeline"
        self.token = token
        self.timeout = timeout

    # -- plumbing ----------------------------------------------------------
    def _pipeline(self, statements):
        body = {"requests": [{"type": "execute", "stmt": {"sql": sql, "args": [_encode(a) for a in args]}}
                             for sql, args in statements]}
        body["requests"].append({"type": "close"})
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                payload = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise TursoError(f"Turso HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}")
        except urllib.error.URLError as e:
            raise TursoError(f"Cannot reach Turso: {e.reason}")

        results = []
        for item in payload.get("results", []):
            if item.get("type") == "error":
                raise TursoError(item.get("error", {}).get("message", "unknown Turso error"))
            if item.get("response", {}).get("type") != "execute":
                continue
            res = item["response"]["result"]
            cols = [c.get("name") for c in res.get("cols", [])]
            rows = [Row(zip(cols, (_decode(v) for v in raw))) for raw in res.get("rows", [])]
            last = res.get("last_insert_rowid")
            results.append(Result(cols, rows, int(last) if last not in (None, "") else None))
        return results

    # -- sqlite3-shaped API ------------------------------------------------
    def execute(self, sql, args=()):
        return self._pipeline([(sql, tuple(args))])[0]

    def batch(self, statements):
        """Run many statements in one HTTP round trip."""
        return self._pipeline([(sql, tuple(args)) for sql, args in statements]) if statements else []

    def executescript(self, script):
        stmts = [(s.strip(), ()) for s in script.split(";") if s.strip()]
        return self._pipeline(stmts)

    def commit(self):
        pass  # each pipeline request commits on its own

    def close(self):
        pass
