# =====================================================================================================
# BUILD FRONT-END STATIS (GitHub Pages) DARI SUMBER APPS SCRIPT
# Jalankan setiap kali file Apps Script (Index.html, Alarm.html, Script.html, Audio.html, Voice.html,
# Peta.html, Styles.html) diubah:
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-docs.ps1
# Hasil: folder docs\ (index.html, alarm.html, css\, js\). Transformasi otomatis: buang tag <script>/<style>/
# template <?!= ?>, ganti google.script.run -> api.call, bootstrap alarm.js dari query string.
# Jangan edit docs\*.html dan docs\js\{dashboard,alarm,peta,audio,voice}.js secara manual - edit sumbernya lalu
# build ulang. File yang BOLEH diedit manual: docs\js\config.js, docs\js\api.js, docs\manifest.json, docs\sw.js.
# =====================================================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$docs = Join-Path $root 'docs'
New-Item -ItemType Directory -Force (Join-Path $docs 'css') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $docs 'js') | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)
$NL = "`n"
# M24: cache buster — stempel versi build ditempel ke URL css/js supaya PC nurse station tidak memakai JS lama
# (GitHub Pages mengirim max-age=600; sw.js network-only, tetapi HTTP cache browser tetap berlaku).
$VER = Get-Date -Format 'yyyyMMddHHmm'

function WriteOut($path, $text) { [System.IO.File]::WriteAllText($path, $text, $enc) }
function ReadSrc($name) { [System.IO.File]::ReadAllText((Join-Path $root $name)) }
function Strip($s, $open, $close) {
  $m = [regex]::Match($s, "(?s)$open(.*?)$close")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  throw "Blok $open tidak ditemukan"
}
function MustReplace($text, $old, $new, $label) {
  if ($text.IndexOf($old) -lt 0) { throw "Transformasi gagal: '$label' tidak ditemukan di sumber (kode berubah? perbarui tools\build-docs.ps1)" }
  return $text.Replace($old, $new)
}

# ---------- CSS ----------
WriteOut (Join-Path $docs 'css\styles.css') (Strip (ReadSrc 'Styles.html') '<style>' '</style>')
$peta = ReadSrc 'Peta.html'
WriteOut (Join-Path $docs 'css\peta.css') (Strip $peta '<style>' '</style>')

# ---------- Peta: fragmen HTML + JS ----------
$petaHtml = [regex]::Match($peta, '(?s)</style>\s*(.*?)\s*<script>').Groups[1].Value.Trim()
$petaJs = Strip $peta '<script>' '</script>'
$oldPetaLoader = @'
    if (!(window.google && google.script && google.script.run)) return;
    google.script.run
      .withSuccessHandler(function (m) {
        if (!m) return;
        Object.keys(m).forEach(function (k) { GEDUNG_MAP[k] = m[k]; });
      })
      .withFailureHandler(function () {})
      .getGedungMap();
'@
$newPetaLoader = @'
    // GITHUB PAGES: lewat api.js (fetch ke Apps Script), bukan google.script.run.
    if (typeof api === 'undefined' || !api.call) return;
    api.call('getGedungMap').then(function (m) {
      if (!m) return;
      Object.keys(m).forEach(function (k) { GEDUNG_MAP[k] = m[k]; });
    }).catch(function () {});
'@
$petaJs = MustReplace $petaJs $oldPetaLoader $newPetaLoader 'peta loader'
WriteOut (Join-Path $docs 'js\peta.js') $petaJs

# ---------- Modul JS apa adanya ----------
WriteOut (Join-Path $docs 'js\audio.js') (Strip (ReadSrc 'Audio.html') '<script>' '</script>')
WriteOut (Join-Path $docs 'js\voice.js') (Strip (ReadSrc 'Voice.html') '<script>' '</script>')

