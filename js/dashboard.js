// Penangkap error global: bila script dashboard crash, tampilkan pesannya di layar login
// (bukan halaman kosong) supaya penyebabnya langsung terlihat.
window.addEventListener('error', function (e) {
  try {
    var el = document.getElementById('loginError');
    if (el && !el.textContent) el.textContent = 'Kesalahan script: ' + (e && e.message ? e.message : 'tidak diketahui') + ' — muat ulang halaman atau hubungi IT.';
  } catch (x) {}
});

(function () {
  'use strict';

  // ===================== STATE =====================
  var session = { token: null, user: null };
  var jenisList = [];               // master jenis code
  var openTabs = {};                // eventId -> { win, event, failed }
  var activeEvents = [];            // hasil polling terakhir
  var pollTimer = null;
  var pollBusy = false;
  var pollFailCount = 0;
  var fallbackEventId = null;       // event yang sedang dibunyikan inline (jika pop-up diblokir)
  var dashAudioEventId = null;      // event MILIK SENDIRI yang audionya diputar langsung dari dashboard (PC pengirim)
  var tickTimer = null;

  // Kunci penyimpanan lokal (localStorage, persist antar sesi).
  var LS_COOKIE_CONSENT = 'cb_cookie_consent';   // 'accepted'
  var LS_AUDIO_OWNER = 'cb_audio_owner';         // JSON { eventId, ts, ended } -> dibaca Alarm.html (anti double audio)
  var AUDIO_OWNER_TTL_MS = 8000;                 // heartbeat dashboard tiap 1 detik; dianggap basi setelah 8 detik

  var $ = function (id) { return document.getElementById(id); };

  // ===================== UTIL =====================
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ms) {
    if (!ms) return '-';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtElapsed(ms) {
    if (!ms) return '';
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    var m = Math.floor(s / 60), h = Math.floor(m / 60);
    s = s % 60; m = m % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' : '') + p(m) + ':' + p(s);
  }
  function toast(msg, ms) {
    var el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 3500);
  }
  // BARU (M13): pesan error RAMAH. Kode/pesan mentah dari server atau fetch dipetakan ke kalimat yang dimengerti
  // perawat; pesan asli tetap dicatat di console untuk IT.
  function friendlyError(err) {
    var raw = String(err && err.message || err || '');
    try { console.warn('[RSAB] error:', raw); } catch (e) {}
    if (/SESI_TIDAK_VALID/.test(raw)) return 'Sesi berakhir, silakan login ulang.';
    if (/timeout/i.test(raw)) return 'Server lambat merespons (lebih dari 30 detik). Dicoba lagi otomatis.';
    if (/Failed to fetch|NetworkError|Load failed|network|ERR_/i.test(raw)) return 'Tidak bisa menghubungi server. Periksa koneksi internet / firewall RS.';
    if (/bukan JSON/i.test(raw)) return 'Alamat server (Apps Script) salah atau deployment belum "Anyone". Hubungi IT.';
    if (/HTTP (5\d\d)/.test(raw)) return 'Server Google sedang bermasalah (' + RegExp.$1 + '). Coba lagi sebentar.';
    if (/HTTP (4\d\d)/.test(raw)) return 'Permintaan ditolak server (' + RegExp.$1 + '). Muat ulang halaman.';
    if (/too many times|kuota|quota/i.test(raw)) return 'Kuota harian server Google habis. Hubungi IT segera.';
    if (/lock/i.test(raw)) return 'Server sedang sibuk memproses permintaan lain. Coba lagi 2-3 detik.';
    if (/Sheet .* tidak ada|Spreadsheet tidak ditemukan/i.test(raw)) return 'Konfigurasi spreadsheet server bermasalah. Hubungi IT.';
    return raw || 'Terjadi kesalahan yang tidak diketahui.';
  }
  // BARU (M12): spinner di tombol. setBusy(btn, 'Menghubungi server...') -> clearBusy(btn) mengembalikan isi asli.
  function setBusy(btn, text) {
    if (!btn) return;
    if (!btn.hasAttribute('data-orig')) btn.setAttribute('data-orig', btn.innerHTML);
    btn.disabled = true;
    btn.classList.add('busy');
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + esc(text || 'Menghubungi server...');
  }
  function clearBusy(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('busy');
    if (btn.hasAttribute('data-orig')) { btn.innerHTML = btn.getAttribute('data-orig'); btn.removeAttribute('data-orig'); }
  }
  // BARU (M8/M9): banner merah "koneksi terputus" (di atas login maupun dashboard) + tombol COBA LAGI.
  var connRetryFn = null;
  function showConnBanner(msg, retryFn) {
    var b = $('connBanner'); if (!b) return;
    $('connText').textContent = msg;
    connRetryFn = retryFn || null;
    b.classList.remove('hidden');
    document.body.classList.add('has-conn-banner');
  }
  function hideConnBanner() {
    var b = $('connBanner'); if (!b) return;
    b.classList.add('hidden');
    document.body.classList.remove('has-conn-banner');
    connRetryFn = null;
  }
  $('connRetry').addEventListener('click', function () {
    var btn = $('connRetry');
    setBusy(btn, 'Mencoba...');
    var p = null;
    try { p = connRetryFn ? connRetryFn() : null; } catch (e) { p = null; }
    Promise.resolve(p).catch(function () {}).then(function () { clearBusy(btn); });
  });
  // Cek server saat halaman dimuat (sebelum login): ambil konfigurasi; gagal -> banner + COBA LAGI.
  function checkServer() {
    return call('getClientConfig').then(function (cfg) {
      if (cfg && typeof cfg === 'object') Object.keys(cfg).forEach(function (k) { APP_CONFIG[k] = cfg[k]; });
      if (!session.token) hideConnBanner();
    }).catch(function (err) {
      showConnBanner('⚠️ Server tidak dapat dihubungi: ' + friendlyError(err), checkServer);
    });
  }
  // GITHUB PAGES: pengganti google.script.run -> fetch() ke Apps Script lewat api.js (kontrak sama: Promise hasil
  // fungsi; error server -> Promise ditolak dengan Error(pesan), jadi isSessionError() tetap bekerja).
  function call(fn) {
    return api.call.apply(null, arguments);
  }
  function isSessionError(err) {
    return /SESI_TIDAK_VALID/.test(String(err && err.message || err));
  }
  // Penyimpanan lokal berlapis: localStorage -> sessionStorage -> memori.
  // localStorage bisa melempar error / tidak tersedia di iframe Apps Script bila browser memblokir storage pihak ketiga.
  var memStore = {};
  // PENTING: bahkan sekadar MENGAKSES window.localStorage bisa melempar SecurityError di iframe Apps Script
  // (cookie pihak ketiga diblokir). Karena itu akses propertinya pun harus di dalam try/catch.
  function storageAvailable(name) {
    try { var s = window[name]; var k = '__cb_probe__'; s.setItem(k, '1'); s.removeItem(k); return true; } catch (e) { return false; }
  }
  var LOCAL_OK = storageAvailable('localStorage');
  var SESSION_OK = storageAvailable('sessionStorage');
  function lsGet(k) {
    try { if (LOCAL_OK) { var v = localStorage.getItem(k); if (v !== null) return v; } } catch (e) {}
    try { if (SESSION_OK) { var w = sessionStorage.getItem(k); if (w !== null) return w; } } catch (e) {}
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null;
  }
  function lsSet(k, v) {
    memStore[k] = v;
    try { if (LOCAL_OK) { localStorage.setItem(k, v); return; } } catch (e) {}
    try { if (SESSION_OK) sessionStorage.setItem(k, v); } catch (e) {}
  }
  function lsDel(k) {
    delete memStore[k];
    try { if (LOCAL_OK) localStorage.removeItem(k); } catch (e) {}
    try { if (SESSION_OK) sessionStorage.removeItem(k); } catch (e) {}
  }
  // Versi per-sesi (tab): sessionStorage -> memori. Dipakai untuk hal yang memang tidak boleh persist antar kunjungan.
  function ssGet(k) {
    try { if (SESSION_OK) { var v = sessionStorage.getItem(k); if (v !== null) return v; } } catch (e) {}
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null;
  }
  function ssSet(k, v) {
    memStore[k] = v;
    try { if (SESSION_OK) sessionStorage.setItem(k, v); } catch (e) {}
  }
  var SS_COOKIE_REJECTED = 'cb_cookie_rejected';
  var LS_TOKEN = 'cb_token';   // BARU: token sesi (localStorage bila "ingat sesi", sessionStorage bila tidak)

  // PERBAIKAN: SEMUA perangkat (HP & desktop) SELALU mode INLINE — alarm tampil sebagai overlay fullscreen
  // di halaman dashboard ini sendiri. Alasan:
  //  - Tab alarm terpisah dari iframe Apps Script di HP hampir selalu diblokir, atau dibekukan Chrome saat
  //    jadi tab background -> tab "TAB ALARM CADANGAN" diam, alarm tidak muncul / tidak berbunyi.
  //  - Overlay inline SELALU bekerja, tidak bergantung kebijakan pop-up browser.
  //  - Audio overlay inline bisa di-unlock SEKALI di "Accept All Cookies" dan tetap 'running' selama halaman
  //    hidup (dijaga keepAlive() tiap 30 detik) -> alarm berikutnya berbunyi otomatis tanpa ketuk layar.
  // Mode TAB lama masih bisa dipaksa untuk debugging lewat localStorage 'cb_inline_mode' = '0'.
  var INLINE_ALARM = (function () {
    var forced = lsGet('cb_inline_mode');
    if (forced === '1') return true;
    if (forced === '0') return false;
    return true;   // HP: SELALU inline. Desktop: inline juga (konsisten).
  })();
  // PERBAIKAN (HP): Wake Lock diminta SEGERA SETELAH LOGIN dan dipertahankan sepanjang sesi (bukan hanya saat
  // alarm). Chrome Android membekukan tab background setelah beberapa menit; dengan Wake Lock aktif, CPU/tab
  // tidak dibekukan sehingga polling + audio tetap hidup dan alarm yang datang kapan pun tetap tampil & berbunyi.
  // (Butuh HTTPS & halaman terlihat; di iframe Apps Script bisa ditolak -> diabaikan tanpa error.)
  // ===================== WAKE LOCK (MANAJEMEN TERPUSAT) =====================
  // Satu-satunya aturan: Wake Lock dipegang bila (a) ada alarm aktif, atau (b) sesi login & halaman terlihat.
  // Dilepas otomatis saat logout / tidak ada alasan lagi. Semua titik (login, logout, alarm muncul/hilang,
  // visibilitychange) hanya memanggil updateWakeLockWanted(); tidak ada requestWakeLock() tersebar lagi.
  var wakeLock = null;
  var wakeLockWanted = false;
  function updateWakeLockWanted() {
    var hasAlarm = Object.keys(openTabs).length > 0;
    wakeLockWanted = hasAlarm || (!!session.token && document.visibilityState === 'visible');
    if (wakeLockWanted) requestWakeLock(); else releaseWakeLock();
  }
  var wakeLockPending = false;
  function requestWakeLock() {
    try {
      if (wakeLock || wakeLockPending || !navigator.wakeLock) return;
      if (document.visibilityState !== 'visible') return;   // request() ditolak bila halaman tidak terlihat
      wakeLockPending = true;
      navigator.wakeLock.request('screen').then(function (wl) {
        wakeLockPending = false;
        wakeLock = wl;
        wl.addEventListener('release', function () {
          wakeLock = null;
          // Browser melepas otomatis saat halaman disembunyikan -> minta lagi bila masih dibutuhkan & terlihat.
          setTimeout(function () { if (wakeLockWanted) requestWakeLock(); }, 500);
        });
        if (!wakeLockWanted) releaseWakeLock();   // alasan sudah hilang selama menunggu promise
      }).catch(function () { wakeLockPending = false; });
    } catch (e) { wakeLockPending = false; }
  }
  function releaseWakeLock() {
    try { if (wakeLock) { var wl = wakeLock; wakeLock = null; wl.release().catch(function () {}); } } catch (e) {}
  }
  // SATU listener visibilitychange untuk semua: Wake Lock, resume audio + polling segera saat HP dibuka lagi
  // (alarm yang datang saat layar mati langsung tampil), dan menutup notifikasi bila overlay alarm sudah terlihat.
  document.addEventListener('visibilitychange', function () {
    updateWakeLockWanted();
    if (document.visibilityState !== 'visible') return;
    if (session.token) {
      try { AlarmAudio.tryResumeAggressive(); } catch (e) {}
      poll(true);
    }
    if (fallbackEventId) closeEventNotification(fallbackEventId);
  });
  function vibrateAlarm() {
    try { if (navigator.vibrate) navigator.vibrate([500, 200, 500]); } catch (e) {}
  }

  // ===================== COOKIE CONSENT ("Accept All Cookies") =====================
  // Tujuan utama banner ini: memberi USER GESTURE pertama sedini mungkin (sebelum login),
  // sehingga izin audio (Web Audio + Speech Synthesis) sudah terbuka dan browser mencatat
  // interaksi pengguna di halaman ini. Pop-up blocker tidak bisa "diizinkan" lewat JS,
  // tetapi klik ini membantu window.open() berikutnya dalam jendela aktivasi yang sama.
  function initCookieBanner() {
    var banner = $('cookieBanner');
    if (!banner) return;
    var accepted = lsGet(LS_COOKIE_CONSENT) === 'accepted';
    // "Tolak" disimpan di kunci terpisah (bukan kunci consent) lewat helper berlapis, jadi tetap bekerja walau sessionStorage diblokir.
    var rejectedThisSession = ssGet(SS_COOKIE_REJECTED) === '1';
    if (accepted || rejectedThisSession) { hideCookieBanner(); return; }
    banner.classList.remove('hidden');
    document.body.classList.add('has-cookie-banner');   // beri ruang di bawah supaya banner tidak menutupi tombol

    $('cookieAccept').addEventListener('click', function () {
      lsSet(LS_COOKIE_CONSENT, 'accepted');
      // PERBAIKAN (HP): unlock() dipanggil SINKRON DI DALAM handler klik ini (bukan di microtask/promise).
      // HP butuh AudioContext.resume() persis di dalam gesture. unlock() di Audio.html sudah melakukan
      // resume() sinkron + memutar buffer kosong + priming speechSynthesis. Ini SATU-SATUNYA gesture yang
      // dibutuhkan: setelah ini AudioContext 'running' untuk seluruh lifetime halaman (dijaga keepAlive()).
      // Tidak ada lagi window.open()/tab cadangan: alarm selalu tampil inline di halaman ini.
      AlarmAudio.unlock();
      AlarmAudio.tryResumeAggressive();   // pastikan state benar-benar 'running'
      updateWakeLockWanted();             // HP: cegah tab dibekukan sejak awal (bila sudah login/dipulihkan)
      // BARU: SEMUA izin diminta di gesture ini sekaligus, sekali saja, lalu disimpan browser:
      //  - MIKROFON  -> tombol BICARA MANUAL saat alarm tidak lagi memunculkan prompt / ditolak.
      //  - NOTIFIKASI -> alarm muncul sebagai notifikasi bila tab tidak terlihat (lihat notifyNewEvent).
      requestMicEarly();
      requestNotifEarly();
      hideCookieBanner();
      // Bila overlay "klik untuk melanjutkan" sedang tampil (sesi dipulihkan), klik ini sudah cukup.
      $('overlayUnlock').classList.add('hidden');
    });
    $('cookieReject').addEventListener('click', function () {
      // Menolak cookie TIDAK menyimpan consent, tetapi klik ini tetap user gesture yang sah:
      // izin audio dibuka juga (ini sistem alarm darurat; suara tidak boleh bergantung pada persetujuan cookie),
      // sehingga overlay "klik untuk melanjutkan" aman ditutup tanpa meninggalkan audio terblokir diam-diam.
      ssSet(SS_COOKIE_REJECTED, '1');
      AlarmAudio.unlock();
      AlarmAudio.tryResumeAggressive();
      hideCookieBanner();
      $('overlayUnlock').classList.add('hidden');
    });
  }
  function hideCookieBanner() {
    var banner = $('cookieBanner');
    if (banner) banner.classList.add('hidden');
    document.body.classList.remove('has-cookie-banner');
  }
  function cookieBannerVisible() {
    var banner = $('cookieBanner');
    return !!banner && !banner.classList.contains('hidden');
  }

  // ===================== LOGIN =====================
  function showLogin(msg) {
    stopPolling();
    stopLogTimer();
    updateWakeLockWanted();   // sesi berakhir & tidak ada alarm -> Wake Lock dilepas
    $('viewDash').classList.add('hidden');
    $('viewLogin').classList.remove('hidden');
    $('loginError').textContent = msg || '';
    $('inPass').value = '';
    setTimeout(function () { $('inUser').focus(); }, 50);
  }

  function showDash() {
    $('viewLogin').classList.add('hidden');
    $('viewDash').classList.remove('hidden');
    $('identNama').textContent = session.user.namaInstalasi;
    $('identGedung').textContent = session.user.gedung + ' · akun: ' + session.user.username;
    loadJenis();
    loadLog();
    startLogTimer();
    startPolling();
    if (!tickTimer) tickTimer = setInterval(renderTick, 1000);
    // PERBAIKAN (HP): Wake Lock segera setelah login (bukan hanya saat alarm) supaya Chrome HP tidak
    // membekukan tab -> polling & audio tetap hidup, alarm yang datang kapan pun tetap tampil + berbunyi.
    updateWakeLockWanted();
    // BARU: baca status izin mikrofon TANPA prompt -> tombol BICARA disembunyikan bila sudah diblokir.
    if (VOICE_OK) AlarmVoice.probeMicPermission();
    autoIceCheck();   // M8: cek jalur WebRTC otomatis (diam-diam) -> tombol DIAGNOSTIK oranye bila tanpa relay
  }

  $('formLogin').addEventListener('submit', function (ev) {
    ev.preventDefault();
    // Klik "Masuk" = user gesture -> buka izin audio di tab ini (bila banner cookie dilewati).
    AlarmAudio.unlock();
    var btn = $('btnLogin');
    setBusy(btn, 'Menghubungi server...'); $('loginError').textContent = '';
    call('login', $('inUser').value, $('inPass').value).then(function (res) {
      clearBusy(btn);
      if (!res.ok) { $('loginError').textContent = res.error || 'Gagal masuk.'; return; }
      session.token = res.token; session.user = res.user;
      // BARU: "Ingat sesi di PC ini" -> token ke localStorage (persist walau tab ditutup, via helper berlapis);
      // tidak dicentang -> hanya sessionStorage (hilang saat tab ditutup).
      var remember = $('inRemember') ? $('inRemember').checked : true;
      lsDel(LS_TOKEN);
      if (remember) lsSet(LS_TOKEN, res.token);
      else ssSet(LS_TOKEN, res.token);
      hideConnBanner();
      showDash();
      // BARU (M17): info login terakhir akun ini (dari kolom "Login Terakhir" sheet Users).
      if (res.lastLogin) toast('Login terakhir akun ' + res.user.username + ': ' + fmtTime(res.lastLogin), 6000);
    }).catch(function (err) {
      clearBusy(btn);
      $('loginError').textContent = 'Gagal masuk: ' + friendlyError(err);
    });
  });

  $('btnLogout').addEventListener('click', function () {
    if (activeEvents.some(function (e) { return e.isMine; })) {
      if (!confirm('Masih ada alarm milik instalasi ini yang berlangsung. Tetap keluar?')) return;
    }
    var t = session.token;
    session = { token: null, user: null };
    lsDel(LS_TOKEN);   // BARU: hapus dari localStorage, sessionStorage, dan memori sekaligus
    if (t) call('logout', t).catch(function () {});
    if (VOICE_OK) AlarmVoice.destroyAll();
    AlarmAudio.release('talk');
    stopDashboardAudio(false);
    closeAllTabs();
    showLogin('Anda telah keluar.');
  });

  // BARU: Auto-restore sesi. Token dibaca lewat lsGet (localStorage -> sessionStorage -> memori),
  // jadi setelah tab ditutup dan dibuka lagi, PC nurse station tidak perlu login ulang.
  function restoreSession() {
    var t = lsGet(LS_TOKEN);
    if (!t) { showLogin(); return Promise.resolve(); }
    // BARU (M4): beri tahu user apa yang sedang terjadi (bukan form login diam tanpa keterangan).
    $('loginError').textContent = 'Memulihkan sesi login PC ini...';
    setBusy($('btnLogin'), 'Memulihkan sesi...');
    return call('checkSession', t).then(function (res) {
      clearBusy($('btnLogin'));
      if (!res.ok) {
        lsDel(LS_TOKEN);   // token invalid/kedaluwarsa -> buang, supaya tidak dicoba lagi di setiap refresh
        showLogin('Sesi sebelumnya sudah berakhir. Silakan masuk kembali.');
        return;
      }
      hideConnBanner();
      session.token = t; session.user = res.user;
      // Tidak ada user gesture setelah halaman dimuat. Overlay "klik untuk melanjutkan" hanya ditampilkan bila
      // consent cookie BELUM diterima dan banner tidak sedang tampil. Jika consent sudah 'accepted', langsung
      // ke dashboard: klik pertama di mana pun (termasuk "YA, KIRIM") akan membuka izin audio secara otomatis
      // (lihat listener klik global di bawah). Catatan: browser tetap mewajibkan 1 gesture per pemuatan halaman
      // untuk audio; consent yang tersimpan tidak bisa menggantikannya, hanya menghilangkan overlay-nya.
      var consented = lsGet(LS_COOKIE_CONSENT) === 'accepted';
      if (!consented && !cookieBannerVisible()) $('overlayUnlock').classList.remove('hidden');
      if (consented) AlarmAudio.tryResumeAggressive();   // berhasil tanpa klik bila browser sudah "percaya" situs ini (MEI Chrome)
      showDash();
    }).catch(function (err) {
      clearBusy($('btnLogin'));
      // Token TIDAK dihapus (kegagalan jaringan, bukan sesi tidak valid) -> COBA LAGI memulihkan tanpa login ulang.
      showLogin('Gagal menghubungi server: ' + friendlyError(err) + ' Sesi PC ini masih tersimpan — klik COBA LAGI di atas.');
      showConnBanner('⚠️ Koneksi ke server terputus: ' + friendlyError(err), restoreSession);
    });
  }
  // UI: titik ripple mengikuti posisi pointer (variabel CSS --x/--y dibaca pseudo-elemen ::after tombol).
  document.addEventListener('pointerdown', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.btn-primary, .btn-stop, .code-btn') : null;
    if (!btn) return;
    var rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    btn.style.setProperty('--x', ((e.clientX - rect.left) / rect.width * 100) + '%');
    btn.style.setProperty('--y', ((e.clientY - rect.top) / rect.height * 100) + '%');
  }, { passive: true });
  // BARU: klik pertama di mana pun pada halaman = gesture -> buka izin audio diam-diam (tanpa overlay).
  // Juga: perangkat yang consent cookie-nya SUDAH tersimpan (banner tidak tampil lagi) tetap mendapat prompt
  // izin mikrofon + notifikasi SEKALI pada klik pertama, supaya tidak harus menghapus consent dulu.
  document.addEventListener('click', function () {
    if (!AlarmAudio.isUnlocked()) AlarmAudio.unlock();
    if (lsGet(LS_COOKIE_CONSENT) === 'accepted' && lsGet(LS_MIC_ASKED) !== '1') { requestMicEarly(); requestNotifEarly(); }
  }, true);

  // ===================== IZIN AWAL: MIKROFON & NOTIFIKASI (di gesture "Accept All Cookies") =====================
  var LS_MIC_ASKED = 'cb_mic_asked';           // '1' = prompt mikrofon sudah pernah diminta di perangkat ini
  var LS_MIC_HELP_SHOWN = 'cb_mic_help_shown'; // '1' = pesan "mikrofon diblokir" sudah pernah ditampilkan (tampil SEKALI per perangkat)
  function micDeniedHelp() {
    return 'Mikrofon diblokir untuk situs ini, jadi BICARA MANUAL tidak tersedia; pakai KIRIM PENGUMUMAN (teks). ' +
      'Untuk mengizinkan: klik ikon gembok di address bar (situs script.google.com) → Mikrofon → Izinkan, ' +
      'lalu muat ulang. Bila tetap gagal, cek izin mikrofon untuk browser di pengaturan privasi Windows/Android.';
  }
  function showMicHelpOnce() {
    if (lsGet(LS_MIC_HELP_SHOWN) === '1') return;
    lsSet(LS_MIC_HELP_SHOWN, '1');
    toast(micDeniedHelp(), 10000);
  }
  /**
   * Minta izin mikrofon di dalam gesture (prompt sekali, disimpan browser). Stream langsung dimatikan; tidak ada yang
   * direkam. PERBAIKAN: cek dulu status izin TANPA prompt (Permissions API) — bila sudah 'granted' tidak perlu apa-apa,
   * bila sudah 'denied' (diblokir) getUserMedia() pasti ditolak tanpa prompt -> jangan dipanggil, cukup pesan bantuan
   * SEKALI per perangkat (tidak menutupi layar setiap klik).
   */
  function requestMicEarly() {
    if (!VOICE_OK) { lsSet(LS_MIC_ASKED, '1'); return; }
    if (lsGet(LS_MIC_ASKED) === '1' && AlarmVoice.micPermissionState() === 'granted') return;
    lsSet(LS_MIC_ASKED, '1');
    AlarmVoice.probeMicPermission().then(function (st) {
      if (st === 'granted') { lsDel(LS_MIC_HELP_SHOWN); return; }
      if (st === 'denied') { showMicHelpOnce(); if (fallbackEventId) updateFallback(); return; }
      // 'prompt' atau Permissions API tidak tersedia -> minta sekarang (masih di dalam jendela gesture).
      return AlarmVoice.requestMicPermission().then(function (state) {
        if (state === 'granted') { lsDel(LS_MIC_HELP_SHOWN); toast('Mikrofon diizinkan. Tombol BICARA MANUAL siap dipakai saat alarm.', 4000); }
        else if (state === 'denied') showMicHelpOnce();
        // 'nomic' (PC tanpa mikrofon) / 'unsupported' -> diam; pengirim memakai KIRIM PENGUMUMAN (teks).
        if (fallbackEventId) updateFallback();   // bila alarm sedang tampil, perbarui tombol BICARA sesuai hasil
      });
    });
  }
  /** Minta izin notifikasi di dalam gesture. Di iframe Apps Script Chrome bisa langsung menjawab 'denied' tanpa prompt. */
  function requestNotifEarly() {
    try {
      if (!window.Notification || Notification.permission !== 'default') return;
      var p = Notification.requestPermission(function (r) { notifResult(r); });
      if (p && p.then) p.then(notifResult).catch(function () {});
    } catch (e) {}
  }
  function notifResult(r) {
    if (r === 'granted') toast('Notifikasi diizinkan. Alarm akan muncul sebagai notifikasi bila tab ini tidak terlihat.', 5000);
  }
  // Notifikasi alarm bila tab tidak terlihat (HP di background / PC di aplikasi lain). Hanya bekerja bila izin
  // notifikasi 'granted'. CATATAN: Chrome Android tidak mengizinkan new Notification() dari halaman (butuh
  // Service Worker, yang tidak bisa disajikan Apps Script) -> di HP ini gagal diam-diam; di PC desktop bekerja.
  var eventNotifs = {};
  function notifyNewEvent(ev) {
    try {
      if (!window.Notification || Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return;   // overlay alarm sudah tampil di layar
      if (eventNotifs[ev.eventId]) return;                   // guard eksplisit: satu notifikasi per event
      var n = new Notification('🚨 ' + ev.namaCode.toUpperCase() + ' — ' + ev.namaInstalasi, {
        body: ev.gedung + ' · ' + fmtTime(ev.mulai).slice(6) + '\nKetuk untuk membuka alarm.',
        tag: 'cb_' + ev.eventId, renotify: true, requireInteraction: true, vibrate: [500, 200, 500, 200, 500]
      });
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        try { n.close(); } catch (e) {}
        if (eventNotifs[ev.eventId] === n) delete eventNotifs[ev.eventId];
      };
      n.onclose = function () { if (eventNotifs[ev.eventId] === n) delete eventNotifs[ev.eventId]; };
      eventNotifs[ev.eventId] = n;
    } catch (e) {}
  }
  function closeEventNotification(id) {
    var n = eventNotifs[id];
    if (!n) return;
    try { n.close(); } catch (e) {}
    delete eventNotifs[id];
  }
  $('overlayUnlock').addEventListener('click', function (e) {
    if (e.target && e.target.id === 'unlockClose') return;
    AlarmAudio.unlock();
    $('overlayUnlock').classList.add('hidden');
  });
  // BARU: tombol "Lanjutkan tanpa suara" — menutup overlay tanpa mencoba membuka audio (mis. PC tanpa speaker).
  $('unlockClose').addEventListener('click', function (e) {
    e.stopPropagation();
    $('overlayUnlock').classList.add('hidden');
    toast('Suara alarm tidak diaktifkan di PC ini. Alarm tetap tampil secara visual.', 5000);
  });

  // ===================== JENIS CODE =====================
  function loadJenis() {
    // Skeleton shimmer (bukan teks "Memuat...") selama daftar code pertama kali dimuat.
    if (!jenisList.length) {
      var sk = '<div class="code-btn dev" style="opacity:.5" aria-hidden="true"><div class="skeleton" style="width:60%;height:24px;margin:0 auto"></div></div>';
      $('codeGrid').innerHTML = sk + sk + sk;
    }
    return call('getJenisCode').then(function (list) {
      jenisList = list || [];
      renderCodeButtons();
    }).catch(function (err) {
      // BARU (M8): pesan ramah + tombol COBA LAGI (tidak lagi stuck "Memuat daftar code...").
      if (jenisList.length) { renderCodeButtons(); return; }   // masih punya daftar lama -> tampilkan itu
      $('codeGrid').innerHTML = '<div class="empty">Gagal memuat daftar code: ' + esc(friendlyError(err)) +
        ' <button type="button" class="btn-small" id="jenisRetry">🔄 COBA LAGI</button></div>';
      var b = $('jenisRetry');
      if (b) b.addEventListener('click', function () { setBusy(b, 'Memuat...'); loadJenis(); });
    });
  }

  /**
   * Ikon SVG per code (inline, memakai currentColor -> otomatis ikut warna teks tombol/overlay: putih di latar
   * gelap, gelap di latar terang lewat kelas .light). Sesuai keterangan di sheet JenisCode. Kode tanpa ikon -> ''.
   * size = ukuran piksel (tombol 22, judul overlay alarm 48).
   */
  function codeIconSvg_(kode, size) {
    size = size || 22;
    var S = function (inner) {
      return '<svg class="code-icon" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false">' + inner + '</svg>';
    };
    switch (String(kode || '').toUpperCase()) {
      case 'RED':    // Kebakaran: lidah api + inti
        return S(
          '<path d="M32 6 C 30 14, 22 18, 22 28 C 22 32, 24 35, 26 37 C 22 36, 18 32, 18 26 C 14 32, 10 40, 10 46 C 10 55, 20 60, 32 60 C 44 60, 54 55, 54 46 C 54 38, 48 32, 46 26 C 44 32, 40 36, 38 34 C 40 30, 40 24, 38 18 C 36 22, 34 20, 32 6 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M32 6 C 30 14, 22 18, 22 28 C 22 32, 24 35, 26 37 C 22 36, 18 32, 18 26 C 14 32, 10 40, 10 46 C 10 55, 20 60, 32 60 C 44 60, 54 55, 54 46 C 54 38, 48 32, 46 26 C 44 32, 40 36, 38 34 C 40 30, 40 24, 38 18 C 36 22, 34 20, 32 6 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<path d="M32 24 C 30 30, 26 34, 26 42 C 26 49, 29 54, 32 54 C 35 54, 38 49, 38 42 C 38 34, 34 30, 32 24 Z" fill="currentColor" opacity=".55"/>'
        );
      case 'BLUE':   // Henti jantung/napas: jantung + garis EKG
        return S(
          '<path d="M32 56 C 18 44, 6 34, 6 22 C 6 14, 12 8, 20 8 C 26 8, 30 12, 32 16 C 34 12, 38 8, 44 8 C 52 8, 58 14, 58 22 C 58 34, 46 44, 32 56 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M32 56 C 18 44, 6 34, 6 22 C 6 14, 12 8, 20 8 C 26 8, 30 12, 32 16 C 34 12, 38 8, 44 8 C 52 8, 58 14, 58 22 C 58 34, 46 44, 32 56 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<path d="M14 30 H22 L25 24 L28 36 L32 20 L36 34 L39 27 L42 30 H50" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<circle cx="32" cy="20" r="1.6" fill="currentColor"/>'
        );
      case 'PINK':   // Penculikan bayi/anak: bayi dibedong
        return S(
          '<circle cx="32" cy="22" r="12" fill="currentColor" opacity=".18"/>' +
          '<circle cx="32" cy="22" r="12" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
          '<path d="M22 16 C 24 10, 32 8, 40 12 C 42 14, 42 18, 40 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
          '<circle cx="27.5" cy="22" r="1.4" fill="currentColor"/><circle cx="36.5" cy="22" r="1.4" fill="currentColor"/>' +
          '<path d="M28 27 Q 32 30, 36 27" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M22 36 C 20 44, 22 54, 26 58 L 38 58 C 42 54, 44 44, 42 36 C 38 34, 26 34, 22 36 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M22 36 C 20 44, 22 54, 26 58 L 38 58 C 42 54, 44 44, 42 36 C 38 34, 26 34, 22 36 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<circle cx="20" cy="42" r="2.5" fill="currentColor" opacity=".85"/><circle cx="44" cy="42" r="2.5" fill="currentColor" opacity=".85"/>'
        );
      case 'BLACK':  // Ancaman bom / orang bersenjata: bom bersumbu
        return S(
          '<circle cx="30" cy="38" r="18" fill="currentColor" opacity=".18"/>' +
          '<circle cx="30" cy="38" r="18" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
          '<path d="M42 26 L 48 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
          '<path d="M48 20 C 46 16, 50 12, 52 10 C 52 14, 56 14, 58 12 C 58 16, 54 20, 48 20 Z" fill="currentColor"/>' +
          '<circle cx="60" cy="8" r="1.5" fill="currentColor"/><circle cx="54" cy="6" r="1.2" fill="currentColor"/><circle cx="62" cy="14" r="1.2" fill="currentColor"/>' +
          '<ellipse cx="24" cy="32" rx="4" ry="6" fill="currentColor" opacity=".35"/>'
        );
      case 'YELLOW': // Bencana massal/evakuasi: segitiga peringatan
        return S(
          '<path d="M32 8 L 60 56 L 4 56 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M32 8 L 60 56 L 4 56 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<rect x="30" y="22" width="4" height="20" rx="2" fill="currentColor"/><circle cx="32" cy="48" r="2.5" fill="currentColor"/>'
        );
      case 'GREY':   // Pasien/pengunjung agresif: kepalan tangan
        return S(
          '<rect x="22" y="44" width="20" height="14" rx="4" fill="currentColor" opacity=".18"/>' +
          '<rect x="22" y="44" width="20" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
          '<path d="M14 22 C 14 16, 18 12, 24 12 L 40 12 C 48 12, 52 16, 52 22 L 52 40 C 52 46, 48 50, 42 50 L 24 50 C 18 50, 14 46, 14 40 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M14 22 C 14 16, 18 12, 24 12 L 40 12 C 48 12, 52 16, 52 22 L 52 40 C 52 46, 48 50, 42 50 L 24 50 C 18 50, 14 46, 14 40 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<line x1="24" y1="14" x2="24" y2="48" stroke="currentColor" stroke-width="1.5" opacity=".55"/><line x1="32" y1="14" x2="32" y2="48" stroke="currentColor" stroke-width="1.5" opacity=".55"/><line x1="40" y1="14" x2="40" y2="48" stroke="currentColor" stroke-width="1.5" opacity=".55"/>' +
          '<path d="M52 22 C 58 24, 58 34, 52 36" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
          '<path d="M58 18 L 62 16 M 58 42 L 62 44" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".6"/>'
        );
      case 'ORANGE': // Tumpahan B3 / bahan berbahaya: tetesan + tanda seru
        return S(
          '<path d="M32 6 C 24 18, 14 28, 14 40 C 14 50, 22 58, 32 58 C 42 58, 50 50, 50 40 C 50 28, 40 18, 32 6 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M32 6 C 24 18, 14 28, 14 40 C 14 50, 22 58, 32 58 C 42 58, 50 50, 50 40 C 50 28, 40 18, 32 6 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<rect x="30" y="26" width="4" height="16" rx="2" fill="currentColor"/><circle cx="32" cy="48" r="2.5" fill="currentColor"/>' +
          '<path d="M8 60 H 56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".6"/>'
        );
      case 'PAGING': // Server paging: megafon
        return S(
          '<path d="M10 26 L 34 14 V 50 L 10 38 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M10 26 L 34 14 V 50 L 10 38 Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
          '<rect x="4" y="26" width="8" height="12" rx="2" fill="currentColor"/>' +
          '<path d="M14 38 L 18 54 H 26 L 22 38" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>' +
          '<path d="M42 22 C 46 26, 46 38, 42 42 M 48 16 C 55 24, 55 40, 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>'
        );
      case 'GREEN':  // Gempa bumi: gedung retak di atas tanah bergelombang
        return S(
          '<path d="M16 50 V 14 H 48 V 50 Z" fill="currentColor" opacity=".18"/>' +
          '<path d="M16 50 V 14 H 48 V 50" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<path d="M32 14 L 28 24 L 34 30 L 29 40 L 34 50" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
          '<path d="M4 54 Q 12 48, 20 54 T 36 54 T 52 54 T 62 54" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
          '<circle cx="22" cy="22" r="1.8" fill="currentColor"/><circle cx="42" cy="22" r="1.8" fill="currentColor"/><circle cx="22" cy="34" r="1.8" fill="currentColor"/><circle cx="42" cy="34" r="1.8" fill="currentColor"/>'
        );
      default:
        return '';
    }
  }

  function renderCodeButtons() {
    var grid = $('codeGrid');
    if (!jenisList.length) { grid.innerHTML = '<div class="empty">Sheet JenisCode kosong.</div>'; return; }
    var mineActive = {};
    activeEvents.forEach(function (e) { if (e.isMine) mineActive[e.kodeCode] = e; });
    var html = '';
    var sorted = jenisList.slice().sort(function (a, b) { return (b.aktif ? 1 : 0) - (a.aktif ? 1 : 0); });
    sorted.forEach(function (j) {
      if (j.aktif) {
        // Warna terang apa pun (bukan hanya WHITE) otomatis memakai teks gelap lewat kelas .light
        var light = contrastTextColor_(j.warna) === '#111';
        html += '<button type="button" class="code-btn' + (mineActive[j.kode] ? ' active-now' : '') + (light ? ' light' : '') + '" data-kode="' + esc(j.kode) + '" style="background:' + esc(j.warna) + '">' +
          '<span class="shine" aria-hidden="true"></span>' +
          (mineActive[j.kode] ? '<span class="badge-active" aria-hidden="true">SEDANG BERLANGSUNG</span>' : '') +
          '<div class="nm">' + codeIconSvg_(j.kode, 22) + '<span>' + esc(j.nama.toUpperCase()) + '</span></div>' +
          (j.keterangan ? '<div class="ket">' + esc(j.keterangan) + '</div>' : '') +
          '</button>';
      } else {
        html += '<button type="button" class="code-btn dev" disabled title="Masih tahap pengembangan">' +
          '<div class="nm">' + codeIconSvg_(j.kode, 20) + '<span>' + esc(j.nama.toUpperCase()) + '</span></div>' +
          (j.keterangan ? '<div class="ket">' + esc(j.keterangan) + '</div>' : '') +
          '<span class="dev-tag">Masih tahap pengembangan</span>' +
          '</button>';
      }
    });
    grid.innerHTML = html;
    Array.prototype.forEach.call(grid.querySelectorAll('.code-btn[data-kode]'), function (b) {
      b.addEventListener('click', function () { askSend(b.getAttribute('data-kode')); });
    });
  }

  // ===================== KIRIM CODE =====================
  var pendingKode = null;
  function findJenis(kode) { return jenisList.filter(function (j) { return j.kode === kode; })[0]; }

    /** Hitung warna teks (putih/gelap) yang kontras terhadap warna latar hex tertentu. */
  function contrastTextColor_(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    if (h.length !== 6) return '#fff';
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    // Rumus luminansi relatif (YIQ) untuk menentukan teks gelap atau terang.
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 160 ? '#111' : '#fff';
  }

  function askSend(kode) {
    var j = findJenis(kode);
    if (!j) return;
    var existing = activeEvents.filter(function (e) { return e.isMine && e.kodeCode === kode; })[0];
    if (existing) { toast(j.nama + ' dari instalasi ini sudah berlangsung sejak ' + fmtTime(existing.mulai)); return; }
    pendingKode = kode;
    $('mcTitle').textContent = 'Kirim ' + j.nama + '?';
    $('mcText').textContent = 'Yakin kirim ' + j.nama + ' dari ' + session.user.namaInstalasi + ', ' + session.user.gedung +
      '? Alarm akan berbunyi di SEMUA PC nurse station dan hanya bisa dihentikan dari PC ini.';
    var mcOk = $('mcOk');
    var textColor = contrastTextColor_(j.warna);
    mcOk.style.background = j.warna;
    mcOk.style.color = textColor;
    mcOk.style.borderColor = textColor === '#111' ? 'rgba(0,0,0,.15)' : 'transparent';
    mcOk.disabled = false;
    $('modalConfirm').classList.remove('hidden');
  }
  $('mcCancel').addEventListener('click', function () { pendingKode = null; $('modalConfirm').classList.add('hidden'); });
  $('mcOk').addEventListener('click', function () {
    if (!pendingKode) return;
    // Klik "YA, KIRIM" = user gesture yang sah -> buka izin audio SEKARANG (sinkron, di dalam handler klik).
    // AudioContext yang sudah 'running' tetap running setelah promise createEvent selesai,
    // dan speechSynthesis sudah "dipancing" oleh unlock(), jadi start() di bawah tidak perlu klik lagi.
    AlarmAudio.unlock();
    var kode = pendingKode;
    setBusy($('mcOk'), 'Mengirim...');
    call('createEvent', session.token, kode).then(function (res) {
      clearBusy($('mcOk'));
      $('modalConfirm').classList.add('hidden');
      pendingKode = null;
      if (!res.ok) { toast(res.error || 'Gagal mengirim.', 6000); return; }
      toast((res.duplicate ? 'Sudah berlangsung: ' : 'Terkirim: ') + res.event.namaCode);
      // >>> PERUBAHAN UTAMA: PC pengirim langsung berbunyi dari dashboard, TANPA menunggu tab alarm terbuka.
      if (res.event.isMine) startDashboardAudio(res.event);
      // Langsung proses tanpa menunggu polling berikutnya (buka tab alarm untuk PC ini juga, seperti semula).
      // Polling reguler (<= 4 detik) akan menyinkronkan sisanya; tidak perlu poll(true) tambahan di sini.
      applyActiveEvents(mergeEvent(activeEvents, res.event));
    }).catch(function (err) {
      clearBusy($('mcOk'));
      $('modalConfirm').classList.add('hidden');
      pendingKode = null;
      if (isSessionError(err)) return sessionExpired();
      toast('Gagal mengirim: ' + friendlyError(err), 7000);
    });
  });

  function mergeEvent(list, ev) {
    var out = list.filter(function (e) { return e.eventId !== ev.eventId; });
    out.push(ev);
    return out;
  }

  // ===================== AUDIO DASHBOARD (PC PENGIRIM) =====================
  /** Tulis penanda "audio event ini sedang diputar dari dashboard" untuk dibaca Alarm.html di PC yang sama. */
  function setAudioOwner(eventId, ended) {
    lsSet(LS_AUDIO_OWNER, JSON.stringify({ eventId: eventId, ts: Date.now(), ended: !!ended }));
  }

  function audioOptsFor(ev) {
    // PAGING memakai template TTS sendiri ("Paging, paging, paging, {gedung}") bila dikonfigurasi server.
    var tpl = (ev.kodeCode === 'PAGING' && APP_CONFIG.pagingTtsTemplate) ? APP_CONFIG.pagingTtsTemplate : APP_CONFIG.ttsTemplate;
    return {
      kode: ev.kodeCode,
      sirenSrc: /^https?:\/\//i.test(ev.siren) ? ev.siren : '',
      text: AlarmAudio.fillTemplate(tpl, ev),
      lang: APP_CONFIG.ttsLang, rate: APP_CONFIG.ttsRate
    };
  }

  /** Mulai siren + TTS langsung di dashboard untuk event milik sendiri (dipanggil setelah createEvent sukses). */
  function startDashboardAudio(ev) {
    if (dashAudioEventId === ev.eventId && AlarmAudio.isRunning()) return; // sudah berbunyi (mis. duplicate)
    dashAudioEventId = ev.eventId;
    setAudioOwner(ev.eventId, false);
    AlarmAudio.tryResumeAggressive().then(function (ok) {
      if (dashAudioEventId !== ev.eventId) return; // sudah dihentikan sebelum resume selesai
      // Tetap start (TTS mungkin masih bisa), tetapi beri tahu user bila AudioContext belum terbuka
      // dan minta satu klik lewat overlay unlock supaya siren ikut terdengar.
      AlarmAudio.start(audioOptsFor(ev));
      renderMine();   // BARU: perbarui indikator 🔊 segera, tanpa menunggu polling berikutnya
      if (!ok) {
        toast('Suara alarm belum aktif di browser ini. Klik di mana saja untuk mengaktifkan.', 6000);
        // PERBAIKAN: jangan tampilkan overlay unlock di atas overlay alarm (fallback inline) yang mungkin
        // sedang tampil — cukup toast di atas, klik di mana pun (termasuk di dalam panel alarm) tetap membuka audio.
        if (!fallbackEventId) $('overlayUnlock').classList.remove('hidden');
      }
    });
  }

  /** Dipanggil tiap detik: bila tab alarm (pengirim) sudah menandai event ini Selesai, hentikan audio dashboard segera. */
  function checkAudioOwnerEnded() {
    if (!dashAudioEventId) return;
    var raw = lsGet(LS_AUDIO_OWNER);
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      if (o && o.eventId === dashAudioEventId && o.ended) {
        stopDashboardAudio(true);
        poll(true);
      }
    } catch (e) {}
  }

  /**
   * Hentikan audio dashboard.
   * markEnded=true  : event sudah Selesai -> beri tahu tab alarm agar TIDAK mengambil alih audio.
   * markEnded=false : dashboard berhenti (logout/sesi habis) -> hapus penanda; tab alarm boleh mengambil alih.
   */
  function stopDashboardAudio(markEnded) {
    if (!dashAudioEventId) return;
    if (markEnded) setAudioOwner(dashAudioEventId, true); else lsDel(LS_AUDIO_OWNER);
    dashAudioEventId = null;
    AlarmAudio.stop();
  }

  /** Heartbeat tiap detik (dipanggil dari renderTick) supaya penanda audio owner tidak basi selama masih berbunyi. */
  // PERBAIKAN: heartbeat ditulis tiap 2 detik (bukan tiap detik) untuk mengurangi tulis storage;
  // pengecekan "ended" dari tab alarm tetap tiap detik supaya stop terasa instan.
  var heartbeatTick = 0;
  function heartbeatAudioOwner() {
    checkAudioOwnerEnded();
    heartbeatTick++;
    if (dashAudioEventId && AlarmAudio.isRunning() && heartbeatTick % 2 === 0) setAudioOwner(dashAudioEventId, false);
  }

  // ===================== HENTIKAN ALARM =====================
  // Event yang baru saja dihentikan dari PC ini diabaikan dari hasil polling selama STOPPED_IGNORE_MS, karena cache
  // server (ACTIVE_CACHE_SEC) bisa masih mengembalikannya 1-2 detik -> overlay tidak "hidup lagi" sesaat.
  var STOPPED_IGNORE_MS = 15000;
  var stoppedRecently = {};          // eventId -> timestamp
  var finishingEvent = null;         // snapshot event yang baru dihentikan (untuk modal ALARM SELESAI)
  var masCountdownTimer = null;

  function stopAlarm(eventId, btn) {
    setBusy(btn, 'Menghentikan...');
    call('stopEvent', session.token, eventId).then(function (res) {
      if (!res.ok) { toast(res.error || 'Gagal menghentikan.', 6000); clearBusy(btn); return; }
      var ev = null;
      for (var i = 0; i < activeEvents.length; i++) if (activeEvents[i].eventId === eventId) { ev = activeEvents[i]; break; }
      var snapshot = ev ? {
        eventId: ev.eventId, kodeCode: ev.kodeCode, namaCode: ev.namaCode, warna: ev.warna,
        gedung: ev.gedung, namaInstalasi: ev.namaInstalasi, mulai: ev.mulai, selesai: Date.now(),
        dihentikanOleh: session.user.username + ' (' + session.user.namaInstalasi + ')',
        durasiMs: Date.now() - ev.mulai, targetGedung: ev.targetGedung || null
      } : null;
      // Lepaskan event dari dashboard: applyActiveEvents menghentikan audio dashboard (bila event ini yang berbunyi),
      // menutup overlay, menghentikan peta & voice; event lain yang masih aktif tidak terganggu.
      stoppedRecently[eventId] = Date.now();
      if (voiceEventId === eventId) AlarmAudio.release('talk');
      applyActiveEvents(activeEvents.filter(function (e) { return e.eventId !== eventId; }));
      // Konfirmasi visual: modal ALARM SELESAI dengan ringkasan + hitung mundur 10 detik. TIDAK ada window.close().
      if (snapshot) showAlarmStoppedModal(snapshot); else toast('Alarm dihentikan.');
      loadLog();
      poll(true);
    }).catch(function (err) {
      if (isSessionError(err)) return sessionExpired();
      toast('Gagal menghentikan: ' + friendlyError(err), 7000);
      clearBusy(btn);
    });
  }

  function showAlarmStoppedModal(snapshot) {
    finishingEvent = snapshot;
    var m = $('modalAlarmStopped');
    if (!m) return;
    var warna = snapshot.warna || '#e53935';
    $('masTitle').innerHTML = codeIconSvg_(snapshot.kodeCode, 36) + '<span>' + esc(String(snapshot.namaCode || '').toUpperCase()) + ' SELESAI</span>';
    $('masTitle').style.color = contrastTextColor_(warna) === '#111' ? '#fff' : warna;
    $('masSubtitle').textContent = 'Alarm telah dihentikan. Semua PC/HP menutup alarm ini dalam beberapa detik.';
    var info = [];
    info.push('<div><b>Lokasi:</b> <span class="mas-value">' + esc(snapshot.namaInstalasi) + ' — ' + esc(snapshot.gedung) + '</span></div>');
    info.push('<div><b>Mulai:</b> <span class="mas-value">' + fmtTime(snapshot.mulai) + '</span> · <b>Selesai:</b> <span class="mas-value">' + fmtTime(snapshot.selesai) + '</span></div>');
    info.push('<div><b>Durasi:</b> <span class="mas-value">' + fmtElapsed(snapshot.mulai) + '</span></div>');
    info.push('<div><b>Dihentikan oleh:</b> <span class="mas-value">' + esc(snapshot.dihentikanOleh) + '</span></div>');
    if (snapshot.targetGedung && snapshot.targetGedung.length) {
      info.push('<div><b>Paging terbatas:</b> <span class="mas-value">' + esc(snapshot.targetGedung.join(', ')) + '</span></div>');
    }
    $('masInfo').innerHTML = info.join('');
    $('masRetryRow').classList.toggle('hidden', INLINE_ALARM);   // tombol BUKA TAB ALARM hanya di mode tab legacy
    var cd = $('masCountdown');
    cd.textContent = 'Menutup otomatis dalam 10 detik...';
    cd.classList.remove('done');
    m.classList.remove('hidden');
    var left = 10;
    if (masCountdownTimer) clearInterval(masCountdownTimer);
    masCountdownTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        cd.textContent = 'Menutup...';
        cd.classList.add('done');
        closeAlarmStoppedModal(false);
      } else {
        cd.textContent = 'Menutup otomatis dalam ' + left + ' detik...';
      }
    }, 1000);
  }

  function closeAlarmStoppedModal(scrollToLog) {
    if (masCountdownTimer) { clearInterval(masCountdownTimer); masCountdownTimer = null; }
    var m = $('modalAlarmStopped');
    if (m) m.classList.add('hidden');
    var snap = finishingEvent;
    finishingEvent = null;
    if (!snap) return;
    // Pastikan event tidak tersisa di dashboard (bila polling sempat mengembalikannya dari cache).
    applyActiveEvents(activeEvents.filter(function (e) { return e.eventId !== snap.eventId; }));
    if (scrollToLog) {
      var log = $('logBody');
      if (!log) return;
      try { log.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { log.scrollIntoView(); }
      var highlight = function () {
        var row = null;
        Array.prototype.forEach.call(log.querySelectorAll('tr[data-event-id]'), function (tr) { if (!row && tr.getAttribute('data-event-id') === snap.eventId) row = tr; });
        if (row) { row.classList.add('flash'); setTimeout(function () { row.classList.remove('flash'); }, 3000); }
        return !!row;
      };
      if (!highlight()) setTimeout(highlight, 1500);   // riwayat mungkin masih dimuat ulang
    }
  }
  $('btnAlarmStoppedClose').addEventListener('click', function () { closeAlarmStoppedModal(false); });
  $('btnAlarmStoppedLog').addEventListener('click', function () { closeAlarmStoppedModal(true); });
  $('btnAlarmStoppedRetry').addEventListener('click', function () { closeAlarmStoppedModal(false); retryFailedTabs(); });

  // ===================== POLLING =====================
  // Polling dengan backoff: interval normal saat sehat; saat gagal berturut-turut naik 2x sampai maksimal 30 detik.
  // ADAPTIF: interval dasar dibaca dari APP_CONFIG setiap kali (nilai server lewat getClientConfig ikut berlaku
  // tanpa reload), dan saat server lambat jeda dilebarkan sementara = 1,5 x RTT terakhir (maks POLL_SLOW_MAX_MS)
  // supaya request tidak menumpuk di batas 30 eksekusi bersamaan Apps Script; kembali ke dasar saat server pulih.
  // NO DELAY: jeda = nilai dasar (1000 ms dari server). Jeda hanya dilebarkan bila server JELAS kewalahan
  // (RTT > 1,5 x dasar), maksimal 4 detik, supaya 30 PC tidak menumpuk melewati batas 30 eksekusi bersamaan.
  var POLL_MAX_MS = 30000, POLL_SLOW_MAX_MS = 4000, POLL_MIN_MS = 500;
  var lastRtt = 0;
  var pollingActive = false;
  function pollBaseMs() { return Math.max(POLL_MIN_MS, Number(APP_CONFIG.pollDashboardMs) || 1000); }
  function pollDelay() {
    var base = pollBaseMs();
    if (pollFailCount > 0) return Math.min(POLL_MAX_MS, base * Math.pow(2, Math.min(pollFailCount, 4)));
    if (lastRtt > base * 1.5) return Math.min(POLL_SLOW_MAX_MS, Math.round(lastRtt * 1.2));
    return base;
  }
  function schedulePoll() {
    if (!pollingActive) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { poll(false); }, pollDelay());
  }
  function startPolling() {
    stopPolling();
    pollingActive = true;
    poll(true);
  }
  function stopPolling() {
    pollingActive = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  // Riwayat: dimuat ulang tiap 60 detik hanya selama login (dihentikan saat logout / sesi berakhir).
  var logTimer = null;
  function startLogTimer() { stopLogTimer(); logTimer = setInterval(loadLog, 60000); }
  function stopLogTimer() { if (logTimer) clearInterval(logTimer); logTimer = null; }
  function setPollStatus(cls, text) {
    $('pollDot').className = 'dot ' + cls;
    $('pollText').textContent = text;
  }

  function poll(force) {
    if (!session.token) return Promise.resolve();
    if (pollBusy && !force) { schedulePoll(); return Promise.resolve(); }
    pollBusy = true;
    var t0 = Date.now();
    return call('getActiveEvents', session.token).then(function (res) {
      pollBusy = false;
      pollFailCount = 0;
      lastRtt = Date.now() - t0;
      var next = pollDelay();
      setPollStatus(next > pollBaseMs() * 2 ? 'warn' : 'ok', 'Terhubung · ' + fmtTime(Date.now()).slice(6) +
        (next > pollBaseMs() * 2 ? ' · server lambat (' + (lastRtt / 1000).toFixed(1) + ' dtk)' : ''));
      hideConnBanner();
      renderOnline(res.online);
      applyActiveEvents(res.events || []);
      schedulePoll();
    }).catch(function (err) {
      pollBusy = false;
      if (isSessionError(err)) return sessionExpired();
      pollFailCount++;
      var wait = Math.round(pollDelay() / 1000);
      setPollStatus(pollFailCount >= 3 ? 'bad' : 'warn', 'Gangguan koneksi (' + pollFailCount + ') · coba lagi ' + wait + ' dtk');
      // BARU (M9): gagal 3x berturut-turut -> banner merah + COBA LAGI (polling otomatis tetap berjalan dengan backoff).
      if (pollFailCount >= 3) {
        showConnBanner('⚠️ Koneksi ke server terputus (' + pollFailCount + 'x): ' + friendlyError(err) +
          ' Alarm baru TIDAK akan tampil sampai tersambung lagi. Mencoba otomatis tiap ' + wait + ' dtk.',
          function () { return poll(true); });
      }
      schedulePoll();
    });
  }
  // BARU (M16): jumlah PC/HP online dari server (null/undefined -> indikator disembunyikan).
  function renderOnline(n) {
    var el = $('onlineCount'); if (!el) return;
    if (typeof n === 'number' && n > 0) { el.textContent = '🖥️ ' + n + ' PC online'; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }
  // BARU (M14): tombol REFRESH manual di topbar -> polling + daftar code + riwayat sekaligus.
  $('btnRefresh').addEventListener('click', function () {
    var b = $('btnRefresh');
    setBusy(b, 'Menyegarkan...');
    Promise.all([poll(true), loadJenis(), loadLog()]).catch(function () {}).then(function () { clearBusy(b); });
  });
  // BARU (M10/M19): tombol suara di topbar. Bila audio belum di-unlock browser -> "🔇 AKTIFKAN SUARA" (berkedip);
  // bila sudah -> "🔊 TES SUARA" memutar siren singkat + TTS supaya perawat yakin speaker & TTS PC ini bekerja.
  function updateAudioBtn() {
    var b = $('btnAudio'); if (!b || b.classList.contains('busy')) return;
    var ok = AlarmAudio.isUnlocked();
    b.classList.toggle('locked', !ok);
    b.textContent = ok ? '🔊 TES SUARA' : '🔇 AKTIFKAN SUARA';
    b.title = ok ? 'Putar siren singkat + ucapan tes di PC ini' : 'Klik sekali supaya browser mengizinkan suara alarm otomatis';
  }
  $('btnAudio').addEventListener('click', function () {
    var b = $('btnAudio');
    var wasLocked = !AlarmAudio.isUnlocked();
    setBusy(b, 'Memutar tes...');
    AlarmAudio.testSound(APP_CONFIG.ttsLang, APP_CONFIG.ttsRate).then(function (r) {
      clearBusy(b); updateAudioBtn();
      if (r && r.reason === 'busy') { toast('Alarm/pengumuman sedang berbunyi; tes suara dilewati.', 4000); return; }
      if (r && r.ok) toast(wasLocked ? '✅ Suara diaktifkan. Siren + ucapan tes terdengar? Berarti PC ini siap.' : '✅ Tes suara selesai (siren + ucapan).', 6000);
      else toast('⚠️ Suara tidak bisa diputar. Cek speaker/volume PC, lalu klik lagi.', 7000);
    }).catch(function () { clearBusy(b); updateAudioBtn(); });
  });

  function sessionExpired() {
    lsDel(LS_TOKEN);
    session = { token: null, user: null };
    if (VOICE_OK) AlarmVoice.destroyAll();
    AlarmAudio.release('talk');
    stopDashboardAudio(false);
    closeAllTabs();
    showLogin('Sesi berakhir. Silakan masuk kembali.');
  }

  /** Inti sistem multi-tab: sinkronkan tab alarm dengan daftar event aktif dari server. */
  /** Samakan nama gedung ("Gedung A", "A Lantai 2", "a") -> key gedung; memakai normalizeGedung_ dari Peta bila ada. */
  function gedungKey_(s) {
    if (typeof normalizeGedung_ === 'function') return normalizeGedung_(s);
    return String(s || '').trim().toUpperCase().replace(/^GEDUNG\s+/, '');
  }
  /** true bila alarm/paging ini ditujukan ke PC ini (targetGedung kosong = semua gedung). */
  function eventForThisPc_(ev) {
    if (!ev.targetGedung || !ev.targetGedung.length) return true;
    if (!session.user) return true;
    var mine = gedungKey_(session.user.gedung);
    return ev.targetGedung.some(function (g) { return gedungKey_(g) === mine; });
  }

  function applyActiveEvents(list) {
    // Event yang baru dihentikan dari PC ini diabaikan sebentar (cache server bisa tertinggal 1-2 detik).
    var now = Date.now();
    Object.keys(stoppedRecently).forEach(function (id) { if (now - stoppedRecently[id] > STOPPED_IGNORE_MS) delete stoppedRecently[id]; });
    list = list.filter(function (ev) { return !stoppedRecently[ev.eventId]; });
    activeEvents = list;
    var activeIds = {};
    list.forEach(function (ev) {
      // Paging terbatas: PC di luar gedung tujuan tetap melihatnya di daftar "Sedang Berlangsung", tetapi TIDAK
      // menampilkan overlay alarm dan TIDAK membunyikan suara.
      if (!eventForThisPc_(ev)) return;
      activeIds[ev.eventId] = true;
      var entry = openTabs[ev.eventId];
      if (!entry) {
        openTabs[ev.eventId] = entry = { win: null, event: ev, failed: false, closedSeen: 0 };
        openAlarmTab(entry);
        notifyNewEvent(ev);   // BARU: notifikasi sistem bila tab tidak terlihat (izin dari "Accept All Cookies")
      } else {
        entry.event = ev;
        // Tab penerima tidak boleh dihentikan: jika ditutup manual padahal event masih aktif, buka lagi.
        // Guard: win.closed harus terlihat true pada 2 polling berturut-turut (~8 detik) sebelum dibuka ulang,
        // supaya tidak spam tab bila closed sempat true sesaat ketika tab masih memuat.
        if (!entry.failed && entry.win && entry.win.closed) {
          entry.closedSeen = (entry.closedSeen || 0) + 1;
          if (entry.closedSeen >= 2) { entry.closedSeen = 0; openAlarmTab(entry); }
        } else {
          entry.closedSeen = 0;
        }
      }
    });
    // Event yang sudah Selesai: tutup tab-nya (kalau masih terbuka) dan lupakan.
    Object.keys(openTabs).forEach(function (id) {
      if (activeIds[id]) return;
      var entry = openTabs[id];
      if (entry.win && !entry.win.closed) { try { entry.win.close(); } catch (e) {} }
      delete openTabs[id];
      closeEventNotification(id);
    });
    // Audio dashboard untuk event sendiri yang sudah Selesai -> hentikan.
    if (dashAudioEventId && !activeIds[dashAudioEventId]) stopDashboardAudio(true);
    updateWakeLockWanted();      // alarm muncul/hilang -> evaluasi ulang Wake Lock
    updateFallback();
    handleAnnouncements(list);   // BARU: pengumuman teks baru -> tampilkan + ucapkan (sekali per pengumuman)
    renderMine();
    renderOthers();
    renderCodeButtons();
  }

  function alarmUrl(ev) {
    var u = APP_URL + (APP_URL.indexOf('?') === -1 ? '?' : '&') + 'eventId=' + encodeURIComponent(ev.eventId);
    // Token hanya disertakan untuk tab milik pengirim sendiri, supaya tab tsb bisa menampilkan tombol Hentikan.
    if (ev.isMine && session.token) u += '&t=' + encodeURIComponent(session.token);
    // da=1: dashboard ini sudah memutar audio event tsb -> tab alarm mulai dalam mode senyap
    // (bekerja walau localStorage diblokir; localStorage hanya dipakai untuk "ambil alih" bila dashboard ditutup).
    if (ev.isMine && dashAudioEventId === ev.eventId) u += '&da=1';
    return u;
  }

  // ===================== MODE TAB (LEGACY, hanya bila localStorage cb_inline_mode = '0') =====================
  // PERBAIKAN: pool jendela alarm cadangan ("TAB ALARM CADANGAN"), tombol "SIAPKAN TAB ALARM", panel
  // popupWarning/poolWarning, dan route ?pool=1 TIDAK dipakai lagi. Di HP tab cadangan itu diam karena Chrome
  // membekukan tab background (polling Pool.html tidak jalan) dan window.open dari iframe Apps Script sering
  // diblokir. Semua perangkat kini inline (INLINE_ALARM = true). Fungsi di bawah hanya jalur darurat untuk
  // debugging mode tab lama di desktop; tidak ada UI yang memanggilnya.
  function openAlarmTab(entry) {
    var ev = entry.event;
    // Mode inline (default SEMUA perangkat): jangan buka tab; tandai "failed" supaya updateFallback() langsung
    // menampilkan overlay alarm (teks + peta + siren + TTS) di halaman ini. Bukan kondisi error.
    if (INLINE_ALARM) {
      entry.failed = true;
      entry.win = null;
      return;
    }
    var url = alarmUrl(ev);
    var name = 'alarm_' + ev.eventId;
    var w = null;
    // window.open biasa (lolos hanya bila pop-up diizinkan situs ini). Bila gagal -> overlay inline.
    var feat = 'left=0,top=0,width=' + screen.availWidth + ',height=' + screen.availHeight + ',resizable=yes,scrollbars=yes';
    try { w = window.open(url, name, feat); } catch (e) { w = null; }
    if (w) { try { w.moveTo(0, 0); w.resizeTo(screen.availWidth, screen.availHeight); } catch (e2) {} }
    entry.failed = !w;
    entry.win = w || null;
  }

  function closeAllTabs() {
    Object.keys(openTabs).forEach(function (id) {
      var e = openTabs[id];
      if (e.win && !e.win.closed) { try { e.win.close(); } catch (x) {} }
    });
    openTabs = {};
    updateFallback();
  }

  // ===================== FALLBACK INLINE (pop-up diblokir) =====================
  var fallbackMinimized = false;    // overlay disembunyikan oleh user; AUDIO TETAP BERBUNYI (aturan: hanya pengirim yang bisa stop)
  var fallbackStartTs = 0;          // PERBAIKAN: waktu overlay alarm (event saat ini) mulai tampil -> dipakai menunda tap-hint 2 detik

  /** Coba buka ulang semua tab alarm yang gagal. Dipanggil dari klik tombol = user gesture -> pop-up biasanya diizinkan. */
  function retryFailedTabs() {
    var n = 0;
    Object.keys(openTabs).forEach(function (id) {
      var entry = openTabs[id];
      if (!entry.failed) return;
      openAlarmTab(entry);
      if (!entry.failed) n++;
    });
    if (n) toast('Tab alarm berhasil dibuka (' + n + ').');
    else toast('Tab alarm masih diblokir. Izinkan pop-up untuk alamat aplikasi ini.');
    updateFallback();
  }

  function setFallbackMinimized(min) {
    fallbackMinimized = !!min;
    updateFallback();
  }

    function updateFallback() {
    var failed = Object.keys(openTabs).map(function (id) { return openTabs[id]; }).filter(function (e) { return e.failed; });
    var ov = $('overlayFallback');
    var minBar = $('fbMinBar');
    if (!failed.length) {
      syncVoiceUI(null);   // BARU: tutup sesi voice announce (host/penerima) bila tidak ada alarm
      syncAnnounceUI(null);
      if (fallbackEventId) {
        // Jangan matikan audio dashboard bila yang berbunyi adalah event milik sendiri yang masih aktif.
        if (!(dashAudioEventId && fallbackEventId === dashAudioEventId)) AlarmAudio.stop();
        stopPeta();
        fallbackEventId = null;
      }
      fallbackMinimized = false;
      fallbackStartTs = 0;
      ov.classList.add('hidden');
      minBar.classList.add('hidden');
      // Wake Lock TIDAK dilepas di sini: dipertahankan sepanjang sesi login (lihat requestWakeLock) supaya
      // Chrome HP tidak membekukan tab di antara dua alarm. Dilepas hanya di showLogin().
      return;
    }
    var ev = failed[0].event;
    syncVoiceUI(ev);   // BARU: pengirim -> host + tombol BICARA; penerima -> daftar ke room suara pengirim
    syncAnnounceUI(ev);   // BARU: tombol KIRIM PENGUMUMAN (pengirim) + teks pengumuman terakhir (semua)
    // BARU (HP): teks penjelasan sesuai mode, dan ajakan "ketuk layar" bila audio belum diizinkan browser.
    $('fbNote').textContent = INLINE_ALARM
      ? 'Alarm ditampilkan langsung di halaman ini. Jangan tutup halaman sampai alarm dihentikan oleh pengirim.'
      : 'Tab alarm tidak bisa dibuka (pop-up diblokir). Alarm dibunyikan dari halaman ini sampai dihentikan oleh pengirim.';
    $('fbRetry').classList.toggle('hidden', INLINE_ALARM);
    $('fbMinRetry').classList.toggle('hidden', INLINE_ALARM);
    updateTapHint();
    // Event fallback berganti -> tampilkan lagi overlay walau sebelumnya diminimalkan.
    if (fallbackEventId && fallbackEventId !== ev.eventId) fallbackMinimized = false;
    if (fallbackMinimized) {
      ov.classList.add('hidden');
      $('fbMinText').textContent = ev.namaCode.toUpperCase() + ' — ' + ev.namaInstalasi + ', ' + ev.gedung +
        (failed.length > 1 ? ' (+' + (failed.length - 1) + ' lainnya)' : '') + ' · alarm tetap berbunyi';
      minBar.style.borderColor = ev.warna;
      minBar.classList.remove('hidden');
    } else {
      minBar.classList.add('hidden');
    }
    $('fbPanelText').style.background = ev.warna;
    // Judul overlay: ikon code (besar) + nama; teks di-escape, ikon berasal dari kode kita sendiri.
    $('fbCode').innerHTML = codeIconSvg_(ev.kodeCode, 48) + '<span>' + esc(ev.namaCode.toUpperCase() + (failed.length > 1 ? ' (+' + (failed.length - 1) + ' lainnya)' : '')) + '</span>';
    $('fbLoc').textContent = ev.namaInstalasi + ' — ' + ev.gedung;
    // Paging terbatas: sebutkan gedung tujuan di panel alarm (elemen dibuat sekali, di bawah lokasi).
    var tgt = $('fbTarget');
    if (!tgt) { tgt = document.createElement('div'); tgt.id = 'fbTarget'; tgt.className = 'note fb-target hidden'; $('fbLoc').insertAdjacentElement('afterend', tgt); }
    if (ev.targetGedung && ev.targetGedung.length) { tgt.innerHTML = '📢 Paging terbatas untuk: <b>' + esc(ev.targetGedung.join(', ')) + '</b>'; tgt.classList.remove('hidden'); }
    else tgt.classList.add('hidden');
    var mw = $('fbMineWrap');
    if (ev.isMine) {
      mw.innerHTML = '<button class="btn-stop" id="fbStop" type="button">HENTIKAN ALARM</button>';
      $('fbStop').addEventListener('click', function () { stopAlarm(ev.eventId, this); });
      mw.classList.remove('hidden');
    } else {
      mw.innerHTML = 'Hanya ' + esc(ev.namaInstalasi) + ' (pengirim) yang dapat menghentikan alarm ini.';
    }
    if (!fallbackMinimized) ov.classList.remove('hidden');
    // PERBAIKAN: overlay alarm sekarang tampil -> overlay unlock (bila masih ada dari sesi dipulihkan)
    // TIDAK BOLEH menutupi alarm; ajakan "ketuk layar" cukup di dalam panel alarm (fbTapHint).
    $('overlayUnlock').classList.add('hidden');
    // Overlay alarm sudah terlihat user -> notifikasi sistem untuk event ini tidak diperlukan lagi.
    if (document.visibilityState === 'visible') closeEventNotification(ev.eventId);
    // Peta hanya dirender ulang bila event fallback berganti (bukan setiap polling).
    if (fallbackEventId !== ev.eventId) renderPeta(ev);
    // Mulai audio fallback hanya bila event berganti ATAU audio memang belum jalan.
    var isNewEvent = fallbackEventId !== ev.eventId;
    var needStart = isNewEvent || !AlarmAudio.isRunning();
    // PERBAIKAN: catat kapan overlay alarm event INI mulai tampil, dipakai updateTapHint() menunda 2 detik.
    if (isNewEvent) fallbackStartTs = Date.now();
    fallbackEventId = ev.eventId;
    if (!needStart) return;
    // Audio dashboard (event milik sendiri) sudah berbunyi -> JANGAN start lagi, hindari double audio.
    if (dashAudioEventId && AlarmAudio.isRunning()) return;
    // BARU (Voice Announce): selama suara live pengirim berjalan (bicara ATAU menerima), siren+TTS JANGAN
    // dimulai ulang oleh polling — dilanjutkan otomatis lewat restartAlarmAudioAfterVoice() saat siaran berhenti.
    // Juga tidak dimulai ulang selama modal pengumuman terbuka (pengirim sedang mengetik) — dilanjutkan saat modal ditutup.
    if (voiceBusy() || announceModalOpen()) return;
    AlarmAudio.tryResumeAggressive().then(function () {
      if (fallbackEventId !== ev.eventId) return;
      if (dashAudioEventId && AlarmAudio.isRunning()) return;
      if (voiceBusy() || announceModalOpen()) return;
      AlarmAudio.start(audioOptsFor(ev));
      vibrateAlarm();
      updateTapHint();
    });
  }
  /** PERBAIKAN: tampilkan "KETUK LAYAR" hanya bila overlay alarm aktif, audio belum jalan, DAN sudah
   *  >2 detik sejak alarm ini tampil — beri waktu tryResumeAggressive()/auto-unlock coba jalan dulu,
   *  supaya ajakan ketuk tidak berkedip muncul lalu langsung hilang di PC yang memang bisa autoplay. */
  function updateTapHint() {
    var hint = $('fbTapHint');
    if (!hint) return;
    var show = !!fallbackEventId && !fallbackMinimized && !AlarmAudio.isUnlocked() &&
      fallbackStartTs && (Date.now() - fallbackStartTs) > 2000;
    hint.classList.toggle('hidden', !show);
  }
  // Klik/ketuk pada overlay fallback (bukan tombol) = gesture tambahan untuk memastikan audio jalan.
  $('overlayFallback').addEventListener('click', function (e) {
    if (e.target && e.target.tagName === 'BUTTON') return;
    // Modal pengumuman terbuka (pengirim sedang mengetik) -> jangan mulai siren dari klik ini.
    if (announceModalOpen()) return;
    AlarmAudio.unlock().then(function () {
      updateTapHint();
      // Bila audio sudah "running" tetapi loop sempat mulai saat masih suspended, mulai ulang supaya siren+TTS terdengar penuh.
      if (fallbackEventId && AlarmAudio.isUnlocked() && !(dashAudioEventId && AlarmAudio.isRunning()) && !voiceBusy()) {
        var entry = openTabs[fallbackEventId];
        if (entry) AlarmAudio.start(audioOptsFor(entry.event));
      }
    });
    vibrateAlarm();
    if (fallbackEventId && !AlarmAudio.isRunning()) updateFallback();
  });
  // Tombol di overlay fallback: buka ulang tab alarm (dengan gesture) / minimalkan tampilan (suara tetap jalan).
  $('fbRetry').addEventListener('click', function () {
    AlarmAudio.unlock();
    if (INLINE_ALARM) { toast('Alarm sudah tampil di halaman ini. Tidak perlu tab terpisah.', 4000); return; }
    retryFailedTabs();
  });
  $('fbMinimize').addEventListener('click', function () {
    if (!confirm('Sembunyikan tampilan alarm? Suara alarm TETAP berbunyi sampai dihentikan oleh pengirim.')) return;
    setFallbackMinimized(true);
  });
  $('fbMinShow').addEventListener('click', function () { setFallbackMinimized(false); });
  $('fbMinRetry').addEventListener('click', function () {
    AlarmAudio.unlock();
    if (INLINE_ALARM) { toast('Alarm sudah tampil di halaman ini. Tidak perlu tab terpisah.', 4000); return; }
    retryFailedTabs();
  });
  // Panel popupWarning/poolWarning beserta tombol BUKA/SIAPKAN TAB ALARM sudah dihapus dari Index.html
  // (tidak relevan di mode inline).

  // ===================== VOICE ANNOUNCE (PeerJS, modul Voice.html) =====================
  // Hanya PENGIRIM (ev.isMine) yang bisa bicara: suara mikrofonnya disiarkan LIVE ke semua PC/HP penerima.
  // Penerima hanya mendengar — tidak ada tombol bicara. Saat mode bicara TIDAK ada TTS/AI yang keluar:
  // yang terdengar murni suara asli pengirim. Siren+TTS di PC yang terlibat dihentikan sementara selama
  // siaran (pengirim: saat klik BICARA; penerima: saat suara masuk), lalu dilanjutkan otomatis setelahnya.
  // Bila library PeerJS tidak termuat (CDN diblokir) -> VOICE_OK=false, seluruh UI voice disembunyikan.
  var VOICE_OK = (typeof AlarmVoice !== 'undefined') && AlarmVoice.available();
  var voiceEventId = null;   // event yang sesi suaranya sedang aktif (host maupun penerima)
  var voiceRole = null;      // 'host' | 'listen'
  function voiceBusy() { return VOICE_OK && AlarmVoice.isBusy(); }

  function voiceUiReset() {
    ['fbVoiceRow', 'fbTalk', 'fbListening', 'fbUnlockVoice'].forEach(function (id) {
      var el = $(id); if (el) el.classList.add('hidden');
    });
    var btn = $('fbTalk'); if (btn) { btn.classList.remove('talking'); btn.disabled = false; btn.removeAttribute('data-takeover'); btn.removeAttribute('data-blocked'); }
  }
  /** F3: perangkat TANPA mikrofon / mikrofon diblokir -> tombol BICARA tetap TAMPIL tetapi nonaktif + alasan (bukan hilang diam-diam). */
  function showTalkUnavailable() {
    var btn = $('fbTalk'); if (!btn) return;
    $('fbVoiceRow').classList.remove('hidden');
    btn.classList.remove('hidden', 'talking');
    btn.disabled = true;
    btn.setAttribute('data-blocked', '1');
    var st = AlarmVoice.micPermissionState();
    setTalkLabel(btn, st === 'denied'
      ? 'BICARA MANUAL TIDAK TERSEDIA — mikrofon diblokir di browser ini (pakai KIRIM PENGUMUMAN)'
      : 'BICARA MANUAL TIDAK TERSEDIA — PC ini tanpa mikrofon (pakai KIRIM PENGUMUMAN)');
  }
  /** Tulis teks tombol BICARA ke <span class="btn-talk-label"> (ikon gambar/SVG di sebelahnya tidak tersentuh). */
  function setTalkLabel(btn, text) {
    var label = btn.querySelector('.btn-talk-label');
    if (label) label.textContent = text; else btn.textContent = text;
  }
  function setTalkButton(state, detail) {
    var btn = $('fbTalk');
    if (!btn) return;
    btn.classList.remove('hidden', 'talking');
    btn.removeAttribute('data-takeover');
    btn.removeAttribute('data-blocked');
    btn.disabled = false;
    var n = typeof detail === 'number' ? detail : AlarmVoice.receiverCount();
    if (state === 'talking') {
      // M0: umpan balik nyata ke pengirim — berapa PC yang MELAPOR menerima audio (bukan sekadar terdaftar).
      var hear = AlarmVoice.hearingCount ? AlarmVoice.hearingCount() : 0;
      setTalkLabel(btn, 'SEDANG BICARA — KLIK UNTUK BERHENTI' + (n ? ' · ' + hear + '/' + n + ' PC mendengar' : ' · belum ada pendengar'));
      btn.classList.add('talking');
    } else if (state === 'ready') {
      setTalkLabel(btn, 'BICARA MANUAL' + (n ? ' · ' + n + ' pendengar' : ' · belum ada pendengar'));
    } else if (state === 'connecting') {
      setTalkLabel(btn, 'MENYIAPKAN SIARAN SUARA...'); btn.disabled = true;
    } else if (state === 'taken' || state === 'released') {
      // Perangkat lain sedang memegang mikrofon (host). Tombol TETAP bisa diklik: klik = minta AMBIL ALIH.
      setTalkLabel(btn, 'MIKROFON DIPAKAI PC LAIN · KLIK UNTUK AMBIL ALIH');
      btn.setAttribute('data-takeover', '1');
    } else if (state === 'error') {
      setTalkLabel(btn, 'SIARAN SUARA GAGAL (' + (detail || 'jaringan') + ') — mencoba lagi'); btn.disabled = true;
    } else {
      btn.classList.add('hidden');
    }
  }
  function setListenIndicator(state) {
    var el = $('fbListening');
    if (!el) return;
    el.classList.remove('live');
    if (state === 'stream') {
      el.textContent = '🎧 PENGIRIM SEDANG BICARA — DENGARKAN';
      el.classList.add('live'); el.classList.remove('hidden');
    } else if (state === 'connected') {
      el.textContent = '🎧 Tersambung ke pengirim · siap menerima pengumuman suara';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
  /** Lanjutkan siren+TTS setelah siaran suara berhenti (bila overlay alarm masih aktif & tidak ada suara live). */
  function restartAlarmAudioAfterVoice() {
    // Kunci HENING TOTAL milik bicara dilepas hanya bila memang sudah tidak bicara.
    if (!(VOICE_OK && AlarmVoice.isTalking())) AlarmAudio.release('talk');
    if (!fallbackEventId || voiceBusy()) return;
    var entry = openTabs[fallbackEventId];
    if (!entry) return;
    // Jeda 500 ms supaya akhir siaran benar-benar bersih sebelum siren + TTS lokasi dilanjutkan.
    setTimeout(function () {
      if (!fallbackEventId || fallbackEventId !== entry.event.eventId) return;
      if (voiceBusy() || AlarmAudio.isRunning()) return;
      AlarmAudio.tryResumeAggressive().then(function () {
        if (!fallbackEventId || fallbackEventId !== entry.event.eventId) return;
        if (voiceBusy() || AlarmAudio.isRunning()) return;
        AlarmAudio.start(audioOptsFor(entry.event));
        renderMine();
      });
    }, 500);
  }
  // ATURAN (F3): SEMUA perangkat (pengirim & penerima) boleh bicara, SATU per waktu. Setiap perangkat mencoba menjadi
  // host room; PeerServer hanya memberi ID room ke satu peer -> yang lain 'taken' (mikrofon dipakai PC lain) dan
  // menjadi penerima dengan tombol AMBIL ALIH. Host hilang (offline) -> penerima otomatis mencoba jadi host baru
  // (lihat startVoiceListen, state 'waiting'). Set false untuk aturan lama: hanya pengirim (ev.isMine).
  var VOICE_ANYONE_CAN_TALK = true;
  var pendingAutoTalk = null;   // eventId: setelah ambil alih berhasil ('ready'), langsung mulai bicara
  var nostreamToastAt = 0;      // M13: pembatas toast peringatan 'nostream' (1x / 30 dtk)

  /** Callback state host (dipakai startVoiceHost & alur ambil alih). */
  function hostStateHandler(ev) {
    return function (state, detail) {
      if (voiceEventId !== ev.eventId) return;
      $('fbVoiceRow').classList.remove('hidden');
      if (state === 'relay-switch') {
        // M0-B: jalur langsung gagal ke semua penerima, TURN RS tersedia -> host dibuat ulang relay-only.
        toast('🔁 Jalur langsung gagal. Beralih ke relay TURN RS — penerima tersambung ulang dalam beberapa detik, tetap bicara.', 8000);
        return;
      }
      if (state === 'icefailed') {
        // M0-B: retry habis untuk sebagian penerima (yang lain mendengar). Pesan sekali per 30 dtk.
        if (Date.now() - nostreamToastAt > 30000) {
          nostreamToastAt = Date.now();
          var d = detail || {};
          toast('⚠️ Suara tidak sampai ke ' + (d.gagal || '?') + ' dari ' + (d.total || '?') + ' PC — kemungkinan firewall/NAT memblokir jalur media. ' +
            (d.relayBerikutnya ? 'Siaran berikutnya otomatis lewat relay TURN RS.' : (d.turn ? 'TURN RS dikonfigurasi tetapi tidak terjangkau — cek DIAGNOSTIK → TES TURN.' : 'Butuh TURN server — hubungi IT (DIAGNOSTIK → TES TURN).')), 12000);
        }
        return;
      }
      if (state === 'nostream') {
        // M0: >= 5 detik bicara, ada penerima terdaftar, tidak satu pun menerima audio -> jalur media (WebRTC) tidak tembus.
        // Dipancarkan tiap 5 dtk (M13); toast dibatasi 1x per 30 dtk, label diperbarui setiap kali.
        if (Date.now() - nostreamToastAt > 30000) {
          nostreamToastAt = Date.now();
          toast('⚠️ Suara Anda BELUM sampai ke ' + detail + ' PC penerima. Kemungkinan firewall/NAT RS memblokir jalur media ' +
            '(butuh TURN server). Klik DIAGNOSTIK di dashboard, lalu kirim hasilnya ke IT. Sementara pakai KIRIM PENGUMUMAN (teks).', 12000);
        }
        var b = $('fbTalk');
        if (b && AlarmVoice.isTalking()) setTalkLabel(b, 'SEDANG BICARA — SUARA BELUM SAMPAI KE ' + detail + ' PC (klik untuk berhenti)');
        return;
      }
      setTalkButton(state, detail);
      if (state === 'taken' && voiceRole !== 'listen') {
        // Perangkat LAIN sudah menjadi host -> perangkat ini mendengarkan; tombol tetap tampil untuk AMBIL ALIH.
        voiceRole = 'listen';
        startVoiceListen(ev);
      } else if (state === 'released') {
        // Host ini melepas mikrofon karena perangkat lain meminta ambil alih -> jadi penerima.
        voiceRole = 'listen';
        toast('Mikrofon diambil alih oleh PC lain.', 4000);
        startVoiceListen(ev);
      } else if ((state === 'ready' || state === 'talking') && voiceRole !== 'host') {
        voiceRole = 'host';
        AlarmVoice.stopListen();
        setListenIndicator(null);
      }
      if (state === 'ready' && pendingAutoTalk === ev.eventId) {
        pendingAutoTalk = null;
        beginTalk(ev);   // ambil alih berhasil -> langsung bicara (itulah maksud klik tadi)
      }
    };
  }
  function startVoiceHost(ev) {
    // Mikrofon tidak bisa diminta di dokumen ini (diblokir / tidak ada) -> tidak bisa jadi host; tetap MENDENGAR
    // supaya suara pengirim lain terdengar di sini. Pengumuman teks tetap tersedia.
    if (!AlarmVoice.micAvailable()) { voiceRole = 'listen'; showTalkUnavailable(); startVoiceListen(ev); return; }
    voiceRole = 'host';
    AlarmVoice.hostOpen(ev.roomId, hostStateHandler(ev));
  }
  /** Mulai bicara di perangkat ini (sudah host). Siren + TTS dihentikan TOTAL lebih dulu, termasuk ucapan yang masih antre. */
  function beginTalk(ev) {
    // HENING TOTAL di PC pengirim: kunci dipasang SEBELUM mikrofon diminta (prompt izin bisa beberapa detik) ->
    // siren, TTS lokasi, dan pengumuman TTS tidak bisa mulai/lanjut sampai release('talk') di restartAlarmAudioAfterVoice().
    AlarmAudio.hold('talk');
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    renderMine();
    AlarmVoice.startTalk().then(function (ok) {
      if (!ok) { restartAlarmAudioAfterVoice(); return; }
      toast('🎤 Siap bicara. Siren & pengumuman di PC ini dimatikan; suara Anda langsung terdengar di semua PC/HP.', 5000);
    }).catch(function (err) {
      var name = err && err.name;
      if (name === 'AnnouncingError') {
        toast(err.message, 5000);   // pengumuman teks sedang diucapkan -> prioritas; coba lagi setelah selesai
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        toast(micDeniedHelp(), 10000);
        $('fbTalk').classList.add('hidden');
      } else {
        var msg = name === 'NotFoundError' ? 'mikrofon tidak ditemukan' : (err && (err.message || err.name)) || String(err);
        toast('Tidak bisa memulai siaran suara: ' + msg, 6000);
      }
      restartAlarmAudioAfterVoice();
    });
  }
  function startVoiceListen(ev) {
    AlarmVoice.listen(ev.roomId, function (state) {
      if (voiceEventId !== ev.eventId) return;
      $('fbVoiceRow').classList.remove('hidden');
      if (state === 'stream') {
        setListenIndicator('stream');
        AlarmAudio.stop();      // siren+TTS di PC ini berhenti supaya suara pengirim jelas
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
        renderMine();
        vibrateAlarm();
      } else if (state === 'end') {
        setListenIndicator('connected');
        $('fbUnlockVoice').classList.add('hidden');
        restartAlarmAudioAfterVoice();
      } else if (state === 'blocked') {
        $('fbUnlockVoice').classList.remove('hidden');
      } else if (state === 'connected') {
        setListenIndicator('connected');
      } else {   // 'waiting' (pengirim belum online) / 'error' -> coba lagi otomatis di modul
        setListenIndicator(null);
        // Host hilang (tutup browser / jaringan) -> perangkat ini mencoba menjadi host baru supaya tombol BICARA
        // tetap ada yang memegang. Jeda acak 2-5 detik: bila banyak penerima, tidak semua menyerbu bersamaan; yang
        // kalah mendapat 'taken' dan kembali menjadi penerima (aman, PeerServer memilih satu).
        if (state === 'waiting' && (ev.isMine || VOICE_ANYONE_CAN_TALK) && voiceRole === 'listen' && AlarmVoice.micAvailable()) {
          voiceRole = 'promoting';
          setTimeout(function () {
            if (voiceEventId !== ev.eventId || voiceRole !== 'promoting') return;
            startVoiceHost(ev);   // hostOpen(room) untuk room yang sama saat 'taken' = permintaan ambil alih
          }, 2000 + Math.floor(Math.random() * 3000));
        }
      }
    });
  }
  /**
   * Dipanggil dari updateFallback(): ev = event yang tampil di overlay alarm (null = tidak ada alarm).
   * Pengirim -> jadi host + tombol BICARA. Penerima -> daftar ke room pengirim + indikator mendengarkan.
   * Idempoten per event; event berganti -> sesi lama ditutup dan dibuat sesi baru.
   */
  function syncVoiceUI(ev) {
    if (!VOICE_OK) return;
    if (!ev || !ev.roomId) {
      if (voiceEventId) { AlarmVoice.destroyAll(); voiceEventId = null; voiceRole = null; }
      AlarmAudio.release('talk');   // alarm selesai/berganti saat bicara -> kunci hening dilepas
      voiceUiReset();
      return;
    }
    if (voiceEventId === ev.eventId) return;
    AlarmVoice.destroyAll();
    AlarmAudio.release('talk');
    voiceUiReset();
    voiceEventId = ev.eventId;
    pendingAutoTalk = null;
    // Semua perangkat mencoba jadi host (yang kalah otomatis jadi penerima lewat 'taken'); atau hanya pengirim
    // bila VOICE_ANYONE_CAN_TALK = false.
    if (ev.isMine || VOICE_ANYONE_CAN_TALK) startVoiceHost(ev); else startVoiceListen(ev);
  }
  // Tombol BICARA MANUAL (tampil di SEMUA perangkat). Klik pertama -> browser meminta izin mikrofon.
  //  - host & belum bicara  -> mulai bicara (siren+TTS dihentikan total lebih dulu)
  //  - host & sedang bicara -> berhenti bicara (siren+TTS dilanjutkan)
  //  - penerima (mikrofon dipegang PC lain) -> minta AMBIL ALIH; bila host lain sedang bicara -> ditolak dengan pesan
  $('fbTalk').addEventListener('click', function () {
    AlarmAudio.unlock();   // klik ini juga gesture sah untuk audio
    var entry = fallbackEventId ? openTabs[fallbackEventId] : null;
    var ev = entry ? entry.event : null;
    if (!ev || !VOICE_OK) return;
    if (!(ev.isMine || VOICE_ANYONE_CAN_TALK)) return;
    var btn = $('fbTalk');
    if (AlarmVoice.isTalking()) {
      AlarmVoice.stopTalk();
      toast('Siaran suara dihentikan. Siren + pengumuman otomatis dilanjutkan.', 4000);
      restartAlarmAudioAfterVoice();
      return;
    }
    if (btn.getAttribute('data-takeover') || voiceRole !== 'host') {
      // AMBIL ALIH: minta host saat ini melepas mikrofon; bila disetujui, jadi host (retry cepat) lalu otomatis bicara.
      setTalkLabel(btn, 'MENGAMBIL ALIH MIKROFON...');
      btn.disabled = true;
      AlarmVoice.requestTakeover().then(function (res) {
        if (voiceEventId !== ev.eventId) return;
        btn.disabled = false;
        if (res === 'ok') {
          pendingAutoTalk = ev.eventId;
          voiceRole = 'host';
          AlarmVoice.stopListen();
          setListenIndicator(null);
          setTalkButton('connecting');
          AlarmVoice.hostOpen(ev.roomId, hostStateHandler(ev), { fast: true });
        } else if (res === 'talking') {
          setTalkButton('taken');
          toast('PC lain sedang bicara. Tunggu sampai selesai, lalu klik BICARA lagi.', 5000);
        } else if (res === 'no-conn') {
          // Belum tersambung ke host mana pun (host lama hilang?) -> coba langsung jadi host.
          pendingAutoTalk = ev.eventId;
          voiceRole = 'host';
          AlarmVoice.stopListen();
          setTalkButton('connecting');
          AlarmVoice.hostOpen(ev.roomId, hostStateHandler(ev), { fast: true });
        } else {
          setTalkButton('taken');
          toast('Tidak bisa mengambil alih mikrofon (' + res + '). Coba lagi.', 5000);
        }
      });
      return;
    }
    beginTalk(ev);
  });
  // Tombol AKTIFKAN SUARA PENGIRIM (penerima; hanya bila browser memblokir autoplay audio yang masuk).
  $('fbUnlockVoice').addEventListener('click', function () {
    AlarmAudio.unlock();
    if (!VOICE_OK) return;
    AlarmVoice.resumePlayback().then(function (ok) {
      if (ok) $('fbUnlockVoice').classList.add('hidden');
      else toast('Masih diblokir browser. Ketuk sekali lagi.', 3000);
    });
  });

  // ===================== SERVER PAGING (pilih gedung tujuan) =====================
  // Daftar gedung dari sheet "Gedung" (getGedungMap, cache server 5 menit). Kosong -> hanya "Semua Gedung".
  var pagingGedungList = null;
  function loadGedungList(force) {
    if (pagingGedungList && !force) return Promise.resolve(pagingGedungList);
    return call('getGedungMap').then(function (m) {
      var out = [];
      if (m && typeof m === 'object') Object.keys(m).forEach(function (k) { out.push({ key: k, no: m[k] && m[k].no }); });
      out.sort(function (a, b) {
        var na = Number(a.no) || 999, nb = Number(b.no) || 999;
        return na !== nb ? na - nb : String(a.key).localeCompare(String(b.key));
      });
      pagingGedungList = out;
      return out;
    }).catch(function () { return pagingGedungList || []; });
  }
  function renderPagingGedungList() {
    var box = $('pagingGedungList');
    var list = pagingGedungList || [];
    var html = '<label class="all"><input type="checkbox" id="pagingAll" checked><span>📢 SEMUA GEDUNG</span></label>';
    if (!list.length) {
      html += '<div class="empty" style="padding:12px 6px;font-size:13px">Daftar gedung belum diisi di sheet <b>Gedung</b> (kolom Nama, X, Y, No). ' +
        'Sementara ini paging hanya bisa dikirim ke <b>Semua Gedung</b>. Hubungi IT untuk menambahkan data gedung.</div>';
    } else {
      list.forEach(function (g) {
        var label = (g.no ? (g.no + '. ') : '') + 'Gedung ' + g.key;
        html += '<label><input type="checkbox" class="paging-gedung" value="' + esc(g.key) + '" checked><span>' + esc(label) + '</span></label>';
      });
    }
    box.innerHTML = html;
    var all = $('pagingAll');
    var items = Array.prototype.slice.call(box.querySelectorAll('.paging-gedung'));
    all.addEventListener('change', function () { items.forEach(function (it) { it.checked = all.checked; }); all.indeterminate = false; });
    items.forEach(function (it) {
      it.addEventListener('change', function () {
        var checked = items.filter(function (x) { return x.checked; }).length;
        all.checked = checked === items.length;
        all.indeterminate = checked > 0 && checked < items.length;
      });
    });
  }
  function openPagingModal() {
    var m = $('modalPaging');
    if (!m) return;
    var sel = $('pagingKode');
    // Jenis paging: PAGING (default) + code aktif lain, supaya code apa pun bisa dibatasi ke gedung tertentu.
    var opts = '<option value="PAGING">📢 Paging (umum)</option>';
    jenisList.forEach(function (j) { if (j.aktif && j.kode !== 'PAGING') opts += '<option value="' + esc(j.kode) + '">' + esc(j.nama) + ' — hanya gedung terpilih</option>'; });
    sel.innerHTML = opts;
    $('pagingHint').textContent = 'Memuat daftar gedung...';
    $('pagingGedungList').innerHTML = '<div class="empty"><span class="spinner"></span>Memuat daftar gedung...</div>';
    m.classList.remove('hidden');
    loadGedungList(true).then(function () {
      renderPagingGedungList();
      $('pagingHint').textContent = pagingGedungList.length
        ? (pagingGedungList.length + ' gedung terdaftar. Alarm dibunyikan hanya di PC/HP yang gedungnya dicentang; PC lain tetap melihatnya di daftar "Sedang Berlangsung".')
        : 'Belum ada data gedung. Paging akan dikirim ke SEMUA PC/HP.';
    });
  }
  $('btnPaging').addEventListener('click', function () { AlarmAudio.unlock(); openPagingModal(); });
  $('pagingCancel').addEventListener('click', function () { $('modalPaging').classList.add('hidden'); });
  $('pagingSend').addEventListener('click', function () {
    var kode = $('pagingKode').value || 'PAGING';
    var box = $('pagingGedungList');
    var all = $('pagingAll');
    var target = [];
    if (all && !all.checked) {
      Array.prototype.forEach.call(box.querySelectorAll('.paging-gedung:checked'), function (it) { target.push(it.value); });
      if (!target.length) { toast('Pilih minimal satu gedung, atau centang "Semua Gedung".', 5000); return; }
    }
    var existing = activeEvents.filter(function (e) { return e.isMine && e.kodeCode === kode; })[0];
    if (existing) { toast('Paging ' + kode + ' dari instalasi ini masih berlangsung sejak ' + fmtTime(existing.mulai) + '. Hentikan dulu sebelum mengirim lagi.', 6000); return; }
    var btn = $('pagingSend');
    AlarmAudio.unlock();
    setBusy(btn, 'Mengirim paging...');
    call('createPagingEvent', session.token, kode, target).then(function (res) {
      clearBusy(btn);
      if (!res.ok) { toast(res.error || 'Gagal mengirim paging.', 6000); return; }
      $('modalPaging').classList.add('hidden');
      toast('Paging terkirim ' + (target.length ? 'ke: ' + target.join(', ') : 'ke SEMUA GEDUNG') + '.', 5000);
      if (res.event.isMine && eventForThisPc_(res.event)) startDashboardAudio(res.event);
      applyActiveEvents(mergeEvent(activeEvents, res.event));
    }).catch(function (err) {
      clearBusy(btn);
      if (isSessionError(err)) return sessionExpired();
      toast('Gagal mengirim paging: ' + friendlyError(err), 7000);
    });
  });

  // ===================== BARU (M0): DIAGNOSTIK =====================
  // Modal berisi snapshot lengkap (koneksi, audio, voice/WebRTC, server ICE) + SELF TEST (loopback PeerJS) + TES TURN
  // (kandidat relay dari jaringan PC ini) + SALIN untuk dikirim ke IT. Tidak menampilkan kredensial TURN.
  var diagLast = null;
  var autoIceResult = null;   // M8: hasil cek jalur WebRTC otomatis setelah login (sekali per pemuatan halaman)
  /** M8: cek TURN/ICE otomatis 3 dtk setelah dashboard tampil. Tidak mengganggu perawat: hanya menandai tombol DIAGNOSTIK
   *  (oranye = tanpa relay) supaya IT melihatnya saat berkeliling; detail ada di modal. */
  function autoIceCheck() {
    if (!VOICE_OK || autoIceResult) return;
    setTimeout(function () {
      if (!session.token) return;
      AlarmVoice.iceTest(6000).then(function (r) {
        autoIceResult = { waktu: new Date().toString(), relayOk: r.relayOk, hasTurnConfigured: r.hasTurnConfigured, verdict: r.verdict, types: r.all.types };
        var b = $('btnDiag');
        if (b) {
          b.classList.toggle('warn', !r.relayOk);
          b.title = r.relayOk ? 'Jalur suara BICARA MANUAL: OK (relay tersedia)' : 'Jalur suara BICARA MANUAL: TANPA RELAY — ' + r.verdict;
        }
      }).catch(function () {});
    }, 3000);
  }
  /** M7: panduan langkah berikutnya di modal, berdasarkan hasil uji terakhir. */
  function diagHint(snap) {
    var el = $('diagHint'); if (!el) return;
    var ice = (snap.hasil && snap.hasil.iceTest) || snap.cekOtomatis || null;
    var st = (snap.hasil && snap.hasil.selfTest) || null;
    var lines = [];
    if (!VOICE_OK) lines.push('❌ PeerJS tidak termuat: CDN unpkg/jsdelivr dan salinan lokal js/peerjs.min.js gagal dimuat. Cek firewall/proxy RS untuk domain tersebut.');
    if (st && !st.ok) lines.push('❌ SELF TEST gagal: ' + (st.error || '-') + '. Bila timeout tanpa langkah = WebSocket ke 0.peerjs.com (signaling) diblokir → izinkan wss://0.peerjs.com:443 di firewall.');
    if (ice) {
      if (ice.forceRelay) lines.push('🔁 Sakelar relay otomatis AKTIF di tab ini (panggilan langsung pernah gagal): semua siaran lewat TURN. Reset: tutup tab, atau di Console: AlarmVoice.setForceRelay(false).');
      if (ice.relayOk) lines.push('✅ TURN/relay tersedia: BICARA MANUAL seharusnya tembus antar-subnet. Bila masih tidak terdengar, cek mikrofon pengirim (Windows: Sound > Recording) dan tombol AKTIFKAN SUARA PENGIRIM di penerima.');
      else if (ice.hasTurnConfigured) lines.push('⚠️ TURN RS sudah dikonfigurasi tetapi tidak memberi kandidat relay: kredensial salah/kedaluwarsa, atau port 443 TCP/TLS ke server TURN diblokir. Cek CONFIG.ICE_SERVERS di Code.gs dan deploy "New version".');
      else lines.push('⚠️ Belum ada TURN RS. Suara hanya sampai bila PC pengirim & penerima satu subnet tanpa client-isolation. LANGKAH IT: daftar TURN (metered.ca gratis 20 GB/bln, atau coturn internal di port 443), isi CONFIG.ICE_SERVERS di Code.gs, Deploy > New version, lalu ulangi TES TURN di sini sampai "✅".');
    } else lines.push('ℹ️ Klik TES TURN / ICE untuk memastikan jalur media WebRTC dari jaringan PC ini.');
    el.textContent = lines.join('\n');
    el.classList.remove('hidden');
  }
  function diagSnapshot(extra) {
    var snap = {
      waktu: new Date().toString(),
      halaman: location.href,
      browser: navigator.userAgent,
      online: navigator.onLine,
      sesi: session.user ? { instalasi: session.user.namaInstalasi, gedung: session.user.gedung, akun: session.user.username } : null,
      koneksiServer: $('pollText').textContent,
      pcOnline: $('onlineCount').textContent || null,
      eventAktif: activeEvents.map(function (e) { return { id: e.eventId, code: e.kodeCode, dari: e.namaInstalasi, mine: e.isMine, room: e.roomId ? 'ada' : 'tidak' }; }),
      audio: { unlocked: AlarmAudio.isUnlocked(), running: AlarmAudio.isRunning(), announcing: AlarmAudio.isAnnouncing(), speechSynthesis: !!window.speechSynthesis },
      mikrofon: VOICE_OK ? AlarmVoice.micPermissionState() : 'voice-off',
      voice: VOICE_OK ? AlarmVoice.debugInfo() : { available: false, catatan: 'PeerJS tidak termuat (CDN diblokir?)' },
      appsScriptUrl: (typeof api !== 'undefined' && api.url) ? api.url() : 'apps-script',
      pollMs: APP_CONFIG.pollDashboardMs,
      cekOtomatis: autoIceResult
    };
    if (extra) Object.keys(extra).forEach(function (k) { snap[k] = extra[k]; });
    return snap;
  }
  function diagRender(obj) {
    diagLast = obj;
    $('diagOut').textContent = JSON.stringify(obj, null, 2);
    diagHint(obj);
  }
  function openDiag() {
    $('modalDiag').classList.remove('hidden');
    diagRender(diagSnapshot());
  }
  $('btnDiag').addEventListener('click', openDiag);
  $('diagClose').addEventListener('click', function () { $('modalDiag').classList.add('hidden'); });
  $('diagRefresh').addEventListener('click', function () { diagRender(diagSnapshot(diagLast && diagLast.hasil ? { hasil: diagLast.hasil } : null)); });
  $('diagSelfTest').addEventListener('click', function () {
    var b = $('diagSelfTest');
    if (!VOICE_OK) { toast('PeerJS tidak termuat — CDN unpkg/jsdelivr diblokir?', 6000); return; }
    setBusy(b, 'Self test...');
    AlarmVoice.selfTest(20000).then(function (r) {
      clearBusy(b);
      var hasil = (diagLast && diagLast.hasil) || {};
      hasil.selfTest = r;
      diagRender(diagSnapshot({ hasil: hasil }));
      toast(r.ok ? '✅ Self test OK: signaling PeerJS + jalur media di PC ini berfungsi.' : '❌ Self test gagal: ' + (r.error || 'lihat langkah'), 8000);
    });
  });
  $('diagIce').addEventListener('click', function () {
    var b = $('diagIce');
    if (!VOICE_OK) { toast('PeerJS tidak termuat — CDN unpkg/jsdelivr diblokir?', 6000); return; }
    setBusy(b, 'Menguji ICE/TURN...');
    AlarmVoice.iceTest(8000).then(function (r) {
      clearBusy(b);
      var hasil = (diagLast && diagLast.hasil) || {};
      hasil.iceTest = r;
      diagRender(diagSnapshot({ hasil: hasil }));
      toast((r.relayOk ? '✅ ' : '⚠️ ') + r.verdict, 12000);
    }).catch(function (e) { clearBusy(b); toast('Uji ICE gagal: ' + (e && e.message || e), 6000); });
  });
  $('diagCopy').addEventListener('click', function () {
    var txt = $('diagOut').textContent;
    var done = function (ok) { toast(ok ? 'Hasil diagnostik disalin. Tempel ke WhatsApp/email untuk IT.' : 'Gagal menyalin otomatis — blok teks lalu Ctrl+C.', 5000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(false); });
    else {
      try { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); done(ok); } catch (e) { done(false); }
    }
  });

  // ===================== PENGUMUMAN TEKS (fallback tanpa mikrofon) =====================
  // Pengirim mengetik teks -> server (sendAnnouncement, divalidasi: hanya instalasi pengirim, event aktif) ->
  // semua penerima menerimanya lewat polling yang SUDAH ADA (ev.announcement) -> ditampilkan di panel alarm +
  // diucapkan TTS lewat AlarmAudio.announce() (siren dijeda sebentar, lalu dilanjutkan otomatis).
  // Bekerja di dalam iframe Apps Script karena tidak butuh mikrofon. Pengirim juga mendengarnya (konfirmasi).
  // announceSeen PERSISTEN per tab (sessionStorage via ssGet/ssSet): reload halaman tidak mengulang TTS pengumuman
  // yang masih tersimpan di CacheService (TTL 5 menit). announceToasted hanya di memori (teks/toast boleh tampil lagi).
  var SS_ANNOUNCE_SEEN = 'cb_announce_seen';
  function loadAnnounceSeen() { try { var raw = ssGet(SS_ANNOUNCE_SEEN); return raw ? (JSON.parse(raw) || {}) : {}; } catch (e) { return {}; } }
  function saveAnnounceSeen() { try { ssSet(SS_ANNOUNCE_SEEN, JSON.stringify(announceSeen)); } catch (e) {} }
  var announceSeen = loadAnnounceSeen();   // eventId -> id pengumuman terakhir yang BENAR-BENAR sudah diucapkan di PC ini
  var announceToasted = {};                 // eventId -> id pengumuman yang sudah ditampilkan (toast) — memori saja
  var announceEventId = null;               // event yang sedang dituju modal pengumuman
  var announceChain = Promise.resolve();    // pengumuman dari beberapa event diucapkan BERURUTAN, tidak saling memotong
  // BARU (pengumuman berulang): pengumuman aktif DIULANG tiap 25 detik di semua PC/HP sampai pengirim menekan
  // HENTIKAN PENGUMUMAN (server menghapus cache -> ev.announcement null) atau event Selesai.
  var ANNOUNCE_REPEAT_MS = 25000;
  var announceLastPlayedAt = {};            // eventId -> timestamp terakhir pengumuman dijadwalkan diucapkan (memori)
  function clearAnnounceState(eventId) {
    delete announceSeen[eventId];
    delete announceToasted[eventId];
    delete announceLastPlayedAt[eventId];
    saveAnnounceSeen();
  }
  /** Pengumuman terkini untuk event (dari activeEvents), dipakai antrean untuk membatalkan pengumuman yang sudah dihentikan/berganti. */
  function currentAnnouncementFor(eventId) {
    for (var i = 0; i < activeEvents.length; i++) if (activeEvents[i].eventId === eventId) return activeEvents[i].announcement || null;
    return null;
  }

  function announceTts(ann) {
    return String(APP_CONFIG.announceTemplate || 'Pengumuman dari {instalasi}. {text}.')
      .replace(/\{instalasi\}/g, ann.oleh || '').replace(/\{text\}/g, ann.text || '');
  }
  function announceModalOpen() {
    var m = $('modalAnnounce');
    return !!m && !m.classList.contains('hidden');
  }
  /**
   * Dipanggil dari applyActiveEvents() (tiap polling <= 4 detik). Untuk setiap event aktif:
   *  - pengumuman BARU (id belum pernah diucapkan)  -> ucapkan sekarang, catat announceLastPlayedAt;
   *  - pengumuman SAMA & masih aktif                 -> ulangi bila sudah >= ANNOUNCE_REPEAT_MS sejak terakhir;
   *  - tidak ada pengumuman / ann.active === false  -> bersihkan state, sembunyikan teks, JANGAN ucapkan.
   * PRIORITAS: bila suara live (bicara/menerima) sedang berjalan, TTS ditunda (tidak dicatat) -> dicoba lagi polling
   * berikutnya. Semua ucapan lewat announceChain supaya pengumuman antar-event tidak saling memotong.
   */
  function handleAnnouncements(list) {
    var activeIds = {};
    var now = Date.now();
    list.forEach(function (ev) {
      activeIds[ev.eventId] = true;
      var ann = ev.announcement;
      if (!ann || !ann.id || ann.active === false) {
        // Dihentikan pengirim / tidak ada -> bersihkan supaya pengumuman berikutnya (id baru) diproses dari awal.
        if (announceSeen[ev.eventId] || announceToasted[ev.eventId] || announceLastPlayedAt[ev.eventId]) clearAnnounceState(ev.eventId);
        if (fallbackEventId === ev.eventId) { renderAnnounceText(ev); syncAnnounceUI(ev); }
        return;
      }
      if (announceToasted[ev.eventId] !== ann.id) {
        announceToasted[ev.eventId] = ann.id;
        toast('📢 ' + ann.oleh + ': ' + ann.text, 8000);
        vibrateAlarm();
        if (fallbackEventId === ev.eventId) { renderAnnounceText(ev); syncAnnounceUI(ev); }
      }
      var isNew = announceSeen[ev.eventId] !== ann.id;
      var last = announceLastPlayedAt[ev.eventId] || 0;
      if (!isNew && (now - last) < ANNOUNCE_REPEAT_MS) return;   // belum 25 detik -> skip
      if (voiceBusy()) return;                                    // ditunda: jangan catat, coba lagi polling berikutnya
      announceSeen[ev.eventId] = ann.id;
      saveAnnounceSeen();
      announceLastPlayedAt[ev.eventId] = now;
      var text = announceTts(ann);
      var annId = ann.id;
      announceChain = announceChain.then(function () {
        // Saat giliran tiba: batal bila event sudah tidak aktif, pengumuman sudah dihentikan/berganti, atau suara live berjalan.
        var cur = currentAnnouncementFor(ev.eventId);
        if (!cur || cur.id !== annId || cur.active === false || voiceBusy()) return false;
        return AlarmAudio.announce(text, APP_CONFIG.ttsLang, APP_CONFIG.ttsRate);
      }).catch(function () { return false; });
    });
    var changed = false;
    Object.keys(announceSeen).forEach(function (id) { if (!activeIds[id]) { delete announceSeen[id]; changed = true; } });
    Object.keys(announceToasted).forEach(function (id) { if (!activeIds[id]) delete announceToasted[id]; });
    Object.keys(announceLastPlayedAt).forEach(function (id) { if (!activeIds[id]) delete announceLastPlayedAt[id]; });
    if (changed) saveAnnounceSeen();
  }
  // Setelah sebuah pengumuman selesai diucapkan -> refresh UI overlay (indikator, tombol) & pastikan siren lanjut.
  AlarmAudio.onAnnouncementEnd(function () {
    if (fallbackEventId) { updateFallback(); renderMine(); }
  });
  function renderAnnounceText(ev) {
    var el = $('fbAnnounceText');
    var ann = ev && ev.announcement;
    if (!ann || !ann.text || ann.active === false) { el.classList.add('hidden'); return; }
    el.textContent = '📢 ' + (ann.oleh || 'Pengirim') + ' (' + fmtTime(ann.ts).slice(6) + '): ' + ann.text +
      ' · diulang tiap ' + Math.round(ANNOUNCE_REPEAT_MS / 1000) + ' dtk sampai dihentikan pengirim';
    el.classList.remove('hidden');
  }
  function announcementActive(ev) {
    var ann = ev && ev.announcement;
    return !!(ann && ann.id && ann.active !== false);
  }
  /** Dipanggil dari updateFallback(): tombol KIRIM/HENTIKAN PENGUMUMAN hanya untuk pengirim; teks terakhir untuk semua. */
  function syncAnnounceUI(ev) {
    var btn = $('fbAnnounce');
    var stopBtn = $('fbStopAnnounce');
    if (!ev) { btn.classList.add('hidden'); stopBtn.classList.add('hidden'); renderAnnounceText(null); return; }
    btn.classList.toggle('hidden', !ev.isMine);
    stopBtn.classList.toggle('hidden', !(ev.isMine && announcementActive(ev)));
    if (ev.isMine) $('fbVoiceRow').classList.remove('hidden');
    renderAnnounceText(ev);
  }
  // Tombol HENTIKAN PENGUMUMAN (hanya pengirim): server menghapus pengumuman -> semua PC/HP berhenti mengulang
  // pada polling berikutnya (<= 4 detik). Ucapan yang sedang berjalan dibiarkan selesai (tidak dipotong).
  $('fbStopAnnounce').addEventListener('click', function () {
    var entry = fallbackEventId ? openTabs[fallbackEventId] : null;
    var ev = entry ? entry.event : null;
    if (!ev || !ev.isMine) return;
    var eventId = ev.eventId;
    var b = $('fbStopAnnounce');
    b.disabled = true; b.textContent = 'Menghentikan...';
    call('stopAnnouncement', session.token, eventId).then(function (res) {
      b.disabled = false; b.textContent = '🛑 HENTIKAN PENGUMUMAN';
      if (!res.ok) { toast(res.error || 'Gagal menghentikan pengumuman.', 6000); return; }
      // Bersihkan state lokal & event lokal sekarang (tanpa menunggu polling).
      clearAnnounceState(eventId);
      activeEvents.forEach(function (e) { if (e.eventId === eventId) e.announcement = null; });
      if (entry) entry.event.announcement = null;
      renderAnnounceText(null);
      syncAnnounceUI(entry ? entry.event : null);
      toast('Pengumuman dihentikan. Semua PC/HP berhenti mengulang dalam beberapa detik.', 4000);
    }).catch(function (err) {
      b.disabled = false; b.textContent = '🛑 HENTIKAN PENGUMUMAN';
      if (isSessionError(err)) return sessionExpired();
      toast('Gagal menghentikan pengumuman: ' + friendlyError(err), 6000);
    });
  });
  function openAnnounceModal(ev) {
    announceEventId = ev.eventId;
    // Jeda siren+TTS di PC ini supaya pengirim bisa fokus mengetik (dilanjutkan saat modal ditutup).
    // Tidak dilakukan bila pengumuman lain sedang diucapkan (biar selesai) atau suara live berjalan.
    if (!AlarmAudio.isAnnouncing() && !voiceBusy()) { AlarmAudio.stop(); renderMine(); }
    var ta = $('annText');
    ta.value = '';
    ta.maxLength = Number(APP_CONFIG.announceMaxLen) || 200;
    $('annMax').textContent = String(ta.maxLength);
    $('annCount').textContent = '0';
    $('annSend').disabled = false; $('annSend').textContent = 'KIRIM & UCAPKAN';
    $('modalAnnounce').classList.remove('hidden');
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 50);
  }
  $('fbAnnounce').addEventListener('click', function () {
    AlarmAudio.unlock();
    var entry = fallbackEventId ? openTabs[fallbackEventId] : null;
    var ev = entry ? entry.event : null;
    if (!ev || !ev.isMine) return;
    openAnnounceModal(ev);
  });
  /** Tutup modal pengumuman & lanjutkan siren+TTS bila alarm masih tampil dan tidak ada suara live/pengumuman. */
  function closeAnnounceModal_() {
    $('modalAnnounce').classList.add('hidden');
    announceEventId = null;
    restartAlarmAudioAfterVoice();   // sudah memeriksa voiceBusy()/isRunning() (isRunning true selama pengumuman)
  }
  $('annText').addEventListener('input', function () { $('annCount').textContent = String(this.value.length); });
  $('annCancel').addEventListener('click', closeAnnounceModal_);
  $('annSend').addEventListener('click', function () {
    var eventId = announceEventId;
    if (!eventId) return;
    var text = $('annText').value.replace(/\s+/g, ' ').trim();
    if (!text) { toast('Ketik teks pengumuman dulu.'); return; }
    var btn = $('annSend');
    setBusy(btn, 'Mengirim...');
    call('sendAnnouncement', session.token, eventId, text).then(function (res) {
      clearBusy(btn);
      if (!res.ok) { toast(res.error || 'Gagal mengirim pengumuman.', 6000); return; }
      $('modalAnnounce').classList.add('hidden');
      announceEventId = null;
      // Siren TIDAK dilanjutkan di sini: handleAnnouncements() di bawah langsung mengucapkan pengumuman ini
      // (AlarmAudio.announce melanjutkan loop siren otomatis setelahnya lewat opsi terakhir / onAnnouncementEnd).
      // Perbarui event lokal supaya teks langsung tampil & diucapkan di PC ini juga (konfirmasi), tanpa menunggu polling.
      var ann = res.announcement;
      activeEvents.forEach(function (e) { if (e.eventId === eventId) e.announcement = ann; });
      var entry = openTabs[eventId];
      if (entry) entry.event.announcement = ann;
      handleAnnouncements(activeEvents);
      if (fallbackEventId === eventId) { renderAnnounceText(entry ? entry.event : null); syncAnnounceUI(entry ? entry.event : null); }
      toast('Pengumuman terkirim. Diulang tiap ' + Math.round(ANNOUNCE_REPEAT_MS / 1000) + ' detik di semua PC/HP sampai Anda menekan HENTIKAN PENGUMUMAN.', 5000);
    }).catch(function (err) {
      clearBusy(btn);
      if (isSessionError(err)) return sessionExpired();
      toast('Gagal mengirim pengumuman: ' + friendlyError(err), 6000);
    });
  });

  // ===================== RENDER =====================
  function renderMine() {
    var mine = activeEvents.filter(function (e) { return e.isMine; });
    var box = $('mineBanners');
    if (!mine.length) { box.innerHTML = ''; return; }
    box.innerHTML = mine.map(function (ev) {
      var audioHere = dashAudioEventId === ev.eventId && AlarmAudio.isRunning();
      var talking = VOICE_OK && voiceEventId === ev.eventId && AlarmVoice.isTalking();
      var audioInd = talking ? '&#127908; siaran suara manual aktif (siren dijeda)' :
                     audioHere ? '&#128266; suara aktif di PC ini' : '&#128263; suara dari tab alarm';
      var tgtChip = (ev.targetGedung && ev.targetGedung.length) ? ' <span class="target-chip">📢 ' + esc(ev.targetGedung.join(', ')) + '</span>' : '';
      return '<div class="banner-mine" style="background:' + esc(ev.warna) + '" data-id="' + esc(ev.eventId) + '">' +
        '<div><div class="t1">' + esc(ev.namaCode.toUpperCase()) + ' SEDANG BERLANGSUNG' + tgtChip + '</div>' +
        '<div class="t2">Dikirim dari ' + esc(ev.namaInstalasi) + ', ' + esc(ev.gedung) + ' sejak ' + fmtTime(ev.mulai) +
        ' &middot; <span class="elapsed" data-mulai="' + esc(ev.mulai) + '">' + fmtElapsed(ev.mulai) + '</span>' +
        // BARU: indikator 🔊 (suara dari dashboard ini) / 🔇 (dashboard senyap; suara dari tab alarm)
        ' &middot; <span class="audio-ind">' + audioInd + '</span></div></div>' +
        '<button type="button" class="btn-stop" data-stop="' + esc(ev.eventId) + '">HENTIKAN ALARM</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-stop]'), function (b) {
      b.addEventListener('click', function () {
        if (confirm('Hentikan alarm ini di semua PC?')) stopAlarm(b.getAttribute('data-stop'), b);
      });
    });
  }

  function renderOthers() {
    var others = activeEvents.filter(function (e) { return !e.isMine; });
    var box = $('othersList');
    if (!others.length) { box.innerHTML = '<div class="empty">Tidak ada.</div>'; return; }
    box.innerHTML = others.map(function (ev) {
      var tgt = (ev.targetGedung && ev.targetGedung.length)
        ? '<span class="target-chip" title="Paging terbatas">📢 ' + esc(ev.targetGedung.join(', ')) + (eventForThisPc_(ev) ? '' : ' · bukan gedung ini') + '</span>' : '';
      return '<div class="other-item" style="border-left-color:' + esc(ev.warna) + '">' +
        '<span class="chip" style="background:' + esc(ev.warna) + '">' + esc(ev.namaCode) + '</span>' +
        '<span class="nm">' + esc(ev.namaInstalasi) + '</span><span class="loc">' + esc(ev.gedung) + '</span>' + tgt +
        '<span class="since">sejak ' + fmtTime(ev.mulai) + ' &middot; <span class="elapsed" data-mulai="' + esc(ev.mulai) + '">' + fmtElapsed(ev.mulai) + '</span></span>' +
        '</div>';
    }).join('');
  }

  var tickCount = 0;
  function renderTick() {
    Array.prototype.forEach.call(document.querySelectorAll('.elapsed[data-mulai]'), function (el) {
      var next = fmtElapsed(Number(el.getAttribute('data-mulai')));
      if (el.textContent !== next) {
        el.textContent = next;
        el.classList.remove('flash');
        void el.offsetWidth;   // reflow supaya animasi kedip halus terpicu ulang
        el.classList.add('flash');
      }
    });
    heartbeatAudioOwner();
    tickCount++;
    // BARU (M15): jam real-time di topbar (WIB = zona waktu PC; PC nurse station diatur Asia/Jakarta).
    var ck = $('clock');
    if (ck) { var d = new Date(); var p2 = function (n) { return (n < 10 ? '0' : '') + n; }; ck.textContent = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + ' WIB'; }
    updateAudioBtn();
    // PERBAIKAN: setiap 30 detik, coba resume AudioContext TANPA gesture. Di Chrome dengan Media
    // Engagement Index (MEI) cukup tinggi (PC nurse station yang membuka dashboard ini 24/7), ini
    // membantu browser "percaya" situs ini ingin memutar audio, sehingga alarm berikutnya makin
    // mungkin berbunyi otomatis tanpa klik.
    if (tickCount % 30 === 0) {
      try { AlarmAudio.tryResumeAggressive(); } catch (e) {}
      // BARU (HP): tone 20 Hz, 50 ms, volume 0.0001 (tak terdengar) untuk menjaga AudioContext tetap 'running'.
      // Chrome Android kadang men-suspend AudioContext setelah idle beberapa menit walau halaman aktif;
      // heartbeat ini mencegahnya sehingga alarm berikutnya berbunyi otomatis tanpa ketuk layar.
      try { AlarmAudio.keepAlive(); } catch (e) {}
      // Pengaman: Wake Lock bisa dilepas OS/browser sewaktu-waktu -> minta ulang bila masih dibutuhkan.
      if (wakeLockWanted && !wakeLock) requestWakeLock();
    }
    // BARU (HP): selama overlay alarm aktif, getarkan tiap 3 detik dan perbarui ajakan ketuk layar.
    if (fallbackEventId) {
      if (tickCount % 3 === 0) vibrateAlarm();
      updateTapHint();
    }
  }

  var logLoadedOnce = false;
  function loadLog() {
    if (!session.token) return Promise.resolve();
    return call('getRecentEvents', session.token, 15).then(function (res) {
      var tb = $('logBody');
      logLoadedOnce = true;
      if (!res.ok || !res.events.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">Belum ada riwayat.</td></tr>'; return; }
      tb.innerHTML = res.events.map(function (ev) {
        return '<tr data-event-id="' + esc(ev.eventId) + '"><td>' + fmtTime(ev.mulai) + '</td>' +
          '<td><span class="chip" style="background:' + esc(ev.warna) + '">' + esc(ev.namaCode) + '</span></td>' +
          '<td>' + esc(ev.namaInstalasi) + ' &middot; ' + esc(ev.gedung) + '</td>' +
          '<td>' + esc(ev.status) + '</td><td>' + fmtTime(ev.selesai) + '</td><td>' + esc(ev.dihentikanOleh || '-') + '</td></tr>';
      }).join('');
    }).catch(function (err) {
      // BARU (M8): tidak lagi stuck "Memuat..." tanpa keterangan; riwayat lama (bila ada) tetap ditampilkan.
      if (isSessionError(err)) return sessionExpired();
      if (logLoadedOnce) return;
      $('logBody').innerHTML = '<tr><td colspan="6" class="empty">Gagal memuat riwayat: ' + esc(friendlyError(err)) +
        ' <button type="button" class="btn-small" id="logRetry">🔄 COBA LAGI</button></td></tr>';
      var b = $('logRetry');
      if (b) b.addEventListener('click', function () { setBusy(b, 'Memuat...'); loadLog(); });
    });
  }

  // Peringatan bila tab utama akan ditutup/refresh.
  window.addEventListener('beforeunload', function (e) {
    // Dashboard akan hilang -> lepaskan penanda audio owner supaya tab alarm di PC ini mengambil alih suara,
    // dan reset state supaya updateFallback() tidak lagi menganggap audio dashboard aktif.
    if (dashAudioEventId) { lsDel(LS_AUDIO_OWNER); dashAudioEventId = null; }
    if (session.token) { e.preventDefault(); e.returnValue = ''; }
  });

  // ===================== INIT (urutan penting) =====================
  // 1. Banner cookie dulu (bila belum accepted) -> klik "Accept All Cookies" = master gesture: unlock audio
  //    (AudioContext + speechSynthesis) untuk seluruh lifetime halaman.
  // 2. Restore sesi dari localStorage (auto-login tanpa klik bila token masih valid).
  initCookieBanner();
  // GITHUB PAGES: ambil konfigurasi dari server (CONFIG di Code.gs tetap satu sumber kebenaran) dan timpa default
  // di js/config.js. Tidak menunggu hasilnya: login/restore sesi berjalan paralel. Bila server tidak bisa dihubungi,
  // checkServer() menampilkan banner merah + COBA LAGI (M4/M8/M9).
  checkServer();
  restoreSession();
  updateAudioBtn();
})();