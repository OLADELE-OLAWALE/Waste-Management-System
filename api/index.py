"""
Vercel entry point.

Vercel's Python runtime runs the `handler` exported here for every /api/* request
(see vercel.json), and serves everything in public/ as static files. The handler is
the same request handler that `python server.py` uses locally, so there is one
implementation of the API rather than two.
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import database as db  # noqa: E402
import server  # noqa: E402
from server import Handler as handler  # noqa: E402,F401  (Vercel looks for `handler`)

# Create the tables on a cold start, and seed the demo data the first time only.
# A database problem must not stop the function from loading: let the failing request
# report it instead, so the logs show one clear error.
try:
    db.ensure(server.con)
except Exception:
    traceback.print_exc()