# ---------- dashboard.js (Script.html) ----------
$dash = Strip (ReadSrc 'Script.html') '<script>' '</script>'
$oldDashCall = @'
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var r = google.script.run.withSuccessHandler(resolve).withFailureHandler(reject);
      r[fn].apply(r, args);
    });
  }
'@
$newDashCall = @'
  // GITHUB PAGES: pengganti google.script.run -> fetch() ke Apps Script lewat api.js (kontrak sama: Promise hasil
  // fungsi; error server -> Promise ditolak dengan Error(pesan), jadi isSessionError() tetap bekerja).
  function call(fn) {
    return api.call.apply(null, arguments);
  }
'@
$oldDashInit = @'
  initCookieBanner();
  restoreSession();
  updateAudioBtn();
})();
'@
$newDashInit = @'
  initCookieBanner();
  // GITHUB PAGES: ambil konfigurasi dari server (CONFIG di Code.gs tetap satu sumber kebenaran) dan timpa default
  // di js/config.js. Tidak menunggu hasilnya: login/restore sesi berjalan paralel. Bila server tidak bisa dihubungi,
  // checkServer() menampilkan banner merah + COBA LAGI (M4/M8/M9).
  checkServer();
  restoreSession();
  updateAudioBtn();
})();
'@
$dash = MustReplace $dash $oldDashCall $newDashCall 'dashboard call()'
$dash = MustReplace $dash $oldDashInit $newDashInit 'dashboard init'
WriteOut (Join-Path $docs 'js\dashboard.js') $dash

# ---------- index.html ----------
$idx = ReadSrc 'Index.html'
$body = [regex]::Match($idx, '(?s)<body>\s*(.*?)\s*<script>\s*var APP_URL').Groups[1].Value
if (-not $body) { throw 'Body Index.html tidak terdeteksi' }
$body = $body.Replace("<?!= include('Peta'); ?>", $petaHtml)
$head = @'
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emergency Code RSAB - Nurse Station</title>
  <meta name="theme-color" content="#111827">
  <link rel="manifest" href="manifest.json">
  <!-- Font Inter (opsional; fallback otomatis ke Segoe UI/Roboto bila Google Fonts diblokir) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <!-- F1: favicon tab browser = logo RS (favicon-64.png); ikon PWA/home screen = ikon mic (icon-192/512.png) -->
  <link rel="icon" type="image/png" sizes="64x64" href="favicon-64.png">
  <link rel="apple-touch-icon" href="icon-192.png">
  <link rel="stylesheet" href="css/styles.css?v=__VER__">
  <link rel="stylesheet" href="css/peta.css?v=__VER__">
  <!-- PeerJS (WebRTC) untuk BICARA MANUAL. M19: salinan LOKAL dimuat lebih dulu (js/peerjs.min.js, tidak bergantung CDN
       & tidak bisa diganti pihak ketiga); bila gagal -> unpkg -> jsdelivr. Di GitHub Pages halaman ini dokumen top-level,
       jadi getUserMedia() / mikrofon BERFUNGSI. -->
  <script src="js/peerjs.min.js?v=__VER__"></script>
  <script>
    if (typeof Peer !== 'function') document.write('<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"><\/script>');
  </script>
  <script>
    if (typeof Peer !== 'function') document.write('<script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"><\/script>');
  </script>
</head>
<body>
'@
$tail = @'

  <!-- Urutan penting: config (URL Apps Script + default) -> api (fetch) -> audio -> voice -> peta -> dashboard -->
  <script src="js/config.js?v=__VER__"></script>
  <script src="js/api.js?v=__VER__"></script>
  <script src="js/audio.js?v=__VER__"></script>
  <script src="js/voice.js?v=__VER__"></script>
  <script src="js/peta.js?v=__VER__"></script>
  <script src="js/dashboard.js?v=__VER__"></script>
  <script>
    // PWA: service worker minimal (network-only, tanpa cache) supaya bisa "Add to Home Screen" dan update selalu terbaru.
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
  </script>
