// GET /api/denah?url=<Google Maps link>&address=<nama/alamat>&lat=<>&lon=<>
// Mengembalikan denah lokasi sebagai SVG vektor (image/svg+xml).
// Server yang mengambil data peta: HP customer hanya menerima SVG ~4 KB,
// tanpa harus mengunduh data mentah OpenStreetMap atau menunggu Overpass.
//
// Alur:
//  1. Tentukan koordinat: dari lat/lon langsung, dari link Google Maps
//     (link pendek maps.app.goo.gl diikuti redirect-nya di server,
//     lalu koordinat dibaca dari URL akhir @lat,lng / !3d/!4d),
//     atau dari geocode alamat (Nominatim, cadangan Photon).
//  2. Ambil data jalan & patokan sekitar (±350 m) dari OSM API
//     (api.openstreetmap.org/api/0.6/map.json) — cepat, tanpa Overpass.
//  3. Bangun SVG vektor dengan desain yang sama seperti denah Heritage
//     (jalan venue oranye tebal, pin merah, ikon masjid/sekolah).
//  4. Cache per koordinat (s-maxage 1 hari) supaya venue yang sama
//     langsung terlayani tanpa mengambil data lagi.
//
// Error JSON: {error:"notfound"} (alamat tidak ketemu),
//             {error:"mapfail"} (data peta tidak bisa diambil),
//             {error:"badinput"} (tidak ada url/address/lat+lon).

const UA = "rancangnikah-denah/1.0 (https://rancangnikah.vercel.app)";
const HALF = 350; // meter, setengah lebar area denah
const VB = 240;   // viewBox SVG

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function fetchTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- koordinat dari link Google Maps -------------------------------
function coordsFromMapsUrl(u) {
  try {
    const url = new URL(u);
    // @lat,lng,zoomz
    let m = url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
      || url.hash.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
      || u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
    // !3dlat!4dlon
    m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
    return null;
  } catch { return null; }
}

function placeNameFromMapsUrl(u) {
  try {
    const m = decodeURIComponent(u).match(/\/place\/([^\/@]+)/);
    if (!m) return null;
    return m[1].replace(/\+/g, " ").replace(/,/g, ", ").trim() || null;
  } catch { return null; }
}

// --- geocode ---------------------------------------------------------
async function geocodeNominatim(q) {
  const r = await fetchTimeout(
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=id&q=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 5000);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.length) return null;
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
}

