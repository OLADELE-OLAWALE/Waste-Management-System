# Stage 1: Design

**Digital Bin Availability System: Team Alpha PoC (LASU Epe Campus)**

The system is built from the problem statement in the merged report. There is no data-driven way to find bin
shortages or choose where new bins should go. The system maps bins, collects student reports, finds hotspots,
and recommends where to place bins.

| Report requirement | Where it lives in the PoC |
|---|---|
| 7.1 Interactive bin mapping, nearest bin, GPS walking distance | Student app: **Map** and **Nearest** tabs |
| 7.2 Report locations lacking bins | Student app: **Report › No bin** |
| 7.4 Report overflowing bins | Student app: **Report › Overflowing / Damaged** |
| 7.3 Demand heatmap (reports + population + waste rate + overflow) | Dashboard: heatmap layer + **Hotspots** tab |
| "Data-driven allocation" | Dashboard: **Allocate** tab and purple `+N` map pins |

## Pages

### 1. Student app (`/`), mobile-first

The home screen answers one question and nothing else: **where is the nearest bin I
can use, and how far is it.** There are no tabs to choose between. GPS runs on open,
the nearest *available* bin is highlighted, the route is drawn, and the answer is
already on screen before the student taps anything.

```
┌──────────────────────────┐
│ 🗑️ BinFinder              │
├──────────────────────────┤
│   street map + campus    │  ● circle = available, ◆ diamond = overflowing,
│   place names            │  ■ square = damaged - shape, colour and glyph,
│   ✓   ◆     🔵 you        │  so sunlight and colour-blindness cannot hide it
│        - - - ->✓         │  dashed line = route to the nearest available bin
├──────────────────────────┤
│  ┌────┐ NEAREST AVAILABLE BIN   │
│  │ 64 │ BIN-13 Faculty Library  │
│  │  m │ ~1 min walk             │
│  └────┘ Status updated 2 h ago  │
│  [ ➤ Directions ]  Report a problem │
│  ▸ What the pins mean    │
└──────────────────────────┘
```

* **Nearest bin:** full and damaged bins are skipped and the app says so. Walking
  distance is 1.3 × straight-line, walking time at 1.3 m/s.
* **Directions:** draws the route on the map and hands the walk to the phone's own
  map app, which knows the footpaths.
* **Pins:** bins that would overlap collapse into a neutral dark cluster below
  zoom 18; at walking zoom every bin is its own pin.
* **Place names** come from our zone list, not from the tiles: OpenStreetMap has
  almost nothing mapped inside LASU Epe, so "the building beside the bin" has to
  come from our own data.
* **Bin popup:** name, status, distance, Directions, and a small report link.

**Two reporting flows**, kept apart from the first tap, because they are two
different jobs for the campus team:

| Flow | Student does | Team gets |
|---|---|---|
| 🗑️ **Report a bin issue** | picks the bin, taps Full/overflowing or Damaged | a repair or collection job; the bin's status and "last updated" change at once |
| 📍 **Request a bin here** | drags a pin to the spot, picks a reason | evidence for siting a *new* bin, in its own list |

* **Confirmation:** every report ends on a screen that repeats the reference number,
  what was reported, which bin or spot, what the bin now shows and when it was
  updated, plus how many reports that area has had in the last 7 days.
* **QR stickers:** a sticker on each bin links to `/?bin=<id>`, which opens the
  bin-issue form with that bin already chosen. Print them from `/qr.html`.

**Wrong reports.** One student can pick the wrong bin from the list, or report a bin that is fine.
Three rules keep a single voice from deciding what everyone else sees, without an account system:

| Rule | Setting | What it stops |
|---|---|---|
| One report per device, per bin, per day (per spot within 25 m for bin requests) | fixed | One phone repeating itself |
| A bin changes status only when **two different phones** report the same thing within 6 hours | `reports_to_confirm`, `confirm_window_hours` | One mistaken or joking report hiding a working bin |
| A status nobody repeats goes stale: overflowing clears after 24 h, damaged after 7 days | `overflow_expiry_hours`, `damaged_expiry_days` | A wrong or out-of-date status lasting forever |

Plus a cap of 30 reports per hour from one network, so a public link cannot be flooded.

Until the second report arrives the bin is **flagged, not hidden**: it keeps its Available status and
still counts as the nearest usable bin, but it wears an amber ring on the map and both the card and the
popup say "1 of 2 reports say it is overflowing — not confirmed yet". The student who reported it sees
on the confirmation screen that their report is counted and what still has to happen. Several students
reporting the same bin is genuine evidence and is never merged away.