</body>
</html>
'@
WriteOut (Join-Path $docs 'index.html') (($head + $body + $tail).Replace('__VER__', $VER))

# ---------- alarm.html + alarm.js ----------
$al = ReadSrc 'Alarm.html'
$alStyle = Strip $al '<style>' '</style>'
$alBody = [regex]::Match($al, '(?s)<body>\s*(.*?)\s*<script>\s*var EVENT_ID').Groups[1].Value
if (-not $alBody) { throw 'Body Alarm.html tidak terdeteksi' }
$alBody = $alBody.Replace("<?!= include('Peta'); ?>", $petaHtml)
$alScripts = [regex]::Matches($al, '(?s)<script>(.*?)</script>')
$iife = $alScripts[$alScripts.Count - 1].Groups[1].Value.Trim()
$oldAlarmCall = @'
    function call(fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve, reject) {
        var r = google.script.run.withSuccessHandler(resolve).withFailureHandler(reject);
        r[fn].apply(r, args);
      });
    }
'@
$newAlarmCall = @'
    // GITHUB PAGES: pengganti google.script.run -> fetch() ke Apps Script lewat api.js.
    function call(fn) {
      return api.call.apply(null, arguments);
    }
'@
$iife = MustReplace $iife $oldAlarmCall $newAlarmCall 'alarm call()'
$iifeOpen = '(function () {'
$iifeClose = '})();'
if (-not $iife.StartsWith($iifeOpen)) { throw 'Awal IIFE Alarm.html berubah' }
if (-not $iife.EndsWith($iifeClose)) { throw 'Akhir IIFE Alarm.html berubah' }
$iifeBody = $iife.Substring($iifeOpen.Length, $iife.Length - $iifeOpen.Length - $iifeClose.Length)
$alarmBoot = @'
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
'@
$alarmJs = $alarmBoot + $iifeBody + $NL + '}' + $NL
WriteOut (Join-Path $docs 'js\alarm.js') $alarmJs
$alHead = @'
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ALARM</title>
  <link rel="icon" type="image/png" sizes="64x64" href="favicon-64.png">
  <link rel="stylesheet" href="css/peta.css?v=__VER__">
  <script src="js/peerjs.min.js?v=__VER__"></script>
  <script>
    if (typeof Peer !== 'function') document.write('<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"><\/script>');
  </script>
  <script>
    if (typeof Peer !== 'function') document.write('<script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"><\/script>');
  </script>
  <style>
'@
$alMid = @'
  </style>
</head>
<body>
'@
$alTail = @'

  <script src="js/config.js?v=__VER__"></script>
  <script src="js/api.js?v=__VER__"></script>
  <script src="js/audio.js?v=__VER__"></script>
  <script src="js/voice.js?v=__VER__"></script>
  <script src="js/peta.js?v=__VER__"></script>
  <script src="js/alarm.js?v=__VER__"></script>
</body>
</html>
'@
WriteOut (Join-Path $docs 'alarm.html') (($alHead + $alStyle + $NL + $alMid + $alBody + $alTail).Replace('__VER__', $VER))

# ---------- File statis yang dibuat sekali (boleh diedit manual) ----------
foreach ($f in @('js\config.js', 'js\api.js', 'js\peerjs.min.js', 'manifest.json', 'sw.js', '.nojekyll', 'icon-192.png', 'icon-512.png', 'favicon-64.png', 'icon-mic.png', 'logo-rsab.png', 'logo-emblem.png', 'logo-rsab.svg', 'logo-emblem.svg')) {
  if (-not (Test-Path (Join-Path $docs $f))) { Write-Warning ("docs\" + $f + " belum ada - file ini dibuat sekali oleh build awal; salin dari repositori.") }
}

Write-Host ("Build selesai -> " + $docs)
Get-ChildItem -Recurse -File $docs | Select-Object @{n='File';e={$_.FullName.Substring($docs.Length + 1)}}, Length | Format-Table -AutoSize | Out-String | Write-Host
