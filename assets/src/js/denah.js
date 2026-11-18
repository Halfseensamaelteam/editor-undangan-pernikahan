/* Hasilkan Denah / QR — dialog + pembuat denah vektor langsung di browser.
   Denah digambar dari data OpenStreetMap (geocode Nominatim/Photon + jalan/patokan dari Overpass),
   dengan desain yang sama seperti denah vektor Heritage Garden Venue.
   Semua layanan peta dicoba bergantian ke server cadangan kalau server pertamanya
   gagal merespons — server Overpass utama sering menolak (406/429) atau timeout.
   Venue Heritage memakai file SVG yang dibundel, tanpa perlu internet. */
const HERITAGE_LL = { lat: -6.3215125, lon: 106.9070101 };
const HERITAGE_SVG_URL = "assets/denah/heritage-garden-venue-denah-vektor.svg";
let ddMode = "both", heritageSvgPromise = null, ddBusy = false;

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
async function ddOverpass(lat, lon, onFallback) {
  const q = '[out:json][timeout:25];(way["highway"]["name"](around:470,' + lat + "," + lon + ');way["amenity"~"place_of_worship|school"](around:470,' + lat + "," + lon + ');node["amenity"~"place_of_worship|school"](around:470,' + lat + "," + lon + ');way["building"]["name"](around:470,' + lat + "," + lon + '););out geom;';
  const body = "data=" + encodeURIComponent(q);
  for (let i = 0; i < DD_OVERPASS_EPS.length; i++) {
    try {
      const r = await ddFetch(DD_OVERPASS_EPS[i], { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: body }, 32000);
      if (!r.ok) throw new Error("overpass " + r.status);
      const j = await r.json();
      if (!j || !Array.isArray(j.elements)) throw new Error("overpass bad");
      return j;
    } catch (e) {
      if (i < DD_OVERPASS_EPS.length - 1 && onFallback) onFallback(i + 1);
    }
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

/* ---- Pembuat SVG denah (port dari make_denah_vector.py) ---- */
function ddBuildSvg(data, lat0, lon0) {
  const VB = 240, HALF = 450, KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110540, S = VB / (2 * HALF);
  const proj = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KY];
  const toV = p => [VB / 2 + p[0] * S, VB / 2 - p[1] * S];
  const F = n => Math.round(n * 10) / 10;
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
  const roadLen = mpts => { let L = 0; for (let i = 0; i < mpts.length - 1; i++) L += Math.hypot(mpts[i + 1][0] - mpts[i][0], mpts[i + 1][1] - mpts[i][1]); return L; };
  const MAIN = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1 };
  const roads = [];
  (data.elements || []).forEach(e => {
    const t = e.tags || {};
    if (e.type !== "way" || !t.highway || !t.name || !e.geometry) return;
    const mpts = [];
    e.geometry.forEach(g => { const p = proj(g.lat, g.lon); if (Math.abs(p[0]) <= HALF * 1.15 && Math.abs(p[1]) <= HALF * 1.15) mpts.push(p); });
    if (mpts.length < 2) return;
    roads.push({ name: t.name, cls: String(t.highway).replace(/_link$/, ""), mpts: simplify(mpts, 10) });
  });
  /* Jalan venue = jalan bernama yang paling dekat dengan titik venue */
  let venue = null, venueD = 1e9;
  roads.forEach(r => { for (let i = 0; i < r.mpts.length - 1; i++) { const d = perp([0, 0], r.mpts[i], r.mpts[i + 1]); if (d < venueD) { venueD = d; venue = r; } } });
  const pathD = mpts => "M" + mpts.map(p => { const v = toV(p); return F(v[0]) + "," + F(v[1]); }).join(" L");
  const parts = [];
  parts.push('<rect x="0" y="0" width="240" height="240" fill="#FDFBF3"/>');
  const minors = roads.filter(r => !MAIN[r.cls] && r !== venue);
  minors.sort((a, b) => roadLen(b.mpts) - roadLen(a.mpts));
  minors.slice(0, 12).forEach(r => parts.push('<path d="' + pathD(r.mpts) + '" fill="none" stroke="#C9C2B2" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'));
  roads.filter(r => MAIN[r.cls] && r !== venue).forEach(r => {
    const d = pathD(r.mpts);
    parts.push('<path d="' + d + '" fill="none" stroke="#A89F8C" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round"/>');
    parts.push('<path d="' + d + '" fill="none" stroke="#F3E9CF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>');
  });
  if (venue) {
    const d = pathD(venue.mpts);
    parts.push('<path d="' + d + '" fill="none" stroke="#A89F8C" stroke-width="7.1" stroke-linecap="round" stroke-linejoin="round"/>');
    parts.push('<path d="' + d + '" fill="none" stroke="#E07856" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>');
  }
  /* Label nama jalan: satu per nama, di ruas terpanjang yang paling tengah */
  function labelAlong(name, mpts, size) {
    const vpts = mpts.map(toV);
    let best = null, bl = 0;
    for (let i = 0; i < vpts.length - 1; i++) {
      const a = vpts[i], b = vpts[i + 1], ln = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const central = 1 - Math.max(Math.abs(mx - VB / 2), Math.abs(my - VB / 2)) / (VB / 2);
      const score = ln * (0.5 + central);
      if (score > bl) { bl = score; best = [a, b]; }
    }
    if (!best || bl < 25) return "";
    const mx = (best[0][0] + best[1][0]) / 2, my = (best[0][1] + best[1][1]) / 2;
    let ang = Math.atan2(best[1][1] - best[0][1], best[1][0] - best[0][0]) * 180 / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    return '<text x="' + F(mx) + '" y="' + F(my) + '" text-anchor="middle" transform="rotate(' + F(ang) + " " + F(mx) + " " + F(my) + ')" font-family="Verdana, DejaVu Sans, sans-serif" font-size="' + size + '" fill="#6E6759">' + ddEsc(name) + "</text>";
  }
  const shortName = n => n.replace(/^Jalan\s+/i, "Jl. ");
  const labeled = new Set();
  let labelCount = 0;
  const labelCands = [];
  if (venue) labelCands.push(venue);
  roads.filter(r => r !== venue).sort((a, b) => roadLen(b.mpts) - roadLen(a.mpts)).forEach(r => labelCands.push(r));
  for (const r of labelCands) {
    if (labelCount >= 3) break;
    if (labeled.has(r.name)) continue;
    const s = labelAlong(shortName(r.name), r.mpts, r === venue ? 7 : 6.5);
    if (s) { parts.push(s); labeled.add(r.name); labelCount++; }
  }
  /* Patokan: tempat ibadah & sekolah bernama, maks 3 terdekat */
  function lmKind(t) {
    const nm = t.name || "";
    if (t.amenity === "place_of_worship") {
      if (t.religion === "muslim" || /masjid|musholla|musala|langgar/i.test(nm)) return "mosque";
      if (t.religion === "christian" || /gereja|church|katolik|kristen|protestan/i.test(nm)) return "church";
      return "mosque";
    }
    if (t.amenity === "school" || /sekolah|\bsmp\b|\bsma\b|\bsmk\b|\bsd\b/i.test(nm)) return "school";
    if (/masjid|musholla|musala/i.test(nm)) return "mosque";
    if (/gereja/i.test(nm)) return "church";
    return null;
  }
  const lms = [];
  (data.elements || []).forEach(e => {
    const t = e.tags || {};
    if (!t.name) return;
    const kind = lmKind(t);
    if (!kind) return;
    let la, lo;
    if (e.type === "node") { la = e.lat; lo = e.lon; }
    else if (e.geometry && e.geometry.length) { let sa = 0, so = 0; e.geometry.forEach(g => { sa += g.lat; so += g.lon; }); la = sa / e.geometry.length; lo = so / e.geometry.length; }
    else return;
    const p = proj(la, lo);
    if (Math.abs(p[0]) > HALF * 0.98 || Math.abs(p[1]) > HALF * 0.98) return;
    lms.push({ kind: kind, name: t.name, m: p, d: Math.hypot(p[0], p[1]) });
  });
  lms.sort((a, b) => a.d - b.d);
  const picked = [], seenName = new Set();
  for (const l of lms) { if (picked.length >= 3) break; if (seenName.has(l.name)) continue; seenName.add(l.name); picked.push(l); }
  const mosqueSym = (x, y) => '<g fill="#2E7D6B"><circle cx="' + F(x) + '" cy="' + F(y - 2) + '" r="6.5"/><rect x="' + F(x - 6.5) + '" y="' + F(y - 2) + '" width="13" height="4"/><rect x="' + F(x - 1.5) + '" y="' + F(y - 11) + '" width="3" height="9"/><circle cx="' + F(x) + '" cy="' + F(y - 12) + '" r="2.5"/></g>';
  const churchSym = (x, y) => '<g fill="#8A5A2B"><rect x="' + F(x - 6) + '" y="' + F(y - 2) + '" width="12" height="6"/><polygon points="' + F(x - 7.5) + "," + F(y - 2) + " " + F(x + 7.5) + "," + F(y - 2) + " " + F(x) + "," + F(y - 9) + '"/><rect x="' + F(x - 1) + '" y="' + F(y - 14) + '" width="2" height="6"/><rect x="' + F(x - 3) + '" y="' + F(y - 12) + '" width="6" height="2"/></g>';
  const schoolSym = (x, y) => '<g fill="#3E6FB0"><polygon points="' + F(x - 6) + "," + F(y + 4) + " " + F(x + 6) + "," + F(y + 4) + " " + F(x) + "," + F(y - 5) + '"/><rect x="' + F(x - 6) + '" y="' + F(y + 4) + '" width="12" height="2"/></g>';
  const lmColor = k => k === "mosque" ? "#2E7D6B" : k === "church" ? "#8A5A2B" : "#3E6FB0";
  picked.forEach(l => {
    const v = toV(l.m);
    let x = v[0], y = v[1];
    if (Math.hypot(x - VB / 2, y - VB / 2) < 30) {
      parts.push('<line x1="' + F(x) + '" y1="' + F(y) + '" x2="' + F(x - 16) + '" y2="' + F(y + 4) + '" stroke="#8A8378" stroke-width="1"/>');
      parts.push('<circle cx="' + F(x) + '" cy="' + F(y) + '" r="1.8" fill="' + lmColor(l.kind) + '"/>');
      x -= 16; y += 4;
    }
    parts.push(l.kind === "mosque" ? mosqueSym(x, y) : l.kind === "church" ? churchSym(x, y) : schoolSym(x, y));
    if (l.kind !== "school") {
      let label = l.name;
      if (l.kind === "church" && /^Gereja Katolik/i.test(label)) label = "Gereja Katolik";
      else if (label.length > 24) label = label.slice(0, 23) + "…";
      if ((l.kind === "mosque" && x >= 76) || (l.kind === "church" && x > 164)) {
        parts.push('<text x="' + F(x - 9) + '" y="' + F(y + 2) + '" text-anchor="end" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="#4A4438">' + ddEsc(label) + "</text>");
      } else {
        parts.push('<text x="' + F(x + 10) + '" y="' + F(y + 2) + '" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="#4A4438">' + ddEsc(label) + "</text>");
      }
    }
  });
  /* Pin venue + panah utara + bingkai */
  parts.push('<g><ellipse cx="120" cy="118" rx="11" ry="11" fill="#C0392B" stroke="white" stroke-width="1.5"/><polygon points="114,124 126,124 120,134" fill="#C0392B"/><circle cx="120" cy="118" r="4" fill="white"/></g>');
  parts.push('<g><circle cx="222" cy="18" r="10" fill="white" stroke="#4A4438" stroke-width="1.2"/><polygon points="222,10 217,21 227,21" fill="#4A4438"/><text x="222" y="34" text-anchor="middle" font-family="Verdana, DejaVu Sans, sans-serif" font-size="7" font-weight="bold" fill="#4A4438">U</text></g>');
  parts.push('<rect x="1" y="1" width="238" height="238" fill="none" stroke="#B9B2A2" stroke-width="2"/>');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">\n' + parts.join("\n") + "\n</svg>";
}

