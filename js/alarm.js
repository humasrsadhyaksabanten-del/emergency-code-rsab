// ===================== HALAMAN ALARM (mode TAB, legacy) - versi GitHub Pages =====================
// Di Apps Script, EVENT_ID / TOKEN / DASH_AUDIO / INITIAL disuntikkan server lewat template. Di GitHub Pages
// semuanya dibaca dari query string (alarm.html?eventId=...&t=...&da=1) dan status awal diambil lewat api.js,
// lalu logika halaman (fungsi startAlarmPage) dijalankan - isinya identik dengan Alarm.html.
var _qs = new URLSearchParams(location.search);
var EVENT_ID = _qs.get('eventId') || '';
var TOKEN = _qs.get('t') || '';
var DASH_AUDIO = _qs.get('da') === '1';
var INITIAL = null;

(function bootstrapAlarmPage() {
  var valid = /^EV-\d{8}-\d{6}-[A-Z0-9]{8}$/.test(EVENT_ID);
  var p = valid ? api.call('getEventStatus', EVENT_ID, TOKEN) : Promise.resolve({ ok: false, error: 'Format eventId tidak valid.' });
  var cfg = api.call('getClientConfig').then(function (c) {
    if (c && typeof c === 'object') Object.keys(c).forEach(function (k) { APP_CONFIG[k] = c[k]; });
  }).catch(function () {});
  Promise.all([p.catch(function (err) { return { ok: false, error: String(err && err.message || err) }; }), cfg]).then(function (r) {
    INITIAL = r[0];
    if (INITIAL && INITIAL.ok && INITIAL.event) document.title = 'ALARM ' + INITIAL.event.namaCode + ' - ' + INITIAL.event.namaInstalasi;
    startAlarmPage();
  });
})();

