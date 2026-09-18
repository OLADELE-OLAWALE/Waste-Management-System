"""
Stage 4 - Intelligence layer.

Turns raw data (bins, zones, student reports, assumptions) into:
  * a hotspot score (0-100) for every campus zone
  * heatmap points showing where bins are most needed
  * bin allocation recommendations (how many, where, why)

Everything here is plain Python so the formulas can be read, explained in the
presentation, and tuned from the dashboard's Assumptions panel.
"""
import math
import time

EARTH_R = 6371000.0
DAY = 86400.0

# How strongly each report type signals demand for bins.
REPORT_WEIGHT = {"no_bin": 3.0, "overflowing": 2.0, "damaged": 1.0}

# Weights of the four hotspot components (sum = 1).
W_REPORTS, W_DEFICIT, W_TRAFFIC, W_OVERFLOW = 0.40, 0.30, 0.20, 0.10


def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def nearest(items, lat, lng, pred=lambda _: True):
    best, best_d = None, float("inf")
    for it in items:
        if not pred(it):
            continue
        d = haversine_m(lat, lng, it["lat"], it["lng"])
        if d < best_d:
            best, best_d = it, d
    return best, best_d


def bin_capacity_kg(s):
    """Usable mass one bin holds before it overflows."""
    return s["bin_capacity_l"] * s["waste_density_kg_per_l"] * s["fill_factor"]


def zone_waste_kg_day(zone, total_traffic, s):
    """Campus daily waste shared out by each zone's share of foot traffic."""
    if total_traffic <= 0:
        return 0.0
    return s["campus_waste_kg_day"] * zone["foot_traffic"] / total_traffic


def required_bins(zone, total_traffic, s):
    kg_per_cycle = zone_waste_kg_day(zone, total_traffic, s) * s["collection_interval_days"]
    return max(1, math.ceil(kg_per_cycle / bin_capacity_kg(s)))


def _decay(age_s, half_life_days):
    return 0.5 ** (age_s / (half_life_days * DAY))


def _kmeans(points, k, iters=20):
    """Tiny weighted k-means on (lat, lng, w) triples. Returns centres."""
    pts = sorted(points, key=lambda p: -p[2])
    k = max(1, min(k, len(pts)))
    centres = [(p[0], p[1]) for p in pts[:k]]
    for _ in range(iters):
        groups = [[] for _ in centres]
        for p in pts:
            i = min(range(len(centres)),
                    key=lambda c: haversine_m(p[0], p[1], centres[c][0], centres[c][1]))
            groups[i].append(p)
        new = []
        for g, c in zip(groups, centres):
            w = sum(p[2] for p in g)
            if w == 0:
                new.append(c)
            else:
                new.append((sum(p[0] * p[2] for p in g) / w, sum(p[1] * p[2] for p in g) / w))
        if new == centres:
            break
        centres = new
    return centres


