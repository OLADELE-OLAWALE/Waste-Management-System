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
```
┌──────────────────────────┐
│ 🗑️ BinFinder     Admin › │
├──────────────────────────┤
│                          │
│   satellite campus map   │  green = available, red = overflowing,
│   🗑️  🗑️     🔵 you       │  grey = damaged; tap a bin to report it
│        - - - ->🗑️        │  dashed line = route to nearest bin
├──────────────────────────┤
│ 🗺️ Map │ 📍 Nearest │ 🚨 Report │
│ [📡 Use my GPS] or tap map│
│ 80 m · BIN-13 · ~1 min    │
└──────────────────────────┘
```
* **Map:** every bin with its live status.
* **Nearest:** the closest *available* bin (full or damaged bins are skipped, and the app says so), walking
  distance estimated as 1.3 × straight-line distance, walking time at 1.3 m/s, plus the next 3 alternatives.
* **Report:** pick No bin / Overflowing / Damaged. Location comes from GPS or a tap on the map. Overflowing or
  damaged reports must name a bin (the 6 closest are listed). Details and name are optional.
* **QR stickers:** a sticker on each bin links to `/?bin=<id>`, which opens the report form with that bin already
  selected, so reporting an overflow takes two taps and needs no GPS. Print them from `/qr.html`.

**Duplicate handling.** Several students reporting the same overflowing bin is genuine evidence and must count,
so reports are never merged. What is blocked is the *same browser* repeating the same report type within 25 m in
10 minutes (a double tap), plus a cap of 30 reports per hour from one network so a public link cannot be flooded.

### 2. Admin dashboard (`/admin`)
```
┌ KPI tiles: bins · available · overflowing · damaged · open reports · bins needed · +recommended · what-if ┐
├──────────────── map ─────────────────┬──── tabs ────────────────────────────────┤
│ layers: heatmap, zone scores, bins,  │ 🔥 Hotspots: ranked zones, score, Δ, bins │
│ recommended +N pins, open reports    │ ➕ Allocate: where to add bins and why    │
│                                      │ 🚨 Reports: resolve, zoom to              │
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
