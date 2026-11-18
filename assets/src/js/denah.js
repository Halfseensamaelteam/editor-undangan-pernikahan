/* Hasilkan Denah / QR — dialog + pembuat denah vektor.
   Urutan jalur pembuatan denah:
   1. Jalur instan: venue yang denahnya sudah dibundel (Heritage, Genus,
      Awa Mangkuruku) langsung memakai file SVG lokal, tanpa fetch ke
      layanan peta.
   2. Backend /api/denah (Vercel serverless, path relatif): server yang
      mengambil data peta dan mengembalikan SVG kecil (~4 KB), jadi HP
      customer tidak perlu mengunduh data mentah OSM / menunggu Overpass.
      Backend juga bisa mengikuti redirect link pendek maps.app.goo.gl.
   3. Jalur lama di browser (tetap dipertahankan sebagai cadangan bila
      /api/denah tidak tersedia — mis. hosting tanpa function): geocode
      Nominatim/Photon + jalan/patokan dari Overpass, dicoba bergantian
      ke server cadangan kalau server pertamanya gagal merespons.
   Semua jalur memakai desain denah vektor yang sama: gaya contoh
   undangan (Awa Mangkuruku) — jalan coklat, semua jalan berlabel,
   patokan berikon coklat, venue = pin merah + bubble nama merah. */
const HERITAGE_LL = { lat: -6.3215125, lon: 106.9070101 };
const HERITAGE_SVG_URL = "assets/denah/heritage-garden-venue-denah-vektor.svg";
const GENUS_LL = { lat: -6.5611108, lon: 106.7494972 };
const GENUS_SVG_URL = "assets/denah/genus-coffee-boutique-denah-vektor.svg";
const AWA_LL = { lat: -1.9101614, lon: 116.1930328 };
const AWA_SVG_URL = "assets/denah/awa-mangkuruku-denah-vektor.svg";
let ddMode = "both", heritageSvgPromise = null, genusSvgPromise = null, awaSvgPromise = null, ddBusy = false;

function ddEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function ddDistM(a, b) { const dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180), dy = (a.lat - b.lat) * 110540; return Math.hypot(dx, dy); }
function ddIsShortLink(s) { return /^https?:\/\//i.test(s) && /(maps\.app\.goo\.gl|goo\.gl|g\.co)\//i.test(s); }
function ddCoordsFromLink(s) {
  const m = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/.exec(s) || /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(s) || /[?&](?:q|query|ll|center)=(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/i.exec(s);
  if (m) { const lat = parseFloat(m[1]), lon = parseFloat(m[2]); if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat: lat, lon: lon }; }
  return null;
}
function ddQueryFromInput(s) {
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s), q = u.searchParams.get("query") || u.searchParams.get("q");
      if (q) return q;
      const pm = /\/place\/([^/@]+)/.exec(u.pathname);
      if (pm) return decodeURIComponent(pm[1].replace(/\+/g, " "));
    } catch (e) { /* bukan URL valid — pakai teks apa adanya */ }
  }
  return s;
}
function ddFetch(url, opts, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 20000);
  return fetch(url, Object.assign({}, opts || {}, { signal: c.signal })).finally(() => clearTimeout(t));
}
function ddNotFound() { const e = new Error("notfound"); e.notfound = true; return e; }
function ddMapFail() { const e = new Error("mapfail"); e.mapfail = true; return e; }
async function ddGeocodeNominatim(q) {
  const r = await ddFetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } }, 15000);
  if (!r.ok) throw new Error("nominatim " + r.status);
  const j = await r.json();
  if (!j || !j.length) throw ddNotFound();
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
}
async function ddGeocodePhoton(q) {
  const r = await ddFetch("https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } }, 15000);
  if (!r.ok) throw new Error("photon " + r.status);
  const j = await r.json();
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry || !f.geometry.coordinates) throw ddNotFound();
  return { lat: parseFloat(f.geometry.coordinates[1]), lon: parseFloat(f.geometry.coordinates[0]) };
}
/* Geocode dicoba ke dua layanan bergantian: kegagalan respons di layanan pertama
   (server sibuk/ditolak) tidak langsung dianggap "alamat tidak ditemukan". */
async function ddGeocode(q) {
  let sawNotFound = false;
  try { return await ddGeocodeNominatim(q); } catch (e) { if (e && e.notfound) sawNotFound = true; }
  try { return await ddGeocodePhoton(q); } catch (e) { if (e && e.notfound) sawNotFound = true; }
  if (sawNotFound) throw ddNotFound();
  throw ddMapFail();
}
/* Server Overpass publik — daftar yang sama seperti yang dipakai Overpass Turbo.
   Server utama overpass-api.de hanya satu-satunya jalur sebelumnya, dan ia yang
   menolak permintaan ini (406/429/timeout) sampai denah selalu gagal dibuat;
   sekarang kegagalan di satu server otomatis lanjut ke server berikutnya. */