def analyse(bins, zones, reports, s, now=None):
    now = now or time.time()
    total_traffic = sum(z["foot_traffic"] for z in zones)
    by_zone = {z["id"]: z for z in zones}

    stats = {z["id"]: {"report_signal": 0.0, "no_bin": 0, "overflowing": 0, "damaged": 0,
                       "open_reports": 0, "recent_overflow": 0, "points": []}
             for z in zones}

    heat = []
    window = s["analysis_window_days"] * DAY
    for r in reports:
        age = now - r["created_at"]
        if age > window or r["zone_id"] not in stats:
            continue
        st = stats[r["zone_id"]]
        # Resolved reports still count as history, but at a reduced weight.
        w = REPORT_WEIGHT[r["type"]] * _decay(age, s["report_half_life_days"])
        if r["status"] == "resolved":
            w *= 0.3
        st["report_signal"] += w
        st[r["type"]] += 1
        if r["status"] == "open":
            st["open_reports"] += 1
        if r["type"] == "overflowing" and age <= 14 * DAY:
            st["recent_overflow"] += 1
        if r["type"] in ("no_bin", "overflowing"):
            st["points"].append((r["lat"], r["lng"], w))
        heat.append([r["lat"], r["lng"], round(w, 3)])

    max_traffic = max((z["foot_traffic"] for z in zones), default=1) or 1
    scored = []
    for z in zones:
        st = stats[z["id"]]
        zb = [b for b in bins if b["zone_id"] == z["id"]]
        functional = sum(1 for b in zb if b["status"] != "damaged")
        need = required_bins(z, total_traffic, s)
        deficit = max(0, need - functional)

        # Each component is scaled to 0..1.
        c_reports = st["report_signal"] / (st["report_signal"] + 6.0)  # saturates, never hits 1
        c_deficit = deficit / need
        c_traffic = z["foot_traffic"] / max_traffic
        c_overflow = min(1.0, st["recent_overflow"] / max(1, len(zb)) / 2.0)

        score = 100 * (W_REPORTS * c_reports + W_DEFICIT * c_deficit
                       + W_TRAFFIC * c_traffic + W_OVERFLOW * c_overflow)
        scored.append({
            **z,
            "score": round(score, 1),
            "level": "critical" if score >= 60 else "high" if score >= 45 else "moderate" if score >= 30 else "low",
            "components": {"reports": round(c_reports, 3), "deficit": round(c_deficit, 3),
                           "traffic": round(c_traffic, 3), "overflow": round(c_overflow, 3)},
            "bins_total": len(zb),
            "bins_functional": functional,
            "bins_full": sum(1 for b in zb if b["status"] == "full"),
            "bins_required": need,
            "deficit": deficit,
            "waste_kg_day": round(zone_waste_kg_day(z, total_traffic, s), 1),
            "reports": {"no_bin": st["no_bin"], "overflowing": st["overflowing"],
                        "damaged": st["damaged"], "open": st["open_reports"]},
            "_points": st["points"],
        })

        # Structural demand also shows on the heatmap, spread over the zone.
        demand = c_deficit * c_traffic * 3.0
        if demand > 0:
            ring = [(0, 0)] + [(math.cos(a), math.sin(a)) for a in
                               (i * math.pi / 3 for i in range(6))]
            r_deg = z["radius_m"] * 0.5 / 111320.0
            for dx, dy in ring:
                heat.append([round(z["lat"] + dy * r_deg, 6),
                             round(z["lng"] + dx * r_deg / math.cos(math.radians(z["lat"])), 6),
                             round(demand, 3)])

    scored.sort(key=lambda z: -z["score"])

    recs = []
    for z in scored:
        by_reports = 1 if z["reports"]["no_bin"] >= s["no_bin_reports_trigger"] else 0
        add = max(z["deficit"], by_reports)
        if add == 0 or z["score"] < s["recommend_min_score"]:
            continue
        pts = z["_points"]
        n_sites = min(add, 3)
        sites = _kmeans(pts, n_sites) if pts else [(z["lat"], z["lng"])]
        per_site = [add // len(sites) + (1 if i < add % len(sites) else 0) for i in range(len(sites))]

        why = []
        if z["reports"]["no_bin"]:
            why.append(f'{z["reports"]["no_bin"]} "no bin" report(s)')
        if z["reports"]["overflowing"]:
            why.append(f'{z["reports"]["overflowing"]} overflow report(s)')
        if z["deficit"]:
            why.append(f'{z["bins_functional"]} working bin(s) vs {z["bins_required"]} needed '
                       f'for ~{z["waste_kg_day"]} kg/day')
        why.append(f'{z["foot_traffic"]} people/day')

        # Merge sites that landed within 20 m of each other.
        merged = []
        for (lat, lng), count in zip(sites, per_site):
            for m in merged:
                if haversine_m(lat, lng, m[0], m[1]) < 20:
                    m[2] += count
                    break
            else:
                merged.append([lat, lng, count])

        for lat, lng, count in merged:
            if count == 0:
                continue
            nb, d = nearest(bins, lat, lng, lambda b: b["status"] != "damaged")
            where = (f'beside {nb["name"].split()[0]} (overflowing: add capacity)'
                     if nb and d < 12 else "new bin point")
            recs.append({
                "zone_id": z["id"], "zone": z["name"], "priority": z["score"], "level": z["level"],
                "lat": round(lat, 6), "lng": round(lng, 6), "add_bins": count,
                "nearest_existing_m": round(d) if nb else None,
                "placement": where,
                "reason": "; ".join(why),
                "based_on": "report cluster" if pts else "zone centre (no reports yet)",
            })

    for z in scored:
        z.pop("_points")

    return {"zones": scored, "heat": heat, "recommendations": recs}
