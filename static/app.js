// Student app: campus map, find nearest bin, report a problem.

const state = { me: null, bins: [], markers: {}, type: null, target: null, walkSpeed: 1.3 };
let map, meMarker, routeLine;

async function init() {
  const campus = await api("/api/campus");
  state.walkSpeed = campus.settings.walking_speed_mps;
  const base = baseMap("map", campus.center, 17);
  map = base.map;
  L.control.layers(base.layers, {}, { position: "topright" }).addTo(map);

  map.on("click", (e) => setMe(e.latlng.lat, e.latlng.lng, "Location set from map"));

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll("[data-locate]").forEach((b) => b.addEventListener("click", locate));
  document.querySelectorAll("#types button").forEach((b) =>
    b.addEventListener("click", () => chooseType(b.dataset.type)));
  document.getElementById("bin-select").addEventListener("change", (e) => {
    state.target = Number(e.target.value) || null;
    highlightTarget();
    updateSubmit();
  });
  document.getElementById("submit").addEventListener("click", submit);

  await loadBins();
  setInterval(loadBins, 15000);
}

async function loadBins() {
  state.bins = await api("/api/bins");
  document.querySelector("[data-bincount]").textContent = state.bins.length;
  const seen = new Set();
  for (const b of state.bins) {
    seen.add(b.id);
    const popup = `<b>${esc(b.name)}</b><br>${esc(b.zone || "")}<br>
      Status: <b style="color:${STATUS[b.status].color}">${STATUS[b.status].label}</b><br>
      <button class="btn sm" onclick="reportBin(${b.id})" style="margin-top:6px">🚨 Report this bin</button>`;
    if (state.markers[b.id]) {
      state.markers[b.id].setLatLng([b.lat, b.lng]).setIcon(binIcon(b.status)).setPopupContent(popup);
    } else {
      state.markers[b.id] = L.marker([b.lat, b.lng], { icon: binIcon(b.status) }).bindPopup(popup).addTo(map);
    }
  }
  for (const id of Object.keys(state.markers)) {
    if (!seen.has(Number(id))) { state.markers[id].remove(); delete state.markers[id]; }
  }
  if (state.me) renderNearest(false);
  if (state.type && state.type !== "no_bin") fillBinSelect();
  highlightTarget();
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const t of ["map", "nearest", "report"]) document.getElementById(`tab-${t}`).hidden = t !== name;
  if (name !== "nearest" && routeLine) { routeLine.remove(); routeLine = null; }
  if (name === "nearest") renderNearest();
  setTimeout(() => map.invalidateSize(), 50);
}

function locate() {
  const status = document.querySelectorAll("[data-locstatus]");
  if (!navigator.geolocation) {
    status.forEach((s) => (s.textContent = "GPS not available: tap the map instead"));
    return;
  }
  status.forEach((s) => (s.textContent = "Getting GPS fix…"));
  navigator.geolocation.getCurrentPosition(
    (p) => {
      setMe(p.coords.latitude, p.coords.longitude, `GPS fix ±${Math.round(p.coords.accuracy)} m`);
      map.setView([p.coords.latitude, p.coords.longitude], 18);
    },
    (err) => status.forEach((s) => (s.textContent =
      (err.code === 1 ? "GPS permission denied" : "No GPS fix") + ": tap the map instead")),
    { enableHighAccuracy: true, timeout: 10000 });
}