const DD_OVERPASS_EPS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];
async function ddOverpass(lat, lon, onProgress) {
  /* Query dibuat seringan mungkin: radius diperkecil (470→320 m, denah tetap
     terisi di tengah). Klausa way["building"] kini diambil lagi untuk
     poligon blok bangunan gaya v3 — dulu klausa itu dibuang karena membuat
     respons membengkak, tetapi radius 320 m menahannya tetap ringan, dan
     generator hanya menggambar bangunan >= 400 m2. Patokan dari bangunan
     bernama tetap tertangkap lewat klausa amenity di bawah.
     Jenis amenity diperluas (tempat makan, SPBU, polisi, rumah sakit,
     kantor/bank) + node toko, supaya ikon patokan gaya baru bisa digambar;
     semuanya node/way ringan, bukan geometri bangunan massal.
     Timeout per server diperpanjang (60 dtk) karena server Overpass publik
     memang lambat merespons; status dialog menunjukkan server ke berapa yang
     sedang dicoba supaya pengguna tahu prosesnya masih berjalan. */
  const DD_AMEN = "place_of_worship|school|restaurant|fast_food|cafe|fuel|police|hospital|clinic|doctors|townhall|courthouse|bank";
  const q = '[out:json][timeout:55];(way["highway"]["name"](around:320,' + lat + "," + lon + ');way["building"](around:320,' + lat + "," + lon + ');way["amenity"~"' + DD_AMEN + '"](around:320,' + lat + "," + lon + ');node["amenity"~"' + DD_AMEN + '"](around:320,' + lat + "," + lon + ');node["shop"~"convenience|supermarket|mall|department_store"](around:320,' + lat + "," + lon + '););out geom;';
  const body = "data=" + encodeURIComponent(q);
  for (let i = 0; i < DD_OVERPASS_EPS.length; i++) {
    if (onProgress) onProgress(i + 1, DD_OVERPASS_EPS.length);
    try {
      const r = await ddFetch(DD_OVERPASS_EPS[i], { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: body }, 60000);
      if (!r.ok) throw new Error("overpass " + r.status);
      const j = await r.json();
      if (!j || !Array.isArray(j.elements)) throw new Error("overpass bad");
      return j;
    } catch (e) { /* lanjut ke server berikutnya */ }
  }
  throw ddMapFail();
}
function ddSvgUrl(svg) { return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); }
function ddHeritageUrl() {
  if (!heritageSvgPromise) {
    heritageSvgPromise = fetch(HERITAGE_SVG_URL)
      .then(r => { if (!r.ok) throw new Error("heritage " + r.status); return r.text(); })
      .then(t => ddSvgUrl(t))
      .catch(e => { heritageSvgPromise = null; throw e; });
  }
  return heritageSvgPromise;
}
function ddGenusUrl() {
  if (!genusSvgPromise) {
    genusSvgPromise = fetch(GENUS_SVG_URL)
      .then(r => { if (!r.ok) throw new Error("genus " + r.status); return r.text(); })
      .then(t => ddSvgUrl(t))
      .catch(e => { genusSvgPromise = null; throw e; });
  }
  return genusSvgPromise;
}
function ddAwaUrl() {
  if (!awaSvgPromise) {
    awaSvgPromise = fetch(AWA_SVG_URL)
      .then(r => { if (!r.ok) throw new Error("awa " + r.status); return r.text(); })
      .then(t => ddSvgUrl(t))
      .catch(e => { awaSvgPromise = null; throw e; });
  }
  return awaSvgPromise;
}
/* Backend /api/denah (Vercel serverless) — dicoba SEBELUM jalur lama.
   Mengembalikan data URL SVG bila server membalas 200 dengan isi SVG;
   mengembalikan null untuk kegagalan APAPUN (404 di hosting tanpa
   function, timeout 10 detik, JSON error, isi bukan SVG) supaya pemanggil
   jatuh ke jalur lama. Tidak pernah melempar error. */
