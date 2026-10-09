// Student app. The home screen answers one question — where is the nearest bin I
// can use, and how far is it — and everything else sits one tap underneath it.

const state = {
  me: null, bins: [], markers: {}, nearest: null,
  walkSpeed: 1.3, locating: true, locError: "", pinMode: false, routeTo: null,
  draft: { type: null, bin: null, reason: null },
};
let map, cluster, meMarker, routeLine, dropMarker;

async function init() {
  const campus = await api("/api/campus");
  state.walkSpeed = campus.settings.walking_speed_mps;
  const base = baseMap("map", campus.center, 17);
  map = base.map;
  L.control.layers(base.layers, {}, { position: "topright" }).addTo(map);
  // Campus place names, from our own zone list rather than the tiles. They appear
  // at walking zoom only: pulled back they would overlap each other and the pins.
  const places = L.layerGroup((campus.places || []).map((z) => L.marker([z.lat, z.lng], {
    interactive: false,
    icon: L.divIcon({ className: "", html: `<div class="place">${esc(z.name)}</div>`, iconSize: [0, 0] }),
  })));
  const showPlaces = () => (map.getZoom() >= 18 ? places.addTo(map) : places.remove());
  map.on("zoomend", showPlaces);
  showPlaces();

  // Bins only collapse into a cluster when the map is pulled back far enough that
  // the pins would sit on top of each other; walking zoom always shows every bin.
  cluster = L.markerClusterGroup({
    maxClusterRadius: 44,
    disableClusteringAtZoom: 18,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: (c) => L.divIcon({
      className: "",
      html: `<div class="cluster-pin">${c.getChildCount()}</div>`,
      iconSize: [38, 38], iconAnchor: [19, 19],
    }),
  }).addTo(map);

  map.on("click", (e) => {
    if (state.pinMode) return movePin(e.latlng.lat, e.latlng.lng);
    if (!state.me || state.locError) setMe(e.latlng.lat, e.latlng.lng);
  });

  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeModal();
  });
  document.getElementById("pin-cancel").addEventListener("click", cancelPin);
  document.getElementById("pin-confirm").addEventListener("click", confirmPin);

  await loadBins();
  if (!applyScannedBin()) locate();
  setInterval(loadBins, 15000);
}

// A QR sticker on a bin links to /?bin=7, so scanning it opens the bin-issue form
// with that bin already chosen: no GPS, no searching a list.
function applyScannedBin() {
  const params = new URLSearchParams(location.search);
  const b = state.bins.find((x) => x.id === Number(params.get("bin")));
  if (!b) return false;
  setMe(b.lat, b.lng);
  map.setView([b.lat, b.lng], 19);
  const type = params.get("type");
  openBinIssue(b.id, REPORT_LABEL[type] && type !== "no_bin" ? type
    : b.status === "damaged" ? "damaged" : "overflowing");
  return true;
}

// Anonymous per-browser id: lets the server hold one report per phone, per bin, per
// day without anyone creating an account.
function deviceId() {
  try {
    let id = localStorage.getItem("binfinder_device");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + Date.now();
      localStorage.setItem("binfinder_device", id);
    }
    return id;
  } catch {
    return "";
  }
}

/* ------------------------------- data ---------------------------------- */

async function loadBins() {
  state.bins = await api("/api/bins");
  const seen = new Set();
  for (const b of state.bins) {
    seen.add(b.id);
    if (state.markers[b.id]) {
      state.markers[b.id].setLatLng([b.lat, b.lng]);
    } else {
      const mk = L.marker([b.lat, b.lng], { icon: binIcon(b.status) });
      mk.bindPopup(() => binPopup(b.id), { maxWidth: 260, autoPanPadding: [20, 20] });
      mk.on("popupopen", () => { state.routeTo = b.id; renderAnswer(); });
      mk.on("popupclose", () => { state.routeTo = null; renderAnswer(); });
      state.markers[b.id] = mk;
      cluster.addLayer(mk);
    }
  }
  for (const id of Object.keys(state.markers)) {
    if (!seen.has(Number(id))) { cluster.removeLayer(state.markers[id]); delete state.markers[id]; }
  }
  highlight(state.nearest && state.nearest.id);
  renderAnswer();
}

function distanceTo(b) {
  return state.me ? distanceM(state.me.lat, state.me.lng, b.lat, b.lng) : null;
}

// Campus paths are not straight lines, so a straight-line distance understates the
// walk. 1.3x is the usual planning rule of thumb and is stated in the write-up.
const walkM = (d) => Math.round(d * 1.3);
const walkMin = (d) => Math.max(1, Math.round(walkM(d) / state.walkSpeed / 60));

