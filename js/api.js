// ===================== API: pengganti google.script.run untuk front-end di luar Apps Script =====================
// api.call('namaFungsi', arg1, arg2, ...) -> Promise hasil fungsi server (Code.gs doPost).
//  - POST dengan Content-Type text/plain = "simple request": browser tidak mengirim preflight OPTIONS (Apps Script
//    tidak bisa menjawabnya). Apps Script menambahkan Access-Control-Allow-Origin: * otomatis.
//  - Apps Script membalas POST dengan redirect 302 ke script.googleusercontent.com; fetch mengikutinya (redirect: follow).
//  - Server membungkus hasil: { __result } atau { __error }. __error -> Promise ditolak dengan Error(pesan), sama
//    seperti withFailureHandler dulu, sehingga isSessionError('SESI_TIDAK_VALID') di klien tetap bekerja.
var api = (function () {
  var TIMEOUT_MS = 30000;
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS) : null;
    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, args: args }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' dari Apps Script');
      return r.text();
    }).then(function (t) {
      var d;
      try { d = JSON.parse(t); } catch (e) {
        throw new Error('Respons server bukan JSON. Pastikan APPS_SCRIPT_URL benar dan deployment diakses "Anyone".');
      }
      if (d && d.__error) throw new Error(d.__error);
      return (d && Object.prototype.hasOwnProperty.call(d, '__result')) ? d.__result : d;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('Server tidak merespons (timeout ' + (TIMEOUT_MS / 1000) + ' dtk).');
      throw err;
    });
  }
  return { call: call, url: function () { return APPS_SCRIPT_URL; } };
})();