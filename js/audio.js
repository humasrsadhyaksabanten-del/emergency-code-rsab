/**
 * Modul audio bersama (dipakai Index.html sebagai fallback & Alarm.html sebagai pemutar utama).
 *
 * Dua lapis:
 *   1. Siren per jenis code  : file audio (URL / Drive) jika tersedia, jika tidak disintesis via Web Audio API.
 *   2. Ucapan lokasi (TTS)   : Web Speech API, teks dari template konfigurasi.
 * Urutan: siren -> jeda -> TTS -> jeda -> ulang, tanpa henti sampai stop() dipanggil.
 *
 * Catatan kecepatan: pola siren & jeda antar-siklus dipercepat sedikit dibanding versi awal
 * (lebih banyak bunyi per detik / jeda lebih singkat) supaya terasa lebih mendesak, namun
 * setiap nada/ucapan tetap diberi durasi minimum agar tetap jelas terdengar.
 */
var AlarmAudio = (function () {
  var ctx = null;
  var running = false;
  var cycleId = 0;
  var fileEl = null;
  var currentSirenNodes = [];
  // BARU (Pengumuman teks): opsi loop terakhir (untuk dilanjutkan setelah pengumuman), flag "sedang mengucapkan
  // pengumuman" (isRunning() ikut true supaya loop siren tidak dimulai ulang di tengah pengumuman), dan penghitung
  // stop() (bila ada stop() lain selama pengumuman -> loop TIDAK dilanjutkan, mis. event sudah Selesai).
  var lastOpts = null;
  var announcing = false;
  var stopGen = 0;
  // BARU (prioritas eksklusif): start() yang dipanggil SELAMA pengumuman diucapkan tidak memotong pengumuman,
  // melainkan diantre di sini dan dijalankan setelah pengumuman selesai. stop() membatalkan antrean.
  var pendingStart = null;
  // Pendengar tetap (persisten) yang dipanggil setiap kali sebuah pengumuman selesai/dibatalkan -> UI bisa refresh.
  var announceEndCbs = [];
  // BARU (TTS HP): deteksi perangkat mobile. Engine TTS Android/iOS lebih lambat merespons cancel()->speak(),
  // jadi jeda di speak() dibedakan per platform (HP 320 ms, desktop tetap 120 ms). Desktop tidak berubah.
  var IS_MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  try { console.log('[AlarmAudio] IS_MOBILE_UA =', IS_MOBILE_UA); } catch (e) {}
  // HENING TOTAL (hold/release): kunci eksplisit yang dipasang pemanggil (mis. dashboard saat klik BICARA) SEBELUM
  // proses apa pun dimulai. Selama ada kunci, start()/speak()/announce() TIDAK mengeluarkan suara apa pun (start
  // diantre sebagai pendingStart, dijalankan oleh pemanggil setelah release). Tidak bergantung pada state modul lain,
  // jadi tidak ada celah waktu antara "klik BICARA" dan "mikrofon terbuka".
  var holdReasons = {};
  function hold(key) {
    holdReasons[key || 'hold'] = true;
    stop();                       // matikan siren, file, TTS lokasi, dan pengumuman yang sedang berjalan
    stopSpeech();                 // cancel() ekstra: engine TTS Windows kadang perlu dua kali
  }
  function release(key) {
    delete holdReasons[key || 'hold'];
  }
  function isHeld() { return Object.keys(holdReasons).length > 0; }
  /** true bila suara LIVE (BICARA MANUAL: sedang bicara ATAU sedang menerima suara pengirim) berjalan, atau ada kunci hold
   *  -> siren & TTS diam total. */
  function voiceLive() {
    if (isHeld()) return true;
    try { return typeof AlarmVoice !== 'undefined' && !!AlarmVoice.isBusy && AlarmVoice.isBusy(); } catch (e) { return false; }
  }

  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    return ctx;
  }

  /** Master gain dibuat SEKALI per AudioContext dan dipakai ulang tiap siklus (sebelumnya dibuat baru tiap siklus -> menumpuk). */
  var masterGain = null;
  function getMaster(c) {
    if (!masterGain) {
      masterGain = c.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(c.destination);
    }
    return masterGain;
  }

  /**
   * Panggil di dalam user gesture (klik) untuk membuka izin autoplay audio di tab ini.
   * Mengembalikan Promise<string> state AudioContext setelah resume ('running' / 'suspended' / 'none').
   * (Tidak wajib di-await; pemanggil lama yang mengabaikan nilai balik tetap berfungsi.)
   */
  function unlock() {
    var c = getCtx();
    var p = Promise.resolve();
    try {
      if (c) {
        if (c.state === 'suspended') p = c.resume().catch(function () {});
        var buf = c.createBuffer(1, 1, 22050);
        var src = c.createBufferSource();
        src.buffer = buf; src.connect(c.destination); src.start(0);
        src.onended = function () { try { src.disconnect(); } catch (e) {} };
      }
      if (window.speechSynthesis) {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {}
    return p.then(function () { return c ? c.state : 'none'; });
  }

  function isUnlocked() {
    var c = getCtx();
    return !!c && c.state === 'running';
  }

  /**
   * true bila audio boleh diputar. Jika browser tidak punya Web Audio sama sekali,
   * kembalikan true selama Speech Synthesis ada (mode TTS saja) supaya UI tidak terjebak di overlay unlock.
   *
   * PERBAIKAN: ini SEKARANG versi "agresif" — dipanggil kapan pun (bukan hanya di dalam gesture).
   * Di Chrome dengan Media Engagement Index (MEI) cukup tinggi (PC yang sering membuka situs ini),
   * resume() TANPA gesture BERHASIL, sehingga alarm berikutnya langsung berbunyi tanpa klik. Di browser
   * yang belum "percaya" situs ini, resume() gagal secara aman (promise ditolak, ditangkap di bawah) dan
   * kita coba lagi nanti (gesture berikutnya / panggilan periodik). tryResume() dipertahankan sebagai alias
   * supaya pemanggil lama tidak perlu diubah.
   */
  function tryResumeAggressive() {
    var c = getCtx();
    if (!c) return Promise.resolve(!!window.speechSynthesis);
    if (c.state === 'running') return Promise.resolve(true);
    return c.resume().then(function () { return c.state === 'running'; }, function () { return false; });
  }
  function tryResume() { return tryResumeAggressive(); }

  /**
   * PERBAIKAN (HP): mainkan tone sangat pendek dengan volume sangat kecil untuk menjaga AudioContext tetap
   * 'running'. Chrome Android kadang men-suspend AudioContext setelah beberapa menit idle walau halaman masih
   * aktif; tone 20 Hz (di bawah ambang dengar) 50 ms ini mencegah suspend itu tanpa terdengar oleh perawat.
   * Dipanggil tiap 30 detik dari renderTick() di Script.html. Aman dipanggil kapan pun (no-op bila belum running).
   */
  function keepAlive() {
    var c = getCtx();
    if (!c || c.state !== 'running') return;
    try {
      var o = c.createOscillator();
      var g = c.createGain();
      o.frequency.value = 20;            // di bawah ambang pendengaran manusia
      g.gain.value = 0.0001;             // hampir tidak terdengar
      o.connect(g); g.connect(c.destination);
      o.onended = function () { try { o.disconnect(); g.disconnect(); } catch (e) {} };
      o.start();
      o.stop(c.currentTime + 0.05);
    } catch (e) {}
  }

  // ===================== AUTO-UNLOCK PADA GESTURE PERTAMA APA PUN =====================
  // Tujuan: alarm berikutnya tidak perlu klik tambahan. Beberapa browser (terutama mobile) hanya
  // menganggap touchstart/touchend/pointerdown/keydown (bukan hanya click) sebagai user gesture yang sah.
  // Modul ini dipakai bersama oleh Index.html (dashboard) dan Alarm.html (tab alarm terpisah), jadi
  // cukup dipasang sekali di sini supaya kedua konteks mendapat manfaatnya tanpa duplikasi kode.
  // Jika browser tetap memblokir, overlay "KETUK LAYAR" / "AKTIFKAN SUARA" tetap menjadi fallback di masing-masing halaman.
  var _unlockOnce = false;
  function bindFirstGestureUnlock() {
    if (_unlockOnce) return;
    _unlockOnce = true;
    var handler = function () {
      try { unlock(); } catch (e) {}
      try { document.removeEventListener('click', handler, true); } catch (e) {}
      try { document.removeEventListener('touchstart', handler, true); } catch (e) {}
      try { document.removeEventListener('touchend', handler, true); } catch (e) {}
      try { document.removeEventListener('pointerdown', handler, true); } catch (e) {}
      try { document.removeEventListener('keydown', handler, true); } catch (e) {}
    };
    document.addEventListener('click', handler, true);
    document.addEventListener('touchstart', handler, true);
    document.addEventListener('touchend', handler, true);
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFirstGestureUnlock);
  } else {
    bindFirstGestureUnlock();
  }

  function wait(ms, id) {
    return new Promise(function (res) { setTimeout(function () { res(id === cycleId && running); }, ms); });
  }

  // ---------- Siren sintetis ----------
  /** Lepas node dari graph & dari daftar setelah selesai, supaya tidak menumpuk (memory leak) saat alarm lama. */
  function releaseNode(o, g) {
    try { o.disconnect(); } catch (e) {}
    try { if (g) g.disconnect(); } catch (e) {}
    if (synthStopping) return;   // PERBAIKAN: stopSynth() sedang membersihkan daftar; jangan ubah array
    var i = currentSirenNodes.indexOf(o);
    if (i !== -1) currentSirenNodes.splice(i, 1);
  }

  function tone(c, type, freq, t0, dur, vol, master) {
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.setValueAtTime(vol, t0 + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g); g.connect(master);
    o.onended = function () { releaseNode(o, g); };
    // stop() tidak boleh dijadwalkan di masa lalu (melempar error bila currentTime sudah lewat).
    o.start(t0); o.stop(Math.max(t0 + dur + 0.02, c.currentTime + 0.01));
    currentSirenNodes.push(o);
    return o;
  }

  // PERBAIKAN: flag "stopping" supaya releaseNode() yang terpicu di tengah stopSynth() tidak menyentuh array
  // yang sedang dikosongkan (race condition currentSirenNodes).
  var synthStopping = false;
  function stopSynth() {
    synthStopping = true;
    var nodes = currentSirenNodes;   // ambil referensi lalu ganti array baru
    currentSirenNodes = [];
    nodes.forEach(function (n) {
      try { n.onended = null; } catch (e) {}
      try { n.stop(); } catch (e) {}       // oscillator yang sudah berhenti melempar error -> aman diabaikan
      try { n.disconnect(); } catch (e) {}
    });
    synthStopping = false;
  }

  /** Code Red: dua nada cepat & mendesak (hi-lo), ritme dipercepat, tetap tiap nada terdengar jelas. */
  function synthRed(c, master) {
    var t = c.currentTime + 0.02, dur = 3.2, step = 0.17, i = 0;
    while (i * step < dur) {
      tone(c, 'square', i % 2 ? 740 : 980, t + i * step, step, 0.18, master);
      i++;
    }
    return dur;
  }

  /** Code Blue: tiga chime tegas dengan jeda dipersingkat (total ~2.8 detik). */
  function synthBlue(c, master) {
    var t = c.currentTime + 0.02;
    for (var i = 0; i < 3; i++) {
      var t0 = t + i * 0.72;
      tone(c, 'sine', 1046, t0, 0.5, 0.35, master);
      tone(c, 'sine', 1568, t0, 0.32, 0.18, master);
    }
    return 2.8;
  }

  /** Code lain (jika kelak diaktifkan tanpa file): sapuan naik-turun, dipercepat ke ~3 detik. */
  function synthGeneric(c, master) {
    var t = c.currentTime + 0.02, dur = 3.0, step = 0.75, k = 0;
    var o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth';
    for (k = 0; k < 4; k++) {
      o.frequency.setValueAtTime(500, t + k * step);
      o.frequency.linearRampToValueAtTime(900, t + k * step + step * 0.5);
      o.frequency.linearRampToValueAtTime(500, t + k * step + step);
    }
    g.gain.setValueAtTime(0.15, t);
    g.gain.setValueAtTime(0.15, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(master);
    o.onended = function () { releaseNode(o, g); };
    o.start(t); o.stop(Math.max(t + dur + 0.02, c.currentTime + 0.01));
    currentSirenNodes.push(o);
    return dur;
  }

  function playSynthSiren(kode) {
    var c = getCtx();
    if (!c) return Promise.resolve(0);
    var master = getMaster(c);   // dipakai ulang, tidak dibuat tiap siklus
    var dur;
    if (kode === 'RED') dur = synthRed(c, master);
    else if (kode === 'BLUE') dur = synthBlue(c, master);
    else dur = synthGeneric(c, master);
    return Promise.resolve(dur * 1000);
  }

  // ---------- Siren dari file ----------
  var FILE_SIREN_HARD_CAP_MS = 60000;   // batas mutlak satu putaran file siren
  function playFileSiren(src) {
    return new Promise(function (resolve) {
      if (!fileEl) { fileEl = document.createElement('audio'); fileEl.preload = 'auto'; document.body.appendChild(fileEl); }
      var done = false, guard = null, playStarted = false;
      function finish(ok) {
        if (done) return;
        done = true;
        if (guard) clearTimeout(guard);
        fileEl.onended = fileEl.onerror = fileEl.onplaying = null;
        resolve(ok);
      }
      fileEl.onended = function () { finish(true); };
      fileEl.onerror = function () { finish(false); };
      fileEl.onplaying = function () { playStarted = true; };
      if (fileEl.src !== src) fileEl.src = src;
      try { fileEl.currentTime = 0; } catch (e) {}
      var p = fileEl.play();
      if (p && p.then) p.then(function () { playStarted = true; }, function () { finish(false); });
      // Pengaman: JANGAN anggap selesai selama file masih benar-benar berputar (cek fileEl.ended / paused),
      // bukan sekadar timeout 15 detik seperti sebelumnya (yang bisa memotong siren panjang).
      var started = Date.now();
      (function guardTick() {
        if (done) return;
        if (fileEl.ended) return finish(true);
        if (fileEl.error) return finish(false);
        if (playStarted && fileEl.paused) return finish(true);          // dihentikan dari luar (stop())
        if (Date.now() - started >= FILE_SIREN_HARD_CAP_MS) return finish(true);
        guard = setTimeout(guardTick, 500);
      })();
    });
  }

  function stopFile() {
    if (fileEl) { try { fileEl.pause(); fileEl.currentTime = 0; } catch (e) {} }
  }

  // ---------- TTS ----------
  var SPEAK_MIN_MS = 6000;        // sebelumnya 3200 -> TTS kalimat panjang sering terpotong
  var SPEAK_HARD_CAP_MS = 30000;  // batas mutlak satu ucapan
  // NORMALISASI: kecepatan TTS disamakan antar platform. Engine TTS tiap OS punya "kecepatan dasar" berbeda
  // (Linux espeak jauh lebih cepat, Android/iOS sedikit lebih cepat dari Windows), jadi rate dasar dari
  // APP_CONFIG.ttsRate dikalikan faktor per platform supaya terdengar setara di semua PC/HP.
  function normalizeRate(baseRate) {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var factor = 1.0;

    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var isWindows = /Win/i.test(platform) || /Windows/i.test(ua);
    var isLinux = /Linux/i.test(platform) && !isAndroid;
    var isMac = /Mac/i.test(platform) && !isIOS;

    if (isAndroid)      factor = 0.85;
    else if (isIOS)     factor = 0.88;
    else if (isLinux)   factor = 0.65;
    else if (isWindows) factor = 0.92;
    else if (isMac)     factor = 0.95;

    return Math.max(0.5, Math.min(2.0, (Number(baseRate) || 1.0) * factor));
  }

  // BARU: prioritas voice per bahasa — pilih voice yang paling natural di tiap platform (urutan = prioritas).
  var PREFERRED_VOICES = {
    'id-ID': [
      'Microsoft Andika',           // Windows 10/11
      'Microsoft Gadis',            // Windows 11
      'Google Bahasa Indonesia',    // Android / Chrome
      'Damayanti',                  // iOS / macOS
      'Indonesia',
      'Indonesian'
    ]
  };

  // BARU: voice dimuat asinkron di Chrome/Android (getVoices() bisa kosong saat pertama). Tunggu 'voiceschanged'
  // maksimal 1,5 detik sebelum memilih voice; setelah itu lanjut dengan apa yang ada.
  function ensureVoices() {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis) return resolve([]);
      var v = window.speechSynthesis.getVoices();
      if (v && v.length) return resolve(v);
      var done = false;
      function fin() { if (done) return; done = true; resolve(window.speechSynthesis.getVoices() || []); }
      try { window.speechSynthesis.addEventListener('voiceschanged', fin, { once: true }); } catch (e) {}
      setTimeout(fin, 1500);
    });
  }

  var voiceCache = null, voiceCacheLang = null;
  function pickVoice(lang, voices) {
    if (!window.speechSynthesis) return null;
    voices = voices || window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    var pref = String(lang || '').toLowerCase();
    var base = pref.split('-')[0];
    // Cache hanya berlaku untuk bahasa yang sama; jika TTS_LANG diganti, pilih voice ulang.
    if (voiceCache && voiceCacheLang === pref && voices.indexOf(voiceCache) !== -1) return voiceCache;
    voiceCacheLang = pref;
    var best = null, i;
    // 1) Nama voice prioritas (cocok sebagian, tidak peka huruf besar) DAN bahasanya sesuai.
    var prefNames = PREFERRED_VOICES[lang] || PREFERRED_VOICES[pref] || [];
    for (var p = 0; p < prefNames.length && !best; p++) {
      var want = prefNames[p].toLowerCase();
      for (i = 0; i < voices.length; i++) {
        var nm = (voices[i].name || '').toLowerCase();
        var vl0 = (voices[i].lang || '').toLowerCase().replace('_', '-');
        if (nm.indexOf(want) !== -1 && vl0.indexOf(base) === 0) { best = voices[i]; break; }
      }
    }
    // 2) Bahasa persis (id-ID), 3) bahasa dasar (id-*)
    for (i = 0; i < voices.length && !best; i++) {
      var vl = (voices[i].lang || '').toLowerCase().replace('_', '-');
      if (vl === pref) best = voices[i];
    }
    for (i = 0; i < voices.length && !best; i++) {
      var vl2 = (voices[i].lang || '').toLowerCase().replace('_', '-');
      if (vl2.indexOf(base) === 0) best = voices[i];
    }
    voiceCache = best;
    return best;
  }

  function speak(text, lang, rate) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis || !text) return resolve(false);
      // PERBAIKAN (tabrakan): suara live berjalan -> jangan ucapkan apa pun (siren/TTS lokasi/pengumuman menunggu).
      if (voiceLive()) return resolve(false);
      lang = lang || 'id-ID';
      // Penanda generasi: bila stop() dipanggil SETELAH speak() ini dijadwalkan tetapi SEBELUM timer di bawah jatuh,
      // ucapan dibatalkan. Ini akar bug "Code Red masih bunyi setelah klik BICARA / saat pengumuman": speak() lama
      // yang sudah lewat cancel() tetap masuk antrean speechSynthesis 120-320 ms kemudian.
      var myGen = stopGen;
      ensureVoices().then(function (voices) {
      try {
        if (stopGen !== myGen || voiceLive()) return resolve(false);   // sudah di-stop() saat menunggu daftar voice
        // PERBAIKAN (HP): TTS TIDAK PERNAH dilewati berdasarkan isi getVoices().
        // Dulu: skip bila daftar voice terisi tetapi tidak ada voice id-* -> di Android getVoices() sering
        // mengembalikan HANYA voice en-* (atau kosong) walau engine TTS SISTEM (Google TTS) mendukung
        // bahasa Indonesia, sehingga HP hanya berbunyi siren tanpa ucapan lokasi. Sekarang:
        //  - daftar kosong  -> tetap speak() dengan u.lang='id-ID' (engine sistem memilih voice default);
        //  - ada voice, tidak ada id-* -> tetap speak() dengan u.lang='id-ID' (engine sistem memilih);
        //  - ada voice id-* -> pickVoice() memilih yang terbaik.
        // Untuk sistem alarm darurat, ucapan dengan aksen kurang tepat lebih baik daripada diam.
        var list = voices || [];

        // BARU: guard anti-tumpuk — bila engine masih mengucapkan/mengantre ucapan sebelumnya, batalkan lebih dulu
        // supaya ucapan baru tidak tumpang tindih dengan ucapan lama.
        try {
          if (window.speechSynthesis.speaking || window.speechSynthesis.pending) window.speechSynthesis.cancel();
        } catch (e) {}
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.rate = normalizeRate(rate || 1.0);   // NORMALISASI: rate dasar sama untuk semua kode & gedung, faktor per platform
        u.pitch = 1.0;
        u.volume = 1.0;
        var v = pickVoice(lang, list);
        if (v) u.voice = v;
        var done = false, guard = null;
        function finish(ok) { if (done) return; done = true; if (guard) clearTimeout(guard); resolve(ok); }
        u.onend = function () { finish(true); };
        u.onerror = function () { finish(false); };
        // PERBAIKAN (HP): Chrome Android kadang mengabaikan speak() yang dipanggil tepat setelah cancel();
        // beri jeda supaya ucapan benar-benar keluar: HP 320 ms, desktop tetap 120 ms.
        setTimeout(function () {
          if (done) return;
          // stop() / suara live terjadi selama jeda -> JANGAN masukkan ucapan ke antrean (inilah yang dulu bocor).
          if (stopGen !== myGen || voiceLive()) return finish(false);
          try { window.speechSynthesis.speak(u); } catch (e) { finish(false); }
        }, IS_MOBILE_UA ? 320 : 120);
        // Pengaman (Chrome kadang tidak memicu onend): minimum dinaikkan ke 6 detik dan per-karakter lebih longgar,
        // lalu hanya dianggap selesai bila speechSynthesis memang sudah tidak berbicara. Batas mutlak 30 detik.
        // Dibatasi di bawah batas mutlak supaya teks sangat panjang tidak langsung dianggap selesai di tick pertama.
        var minMs = Math.min(Math.max(SPEAK_MIN_MS, text.length * 150), SPEAK_HARD_CAP_MS - 1000);
        var started = Date.now();
        (function guardTick() {
          if (done) return;
          var el = Date.now() - started;
          var busy = false;
          try { busy = window.speechSynthesis.speaking || window.speechSynthesis.pending; } catch (e) {}
          if (el >= SPEAK_HARD_CAP_MS) return finish(true);
          if (el >= minMs && !busy) return finish(true);
          guard = setTimeout(guardTick, 500);
        })();
      } catch (e) { resolve(false); }
      });
    });
  }

  function stopSpeech() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  }

  // ---------- Loop utama ----------
  /**
   * opts: { kode, sirenSrc (URL/dataURI/kosong), text, lang, rate, onCycle(fn) }
   */
  function start(opts) {
    opts = opts || {};
    // BARU: pengumuman teks sedang diucapkan -> JANGAN dipotong; antre, dijalankan otomatis setelah selesai.
    if (announcing) { pendingStart = opts; lastOpts = opts; return; }
    // PERBAIKAN (tabrakan): suara live (bicara/menerima) berjalan -> siren+TTS TIDAK dimulai; disimpan sebagai
    // pendingStart dan dijalankan oleh pemanggil (restartAlarmAudioAfterVoice) setelah suara live selesai.
    if (voiceLive()) { pendingStart = opts; lastOpts = opts; return; }
    stop();
    lastOpts = opts;
    running = true;
    var id = ++cycleId;
    if (window.speechSynthesis) window.speechSynthesis.getVoices(); // pancing pemuatan voice

    (function loop() {
      if (!running || id !== cycleId) return;
      if (opts.onCycle) { try { opts.onCycle(); } catch (e) {} }
      var p;
      if (opts.sirenSrc) {
        p = playFileSiren(opts.sirenSrc).then(function (ok) {
          if (!running || id !== cycleId) return false;   // sudah di-stop() saat file berputar -> jangan lanjut ke sintetis
          if (!ok) return playSynthSiren(opts.kode).then(function (ms) { return wait(ms, id); });
          return true;
        });
      } else {
        p = playSynthSiren(opts.kode).then(function (ms) { return wait(ms, id); });
      }
      p.then(function (cont) { if (!cont) return false; return wait(280, id); })
       .then(function (cont) { if (!cont) return false; return speak(opts.text, opts.lang, opts.rate).then(function () { return running && id === cycleId; }); })
       .then(function (cont) { if (!cont) return false; return wait(400, id); })
       .then(function (cont) { if (cont) loop(); });
    })();
  }

  function stop() {
    running = false;
    cycleId++;
    stopGen++;
    pendingStart = null;   // stop() eksplisit membatalkan start() yang sedang antre
    stopSynth();
    stopFile();
    stopSpeech();          // juga membatalkan ucapan pengumuman yang sedang berjalan (finish() di announce menyusul)
  }

  // ---------- BARU: API pengumuman untuk koordinasi antar modul ----------
  function isAnnouncing() { return announcing; }
  /** Daftarkan pendengar PERSISTEN: dipanggil setiap pengumuman selesai (atau dibatalkan). */
  function onAnnouncementEnd(cb) {
    if (typeof cb === 'function') announceEndCbs.push(cb);
  }
  function fireAnnouncementEnd_() {
    announceEndCbs.slice().forEach(function (cb) { try { cb(); } catch (e) {} });
  }

  /**
   * BARU (Pengumuman teks): ucapkan SATU teks pengumuman sekarang juga. Loop siren+TTS yang sedang berjalan
   * dijeda (stop), teks diucapkan, lalu:
   *  - bila ada start() yang diantre selama pengumuman (event baru) -> jalankan itu;
   *  - bila tidak, lanjutkan loop sebelumnya (opsi terakhir) — kecuali ada stop() eksplisit di tengah
   *    pengumuman (mis. alarm dihentikan) -> tidak dilanjutkan.
   * Selama pengumuman isRunning() = true (loop tidak dimulai ulang oleh polling). Di akhir, semua pendengar
   * onAnnouncementEnd dipanggil. Mengembalikan Promise<boolean>.
   */
  var announceSeq = 0;
  function announce(text, lang, rate) {
    if (!text) return Promise.resolve(false);
    // PERBAIKAN (tabrakan): suara live berjalan -> pengumuman DITOLAK (false). Pemanggil (handleAnnouncements)
    // tidak menandai seen bila voice busy dan mengulang pada polling berikutnya, jadi pengumuman tidak hilang.
    if (voiceLive()) return Promise.resolve(false);
    var resume = running ? lastOpts : (announcing ? lastOpts : null);
    stop();   // stopGen++ -> speak() loop siren yang masih tertunda di timer-nya batal, tidak menimpa pengumuman
    var gen = stopGen;
    var seq = ++announceSeq;
    announcing = true;
    function finish(ok) {
      if (seq !== announceSeq) return ok;   // sudah digantikan pengumuman yang lebih baru -> biarkan yang baru mengatur
      announcing = false;
      var next = pendingStart;
      pendingStart = null;
      if (next) start(next);
      else if (resume && !running && gen === stopGen) start(resume);
      fireAnnouncementEnd_();
      return ok;
    }
    return new Promise(function (res) { setTimeout(res, 150); })   // beri waktu cancel() speech sebelumnya selesai
      .then(function () { return speak(text, lang, rate); })
      // Jeda 300 ms sebelum siren+TTS lokasi dilanjutkan, supaya akhir ucapan pengumuman benar-benar tuntas terdengar
      // (guard speak() kadang menandai selesai sesaat sebelum engine benar-benar diam).
      .then(function (ok) { return new Promise(function (res) { setTimeout(function () { res(ok); }, 300); }); })
      .then(finish, function () { return finish(false); });
  }

  /**
   * BARU: TES SUARA dari dashboard (tombol "🔊 TES SUARA"). Dipanggil dari klik (gesture) -> unlock, mainkan siren
   * sintetis singkat (~1 detik) lalu ucapkan kalimat tes. Ditolak (false) bila alarm/pengumuman/suara live sedang
   * berjalan supaya tidak mengganggu. Mengembalikan Promise<{ ok, audio: 'running'|..., tts: boolean }>.
   */
  function testSound(lang, rate) {
    if (running || announcing || voiceLive()) return Promise.resolve({ ok: false, reason: 'busy' });
    return unlock().then(function (state) {
      var c = getCtx();
      var ok = !!c && c.state === 'running';
      try {
        if (ok) {
          var master = getMaster(c);
          var t = c.currentTime + 0.02;
          for (var i = 0; i < 6; i++) tone(c, 'square', i % 2 ? 740 : 980, t + i * 0.17, 0.17, 0.18, master);
        }
      } catch (e) { ok = false; }
      return new Promise(function (res) { setTimeout(res, ok ? 1200 : 0); }).then(function () {
        if (running || announcing || voiceLive()) return { ok: ok, audio: state, tts: false };
        return speak('Tes suara berhasil. Nurse station siap menerima alarm.', lang || 'id-ID', rate || 1.0)
          .then(function (spoke) { return { ok: ok || spoke, audio: state, tts: !!spoke }; });
      });
    });
  }

  function fillTemplate(tpl, ev) {
    ev = ev || {};
    return String(tpl || '{code}, {instalasi}, {gedung}')
      .replace(/\{code\}/g, ev.namaCode || ev.kodeCode || '')
      .replace(/\{instalasi\}/g, ev.namaInstalasi || '')
      .replace(/\{gedung\}/g, ev.gedung || '');
  }

  return {
    unlock: unlock, isUnlocked: isUnlocked, tryResume: tryResume, tryResumeAggressive: tryResumeAggressive,
    keepAlive: keepAlive, announce: announce, isAnnouncing: isAnnouncing, onAnnouncementEnd: onAnnouncementEnd,
    hold: hold, release: release, isHeld: isHeld,
    start: start, stop: stop, isRunning: function () { return running || announcing; },
    testSound: testSound, fillTemplate: fillTemplate
  };
})();