function byDistance(pred = () => true) {
  return state.bins.filter(pred)
    .map((b) => ({ ...b, d: distanceTo(b) }))
    .sort((a, b) => a.d - b.d);
}

/* ------------------------------ location -------------------------------- */

function locate() {
  state.locating = true;
  state.locError = "";
  renderAnswer();
  if (!navigator.geolocation) return locateFailed("This browser cannot share a location.");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      setMe(p.coords.latitude, p.coords.longitude);
      map.setView([p.coords.latitude, p.coords.longitude], 18);
    },
    (err) => locateFailed(err.code === 1 ? "Location permission was turned down."
      : "We could not get a GPS fix."),
    // A fix the phone already took in the last minute is good enough for "which
    // bin is nearest" and returns instantly, which is what keeps the answer
    // inside five seconds on a real phone.
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function locateFailed(why) {
  state.locating = false;
  state.locError = why;
  renderAnswer();
}

function setMe(lat, lng) {
  state.me = { lat, lng };
  state.locating = false;
  state.locError = "";
  if (!meMarker) {
    meMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "", html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else meMarker.setLatLng([lat, lng]);
  renderAnswer();
}

/* ------------------------------- answer --------------------------------- */

function renderAnswer() {
  const out = document.getElementById("answer");
  if (state.locating) {
    out.innerHTML = `<div class="answer-card loading">
      <div class="spin"></div>
      <div><b>Finding your location…</b>
        <div class="small muted">Allow location so we can show the nearest bin.</div></div>
    </div>`;
    return;
  }
  if (!state.me) {
    out.innerHTML = `<div class="answer-card">
      <div><b>${esc(state.locError || "Location unknown")}</b>
        <div class="small muted">Tap the map where you are standing, or try again.</div></div>
      <div class="answer-actions">
        <button class="btn primary big" id="a-retry">📡 Use my location</button>
        <button class="btn link" id="a-report">Report a problem</button>
      </div>
    </div>`;
    document.getElementById("a-retry").addEventListener("click", locate);
    document.getElementById("a-report").addEventListener("click", openChooser);
    return;
  }

  const available = byDistance((b) => b.status === "ok");
  const n = available[0];
  if (!n) {
    out.innerHTML = `<div class="answer-card">
      <div><b>No available bin on campus right now</b>
        <div class="small muted">Every mapped bin is reported overflowing or damaged.</div></div>
      <div class="answer-actions">
        <button class="btn primary big" id="a-report">Request a bin here</button>
      </div>
    </div>`;
    document.getElementById("a-report").addEventListener("click", startPinDrop);
    drawRoute(null);
    return;
  }

  state.nearest = n;
  const closest = byDistance()[0];
  const skipped = closest && closest.id !== n.id
    ? `<div class="skipped small">Skipped ${esc(closest.name)} ${walkM(closest.d)} m away —
         it is ${STATUS[closest.status].label.toLowerCase()}.</div>`
    : "";
  out.innerHTML = `
    <div class="answer-card">
      <div class="answer-top">
        <div class="dist"><b>${walkM(n.d)}</b><span>m</span></div>
        <div class="answer-who">
          <div class="label">Nearest available bin</div>
          <div class="name">${esc(n.name)}</div>
          <div class="small"><span class="chip ok">${STATUS.ok.label}</span>
            <span class="muted">· ~${walkMin(n.d)} min walk</span></div>
          <div class="small muted">${esc(n.zone || "")} · updated ${ago(n.status_at || n.created_at)}</div>
        </div>
      </div>
      ${skipped}
      <div class="answer-actions">
        <button class="btn primary big" id="a-dir">➤ Directions</button>
        <button class="btn link" id="a-report">Report a problem</button>
      </div>
    </div>`;
  document.getElementById("a-dir").addEventListener("click", () => directionsTo(n.id));
  document.getElementById("a-report").addEventListener("click", openChooser);
  const tapped = state.routeTo && state.bins.find((b) => b.id === state.routeTo);
  drawRoute(tapped || n);
  highlight(tapped ? tapped.id : n.id);
}

function highlight(id) {
  for (const b of state.bins) {
    const mk = state.markers[b.id];
    if (mk) mk.setIcon(binIcon(b.status, b.id === id ? "target" : ""));
  }
}

function drawRoute(bin, fit = false) {
  if (routeLine) { routeLine.remove(); routeLine = null; }
  if (!bin || !state.me) return;
  routeLine = L.polyline([[state.me.lat, state.me.lng], [bin.lat, bin.lng]],
    { color: "#1d4ed8", weight: 5, opacity: .85, dashArray: "9 9" }).addTo(map);
  if (fit) map.fitBounds(routeLine.getBounds(), { padding: [50, 50], maxZoom: 19 });
}

// Walking directions open in the phone's own map app, which knows the footpaths.
// The dashed line on our map shows the direction and distance before they leave.
function directionsTo(id) {
  const b = state.bins.find((x) => x.id === id);
  if (!b) return;
  map.closePopup();
  drawRoute(b, true);
  const from = state.me ? `${state.me.lat},${state.me.lng}` : "";
  window.open(`https://www.google.com/maps/dir/?api=1&origin=${from}&destination=${b.lat},${b.lng}&travelmode=walking`,
    "_blank", "noopener");
}
window.directionsTo = directionsTo;

/* ------------------------------- popup ---------------------------------- */

function binPopup(id) {
  const b = state.bins.find((x) => x.id === id);
  if (!b) return "";
  const d = distanceTo(b);
  return `<div class="binpop">
    <b>${esc(b.name)}</b>
    <div class="small"><span class="chip ${b.status}">${STATUS[b.status].label}</span>
      ${d != null ? `· ${walkM(d)} m away` : ""}</div>
    <div class="small muted">Updated ${ago(b.status_at || b.created_at)}</div>
    <button class="btn primary sm" onclick="directionsTo(${b.id})">➤ Directions</button>
    <a href="#" class="small" onclick="reportBin(${b.id});return false">Report this bin</a>
  </div>`;
}

window.reportBin = (id) => {
  map.closePopup();
  const b = state.bins.find((x) => x.id === id);
  openBinIssue(id, b && b.status === "damaged" ? "damaged" : "overflowing");
};

/* ------------------------------ modal ----------------------------------- */

function openModal(title, html) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("overlay").hidden = false;
}

