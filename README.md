# BinFinder: Digital Bin Availability System (Team Alpha PoC)

A web prototype for LASU Epe Campus: a campus bin map, a nearest-bin finder, student problem reports, an admin
dashboard, a demand heatmap, and bin allocation recommendations.
See [DESIGN.md](DESIGN.md) for the page designs, data model, and formulas.

## Run it
You need Python 3.9+ and nothing else (standard library only). The map tiles need internet access.

```
cd "TEAM ALPHA/bin-system"
python server.py            # first run creates bins.db with representative demo data
python server.py --reset    # restore demo data before a presentation
```
* Student app: http://localhost:8000/
* Admin dashboard: http://localhost:8000/admin
* On phones: connect to the same Wi-Fi and open the "On the same Wi-Fi" address the server prints.
  (Phone GPS needs https, so use "tap the map" to set your location.)

## Files
| File | Stage |
|---|---|
| `DESIGN.md` | 1: Design |
| `public/index.html`, `app.js`, `admin.html`, `admin.js`, `qr.html`, `common.js`, `style.css` | 2: Frontend (Leaflet map) |
| `database.py` (SQLite `bins.db`), `turso.py` (hosted SQLite), `server.py` (REST API) | 3: Database |
| `intelligence.py` | 4: Hotspot scores, heatmap, recommendations |
| `api/index.py`, `vercel.json` | Deployment entry point for Vercel |

## Deploy to Vercel

Vercel runs the app as a serverless function with no permanent disk, so the data lives in Turso
(free hosted SQLite). The same code runs both ways: with no Turso environment variables set,
`python server.py` uses the local `bins.db` exactly as before.

**1. Create the database (turso.tech)**

Sign up, create a database (choose a region near Nigeria, e.g. Frankfurt `fra`), then copy:
* its **database URL**, which looks like `libsql://your-db-yourname.turso.io`
* a **auth token** it generates for that database

**2. Import the repo (vercel.com)**

"Add New… → Project" → import this GitHub repo → before clicking Deploy, add three environment variables:

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | the `libsql://…` URL from step 1 |
| `TURSO_AUTH_TOKEN` | the token from step 1 |
| `ADMIN_PASSWORD` | any password you choose: it protects the dashboard's actions |

Then Deploy. Vercel serves `public/` as static files and sends every `/api/*` request to `api/index.py`.

**3. First run**

Check the wiring first at `https://your-project.vercel.app/api/` — it answers with the database in use
and how many bins and reports it can see. Then open `https://your-project.vercel.app/admin`. The tables are created on the first request and the demo
data is seeded automatically. Any action that changes data asks once for the `ADMIN_PASSWORD` you set,
and the browser remembers it.

Anyone with the link can view the dashboard and send reports; only someone with the admin key can edit
bins, resolve reports, change assumptions or reset the data. Vercel's free Hobby plan is for
non-commercial projects, which this is.

**Why this matters for the demo:** the deployed site is `https://`, so phone GPS works. Your teammates
open the link on any network, and their reports appear on the dashboard within about 4 seconds.

## Stage 5: Demo script (about 5 minutes)
Before you start: `python server.py --reset`. Open `/admin` on the projector and `/` on a phone or a second window.

1. **The problem, in data** (Hotspots tab). There are 16 mapped bins and 8 are overflowing, matching our field
   observation. Classrooms have 0 bins and are ranked critical, matching the survey (78.6% saw no bins in
   classrooms). Point out the KPI: ~59 bins are needed with weekly collection, but only ~21 with collection every 2 days.
2. **Find the nearest bin** (student app). Tap near the cafeteria and open 📍 Nearest. The app skips the
   closer overflowing bin and routes to an available one.
3. **Submit a test report.** On the student app, go to 🚨 Report › No bin, tap near *Sports Courts*, add a note, and send.
4. **Watch it arrive** (dashboard, within 4 s). A toast appears, the point pulses on the map, and the Sports
   Courts row flashes with its score ▲ (≈18 → ≈32, low → moderate). A `+1` recommendation appears.
5. **Watch the hotspot change.** Go to 🎬 Demo, choose Sports Courts › No bin × 6 › Send. The score climbs to about
   49 (high) and the heatmap turns red there.
6. **Recommend where to add bins** (➕ Allocate). Each card gives the zone, how many bins, map coordinates,
   and the evidence ("7 'no bin' reports; 1 working bin vs 2 needed; 150 people/day"). Click a card to zoom to the site.
7. **Close the loop.** Click an overflowing bin › ✅ Mark emptied. It turns green, its reports resolve, and the score drops.
8. **What-if** (⚙️ Model). Change "Days between collections" from 7 to 3, then Save. The bins needed and the
   recommendations shrink. This is the evidence for the collection-frequency part of our recommendation.

## QR stickers for the bins

Open `/qr.html` (also linked from the dashboard's 🎬 Demo tab) and print it. Each sticker carries the bin's code
and a QR code; scanning it opens the report form with that bin already selected, so a student reports an
overflowing bin in two taps without GPS or searching a list. Tape one to each bin, with clear tape over the top
to keep the rain off, and test one with a phone camera before printing the full sheet.

## Exporting the data

The dashboard's 🚨 Reports tab has a **⬇️ CSV** button (`/api/reports.csv`) that downloads every report with its
type, zone, bin, coordinates, distance to the nearest bin, note and timestamps: ready for the appendix of the
research report, or for charts in Excel.

## On phones

Both pages are built for phones first and adapt upward: on a phone the dashboard shows its figures and the
ranked hotspot table before the map, tables scroll sideways inside their own box, and nobody needs to
switch to "desktop site". On a laptop or projector the student app puts its controls beside a large map.

## Before real campus data replaces the demo data
1. Walk the campus with a phone and note each bin's position and condition.
2. Open 🎬 Demo › ✏️ Edit mode. Drag each zone centre onto the correct building (click it to set foot traffic),
   drag or add bins (click the map to add), and delete bins that don't exist.
3. Use **Reset: bins only, no reports** first if you want to start without the synthetic 14-day history
   (note: that reset restores the demo bins too, so edit bins afterwards).
