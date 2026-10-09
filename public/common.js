// Shared helpers for the student app and admin dashboard.

// The deployed dashboard asks for an admin key once and keeps it in this browser.
// Locally (no ADMIN_PASSWORD set) the server never asks, so this stays unused.
function adminKey() {
  try { return localStorage.getItem("binfinder_admin_key") || ""; } catch { return ""; }
}

function setAdminKey(key) {
  try { localStorage.setItem("binfinder_admin_key", key); } catch { /* private mode */ }
}

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  const key = adminKey();
  if (key) headers["X-Admin-Key"] = key;
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.retried) {
    const entered = prompt("Admin key required for this action:");
    if (entered) {
      setAdminKey(entered);
      return api(path, { ...opts, retried: true });
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Status is carried by shape AND glyph as well as colour: a red and a green circle
// look the same to a colour-blind student, and almost the same on a phone held in
// direct sunlight. Circle = available, diamond = overflowing, square = damaged.
const STATUS = {
  ok: { label: "Available", color: "#0f7a3d", shape: "circle", glyph: "✓" },
  full: { label: "Overflowing", color: "#c81e1e", shape: "diamond", glyph: "!" },
  damaged: { label: "Damaged", color: "#4b5563", shape: "square", glyph: "✕" },
};

const REPORT_LABEL = { no_bin: "Bin requested here", overflowing: "Overflowing bin", damaged: "Damaged bin" };

// Why a bin is wanted somewhere there is none. Kept short enough to tap once.
const BIN_REASONS = {
  litter_on_ground: "Litter ends up on the ground here",
  long_walk: "Nearest bin is too far",
  busy_spot: "Busy spot with no bin",
  other: "Other reason",
};

function binIcon(status, extra = "") {
  const st = STATUS[status];
  return L.divIcon({
    className: "",
    html: `<div class="bin-pin ${st.shape} ${extra}" style="--c:${st.color}"><span>${st.glyph}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

// Street map first: building and road names are what tell a student which block a
// bin is beside. Satellite stays available for the team when placing bins.
function baseMap(el, center, zoom = 17, base = "street") {
  const map = L.map(el, { zoomControl: true }).setView(center, zoom);
  const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap contributors",
  });
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery © Esri" });
  (base === "street" ? street : satellite).addTo(map);
  return { map, layers: { Street: street, Satellite: satellite } };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
}