function startAlarmPage() {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var ev = null;
    var finished = false;
    var audioStarted = false;
    var silentByDashboard = false;   // true = audio event ini sedang diputar dari dashboard pengirim di PC yang sama
    var pollTimer = null, pollBusy = false, failCount = 0;
    var sirenSrc = '';
    var unlockAttempts = 0;
    var lastRenderKey = '';

    // Penanda dari Script.html (dashboard): localStorage 'cb_audio_owner' = { eventId, ts, ended }.
    // Dashboard memperbarui ts tiap 1 detik selama audionya berbunyi; dianggap basi setelah 4 detik
    // (supaya bila dashboard crash tanpa beforeunload, tab ini cepat mengambil alih suara).
    var LS_AUDIO_OWNER = 'cb_audio_owner';
    var AUDIO_OWNER_TTL_MS = 4000;
    var TAKEOVER_GRACE_MS = 3000;   // masa tenggang sejak tab dimuat sebelum boleh mengambil alih
    var loadedAt = Date.now();
    function writeAudioOwnerEnded() {
      if (!STORAGE_OK || !ev || !ev.isMine) return;
      try { localStorage.setItem(LS_AUDIO_OWNER, JSON.stringify({ eventId: EVENT_ID, ts: Date.now(), ended: true })); } catch (e) {}
    }
    // localStorage bisa diblokir di iframe Apps Script; bila tidak tersedia, mode senyap hanya mengandalkan DASH_AUDIO (URL).
    var STORAGE_OK = (function () { try { localStorage.setItem('__cb_probe__', '1'); localStorage.removeItem('__cb_probe__'); return true; } catch (e) { return false; } })();
    function readAudioOwner() {
      if (!STORAGE_OK) return null;
      try {
        var raw = localStorage.getItem(LS_AUDIO_OWNER);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (!o || o.eventId !== EVENT_ID) return null;
        if (typeof o.ts !== 'number' || !isFinite(o.ts)) return null;   // penanda rusak -> abaikan
        return o;
      } catch (e) { return null; }
    }
    /** true bila dashboard di PC ini sedang (masih) memutar audio untuk event ini (heartbeat < 8 detik). */
    function dashboardOwnsAudio() {
      var o = readAudioOwner();
      return !!(o && !o.ended && (Date.now() - o.ts) < AUDIO_OWNER_TTL_MS);
    }
    /** true bila dashboard sudah menandai event ini Selesai (jangan ambil alih audio; tunggu polling menutup tab). */
    function dashboardMarkedEnded() {
      var o = readAudioOwner();
      return !!(o && o.ended);
    }
    /** Mode senyap awal: dari URL (da=1, tahan terhadap storage diblokir) ATAU dari penanda localStorage. */
    function dashboardInitiallyOwnsAudio() {
      return DASH_AUDIO || dashboardOwnsAudio();
    }

    // GITHUB PAGES: pengganti google.script.run -> fetch() ke Apps Script lewat api.js.
    function call(fn) {
      return api.call.apply(null, arguments);
    }
    function fmtTime(ms) {
      if (!ms) return '-';
      var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function fmtElapsed(ms) {
      var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      var m = Math.floor(s / 60), h = Math.floor(m / 60); s %= 60; m %= 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return (h ? h + ':' : '') + p(m) + ':' + p(s);
    }

         /** Pilih warna teks gelap/terang otomatis berdasarkan terangnya warna latar (mis. Code White = putih). */
    function contrastTextColor_(hex) {
      var h = String(hex || '').replace('#', '');
      if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6) return '#fff';
      var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
      var yiq = (r * 299 + g * 587 + b * 114) / 1000;
      return yiq >= 160 ? '#111' : '#fff';
    }

    function render() {
      if (!ev) return;
      var panelText = $('panelText');
      panelText.style.background = ev.warna;
      panelText.classList.toggle('light-bg', contrastTextColor_(ev.warna) === '#111');
      document.title = 'ALARM ' + ev.namaCode.toUpperCase() + ' - ' + ev.namaInstalasi;
      $('elCode').textContent = ev.namaCode.toUpperCase();
      $('elInst').textContent = ev.namaInstalasi;
      // BARU (Server Paging): bila paging terbatas, sebutkan gedung tujuan.
      $('elGed').textContent = ev.gedung + ((ev.targetGedung && ev.targetGedung.length) ? ' · Paging untuk gedung: ' + ev.targetGedung.join(', ') : '');
      if (ev.isMine) {
        $('btnStop').classList.remove('hidden');
        $('elNote').textContent = 'Anda adalah pengirim. Tekan HENTIKAN ALARM setelah kejadian tertangani.';
      } else {
        $('btnStop').classList.add('hidden');
        $('elNote').textContent = 'Alarm hanya dapat dihentikan dari PC ' + ev.namaInstalasi + ' (pengirim).';
      }
      renderPeta(ev);
      tick();
      if (ev.status === 'Aktif') {
        setupVoice();   // BARU: voice announce (host bila pengirim, penerima bila bukan)
        // BARU: tombol KIRIM PENGUMUMAN (teks -> TTS di semua penerima) hanya untuk pengirim yang punya token.
        var canAnnounce = !!(ev.isMine && TOKEN);
        $('btnAnnounce').classList.toggle('hidden', !canAnnounce);
        if (canAnnounce) $('voiceRow').classList.remove('hidden');
      }
    }

    function tick() {
      if (!ev || finished) return;
      $('elSince').textContent = 'Sejak ' + fmtTime(ev.mulai) + ' · ' + fmtElapsed(ev.mulai);
      // Mode senyap (audio dari dashboard): bila dashboard berhenti/ditutup tanpa menandai Selesai
      // (penanda basi / tidak ada), tab ini mengambil alih suara supaya PC pengirim tidak jadi hening.
      // Hanya bisa dideteksi bila localStorage tersedia; beri masa tenggang 8 detik sejak tab dimuat
      // supaya heartbeat pertama dari dashboard sempat terbaca.
      if (silentByDashboard && !audioStarted && STORAGE_OK && (Date.now() - loadedAt) > TAKEOVER_GRACE_MS && !dashboardOwnsAudio()) {
        if (dashboardMarkedEnded()) { poll(); return; } // event sudah Selesai; biarkan polling menutup tab
        silentByDashboard = false;
        $('elNote').textContent = 'Anda adalah pengirim. Tekan HENTIKAN ALARM setelah kejadian tertangani.';
        startAudio();
      }
    }
    setInterval(tick, 1000);

    // ---------- Audio ----------
    // PERBAIKAN: coba tryResumeAggressive() dua kali (langsung, lalu sekali lagi 100ms kemudian —
    // kadang browser butuh 1 tick) SEBELUM menyerah ke overlay besar. Di PC dengan Media Engagement
    // Index tinggi (dibuka rutin) ini biasanya sukses tanpa gesture sama sekali -> bunyi otomatis.
    function startAudio() {
      if (audioStarted || finished || !ev) return;
      // BARU (Voice Announce): suara live sedang berjalan -> tandai audio "sudah dimulai" tetapi jangan bunyikan
      // siren+TTS sekarang; dilanjutkan oleh restartAudioAfterVoice() setelah siaran berhenti.
      if (VOICE_OK && AlarmVoice.isBusy()) { audioStarted = true; $('overlayUnlock').classList.add('hidden'); return; }
      // ANTI DOUBLE AUDIO: untuk event milik sendiri, bila dashboard di PC yang sama sudah memutar
      // siren+TTS (Script.html -> startDashboardAudio), tab ini tidak ikut berbunyi.
      if (ev.isMine && dashboardInitiallyOwnsAudio()) {
        silentByDashboard = true;
        $('overlayUnlock').classList.add('hidden');
        $('elNote').textContent = 'Anda adalah pengirim. Suara alarm diputar dari dashboard di PC ini. Tekan HENTIKAN ALARM setelah kejadian tertangani.';
        return;
      }
      AlarmAudio.tryResumeAggressive().then(function (ok) {
        if (ok) { startAlarmAudio_(); return; }
        // Coba sekali lagi dalam microtask berikutnya (kadang browser butuh 1 tick).
        setTimeout(function () {
          if (audioStarted || finished) return;
          AlarmAudio.tryResumeAggressive().then(function (ok2) {
            if (ok2) { startAlarmAudio_(); return; }
            // BENAR-BENAR diblokir: tampilkan overlay + tombol tutup.
            $('overlayUnlock').classList.remove('hidden');
            if (unlockAttempts >= 1) $('btnUnlockClose').classList.remove('hidden');
          });
        }, 100);
      });
    }
    function startAlarmAudio_() {
      $('overlayUnlock').classList.add('hidden');
      $('btnEnableAudio').classList.add('hidden');
      audioStarted = true;
      AlarmAudio.start({
        kode: ev.kodeCode, sirenSrc: sirenSrc,
        text: AlarmAudio.fillTemplate(APP_CONFIG.ttsTemplate, ev),
        lang: APP_CONFIG.ttsLang, rate: APP_CONFIG.ttsRate
      });
    }
    $('overlayUnlock').addEventListener('click', function (e) {
      if (e.target && e.target.id === 'btnUnlockClose') return;
      unlockAttempts++;
      AlarmAudio.unlock();
      startAudio();
    });
    $('btnUnlockClose').addEventListener('click', function (e) {
      e.stopPropagation();
      $('overlayUnlock').classList.add('hidden');
      $('elNote').textContent = 'Suara tidak dapat diaktifkan di browser ini. Alarm tetap ditampilkan secara visual.';
    });
    // PERBAIKAN: gesture APA PUN (klik, sentuh, tombol keyboard) — bukan hanya click — memicu unlock + startAudio,
    // supaya alarm berikutnya tidak perlu klik tambahan pada browser yang menganggap touch/keydown sebagai gesture sah.
    (function bindAnyGestureStartAudio() {
      var handler = function () {
        if (!audioStarted && !finished && !silentByDashboard) {
          AlarmAudio.unlock().then(function () { startAudio(); });
        }
      };
      document.addEventListener('click', handler, { capture: true });
      document.addEventListener('touchstart', handler, { capture: true });
      document.addEventListener('touchend', handler, { capture: true });
      document.addEventListener('pointerdown', handler, { capture: true });
      document.addEventListener('keydown', handler, { capture: true });
    })();
    // PERBAIKAN (fallback terakhir): tombol kecil "AKTIFKAN SUARA" di dalam panel alarm (BUKAN overlay
    // besar yang menutupi alarm) — muncul hanya jika audio masih belum jalan 3 detik setelah alarm tampil.
    $('btnEnableAudio').addEventListener('click', function () {
      AlarmAudio.unlock().then(function () { startAudio(); });
      $('btnEnableAudio').classList.add('hidden');
    });
    setTimeout(function () {
      if (!AlarmAudio.isRunning() && !audioStarted && !finished && !silentByDashboard) {
        $('btnEnableAudio').classList.remove('hidden');
      }
    }, 3000);

    // ---------- BARU: Voice Announce (modul Voice.html, PeerJS) ----------
    // Pengirim (ev.isMine) = host: tombol BICARA MANUAL menyiarkan mikrofon live ke semua penerima (tanpa TTS/AI).
    // Penerima = hanya mendengar. Siren+TTS di tab ini dihentikan selama suara live, lalu dilanjutkan.
    var VOICE_OK = (typeof AlarmVoice !== 'undefined') && AlarmVoice.available();
    var voiceRoom = null;
    function alarmAudioOpts() {
      return { kode: ev.kodeCode, sirenSrc: sirenSrc, text: AlarmAudio.fillTemplate(APP_CONFIG.ttsTemplate, ev), lang: APP_CONFIG.ttsLang, rate: APP_CONFIG.ttsRate };
    }
    function restartAudioAfterVoice() {
      if (finished || !ev || !audioStarted || silentByDashboard) return;
      if (VOICE_OK && AlarmVoice.isBusy()) return;
      if (AlarmAudio.isRunning()) return;
      AlarmAudio.tryResumeAggressive().then(function () {
        if (finished || (VOICE_OK && AlarmVoice.isBusy()) || AlarmAudio.isRunning()) return;
        AlarmAudio.start(alarmAudioOpts());
      });
    }
    /** Tulis teks tombol BICARA ke <span class="btn-talk-label"> (ikon gambar/SVG tidak tersentuh). */
    function setTalkLabel(btn, text) {
      var label = btn.querySelector('.btn-talk-label');
      if (label) label.textContent = text; else btn.textContent = text;
    }
    function setTalkButton(state, detail) {
      var btn = $('btnTalk');
      btn.classList.remove('hidden', 'talking');
      btn.disabled = false;
      var n = typeof detail === 'number' ? detail : AlarmVoice.receiverCount();
      if (state === 'talking') { setTalkLabel(btn, 'SEDANG BICARA — KLIK UNTUK BERHENTI' + (n ? ' (' + n + ' pendengar)' : '')); btn.classList.add('talking'); }
      else if (state === 'ready') { setTalkLabel(btn, 'BICARA MANUAL' + (n ? ' · ' + n + ' pendengar' : ' · belum ada pendengar')); }
      else if (state === 'connecting') { setTalkLabel(btn, 'MENYIAPKAN SIARAN SUARA...'); btn.disabled = true; }
      else if (state === 'taken') { setTalkLabel(btn, 'MIKROFON DIPAKAI PERANGKAT LAIN INSTALASI INI'); btn.disabled = true; }
      else if (state === 'error') { setTalkLabel(btn, 'SIARAN SUARA GAGAL (' + (detail || 'jaringan') + ') — mencoba lagi'); btn.disabled = true; }
      else btn.classList.add('hidden');
    }
    function onListenState(state) {
      if (finished) return;
      var el = $('elListening');
      el.classList.remove('live');
      if (state === 'stream') {
        el.textContent = '🎧 PENGIRIM SEDANG BICARA — DENGARKAN';
        el.classList.add('live'); el.classList.remove('hidden');
        AlarmAudio.stop();   // siren+TTS berhenti supaya suara pengirim jelas
      } else if (state === 'end') {
        el.textContent = '🎧 Tersambung ke pengirim · siap menerima pengumuman suara';
        $('btnUnlockVoice').classList.add('hidden');
        restartAudioAfterVoice();
      } else if (state === 'connected') {
        el.textContent = '🎧 Tersambung ke pengirim · siap menerima pengumuman suara';
        el.classList.remove('hidden');
      } else if (state === 'blocked') {
        $('btnUnlockVoice').classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
    function setupVoice() {
      if (!VOICE_OK || finished || !ev || !ev.roomId || voiceRoom === ev.roomId) return;
      voiceRoom = ev.roomId;
      // Pengirim tanpa akses mikrofon (Permissions Policy iframe) -> tanpa host/tombol BICARA; pakai pengumuman teks.
      if (ev.isMine && !AlarmVoice.micAvailable()) return;
      $('voiceRow').classList.remove('hidden');
      if (ev.isMine) {
        var listening = false;
        AlarmVoice.hostOpen(ev.roomId, function (state, detail) {
          if (finished) return;
          setTalkButton(state, detail);
          if (state === 'taken' && !listening) {
            // Perangkat lain instalasi ini (mis. dashboard di PC lain) sudah jadi host -> ikut mendengarkan saja.
            listening = true;
            AlarmVoice.listen(ev.roomId, onListenState);
          } else if ((state === 'ready' || state === 'talking') && listening) {
            listening = false;
            AlarmVoice.stopListen();
            $('elListening').classList.add('hidden');
          }
        });
      } else {
        AlarmVoice.listen(ev.roomId, onListenState);
      }
    }
    $('btnTalk').addEventListener('click', function () {
      AlarmAudio.unlock();
      if (!VOICE_OK || !ev || !ev.isMine || finished) return;
      if (AlarmVoice.isTalking()) { AlarmVoice.stopTalk(); restartAudioAfterVoice(); return; }
      AlarmAudio.stop();   // tidak ada siren/TTS selama bicara; yang keluar hanya suara asli pengirim
      AlarmVoice.startTalk().then(function (ok) { if (!ok) restartAudioAfterVoice(); }).catch(function (err) {
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
          $('btnTalk').classList.add('hidden');
          alert('Izin mikrofon ditolak/diblokir untuk situs ini. Pakai KIRIM PENGUMUMAN (teks). Untuk mengizinkan: ikon gembok / setelan situs di address bar → Mikrofon → Izinkan, lalu muat ulang.');
        } else {
          alert('Tidak bisa memulai siaran suara: ' + (name === 'NotFoundError' ? 'mikrofon tidak ditemukan' : (err && (err.message || err.name)) || err));
        }
        restartAudioAfterVoice();
      });
    });
    $('btnUnlockVoice').addEventListener('click', function () {
      AlarmAudio.unlock();
      if (!VOICE_OK) return;
      AlarmVoice.resumePlayback().then(function (ok) { if (ok) $('btnUnlockVoice').classList.add('hidden'); });
    });

    // ---------- BARU: Pengumuman teks (fallback tanpa mikrofon) ----------
    // ev.announcement datang lewat polling getEventStatus yang sudah ada. Diucapkan sekali per id
    // (AlarmAudio.announce: siren dijeda, teks diucapkan, siren dilanjutkan).
    // Seen PERSISTEN per tab+event (sessionStorage): reload tab tidak mengulang TTS pengumuman yang masih di cache server.
    var SS_ANN_SEEN = 'cb_announce_seen_' + EVENT_ID;
    var announceSeenId = (function () { try { return sessionStorage.getItem(SS_ANN_SEEN); } catch (e) { return null; } })();
    function announceTts(ann) {
      return String(APP_CONFIG.announceTemplate || 'Pengumuman dari {instalasi}. {text}.')
        .replace(/\{instalasi\}/g, ann.oleh || '').replace(/\{text\}/g, ann.text || '');
    }
    function announceModalOpen() { return !$('modalAnnounce').classList.contains('hidden'); }
    // BARU (pengumuman berulang): diulang tiap 25 detik sampai pengirim menekan HENTIKAN PENGUMUMAN
    // (server menghapus cache -> e.announcement null) atau event Selesai.
    var ANNOUNCE_REPEAT_MS = 25000;
    var announceLastPlayedAt = 0;
    function handleAnnouncement(e) {
      var ann = e && e.announcement;
      var el = $('elAnnounce');
      var stopBtn = $('fbStopAnnounce');
      if (!ann || !ann.text || ann.active === false || finished) {
        // Dihentikan / tidak ada -> bersihkan state supaya pengumuman berikutnya (id baru) diproses dari awal.
        el.classList.add('hidden');
        stopBtn.classList.add('hidden');
        announceSeenId = null;
        announceLastPlayedAt = 0;
        try { sessionStorage.removeItem(SS_ANN_SEEN); } catch (x) {}
        return;
      }
      el.textContent = '📢 ' + (ann.oleh || 'Pengirim') + ' (' + fmtTime(ann.ts) + '): ' + ann.text +
        ' · diulang tiap ' + Math.round(ANNOUNCE_REPEAT_MS / 1000) + ' dtk sampai dihentikan pengirim';
      el.classList.remove('hidden');
      var canStop = !!(e.isMine && TOKEN);
      stopBtn.classList.toggle('hidden', !canStop);
      if (canStop) $('voiceRow').classList.remove('hidden');
      var isNew = announceSeenId !== ann.id;
      if (!isNew && (Date.now() - announceLastPlayedAt) < ANNOUNCE_REPEAT_MS) return;   // belum 25 detik -> skip
      // PRIORITAS: suara live berjalan / pengumuman sebelumnya masih diucapkan -> tunda (coba lagi polling berikutnya).
      if (VOICE_OK && AlarmVoice.isBusy()) return;
      if (AlarmAudio.isAnnouncing()) return;
      announceSeenId = ann.id;
      try { sessionStorage.setItem(SS_ANN_SEEN, ann.id); } catch (x) {}
      announceLastPlayedAt = Date.now();
      AlarmAudio.announce(announceTts(ann), APP_CONFIG.ttsLang, APP_CONFIG.ttsRate);
    }
    // Tombol HENTIKAN PENGUMUMAN (hanya tab pengirim). Ucapan yang sedang berjalan dibiarkan selesai.
    $('fbStopAnnounce').addEventListener('click', function () {
      if (!ev || !ev.isMine || !TOKEN || finished) return;
      var b = $('fbStopAnnounce');
      b.disabled = true; b.textContent = 'Menghentikan...';
      call('stopAnnouncement', TOKEN, EVENT_ID).then(function (res) {
        b.disabled = false; b.textContent = '🛑 HENTIKAN PENGUMUMAN';
        if (!res.ok) { alert(res.error || 'Gagal menghentikan pengumuman.'); return; }
        if (ev) { ev.announcement = null; handleAnnouncement(ev); }   // bersihkan state & sembunyikan teks sekarang
      }).catch(function (err) {
        b.disabled = false; b.textContent = '🛑 HENTIKAN PENGUMUMAN';
        alert('Gagal menghentikan pengumuman: ' + (err.message || err));
      });
    });
    // Setelah pengumuman selesai diucapkan: pastikan siren+TTS lanjut (announce() sudah melanjutkan; ini pengaman).
    AlarmAudio.onAnnouncementEnd(function () { if (!finished && !announceModalOpen()) restartAudioAfterVoice(); });
    function closeAnnounceModal_() {
      $('modalAnnounce').classList.add('hidden');
      restartAudioAfterVoice();   // lanjutkan siren bila tidak ada suara live / pengumuman sedang diucapkan
    }
    $('btnAnnounce').addEventListener('click', function () {
      AlarmAudio.unlock();
      if (!ev || !ev.isMine || !TOKEN || finished) return;
      // Jeda siren supaya pengirim fokus mengetik (kecuali pengumuman lain sedang diucapkan / suara live berjalan).
      if (!AlarmAudio.isAnnouncing() && !(VOICE_OK && AlarmVoice.isBusy())) AlarmAudio.stop();
      var ta = $('annText');
      ta.value = '';
      ta.maxLength = Number(APP_CONFIG.announceMaxLen) || 200;
      $('annMax').textContent = String(ta.maxLength);
      $('annCount').textContent = '0';
      $('annSend').disabled = false; $('annSend').textContent = 'KIRIM & UCAPKAN';
      $('modalAnnounce').classList.remove('hidden');
      setTimeout(function () { try { ta.focus(); } catch (e) {} }, 50);
    });
    $('annText').addEventListener('input', function () { $('annCount').textContent = String(this.value.length); });
    $('annCancel').addEventListener('click', closeAnnounceModal_);
    $('annSend').addEventListener('click', function () {
      var text = $('annText').value.replace(/\s+/g, ' ').trim();
      if (!text) { alert('Ketik teks pengumuman dulu.'); return; }
      var btn = $('annSend');
      btn.disabled = true; btn.textContent = 'Mengirim...';
      call('sendAnnouncement', TOKEN, EVENT_ID, text).then(function (res) {
        btn.disabled = false; btn.textContent = 'KIRIM & UCAPKAN';
        if (!res.ok) { alert(res.error || 'Gagal mengirim pengumuman.'); return; }
        $('modalAnnounce').classList.add('hidden');   // siren dilanjutkan oleh announce() setelah pengumuman diucapkan
        if (ev) { ev.announcement = res.announcement; handleAnnouncement(ev); }   // tampil & diucapkan di sini juga (konfirmasi)
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = 'KIRIM & UCAPKAN';
        alert('Gagal mengirim pengumuman: ' + (err.message || err));
      });
    });

    function resolveSirenThenStart() {
      var ref = (ev && ev.siren) || '';
      if (!ref) { startAudio(); return; }
      if (/^https?:\/\//i.test(ref) || /^data:/i.test(ref)) { sirenSrc = ref; startAudio(); return; }
      // Anggap ID file Google Drive -> minta data URI ke server; jika gagal pakai siren sintetis.
      call('getSirenAudio', ref).then(function (res) {
        if (res && res.ok) sirenSrc = res.dataUri;
        startAudio();
      }).catch(function () { startAudio(); });
    }

    // ---------- Selesai ----------
        function finish(reason) {
      if (finished) return;
      finished = true;
      if (pollTimer) clearTimeout(pollTimer);
      AlarmAudio.stop();
      if (VOICE_OK) { try { AlarmVoice.destroyAll(); } catch (e) {} }   // BARU: tutup sesi voice announce
      $('voiceRow').classList.add('hidden');
      $('elAnnounce').classList.add('hidden');
      $('fbStopAnnounce').classList.add('hidden');
      $('modalAnnounce').classList.add('hidden');
      stopPeta();
      // Beri tahu dashboard di PC yang sama (bila ia sedang memutar audio event ini) bahwa event sudah selesai,
      // supaya audionya langsung berhenti tanpa menunggu polling berikutnya.
      writeAudioOwnerEnded();
      var panelText = $('panelText');
      panelText.classList.add('done');
      // Layar status "ALARM SELESAI": ringkasan + dua tombol. TIDAK ada window.close() otomatis.
      $('elCode').textContent = (ev ? ev.namaCode.toUpperCase() : 'ALARM') + ' SELESAI';
      if (ev) {
        $('elInst').textContent = ev.namaInstalasi || '-';
        $('elGed').textContent = ev.gedung || '-';
        $('elSince').textContent = 'Mulai ' + fmtTime(ev.mulai) + ' · Selesai ' + fmtTime(Date.now()) + ' · Durasi ' + fmtElapsed(ev.mulai);
      } else {
        $('elSince').textContent = '';
      }
      var oleh = (ev && ev.isMine) ? 'Alarm dihentikan dari PC ini (pengirim).' : 'Alarm dihentikan oleh pengirim.';
      $('elNote').textContent = (reason || oleh) + ' Tab ini TIDAK menutup otomatis. Klik TUTUP TAB INI di bawah bila sudah selesai.';
      $('btnStop').classList.add('hidden');
      $('btnEnableAudio').classList.add('hidden');
      $('btnAnnounce').classList.add('hidden');
      $('btnTalk').classList.add('hidden');
      $('finishActions').classList.remove('hidden');
      document.title = 'SELESAI - ' + (ev ? ev.namaCode.toUpperCase() : 'ALARM');
    }
    // Tombol layar SELESAI. Menutup tab hanya diizinkan browser bila tab dibuka lewat window.open; kalau ditolak,
    // beri tahu sekali (tanpa mencoba berulang).
    $('btnFinishClose').addEventListener('click', function () {
      try { window.top.close(); } catch (e) {}
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        if (!window.closed) $('elNote').textContent = 'Tab ini tidak bisa menutup otomatis (dibatasi browser). Silakan tutup manual dengan Ctrl+W atau tombol X pada tab.';
      }, 400);
    });
    $('btnFinishDashboard').addEventListener('click', function () {
      // Di GitHub Pages dashboard = index.html (api.js ada); di Apps Script APP_URL = URL web app (dashboard).
      window.location.href = (typeof api !== 'undefined') ? 'index.html' : APP_URL;
    });

    // ---------- Polling status ----------
    function renderKey(e) {
      return e ? [e.status, e.isMine, e.warna, e.namaCode, e.namaInstalasi, e.gedung].join('|') : '';
    }
    function applyStatus(res) {
      if (!res || !res.ok) { failCount++; $('elConn').textContent = 'Gangguan koneksi (' + failCount + ')'; return; }
      failCount = 0;
      $('elConn').textContent = 'Terhubung';
      ev = res.event;
      // Render ulang hanya bila data yang ditampilkan memang berubah (bukan setiap polling).
      var key = renderKey(ev);
      if (key !== lastRenderKey) { lastRenderKey = key; render(); }
      if (ev.status !== 'Aktif') finish();
      else {
        setupVoice();            // BARU: idempoten per room; menangani event yang roomId-nya baru terisi
        handleAnnouncement(ev);  // BARU: pengumuman teks baru -> tampilkan + ucapkan
      }
    }
    // Polling dengan backoff: interval normal saat sehat; saat gagal berturut-turut naik 2x sampai maksimal 30 detik.
    var POLL_BASE_MS = APP_CONFIG.pollAlarmMs || 1000, POLL_MAX_MS = 30000;
    function pollDelay() { return Math.min(POLL_MAX_MS, POLL_BASE_MS * Math.pow(2, Math.min(failCount, 4))); }
    function schedulePoll() {
      if (finished) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, pollDelay());
    }
    function poll() {
      if (finished) return;
      if (pollBusy) { schedulePoll(); return; }
      pollBusy = true;
      call('getEventStatus', EVENT_ID, TOKEN).then(function (res) { pollBusy = false; applyStatus(res); schedulePoll(); })
        .catch(function () { pollBusy = false; failCount++; $('elConn').textContent = 'Gangguan koneksi (' + failCount + ')'; schedulePoll(); });
    }

    // ---------- Tombol stop (hanya tab pengirim, divalidasi server) ----------
    $('btnStop').addEventListener('click', function () {
      var b = this;
      if (!confirm('Hentikan alarm ini di semua PC?')) return;
      b.disabled = true; b.textContent = 'Menghentikan...';
      call('stopEvent', TOKEN, EVENT_ID).then(function (res) {
        if (!res.ok) { alert(res.error || 'Gagal menghentikan.'); b.disabled = false; b.textContent = 'HENTIKAN ALARM'; return; }
        finish('Alarm dihentikan.');
      }).catch(function (err) {
        alert('Gagal menghentikan: ' + (err.message || err));
        b.disabled = false; b.textContent = 'HENTIKAN ALARM';
      });
    });

    // ---------- Init ----------
    if (INITIAL && INITIAL.ok) {
      ev = INITIAL.event;
      lastRenderKey = renderKey(ev);
      render();
      if (ev.status !== 'Aktif') { finish(); }
      else { resolveSirenThenStart(); handleAnnouncement(ev); }
    } else {
      $('elCode').textContent = 'EVENT TIDAK DITEMUKAN';
      $('elInst').textContent = (INITIAL && INITIAL.error) || '';
      $('elNote').textContent = 'Event ini tidak ada atau sudah lama selesai. Tab TIDAK ditutup otomatis; gunakan tombol di bawah.';
      $('finishActions').classList.remove('hidden');
      finished = true;
    }
    if (!finished) schedulePoll();

    // Tab penerima tidak boleh dibisukan lewat mute: coba lanjutkan audio jika terhenti (mis. voice belum termuat).
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = function () { /* voice list siap; loop berikutnya otomatis memakainya */ };
    }
  
}
