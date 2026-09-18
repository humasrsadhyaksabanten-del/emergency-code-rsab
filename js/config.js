// ===================== KONFIGURASI FRONT-END (GitHub Pages) =====================
// Ganti APPS_SCRIPT_URL bila Anda membuat deployment Apps Script BARU (URL /exec berubah). Deployment harus:
// Execute as = Me, Who has access = Anyone. Cek cepat: buka APPS_SCRIPT_URL + '?api=ping' di browser -> JSON {"ok":true}.
var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxlqDfnfyjqKeTv617LRxDa8ibple_N9MYoU8NPEk3Ma8FU08WN97RNp70yYd8B0wdM/exec';

// Halaman alarm mode TAB (legacy, hanya bila localStorage cb_inline_mode = '0'). Default aplikasi: inline (overlay).
var APP_URL = 'alarm.html';

// Nilai default; ditimpa otomatis oleh server (getClientConfig) saat halaman dimuat, supaya CONFIG di Code.gs tetap
// menjadi satu sumber kebenaran (template TTS, interval polling, dsb.).
var APP_CONFIG = {
  pollDashboardMs: 1000,
  pollAlarmMs: 1000,
  ttsTemplate: '{code}, {code}, {code}, {gedung}',
  ttsLang: 'id-ID',
  ttsRate: 1.0,
  announceMaxLen: 200,
  announceTemplate: 'Pengumuman dari {instalasi}. {text}. Sekali lagi. {text}.',
  pagingTtsTemplate: 'Paging, paging, paging, {gedung}',
  // M0 (BICARA MANUAL): server TURN/STUN milik RS. Normalnya DIISI DI Code.gs (CONFIG.ICE_SERVERS) dan ditimpa dari
  // server saat halaman dimuat; isi di sini hanya bila ingin memaksa tanpa redeploy Apps Script. Format WebRTC:
  //   [{ urls: 'turns:turn.rs.example:443?transport=tcp', username: 'u', credential: 'p' }]
  iceServers: [],
  // 'all' (default) atau 'relay' (paksa lewat TURN; hanya berlaku bila iceServers berisi turn:/turns:). Ditimpa dari Code.gs.
  iceTransportPolicy: 'all'
};