async function geocodePhoton(q) {
  const r = await fetchTimeout(
    "https://photon.komoot.io/api/?limit=1&lang=id&q=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 5000);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry || !f.geometry.coordinates) return null;
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
}

async function geocode(q) {
  try { const a = await geocodeNominatim(q); if (a) return a; } catch {}
  try { return await geocodePhoton(q); } catch { return null; }
}

// --- data OSM --------------------------------------------------------
async function fetchOsmBbox(lat, lon) {
  const KX = 111320 * Math.cos(lat * Math.PI / 180), KY = 110540;
  const dLon = HALF / KX, dLat = HALF / KY;
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
    .map((v) => v.toFixed(6)).join(",");
  const r = await fetchTimeout(
    "https://api.openstreetmap.org/api/0.6/map.json?bbox=" + bbox,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 8000);
  if (!r.ok) return null;
  return r.json();
}

// --- geometri --------------------------------------------------------
function project(lat0, lon0, lat, lon) {
  const KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110540;
  return [(lon - lon0) * KX, (lat - lat0) * KY];
}
function toV(mx, my) {
  return [VB / 2 + (mx * VB) / (2 * HALF), VB / 2 - (my * VB) / (2 * HALF)];
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  function perp(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    if (!L2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function rec(ps) {
    if (ps.length <= 2) return ps;
    const a = ps[0], b = ps[ps.length - 1];
    let dmax = 0, idx = 0;
    for (let i = 1; i < ps.length - 1; i++) {
      const dd = perp(ps[i], a, b);
      if (dd > dmax) { dmax = dd; idx = i; }
    }
    if (dmax > tol) return rec(ps.slice(0, idx + 1)).slice(0, -1).concat(rec(ps.slice(idx)));
    return [a, b];
  }
  return rec(pts);
}

// --- bangun SVG ------------------------------------------------------
const MAIN = new Set(["motorway", "primary", "secondary", "tertiary"]);

function buildDenahSvg(lat0, lon0, data, roadLabelOverride) {
  const nodes = new Map();
  for (const e of data.elements || []) {
    if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
  }
  const roads = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    if (e.type !== "way" || !t.highway || !t.name) continue;
    const mpts = [];
    for (const nid of e.nodes || []) {
      const n = nodes.get(nid);
      if (!n) continue;
      const [mx, my] = project(lat0, lon0, n[0], n[1]);
      if (Math.abs(mx) <= HALF * 1.15 && Math.abs(my) <= HALF * 1.15) mpts.push([mx, my]);
    }
    if (mpts.length < 2) continue;
    const dist = Math.min(...mpts.map(([mx, my]) => Math.hypot(mx, my)));
    roads.push({ name: t.name, cls: t.highway, pts: simplify(mpts, 8), dist });
  }
  if (!roads.length) return null;
  const venueRoad = roads.reduce((a, b) => (b.dist < a.dist ? b : a)).name;

  const pathD = (mpts) => "M" + mpts.map(([mx, my]) => {
    const [x, y] = toV(mx, my);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" L");

  const P = [`<rect x="0" y="0" width="${VB}" height="${VB}" fill="#FDFBF3"/>`];
  for (const r of roads) {
    if (MAIN.has(r.cls)) continue;
    P.push(`<path d="${pathD(r.pts)}" fill="none" stroke="#C9C2B2" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const r of roads) {
    if (!MAIN.has(r.cls)) continue;
    const col = r.name === venueRoad ? "#E07856" : "#F3E9CF";
    const w = r.name === venueRoad ? 5.5 : 4;
    const d = pathD(r.pts);
    P.push(`<path d="${d}" fill="none" stroke="#A89F8C" stroke-width="${w + 1.6}" stroke-linecap="round" stroke-linejoin="round"/>`);
    P.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  function labelAlong(name, mpts, size) {
    const vpts = mpts.map(([mx, my]) => toV(mx, my));
    let best = null, bl = 0;
    for (let i = 0; i < vpts.length - 1; i++) {
      const [x1, y1] = vpts[i], [x2, y2] = vpts[i + 1];
      const ln = Math.hypot(x2 - x1, y2 - y1);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const central = 1 - Math.max(Math.abs(mx - VB / 2), Math.abs(my - VB / 2)) / (VB / 2);
      const score = ln * (0.5 + central);
      if (score > bl) { bl = score; best = [[x1, y1], [x2, y2]]; }
    }
    if (!best || bl < 12) return "";
    const [[x1, y1], [x2, y2]] = best;
    let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const short = name.replace(/^Jalan /, "Jl. ");
    return `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle" transform="rotate(${ang.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})" font-family="Verdana, DejaVu Sans, sans-serif" font-size="${size}" fill="#6E6759">${esc(short)}</text>`;
  }
  const bestLabel = new Map();
  for (const r of roads) {
    const vpts = r.pts.map(([mx, my]) => toV(mx, my));
    const bl = Math.max(0, ...vpts.slice(0, -1).map((a, i) => Math.hypot(vpts[i + 1][0] - a[0], vpts[i + 1][1] - a[1])));
    if (!bestLabel.has(r.name) || bl > bestLabel.get(r.name)[0]) bestLabel.set(r.name, [bl, r.pts]);
  }
  for (const [name, [, mpts]] of bestLabel) {
    if (name !== venueRoad) continue; // hanya jalan venue yang dilabeli
    // Nama jalan di OSM kadang pendek ("Cifor"); bila alamat/URL menyebut
    // nama lengkapnya ("Jl. Raya Cifor"), pakai nama lengkap itu.
    let disp = name;
    if (roadLabelOverride && roadLabelOverride.toLowerCase().includes(name.toLowerCase())) disp = roadLabelOverride;
    P.push(labelAlong(disp, mpts, 7));
  }

  const mosqueSym = (x, y, col) =>
    `<g fill="${col}"><circle cx="${x.toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="6.5"/>` +
    `<rect x="${(x - 6.5).toFixed(1)}" y="${(y - 2).toFixed(1)}" width="13" height="4"/>` +
    `<rect x="${(x - 1.5).toFixed(1)}" y="${(y - 11).toFixed(1)}" width="3" height="9"/>` +
    `<circle cx="${x.toFixed(1)}" cy="${(y - 12).toFixed(1)}" r="2.5"/></g>`;
  const schoolSym = (x, y, col) =>
    `<g fill="${col}"><polygon points="${(x - 6).toFixed(1)},${(y + 4).toFixed(1)} ${(x + 6).toFixed(1)},${(y + 4).toFixed(1)} ${x.toFixed(1)},${(y - 5).toFixed(1)}"/>` +
    `<rect x="${(x - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" width="12" height="2"/></g>`;

  const pois = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    if (t.amenity !== "place_of_worship" && t.amenity !== "school") continue;
    if (!t.name) continue;
    let la, lo;
    if (e.type === "node") { la = e.lat; lo = e.lon; }
    else {
      const pts = (e.nodes || []).map((n) => nodes.get(n)).filter(Boolean);
      if (!pts.length) continue;
      la = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      lo = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    }
    const [mx, my] = project(lat0, lon0, la, lo);
    if (Math.abs(mx) > HALF || Math.abs(my) > HALF) continue;
    pois.push({ d: Math.hypot(mx, my), name: t.name, am: t.amenity, mx, my });
  }
  pois.sort((a, b) => a.d - b.d);
  const mosque = pois.find((p) => p.am === "place_of_worship");
  const school = pois.find((p) => p.am === "school");
  for (const p of [mosque, school]) {
    if (!p) continue;
    const [x, y] = toV(p.mx, p.my);
    P.push(p.am === "place_of_worship" ? mosqueSym(x, y, "#2E7D6B") : schoolSym(x, y, "#3E6FB0"));
    const short = p.name.length <= 22 ? p.name : p.name.slice(0, 21) + "…";
    P.push(`<text x="${x.toFixed(1)}" y="${(y + 22).toFixed(1)}" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="#4A4438">${esc(short)}</text>`);
  }

  const [vx, vy] = toV(0, 0);
  P.push(`<g><ellipse cx="${vx.toFixed(1)}" cy="${(vy - 2).toFixed(1)}" rx="11" ry="11" fill="#C0392B" stroke="white" stroke-width="1.5"/>` +
    `<polygon points="${(vx - 6).toFixed(1)},${(vy + 4).toFixed(1)} ${(vx + 6).toFixed(1)},${(vy + 4).toFixed(1)} ${vx.toFixed(1)},${(vy + 14).toFixed(1)}" fill="#C0392B"/>` +
    `<circle cx="${vx.toFixed(1)}" cy="${(vy - 2).toFixed(1)}" r="4" fill="white"/></g>`);
  P.push(`<g><circle cx="222" cy="18" r="10" fill="white" stroke="#4A4438" stroke-width="1.2"/>` +
    `<polygon points="222,10 217,21 227,21" fill="#4A4438"/>` +
    `<text x="222" y="34" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="#4A4438">U</text></g>`);
  P.push(`<rect x="1" y="1" width="${VB - 2}" height="${VB - 2}" fill="none" stroke="#B9B2A2" stroke-width="2"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${VB}" height="${VB}">\n${P.join("\n")}\n</svg>`;
}

// --- handler ---------------------------------------------------------
module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    let lat = parseFloat(q.lat), lon = parseFloat(q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { lat = NaN; lon = NaN; }

    let nameSource = q.address || "";
    if (!Number.isFinite(lat) && q.url) {
      let finalUrl = q.url;
      // Link pendek (maps.app.goo.gl) tidak boleh diikuti sampai ke
      // google.com — halaman Google sering memblokir fetch server
      // (consent page) sehingga URL akhirnya kehilangan nama tempat.
      // Cukup baca header Location dari 302-nya: URL tujuan itu sudah
      // memuat /place/<nama>/ yang bisa di-geocode.
      try {
        const r = await fetchTimeout(q.url, { redirect: "manual" }, 5000);
        const loc = r && r.headers && r.headers.get && r.headers.get("location");
        if (loc) finalUrl = new URL(loc, q.url).toString();
        else {
          const r2 = await fetchTimeout(q.url, { redirect: "follow" }, 6000);
          if (r2 && r2.url) finalUrl = r2.url;
        }
      } catch {}
      nameSource = placeNameFromMapsUrl(finalUrl) || finalUrl;
      const c = coordsFromMapsUrl(finalUrl);
      if (c) { lat = c.lat; lon = c.lon; }
      else {
        const name = placeNameFromMapsUrl(finalUrl) || q.url;
        const g = await geocode(name);
        if (g) { lat = g.lat; lon = g.lon; }
      }
    }
    if (!Number.isFinite(lat) && q.address) {
      const g = await geocode(q.address);
      if (g) { lat = g.lat; lon = g.lon; }
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      res.status(404).json({ error: "notfound" });
      return;
    }

    const data = await fetchOsmBbox(lat, lon);
    if (!data) { res.status(502).json({ error: "mapfail" }); return; }
    // Nama jalan lengkap dari alamat/URL, mis. "Jl. Raya Cifor".
    const srcText = nameSource;
    const rm = srcText.match(/Jl\.\s*[A-Za-z]+(?:\s+[A-Za-z]+)*?(?=\s+No\.|\s*,|\s*$)/);
    const svg = buildDenahSvg(lat, lon, data, rm ? rm[0].trim() : null);
    if (!svg) { res.status(502).json({ error: "mapfail" }); return; }

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=86400, max-age=3600");
    res.status(200).send(svg);
  } catch (e) {
    res.status(502).json({ error: "mapfail" });
  }
};

// Untuk pengujian lokal (node): node -e "require('./api/denah.js')._test()"
module.exports._test = { coordsFromMapsUrl, placeNameFromMapsUrl, buildDenahSvg };