async function ddMakeDenah(input, onFallback) {
  if (/heritage/i.test(input)) return ddHeritageUrl();
  let coords = ddCoordsFromLink(input);
  if (!coords) coords = await ddGeocode(ddQueryFromInput(input));
  if (ddDistM(coords, HERITAGE_LL) < 100) return ddHeritageUrl();
  const data = await ddOverpass(coords.lat, coords.lon, onFallback);
  return ddSvgUrl(ddBuildSvg(data, coords.lat, coords.lon));
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
    if (ddIsShortLink(input)) {
      ddShowErr("Link pendek (maps.app.goo.gl) tidak bisa dibaca browser untuk membuat denah. Tempel link panjang Google Maps (google.com/maps/…) atau ketik nama / alamat venue-nya.");
      return;
    }
    ddBusy = true;
    const go = $("ddGo");
    go.disabled = true; go.textContent = "Membuat…";
    ddShowStatus("Sedang mencari lokasi dan menggambar denah dari peta sekitar venue…");
    try {
      denahUrl = await ddMakeDenah(input, () => ddShowStatus("Server peta pertama tidak merespons — mencoba server peta cadangan…"));
    } catch (e) {
      ddBusy = false; go.disabled = false; go.textContent = "Hasilkan"; ddShowStatus("");
      ddShowErr(e && e.notfound
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
