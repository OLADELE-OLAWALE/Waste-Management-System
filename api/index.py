"""
Vercel entry point.

Vercel serves everything in public/ as static files and sends every /api/* request
here (see vercel.json). The request handler is the same one `python server.py` uses
locally, so there is a single implementation of the API rather than two.

`handler` MUST be written as a top-level class inheriting from BaseHTTPRequestHandler:
Vercel scans this file for that class to decide it is a function. An alias such as
`handler = Handler` is not detected and the build fails with
"doesn't match any Serverless Functions".
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import database as db  # noqa: E402
import server  # noqa: E402


class handler(server.Handler):  # noqa: N801  (Vercel requires this exact name)
    pass


# Create the tables on a cold start, and seed the demo data the first time only.
# A database problem must not stop the function from loading: let the failing request
# report it instead, so the logs show one clear error.
try:
    db.ensure(server.con)
except Exception:
    traceback.print_exc()
