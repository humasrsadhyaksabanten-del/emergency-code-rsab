/**
 * Modul VOICE ANNOUNCE (PeerJS / WebRTC) — dipakai bersama oleh Index.html (dashboard, mode inline) dan
 * Alarm.html (tab alarm, mode tab lama).
 *
 * Aturan:
 *  - Hanya PENGIRIM (event.isMine) yang bisa bicara (HOST). Suara mikrofon pengirim disiarkan LIVE ke semua
 *    PC/HP penerima. Tidak ada TTS/AI yang ikut keluar — murni suara asli pengirim.
 *  - PENERIMA hanya mendengar (one-way). Tidak ada tombol bicara di penerima.
 *
 * Arah koneksi (PENTING, berbeda dari pola "penerima memanggil host dengan stream kosong"):
 *  - Penerima membuka DATA-CONNECTION ke ID room (= Peer ID host). Ini hanya "pendaftaran" supaya host tahu
 *    siapa yang harus dipanggil.
 *  - Saat pengirim klik BICARA, HOST memanggil (call) setiap penerima yang terdaftar dengan stream mikrofon.
 *    Penerima menjawab TANPA stream -> audio satu arah. Penerima yang bergabung di tengah siaran otomatis
 *    ikut dipanggil.
 *  Alasan: offer WebRTC tanpa track audio tidak membuka jalur media, jadi "penerima memanggil host dengan
 *  MediaStream kosong" sering menghasilkan sambungan tanpa suara.
 *
 * Room ID (= Peer ID host) dibuat server-side di Code.gs (createEvent) dan dikirim sebagai event.roomId.
 * Signaling memakai PeerJS Cloud (gratis, butuh internet). Bila library PeerJS tidak termuat (CDN diblokir
 * firewall RS), AlarmVoice.available() = false dan UI voice disembunyikan — alarm siren+TTS tetap normal.
 */
