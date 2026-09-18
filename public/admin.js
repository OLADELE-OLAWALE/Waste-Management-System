// Admin dashboard: live analytics, hotspots, heatmap, allocation recommendations.

const SETTING_FIELDS = [
  ["campus_waste_kg_day", "Campus waste (kg/day)", "Field report: over 70 kg/day"],
  ["collection_interval_days", "Days between collections", "Field report: weekly = 7"],
  ["bin_capacity_l", "Bin capacity (litres)", "0.45 m dia × 0.70 m high ≈ 111 L"],
  ["waste_density_kg_per_l", "Waste density (kg/L)", "Assumption: loose mixed waste ≈ 0.10"],
  ["fill_factor", "Usable fill fraction", "Assumption: bin counts as full at 80%"],
  ["report_half_life_days", "Report half-life (days)", "Older reports count less"],
  ["no_bin_reports_trigger", "\"No bin\" reports that force a recommendation", ""],
  ["recommend_min_score", "Minimum score to recommend", ""],
];
const LEVEL_COLOR = { critical: "#b91c1c", high: "#ea580c", moderate: "#ca8a04", low: "#65a30d" };

let map, heatLayer;
const groups = {};
const binMarkers = {};
let data = null, bins = [], reports = [];
let baseline = null, knownReports = null, editMode = false, lastSig = "";

async function init() {
  const campus = await api("/api/campus");
  const base = baseMap("map", campus.center, 17);
  map = base.map;
  L.control.layers(base.layers, {}, { position: "bottomright" }).addTo(map);
  for (const g of ["zones", "bins", "recs", "reports", "fresh"]) groups[g] = L.layerGroup().addTo(map);
  groups.reports.remove();

  heatLayer = L.heatLayer([], {
    radius: 38, blur: 30, maxZoom: 18, minOpacity: 0.25,
    gradient: { 0.2: "#2c7bb6", 0.45: "#abd9e9", 0.6: "#ffffbf", 0.8: "#fdae61", 1: "#d7191c" },
  }).addTo(map);

  const toggle = (id, layer) => document.getElementById(id).addEventListener("change", (e) =>
    e.target.checked ? layer.addTo(map) : layer.remove());
  toggle("l-heat", heatLayer); toggle("l-zones", groups.zones); toggle("l-bins", groups.bins);
  toggle("l-recs", groups.recs); toggle("l-reports", groups.reports);

  document.querySelectorAll(".side .tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".side .tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".side .panel").forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
  }));
  document.getElementById("baseline").addEventListener("click", () => { baseline = scoreMap(); render(); });
  document.getElementById("report-filter").addEventListener("change", renderReports);
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("simulate").addEventListener("click", simulate);
  document.getElementById("edit-toggle").addEventListener("click", toggleEdit);
  document.getElementById("reset-history").addEventListener("click", () => resetDemo(true));
  document.getElementById("reset-clean").addEventListener("click", () => resetDemo(false));
  document.getElementById("phone-url").textContent = `${location.protocol}//${location.host}/`;
  map.on("click", addBinAt);

  await refresh(true);
  setInterval(() => refresh(false), 4000);
}

const scoreMap = () => Object.fromEntries(data.zones.map((z) => [z.id, z.score]));

async function refresh(first) {
  try {
    [data, bins, reports] = await Promise.all([api("/api/analytics"), api("/api/bins"), api("/api/reports")]);
    document.getElementById("live").textContent = `live · updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById("live").textContent = "server offline";
    return;
  }
  if (!baseline) baseline = scoreMap();
  const ids = new Set(reports.map((r) => r.id));
  const fresh = knownReports ? reports.filter((r) => !knownReports.has(r.id)) : [];
  knownReports = ids;
  // Skip redraws when nothing changed, and don't close a popup the admin is using.
  const sig = JSON.stringify([data, bins, reports]);
  if (!first && !fresh.length && (sig === lastSig || map.hasLayer(map._popup || L.layerGroup()))) return;
  lastSig = sig;
  render(fresh);
  if (first) { fillSettings(); fillSimZones(); }
  for (const r of fresh) {
    if (r.reporter !== "demo") toast(`🚨 New report #${r.id}: ${REPORT_LABEL[r.type]} at ${r.zone}`);
  }
  if (fresh.some((r) => r.reporter === "demo")) toast(`🚨 ${fresh.length} new report(s) received`);
}

