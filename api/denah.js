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
//  3. Bangun SVG vektor gaya contoh undangan (Awa Mangkuruku): jalan coklat,
//     semua jalan berlabel, patokan beragam berikon coklat, venue = pin merah
//     + bubble nama merah.
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
    "https://photon.komoot.io/api/?limit=1&lang=en&q=" + encodeURIComponent(q),
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 5000);
  if (!r.ok) return null;
  const j = await r.json();
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry || !f.geometry.coordinates) return null;
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
}

async function geocode(q) {
  // Nominatim/Photon sering gagal pada alamat lengkap ("..., RT.01")
  // tetapi berhasil pada nama venue saja ("Genus Coffee & Boutique").
  const variants = [q];
  const first = q.split(",")[0].trim();
  if (first && first !== q) variants.push(first);
  for (const v of variants) {
    try { const a = await geocodeNominatim(v); if (a) return a; } catch {}
    try { const b = await geocodePhoton(v); if (b) return b; } catch {}
  }
  return null;
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
// Gaya contoh undangan (Gedung Pertemuan Awa Mangkuruku): jalan coklat,
// semua jalan berlabel mengikuti arah jalan, patokan beragam berikon coklat,
// venue = pin merah + bubble nama merah. Sama seperti generator Python
// (make_denah_v2.py) yang dipakai untuk SVG bundel.
const MAIN_CLS = new Set(["motorway", "primary", "secondary", "tertiary", "trunk"]);
const C_BG = "#F8F4EB", C_EDGE = "#6E4520", C_MAIN = "#8B5A2B", C_MINOR = "#B08D5F";
const C_LABEL = "#5C3D1E", C_ICON = "#6B4A2F", C_RED = "#C0392B", C_FRAME = "#8B5A2B";

function toVh(mx, my, half) {
  return [VB / 2 + (mx * VB) / (2 * half), VB / 2 - (my * VB) / (2 * half)];
}
function dispName(name) {
  const n = name.trim();
  if (/^jalan /i.test(n)) return "Jl. " + n.slice(6);
  if (/^gang /i.test(n)) return "Gg. " + n.slice(5);
  if (!/^(Jl\.|Gg\.|Jl )/i.test(n)) return "Jl. " + n;
  return n;
}
function junkName(name) {
  const u = name.trim().toUpperCase();
  return u === "JALAN" || u.includes("PARKIRAN") || u === "";
}
function cleanPoiName(name) {
  let n = name.trim().replace(/=+$/, "").trim();
  if (n === n.toUpperCase() && n.length > 3) {
    n = n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    for (const a of ["Sd ", "Smp ", "Tk ", "Sma ", "Smk "]) n = n.replace(new RegExp(a, "g"), a.toUpperCase());
  }
  return n;
}
function wrap2(name, maxlen) {
  maxlen = maxlen || 14;
  if (name.length <= maxlen) return [name];
  const words = name.split(" ");
  if (words.length < 2) return [name.slice(0, maxlen) + "…"];
  let best = 1, bd = 99;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(" ").length, l2 = words.slice(i).join(" ").length;
    const d = Math.abs(l1 - l2) + (Math.max(l1, l2) <= maxlen + 4 ? 0 : 10);
    if (d < bd) { bd = d; best = i; }
  }
  let l2 = words.slice(best).join(" ");
  if (l2.length > maxlen + 6) l2 = l2.slice(0, maxlen + 3) + "…";
  return [words.slice(0, best).join(" "), l2];
}
function textW(s, size) { return s.length * size * 0.72; }