function setMe(lat, lng, how) {
  state.me = { lat, lng };
  if (!meMarker) {
    meMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else meMarker.setLatLng([lat, lng]);
  document.querySelectorAll("[data-locstatus]").forEach((s) => (s.textContent = `📍 ${how}`));
  renderNearest();
  if (state.type && state.type !== "no_bin") fillBinSelect();
  updateSubmit();
}

function byDistance(pred = () => true) {
  return state.bins.filter(pred)
    .map((b) => ({ ...b, d: distanceM(state.me.lat, state.me.lng, b.lat, b.lng) }))
    .sort((a, b) => a.d - b.d);
}

function renderNearest(fit = true) {
  const out = document.getElementById("nearest-out");
  if (!state.me || document.getElementById("tab-nearest").hidden) return;
  const avail = byDistance((b) => b.status === "ok");
  if (!avail.length) { out.innerHTML = "No available bins found."; return; }
  // Paths on campus are not straight lines: estimate walking distance as 1.3x straight line.
  const walk = (d) => Math.round(d * 1.3);
  const mins = (d) => Math.max(1, Math.round(walk(d) / state.walkSpeed / 60));
  const n = avail[0];
  const closestAny = byDistance()[0];
  const skipped = closestAny && closestAny.id !== n.id
    ? `<div class="small" style="margin-top:8px;color:#b91c1c">Skipped a closer bin (${esc(closestAny.name)}, ${Math.round(closestAny.d)} m): it is ${STATUS[closestAny.status].label.toLowerCase()}.</div>`
    : "";
  out.innerHTML = `
    <div class="card">
      <div class="nearest-main">
        <div class="big">${walk(n.d)} m</div>
        <div><b>${esc(n.name)}</b><div class="small muted">${esc(n.zone || "")} · ~${mins(n.d)} min walk</div></div>
      </div>
      ${skipped}
    </div>
    <div class="small muted" style="margin-top:10px">Other available bins</div>
    <ul class="list">${avail.slice(1, 4).map((b) =>
      `<li><span>${esc(b.name)}</span><span class="muted">${walk(b.d)} m · ${mins(b.d)} min</span></li>`).join("")}</ul>`;
  if (routeLine) routeLine.remove();
  routeLine = L.polyline([[state.me.lat, state.me.lng], [n.lat, n.lng]],
    { color: "#2563eb", weight: 4, dashArray: "8 8" }).addTo(map);
  if (fit) map.fitBounds(routeLine.getBounds(), { padding: [60, 60], maxZoom: 18 });
}

function chooseType(type) {
  state.type = type;
  document.querySelectorAll("#types button").forEach((b) => b.classList.toggle("sel", b.dataset.type === type));
  document.getElementById("bin-pick").hidden = type === "no_bin";
  if (type === "no_bin") state.target = null;
  else fillBinSelect();
  highlightTarget();
  updateSubmit();
}

function fillBinSelect() {
  const sel = document.getElementById("bin-select");
  const list = state.me ? byDistance().slice(0, 6) : state.bins;
  sel.innerHTML = `<option value="">Select a bin…</option>` + list.map((b) =>
    `<option value="${b.id}">${esc(b.name)}${b.d != null ? ` · ${Math.round(b.d)} m` : ""} (${STATUS[b.status].label})</option>`).join("");
  if (state.target && list.some((b) => b.id === state.target)) sel.value = state.target;
  else if (state.target) {
    const b = state.bins.find((x) => x.id === state.target);
    if (b) { sel.insertAdjacentHTML("beforeend", `<option value="${b.id}">${esc(b.name)}</option>`); sel.value = b.id; }
  }
}

window.reportBin = (id) => {
  map.closePopup();
  const b = state.bins.find((x) => x.id === id);
  if (!state.me) setMe(b.lat, b.lng, `At ${b.name}`);
  showTab("report");
  state.target = id;
  chooseType(b.status === "damaged" ? "damaged" : "overflowing");
};

function highlightTarget() {
  for (const b of state.bins) {
    const m = state.markers[b.id];
    if (m) m.setIcon(binIcon(b.status, b.id === state.target ? "target" : ""));
  }
}

function updateSubmit() {
  const btn = document.getElementById("submit"), hint = document.getElementById("submit-hint");
  let msg = "";
  if (!state.type) msg = "Choose a problem type.";
  else if (!state.me) msg = "Set a location: GPS or tap the map.";
  else if (state.type !== "no_bin" && !state.target) msg = "Select the bin.";
  btn.disabled = !!msg;
  hint.textContent = msg || "Ready to send.";
}

async function submit() {
  const btn = document.getElementById("submit");
  btn.disabled = true;
  try {
    const r = await api("/api/reports", {
      method: "POST",
      body: {
        type: state.type, lat: state.me.lat, lng: state.me.lng,
        bin_id: state.type === "no_bin" ? null : state.target,
        note: document.getElementById("note").value,
        reporter: document.getElementById("reporter").value,
      },
    });
    toast(`✅ Report #${r.id} sent. Thank you!`);
    document.getElementById("note").value = "";
    state.type = null; state.target = null;
    document.querySelectorAll("#types button").forEach((b) => b.classList.remove("sel"));
    document.getElementById("bin-pick").hidden = true;
    await loadBins();
  } catch (e) {
    toast(e.message, "err");
  }
  updateSubmit();
}

init().catch((e) => toast("Could not reach the server: " + e.message, "err"));