async function ddTryApiDenah(input) {
  try {
    const params = new URLSearchParams();
    if (/^https?:\/\//i.test(input)) params.set("url", input);
    else params.set("address", ddQueryFromInput(input));
    const coords = ddCoordsFromLink(input);
    if (coords) { params.set("lat", String(coords.lat)); params.set("lon", String(coords.lon)); }
    if (!params.toString()) return null;
    const r = await ddFetch("api/denah?" + params.toString(), { headers: { Accept: "image/svg+xml" } }, 10000);
    if (!r.ok) return null;
    const t = await r.text();
    if (!t || !t.replace(/^\s+/, "").startsWith("<svg")) return null;
    return ddSvgUrl(t);
  } catch (e) { return null; }
}

/* ---- Pembuat SVG denah v3 — gaya contoh undangan (Awa Mangkuruku) ----
   Port dari buildDenahSvg v3 di api/denah.js (server), yang setara dengan
   generator Python untuk SVG bundel: latar abu sangat muda #F2F2F5,
   poligon bangunan/blok putih #FFFFFF bertepi coklat #6E4A2F (hanya yang
   >= 400 m2, maks 60 terbesar; gedung venue — bangunan terdekat < 60 m —
   isi sorot #EFE3CE), jalan coklat #6E4A2F bertepi #5A3A22 (jalan utama
   lebar 7/6, jalan kecil 4.5), SEMUA jalan berlabel PUTIH TEBAL di atas
   badan jalan (ukuran 6 jalan utama / 5 jalan kecil) mengikuti arah
   jalan (dijepit di dalam kanvas dan tidak menutupi bubble venue),
   patokan maks 6 terdekat berikon coklat #6B4A2F sesuai jenis dengan
   label anti-tabrakan, POI dalam 30 m dari venue tidak digambar (itu
   venue itu sendiri), venue = pin merah #C0392B + bubble nama merah,
   panah satu arah di jalan besar bertanda oneway, panah utara "U"
   kanan atas, bingkai coklat #6E4A2F.
   Bedanya dari versi server hanya format data masuk: di sini data
   Overpass (way ber-geometry, node ber-lat/lon), bukan OSM API. */
const DD_MAIN_CLS = { motorway: 1, primary: 1, secondary: 1, tertiary: 1, trunk: 1 };
const DD_C_BG = "#F2F2F5", DD_C_EDGE = "#5A3A22", DD_C_MAIN = "#6E4A2F";
const DD_C_LABEL = "#5C3D1E", DD_C_ICON = "#6B4A2F", DD_C_RED = "#C0392B", DD_C_FRAME = "#6E4A2F";
const DD_C_BLD_FILL = "#FFFFFF", DD_C_BLD_STROKE = "#6E4A2F", DD_C_VENUE_BLD_FILL = "#EFE3CE";

function ddDispName(name) {
  const n = name.trim();
  if (/^jalan /i.test(n)) return "Jl. " + n.slice(6);
  if (/^gang /i.test(n)) return "Gg. " + n.slice(5);
  if (!/^(Jl\.|Gg\.|Jl )/i.test(n)) return "Jl. " + n;
  return n;
}
function ddJunkName(name) {
  const u = name.trim().toUpperCase();
  return u === "JALAN" || u.indexOf("PARKIRAN") >= 0 || u === "";
}
function ddCleanPoiName(name) {
  let n = name.trim().replace(/=+$/, "").trim();
  if (n === n.toUpperCase() && n.length > 3) {
    n = n.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    ["Sd ", "Smp ", "Tk ", "Sma ", "Smk "].forEach(a => { n = n.split(a).join(a.toUpperCase()); });
  }
  return n;
}
function ddWrap2(name, maxlen) {
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
function ddTextW(s, size) { return s.length * size * 0.75; }
function ddClassifyPoi(t) {
  const am = t.amenity || "";
  if (am === "place_of_worship") {
    if ((t.name || "").toLowerCase().indexOf("gereja") >= 0 || t.religion === "christian") return "church";
    return "mosque";
  }
  if (am === "school") return "school";
  if (am === "restaurant" || am === "fast_food" || am === "cafe") return "food";
  if (am === "fuel") return "fuel";
  if (am === "police") return "police";
  if (am === "hospital" || am === "clinic" || am === "doctors") return "hospital";
  if (am === "townhall" || am === "courthouse" || t.office === "government" || am === "bank") return "building";
  if (["convenience", "supermarket", "mall", "department_store"].indexOf(t.shop) >= 0) return "shop";
  if (t.tourism === "hotel") return "building";
  return null;
}

function ddBuildSvg(data, lat0, lon0, roadLabelOverride, venueName) {
  const VB = 240, HALF = 450, KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110540, S = VB / (2 * HALF);
  const proj = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KY];
  const toVh = (mx, my) => [VB / 2 + mx * S, VB / 2 - my * S];
  const F = n => (Math.round(n * 10) / 10).toFixed(1);
  function perp(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    if (!L2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let dmax = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = perp(pts[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > tol) { const l = simplify(pts.slice(0, idx + 1), tol), r = simplify(pts.slice(idx), tol); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  const vx = VB / 2, vy = VB / 2;

  const roads = [];
  (data.elements || []).forEach(e => {
    const t = e.tags || {};
    if (e.type !== "way" || !t.highway || !t.name || !e.geometry) return;
    if (ddJunkName(t.name)) return;
    const mpts = [];
    e.geometry.forEach(g => { const p = proj(g.lat, g.lon); if (Math.abs(p[0]) <= HALF * 1.15 && Math.abs(p[1]) <= HALF * 1.15) mpts.push(p); });
    if (mpts.length < 2) return;
    roads.push({ name: t.name, cls: String(t.highway).replace(/_link$/, ""), pts: simplify(mpts, 8), oneway: t.oneway === "yes" || t.oneway === "1" || t.oneway === "true" });
  });
  if (!roads.length) return null;

  /* Poligon bangunan (footprint OSM): hanya yang besar supaya blok terbaca,
     bukan ratusan rumah kecil. Gedung venue diberi isi warna sorot. */
  const buildings = [];
  (data.elements || []).forEach(e => {
    const t = e.tags || {};
    if (e.type !== "way" || !("building" in t) || !e.geometry) return;
    if (e.geometry.length < 4) return;
    const pts = [];
    e.geometry.forEach(g => { const p = proj(g.lat, g.lon); if (Math.abs(p[0]) <= HALF * 1.15 && Math.abs(p[1]) <= HALF * 1.15) pts.push(p); });
    if (pts.length < 4) return;
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    area = Math.abs(area) / 2;
    if (area < 400) return;
    let cx = 0, cy = 0;
    pts.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    buildings.push({ pts: simplify(pts, 3), area: area, dist: Math.hypot(cx, cy) });
  });
  buildings.sort((a, b) => b.area - a.area);
  if (buildings.length > 60) buildings.length = 60;
  let venueBld = null;
  if (buildings.length) {
    const near = buildings.reduce((a, b) => (b.dist < a.dist ? b : a));
    if (near.dist < 60) venueBld = near;
  }

  /* Geometri bubble venue (dihitung duluan supaya label jalan menghindarinya) */
  let bubble = null;
  if (venueName) {
    const lines = ddWrap2(venueName, 18);
    const w = Math.max.apply(null, lines.map(ln => ln.length)) * 5.6 + 16;
    const h = lines.length * 9.5 + 9;
    const bx = Math.min(Math.max(vx - w / 2 + 14, 4), VB - w - 4);
    let by = vy - 16 - h;
    if (by < 4) by = vy + 20;
    bubble = { x: bx, y: by, w: w, h: h, lines: lines };
  }

  const pathD = mpts => "M" + mpts.map(p => { const v = toVh(p[0], p[1]); return F(v[0]) + "," + F(v[1]); }).join(" L");

  const P = ['<rect x="0" y="0" width="' + VB + '" height="' + VB + '" fill="' + DD_C_BG + '"/>'];
  buildings.forEach(b => {
    const ptsS = b.pts.map(p => { const v = toVh(p[0], p[1]); return F(v[0]) + "," + F(v[1]); }).join(" ");
    const fill = b === venueBld ? DD_C_VENUE_BLD_FILL : DD_C_BLD_FILL;
    const sw = b === venueBld ? "0.7" : "0.5";
    P.push('<polygon points="' + ptsS + '" fill="' + fill + '" stroke="' + DD_C_BLD_STROKE + '" stroke-width="' + sw + '" stroke-linejoin="round"/>');
  });
  roads.forEach(r => {
    if (DD_MAIN_CLS[r.cls]) return;
    P.push('<path d="' + pathD(r.pts) + '" fill="none" stroke="' + DD_C_MAIN + '" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>');
  });
  roads.forEach(r => {
    if (!DD_MAIN_CLS[r.cls]) return;
    const w = (r.cls === "motorway" || r.cls === "primary" || r.cls === "secondary" || r.cls === "trunk") ? 7 : 6;
    const d = pathD(r.pts);
    P.push('<path d="' + d + '" fill="none" stroke="' + DD_C_EDGE + '" stroke-width="' + F(w + 1.6) + '" stroke-linecap="round" stroke-linejoin="round"/>');
    P.push('<path d="' + d + '" fill="none" stroke="' + DD_C_MAIN + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>');
  });

  function segCandidates(mpts) {
    const vpts = mpts.map(p => toVh(p[0], p[1]));
    const cands = [];
    for (let i = 0; i < vpts.length - 1; i++) {
      const a = vpts[i], b = vpts[i + 1];
      const ln = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const central = 1 - Math.max(Math.abs(mx - VB / 2), Math.abs(my - VB / 2)) / (VB / 2);
      cands.push([ln * (0.5 + central), [a, b], [mx, my]]);
    }
    cands.sort((x, y) => y[0] - x[0]);
    return cands;
  }

  function labelAlong(name, mpts, cls) {
    /* Label jalan PUTIH TEBAL di atas badan jalan (seperti contoh). */
    const size = DD_MAIN_CLS[cls] ? 6 : 5;
    const cands = segCandidates(mpts);
    if (!cands.length || cands[0][0] < 12) return ["", null];
    /* Nama jalan di OSM kadang pendek ("Cifor"); bila alamat/URL menyebut
       nama lengkapnya ("Jl. Raya Cifor"), pakai nama lengkap itu. */
    let txt = ddDispName(name);
    if (roadLabelOverride && roadLabelOverride.toLowerCase().indexOf(name.toLowerCase()) >= 0) txt = roadLabelOverride;
    const hw = ddTextW(txt, size) / 2;
    let chosen = null;
    for (let ci = 0; ci < cands.length; ci++) {
      const seg = cands[ci][1], mid = cands[ci][2];
      let ang = Math.atan2(seg[1][1] - seg[0][1], seg[1][0] - seg[0][0]) * 180 / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const ca = Math.abs(Math.cos(ang * Math.PI / 180)), sa = Math.abs(Math.sin(ang * Math.PI / 180));
      const hext = ca * hw + sa * size / 2 + 3, vext = sa * hw + ca * size / 2 + 3;
      const mx = Math.min(Math.max(mid[0], hext + 2), VB - hext - 2);
      const my = Math.min(Math.max(mid[1], vext + 2), VB - vext - 2);
      const box = [mx - hext, my - vext, mx + hext, my + vext];
      if (bubble && box[0] < bubble.x + bubble.w + 4 && box[2] > bubble.x - 4 && box[1] < bubble.y + bubble.h + 4 && box[3] > bubble.y - 4) continue;
      chosen = [mx, my, ang, box];
      break;
    }
    if (!chosen) return ["", null];
    const mx = chosen[0], my = chosen[1], ang = chosen[2], box = chosen[3];
    const svg = '<text x="' + F(mx) + '" y="' + F(my) + '" text-anchor="middle" transform="rotate(' + F(ang) + " " + F(mx) + " " + F(my) + ')" font-family="Verdana, DejaVu Sans, sans-serif" font-size="' + size + '" font-weight="bold" fill="white">' + ddEsc(txt) + "</text>";
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const cbox = [cx - (box[2] - box[0]) * 0.35, cy - (box[3] - box[1]) * 0.35, cx + (box[2] - box[0]) * 0.35, cy + (box[3] - box[1]) * 0.35];
    return [svg, cbox];
  }

  /* Label untuk SEMUA nama jalan: satu per nama, di ruas terpanjangnya */
  const bestLabel = new Map();
  roads.forEach(r => {
    const vpts = r.pts.map(p => toVh(p[0], p[1]));
    let bl = 0;
    for (let i = 0; i < vpts.length - 1; i++) { const ln = Math.hypot(vpts[i + 1][0] - vpts[i][0], vpts[i + 1][1] - vpts[i][1]); if (ln > bl) bl = ln; }
    if (!bestLabel.has(r.name) || bl > bestLabel.get(r.name)[0]) bestLabel.set(r.name, [bl, r.pts, r.cls]);
  });
  const roadBoxes = [];
  bestLabel.forEach((v, name) => {
    const res = labelAlong(name, v[1], v[2]);
    if (res[0]) P.push(res[0]);
    if (res[1]) roadBoxes.push(res[1]);
  });
  /* Panah satu arah putih di jalan besar yang bertanda oneway */
  roads.forEach(r => {
    if (!r.oneway || !DD_MAIN_CLS[r.cls]) return;
    const cands = segCandidates(r.pts);
    if (!cands.length || cands[0][0] < 20) return;
    const seg = cands[0][1];
    const mx = (seg[0][0] + seg[1][0]) / 2, my = (seg[0][1] + seg[1][1]) / 2;
    const ang = Math.atan2(seg[1][1] - seg[0][1], seg[1][0] - seg[0][0]) * 180 / Math.PI;
    P.push('<g transform="translate(' + F(mx) + " " + F(my) + ") rotate(" + F(ang) + ')"><polygon points="0,-3.2 7,0 0,3.2" fill="' + DD_C_BG + '"/></g>');
  });

  /* ---- POI / patokan ---- */
  const ICONS = {
    mosque: (x, y) =>
      '<g fill="' + DD_C_ICON + '"><circle cx="' + F(x) + '" cy="' + F(y - 2) + '" r="6.5"/>' +
      '<rect x="' + F(x - 6.5) + '" y="' + F(y - 2) + '" width="13" height="4"/>' +
      '<rect x="' + F(x - 1.5) + '" y="' + F(y - 11) + '" width="3" height="9"/>' +
      '<circle cx="' + F(x) + '" cy="' + F(y - 12) + '" r="2.5"/></g>',
    church: (x, y) =>
      '<g stroke="' + DD_C_ICON + '" stroke-width="1.6" fill="none">' +
      '<circle cx="' + F(x) + '" cy="' + F(y - 2) + '" r="7"/>' +
      '<path d="M' + F(x) + " " + F(y - 8) + " V" + F(y + 3) + " M" + F(x - 3) + " " + F(y - 5) + " H" + F(x + 3) + '"/></g>',
    school: (x, y) =>
      '<g fill="' + DD_C_ICON + '"><polygon points="' + F(x - 7) + "," + F(y - 1) + " " + F(x + 7) + "," + F(y - 1) + " " + F(x) + "," + F(y - 8) + '"/>' +
      '<path d="M' + F(x - 4.5) + " " + F(y) + " V" + F(y + 4) + " H" + F(x + 4.5) + " V" + F(y) + '"/>' +
      '<circle cx="' + F(x + 7) + '" cy="' + F(y + 1) + '" r="1.4"/></g>',
    food: (x, y) =>
      '<g stroke="' + DD_C_ICON + '" stroke-width="1.6" fill="none">' +
      '<circle cx="' + F(x) + '" cy="' + F(y - 2) + '" r="7.5"/>' +
      '<path d="M' + F(x - 3) + " " + F(y - 6) + " V" + F(y + 1) + " M" + F(x - 4.5) + " " + F(y - 6) + " V" + F(y - 2) + " M" + F(x - 1.5) + " " + F(y - 6) + " V" + F(y - 2) + '"/>' +
      '<path d="M' + F(x + 3) + " " + F(y - 6) + " L" + F(x + 4.5) + " " + F(y + 1) + '"/></g>',
    fuel: (x, y) =>
      '<g stroke="' + DD_C_ICON + '" stroke-width="1.5" fill="none">' +
      '<rect x="' + F(x - 5) + '" y="' + F(y - 7) + '" width="8" height="11" rx="1"/>' +
      '<path d="M' + F(x + 3) + " " + F(y - 3) + ' h2.5 v5"/>' +
      '<path d="M' + F(x - 2.5) + " " + F(y - 1) + ' h3"/></g>',
    police: (x, y) =>
      '<g fill="' + DD_C_ICON + '"><path d="M' + F(x) + " " + F(y - 9) + " L" + F(x + 5.5) + " " + F(y - 6) + " V" + F(y) + " " +
      "C" + F(x + 5.5) + " " + F(y + 4) + " " + F(x) + " " + F(y + 7) + " " + F(x) + " " + F(y + 7) + " " +
      "C" + F(x) + " " + F(y + 7) + " " + F(x - 5.5) + " " + F(y + 4) + " " + F(x - 5.5) + " " + F(y) + " V" + F(y - 6) + ' Z"/>' +
      '<circle cx="' + F(x) + '" cy="' + F(y - 1) + '" r="1.8" fill="' + DD_C_BG + '"/></g>',
    building: (x, y) =>
      '<g stroke="' + DD_C_ICON + '" stroke-width="1.5" fill="none">' +
      '<path d="M' + F(x - 6) + " " + F(y + 4) + " H" + F(x + 6) + " M" + F(x - 5) + " " + F(y + 4) + " V" + F(y - 3) + " " +
      "M" + F(x) + " " + F(y + 4) + " V" + F(y - 3) + " M" + F(x + 5) + " " + F(y + 4) + " V" + F(y - 3) + " " +
      "M" + F(x - 7) + " " + F(y - 3) + " H" + F(x + 7) + " M" + F(x - 6) + " " + F(y - 6) + " H" + F(x + 6) + '"/></g>',
    shop: (x, y) =>
      '<g stroke="' + DD_C_ICON + '" stroke-width="1.5" fill="none">' +
      '<path d="M' + F(x - 6) + " " + F(y - 5) + " H" + F(x + 6) + " L" + F(x + 5) + " " + F(y - 1) + " H" + F(x - 5) + ' Z"/>' +
      '<rect x="' + F(x - 5) + '" y="' + F(y - 1) + '" width="10" height="6"/></g>',
    hospital: (x, y) =>
      '<g fill="' + DD_C_ICON + '"><circle cx="' + F(x) + '" cy="' + F(y - 2) + '" r="7"/>' +
      '<rect x="' + F(x - 1.4) + '" y="' + F(y - 7) + '" width="2.8" height="10" fill="' + DD_C_BG + '"/>' +
      '<rect x="' + F(x - 5) + '" y="' + F(y - 3.4) + '" width="10" height="2.8" fill="' + DD_C_BG + '"/></g>'
  };
  const pois = [];
  (data.elements || []).forEach(e => {
    const t = e.tags || {};
    if (!t.name) return;
    const kind = ddClassifyPoi(t);
    if (!kind) return;
    let la, lo;
    if (e.type === "node") { la = e.lat; lo = e.lon; }
    else if (e.geometry && e.geometry.length) { let sa = 0, so = 0; e.geometry.forEach(g => { sa += g.lat; so += g.lon; }); la = sa / e.geometry.length; lo = so / e.geometry.length; }
    else return;
    const p = proj(la, lo);
    if (Math.abs(p[0]) > HALF || Math.abs(p[1]) > HALF) return;
    const d = Math.hypot(p[0], p[1]);
    if (d < 30) return; /* venue itu sendiri — jangan digambar dua kali */
    pois.push({ d: d, name: ddCleanPoiName(t.name), kind: kind, mx: p[0], my: p[1] });
  });
  pois.sort((a, b) => a.d - b.d);

  const boxes = roadBoxes.slice();
  if (bubble) boxes.push([bubble.x - 4, bubble.y - 4, bubble.x + bubble.w + 4, bubble.y + bubble.h + 4]);
  boxes.push([vx - 16, vy - 16, vx + 16, vy + 18]);
  const iconsDrawn = [[vx, vy]];
  const overlaps = b => boxes.some(o => b[0] < o[2] + 3 && b[2] > o[0] - 3 && b[1] < o[3] + 3 && b[3] > o[1] - 3);

  const placedPois = [];
  pois.slice(0, 6).forEach(p => {
    const v = toVh(p.mx, p.my), x = v[0], y = v[1];
    if (iconsDrawn.some(ic => Math.hypot(x - ic[0], y - ic[1]) < 20)) return;
    iconsDrawn.push([x, y]);
    P.push(ICONS[p.kind](x, y));
    placedPois.push([p, x, y]);
    boxes.push([x - 10, y - 14, x + 10, y + 8]);
  });
  placedPois.forEach(pp => {
    const p = pp[0], x = pp[1], y = pp[2];
    const lines = ddWrap2(p.name);
    const w = Math.max.apply(null, lines.map(ln => ddTextW(ln, 7)));
    const h = 8 * lines.length;
    const cands = [];
    [20, 33, 46, -18, -31].forEach(dy => {
      const lx = Math.min(Math.max(x, w / 2 + 3), VB - w / 2 - 3);
      cands.push(["middle", lx, y + dy, [lx - w / 2, y + dy - 7, lx + w / 2, y + dy + h]]);
    });
    cands.push(["start", x + 13, y + 3, [x + 13, y - 4, x + 13 + w, y + 3 + h]]);
    cands.push(["end", x - 13, y + 3, [x - 13 - w, y - 4, x - 13, y + 3 + h]]);
    for (let ci = 0; ci < cands.length; ci++) {
      const anchor = cands[ci][0], lx = cands[ci][1], ly = cands[ci][2], b = cands[ci][3];
      if (b[0] < 2 || b[2] > VB - 2 || b[1] < 2 || b[3] > VB - 2) continue;
      if (overlaps(b)) continue;
      boxes.push(b);
      for (let i = 0; i < lines.length; i++) {
        P.push('<text x="' + F(lx) + '" y="' + F(ly + i * 8) + '" text-anchor="' + anchor + '" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" fill="' + DD_C_LABEL + '">' + ddEsc(lines[i]) + "</text>");
      }
      break;
    }
  });

  /* ---- venue: pin merah + bubble nama ---- */
  P.push('<g><ellipse cx="' + F(vx) + '" cy="' + F(vy - 2) + '" rx="11" ry="11" fill="' + DD_C_RED + '" stroke="white" stroke-width="1.5"/><polygon points="' + F(vx - 6) + "," + F(vy + 4) + " " + F(vx + 6) + "," + F(vy + 4) + " " + F(vx) + "," + F(vy + 14) + '" fill="' + DD_C_RED + '"/><circle cx="' + F(vx) + '" cy="' + F(vy - 2) + '" r="4" fill="white"/></g>');
  if (bubble) {
    const bx = bubble.x, by = bubble.y, bw = bubble.w, bh = bubble.h;
    P.push('<rect x="' + F(bx) + '" y="' + F(by) + '" width="' + F(bw) + '" height="' + F(bh) + '" rx="7" fill="' + DD_C_RED + '"/>');
    bubble.lines.forEach((ln, i) => {
      P.push('<text x="' + F(bx + bw / 2) + '" y="' + F(by + 11 + i * 9.5) + '" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="8" font-weight="bold" fill="white">' + ddEsc(ln) + "</text>");
    });
    const tx = Math.min(Math.max(vx, bx + 8), bx + bw - 8);
    if (by < vy) {
      P.push('<polygon points="' + F(tx - 5) + "," + F(by + bh) + " " + F(tx + 5) + "," + F(by + bh) + " " + F(vx) + "," + F(vy - 12) + '" fill="' + DD_C_RED + '"/>');
    } else {
      P.push('<polygon points="' + F(tx - 5) + "," + F(by) + " " + F(tx + 5) + "," + F(by) + " " + F(vx) + "," + F(vy + 14) + '" fill="' + DD_C_RED + '"/>');
    }
  }
  P.push('<g><circle cx="222" cy="18" r="10" fill="white" stroke="' + DD_C_LABEL + '" stroke-width="1.2"/><polygon points="222,10 217,21 227,21" fill="' + DD_C_LABEL + '"/><text x="222" y="34" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="' + DD_C_LABEL + '">U</text></g>');
  P.push('<rect x="1" y="1" width="' + (VB - 2) + '" height="' + (VB - 2) + '" fill="none" stroke="' + DD_C_FRAME + '" stroke-width="2"/>');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VB + " " + VB + '" width="' + VB + '" height="' + VB + '">\n' + P.join("\n") + "\n</svg>";
}

/* Nama venue untuk bubble: segmen sebelum koma pertama dari input
   customer (nama tempat dari link/alamat). Input berupa URL tanpa nama
   tempat → null (pin saja, tanpa bubble). */
function ddVenueName(input) {
  const q = ddQueryFromInput(input);
  if (/^https?:\/\//i.test(q)) return null;
  const n = (q.split(",")[0] || "").trim();
  return n || null;
}
/* Nama jalan lengkap dari alamat/URL, mis. "Jl. Raya Cifor" — dipakai
   sebagai label bila nama OSM-nya lebih pendek ("Cifor"). */
function ddRoadOverride(input) {
  const rm = /Jl\.\s*[A-Za-z]+(?:\s+[A-Za-z]+)*?(?=\s+No\.|\s*,|\s*$)/.exec(ddQueryFromInput(input));
  return rm ? rm[0].trim() : null;
}

function ddShortLink() { const e = new Error("shortlink"); e.shortlink = true; return e; }
async function ddMakeDenah(input, onFallback) {
  /* 1. Jalur instan — SVG yang dibundel, tanpa layanan peta apa pun.
        Kecocokan nama, atau koordinat hasil parse link dalam 100 m. */
  if (/heritage/i.test(input)) return ddHeritageUrl();
  if (/genus/i.test(input)) return ddGenusUrl();
  if (/awa mangkuruku/i.test(input)) return ddAwaUrl();
  const parsed = ddCoordsFromLink(input);
  if (parsed && ddDistM(parsed, HERITAGE_LL) < 100) return ddHeritageUrl();
  if (parsed && ddDistM(parsed, GENUS_LL) < 100) return ddGenusUrl();
  if (parsed && ddDistM(parsed, AWA_LL) < 100) return ddAwaUrl();
  /* 2. Backend /api/denah — server mengambil data peta, HP hanya menerima
        SVG kecil. Link pendek juga hanya bisa dibaca di jalur ini (server
        mengikuti redirect-nya). Gagal apa pun → lanjut ke jalur lama. */
  const apiUrl = await ddTryApiDenah(input);
  if (apiUrl) return apiUrl;
  /* 3. Jalur lama di browser — perilaku tidak berubah. Link pendek tidak
        bisa dibaca browser, jadi berhenti di sini dengan penjelasannya
        (sama seperti sebelum ada backend). */
  if (ddIsShortLink(input)) throw ddShortLink();
  let coords = parsed;
  if (!coords) coords = await ddGeocode(ddQueryFromInput(input));
  if (ddDistM(coords, HERITAGE_LL) < 100) return ddHeritageUrl();
  if (ddDistM(coords, GENUS_LL) < 100) return ddGenusUrl();
  if (ddDistM(coords, AWA_LL) < 100) return ddAwaUrl();
  const data = await ddOverpass(coords.lat, coords.lon, onFallback);
  const svg = ddBuildSvg(data, coords.lat, coords.lon, ddRoadOverride(input), ddVenueName(input));
  if (!svg) throw ddMapFail();
  return ddSvgUrl(svg);
}

/* ---- Penempatan hasil di kanvas ---- */
/* QR template ada di halamannya sendiri (di CL hampir selalu halaman 2, indeks 1),
   jadi cari elemen QR di SEMUA halaman — bukan cuma halaman yang sedang dibuka —
   supaya hasil denah/QR selalu mendarat di halaman tempat QR berada. */
function ddFindQr() {
  const pages = state.pageEls && state.pageEls.length ? state.pageEls : [state.elements];
  for (let p = 0; p < pages.length; p++) {
    const q = (pages[p] || []).find(e => e.type === "qr");
    if (q) return { el: q, page: p };
  }
  return { el: null, page: -1 };
}
function ddAnchor() {
  const f = ddFindQr();
  if (f.el) return { el: f.el, page: f.page, x: f.el.x, y: f.el.y, s: f.el.w };
  const d = CL_QRS(state.template);
  if (d) return { el: null, page: d.p, x: d.x, y: d.y, s: d.s };
  const s = 130;
  return { el: null, page: state.page, x: Math.round((W - s) / 2), y: Math.round(H / 2 - s / 2), s: s };
}
function ddDenahEl(x, y, s, url) {
  const e = imgEl({ src: url, nw: 240, nh: 240, x: x, y: y, w: s, h: s, shape: "straight" });
  e.denah = true;
  return e;
}
function ddApply(mode, denahUrl, link) {
  const a = ddAnchor(), ex = a.el, P = a.page;
  const els = state.pageEls && state.pageEls[P] ? state.pageEls[P] : state.elements;
  const color = ex ? ex.color : (CL_QRCS(state.template) || "#000000");
  const rot = ex ? (ex.rot || 0) : 0;
  const tplQr = CL_QRS(state.template);
  const def = ex ? ex.def : (tplQr && tplQr.p === P ? "assets/" + (TEMPLATES[state.template].dir || "cl") + "/qr/" + state.template + ".png" : "");
  let qrOk = true, selEl = null;
  const updQr = q => { q.link = link; if (!regenQr(q) && !q.img && !q.def) qrOk = false; };
  if (mode === "qr") {
    if (ex) { updQr(ex); selEl = ex; }
    else { const q = qrEl({ x: a.x, y: a.y, w: a.s, h: a.s, link: link, def: def, color: color, rot: rot }); updQr(q); els.push(q); selEl = q; }
  } else if (mode === "denah") {
    const d = ddDenahEl(a.x, a.y, a.s, denahUrl);
    if (ex) els.splice(els.indexOf(ex), 1, d);
    else els.push(d);
    selEl = d;
  } else {
    const ds = Math.round(a.s * 0.78), qs = Math.round(a.s * 0.52), gap = 6, totalH = ds + gap + qs, cx = a.x + a.s / 2;
    let top = Math.round(a.y + a.s / 2 - totalH / 2);
    top = Math.max(4, Math.min(top, H - totalH - 4));
    const d = ddDenahEl(Math.round(cx - ds / 2), top, ds, denahUrl);
    if (ex) {
      ex.x = Math.round(cx - qs / 2); ex.y = top + ds + gap; ex.w = qs; ex.h = qs; updQr(ex);
    } else {
      const q = qrEl({ x: Math.round(cx - qs / 2), y: top + ds + gap, w: qs, h: qs, link: link, def: def, color: color, rot: rot });
      updQr(q); els.push(q);
    }
    els.push(d);
    selEl = d;
  }
  /* Pindah ke halaman tempat hasil ditaruh (halaman QR) supaya langsung terlihat */
  if (state.pageEls && P !== state.page) switchPage(P);
  commit(); renderBoard();
  if (selEl) select(selEl.id);
  return qrOk;
}

/* ---- Dialog ---- */
function ddShowErr(msg) { const e = $("ddErr"); if (e) { e.textContent = msg || ""; e.classList.toggle("show", !!msg); } }
function ddShowStatus(msg) { const e = $("ddStatus"); if (e) { e.textContent = msg || ""; e.classList.toggle("show", !!msg); } }
function ddSetMode(m) {
  ddMode = m;
  document.querySelectorAll("#ddModes .seg").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  const n = $("ddFootNote");
  if (n) n.textContent = m === "denah" ? "Denah menggantikan QR di tempat yang sama" : m === "qr" ? "QR dibuat ulang di tempat yang sama" : "Denah di atas, QR di bawahnya, di area QR";
}
function openDenahDialog() {
  const ex = ddFindQr().el, inp = $("ddInput");
  if (ex && ex.link) inp.value = ex.link;
  else if (!inp.value) { const d = CL_QRS(state.template); if (d && d.link) inp.value = d.link; }
  ddSetMode(ddMode); ddShowErr(""); ddShowStatus("");
  $("denahdlg").classList.add("open");
  setTimeout(() => { try { inp.focus(); } catch (e) { /* abaikan */ } }, 60);
}
function closeDenahDialog() { $("denahdlg").classList.remove("open"); }
async function ddGenerate() {
  if (ddBusy) return;
  const input = $("ddInput").value.trim();
  ddShowErr("");
  const ex = ddFindQr().el;
  let link = input;
  if (!link) {
    if (ddMode === "qr" && ex && ex.link) link = ex.link;
    else { ddShowErr("Isi dulu alamat atau link Google Maps lokasinya ya."); return; }
  }
  let denahUrl = null;
  if (ddMode !== "qr") {
    /* Link pendek tidak lagi ditolak di depan: backend /api/denah bisa
       mengikutinya di server. Penolakan lama hanya muncul bila backend
       tidak tersedia DAN jalur lama yang menangani (error shortlink). */
    ddBusy = true;
    const go = $("ddGo");
    go.disabled = true; go.textContent = "Membuat…";
    ddShowStatus("Sedang mencari lokasi dan menggambar denah dari peta sekitar venue…");
    try {
      denahUrl = await ddMakeDenah(input, (n, total) => ddShowStatus(n <= 1
        ? "Menghubungi server peta 1 dari " + total + "… server peta publik kadang lambat — di koneksi pelan bisa sampai 1 menit, mohon ditunggu."
        : "Server peta " + (n - 1) + " tidak merespons — mencoba server peta " + n + " dari " + total + "…"));
    } catch (e) {
      ddBusy = false; go.disabled = false; go.textContent = "Hasilkan"; ddShowStatus("");
      ddShowErr(e && e.shortlink
        ? "Link pendek (maps.app.goo.gl) tidak bisa dibaca browser untuk membuat denah. Tempel link panjang Google Maps (google.com/maps/…) atau ketik nama / alamat venue-nya."
        : e && e.notfound
        ? "Alamat itu tidak ditemukan di peta. Coba tulis nama tempat + daerahnya, mis. “Heritage Garden Venue, Setu, Cipayung”."
        : e && e.mapfail
          ? "Server peta sedang tidak bisa dihubungi — sudah dicoba beberapa server dan semuanya gagal merespons. Tunggu sebentar, lalu tekan Hasilkan lagi. Kalau tetap gagal, periksa internet."
          : "Tidak bisa memuat peta, periksa internet lalu coba lagi.");
      return;
    }
    ddBusy = false; go.disabled = false; go.textContent = "Hasilkan"; ddShowStatus("");
  }
  const targetPage = ddAnchor().page;
  const qrOk = ddApply(ddMode, denahUrl, link);
  closeDenahDialog();
  const pgNote = state.pageEls && state.pageEls.length > 1 ? " di halaman " + (targetPage + 1) : "";
  toast(ddMode === "qr"
    ? (qrOk ? "Kode QR diperbarui" + pgNote + " — sekarang mengarah ke lokasimu." : "Alamat tersimpan di elemen QR, tapi pustaka QR belum termuat. Cek internet, lalu ketuk Perbarui kode QR di panel Edit.")
    : ddMode === "denah"
      ? "Denah selesai dibuat" + pgNote + ", di tempat QR — geser atau ubah ukurannya seperti elemen lain."
      : "Denah + QR selesai dibuat" + pgNote + ", di area QR — geser kalau perlu.");
}
if (typeof document !== "undefined" && document.querySelectorAll) {
  document.querySelectorAll("#ddModes .seg").forEach(b => b.addEventListener("click", () => ddSetMode(b.dataset.mode)));
  const ddC = $("ddClose"); if (ddC) ddC.addEventListener("click", closeDenahDialog);
  const ddG = $("ddGo"); if (ddG) ddG.addEventListener("click", ddGenerate);
  const ddD = $("denahdlg"); if (ddD) ddD.addEventListener("click", e => { if (e.target === ddD) closeDenahDialog(); });
}