function render(fresh = []) {
  renderKpis();
  renderZones(fresh);
  renderMap(fresh);
  renderRecs();
  renderReports();
}

function renderKpis() {
  const k = data.kpis;
  const tile = (v, l, cls = "") => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  document.getElementById("kpis").innerHTML =
    tile(k.bins, "Bins mapped") +
    tile(k.bins_ok, "Available now") +
    tile(k.bins_full, "Overflowing", k.bins_full ? "bad" : "") +
    tile(k.bins_damaged, "Damaged", k.bins_damaged ? "warn" : "") +
    tile(k.open_reports, `Open reports · ${k.reports_24h} in 24 h`, "warn") +
    tile(`${k.bins_required}`, `Bins needed (collection every ${data.settings.collection_interval_days} d)`) +
    tile(`+${k.bins_to_add}`, "Recommended new bins", "purple") +
    tile(k.bins_required_2day, "Bins needed if collected every 2 d");
}

function renderZones(fresh) {
  const freshZones = new Set(fresh.map((r) => r.zone_id));
  document.getElementById("zone-rows").innerHTML = data.zones.map((z, i) => {
    const d = baseline && baseline[z.id] != null ? z.score - baseline[z.id] : 0;
    const delta = Math.abs(d) < 0.05 ? '<span class="muted small">–</span>'
      : `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(1)}</span>`;
    return `<tr class="clickable ${freshZones.has(z.id) ? "flash" : ""}" data-zone="${z.id}">
      <td>${i + 1}</td>
      <td><b>${esc(z.name)}</b><br><span class="pill lvl-${z.level}">${z.level}</span>
        <span class="small muted">${z.foot_traffic}/day</span></td>
      <td><b>${z.score.toFixed(1)}</b><div class="bar"><i style="width:${z.score}%;background:${LEVEL_COLOR[z.level]}"></i></div></td>
      <td>${delta}</td>
      <td>${z.bins_functional}/${z.bins_required}${z.bins_full ? `<br><span class="small" style="color:var(--red)">${z.bins_full} full</span>` : ""}</td>
      <td class="small">🚫${z.reports.no_bin} 🗑️${z.reports.overflowing} 🔧${z.reports.damaged}</td>
    </tr>`;
  }).join("");
  document.querySelectorAll("#zone-rows tr").forEach((tr) => tr.addEventListener("click", () => {
    const z = data.zones.find((x) => x.id === Number(tr.dataset.zone));
    map.setView([z.lat, z.lng], 18);
  }));
}

