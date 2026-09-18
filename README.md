# Emergency Code RSAB — Front-end statis (GitHub Pages)

Folder ini adalah versi **statis** dari aplikasi alarm yang sebelumnya disajikan Apps Script (HtmlService).
Di sini halaman berjalan sebagai dokumen top-level di domain Anda sendiri (`*.github.io`), **bukan di dalam
iframe Google**, sehingga mikrofon (BICARA MANUAL), TTS, siren, dan PWA "Add to Home Screen" semuanya berfungsi.
Apps Script tetap dipakai sebagai **backend JSON** (login, event, sheet, pengumuman) lewat `doPost` di `Code.gs`.

## Isi

| File | Asal | Keterangan |
|---|---|---|
| `index.html` | `Index.html` | Dashboard + login + overlay alarm (mode inline, default) |
| `alarm.html` + `js/alarm.js` | `Alarm.html` | Halaman alarm mode tab (legacy, hanya bila `cb_inline_mode = '0'`) |
| `css/styles.css` | `Styles.html` | |
| `css/peta.css`, `js/peta.js` | `Peta.html` | Peta gedung; `getGedungMap` lewat `api.js` |
| `js/audio.js` | `Audio.html` | Sama persis |
| `js/voice.js` | `Voice.html` | Sama persis — mikrofon aktif di origin ini |
| `js/dashboard.js` | `Script.html` | `call()` -> `api.call()`; konfigurasi dari `getClientConfig` |
| `js/api.js` | baru | Pengganti `google.script.run` (fetch POST text/plain ke `/exec`) |
| `js/config.js` | baru | **URL Apps Script** + default konfigurasi |
| `manifest.json`, `sw.js`, `icon-*.png` | baru | PWA |

## Deploy

1. **Apps Script**: salin `Code.gs` terbaru (sudah ada `doPost` JSON API), lalu *Deploy > Manage deployments > Edit >
   New version*. Pastikan **Execute as: Me** dan **Who has access: Anyone**. Uji di browser:
   `<URL /exec>?api=ping` harus menampilkan `{"ok":true,...}`.
2. Bila URL `/exec` berubah, perbarui `APPS_SCRIPT_URL` di `js/config.js`.
3. **GitHub**: buat repositori, unggah seluruh proyek. Di *Settings > Pages* pilih *Deploy from a branch*,
   branch `main`, folder **`/docs`**. (Atau unggah hanya isi folder `docs/` ke root repo dan pilih folder `/ (root)`.)
4. Buka `https://<username>.github.io/<repo>/` di Chrome HP -> menu -> *Add to Home screen*.

## Perubahan 17-09-2026 (lihat `AUDIT-PERBAIKAN-2026-09-17.md` di root proyek)

- **Code.gs WAJIB dideploy versi baru**: cache sesi di CacheService (kuota Properties 50.000/hari tidak lagi
  tersentuh oleh polling), penghitung PC online, kolom "Login Terakhir" di sheet Users.
- Klien: banner merah koneksi terputus + COBA LAGI, spinner tombol, pesan error ramah, tombol REFRESH, jam WIB,
  jumlah PC online, TES SUARA / AKTIFKAN SUARA, BICARA MANUAL di semua perangkat (ambil alih), logo RS di login &
  header, ikon PWA = mic, favicon = logo RS.
- **BICARA MANUAL (M0)**: dari jaringan RS, TURN bawaan PeerJS diblokir → suara hanya sampai bila PC saling jangkau
  langsung. Isi `CONFIG.ICE_SERVERS` di Code.gs dengan TURN RS (metered.ca gratis / coturn port 443), deploy New version,
  lalu di dashboard klik **DIAGNOSTIK → TES TURN / ICE** sampai "✅". Panduan lengkap: `AUDIT-PERBAIKAN-2026-09-17.md` §1b.
- **Tema "Deep Slate" (17-09-2026)**: latar #111827 dengan gradasi, kartu glassmorphism, aksen sky blue, animasi
  150–400 ms (hormati `prefers-reduced-motion`), font Inter (fallback Segoe UI). Logo: `logo-rsab.svg` dan
  `logo-emblem.svg` = lencana vektor (cincin gradasi + glow) yang membingkai PNG asli 512 px yang ditanam sebagai
  data URI (SVG lewat `<img>` tidak boleh memuat berkas luar); fallback ke PNG lama lewat `onerror`. Badge
  "SEDANG BERLANGSUNG" dan kilau tombol code kini elemen `<span>` (bukan `::after`) karena `::after` dipakai ripple.
