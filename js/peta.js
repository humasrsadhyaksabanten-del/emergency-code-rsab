/**
 * Mapping nama Gedung (sesuai kolom "Gedung" di sheet Users) -> nomor & posisi di peta.
 * x, y = persentase posisi (0-100) relatif terhadap gambar denah.
 * SESUAIKAN nilai x,y ini jika penempatan marker meleset dari gambar aslimu.
 * (Nilai awal diperkirakan dari foto denah yang kamu tandai nomor 1-9.)
 */
var GEDUNG_MAP = {
  'A':                    { no: 1, x: 50, y: 70 },
  'B':                    { no: 2, x: 37, y: 75 },
  'C':                    { no: 3, x: 30, y: 58 },
  'D':                    { no: 4, x: 32, y: 22 },
  'E':                    { no: 5, x: 51, y: 19 },
  'F':                    { no: 6, x: 68, y: 42 },
  'PEMULASARAN JENAZAH':  { no: 7, x: 73, y: 71 },
  'LAUNDRY':              { no: 8, x: 67, y: 61 },
  'GIZI':                 { no: 9, x: 63, y: 60 }
};

var PETA_VB_W = 1024, PETA_VB_H = 685;
var petaCurrentGedung = null;

// BARU: cache busting gambar denah. Naikkan PETA_IMG_VERSION setiap kali file denah di Drive diganti,
// supaya browser tidak memakai gambar lama dari cache.
var PETA_IMG_URL = 'https://lh3.googleusercontent.com/d/1vMv3yLH0L0rVquOyB7EFkq2sp2qwjTsp';
var PETA_IMG_VERSION = '2';
(function setPetaImg() {
  try {
    var img = document.getElementById('petaImg');
    if (img) img.src = PETA_IMG_URL + (PETA_IMG_URL.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(PETA_IMG_VERSION);
  } catch (e) {}
})();

/**
 * Opsional: tambah/timpa GEDUNG_MAP dari sheet "Gedung" (kolom: Nama, X, Y, No) lewat Code.gs getGedungMap().
 * Dengan ini gedung baru cukup ditambahkan di spreadsheet, tanpa mengedit kode.
 * Bila sheet tidak ada atau panggilan gagal, GEDUNG_MAP bawaan di atas tetap dipakai.
 */
(function loadGedungMapFromSheet() {
  try {
    // GITHUB PAGES: lewat api.js (fetch ke Apps Script), bukan google.script.run.
    if (typeof api === 'undefined' || !api.call) return;
    api.call('getGedungMap').then(function (m) {
      if (!m) return;
      Object.keys(m).forEach(function (k) { GEDUNG_MAP[k] = m[k]; });
    }).catch(function () {});
  } catch (e) {}
})();

/** Buang prefix "Gedung " (kalau ada) & samakan huruf besar, supaya
 *  "Gedung A", "gedung a", atau "A" semuanya cocok ke key yang sama. */
/** Samakan "Gedung A", "gedung a", "A Lantai 2", "A LT.3", "A-L2", dst -> semua jadi key "A"
 *  supaya lantai berapa pun di gedung yang sama tetap menunjuk ke marker gedung itu. */
function normalizeGedung_(s) {
  var v = String(s || '').trim().toUpperCase();
  v = v.replace(/^GEDUNG\s+/, '');                 // buang prefix "GEDUNG "
  v = v.replace(/\s*[-,]\s*LANTAI\s*\d+.*$/, '');   // "A - Lantai 2" / "A, Lantai 2"
  v = v.replace(/\s+LANTAI\s*\d+.*$/, '');          // "A Lantai 2"
  // Sufiks lantai HANYA dibuang bila didahului pemisah (spasi / "-" / ","), supaya nama gedung yang
  // memang diawali huruf L + angka (mis. "L2" saja) tidak terpotong jadi string kosong.
  v = v.replace(/(?:\s+|\s*[-,]\s*)LT\.?\s*\d+.*$/, '');   // "A LT.2" / "A LT 2" / "A-LT2"
  v = v.replace(/(?:\s+|\s*[-,]\s*)L\d+.*$/, '');          // "A L2" / "A-L2"
  return v.trim();
}

/** Titik marker untuk nama gedung. Gedung yang tidak terdaftar -> fallback ke tengah peta + flag unknown. */
function petaPointFor_(nama) {
  var key = normalizeGedung_(nama);
  var g = GEDUNG_MAP[key];
  if (!g) {
    console.warn('[Peta] Nama gedung tidak dikenali di GEDUNG_MAP:', JSON.stringify(nama), '-> key dicoba:', key, '(pakai posisi tengah peta)');
    return { x: PETA_VB_W / 2, y: PETA_VB_H / 2, no: null, unknown: true };
  }
  return { x: (g.x / 100) * PETA_VB_W, y: (g.y / 100) * PETA_VB_H, no: g.no, unknown: false };
}

/** Dipanggil dari render() di Alarm.html setiap kali data event berubah. */
function renderPeta(ev) {
  try {
    var box = document.getElementById('petaContainer');
    if (!box) return;
    if (!ev || !ev.gedung) { box.classList.remove('show'); return; }

    // BARU (Server Paging): bila event punya targetGedung (array), tampilkan marker + lubang spotlight untuk SETIAP
    // gedung tujuan; gedung pertama mendapat cincin & garis penunjuk. Tanpa targetGedung -> gedung pengirim seperti biasa.
    var namaList = (ev.targetGedung && ev.targetGedung.length) ? ev.targetGedung.slice(0, 20) : [ev.gedung];
    var points = namaList.map(function (n) { return petaPointFor_(n); });
    var pt = points[0];
    if (!pt) { box.classList.remove('show'); return; }

    var warna = ev.warna || '#e53935';
    var svgNS = 'http://www.w3.org/2000/svg';

    document.getElementById('petaSpotHole').setAttribute('cx', pt.x);
    document.getElementById('petaSpotHole').setAttribute('cy', pt.y);
    // Lubang spotlight & marker tambahan (gedung ke-2 dst) dibuat ulang setiap render.
    var mask = document.getElementById('petaSpotlight');
    var svg = document.getElementById('petaSvg');
    Array.prototype.forEach.call(svg.querySelectorAll('.peta-extra'), function (n) { n.parentNode.removeChild(n); });
    var marker = document.getElementById('petaMarker');
    for (var i = 1; i < points.length; i++) {
      var hole = document.createElementNS(svgNS, 'circle');
      hole.setAttribute('class', 'peta-extra'); hole.setAttribute('cx', points[i].x); hole.setAttribute('cy', points[i].y); hole.setAttribute('r', 95); hole.setAttribute('fill', '#000');
      mask.appendChild(hole);
      var m2 = marker.cloneNode(true);
      m2.removeAttribute('id'); m2.setAttribute('class', 'peta-extra'); m2.setAttribute('id', 'petaMarkerExtra' + i);
      m2.setAttribute('transform', 'translate(' + points[i].x + ',' + points[i].y + ')');
      m2.querySelector('.marker-dot').setAttribute('fill', warna);
      m2.querySelector('.marker-pulse').setAttribute('fill', warna);
      m2.style.opacity = '1';
      svg.appendChild(m2);
    }

    var hi = document.getElementById('petaHighlight');
    hi.setAttribute('cx', pt.x);
    hi.setAttribute('cy', pt.y);
    hi.setAttribute('stroke', warna);

    marker.setAttribute('transform', 'translate(' + pt.x + ',' + pt.y + ')');
    marker.querySelector('.marker-dot').setAttribute('fill', warna);
    marker.querySelector('.marker-pulse').setAttribute('fill', warna);

    var line = document.getElementById('petaLine');
    var cx = PETA_VB_W / 2, cy = PETA_VB_H / 2;
    var len = Math.hypot(pt.x - cx, pt.y - cy) || 1;
    line.setAttribute('x1', cx); line.setAttribute('y1', cy);
    line.setAttribute('x2', pt.x); line.setAttribute('y2', pt.y);
    line.setAttribute('stroke-dasharray', len);
    line.style.setProperty('--peta-line-len', len);
    line.setAttribute('stroke', warna);

       var badge = document.getElementById('petaLabelBadge');
    if (badge) {
      badge.style.setProperty('--peta-badge-color', warna);
      var plCode = document.getElementById('plCode');
      var plGedung = document.getElementById('plGedung');
      var plInst = document.getElementById('plInst');
      if (plCode) plCode.textContent = ev.namaCode || ev.kodeCode || '';
      if (plGedung) {
        plGedung.textContent = namaList.length > 1
          ? ('Gedung ' + namaList.join(', '))
          : ((namaList[0] || '') + (pt.unknown ? ' (tidak terdaftar di peta)' : ''));
      }
      if (plInst) plInst.textContent = (ev.namaInstalasi || '') + (namaList.length > 1 ? ' · paging ' + namaList.length + ' gedung' : '');
    }

    var petaKey = namaList.join(',') + '|' + ev.eventId;
    if (petaCurrentGedung !== petaKey) {
      petaCurrentGedung = petaKey;
      box.classList.remove('show');
      void box.offsetWidth;
      box.classList.add('show');
    }
  } catch (e) {
    console.warn('[Peta] renderPeta gagal, dilewati supaya tidak mengganggu alarm/suara:', e);
  }
}

/** Dipanggil dari finish() di Alarm.html saat alarm dihentikan. */
function stopPeta() {
  try {
    petaCurrentGedung = null;
    var box = document.getElementById('petaContainer');
    if (box) box.classList.remove('show');
  } catch (e) {}
}