function buildDenahSvg(lat0, lon0, data, roadLabelOverride, venueName, half) {
  half = half || HALF;
  const nodes = new Map();
  for (const e of data.elements || []) {
    if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
  }
  const vx = VB / 2, vy = VB / 2;

  const roads = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    if (e.type !== "way" || !t.highway || !t.name) continue;
    if (junkName(t.name)) continue;
    const mpts = [];
    for (const nid of e.nodes || []) {
      const n = nodes.get(nid);
      if (!n) continue;
      const [mx, my] = project(lat0, lon0, n[0], n[1]);
      if (Math.abs(mx) <= half * 1.15 && Math.abs(my) <= half * 1.15) mpts.push([mx, my]);
    }
    if (mpts.length < 2) continue;
    const dist = Math.min(...mpts.map(([mx, my]) => Math.hypot(mx, my)));
    roads.push({ name: t.name, cls: t.highway, pts: simplify(mpts, 8), dist,
                 oneway: t.oneway === "yes" || t.oneway === "1" || t.oneway === "true" });
  }
  if (!roads.length) return null;

  // Geometri bubble venue (dihitung duluan supaya label menghindarinya)
  let bubble = null;
  if (venueName) {
    const lines = wrap2(venueName, 18);
    const w = Math.max(...lines.map((ln) => ln.length)) * 5.6 + 16;
    const h = lines.length * 9.5 + 9;
    const bx = Math.min(Math.max(vx - w / 2 + 14, 4), VB - w - 4);
    let by = vy - 16 - h;
    if (by < 4) by = vy + 20;
    bubble = { x: bx, y: by, w, h, lines };
  }

  const pathD = (mpts) => "M" + mpts.map(([mx, my]) => {
    const [x, y] = toVh(mx, my, half);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" L");

  const P = [`<rect x="0" y="0" width="${VB}" height="${VB}" fill="${C_BG}"/>`];
  for (const r of roads) {
    if (MAIN_CLS.has(r.cls)) continue;
    P.push(`<path d="${pathD(r.pts)}" fill="none" stroke="${C_MINOR}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const r of roads) {
    if (!MAIN_CLS.has(r.cls)) continue;
    const w = ["motorway", "primary", "secondary", "trunk"].includes(r.cls) ? 5.5 : 4.5;
    const d = pathD(r.pts);
    P.push(`<path d="${d}" fill="none" stroke="${C_EDGE}" stroke-width="${(w + 1.6).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    P.push(`<path d="${d}" fill="none" stroke="${C_MAIN}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  function segCandidates(mpts) {
    const vpts = mpts.map(([mx, my]) => toVh(mx, my, half));
    const cands = [];
    for (let i = 0; i < vpts.length - 1; i++) {
      const [x1, y1] = vpts[i], [x2, y2] = vpts[i + 1];
      const ln = Math.hypot(x2 - x1, y2 - y1);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const central = 1 - Math.max(Math.abs(mx - VB / 2), Math.abs(my - VB / 2)) / (VB / 2);
      cands.push([ln * (0.5 + central), [[x1, y1], [x2, y2]], [mx, my]]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    return cands;
  }

  function labelAlong(name, mpts, size) {
    const cands = segCandidates(mpts);
    if (!cands.length || cands[0][0] < 12) return ["", null];
    // Nama jalan di OSM kadang pendek ("Cifor"); bila alamat/URL menyebut
    // nama lengkapnya ("Jl. Raya Cifor"), pakai nama lengkap itu.
    let txt = dispName(name);
    if (roadLabelOverride && roadLabelOverride.toLowerCase().includes(name.toLowerCase())) txt = roadLabelOverride;
    const hw = textW(txt, size) / 2;
    let chosen = null;
    for (const [score, [[x1, y1], [x2, y2]], [mx0, my0]] of cands) {
      let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const ca = Math.abs(Math.cos(ang * Math.PI / 180)), sa = Math.abs(Math.sin(ang * Math.PI / 180));
      const hext = ca * hw + sa * size / 2 + 3, vext = sa * hw + ca * size / 2 + 3;
      const mx = Math.min(Math.max(mx0, hext + 2), VB - hext - 2);
      const my = Math.min(Math.max(my0, vext + 2), VB - vext - 2);
      const box = [mx - hext, my - vext, mx + hext, my + vext];
      if (bubble && box[0] < bubble.x + bubble.w + 4 && box[2] > bubble.x - 4 &&
          box[1] < bubble.y + bubble.h + 4 && box[3] > bubble.y - 4) continue;
      chosen = [mx, my, ang, hext, vext, box];
      break;
    }
    if (!chosen) return ["", null];
    const [mx, my, ang, hext, vext, box] = chosen;
    const svg = `<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle" transform="rotate(${ang.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})" font-family="Verdana, DejaVu Sans, sans-serif" font-size="${size}" fill="${C_LABEL}">${esc(txt)}</text>`;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const cbox = [cx - (box[2] - box[0]) * 0.35, cy - (box[3] - box[1]) * 0.35,
                  cx + (box[2] - box[0]) * 0.35, cy + (box[3] - box[1]) * 0.35];
    return [svg, cbox];
  }

  const bestLabel = new Map();
  for (const r of roads) {
    const vpts = r.pts.map(([mx, my]) => toVh(mx, my, half));
    const bl = Math.max(0, ...vpts.slice(0, -1).map((a, i) => Math.hypot(vpts[i + 1][0] - a[0], vpts[i + 1][1] - a[1])));
    if (!bestLabel.has(r.name) || bl > bestLabel.get(r.name)[0]) bestLabel.set(r.name, [bl, r.pts]);
  }
  const roadBoxes = [];
  for (const [name, [, mpts]] of bestLabel) {
    const [svg, box] = labelAlong(name, mpts, 7);
    if (svg) P.push(svg);
    if (box) roadBoxes.push(box);
  }
  for (const r of roads) {
    if (!r.oneway || !MAIN_CLS.has(r.cls)) continue;
    const cands = segCandidates(r.pts);
    if (!cands.length || cands[0][0] < 20) continue;
    const [[x1, y1], [x2, y2]] = cands[0][1];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    P.push(`<g transform="translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${ang.toFixed(1)})"><polygon points="0,-3.2 7,0 0,3.2" fill="${C_BG}"/></g>`);
  }

  // ---- POI ----
  const ICONS = {
    mosque: (x, y) =>
      `<g fill="${C_ICON}"><circle cx="${x.toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="6.5"/>` +
      `<rect x="${(x - 6.5).toFixed(1)}" y="${(y - 2).toFixed(1)}" width="13" height="4"/>` +
      `<rect x="${(x - 1.5).toFixed(1)}" y="${(y - 11).toFixed(1)}" width="3" height="9"/>` +
      `<circle cx="${x.toFixed(1)}" cy="${(y - 12).toFixed(1)}" r="2.5"/></g>`,
    church: (x, y) =>
      `<g stroke="${C_ICON}" stroke-width="1.6" fill="none">` +
      `<circle cx="${x.toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="7"/>` +
      `<path d="M${x.toFixed(1)} ${(y - 8).toFixed(1)} V${(y + 3).toFixed(1)} M${(x - 3).toFixed(1)} ${(y - 5).toFixed(1)} H${(x + 3).toFixed(1)}"/></g>`,
    school: (x, y) =>
      `<g fill="${C_ICON}"><polygon points="${(x - 7).toFixed(1)},${(y - 1).toFixed(1)} ${(x + 7).toFixed(1)},${(y - 1).toFixed(1)} ${x.toFixed(1)},${(y - 8).toFixed(1)}"/>` +
      `<path d="M${(x - 4.5).toFixed(1)} ${y.toFixed(1)} V${(y + 4).toFixed(1)} H${(x + 4.5).toFixed(1)} V${y.toFixed(1)}" />` +
      `<circle cx="${(x + 7).toFixed(1)}" cy="${(y + 1).toFixed(1)}" r="1.4"/></g>`,
    food: (x, y) =>
      `<g stroke="${C_ICON}" stroke-width="1.6" fill="none">` +
      `<circle cx="${x.toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="7.5"/>` +
      `<path d="M${(x - 3).toFixed(1)} ${(y - 6).toFixed(1)} V${(y + 1).toFixed(1)} M${(x - 4.5).toFixed(1)} ${(y - 6).toFixed(1)} V${(y - 2).toFixed(1)} M${(x - 1.5).toFixed(1)} ${(y - 6).toFixed(1)} V${(y - 2).toFixed(1)}"/>` +
      `<path d="M${(x + 3).toFixed(1)} ${(y - 6).toFixed(1)} L${(x + 4.5).toFixed(1)} ${(y + 1).toFixed(1)}"/></g>`,
    fuel: (x, y) =>
      `<g stroke="${C_ICON}" stroke-width="1.5" fill="none">` +
      `<rect x="${(x - 5).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="8" height="11" rx="1"/>` +
      `<path d="M${(x + 3).toFixed(1)} ${(y - 3).toFixed(1)} h2.5 v5"/>` +
      `<path d="M${(x - 2.5).toFixed(1)} ${(y - 1).toFixed(1)} h3"/></g>`,
    police: (x, y) =>
      `<g fill="${C_ICON}"><path d="M${x.toFixed(1)} ${(y - 9).toFixed(1)} L${(x + 5.5).toFixed(1)} ${(y - 6).toFixed(1)} V${y.toFixed(1)} ` +
      `C${(x + 5.5).toFixed(1)} ${(y + 4).toFixed(1)} ${x.toFixed(1)} ${(y + 7).toFixed(1)} ${x.toFixed(1)} ${(y + 7).toFixed(1)} ` +
      `C${x.toFixed(1)} ${(y + 7).toFixed(1)} ${(x - 5.5).toFixed(1)} ${(y + 4).toFixed(1)} ${(x - 5.5).toFixed(1)} ${y.toFixed(1)} V${(y - 6).toFixed(1)} Z"/>` +
      `<circle cx="${x.toFixed(1)}" cy="${(y - 1).toFixed(1)}" r="1.8" fill="${C_BG}"/></g>`,
    building: (x, y) =>
      `<g stroke="${C_ICON}" stroke-width="1.5" fill="none">` +
      `<path d="M${(x - 6).toFixed(1)} ${(y + 4).toFixed(1)} H${(x + 6).toFixed(1)} M${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)} V${(y - 3).toFixed(1)} ` +
      `M${x.toFixed(1)} ${(y + 4).toFixed(1)} V${(y - 3).toFixed(1)} M${(x + 5).toFixed(1)} ${(y + 4).toFixed(1)} V${(y - 3).toFixed(1)} ` +
      `M${(x - 7).toFixed(1)} ${(y - 3).toFixed(1)} H${(x + 7).toFixed(1)} M${(x - 6).toFixed(1)} ${(y - 6).toFixed(1)} H${(x + 6).toFixed(1)}"/></g>`,
    shop: (x, y) =>
      `<g stroke="${C_ICON}" stroke-width="1.5" fill="none">` +
      `<path d="M${(x - 6).toFixed(1)} ${(y - 5).toFixed(1)} H${(x + 6).toFixed(1)} L${(x + 5).toFixed(1)} ${(y - 1).toFixed(1)} H${(x - 5).toFixed(1)} Z"/>` +
      `<rect x="${(x - 5).toFixed(1)}" y="${(y - 1).toFixed(1)}" width="10" height="6"/></g>`,
    hospital: (x, y) =>
      `<g fill="${C_ICON}"><circle cx="${x.toFixed(1)}" cy="${(y - 2).toFixed(1)}" r="7"/>` +
      `<rect x="${(x - 1.4).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="2.8" height="10" fill="${C_BG}"/>` +
      `<rect x="${(x - 5).toFixed(1)}" y="${(y - 3.4).toFixed(1)}" width="10" height="2.8" fill="${C_BG}"/></g>`,
  };
  function classify(t) {
    const am = t.amenity || "";
    if (am === "place_of_worship") {
      if ((t.name || "").toLowerCase().includes("gereja") || t.religion === "christian") return "church";
      return "mosque";
    }
    if (am === "school") return "school";
    if (am === "restaurant" || am === "fast_food" || am === "cafe") return "food";
    if (am === "fuel") return "fuel";
    if (am === "police") return "police";
    if (am === "hospital" || am === "clinic" || am === "doctors") return "hospital";
    if (am === "townhall" || am === "courthouse" || t.office === "government" || am === "bank") return "building";
    if (["convenience", "supermarket", "mall", "department_store"].includes(t.shop)) return "shop";
    if (t.tourism === "hotel") return "building";
    return null;
  }
  const pois = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    if (!t.name) continue;
    const kind = classify(t);
    if (!kind) continue;
    let la, lo;
    if (e.type === "node") { la = e.lat; lo = e.lon; }
    else {
      const pts = (e.nodes || []).map((n) => nodes.get(n)).filter(Boolean);
      if (!pts.length) continue;
      la = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      lo = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    }
    const [mx, my] = project(lat0, lon0, la, lo);
    if (Math.abs(mx) > half || Math.abs(my) > half) continue;
    const d = Math.hypot(mx, my);
    if (d < 30) continue; // venue itu sendiri — jangan digambar dua kali
    pois.push({ d, name: cleanPoiName(t.name), kind, mx, my });
  }
  pois.sort((a, b) => a.d - b.d);

  const boxes = [...roadBoxes];
  if (bubble) boxes.push([bubble.x - 4, bubble.y - 4, bubble.x + bubble.w + 4, bubble.y + bubble.h + 4]);
  boxes.push([vx - 16, vy - 16, vx + 16, vy + 18]);
  const iconsDrawn = [[vx, vy]];
  const overlaps = (b) => boxes.some((o) => b[0] < o[2] + 3 && b[2] > o[0] - 3 && b[1] < o[3] + 3 && b[3] > o[1] - 3);

  const placedPois = [];
  for (const p of pois.slice(0, 6)) {
    const [x, y] = toVh(p.mx, p.my, half);
    if (iconsDrawn.some(([ix, iy]) => Math.hypot(x - ix, y - iy) < 20)) continue;
    iconsDrawn.push([x, y]);
    P.push(ICONS[p.kind](x, y));
    placedPois.push([p, x, y]);
    boxes.push([x - 10, y - 14, x + 10, y + 8]);
  }
  for (const [p, x, y] of placedPois) {
    const lines = wrap2(p.name);
    const w = Math.max(...lines.map((ln) => textW(ln, 7)));
    const h = 8 * lines.length;
    const cands = [];
    for (const dy of [20, 33, 46, -18, -31]) {
      const lx = Math.min(Math.max(x, w / 2 + 3), VB - w / 2 - 3);
      cands.push(["middle", lx, y + dy, [lx - w / 2, y + dy - 7, lx + w / 2, y + dy + h]]);
    }
    cands.push(["start", x + 13, y + 3, [x + 13, y - 4, x + 13 + w, y + 3 + h]]);
    cands.push(["end", x - 13, y + 3, [x - 13 - w, y - 4, x - 13, y + 3 + h]]);
    for (const [anchor, lx, ly, b] of cands) {
      if (b[0] < 2 || b[2] > VB - 2 || b[1] < 2 || b[3] > VB - 2) continue;
      if (overlaps(b)) continue;
      boxes.push(b);
      for (let i = 0; i < lines.length; i++) {
        P.push(`<text x="${lx.toFixed(1)}" y="${(ly + i * 8).toFixed(1)}" text-anchor="${anchor}" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" fill="${C_LABEL}">${esc(lines[i])}</text>`);
      }
      break;
    }
  }

  // ---- venue: pin + bubble nama ----
  P.push(`<g><ellipse cx="${vx.toFixed(1)}" cy="${(vy - 2).toFixed(1)}" rx="11" ry="11" fill="${C_RED}" stroke="white" stroke-width="1.5"/>` +
    `<polygon points="${(vx - 6).toFixed(1)},${(vy + 4).toFixed(1)} ${(vx + 6).toFixed(1)},${(vy + 4).toFixed(1)} ${vx.toFixed(1)},${(vy + 14).toFixed(1)}" fill="${C_RED}"/>` +
    `<circle cx="${vx.toFixed(1)}" cy="${(vy - 2).toFixed(1)}" r="4" fill="white"/></g>`);
  if (bubble) {
    const { x: bx, y: by, w, h, lines } = bubble;
    P.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="7" fill="${C_RED}"/>`);
    for (let i = 0; i < lines.length; i++) {
      P.push(`<text x="${(bx + w / 2).toFixed(1)}" y="${(by + 11 + i * 9.5).toFixed(1)}" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="8" font-weight="bold" fill="white">${esc(lines[i])}</text>`);
    }
    const tx = Math.min(Math.max(vx, bx + 8), bx + w - 8);
    if (by < vy) {
      P.push(`<polygon points="${(tx - 5).toFixed(1)},${(by + h).toFixed(1)} ${(tx + 5).toFixed(1)},${(by + h).toFixed(1)} ${vx.toFixed(1)},${(vy - 12).toFixed(1)}" fill="${C_RED}"/>`);
    } else {
      P.push(`<polygon points="${(tx - 5).toFixed(1)},${by.toFixed(1)} ${(tx + 5).toFixed(1)},${by.toFixed(1)} ${vx.toFixed(1)},${(vy + 14).toFixed(1)}" fill="${C_RED}"/>`);
    }
  }
  P.push(`<g><circle cx="222" cy="18" r="10" fill="white" stroke="${C_LABEL}" stroke-width="1.2"/>` +
    `<polygon points="222,10 217,21 227,21" fill="${C_LABEL}"/>` +
    `<text x="222" y="34" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="${C_LABEL}">U</text></g>`);
  P.push(`<rect x="1" y="1" width="${VB - 2}" height="${VB - 2}" fill="none" stroke="${C_FRAME}" stroke-width="2"/>`);

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
    const venueName = (nameSource.split(",")[0] || "").trim() || null;
    const svg = buildDenahSvg(lat, lon, data, rm ? rm[0].trim() : null, venueName);
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