function closeModal() {
  document.getElementById("overlay").hidden = true;
}

// Two reporting flows, kept apart from the first tap, because they answer two
// different questions for the team: fix this bin, or put a bin here.
function openChooser() {
  openModal("Report a problem", `
    <button class="choice" id="c-issue">
      <span class="ci">🗑️</span>
      <span><b>Report a bin issue</b><br><span class="small muted">A bin is full or damaged</span></span>
    </button>
    <button class="choice" id="c-request">
      <span class="ci">📍</span>
      <span><b>Request a bin here</b><br><span class="small muted">There is no bin in this spot</span></span>
    </button>`);
  document.getElementById("c-issue").addEventListener("click", () => openBinIssue());
  document.getElementById("c-request").addEventListener("click", startPinDrop);
}

function openBinIssue(binId = null, type = null) {
  state.draft = { type, bin: binId ?? (state.nearest && state.nearest.id) ?? null, reason: null };
  const list = state.me ? byDistance().slice(0, 8) : state.bins.slice(0, 8);
  openModal("Report a bin issue", `
    <label class="field" for="r-bin">Which bin?</label>
    <select id="r-bin">${list.map((b) =>
      `<option value="${b.id}">${esc(b.name)}${b.d != null ? ` · ${walkM(b.d)} m` : ""}</option>`).join("")}</select>
    <label class="field">What is wrong?</label>
    <div class="types" id="r-types">
      <button data-type="overflowing"><span>🗑️</span>Full / overflowing</button>
      <button data-type="damaged"><span>🔧</span>Damaged</button>
    </div>
    <label class="field" for="r-note">Details (optional)</label>
    <textarea id="r-note" maxlength="500" placeholder="e.g. bags on the floor beside it"></textarea>
    <button class="btn primary big full" id="r-send" disabled>Send report</button>
    <div class="small muted hint" id="r-hint">Choose what is wrong.</div>`);

  const sel = document.getElementById("r-bin");
  if (state.draft.bin && list.some((b) => b.id === state.draft.bin)) sel.value = state.draft.bin;
  else state.draft.bin = Number(sel.value) || null;
  sel.addEventListener("change", () => { state.draft.bin = Number(sel.value) || null; syncIssue(); });
  document.querySelectorAll("#r-types button").forEach((btn) =>
    btn.addEventListener("click", () => { state.draft.type = btn.dataset.type; syncIssue(); }));
  document.getElementById("r-send").addEventListener("click", sendIssue);
  syncIssue();
}

function syncIssue() {
  document.querySelectorAll("#r-types button").forEach((b) =>
    b.classList.toggle("sel", b.dataset.type === state.draft.type));
  const ok = state.draft.type && state.draft.bin;
  document.getElementById("r-send").disabled = !ok;
  document.getElementById("r-hint").textContent = ok ? "One report per bin, per day, from this phone."
    : !state.draft.bin ? "Choose the bin." : "Choose what is wrong.";
}

async function sendIssue() {
  const b = state.bins.find((x) => x.id === state.draft.bin);
  await send({
    type: state.draft.type,
    lat: b.lat, lng: b.lng, bin_id: b.id,
    note: document.getElementById("r-note").value,
  });
}

