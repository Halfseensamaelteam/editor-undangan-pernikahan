"use strict";
/* ============================================================
   EXPORT — PNG raster (tetap), PDF raster lama (cadangan), dan
   EXPORT VEKTOR: PDF Vektor + .AI.
   Di PDF Vektor tiap elemen digambar sebagai objek terpisah:
   teks sebagai teks asli (font TTF disematkan), QR sebagai modul
   vektor, denah SVG diterjemahkan ke bentuk/teks vektor jsPDF,
   foto & latar sebagai gambar yang disematkan. File .AI berisi
   vektor yang sama persis, disimpan dengan nama .ai — itu file
   PDF-compatible yang dibuka Illustrator sebagai objek yang bisa
   diedit/dipindah (bukan .ai native berlapis).
   ============================================================ */

/* ---------- Util gambar raster (dipakai PNG + cadangan raster) ---------- */
const imgCache = new Map();
function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
  imgCache.set(src, p);
  return p;
}
function svgImage(svg, w, h) {
  return new Promise((res, rej) => {
    const s2 = svg.replace("<svg ", `<svg width="${w}" height="${h}" `);
    const url = URL.createObjectURL(new Blob([s2], { type: "image/svg+xml;charset=utf-8" }));
    const im = new Image();
    im.onload = () => res({ im: im, url: url });
    im.onerror = e => { URL.revokeObjectURL(url); rej(e); };
    im.src = url;
  });
}
function canvasBg(ctx, bg, w, h) {
  if (bg.kind === "solid") { ctx.fillStyle = bg.c; ctx.fillRect(0, 0, w, h); return; }
  let g;
  if (bg.kind === "linear") g = bg.dir === "d" ? ctx.createLinearGradient(0, 0, w, h) : ctx.createLinearGradient(0, 0, 0, h);
  else g = ctx.createRadialGradient(w / 2, 0.3 * h, 10, w / 2, 0.3 * h, 0.75 * h);
  bg.stops.forEach(([o, c]) => g.addColorStop(o, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
function clipShape(ctx, el, s) {
  const x = el.x * s, y = el.y * s, w = el.w * s, h = el.h * s;
  ctx.beginPath();
  if (el.shape === "circle" || el.shape === "oval") ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
  else if (el.shape === "arch") {
    const r = w / 2;
    ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath();
  } else {
    const r = (el.shape === "straight" ? 6 : 26) * s;
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  ctx.clip();
}
function drawDividerCanvas(ctx, el, s) {
  const x = el.x * s, cy = (el.y + el.h / 2) * s, w = el.w * s, lw = Math.max(1.4, 1.8 * s);
  ctx.strokeStyle = el.color; ctx.fillStyle = el.color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(x + w * (4 / 300), cy); ctx.lineTo(x + w * (118 / 300), cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w * (182 / 300), cy); ctx.lineTo(x + w * (296 / 300), cy); ctx.stroke();
  const c = (cx, r) => { ctx.beginPath(); ctx.arc(cx, cy, r * s, 0, 2 * Math.PI); ctx.fill(); };
  c(x + w * (128 / 300), 2.6); c(x + w * (172 / 300), 2.6); c(x + w / 2, 2.4);
  const cx = x + w / 2, p = 9 * s;
  ctx.beginPath(); ctx.moveTo(cx, cy - p); ctx.lineTo(cx + p, cy); ctx.lineTo(cx, cy + p); ctx.lineTo(cx - p, cy); ctx.closePath(); ctx.stroke();
}
function drawTextCanvas(ctx, el, s) {
  ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : "400 "}${el.size * s}px ${fam(el.font)}`;
  try { ctx.letterSpacing = el.ls * s + "px"; } catch (e) { /* abaikan */ }
  ctx.fillStyle = el.color; ctx.textBaseline = "top";
  const w = el.w * s, lh = el.size * s * el.lh, lines = [];
  el.text.split("\n").forEach(par => {
    if (par === "") { lines.push(""); return; }
    if (el.oneLine) { lines.push(par); return; }
    const words = par.split(/\s+/); let cur = "";
    words.forEach(word => {
      const cand = cur ? cur + " " + word : word;
      if (cur && ctx.measureText(cand).width > w) { lines.push(cur); cur = word; } else cur = cand;
    });
    lines.push(cur);
  });
  if (el.rot) {
    ctx.save();
    ctx.translate((el.x + el.w / 2) * s, el.y * s + lines.length * lh / 2);
    ctx.rotate(Math.PI);
    ctx.translate(-(el.x + el.w / 2) * s, -(el.y * s + lines.length * lh / 2));
  }
  lines.forEach((line, i) => {
    const rw = ctx.measureText(line).width;
    let lx = el.x * s;
    if (el.align === "center") lx = el.x * s + (w - rw) / 2;
    else if (el.align === "right") lx = el.x * s + (w - rw);
    ctx.fillText(line, lx, el.y * s + i * lh);
  });
  try { ctx.letterSpacing = "0px"; } catch (e) { /* abaikan */ }
  if (el.rot) ctx.restore();
}
async function renderPrintCanvas(widthPx, elements, bgImgSrc) {
  const els = elements || state.elements;
  await Promise.all(els.filter(e => e.type === "text").map(e => loadFontFull(e.font)));
  await document.fonts.ready;
  const s = widthPx / W, hPx = Math.round(H * s);
  const cv = document.createElement("canvas");
  cv.width = widthPx; cv.height = hPx;
  const ctx = cv.getContext("2d");
  if (bgImgSrc) {
    const im = await loadImg(bgImgSrc);
    ctx.drawImage(im, 0, 0, widthPx, hPx);
  } else {
    canvasBg(ctx, state.bg, widthPx, hPx);
    const d = await svgImage(decorSVG(state.template), widthPx, hPx);
    ctx.drawImage(d.im, 0, 0, widthPx, hPx);
    URL.revokeObjectURL(d.url);
  }
  for (const el of els) {
    if (el.type === "image") {
      const im = await loadImg(el.src);
      if (!el.nw) { el.nw = im.naturalWidth; el.nh = im.naturalHeight; }
      ctx.save(); clipShape(ctx, el, s);
      const g = imgGeom(el);
      ctx.drawImage(im, g.dx * s, g.dy * s, g.dw * s, g.dh * s);
      ctx.restore();
    } else if (el.type === "text") drawTextCanvas(ctx, el, s);
    else if (el.type === "qr") {
      const im = await loadImg(qrSrc(el));
      if (el.rot) {
        ctx.save();
        ctx.translate((el.x + el.w / 2) * s, (el.y + el.h / 2) * s);
        ctx.rotate(Math.PI);
        ctx.fillStyle = "#ffffff"; ctx.fillRect(-el.w * s / 2, -el.h * s / 2, el.w * s, el.h * s);
        ctx.drawImage(im, -el.w * s / 2, -el.h * s / 2, el.w * s, el.h * s);
        ctx.restore();
      } else {
        ctx.fillStyle = "#ffffff"; ctx.fillRect(el.x * s, el.y * s, el.w * s, el.h * s);
        ctx.drawImage(im, el.x * s, el.y * s, el.w * s, el.h * s);
      }
    } else if (el.type === "divider") drawDividerCanvas(ctx, el, s);
  }
  return cv;
}
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function canvasBlob(cv, type, q) { return new Promise(res => cv.toBlob(res, type, q)); }

/* ---------- PNG (raster, tidak berubah) ---------- */
async function exportPNG(btn) {
  btn.disabled = true;
  try {
    if (isCL()) {
      const cv = await renderPrintCanvas(W, state.elements, clBg(state.page));
      saveBlob(await canvasBlob(cv, "image/png"), "undangan-" + state.template + "-halaman-" + (state.page + 1) + ".png");
      toast("PNG tersimpan — " + W + " × " + H + " px " + (H > W ? "portrait" : "landscape") + ", halaman " + (state.page + 1) + " dari " + state.pageEls.length + ".");
    } else {
      const cv = await renderPrintCanvas(2480);
      saveBlob(await canvasBlob(cv, "image/png"), "undangan-pernikahan.png");
      toast("PNG tersimpan — 2480 × 3508 px (300 DPI), siap dibawa ke percetakan.");
    }
  } catch (e) { toast("Maaf, ekspor PNG gagal. Coba lagi ya."); }
  btn.disabled = false;
  $("dlmenu").classList.remove("open");
}

/* ---------- PDF raster lama (hanya cadangan bila vektor gagal total) ---------- */
async function exportRasterPDF(btn) {
  btn.disabled = true;
  try {
    if (isCL()) {
      if (window.jspdf && window.jspdf.jsPDF) {
        const land = W >= H, f = land ? [297, 217] : [217, 297], orient = land ? "landscape" : "portrait";
        const doc = new window.jspdf.jsPDF({ unit: "mm", format: f, orientation: orient });
        for (let p = 0; p < state.pageEls.length; p++) {
          const data = (await renderPrintCanvas(W, state.pageEls[p], clBg(p))).toDataURL("image/jpeg", 0.96);
          if (p > 0) doc.addPage(f, orient);
          doc.addImage(data, "JPEG", 0, 0, f[0], f[1]);
        }
        doc.save("undangan-" + state.template + ".pdf");
        toast("PDF tersimpan — " + orient + " " + state.pageEls.length + " halaman, siap dibawa ke percetakan.");
      } else {
        const cv = await renderPrintCanvas(W, state.elements, clBg(state.page));
        saveBlob(await canvasBlob(cv, "image/png"), "undangan-" + state.template + "-halaman-" + (state.page + 1) + ".png");
        toast("Pustaka PDF tidak termuat, jadi PNG halaman ini yang diunduh — tetap siap cetak.");
      }
      btn.disabled = false;
      $("dlmenu").classList.remove("open");
      return;
    }
    const cv = await renderPrintCanvas(2480), data = cv.toDataURL("image/jpeg", 0.96);
    if (window.jspdf && window.jspdf.jsPDF) {
      const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a5", orientation: "portrait" });
      doc.addImage(data, "JPEG", 0, 0, 148, 210);
      doc.save("undangan-pernikahan.pdf");
      toast("PDF siap cetak tersimpan — ukuran A5, 300 DPI.");
    } else {
      saveBlob(await canvasBlob(cv, "image/png"), "undangan-pernikahan.png");
      toast("Pustaka PDF tidak termuat, jadi PNG resolusi tinggi yang diunduh — tetap siap cetak.");
    }
  } catch (e) { toast("Maaf, ekspor PDF gagal. Coba unduh PNG-nya ya."); }
  btn.disabled = false;
  $("dlmenu").classList.remove("open");
}

/* ============================================================
   MESIN EXPORT VEKTOR
   ============================================================ */
function vxHexRgb(hex) {
  const s = String(hex || "").trim().toLowerCase();
  const named = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0] };
  if (named[s]) return named[s];
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  m = /^#?([0-9a-f]{3})$/.exec(s);
  if (m) return m[1].split("").map(c => parseInt(c + c, 16));
  return [0, 0, 0];
}
function vxB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function vxStyleKey(el) { return el.bold && el.italic ? "bolditalic" : el.bold ? "bold" : el.italic ? "italic" : "normal"; }
function vxStandardFont(family) {
  let cat = null;
  if (typeof FONT_CATALOG !== "undefined") {
    const hit = FONT_CATALOG.find(([n]) => n === family);
    if (hit) cat = hit[1];
  }
  if (cat === 4) return "courier";
  if (cat === 1) return "helvetica";
  return "times";
}

/* ---------- Font TTF dari repo google/fonts (GitHub) ---------- */
const vxFontDirCache = new Map(), vxFontFileCache = new Map();
function vxSlug(family) { return String(family).toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function vxFontDir(slug) {
  if (vxFontDirCache.has(slug)) return vxFontDirCache.get(slug);
  const p = (async () => {
    for (const base of ["ofl", "apache", "ufl"]) {
      try {
        const r = await fetch("https://api.github.com/repos/google/fonts/contents/" + base + "/" + slug);
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) {
          const names = j.filter(x => x.type === "file" && /\.ttf$/i.test(x.name)).map(x => x.name);
          if (names.length) return { base: base, names: names };
        }
      } catch (e) { /* lanjut ke basis berikutnya */ }
    }
    return null;
  })();
  vxFontDirCache.set(slug, p);
  return p;
}
function vxPickFontFile(names, style) {
  const wantItalic = style === "italic" || style === "bolditalic";
  const wantBold = style === "bold" || style === "bolditalic";
  const info = names.map(n => {
    const low = n.toLowerCase();
    return { n: n, italic: /italic/.test(low), variable: /\[.+\]/.test(n), bold: /bold/.test(low), regular: /regular/.test(low), other: /medium|semibold|extrabold|black|light|thin/.test(low) };
  });
  let pool = info.filter(f => f.italic === wantItalic);
  if (!pool.length) pool = info.slice();
  const score = f => {
    let s = 0;
    if (wantBold) { if (/-bolditalic/i.test(f.n)) s += wantItalic ? 60 : -60; else if (/-bold(\.|\[)/i.test(f.n)) s += 50; else if (f.bold) s += 30; if (f.variable) s += 15; }
    else { if (f.regular) s += 40; if (/-regular/i.test(f.n)) s += 10; if (f.bold) s -= 25; if (f.variable) s += 10; }
    if (f.other) s -= 15;
    return s;
  };
  pool.sort((a, b) => score(b) - score(a));
  return pool.length ? pool[0].n : null;
}
async function vxFetchFont(family, style) {
  const key = vxSlug(family) + "|" + style;
  if (vxFontFileCache.has(key)) return vxFontFileCache.get(key);
  const p = (async () => {
    const dir = await vxFontDir(vxSlug(family));
    if (!dir) return null;
    const file = vxPickFontFile(dir.names, style);
    if (!file) return null;
    const base = "https://raw.githubusercontent.com/google/fonts/main/" + dir.base + "/" + vxSlug(family) + "/";
    for (const u of [base + encodeURIComponent(file), base + file]) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        if (buf && buf.byteLength > 8000) return { fileName: file, base64: vxB64(buf) };
      } catch (e) { /* coba URL berikutnya */ }
    }
    return null;
  })().catch(() => null);
  vxFontFileCache.set(key, p);
  return p;
}
async function vxRegisterFonts(doc, needs) {
  const fontMap = new Map(), embedded = [], fallback = [];
  const vfsDone = new Set();
  for (const [family, styles] of needs) {
    const internal = "vx" + vxSlug(family);
    const files = {};
    for (const st of styles) { const f = await vxFetchFont(family, st); if (f) files[st] = f; }
    if (files.normal || files[styles.values().next().value]) {
      let partial = false;
      for (const st of styles) {
        const f = files[st] || files.normal || files.bold || files.italic;
        if (!f) { partial = true; continue; }
        if (!files[st]) partial = true;
        const vfsName = internal + "-" + st + ".ttf";
        try {
          if (!vfsDone.has(vfsName)) { doc.addFileToVFS(vfsName, f.base64); vfsDone.add(vfsName); }
          doc.addFont(vfsName, internal, st);
        } catch (e) { partial = true; }
      }
      let registered = true;
      try { const fl = doc.getFontList(); registered = !!fl[internal]; } catch (e) { registered = true; }
      if (!registered) {
        fontMap.set(family, vxStandardFont(family));
        fallback.push(family);
        continue;
      }
      fontMap.set(family, internal);
      embedded.push(family);
      if (partial) fallback.push(family + " (sebagian gaya memakai font cadangan)");
    } else {
      fontMap.set(family, vxStandardFont(family));
      fallback.push(family);
    }
  }
  return { fontMap: fontMap, embedded: embedded, fallback: fallback };
}

/* ---------- Parser SVG kecil (subset denah & ornamen kita) ---------- */
function vxDecodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function vxParseSvg(svg) {
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>)|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  const parseAttrs = s => {
    const o = {}, r = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
    let mm;
    while ((mm = r.exec(s))) o[mm[1] || mm[3]] = vxDecodeEntities(mm[2] !== undefined && mm[2] !== null ? mm[2] : mm[4]);
    return o;
  };
  while ((m = re.exec(svg))) {
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[6] !== undefined) { stack[stack.length - 1].text += vxDecodeEntities(m[6]); continue; }
    if (!m[3]) continue;
    const closing = m[2] === "/", tag = m[3].toLowerCase(), selfClose = m[5] === "/";
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const node = { tag: tag, attrs: parseAttrs(m[4] || ""), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  const findSvg = n => {
    if (n.tag === "svg") return n;
    for (const c of n.children) { const f = findSvg(c); if (f) return f; }
    return null;
  };
  return findSvg(root);
}
/* Matriks afin 2D [a,b,c,d,e,f]: (x,y) -> (a*x + c*y + e, b*x + d*y + f) */
function vxMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}
function vxApplyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function vxParseTransform(str) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!str) return m;
  const re = /(translate|rotate|scale|matrix)\s*\(([^)]*)\)/g;
  let mm;
  while ((mm = re.exec(str))) {
    const v = mm[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = [1, 0, 0, 1, 0, 0];
    if (mm[1] === "translate") t = [1, 0, 0, 1, v[0] || 0, v.length > 1 ? v[1] : 0];
    else if (mm[1] === "rotate") {
      const a = (v[0] || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a), rot = [cos, sin, -sin, cos, 0, 0];
      t = v.length >= 3 ? vxMul(vxMul([1, 0, 0, 1, v[1], v[2]], rot), [1, 0, 0, 1, -v[1], -v[2]]) : rot;
    } else if (mm[1] === "scale") t = [v[0] === undefined ? 1 : v[0], 0, 0, v.length > 1 ? v[1] : (v[0] === undefined ? 1 : v[0]), 0, 0];
    else if (mm[1] === "matrix" && v.length === 6) t = v.slice();
    m = vxMul(m, t);
  }
  return m;
}
/* Path SVG -> subpath absolut: {start:[x,y], segs:[{t:'L',from,p}|{t:'C',from,p1,p2,p}|{t:'Q',from,p1,p}], closed} */
function vxParsePath(d) {
  const tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const subs = [];
  let i = 0, cmd = null, cur = [0, 0], start = [0, 0], sub = null, prevC2 = null, prevQ1 = null;
  const num = () => parseFloat(tokens[i++]);
  const hasNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  function newSub(p) { sub = { start: [p[0], p[1]], segs: [], closed: false }; subs.push(sub); start = [p[0], p[1]]; cur = [p[0], p[1]]; }
  function ensureSub() { if (!sub) newSub(cur); }
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) { cmd = tokens[i++]; if (cmd === "Z" || cmd === "z") { if (sub) { sub.closed = true; if (cur[0] !== start[0] || cur[1] !== start[1]) sub.segs.push({ t: "L", from: [cur[0], cur[1]], p: [start[0], start[1]] }); cur = [start[0], start[1]]; } prevC2 = prevQ1 = null; } continue; }
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === "M") {
      let x = num(), y = num(); if (rel) { x += cur[0]; y += cur[1]; }
      newSub([x, y]); prevC2 = prevQ1 = null;
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      ensureSub(); let x = num(), y = num(); if (rel) { x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "L", from: [cur[0], cur[1]], p: [x, y] }); cur = [x, y]; prevC2 = prevQ1 = null;
    } else if (C === "H") {
      ensureSub(); let x = num(); if (rel) x += cur[0];
      sub.segs.push({ t: "L", from: [cur[0], cur[1]], p: [x, cur[1]] }); cur = [x, cur[1]]; prevC2 = prevQ1 = null;
    } else if (C === "V") {
      ensureSub(); let y = num(); if (rel) y += cur[1];
      sub.segs.push({ t: "L", from: [cur[0], cur[1]], p: [cur[0], y] }); cur = [cur[0], y]; prevC2 = prevQ1 = null;
    } else if (C === "C") {
      ensureSub();
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += cur[0]; y1 += cur[1]; x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "C", from: [cur[0], cur[1]], p1: [x1, y1], p2: [x2, y2], p: [x, y] });
      prevC2 = [x2, y2]; prevQ1 = null; cur = [x, y];
    } else if (C === "S") {
      ensureSub();
      const x1 = prevC2 ? 2 * cur[0] - prevC2[0] : cur[0], y1 = prevC2 ? 2 * cur[1] - prevC2[1] : cur[1];
      let x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "C", from: [cur[0], cur[1]], p1: [x1, y1], p2: [x2, y2], p: [x, y] });
      prevC2 = [x2, y2]; prevQ1 = null; cur = [x, y];
    } else if (C === "Q") {
      ensureSub();
      let x1 = num(), y1 = num(), x = num(), y = num();
      if (rel) { x1 += cur[0]; y1 += cur[1]; x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "Q", from: [cur[0], cur[1]], p1: [x1, y1], p: [x, y] });
      prevQ1 = [x1, y1]; prevC2 = null; cur = [x, y];
    } else if (C === "T") {
      ensureSub();
      const x1 = prevQ1 ? 2 * cur[0] - prevQ1[0] : cur[0], y1 = prevQ1 ? 2 * cur[1] - prevQ1[1] : cur[1];
      let x = num(), y = num(); if (rel) { x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "Q", from: [cur[0], cur[1]], p1: [x1, y1], p: [x, y] });
      prevQ1 = [x1, y1]; prevC2 = null; cur = [x, y];
    } else if (C === "A") {
      /* Busur: disederhanakan jadi garis ke titik akhir (denah & ornamen kita tidak memakainya). */
      ensureSub();
      num(); num(); num(); num(); num();
      let x = num(), y = num(); if (rel) { x += cur[0]; y += cur[1]; }
      sub.segs.push({ t: "L", from: [cur[0], cur[1]], p: [x, y] }); cur = [x, y]; prevC2 = prevQ1 = null;
    } else break;
    if (!hasNum() && cmd !== null && !/^[a-zA-Z]$/.test(tokens[i] || "")) { /* lanjut */ }
  }
  return subs.filter(s => s.segs.length);
}

/* ---------- Gambar SVG sebagai vektor jsPDF ---------- */
function vxPaint(doc, st, scaleAvg) {
  const fillNone = !st.fill || st.fill === "none";
  const strokeNone = !st.stroke || st.stroke === "none";
  if (fillNone && strokeNone) return null;
  if (!fillNone) { const c = vxHexRgb(st.fill); doc.setFillColor(c[0], c[1], c[2]); }
  if (!strokeNone) {
    const c = vxHexRgb(st.stroke);
    doc.setDrawColor(c[0], c[1], c[2]);
    doc.setLineWidth(Math.max(0.05, (parseFloat(st.strokeWidth) || 1) * scaleAvg));
    if (typeof doc.setLineCap === "function" && st.lineCap) doc.setLineCap(st.lineCap === "butt" ? "butt" : st.lineCap);
    if (typeof doc.setLineJoin === "function" && st.lineJoin) doc.setLineJoin(st.lineJoin);
  }
  return fillNone ? "S" : strokeNone ? "F" : "DF";
}
function vxPathLines(doc, subs, matrix, styleStr) {
  for (const sp of subs) {
    const start = vxApplyM(matrix, sp.start[0], sp.start[1]);
    const lines = sp.segs.map(sg => {
      const a = vxApplyM(matrix, sg.from[0], sg.from[1]), b = vxApplyM(matrix, sg.p[0], sg.p[1]);
      if (sg.t === "L") return [b[0] - a[0], b[1] - a[1]];
      if (sg.t === "C") {
        const c1 = vxApplyM(matrix, sg.p1[0], sg.p1[1]), c2 = vxApplyM(matrix, sg.p2[0], sg.p2[1]);
        return [c1[0] - a[0], c1[1] - a[1], c2[0] - a[0], c2[1] - a[1], b[0] - a[0], b[1] - a[1]];
      }
      /* Q -> kubik: c1 = from + 2/3(q-from), c2 = p + 2/3(q-p) */
      const q = vxApplyM(matrix, sg.p1[0], sg.p1[1]);
      const c1 = [a[0] + 2 / 3 * (q[0] - a[0]), a[1] + 2 / 3 * (q[1] - a[1])];
      const c2 = [b[0] + 2 / 3 * (q[0] - b[0]), b[1] + 2 / 3 * (q[1] - b[1])];
      return [c1[0] - a[0], c1[1] - a[1], c2[0] - a[0], c2[1] - a[1], b[0] - a[0], b[1] - a[1]];
    });
    doc.lines(lines, start[0], start[1], [1, 1], styleStr, sp.closed);
  }
}
function vxPointsPath(pts, closed) {
  if (pts.length < 2) return [];
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push({ t: "L", from: pts[i], p: pts[i + 1] });
  return [{ start: pts[0], segs: segs, closed: !!closed }];
}
function vxDrawSvg(doc, svgText, dx, dy, dw, dh) {
  const rootSvg = vxParseSvg(svgText);
  if (!rootSvg) throw new Error("svg parse gagal");
  let vb = [0, 0, 240, 240];
  if (rootSvg.attrs.viewBox) {
    const parts = rootSvg.attrs.viewBox.split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) vb = parts;
  } else if (rootSvg.attrs.width && rootSvg.attrs.height) vb = [0, 0, parseFloat(rootSvg.attrs.width), parseFloat(rootSvg.attrs.height)];
  const kx = dw / vb[2], ky = dh / vb[3];
  const base = [kx, 0, 0, ky, dx - vb[0] * kx, dy - vb[1] * ky];
  const clip = [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]];
  const idMap = {};
  (function collect(n) { if (n.attrs && n.attrs.id) idMap[n.attrs.id] = n; (n.children || []).forEach(collect); })(rootSvg);
  const baseStyle = { fill: "#000000", stroke: "none", strokeWidth: 1, lineCap: "butt", lineJoin: "miter", fontFamily: "helvetica", fontSize: 0, fontWeight: "normal", opacity: 1 };
  function mergeStyle(st, attrs) {
    const o = Object.assign({}, st);
    if (attrs.fill !== undefined) o.fill = attrs.fill;
    if (attrs.stroke !== undefined) o.stroke = attrs.stroke;
    if (attrs["stroke-width"] !== undefined) o.strokeWidth = parseFloat(attrs["stroke-width"]) || 0;
    if (attrs["stroke-linecap"] !== undefined) o.lineCap = attrs["stroke-linecap"];
    if (attrs["stroke-linejoin"] !== undefined) o.lineJoin = attrs["stroke-linejoin"];
    if (attrs["font-family"] !== undefined) o.fontFamily = attrs["font-family"];
    if (attrs["font-size"] !== undefined) o.fontSize = parseFloat(attrs["font-size"]) || 0;
    if (attrs["font-weight"] !== undefined) o.fontWeight = attrs["font-weight"];
    if (attrs.opacity !== undefined) o.opacity = parseFloat(attrs.opacity);
    return o;
  }
  function withOpacity(st, fn) {
    let used = false;
    try {
      if (st.opacity !== undefined && st.opacity < 1 && typeof doc.GState === "function" && typeof doc.setGState === "function") {
        doc.setGState(new doc.GState({ opacity: st.opacity }));
        used = true;
      }
    } catch (e) { /* abaikan */ }
    fn();
    if (used) { try { doc.setGState(new doc.GState({ opacity: 1 })); } catch (e) { /* abaikan */ } }
  }
  /* --- Clipping ke viewBox, di ruang akar SVG (seperti <img> memotong SVG) --- */
  function clipSeg(p, q) {
    let t0 = 0, t1 = 1;
    const ddx = q[0] - p[0], ddy = q[1] - p[1];
    const edges = [[-ddx, p[0] - clip[0]], [ddx, clip[2] - p[0]], [-ddy, p[1] - clip[1]], [ddy, clip[3] - p[1]]];
    for (let k = 0; k < 4; k++) {
      const a = edges[k][0], b = edges[k][1];
      if (Math.abs(a) < 1e-12) { if (b < 0) return null; continue; }
      const t = b / a;
      if (a < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    if (t0 > t1) return null;
    return [[p[0] + t0 * ddx, p[1] + t0 * ddy], [p[0] + t1 * ddx, p[1] + t1 * ddy]];
  }
  function clipOpen(pts) {
    const runs = [];
    let run = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = clipSeg(pts[i], pts[i + 1]);
      if (!seg) { run = null; continue; }
      if (run && Math.abs(run[run.length - 1][0] - seg[0][0]) < 1e-9 && Math.abs(run[run.length - 1][1] - seg[0][1]) < 1e-9) run.push(seg[1]);
      else { run = [seg[0], seg[1]]; runs.push(run); }
    }
    return runs.filter(r => r.length > 1);
  }
  function clipClosed(pts) {
    let out = pts.slice();
    const edges = [
      { inside: p => p[0] >= clip[0], isect: (a, b) => { const t = (clip[0] - a[0]) / ((b[0] - a[0]) || 1e-12); return [clip[0], a[1] + t * (b[1] - a[1])]; } },
      { inside: p => p[0] <= clip[2], isect: (a, b) => { const t = (clip[2] - a[0]) / ((b[0] - a[0]) || 1e-12); return [clip[2], a[1] + t * (b[1] - a[1])]; } },
      { inside: p => p[1] >= clip[1], isect: (a, b) => { const t = (clip[1] - a[1]) / ((b[1] - a[1]) || 1e-12); return [a[0] + t * (b[0] - a[0]), clip[1]]; } },
      { inside: p => p[1] <= clip[3], isect: (a, b) => { const t = (clip[3] - a[1]) / ((b[1] - a[1]) || 1e-12); return [a[0] + t * (b[0] - a[0]), clip[3]]; } }
    ];
    for (const e of edges) {
      if (!out.length) break;
      const inp = out; out = [];
      for (let i = 0; i < inp.length; i++) {
        const cur = inp[i], prv = inp[(i + inp.length - 1) % inp.length];
        const curIn = e.inside(cur), prvIn = e.inside(prv);
        if (curIn) { if (!prvIn) out.push(e.isect(prv, cur)); out.push(cur); }
        else if (prvIn) out.push(e.isect(prv, cur));
      }
    }
    return out;
  }
  function sampleSub(sp) {
    const pts = [[sp.start[0], sp.start[1]]];
    for (const sg of sp.segs) {
      if (sg.t === "L") pts.push([sg.p[0], sg.p[1]]);
      else if (sg.t === "C") {
        const N = 12;
        for (let i = 1; i <= N; i++) {
          const t = i / N, u = 1 - t;
          pts.push([
            u * u * u * sg.from[0] + 3 * u * u * t * sg.p1[0] + 3 * u * t * t * sg.p2[0] + t * t * t * sg.p[0],
            u * u * u * sg.from[1] + 3 * u * u * t * sg.p1[1] + 3 * u * t * t * sg.p2[1] + t * t * t * sg.p[1]
          ]);
        }
      } else if (sg.t === "Q") {
        const N = 10;
        for (let i = 1; i <= N; i++) {
          const t = i / N, u = 1 - t;
          pts.push([
            u * u * sg.from[0] + 2 * u * t * sg.p1[0] + t * t * sg.p[0],
            u * u * sg.from[1] + 2 * u * t * sg.p1[1] + t * t * sg.p[1]
          ]);
        }
      }
    }
    return { pts: pts, closed: sp.closed };
  }
  function drawPts(ptsLocal, closed, rootM, styleStr) {
    const root = ptsLocal.map(p => vxApplyM(rootM, p[0], p[1]));
    if (closed) {
      const cl = clipClosed(root);
      if (cl.length > 1) vxPathLines(doc, vxPointsPath(cl, true), base, styleStr);
    } else {
      clipOpen(root).forEach(run => vxPathLines(doc, vxPointsPath(run, false), base, styleStr));
    }
  }
  function walk(node, rootM, st) {
    const local = vxMul(rootM, vxParseTransform(node.attrs.transform));
    const s2 = mergeStyle(st, node.attrs);
    const full = vxMul(base, local);
    const scaleAvg = (Math.hypot(full[0], full[1]) + Math.hypot(full[2], full[3])) / 2;
    const tag = node.tag;
    if (tag === "svg" || tag === "g") { node.children.forEach(c => walk(c, local, s2)); return; }
    if (tag === "defs" || tag === "title" || tag === "desc") return;
    if (tag === "use") {
      const href = node.attrs.href || node.attrs["xlink:href"] || "";
      const ref = idMap[href.replace(/^#/, "")];
      if (ref) {
        const extra = [1, 0, 0, 1, parseFloat(node.attrs.x) || 0, parseFloat(node.attrs.y) || 0];
        walk(ref, vxMul(local, extra), s2);
      }
      return;
    }
    if (tag === "text") {
      const txt = (node.text || "").trim();
      if (!txt) return;
      const fsMm = (s2.fontSize || 7) * scaleAvg;
      const bold = s2.fontWeight === "bold" || parseInt(s2.fontWeight, 10) >= 600;
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(fsMm * 72 / 25.4);
      const wMm = doc.getTextWidth(txt);
      const anchor = node.attrs["text-anchor"] || "start";
      let sxv = parseFloat(node.attrs.x) || 0;
      const syv = parseFloat(node.attrs.y) || 0;
      const wSvg = scaleAvg > 0 ? wMm / scaleAvg : 0;
      if (anchor === "middle") sxv -= wSvg / 2;
      else if (anchor === "end") sxv -= wSvg;
      const ptRoot = vxApplyM(local, sxv, syv);
      if (ptRoot[0] < clip[0] - 2 || ptRoot[0] > clip[2] + 2 || ptRoot[1] < clip[1] - 2 || ptRoot[1] > clip[3] + 2) return;
      withOpacity(s2, () => {
        const c = vxHexRgb(s2.fill === "none" ? "#000000" : s2.fill);
        doc.setTextColor(c[0], c[1], c[2]);
        const pt = vxApplyM(base, ptRoot[0], ptRoot[1]);
        const ang = Math.atan2(full[1], full[0]) * 180 / Math.PI;
        doc.text(txt, pt[0], pt[1], Math.abs(ang) > 0.01 ? { angle: -ang } : undefined);
      });
      return;
    }
    const styleStr = vxPaint(doc, s2, scaleAvg);
    if (!styleStr) { node.children.forEach(c => walk(c, local, s2)); return; }
    withOpacity(s2, () => {
      if (tag === "rect") {
        const x = parseFloat(node.attrs.x) || 0, y = parseFloat(node.attrs.y) || 0;
        const w = parseFloat(node.attrs.width) || 0, h = parseFloat(node.attrs.height) || 0, rx = parseFloat(node.attrs.rx) || 0;
        const axisAligned = Math.abs(full[1]) < 1e-6 && Math.abs(full[2]) < 1e-6 && full[0] > 0 && full[3] > 0;
        const inside = x >= clip[0] - 0.01 && y >= clip[1] - 0.01 && x + w <= clip[2] + 0.01 && y + h <= clip[3] + 0.01;
        if (rx > 0 && axisAligned && inside) {
          const tl = vxApplyM(full, x, y);
          doc.roundedRect(tl[0], tl[1], w * full[0], h * full[3], rx * full[0], rx * full[3], styleStr);
        } else {
          drawPts([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, local, styleStr);
        }
      } else if (tag === "circle" || tag === "ellipse") {
        const cx = parseFloat(node.attrs.cx) || 0, cy = parseFloat(node.attrs.cy) || 0;
        const rxv = tag === "circle" ? parseFloat(node.attrs.r) || 0 : parseFloat(node.attrs.rx) || 0;
        const ryv = tag === "circle" ? rxv : parseFloat(node.attrs.ry) || 0;
        const ctrRoot = vxApplyM(local, cx, cy);
        const margin = Math.max(rxv, ryv) * 1.6 + 2;
        if (ctrRoot[0] < clip[0] - margin || ctrRoot[0] > clip[2] + margin || ctrRoot[1] < clip[1] - margin || ctrRoot[1] > clip[3] + margin) return;
        const ctr = vxApplyM(base, ctrRoot[0], ctrRoot[1]);
        doc.ellipse(ctr[0], ctr[1], rxv * Math.hypot(full[0], full[1]), ryv * Math.hypot(full[2], full[3]), styleStr);
      } else if (tag === "line") {
        drawPts([[parseFloat(node.attrs.x1) || 0, parseFloat(node.attrs.y1) || 0], [parseFloat(node.attrs.x2) || 0, parseFloat(node.attrs.y2) || 0]], false, local, styleStr);
      } else if (tag === "polygon" || tag === "polyline") {
        const nums = (node.attrs.points || "").split(/[\s,]+/).filter(Boolean).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        if (pts.length > 1) drawPts(pts, tag === "polygon", local, styleStr);
      } else if (tag === "path") {
        if (node.attrs.d) vxParsePath(node.attrs.d).forEach(sp => { const smp = sampleSub(sp); drawPts(smp.pts, smp.closed, local, styleStr); });
      }
    });
    node.children.forEach(c => walk(c, local, s2));
  }
  walk(rootSvg, [1, 0, 0, 1, 0, 0], baseStyle);
}

/* ---------- Gambar elemen halaman sebagai vektor ---------- */
function vxWrapLines(doc, el, maxWMm, csMm) {
  const lines = [];
  const widthOf = str => str ? doc.getTextWidth(str) + csMm * str.length : 0;
  el.text.split("\n").forEach(par => {
    if (par === "") { lines.push(""); return; }
    if (el.oneLine) { lines.push(par); return; }
    const words = par.split(/\s+/);
    let cur = "";
    words.forEach(word => {
      const cand = cur ? cur + " " + word : word;
      if (cur && widthOf(cand) > maxWMm) { lines.push(cur); cur = word; } else cur = cand;
    });
    lines.push(cur);
  });
  return { lines: lines, widthOf: widthOf };
}
function vxDrawTextEl(doc, el, ctx) {
  const sx = ctx.sx, sy = ctx.sy;
  const family = famName(el.font);
  const internal = ctx.fontMap.get(family) || vxStandardFont(family);
  const style = vxStyleKey(el);
  doc.setFont(internal, style);
  const sizeMm = el.size * sy;
  doc.setFontSize(sizeMm * 72 / 25.4);
  const rgb = vxHexRgb(el.color);
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const csMm = (el.ls || 0) * sx;
  const wrapped = vxWrapLines(doc, el, el.w * sx, csMm);
  const lines = wrapped.lines, widthOf = wrapped.widthOf;
  const lineH = el.size * el.lh * sy;
  const blockH = lines.length * lineH;
  const cxMm = (el.x + el.w / 2) * sx, cyMm = el.y * sy + blockH / 2;
  const opts = csMm ? { charSpace: csMm } : undefined;
  lines.forEach((line, i) => {
    if (!line) return;
    const wMm = widthOf(line);
    let lx = el.x * sx;
    if (el.align === "center") lx = el.x * sx + (el.w * sx - wMm) / 2;
    else if (el.align === "right") lx = el.x * sx + (el.w * sx - wMm);
    const baseline = el.y * sy + i * lineH + el.size * sy * 0.85;
    if (el.rot) {
      const o2 = Object.assign({}, opts || {}, { angle: 180 });
      doc.text(line, 2 * cxMm - lx, 2 * cyMm - baseline, o2);
    } else doc.text(line, lx, baseline, opts);
  });
}
function vxDrawDivider(doc, el, ctx) {
  const sx = ctx.sx, sy = ctx.sy;
  const rgb = vxHexRgb(el.color);
  doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  doc.setLineWidth(Math.max(0.2, 1.8 * sx));
  if (typeof doc.setLineCap === "function") doc.setLineCap("butt");
  const x0 = el.x * sx, wMm = el.w * sx, midY = (el.y + el.h / 2) * sy;
  doc.line(x0 + wMm * (4 / 300), midY, x0 + wMm * (118 / 300), midY);
  doc.line(x0 + wMm * (182 / 300), midY, x0 + wMm * (296 / 300), midY);
  doc.circle(x0 + wMm * (128 / 300), midY, 2.6 * sx, "F");
  doc.circle(x0 + wMm * (172 / 300), midY, 2.6 * sx, "F");
  doc.circle(x0 + wMm / 2, midY, 2.4 * sx, "F");
  const cx = x0 + wMm / 2, p = 9 * sy;
  doc.lines([[9 * sx, p], [-9 * sx, p], [-9 * sx, -p]], cx - 9 * sx, midY - p, [1, 1], "S", true);
}
function vxDrawQr(doc, el, ctx) {
  const sx = ctx.sx, sy = ctx.sy;
  const x = el.x * sx, y = el.y * sy, w = el.w * sx, h = el.h * sy;
  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, w, h, "F");
  let drawn = false;
  if (el.link && typeof qrcode === "function") {
    try {
      const qr = qrcode(0, "M");
      qr.addData(mapsUrl(el.link));
      qr.make();
      const n = qr.getModuleCount(), border = 2, cells = n + 2 * border;
      const cw = w / cells, ch = h / cells;
      const rgb = vxHexRgb(qrSafeColor(el.color || "#000000"));
      doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        let gr = r + border, gc = c + border;
        if (el.rot) { gr = cells - 1 - gr; gc = cells - 1 - gc; }
        doc.rect(x + gc * cw, y + gr * ch, cw + 0.02, ch + 0.02, "F");
      }
      drawn = true;
    } catch (e) { drawn = false; }
  }
  if (!drawn && el.__qrImg) doc.addImage(el.__qrImg, "PNG", x, y, w, h);
}
function vxDrawImageEl(doc, el, ctx) {
  const x = el.x * ctx.sx, y = el.y * ctx.sy, w = el.w * ctx.sx, h = el.h * ctx.sy;
  if (el.__svg) { vxDrawSvg(doc, el.__svg, x, y, w, h); return; }
  if (el.__img) doc.addImage(el.__img, "PNG", x, y, w, h);
}
function vxDrawPage(doc, page, fontMap) {
  const ctx = { sx: page.mm[0] / page.W, sy: page.mm[1] / page.H, fontMap: fontMap };
  if (page.bgColor) {
    const c = vxHexRgb(page.bgColor);
    doc.setFillColor(c[0], c[1], c[2]);
    doc.rect(0, 0, page.mm[0], page.mm[1], "F");
  }
  if (page.bgImage) doc.addImage(page.bgImage.data, page.bgImage.format || "JPEG", 0, 0, page.mm[0], page.mm[1]);
  if (page.decorSvg) { try { vxDrawSvg(doc, page.decorSvg, 0, 0, page.mm[0], page.mm[1]); } catch (e) { /* latar warna tetap ada */ } }
  for (const el of page.elements) {
    if (el.type === "text") vxDrawTextEl(doc, el, ctx);
    else if (el.type === "divider") vxDrawDivider(doc, el, ctx);
    else if (el.type === "qr") vxDrawQr(doc, el, ctx);
    else if (el.type === "image") vxDrawImageEl(doc, el, ctx);
  }
}
async function vxBuildDocument(opts) {
  const pages = opts.pages;
  const needs = new Map();
  pages.forEach(pg => pg.elements.forEach(el => {
    if (el.type !== "text") return;
    const fam2 = famName(el.font);
    if (!needs.has(fam2)) needs.set(fam2, new Set());
    needs.get(fam2).add(vxStyleKey(el));
  }));
  const doc = new opts.JsPDF({ unit: "mm", format: pages[0].mm, orientation: pages[0].orientation, compress: true });
  try { doc.setProperties({ title: "Undangan Pernikahan", creator: "Editor Undangan Pernikahan" }); } catch (e) { /* abaikan */ }
  const reg = await vxRegisterFonts(doc, needs);
  const report = { embedded: reg.embedded, fallbackFonts: reg.fallback, rasterPages: [] };
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (i > 0) doc.addPage(p.mm, p.orientation);
    try {
      vxDrawPage(doc, p, reg.fontMap);
    } catch (e) {
      let covered = false;
      if (opts.rasterPage) {
        try {
          const rp = await opts.rasterPage(p.pageIndex !== undefined && p.pageIndex !== null ? p.pageIndex : i);
          if (rp && rp.data) { doc.addImage(rp.data, rp.format || "JPEG", 0, 0, p.mm[0], p.mm[1]); covered = true; }
        } catch (e2) { /* abaikan */ }
      }
      if (!covered) throw e;
      report.rasterPages.push(i);
    }
  }
  return { doc: doc, report: report };
}

/* ---------- Persiapan halaman (browser) untuk export vektor ---------- */
async function vxClippedImage(el) {
  const im = await loadImg(el.src);
  const gEl = Object.assign({}, el, { nw: el.nw || im.naturalWidth, nh: el.nh || im.naturalHeight });
  const mmPerPx = (isCL() ? (W >= H ? 297 : 217) : 148) / W;
  const K = Math.max(1.5, Math.min(4, mmPerPx / 25.4 * 300));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(el.w * K));
  cv.height = Math.max(1, Math.round(el.h * K));
  const ctx = cv.getContext("2d");
  ctx.translate(-el.x * K, -el.y * K);
  ctx.save();
  clipShape(ctx, gEl, K);
  const g = imgGeom(gEl);
  ctx.drawImage(im, g.dx * K, g.dy * K, g.dw * K, g.dh * K);
  ctx.restore();
  return cv.toDataURL("image/png");
}
async function vxPrepareEl(el) {
  const c = Object.assign({}, el);
  if (el.type === "image") {
    if (el.src && el.src.indexOf("data:image/svg+xml") === 0) {
      try { c.__svg = decodeURIComponent(el.src.slice(el.src.indexOf(",") + 1)); } catch (e) { c.__svg = null; }
    }
    if (!c.__svg) { try { c.__img = await vxClippedImage(el); } catch (e) { c.__img = null; } }
  } else if (el.type === "qr") {
    const canVector = el.link && typeof window.qrcode === "function";
    if (!canVector) {
      const src = qrSrc(el);
      if (src) {
        try {
          if (src.indexOf("data:") === 0) c.__qrImg = src;
          else {
            const im = await loadImg(src);
            const cv = document.createElement("canvas");
            cv.width = im.naturalWidth; cv.height = im.naturalHeight;
            cv.getContext("2d").drawImage(im, 0, 0);
            c.__qrImg = cv.toDataURL("image/png");
          }
        } catch (e) { c.__qrImg = null; }
      }
    }
  }
  return c;
}
async function vxPreparePages() {
  const pages = [];
  if (isCL()) {
    const mm = W >= H ? [297, 217] : [217, 297], orient = W >= H ? "landscape" : "portrait";
    for (let p = 0; p < state.pageEls.length; p++) {
      const els = [];
      for (const el of state.pageEls[p]) els.push(await vxPrepareEl(el));
      const bgIm = await loadImg(clBg(p));
      pages.push({ W: W, H: H, mm: mm, orientation: orient, bgImage: { data: bgIm, format: "JPEG" }, elements: els, pageIndex: p });
    }
  } else {
    const els = [];
    for (const el of state.elements) els.push(await vxPrepareEl(el));
    const page = { W: W, H: H, mm: [148, 210], orientation: "portrait", elements: els, pageIndex: 0 };
    if (state.bg.kind === "solid") {
      page.bgColor = state.bg.c;
      page.decorSvg = decorSVG(state.template);
    } else {
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      canvasBg(ctx, state.bg, W, H);
      const d = await svgImage(decorSVG(state.template), W, H);
      ctx.drawImage(d.im, 0, 0, W, H);
      URL.revokeObjectURL(d.url);
      page.bgImage = { data: cv.toDataURL("image/jpeg", 0.92), format: "JPEG" };
    }
    pages.push(page);
  }
  return pages;
}
async function vxRasterPageData(pageIndex) {
  if (isCL()) {
    const cv = await renderPrintCanvas(W, state.pageEls[pageIndex], clBg(pageIndex));
    return { data: cv.toDataURL("image/jpeg", 0.96), format: "JPEG" };
  }
  const cv = await renderPrintCanvas(2480);
  return { data: cv.toDataURL("image/jpeg", 0.96), format: "JPEG" };
}

/* ---------- Orkestrasi export vektor (PDF Vektor / .AI) ---------- */
let vxBusy = false;
async function exportVector(btn, kind) {
  if (vxBusy) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast("Pustaka PDF belum termuat — periksa internet, lalu coba lagi. PNG tetap bisa diunduh.");
    return;
  }
  vxBusy = true;
  const btns = [$("dlPdf"), $("dlAi"), $("dlPng")].filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  $("dlmenu").classList.remove("open");
  toast(kind === "ai"
    ? "Menyiapkan file .AI vektor — mengunduh font untuk disematkan, mohon tunggu…"
    : "Menyiapkan PDF Vektor — mengunduh font untuk disematkan, mohon tunggu…");
  try {
    const pages = await vxPreparePages();
    const built = await vxBuildDocument({ JsPDF: window.jspdf.jsPDF, pages: pages, rasterPage: vxRasterPageData });
    const blob = built.doc.output("blob");
    const base = isCL() ? "undangan-" + state.template + "-vektor" : "undangan-pernikahan-vektor";
    saveBlob(blob, base + (kind === "ai" ? ".ai" : ".pdf"));
    const r = built.report, notes = [];
    if (r.fallbackFonts.length) notes.push("font diganti font standar PDF: " + r.fallbackFonts.slice(0, 3).join(", ") + (r.fallbackFonts.length > 3 ? ", …" : ""));
    if (r.rasterPages.length) notes.push("halaman " + r.rasterPages.map(p => p + 1).join(", ") + " memakai gambar raster");
    toast((kind === "ai"
      ? "File .AI tersimpan — buka di Illustrator: teks, denah & QR tetap vektor, bisa diedit dan dipindah."
      : "PDF Vektor tersimpan — teks tetap teks (bisa dipilih & diedit), denah & QR berupa vektor, foto sebagai gambar terpisah.")
      + (notes.length ? " Catatan: " + notes.join("; ") + "." : ""));
  } catch (e) {
    toast("PDF Vektor gagal dibuat — mengunduh PDF raster seperti biasa.");
    btns.forEach(b => { b.disabled = false; });
    vxBusy = false;
    try { await exportRasterPDF(btn); } catch (e2) { /* abaikan */ }
    return;
  }
  btns.forEach(b => { b.disabled = false; });
  vxBusy = false;
}

/* ---------- Menu unduh, pintasan keyboard, bootstrap ---------- */
$("dlPng").addEventListener("click", e => exportPNG(e.currentTarget));
$("dlPdf").addEventListener("click", e => exportVector(e.currentTarget, "pdf"));
$("dlAi").addEventListener("click", e => exportVector(e.currentTarget, "ai"));
$("dlBtn").addEventListener("click", e => { e.stopPropagation(); $("dlmenu").classList.toggle("open"); });
document.addEventListener("click", e => { if (!e.target.closest("#dlwrap")) $("dlmenu").classList.remove("open"); });
window.addEventListener("keydown", e => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && sel()) { e.preventDefault(); deleteEl(sel()); }
  else if (e.key === "Escape") select(null, false);
});
window.__VX = { buildDocument: vxBuildDocument, parseSvg: vxParseSvg, drawSvg: vxDrawSvg, parsePath: vxParsePath, fetchFont: vxFetchFont, registerFonts: vxRegisterFonts, drawPage: vxDrawPage };
state.elements = TEMPLATES.emas.make();
commit();
renderAll();
