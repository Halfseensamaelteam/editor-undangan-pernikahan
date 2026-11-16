# Editor Undangan Pernikahan

Website editor undangan pernikahan — customer edit template sendiri di HP, lebih simpel dari Adobe Illustrator. Prototipe web statis (buka `index.html`).

## Yang sudah ada (prototipe 14 Nov 2026)

- 3 template: Klasik Emas, Sage Botani, Blush Mawar
- Edit bebas: ketuk untuk memilih, seret untuk memindah, pegangan biru untuk resize, ketuk dua kali teks untuk edit langsung
- Panel bawah: Template / Tambah / Edit / Lapisan
- 1.633 font Google Fonts, bisa dicari + filter kategori (Serif Elegan, Script & Kaligrafi, Sans Modern, Dekoratif, Monospace, Favorit Undangan), dimuat on-demand
- Ganti foto dari galeri, 5 bentuk bingkai foto, zoom/geser foto, warna, perataan, urutan lapisan, undo/redo, zoom kanvas, mode Pratinjau
- Ekspor: PDF A5 siap cetak atau PNG 2480×3508 px (300 DPI), digambar ulang di canvas — bukan screenshot

## Template asli CL — konversi selesai (16 Nov 2026)

- **30 template CL berhasil, 0 gagal:** CL1–16, CL18–23, CL25–30, CL35, CL36 (seksi "Template Asli (CL)" di pemilih template)
- Tiap template CL = **2 halaman LANDSCAPE** 1200×877 px, tombol Halaman 1/2 (CL23: 3 halaman, hal. 3 = kartu "Kepada Yth."), background = gambar master cetak asli yang dioptimasi untuk web (61 file di `assets/cl/`, 5,9 MB total — file HD 3071 px untuk cetak TIDAK masuk repo)
- **1.580 objek teks** yang bisa diedit (posisi/font/ukuran/warna diambil dari file .ai), font dipetakan ke Google Fonts (mis. Armelie/Birds of Paradise → Great Vibes, Trajan Pro → Cinzel, Century Gothic → Jost; Times New Roman → font sistem)
- Ekspor CL: PNG landscape 1200×877 per halaman aktif + PDF landscape semua halaman. Template portrait lama tidak berubah.
- Di-skip sesuai keputusan wood: 13 CL tanpa master (CL17, CL24, CL31–CL34, CL37–CL43) dan seluruh seri CLA/CLE/CLM/KUT.
- Data konversi: `~/workspace/undangan-template/cl-conversion.json` (tidak di repo).
- **Cara melihat:** repo ini tidak dirender GitHub — buka `index.html` langsung di browser (klik dua kali / drag ke browser HP/komputer, butuh internet untuk font Google). Belum terverifikasi live: render font Google saat runtime, unduh jsPDF, dan cek interaktif ganti halaman/edit/ekspor.

## Yang belum ada (draf, belum dibangun)

1. **Autosave** — desain hilang kalau customer tutup tab / HP refresh di tengah edit. Rencana: simpan otomatis tiap edit + "Lanjutkan desain terakhir".
2. **Jalur order** — editor berhenti di Unduh. Rencana: tombol "Pesan & Cetak via WhatsApp" di header, membuka WA dengan pesan terisi otomatis (template, nama mempelai, tanggal, jumlah cetak). WA tidak bisa melampirkan file otomatis dari web, jadi customer tetap unduh PDF/PNG dulu lalu kirim manual di chat.

Menunggu keputusan wood: nomor WA untuk tombol order, order lewat WA atau bayar langsung di website, setuju bangun autosave?

## Cara upload file template .ai / .zip / .rar (500 MB)

**JANGAN commit file 500 MB ke git — GitHub menolak file di atas 100 MB.**

Pakai **Releases** (batas 2 GB per file):

1. Buka https://github.com/Halfseensamaelteam/editor-undangan-pernikahan/releases
2. Klik **Draft a new release**
3. Tag: misal `template-v1`, judul: `Template .ai asli`
4. Di bagian bawah, seret file `.zip` / `.rar` / `.ai` ke kotak "Attach binaries" — tunggu upload selesai
5. Klik **Publish release**, kirim link release-nya ke Muse

## Cara konversi template .ai asli jadi template ke-4

1. Di Illustrator, pisah layer: hiasan/background di layer sendiri, teks yang bisa diedit (nama mempelai, tanggal, alamat) di layer bernama jelas. Huruf hiasan yang TIDAK boleh berubah di-outline dulu via Type > Create Outlines.
2. File > Export > Export As > SVG — BUKAN File > Save As > SVG.
3. Di SVG Options: Font = SVG, Styling = Internal CSS, Object IDs = Layer Names, Decimal = 2-3, hilangkan centang "Preserve Illustrator Editing Capabilities", Images = Embed, Responsive off.
4. Kirim .svg hasilnya (atau .ai-nya), dan sebut teks mana yang tetap bisa diedit. Kalau .ai pakai font komersial yang tidak ada di Google Fonts, sertakan file .ttf/.otf/.woff2-nya.

Catatan: export itu langkah 1 saja. Template di editor masih hardcoded, jadi langkah 2 adalah memasang .svg itu jadi template ke-4 dengan teks dan fotonya dipetakan supaya bisa diedit.