/* --------------------------- request a bin ------------------------------- */

function startPinDrop() {
  closeModal();
  state.pinMode = true;
  document.getElementById("pinbar").hidden = false;
  document.body.classList.add("pinning");
  const at = state.me || map.getCenter();
  const lat = at.lat, lng = at.lng ?? at.lon;
  dropMarker = L.marker([lat, lng], {
    draggable: true,
    icon: L.divIcon({ className: "", html: '<div class="drop-pin"></div>', iconSize: [32, 40], iconAnchor: [16, 38] }),
    zIndexOffset: 1200,
  }).addTo(map);
  map.setView([lat, lng], Math.max(map.getZoom(), 18));
}

function movePin(lat, lng) {
  if (dropMarker) dropMarker.setLatLng([lat, lng]);
}

function endPinMode() {
  state.pinMode = false;
  document.getElementById("pinbar").hidden = true;
  document.body.classList.remove("pinning");
  if (dropMarker) { dropMarker.remove(); dropMarker = null; }
}

function cancelPin() {
  endPinMode();
}

function confirmPin() {
  const p = dropMarker.getLatLng();
  endPinMode();
  openBinRequest(p.lat, p.lng);
}

function openBinRequest(lat, lng) {
  state.draft = { type: "no_bin", bin: null, reason: null, lat, lng };
  const near = state.bins
    .map((b) => ({ ...b, d: distanceM(lat, lng, b.lat, b.lng) }))
    .sort((a, b) => a.d - b.d)[0];
  openModal("Request a bin here", `
    <div class="pinned small">📍 Spot marked${near ? ` · nearest bin is ${esc(near.name)}, ${walkM(near.d)} m away` : ""}</div>
    <label class="field">Why is a bin needed here?</label>
    <div class="reasons" id="r-reasons">${Object.entries(BIN_REASONS).map(([k, v]) =>
      `<button data-reason="${k}">${esc(v)}</button>`).join("")}</div>
    <label class="field" for="r-note">Details (optional)</label>
    <textarea id="r-note" maxlength="500" placeholder="e.g. students eat here between lectures"></textarea>
    <button class="btn primary big full" id="r-send" disabled>Send request</button>
    <div class="small muted hint" id="r-hint">Choose a reason.</div>`);
  document.querySelectorAll("#r-reasons button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.draft.reason = btn.dataset.reason;
      document.querySelectorAll("#r-reasons button").forEach((o) =>
        o.classList.toggle("sel", o === btn));
      document.getElementById("r-send").disabled = false;
      document.getElementById("r-hint").textContent = "One request per spot, per day, from this phone.";
    }));
  document.getElementById("r-send").addEventListener("click", () => send({
    type: "no_bin", lat: state.draft.lat, lng: state.draft.lng, bin_id: null,
    reason: state.draft.reason, note: document.getElementById("r-note").value,
  }));
}

/* ------------------------- send and confirm ------------------------------ */

async function send(payload) {
  const btn = document.getElementById("r-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const r = await api("/api/reports", { method: "POST", body: { ...payload, device_id: deviceId() } });
    await loadBins();
    showConfirmation(r);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = payload.type === "no_bin" ? "Send request" : "Send report";
    document.getElementById("r-hint").textContent = e.message;
    toast(e.message, "err");
  }
}

// Step 4 of the flow: say exactly what was recorded, so the student can see their
// report landed on the right bin and that the map now shows it.
function showConfirmation(r) {
  const row = (k, v) => `<div class="rk">${k}</div><div class="rv">${v}</div>`;
  const where = r.bin ? esc(r.bin) : `Pin dropped${r.zone ? ` in ${esc(r.zone)}` : ""}`;
  const status = r.bin
    ? `${STATUS[r.bin_status].label} · updated ${ago(r.bin_status_at)}`
    : "Added to the bin-request list for the campus team";
  openModal("Report received", `
    <div class="confirm">
      <div class="tick">✅</div>
      <h3>Thank you — it is recorded</h3>
      <div class="recap">
        ${row("Reference", `#${r.id}`)}
        ${row("What", esc(REPORT_LABEL[r.type]) + (r.reason ? ` · ${esc(BIN_REASONS[r.reason])}` : ""))}
        ${row("Where", where)}
        ${row("Now shows", esc(status))}
      </div>
      ${r.zone_week_count > 1
        ? `<div class="weekly small">${r.zone_week_count} reports from this area in the last 7 days.</div>` : ""}
      <button class="btn primary big full" id="r-done">Done</button>
    </div>`);
  document.getElementById("r-done").addEventListener("click", closeModal);
}

init().catch((e) => toast("Could not reach the server: " + e.message, "err"));