Expiry keeps the timestamp at the moment the information went stale rather than moving it to now, so
the app says "updated 1 d ago" instead of pretending someone has just checked. The collection crew's
**Mark emptied** in the dashboard still overrides everything immediately.

### 2. Admin dashboard (`/admin`)
```
┌ KPI tiles: bins · available · overflowing · damaged · open reports · bins needed · +recommended · what-if ┐
├──────────────── map ─────────────────┬──── tabs ────────────────────────────────┤
│ layers: heatmap, zone scores, bins,  │ 🔥 Hotspots: ranked zones, score, Δ, bins │
│ recommended +N pins, open reports    │ ➕ Allocate: where to add bins and why    │
│                                      │ 🚨 Reports: two streams, resolve, zoom to │
│                                      │ ⚙️ Model: edit assumptions, recalculate  │
│                                      │ 🎬 Demo: simulate reports, edit, reset    │
└──────────────────────────────────────┴───────────────────────────────────────────┘
```
Refreshes every 4 s. New reports pulse on the map and flash their zone row. Δ shows each score's change
since the dashboard was opened.

## Data

| Table | Fields | Notes |
|---|---|---|
| `zones` | name, type, lat, lng, radius_m, foot_traffic | Campus areas: classrooms, hostels, cafeteria, gate… |
| `bins` | name, lat, lng, zone_id, capacity_l, status (`ok`/`full`/`damaged`), last_emptied | An overflowing report sets `full`; "Mark emptied" sets `ok` and closes its reports |
| `reports` | type (`no_bin`/`overflowing`/`damaged`), lat, lng, bin_id, zone_id, nearest_bin_m, note, reporter, device_id, reporter_key, status, created_at | Each report is assigned to the nearest zone. `nearest_bin_m` shows how far a "no bin" spot is from any bin. `device_id` is an anonymous per-browser id and `reporter_key` a hash of the network address: both exist only to spot duplicates, and no personal data or raw IP is stored |
| `settings` | key/value | Model assumptions, editable in the dashboard |

**Values from our field work:** 70 kg/day of waste, weekly collection, bins 0.45 m × 0.70 m (≈111 L),
16 observed bins with 8 overflowing, and no bins in classrooms.
**Assumptions to validate in Week 5:** waste density 0.10 kg/L, 80% usable fill, foot traffic per zone,
and which building each zone really is.

## Stage 4: Intelligence

**Bins needed per zone**
```
zone_waste_kg_day = campus_waste_kg_day × zone_foot_traffic / total_foot_traffic
bins_needed       = ceil(zone_waste_kg_day × collection_interval_days / (bin_L × density × fill))
deficit           = max(0, bins_needed − working_bins)
```

**Hotspot score (0–100)**
```
score = 100 × (0.40·R + 0.30·D + 0.20·T + 0.10·O)
R  report signal   S/(S+6), where S = Σ weight × 0.5^(age/7 days); no_bin 3, overflowing 2, damaged 1; resolved × 0.3
D  deficit         deficit / bins_needed
T  foot traffic    zone traffic / busiest zone's traffic
O  overflow rate   min(1, overflow reports in 14 d / bins / 2)
levels: ≥60 critical · ≥45 high · ≥30 moderate · else low
```

**Heatmap:** each report is a point weighted like S above. Structural demand (D × T) is spread across each zone
too, so areas with no reports yet still show their shortage.

**Allocation recommendation:** add `max(deficit, 1 if "no bin" reports ≥ 3)` bins to each zone scoring ≥ 25.
Bins are placed at up to 3 weighted k-means centres of that zone's "no bin" and overflow report locations
(the zone centre if there are no reports). Sites within 20 m of each other are merged. A site within 12 m of an
existing bin is labelled "add capacity beside BIN-xx". Each recommendation lists the evidence behind it.

## Known limitations (be upfront about these in the presentation)
* Zone positions match building clusters in satellite imagery, but the building names are guesses. Correct them in Edit mode.
* Distances are straight-line × 1.3, not routed along real paths.
* Anyone with the link can open `/admin` and read it. Actions that change data (editing bins, resolving
  reports, changing assumptions, resetting) need the admin key when `ADMIN_PASSWORD` is set on the deployment.
  There are no real user accounts: that would come after the PoC.
* Phone browsers only allow GPS on `https://` or `localhost`. Over plain LAN http, students tap the map instead.
