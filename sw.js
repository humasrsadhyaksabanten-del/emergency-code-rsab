// Service worker MINIMAL untuk PWA (Add to Home Screen). Sengaja TANPA cache (network-only) supaya setiap perubahan
// di GitHub Pages langsung terlihat dan tidak ada JS lama tersisa. Kelak bisa dipakai untuk Web Push.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* passthrough: biarkan browser mengambil dari jaringan */ });