var AlarmVoice = (function () {
  var RX_RETRY_MS = 5000;        // penerima: coba sambung ulang ke host tiap 5 detik (host mungkin belum online)
  var HOST_RETRY_MS = 15000;     // host: coba ambil ID room lagi bila ID sedang dipakai perangkat lain / error
  var HOST_TAKEN_MAX_RETRY = 3;  // batas retry saat ID room dipakai perangkat lain (hemat kuota PeerJS Cloud)

  var _warnedUnavailable = false;
  function available() {
    var ok = typeof Peer === 'function' && !!window.RTCPeerConnection;
    if (!ok && !_warnedUnavailable) {
      _warnedUnavailable = true;
      try { console.warn('[Voice] PeerJS tidak termuat (CDN diblokir firewall?) atau WebRTC tidak tersedia — fitur BICARA MANUAL dinonaktifkan. Siren + TTS + pengumuman teks tetap berjalan.'); } catch (e) {}
    }
    return ok;
  }
  /**
   * true bila mikrofon BENAR-BENAR bisa diminta di dokumen ini. Selain cek API, periksa Permissions Policy:
   * halaman Apps Script berjalan di iframe cross-origin (googleusercontent.com); bila iframe induk milik Google
   * tidak memberi allow="microphone", getUserMedia() pasti ditolak -> tombol BICARA disembunyikan dan pengirim
   * memakai jalur PENGUMUMAN TEKS (TTS di semua penerima). Bisa dicek manual di console:
   *   document.featurePolicy.allowsFeature('microphone')
   */
  // Status izin mikrofon yang sudah diketahui: null (belum tahu) | 'granted' | 'denied' | 'nomic' | 'unsupported' | 'error'
  var micState = null;
  function micPolicyBlocked_() {
    try {
      var fp = document.permissionsPolicy || document.featurePolicy;
      return !!(fp && typeof fp.allowsFeature === 'function' && !fp.allowsFeature('microphone'));
    } catch (e) { return false; }
  }
  function micAvailable() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return false;
    if (micPolicyBlocked_()) return false;
    if (micState === 'denied' || micState === 'nomic' || micState === 'unsupported') return false;
    return true;
  }
  function classifyMicError_(err) {
    var n = (err && err.name) || '';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'nomic';
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return 'denied';
    return 'error';
  }
  /**
   * BARU: minta izin mikrofon LEBIH AWAL — panggil dari gesture "Accept All Cookies" (klik pertama), bukan saat
   * alarm. Browser menampilkan prompt sekali dan MENYIMPAN jawabannya untuk origin ini, sehingga klik BICARA
   * MANUAL saat alarm tidak lagi memunculkan prompt / ditolak. Stream langsung dimatikan: tidak ada yang direkam.
   * Mengembalikan Promise<'granted'|'denied'|'nomic'|'unsupported'|'error'>.
   */
  function requestMicPermission() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { micState = 'unsupported'; return Promise.resolve(micState); }
    if (micPolicyBlocked_()) { micState = 'denied'; return Promise.resolve(micState); }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (s) {
      try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      micState = 'granted';
      return micState;
    }, function (err) {
      micState = classifyMicError_(err);
      return micState;
    });
  }
  /** Cek status izin mikrofon TANPA prompt (Permissions API) — untuk menyembunyikan tombol BICARA bila sudah diblokir. */
  function probeMicPermission() {
    if (!(navigator.permissions && navigator.permissions.query)) return Promise.resolve(null);
    var q;
    try { q = navigator.permissions.query({ name: 'microphone' }); } catch (e) { return Promise.resolve(null); }
    return q.then(function (st) {
      var apply = function () {
        if (st.state === 'denied') micState = 'denied';
        else if (st.state === 'granted') micState = 'granted';
        else if (micState === 'denied' || micState === 'granted') micState = null;   // kembali ke 'prompt'
      };
      apply();
      try { st.onchange = apply; } catch (e) {}
      return st.state;
    }, function () { return null; });
  }
  function micPermissionState() { return micState; }
  function safeClose(o) { try { if (o) o.close(); } catch (e) {} }
  function safeDestroy(p) { try { if (p) p.destroy(); } catch (e) {} }

  // =========================== ICE / TURN (M0) ===========================
  // Diagnosa 17-09-2026 dari jaringan RS: signaling PeerJS & STUN berjalan, tetapi TURN bawaan PeerJS
  // (0.peerjs.com:3478 UDP/TCP) TIDAK menghasilkan kandidat relay -> bila dua PC tidak bisa saling jangkau langsung
  // (beda subnet/VLAN, WiFi client-isolation, NAT tanpa hairpin) ICE gagal dan suara tidak sampai.
  // Solusi: TURN milik RS (metered.ca / Twilio / coturn di port 443 TCP+TLS) diisi di Code.gs CONFIG.ICE_SERVERS ->
  // dikirim lewat getClientConfig -> APP_CONFIG.iceServers -> dipakai di sini untuk SEMUA Peer (host, penerima, selfTest).
  var DEFAULT_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'turn:0.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' }   // bawaan PeerJS (sering diblokir)
  ];
  function iceServers_() {
    var extra = null;
    try { extra = (typeof APP_CONFIG !== 'undefined' && Array.isArray(APP_CONFIG.iceServers)) ? APP_CONFIG.iceServers : null; } catch (e) {}
    var list = [];
    if (extra) extra.forEach(function (s) { if (s && s.urls) list.push(s); });   // TURN RS diprioritaskan (urutan = prioritas)
    return list.concat(DEFAULT_ICE_SERVERS);
  }
  /** true bila ada turn:/turns: di APP_CONFIG.iceServers (TURN milik RS dari Code.gs), BUKAN TURN bawaan PeerJS. */
  function hasTurnConfigured_() {
    var extra = [];
    try { extra = (typeof APP_CONFIG !== 'undefined' && Array.isArray(APP_CONFIG.iceServers)) ? APP_CONFIG.iceServers : []; } catch (e) { extra = []; }
    return extra.some(function (s) { return s && /^turns?:/i.test(Array.isArray(s.urls) ? s.urls.join(' ') : String(s.urls || '')); });
  }
  // ---- Kebijakan transport ICE (M0-B) ----
  // 'all'   : default. ICE mencoba jalur langsung (host/srflx) DAN relay sekaligus; yang tersambung lebih dulu dipakai.
  //           Bila TURN RS ada, antar-subnet otomatis lewat relay — TIDAK perlu deteksi subnet manual.
  // 'relay' : paksa semua media lewat TURN (latensi sedikit lebih tinggi, tetapi paling pasti di jaringan ketat).
  // Sumber kebijakan: APP_CONFIG.iceTransportPolicy (Code.gs CONFIG.ICE_TRANSPORT_POLICY) ATAU sakelar otomatis
  // sessionStorage 'cb_force_relay' yang dinyalakan sendiri oleh callPeer_() saat panggilan langsung gagal
  // berulang padahal TURN RS tersedia. Sakelar hanya berlaku bila TURN RS memang dikonfigurasi.
  var FORCE_RELAY_KEY = 'cb_force_relay';
  function forceRelay_() { try { return sessionStorage.getItem(FORCE_RELAY_KEY) === '1'; } catch (e) { return false; } }
  function setForceRelay(on) {
    try { if (on) sessionStorage.setItem(FORCE_RELAY_KEY, '1'); else sessionStorage.removeItem(FORCE_RELAY_KEY); } catch (e) {}
    log_('kebijakan ICE: force relay =', !!on);
  }
  function iceTransportPolicy_() {
    var cfg = '';
    try { cfg = String((typeof APP_CONFIG !== 'undefined' && APP_CONFIG.iceTransportPolicy) || '').toLowerCase(); } catch (e) {}
    if (cfg === 'relay' && hasTurnConfigured_()) return 'relay';
    if (forceRelay_() && hasTurnConfigured_()) return 'relay';
    return 'all';
  }
  function peerOptions_() {
    return {
      debug: 0,
      config: {
        iceServers: iceServers_(),
        iceTransportPolicy: iceTransportPolicy_(),
        iceCandidatePoolSize: 4,        // pre-gather kandidat (termasuk alokasi TURN) sebelum panggilan -> ICE selesai lebih cepat
        sdpSemantics: 'unified-plan'
      }
    };
  }
  /** Daftar server ICE tanpa kredensial (untuk tampilan diagnostik). */
  function iceServerUrls_() {
    var out = [];
    iceServers_().forEach(function (s) { (Array.isArray(s.urls) ? s.urls : [s.urls]).forEach(function (u) { out.push(u + (s.username ? ' (auth)' : '')); }); });
    return out;
  }
  /**
   * DIAGNOSTIK M0: kumpulkan kandidat ICE dari jaringan PC ini dengan server yang dikonfigurasi.
   *  - all   : semua jenis (host = LAN, srflx = lewat STUN/NAT, relay = lewat TURN)
   *  - relay : HANYA relay (iceTransportPolicy 'relay') -> ok=true berarti TURN bisa dipakai dari jaringan ini.
   * Tanpa relay, BICARA MANUAL hanya berhasil bila kedua PC bisa saling jangkau langsung.
   */
  function iceTest(timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    function gather(cfg) {
      return new Promise(function (res) {
        var out = { types: {}, samples: [], ms: 0, timeout: false };
        var t0 = Date.now(), pc = null, done = false;
        function fin(to) { if (done) return; done = true; out.ms = Date.now() - t0; out.timeout = !!to; try { pc.close(); } catch (e) {} res(out); }
        try {
          pc = new RTCPeerConnection(cfg);
          pc.createDataChannel('probe');
          pc.onicecandidate = function (e) {
            if (!e.candidate) return fin(false);
            var c = e.candidate, t = c.type || (String(c.candidate).split(' ')[7] || '?');
            out.types[t] = (out.types[t] || 0) + 1;
            if (out.samples.length < 5) out.samples.push((c.protocol || '') + ' ' + t + ' ' + (c.address || '') + ':' + (c.port || ''));
          };
          pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function (e) { out.error = String(e); fin(false); });
          setTimeout(function () { fin(true); }, timeoutMs);
        } catch (e) { out.error = String(e); fin(false); }
      });
    }
    var servers = iceServers_();
    var hasTurn = hasTurnConfigured_();
    return gather({ iceServers: servers }).then(function (all) {
      return gather({ iceServers: servers, iceTransportPolicy: 'relay' }).then(function (relay) {
        var relayOk = !!(relay.types.relay);
        return {
          servers: iceServerUrls_(), hasTurnConfigured: hasTurn,
          iceTransportPolicy: iceTransportPolicy_(), forceRelay: forceRelay_(),
          all: all, relay: relay, relayOk: relayOk,
          verdict: relayOk ? 'OK: TURN dapat dipakai dari jaringan ini -> BICARA MANUAL bisa menembus firewall/NAT.'
            : (all.types.srflx ? 'TANPA RELAY: STUN jalan, TURN tidak. Suara hanya sampai bila kedua PC saling jangkau langsung (satu subnet, tanpa client-isolation). Isi CONFIG.ICE_SERVERS di Code.gs dengan TURN RS (port 443 TCP/TLS).'
              : 'TERBLOKIR: tidak ada kandidat STUN/relay -> firewall memblokir UDP keluar & TURN. Butuh TURN di 443 TCP/TLS.')
        };
      });
    });
  }
  // DIAGNOSTIK: log rinci ke console bila localStorage 'cb_voice_debug' = '1' (nyalakan: localStorage.setItem('cb_voice_debug','1'); muat ulang).
  var DEBUG_LOG = (function () { try { return localStorage.getItem('cb_voice_debug') === '1'; } catch (e) { return false; } })();
  function log_() { if (!DEBUG_LOG) return; try { console.log.apply(console, ['[Voice ' + new Date().toLocaleTimeString() + ']'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }
  /** Pantau state ICE sebuah MediaConnection (untuk log & debugInfo). 'failed' = NAT/firewall menghalangi media (butuh TURN). */
  function watchIce_(call, label, onState) {
    try {
      var pc = call && call.peerConnection;
      if (!pc) return;
      pc.addEventListener('iceconnectionstatechange', function () { log_(label, 'ICE:', pc.iceConnectionState); if (onState) { try { onState(pc.iceConnectionState); } catch (e) {} } });
      pc.addEventListener('connectionstatechange', function () { log_(label, 'PC:', pc.connectionState); });
    } catch (e) {}
  }

  // =========================== HOST (PENGIRIM) ===========================
  // host = { peer, room, conns:{peerId:DataConnection}, calls:{peerId:MediaConnection}, stream, talking,
  //          onState, retryTimer, state }
  // state: 'connecting' | 'ready' | 'talking' | 'taken' | 'error'
  var host = null;

  function emitHost_(h, state, detail) {
    if (!h || host !== h) return;
    h.state = state;
    if (h.onState) { try { h.onState(state, detail); } catch (e) {} }
  }
  function receiverCount() {
    return host ? Object.keys(host.conns).length : 0;
  }

  /**
   * Buka Peer dengan ID = room. Penerima akan mendaftar ke ID ini. Idempoten untuk room yang sama.
   * opts.fast = true (AMBIL ALIH): bila ID masih dipakai host lama yang sedang melepasnya, coba lagi tiap 700 ms
   * (maks 8x) tanpa menghitung batas 'taken' -> peminta menjadi host baru dalam ~1 detik.
   */
  function hostOpen(room, onState, opts) {
    opts = opts || {};
    if (!available() || !room) { if (onState) { try { onState('unsupported'); } catch (e) {} } return; }
    if (host && host.room === room) {
      if (onState) host.onState = onState;
      if (opts.fast) host.fastRetry = 8;
      // Dipanggil lagi untuk room yang sama saat host "menyerah" ('taken' habis retry / 'error') -> permintaan
      // AMBIL ALIH (host lama hilang / melepas ID): batalkan timer lambat, reset hitungan, coba lagi sekarang.
      if (!host.peer && (host.state === 'taken' || host.state === 'error')) {
        if (host.retryTimer) { clearTimeout(host.retryTimer); host.retryTimer = null; }
        host.takenRetries = 0;
        createHostPeer_(host);
        return;
      }
      emitHost_(host, host.state, receiverCount());
      return;
    }
    hostClose();
    host = { peer: null, room: room, conns: {}, calls: {}, rxState: {}, stream: null, talking: false, onState: onState || null, retryTimer: null, state: 'connecting', takenRetries: 0, fastRetry: opts.fast ? 8 : 0, nostreamTimer: null };
    createHostPeer_(host);
  }
  /** M0: jumlah penerima yang MELAPOR benar-benar menerima audio (track unmuted) selama siaran ini. */
  function hearingCount() {
    if (!host) return 0;
    var n = 0;
    Object.keys(host.rxState).forEach(function (id) { if (host.rxState[id] === 'audio') n++; });
    return n;
  }
  function rxStates() { return host ? JSON.parse(JSON.stringify(host.rxState)) : {}; }

  /**
   * Pesan data dari penerima ke host. Protokol AMBIL ALIH mikrofon (semua perangkat boleh bicara, satu per waktu):
   *   penerima -> { type: 'takeover' }
   *   host     -> { type: 'takeover-denied', reason: 'talking' }  bila host sedang bicara (tidak boleh dipotong)
   *   host     -> { type: 'takeover-ok' } lalu MELEPAS ID room (hostClose) -> peminta hostOpen(room, ..., {fast:true})
   * PeerServer menjamin hanya SATU peer memegang ID room, jadi dua peminta bersamaan tidak bisa sama-sama menang:
   * yang kalah mendapat 'taken' dan kembali menjadi penerima.
   */
  function handleHostMessage_(h, conn, msg) {
    if (!msg || typeof msg !== 'object' || host !== h) return;
    // M0: laporan balik dari penerima ('calling' | 'stream' | 'audio' | 'blocked' | 'end' | 'failed') -> pengirim melihat
    // "X/Y PC mendengar" dan mendapat peringatan bila suaranya tidak sampai ke siapa pun.
    if (msg.type === 'rx-state') {
      h.rxState[conn.peer] = String(msg.state || '');
      log_('HOST: penerima', conn.peer, 'melapor', msg.state);
      emitHost_(h, h.state, receiverCount());
      return;
    }
    if (msg.type !== 'takeover') return;
    if (h.talking && h.stream) {
      log_('HOST: permintaan ambil alih dari', conn.peer, 'DITOLAK (sedang bicara)');
      try { conn.send({ type: 'takeover-denied', reason: 'talking' }); } catch (e) {}
      return;
    }
    log_('HOST: melepas ID room untuk', conn.peer);
    try { conn.send({ type: 'takeover-ok' }); } catch (e) {}
    emitHost_(h, 'released', conn.peer);
    setTimeout(function () { if (host === h) hostClose(); }, 150);   // beri waktu pesan terkirim, lalu lepaskan ID
  }

  function createHostPeer_(h) {
    if (host !== h) return;
    emitHost_(h, 'connecting');
    var p;
    var opts = peerOptions_();
    h.policyAtCreate = opts.config.iceTransportPolicy;
    try { p = new Peer(h.room, opts); } catch (e) { emitHost_(h, 'error', String(e)); scheduleHostRetry_(h); return; }
    h.peer = p;
    p.on('open', function () {
      if (host !== h || h.peer !== p) return;
      log_('HOST terdaftar di PeerServer sebagai', h.room);
      emitHost_(h, h.talking ? 'talking' : 'ready', receiverCount());
    });
    p.on('connection', function (conn) {
      if (host !== h || h.peer !== p) { safeClose(conn); return; }
      var id = conn.peer;
      log_('HOST: penerima mendaftar', id, '| sedang bicara:', h.talking);
      // Penerima lama dengan ID yang sama (reload) -> tutup yang lama.
      if (h.conns[id] && h.conns[id] !== conn) safeClose(h.conns[id]);
      h.conns[id] = conn;
      var gone = function () {
        if (h.conns[id] === conn) delete h.conns[id];
        dropCall_(h, id);
        delete h.rxState[id];
        emitHost_(h, h.state, receiverCount());
      };
      conn.on('close', gone);
      conn.on('error', gone);
      conn.on('data', function (msg) { handleHostMessage_(h, conn, msg); });
      // Sedang bicara -> penerima yang baru bergabung langsung dipanggil.
      if (h.talking && h.stream) callPeer_(h, id);
      emitHost_(h, h.state, receiverCount());
    });
    p.on('disconnected', function () {
      // Putus dari server signaling (jaringan) -> sambung ulang; koneksi media yang ada tetap berjalan.
      if (host !== h || h.peer !== p) return;
      try { if (!p.destroyed) p.reconnect(); } catch (e) {}
    });
    p.on('error', function (err) {
      if (host !== h || h.peer !== p) return;
      var type = (err && err.type) || String(err);
      log_('HOST peer error:', type, err && err.message);
      if (type === 'peer-unavailable') return;   // penerima pergi tepat saat dipanggil -> abaikan
      if (type === 'unavailable-id') {
        // Perangkat LAIN sudah menjadi host untuk event ini (semua perangkat mencoba jadi host; PeerServer memilih satu).
        emitHost_(h, 'taken');
        if (h.fastRetry > 0) { scheduleHostRetry_(h); return; }   // mode ambil alih: coba cepat, tanpa hitung batas
        h.takenRetries = (h.takenRetries || 0) + 1;
        if (h.takenRetries >= HOST_TAKEN_MAX_RETRY) {
          // Menyerah (hemat kuota). Peer dilepas; hostOpen(room) berikutnya dari pemanggil = permintaan ambil alih.
          var dead = h.peer; h.peer = null; safeDestroy(dead);
          return;
        }
        scheduleHostRetry_(h);
        return;
      }
      emitHost_(h, 'error', type);
      scheduleHostRetry_(h);
    });
  }

  function scheduleHostRetry_(h) {
    if (host !== h || h.retryTimer) return;
    var old = h.peer;
    h.peer = null;
    safeDestroy(old);
    var delay = HOST_RETRY_MS;
    if (h.fastRetry > 0) { h.fastRetry--; delay = 700; }
    h.retryTimer = setTimeout(function () {
      h.retryTimer = null;
      if (host !== h) return;
      createHostPeer_(h);
    }, delay);
  }

  var CALL_RETRY_MAX = 3;        // M0: panggil ulang bila ICE 'failed' (kandidat/rute baru), maks 3x per penerima per siaran
  var CALL_RETRY_MS = 1500;
  function callPeer_(h, id, attempt) {
    attempt = attempt || 0;
    if (!h.peer || !h.peer.open || !h.stream || h.calls[id]) return;
    var call = null;
    try { call = h.peer.call(id, h.stream); } catch (e) { call = null; log_('HOST: peer.call() gagal ke', id, e); }
    if (!call) return;
    log_('HOST: memanggil penerima', id, '| percobaan', attempt + 1, '| track audio:', h.stream.getAudioTracks().length);
    h.calls[id] = call;
    h.rxState[id] = 'calling';
    var discTimer = null;
    function failNow_() {
      // ICE gagal: jalur media tidak tembus (NAT/firewall) atau putus > 5 dtk. Tutup, lalu panggil ulang setelah jeda
      // (koneksi baru = ICE restart penuh); kalau habis -> 'failed' (pengirim melihat peringatan lewat hearingCount/
      // nostream; penerima tetap mendengar siren+TTS).
      if (host !== h || h.calls[id] !== call) return;
      if (discTimer) { clearTimeout(discTimer); discTimer = null; }
      delete h.calls[id];
      safeClose(call);
      if (attempt < CALL_RETRY_MAX && h.talking && h.stream && h.conns[id]) {
        h.rxState[id] = 'retry';
        setTimeout(function () { if (host === h && h.talking && h.stream && h.conns[id] && !h.calls[id]) callPeer_(h, id, attempt + 1); }, CALL_RETRY_MS);
      } else {
        h.rxState[id] = 'failed';
        h.iceFailures = (h.iceFailures || 0) + 1;
        // M0-B: retry habis. Bila TURN RS tersedia dan kebijakan masih 'all' -> nyalakan sakelar relay.
        //  - Belum ada satu pun penerima yang mendengar -> beralih SEKARANG: host peer dibuat ulang dengan
        //    iceTransportPolicy 'relay' (ID room sama); penerima tersambung ulang otomatis (retry 5 dtk) dan
        //    dipanggil lagi lewat TURN. Cukup sisi host yang relay-only: media tetap tembus selama penerima
        //    bisa menjangkau server TURN (port 443).
        //  - Sebagian penerima sudah mendengar -> jangan ganggu mereka; relay dipakai pada siaran berikutnya
        //    (lihat stopTalk) dan pengirim diberi tahu lewat 'icefailed'.
        var bisaRelay = hasTurnConfigured_() && iceTransportPolicy_() !== 'relay';
        if (bisaRelay) setForceRelay(true);
        if (bisaRelay && hearingCount() === 0 && h.talking && h.stream) {
          emitHost_(h, 'relay-switch', receiverCount());
          switchHostToRelay_(h);
          return;
        }
        var gagal = 0;
        Object.keys(h.rxState).forEach(function (k) { if (h.rxState[k] === 'failed') gagal++; });
        emitHost_(h, 'icefailed', { gagal: gagal, total: receiverCount(), turn: hasTurnConfigured_(), relayBerikutnya: bisaRelay });
      }
      emitHost_(h, h.state, receiverCount());
    }
    watchIce_(call, 'HOST->' + id, function (state) {
      if (host !== h || h.calls[id] !== call) return;
      if (state === 'connected' || state === 'completed') { if (discTimer) { clearTimeout(discTimer); discTimer = null; } return; }
      if (state === 'disconnected') {
        // M4: 'disconnected' sering pulih sendiri (WiFi berpindah AP). Tunggu 5 dtk; bila belum kembali -> perlakukan gagal.
        if (!discTimer) discTimer = setTimeout(function () {
          discTimer = null;
          var pc = call && call.peerConnection;
          var st = pc ? pc.iceConnectionState : 'failed';
          if (st === 'disconnected' || st === 'failed' || st === 'closed') failNow_();
        }, 5000);
        return;
      }
      if (state === 'failed') failNow_();
    });
    var done = function (e) { log_('HOST: panggilan ke', id, 'selesai', e || ''); if (h.calls[id] === call) delete h.calls[id]; };
    call.on('close', done);
    call.on('error', done);
  }
  /**
   * M0-B: buat ulang Peer host dengan kebijakan ICE terbaru (relay). Data-connection & panggilan lama ditutup;
   * ID room dipertahankan sehingga penerima menyambung ulang sendiri. Dipakai saat sakelar relay dinyalakan.
   */
  function switchHostToRelay_(h) {
    if (host !== h) return;
    log_('HOST: beralih ke relay-only, membuat ulang peer', h.room);
    if (h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
    Object.keys(h.calls).forEach(function (id) { dropCall_(h, id); });
    Object.keys(h.conns).forEach(function (id) { safeClose(h.conns[id]); });
    h.conns = {}; h.rxState = {};
    var old = h.peer; h.peer = null; safeDestroy(old);
    h.fastRetry = 8;   // ID room mungkin masih tercatat di PeerServer beberapa ratus ms -> coba cepat
    createHostPeer_(h);
  }
  function dropCall_(h, id) {
    if (!h.calls[id]) return;
    safeClose(h.calls[id]);
    delete h.calls[id];
  }

  /**
   * PENGIRIM: mulai bicara. Minta izin mikrofon (browser akan menampilkan prompt izin pada klik pertama),
   * lalu panggil semua penerima yang terdaftar. Panggil dari user gesture (klik tombol BICARA).
   * Mengembalikan Promise<boolean> (true = siaran berjalan). Ditolak bila mikrofon tidak bisa diakses.
   */
  function startTalk() {
    var h = host;
    if (!h) return Promise.reject(new Error('Siaran suara belum siap (host belum dibuka).'));
    if (h.talking && h.stream) return Promise.resolve(true);
    if (!micAvailable()) return Promise.reject(new Error('Browser ini tidak mendukung akses mikrofon.'));
    // Prioritas eksklusif: pengumuman teks (TTS) sedang diucapkan -> tolak; tunggu selesai (pemanggil menampilkan pesan).
    if (typeof AlarmAudio !== 'undefined' && AlarmAudio.isAnnouncing && AlarmAudio.isAnnouncing()) {
      var e = new Error('Pengumuman teks sedang diucapkan. Tunggu sampai selesai, lalu klik BICARA lagi.');
      e.name = 'AnnouncingError';
      return Promise.reject(e);
    }
    var constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
    // PERBAIKAN (prioritas suara): sejak klik BICARA sampai mikrofon terbuka (prompt izin bisa beberapa detik),
    // isBusy() sudah true supaya polling/announce TIDAK memulai ulang siren+TTS di celah ini (dulu: TTS "Code Red"
    // sempat bunyi lagi tepat saat pengirim mulai bicara).
    talkStarting = true;
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      talkStarting = false;
      if (host !== h) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); return false; }
      h.stream = stream;
      h.talking = true;
      h.rxState = {};
      // Izin mikrofon dicabut / perangkat dicabut -> hentikan siaran dengan rapi.
      stream.getTracks().forEach(function (t) { t.onended = function () { if (host === h && h.stream === stream) stopTalk(); }; });
      Object.keys(h.conns).forEach(function (id) { callPeer_(h, id); });
      emitHost_(h, 'talking', receiverCount());
      micState = 'granted';
      // M0/M9/M13: pengawas BERKALA (pertama 5 dtk, lalu tiap 5 dtk selama bicara) — ada penerima terdaftar tetapi TIDAK SATU
      // PUN melapor menerima audio -> 'nostream' (UI pengirim: peringatan + arahan DIAGNOSTIK; toast dibatasi di pemanggil).
      // Begitu ada yang melapor 'audio', rx-state memancarkan 'talking' lagi sehingga label pulih otomatis.
      if (h.nostreamTimer) clearTimeout(h.nostreamTimer);
      (function watchdog() {
        h.nostreamTimer = setTimeout(function () {
          h.nostreamTimer = null;
          if (host !== h || !h.talking) return;
          var n = receiverCount();
          if (n > 0 && hearingCount() === 0) emitHost_(h, 'nostream', n);
          watchdog();
        }, 5000);
      })();
      return true;
    }, function (err) {
      talkStarting = false;
      micState = classifyMicError_(err);   // 'denied' -> micAvailable() false -> tombol BICARA disembunyikan pemanggil
      throw err;
    });
  }
  var talkStarting = false;   // true selama getUserMedia() berjalan setelah klik BICARA (lihat startTalk)

  /** PENGIRIM: berhenti bicara. Tutup semua panggilan & matikan mikrofon; host tetap terbuka (penerima tetap terdaftar). */
  function stopTalk() {
    var h = host;
    if (!h) return;
    if (h.nostreamTimer) { clearTimeout(h.nostreamTimer); h.nostreamTimer = null; }
    Object.keys(h.calls).forEach(function (id) { dropCall_(h, id); });
    if (h.stream) {
      h.stream.getTracks().forEach(function (t) { try { t.onended = null; t.stop(); } catch (e) {} });
      h.stream = null;
    }
    var was = h.talking;
    h.talking = false;
    if (was || h.state === 'talking') emitHost_(h, (h.peer && h.peer.open) ? 'ready' : h.state === 'talking' ? 'connecting' : h.state, receiverCount());
    // M0-B: sakelar relay dinyalakan selama siaran tadi (sebagian penerima gagal) -> terapkan sekarang, saat
    // tidak ada audio berjalan, supaya siaran berikutnya langsung lewat TURN.
    if (h.peer && h.policyAtCreate !== 'relay' && iceTransportPolicy_() === 'relay') switchHostToRelay_(h);
  }

  function hostClose() {
    var h = host;
    if (!h) return;
    host = null;   // set dulu supaya callback yang tersisa tidak memancarkan state
    if (h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
    if (h.nostreamTimer) { clearTimeout(h.nostreamTimer); h.nostreamTimer = null; }
    Object.keys(h.calls).forEach(function (id) { safeClose(h.calls[id]); });
    Object.keys(h.conns).forEach(function (id) { safeClose(h.conns[id]); });
    if (h.stream) h.stream.getTracks().forEach(function (t) { try { t.onended = null; t.stop(); } catch (e) {} });
    safeDestroy(h.peer);
  }

  // =========================== PENERIMA ===========================
  // rx = { peer, room, conn, call, audio, retryTimer, onState, playing }
  // state ke pemanggil: 'waiting' (host belum online), 'connected' (terdaftar di host, belum ada suara),
  //                     'stream' (suara pengirim masuk), 'blocked' (autoplay diblokir; butuh klik),
  //                     'end' (siaran berhenti), 'error'
  var rx = null;

  function emitRx_(r, state, detail) {
    if (!r || rx !== r) return;
    if (r.onState) { try { r.onState(state, detail); } catch (e) {} }
  }

  /** PENERIMA: daftar ke host room ini dan putar suara yang masuk. Idempoten untuk room yang sama. */
  function listen(room, onState) {
    if (!available() || !room) return;
    if (rx && rx.room === room) { if (onState) rx.onState = onState; return; }
    stopListen();
    rx = { peer: null, room: room, conn: null, call: null, audio: null, retryTimer: null, onState: onState || null, playing: false };
    createRxPeer_(rx);
  }

  function createRxPeer_(r) {
    if (rx !== r) return;
    var p;
    try { p = new Peer(peerOptions_()); } catch (e) { emitRx_(r, 'error', String(e)); scheduleRxRetry_(r, true); return; }
    r.peer = p;
    p.on('open', function (id) { log_('RX terdaftar di PeerServer sebagai', id, '-> mendaftar ke host', r.room); if (rx === r && r.peer === p) connectHost_(r); });
    p.on('call', function (call) {
      if (rx !== r || r.peer !== p) { safeClose(call); return; }
      // Hanya terima panggilan dari host room ini (bukan peer sembarang).
      if (call.peer !== r.room) { log_('RX: panggilan dari peer asing ditolak', call.peer); safeClose(call); return; }
      log_('RX: panggilan masuk dari host', call.peer);
      if (r.call && r.call !== call) safeClose(r.call);
      r.call = call;
      call.answer();   // TANPA stream: penerima tidak mengirim apa pun (one-way)
      sendRx_(r, 'calling');
      watchIce_(call, 'RX<-host', function (st) { if (rx === r && r.call === call && st === 'failed') sendRx_(r, 'failed'); });
      call.on('stream', function (remoteStream) {
        if (rx !== r || r.call !== call) return;
        log_('RX: stream diterima, track audio:', remoteStream.getAudioTracks().length);
        r.playing = true;
        r.audioFlowing = false;
        playIncoming_(r, remoteStream);
        emitRx_(r, 'stream', remoteStream);
        sendRx_(r, 'stream');
        // M0: 'audio' dilaporkan hanya bila paket audio BENAR-BENAR masuk (track unmuted) -> pengirim tahu suaranya sampai.
        var tr = remoteStream.getAudioTracks()[0];
        if (tr) {
          var flowing = function () { if (rx !== r || r.call !== call) return; r.audioFlowing = true; sendRx_(r, r.audio && r.audio.paused ? 'blocked' : 'audio'); };
          if (!tr.muted) flowing(); else tr.onunmute = flowing;
          tr.onmute = function () { if (rx === r && r.call === call) { r.audioFlowing = false; sendRx_(r, 'stream'); } };
        }
      });
      var ended = function () {
        if (rx !== r || r.call !== call) return;
        r.call = null;
        var was = r.playing;
        r.playing = false;
        r.audioFlowing = false;
        clearAudio_(r);
        sendRx_(r, 'end');
        if (was) emitRx_(r, 'end');
      };
      call.on('close', ended);
      call.on('error', ended);
    });
    p.on('disconnected', function () {
      if (rx !== r || r.peer !== p) return;
      try { if (!p.destroyed) p.reconnect(); } catch (e) {}
    });
    p.on('error', function (err) {
      if (rx !== r || r.peer !== p) return;
      var type = (err && err.type) || String(err);
      log_('RX peer error:', type, err && err.message);
      if (type === 'peer-unavailable') {
        // Host (pengirim) belum online untuk room ini -> coba lagi nanti.
        emitRx_(r, 'waiting');
        scheduleRxRetry_(r, false);
        return;
      }
      emitRx_(r, 'error', type);
      scheduleRxRetry_(r, true);
    });
  }

  /** M0: kirim laporan state ke host lewat data-connection (diabaikan diam-diam bila belum tersambung). */
  function sendRx_(r, state) {
    try { if (r && r.conn && r.conn.open) r.conn.send({ type: 'rx-state', state: state }); } catch (e) {}
  }
  function connectHost_(r) {
    if (rx !== r || !r.peer || !r.peer.open) return;
    if (r.conn) { safeClose(r.conn); r.conn = null; }
    var c = null;
    try { c = r.peer.connect(r.room, { reliable: true, serialization: 'json' }); } catch (e) { c = null; }
    if (!c) { scheduleRxRetry_(r, false); return; }
    r.conn = c;
    c.on('open', function () { log_('RX: data-connection ke host terbuka'); if (rx === r && r.conn === c) emitRx_(r, 'connected'); });
    c.on('data', function (msg) {
      // Jawaban protokol ambil alih dari host (lihat handleHostMessage_).
      if (rx !== r || !r.takeoverCb || !msg || typeof msg.type !== 'string' || msg.type.indexOf('takeover-') !== 0) return;
      var cb = r.takeoverCb; r.takeoverCb = null; cb(msg);
    });
    var lost = function () {
      if (rx !== r || r.conn !== c) return;
      r.conn = null;
      // Host hilang mendadak (tab ditutup / jaringan putus) -> tutup juga panggilan media yang mungkin masih
      // "menggantung", supaya isReceiving() kembali false dan siren+TTS di penerima TIDAK terkunci senyap.
      if (r.call) { var stale = r.call; r.call = null; var was = r.playing; r.playing = false; clearAudio_(r); safeClose(stale); if (was) emitRx_(r, 'end'); }
      emitRx_(r, 'waiting');
      scheduleRxRetry_(r, false);
    };
    c.on('close', lost);
    c.on('error', lost);
  }

  function scheduleRxRetry_(r, recreatePeer) {
    if (rx !== r || r.retryTimer) return;
    r.retryTimer = setTimeout(function () {
      r.retryTimer = null;
      if (rx !== r) return;
      if (recreatePeer || !r.peer || r.peer.destroyed) {
        var old = r.peer; r.peer = null; safeDestroy(old);
        createRxPeer_(r);
      } else if (r.peer.disconnected) {
        try { r.peer.reconnect(); } catch (e) {}
        scheduleRxRetry_(r, false);
      } else {
        connectHost_(r);
      }
    }, RX_RETRY_MS);
  }

  function playIncoming_(r, stream) {
    if (!r.audio) {
      var a = document.createElement('audio');
      a.autoplay = true;
      a.playsInline = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      document.body.appendChild(a);
      r.audio = a;
    }
    try { r.audio.srcObject = stream; } catch (e) {}
    r.audio.volume = 1.0;
    var p = null;
    try { p = r.audio.play(); } catch (e) { p = Promise.reject(e); }
    if (p && p.catch) p.catch(function (err) { log_('RX: autoplay diblokir -> tombol AKTIFKAN SUARA PENGIRIM', err && err.name); emitRx_(r, 'blocked'); sendRx_(r, 'blocked'); });
  }
  function clearAudio_(r) {
    if (!r.audio) return;
    try { r.audio.pause(); r.audio.srcObject = null; } catch (e) {}
    try { r.audio.remove(); } catch (e) {}
    r.audio = null;
  }
  /**
   * PENERIMA: minta AMBIL ALIH mikrofon dari host saat ini (semua perangkat boleh bicara, satu per waktu).
   * Resolve: 'ok' (host melepas ID; lanjutkan dengan stopListen() + hostOpen(room, cb, {fast:true})),
   *          'talking' (host sedang bicara, tidak boleh dipotong), 'no-conn' (belum tersambung ke host),
   *          'timeout' / 'send-failed'. Tidak pernah reject.
   */
  function requestTakeover(timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    return new Promise(function (resolve) {
      var r = rx;
      if (!r || !r.conn || !r.conn.open) return resolve('no-conn');
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; if (r.takeoverCb) r.takeoverCb = null; resolve('timeout'); } }, timeoutMs);
      r.takeoverCb = function (msg) {
        if (done) return; done = true; clearTimeout(t);
        resolve(msg.type === 'takeover-ok' ? 'ok' : (msg.reason || 'denied'));
      };
      log_('RX: meminta ambil alih mikrofon dari host');
      try { r.conn.send({ type: 'takeover' }); } catch (e) { done = true; clearTimeout(t); r.takeoverCb = null; resolve('send-failed'); }
    });
  }

  /** PENERIMA: panggil dari klik (gesture) bila autoplay diblokir -> putar ulang audio yang masuk. */
  function resumePlayback() {
    if (!rx || !rx.audio) return Promise.resolve(false);
    var p = null;
    var r = rx;
    try { p = rx.audio.play(); } catch (e) { return Promise.resolve(false); }
    return (p && p.then ? p.then(function () { return true; }, function () { return false; }) : Promise.resolve(true))
      .then(function (ok) { if (ok && rx === r) sendRx_(r, r.audioFlowing ? 'audio' : 'stream'); return ok; });
  }

  function stopListen() {
    var r = rx;
    if (!r) return;
    rx = null;
    if (r.retryTimer) { clearTimeout(r.retryTimer); r.retryTimer = null; }
    safeClose(r.call);
    safeClose(r.conn);
    clearAudio_(r);
    safeDestroy(r.peer);
  }

  // =========================== UMUM ===========================
  // =========================== DIAGNOSTIK (jalankan dari Console F12) ===========================
  /** Snapshot lengkap state host & penerima: AlarmVoice.debugInfo() */
  function debugInfo() {
    var info = { available: available(), micAvailable: micAvailable(), micState: micState, peerLib: typeof Peer, iceServers: iceServerUrls_(),
      turnConfigured: hasTurnConfigured_(), iceTransportPolicy: iceTransportPolicy_(), forceRelay: forceRelay_(), host: null, rx: null };
    if (host) {
      info.host = {
        room: host.room, state: host.state, peerOpen: !!(host.peer && host.peer.open), talking: host.talking,
        policyAtCreate: host.policyAtCreate || null, iceFailures: host.iceFailures || 0,
        micTracks: host.stream ? host.stream.getAudioTracks().map(function (t) { return { label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState }; }) : [],
        receivers: Object.keys(host.conns),
        rxState: rxStates(), hearing: hearingCount(),
        calls: Object.keys(host.calls).map(function (id) {
          var c = host.calls[id], pc = c && c.peerConnection;
          return { to: id, open: !!(c && c.open), ice: pc ? pc.iceConnectionState : null, connection: pc ? pc.connectionState : null };
        })
      };
    }
    if (rx) {
      var pc = rx.call && rx.call.peerConnection, a = rx.audio;
      info.rx = {
        room: rx.room, peerId: rx.peer ? rx.peer.id : null, peerOpen: !!(rx.peer && rx.peer.open),
        dataConnOpen: !!(rx.conn && rx.conn.open), callActive: !!rx.call,
        ice: pc ? pc.iceConnectionState : null, connection: pc ? pc.connectionState : null, playing: rx.playing, audioFlowing: !!rx.audioFlowing,
        audio: a ? { paused: a.paused, muted: a.muted, volume: a.volume, hasStream: !!a.srcObject, tracks: a.srcObject ? a.srcObject.getAudioTracks().length : 0, readyState: a.readyState } : null
      };
    }
    return info;
  }
  /**
   * Uji loopback MANDIRI tanpa mikrofon & tanpa PC kedua: AlarmVoice.selfTest().then(console.log)
   * Dua Peer sementara dibuat di halaman ini: B mendaftar ke A (pola sama dengan penerima->host), A memanggil B dengan
   * nada 440 Hz sintetis. ok=true bila B menerima track audio dan ICE tersambung. Menjawab tegas apakah PeerJS Cloud
   * (signaling) DAN jalur media WebRTC bisa dipakai dari jaringan/PC ini. Gagal di langkah mana tercatat di 'steps'.
   */
  function selfTest(timeoutMs) {
    timeoutMs = timeoutMs || 20000;
    return new Promise(function (resolve) {
      var rep = { ok: false, steps: [], error: null, ms: 0 };
      var t0 = Date.now(), done = false, A = null, B = null, ctx = null, osc = null, timer = null;
      function step(s) { rep.steps.push((Date.now() - t0) + ' ms: ' + s); }
      function finish(ok, err) {
        if (done) return; done = true;
        if (timer) clearTimeout(timer);
        rep.ok = ok; if (err) rep.error = String(err); rep.ms = Date.now() - t0;
        try { if (osc) osc.stop(); } catch (e) {} try { if (ctx) ctx.close(); } catch (e) {}
        safeDestroy(A); safeDestroy(B);
        resolve(rep);
      }
      if (!available()) return finish(false, 'PeerJS tidak termuat / WebRTC tidak tersedia');
      timer = setTimeout(function () { finish(false, 'timeout ' + timeoutMs + ' ms; langkah terakhir: ' + (rep.steps[rep.steps.length - 1] || 'belum ada (PeerServer tidak menjawab -> WebSocket ke 0.peerjs.com diblokir?)')); }, timeoutMs);
      var stream;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        var dest = ctx.createMediaStreamDestination();
        osc = ctx.createOscillator(); osc.frequency.value = 440; osc.connect(dest); osc.start();
        stream = dest.stream;
      } catch (e) { return finish(false, 'gagal membuat stream sintetis: ' + e); }
      var roomId = 'rsab-selftest-' + Math.random().toString(36).slice(2, 10);
      A = new Peer(roomId, peerOptions_());
      A.on('error', function (e) { step('A error: ' + (e && e.type)); finish(false, 'host peer error: ' + (e && e.type) + ' ' + (e && e.message || '')); });
      A.on('open', function () {
        step('A (host) terdaftar di PeerServer -> signaling OK');
        B = new Peer(peerOptions_());
        B.on('error', function (e) { step('B error: ' + (e && e.type)); finish(false, 'receiver peer error: ' + (e && e.type) + ' ' + (e && e.message || '')); });
        B.on('call', function (call) {
          step('B menerima panggilan dari ' + call.peer);
          call.answer();
          try {
            var pcB = call.peerConnection;
            pcB.addEventListener('iceconnectionstatechange', function () {
              step('B ICE: ' + pcB.iceConnectionState);
              if (pcB.iceConnectionState === 'failed') finish(false, 'ICE failed: NAT/firewall menghalangi media (butuh TURN server)');
            });
          } catch (e) {}
          call.on('stream', function (s) {
            var n = s.getAudioTracks().length;
            step('B menerima stream, track audio: ' + n);
            if (n) finish(true);
          });
          call.on('error', function (e) { finish(false, 'call error: ' + e); });
        });
        B.on('open', function () {
          step('B (penerima) terdaftar -> mendaftar ke A');
          var c = B.connect(roomId, { reliable: true });
          c.on('open', function () { step('data-connection B->A terbuka'); });
          c.on('error', function (e) { step('data-connection error: ' + e); });
        });
      });
      A.on('connection', function (conn) {
        step('A menerima pendaftaran dari ' + conn.peer + ' -> memanggil dengan nada 440 Hz');
        var call = A.call(conn.peer, stream);
        try { var pcA = call.peerConnection; pcA.addEventListener('iceconnectionstatechange', function () { step('A ICE: ' + pcA.iceConnectionState); }); } catch (e) {}
        call.on('error', function (e) { finish(false, 'host call error: ' + e); });
      });
    });
  }

  function isTalking() { return !!(host && host.talking && host.stream); }
  function isReceiving() { return !!(rx && rx.playing); }
  /** true bila suara live sedang berjalan (bicara ATAU menerima) -> siren+TTS jangan dimulai ulang dulu. */
  function isBusy() { return talkStarting || isTalking() || isReceiving(); }
  function hostState() { return host ? host.state : null; }
  function destroyAll() { hostClose(); stopListen(); }

  // Lepaskan ID room di server signaling saat halaman BENAR-BENAR ditutup/di-refresh. Dipakai pagehide, bukan
  // beforeunload: beforeunload bisa dibatalkan user lewat dialog konfirmasi dan halaman tetap hidup — kita hanya
  // ingin destroyAll saat halaman sungguh ditinggalkan. Setelah refresh, halaman baru membuat host/penerima lagi
  // lewat syncVoiceUI()/setupVoice(); penerima lain menyambung ulang otomatis (retry 5 detik).
  window.addEventListener('pagehide', destroyAll);

  return {
    available: available, micAvailable: micAvailable,
    requestMicPermission: requestMicPermission, probeMicPermission: probeMicPermission, micPermissionState: micPermissionState,
    hostOpen: hostOpen, hostClose: hostClose, startTalk: startTalk, stopTalk: stopTalk,
    listen: listen, stopListen: stopListen, resumePlayback: resumePlayback, requestTakeover: requestTakeover,
    isTalking: isTalking, isReceiving: isReceiving, isBusy: isBusy,
    receiverCount: receiverCount, hearingCount: hearingCount, rxStates: rxStates, hostState: hostState, destroyAll: destroyAll,
    debugInfo: debugInfo, selfTest: selfTest, iceTest: iceTest, iceServerUrls: iceServerUrls_,
    iceTransportPolicy: iceTransportPolicy_, setForceRelay: setForceRelay, hasTurnConfigured: hasTurnConfigured_
  };
})();