- **Polling 1 detik ("no delay", 18-09-2026)**: `CONFIG.POLL_DASHBOARD_MS: 1000`, `POLL_ALARM_MS: 1000`,
  `ACTIVE_CACHE_SEC: 1` di Code.gs (nilai server MENIMPA default klien saat halaman dimuat, jadi Code.gs harus dideploy
  ulang agar berlaku). Jeda klien = nilai dasar; hanya melebar bila RTT > 1,5 × dasar (maks 4 dtk) dan saat gagal
  (backoff). Alarm dari PC lain tampil ±1,1 dtk. PERINGATAN kuota: 30 PC × 1 req/dtk mendekati batas 30 eksekusi
  bersamaan Apps Script; bila Executions sering error "too many simultaneous", naikkan ke 2000.
- **HENTIKAN ALARM tidak langsung menutup (18-09-2026)**: mode inline menampilkan modal **ALARM SELESAI** (ringkasan
  lokasi/mulai/selesai/durasi/dihentikan oleh, hitung mundur 10 dtk, tombol TUTUP SEKARANG dan LIHAT RIWAYAT yang
  menyorot baris riwayat). Mode tab legacy (`alarm.html`): layar status SELESAI dengan tombol TUTUP TAB INI / BUKA
  DASHBOARD; tidak ada `window.close()` otomatis lagi (juga saat event tidak ditemukan).
- **SERVER PAGING (18-09-2026)**: tombol 📢 SERVER PAGING di topbar → pilih jenis (Paging umum atau code lain) dan
  centang gedung tujuan (daftar dari sheet `Gedung`; "Semua Gedung" = semua PC). Server: `createPagingEvent` menulis
  kolom 11 **Target Gedung** (JSON array) di sheet Events. Jalankan `migrateEventsTargetGedung()` SEKALI di editor
  Apps Script (menambah header kolom 11 + baris `PAGING` di JenisCode). PC yang gedungnya tidak dicentang tidak
  membunyikan/menampilkan overlay, tetapi tetap melihatnya di daftar "Sedang Berlangsung" (chip 📢). Peta menampilkan
  marker untuk setiap gedung tujuan. TTS paging: `CONFIG.PAGING_TTS_TEMPLATE` ("Paging, paging, paging, {gedung}").
- **Relay otomatis (M0-B)**: kebijakan ICE `all` (langsung + relay bersamaan); bila panggilan langsung gagal ke semua
  penerima padahal TURN RS terdaftar, host beralih relay-only otomatis (sakelar per tab `cb_force_relay`).
  `CONFIG.ICE_TRANSPORT_POLICY: 'relay'` di Code.gs memaksa relay untuk semua PC. Panduan lengkap TURN (metered.ca,
  coturn `turnserver.conf`, firewall, uji antar-VLAN): `PANDUAN-TURN.md` di root proyek.
- `js/peerjs.min.js` (PeerJS 1.5.4, SHA-256 `AD5D8870D1E389914F9CBA8D35BE313C4327C69EE0A221E482E9BF7621136FE5`) dimuat
  lebih dulu; CDN unpkg/jsdelivr hanya cadangan. Build menambahkan `?v=<stempel>` ke css/js (cache buster).
- Uji lokal tanpa dependensi: `node tools\serve-docs.js` lalu buka http://127.0.0.1:8765/ (jangan pakai untuk produksi).
- Jangan mengedit `docs/js/dashboard.js` langsung di GitHub: edit `Script.html` lalu jalankan `tools\build-docs.ps1`,
  supaya sumber dan hasil deploy tidak tercerai (kasus `VOICE_ANYONE_CAN_TALK` yang berbeda antara deploy dan sumber).

## Catatan

- Alarm tetap **tidak** bisa berbunyi bila tab/PWA benar-benar ditutup (batasan browser; butuh Web Push + server push).
- `sw.js` sengaja tanpa cache (network-only) supaya setiap update di GitHub langsung terlihat.
- Versi Apps Script (HtmlService) masih bisa dipakai berdampingan; `doGet` tidak diubah.