function renderMap(fresh) {
  heatLayer.setLatLngs(data.heat);

  groups.zones.clearLayers();
  for (const z of data.zones) {
    const c = L.circle([z.lat, z.lng], {
      radius: z.radius_m, color: LEVEL_COLOR[z.level], weight: 2, fillOpacity: 0.06, dashArray: "4 4",
      interactive: !editMode,
    }).bindTooltip(`<b>${esc(z.name)}</b><br>Score ${z.score.toFixed(1)} (${z.level})<br>
      Bins ${z.bins_functional}/${z.bins_required} needed · ~${z.waste_kg_day} kg/day`, { sticky: true });
    groups.zones.addLayer(c);
    const label = L.marker([z.lat, z.lng], {
      draggable: editMode,
      icon: L.divIcon({
        className: "",
        html: `<div style="transform:translate(-50%,-50%);white-space:nowrap;background:${LEVEL_COLOR[z.level]};color:#fff;
          font-size:11px;font-weight:700;padding:2px 6px;border-radius:99px;box-shadow:0 1px 3px rgba(0,0,0,.4)">
          ${editMode ? "✥ " : ""}${z.score.toFixed(0)}</div>`,
        iconSize: [0, 0],
      }),
    });
    if (editMode) {
      label.on("dragend", async (e) => {
        const p = e.target.getLatLng();
        await api(`/api/zones/${z.id}`, { method: "PUT", body: { lat: p.lat, lng: p.lng } });
        refresh();
      });
      label.on("click", () => editZone(z));
    }
    groups.zones.addLayer(label);
  }

  groups.bins.clearLayers();
  for (const b of bins) {
    const m = L.marker([b.lat, b.lng], { icon: binIcon(b.status), draggable: editMode });
    m.bindPopup(() => binPopup(b));
    m.on("dragend", async (e) => {
      const p = e.target.getLatLng();
      await api(`/api/bins/${b.id}`, { method: "PUT", body: { lat: p.lat, lng: p.lng } });
      toast(`Moved ${b.name}`);
      refresh();
    });
    groups.bins.addLayer(m);
  }

  groups.recs.clearLayers();
  for (const r of data.recommendations) {
    groups.recs.addLayer(L.marker([r.lat, r.lng], {
      icon: L.divIcon({ className: "", html: `<div class="rec-pin">+${r.add_bins}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      zIndexOffset: 500,
    }).bindPopup(`<b>Add ${r.add_bins} bin(s)</b>: ${esc(r.zone)}<br>${esc(r.placement)}<br>
      <span class="small">${esc(r.reason)}</span><br>
      <span class="small muted">Nearest working bin: ${r.nearest_existing_m ?? "–"} m · placed at ${esc(r.based_on)}</span>`));
  }

  groups.reports.clearLayers();
  for (const r of reports.filter((x) => x.status === "open")) {
    groups.reports.addLayer(L.circleMarker([r.lat, r.lng], {
      radius: 5, color: "#fff", weight: 1, fillColor: r.type === "no_bin" ? "#7c3aed" : r.type === "overflowing" ? "#e3342f" : "#6b7280", fillOpacity: 0.9,
    }).bindTooltip(`#${r.id} ${REPORT_LABEL[r.type]} · ${ago(r.created_at)}`));
  }

  for (const r of fresh) {
    const m = L.marker([r.lat, r.lng], {
      icon: L.divIcon({ className: "", html: '<div class="new-report-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 2000,
    });
    groups.fresh.addLayer(m);
    setTimeout(() => groups.fresh.removeLayer(m), 6000);
  }
}

function binPopup(b) {
  const div = document.createElement("div");
  div.innerHTML = `<b>${esc(b.name)}</b><br>${esc(b.zone || "")}<br>
    Status: <b style="color:${STATUS[b.status].color}">${STATUS[b.status].label}</b><br>
    <span class="small muted">Last emptied ${b.last_emptied ? ago(b.last_emptied) : "unknown"}</span>
    <div class="row" style="margin-top:8px;gap:4px">
      ${b.status === "full" ? '<button class="btn sm" data-a="empty">✅ Mark emptied</button>' : ""}
      ${b.status === "damaged" ? '<button class="btn sm" data-a="fix">🔧 Mark repaired</button>' : ""}
      ${editMode ? '<button class="btn sm danger" data-a="del">Delete</button>' : ""}
    </div>`;
  div.addEventListener("click", async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (a === "empty") await api(`/api/bins/${b.id}/empty`, { method: "POST" });
    if (a === "fix") {
      await api(`/api/bins/${b.id}`, { method: "PUT", body: { status: "ok" } });
      for (const r of reports.filter((r) => r.bin_id === b.id && r.type === "damaged" && r.status === "open"))
        await api(`/api/reports/${r.id}/resolve`, { method: "POST" });
    }
    if (a === "del") {
      if (!confirm(`Delete ${b.name}?`)) return;
      await api(`/api/bins/${b.id}`, { method: "DELETE" });
    }
    map.closePopup();
    refresh();
  });
  return div;
}

function renderRecs() {
  const recs = data.recommendations;
  const byZone = {};
  for (const r of recs) byZone[r.zone] = (byZone[r.zone] || 0) + r.add_bins;
  const k = data.kpis;
  document.getElementById("rec-summary").innerHTML = recs.length
    ? `<b>Add ${k.bins_to_add} bins across ${Object.keys(byZone).length} zones</b>, highest priority first.
       With collection every ${data.settings.collection_interval_days} days the campus needs ~${k.bins_required} bins;
       collecting every 2 days would cut that to ~${k.bins_required_2day}. More bins and more frequent
       collection work together.`
    : "No zone currently needs extra bins under the model's assumptions.";
  document.getElementById("rec-list").innerHTML = recs.map((r, i) => `
    <div class="rec" data-i="${i}">
      <h3><span>+${r.add_bins} · ${esc(r.zone)}</span><span class="pill lvl-${r.level}">${r.priority.toFixed(0)}</span></h3>
      <div class="small">${esc(r.placement)} · ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</div>
      <div class="small muted">${esc(r.reason)}</div>
      <div class="small muted">Nearest working bin ${r.nearest_existing_m ?? "–"} m · from ${esc(r.based_on)}</div>
    </div>`).join("");
  document.querySelectorAll(".rec").forEach((el) => el.addEventListener("click", () => {
    const r = recs[Number(el.dataset.i)];
    map.setView([r.lat, r.lng], 19);
  }));
}

function renderReports() {
  const filter = document.getElementById("report-filter").value;
  const list = reports.filter((r) => filter === "all" || r.status === "open").slice(0, 100);
  const icon = { no_bin: "🚫", overflowing: "🗑️", damaged: "🔧" };
  document.getElementById("report-rows").innerHTML = list.map((r) => `
    <tr class="clickable" data-id="${r.id}">
      <td>${r.id}</td>
      <td>${icon[r.type]} ${REPORT_LABEL[r.type]}${r.status === "resolved" ? '<br><span class="small muted">resolved</span>' : ""}</td>
      <td>${esc(r.zone || "")}${r.bin ? `<br><span class="small muted">${esc(r.bin)}</span>` : ""}
        ${r.nearest_bin_m != null && r.type === "no_bin" ? `<br><span class="small muted">nearest bin ${Math.round(r.nearest_bin_m)} m</span>` : ""}
        ${r.note ? `<br><span class="small">“${esc(r.note)}”</span>` : ""}</td>
      <td class="small">${ago(r.created_at)}<br><span class="muted">${esc(r.reporter)}</span></td>
      <td>${r.status === "open" ? `<button class="btn sm" data-resolve="${r.id}">Resolve</button>` : ""}</td>
    </tr>`).join("") || '<tr><td colspan="5" class="muted">No reports.</td></tr>';
  document.querySelectorAll("#report-rows tr[data-id]").forEach((tr) => tr.addEventListener("click", async (e) => {
    if (e.target.dataset.resolve) {
      await api(`/api/reports/${e.target.dataset.resolve}/resolve`, { method: "POST" });
      return refresh();
    }
    const r = reports.find((x) => x.id === Number(tr.dataset.id));
    map.setView([r.lat, r.lng], 19);
  }));
}

function fillSettings() {
  document.getElementById("settings-form").innerHTML = SETTING_FIELDS.map(([k, label, hint]) => `
    <label for="s-${k}">${label}</label>
    <input type="number" step="any" id="s-${k}" value="${data.settings[k]}">
    ${hint ? `<div class="hint">${hint}</div>` : ""}`).join("");
}

async function saveSettings() {
  const body = {};
  for (const [k] of SETTING_FIELDS) body[k] = document.getElementById(`s-${k}`).value;
  try {
    await api("/api/settings", { method: "PUT", body });
    toast("Assumptions saved: scores recalculated");
    refresh();
  } catch (e) { toast(e.message, "err"); }
}

function fillSimZones() {
  document.getElementById("sim-zone").innerHTML = data.zones
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join("");
}

async function simulate() {
  try {
    await api("/api/demo/simulate", {
      method: "POST",
      body: {
        zone_id: Number(document.getElementById("sim-zone").value),
        type: document.getElementById("sim-type").value,
        count: Number(document.getElementById("sim-count").value),
      },
    });
    refresh();
  } catch (e) { toast(e.message, "err"); }
}

function toggleEdit() {
  editMode = !editMode;
  document.getElementById("edit-toggle").textContent = editMode ? "✅ Exit edit mode" : "✏️ Enter edit mode";
  document.getElementById("editbanner").hidden = !editMode;
  renderMap([]);
}

async function addBinAt(e) {
  if (!editMode) return;
  const name = prompt("Name for the new bin (leave blank for automatic):", "");
  if (name === null) return;
  await api("/api/bins", { method: "POST", body: { lat: e.latlng.lat, lng: e.latlng.lng, name } });
  toast("Bin added");
  refresh();
}

async function editZone(z) {
  const v = prompt(`Foot traffic for ${z.name} (people per day):`, z.foot_traffic);
  if (v === null || v === "" || isNaN(Number(v))) return;
  await api(`/api/zones/${z.id}`, { method: "PUT", body: { foot_traffic: Math.round(Number(v)) } });
  refresh();
}

async function resetDemo(history) {
  if (!confirm("Erase all current data and reload the demo data set?")) return;
  await api("/api/demo/reset", { method: "POST", body: { history } });
  baseline = null; knownReports = null;
  await refresh(true);
  toast("Demo data reloaded");
}

init().catch((e) => toast("Could not reach the server: " + e.message, "err"));
