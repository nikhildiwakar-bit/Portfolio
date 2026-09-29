// Target of the QR code on the Office TV home screen: .../tv/phone.html#h=IP&p=PORT&k=SECRET&n=NAME.
// The TV details live only in the fragment, which browsers never send to a server; this page makes no
// requests with it and removes it from the address bar at once. It only hands it to the Office TV app.
'use strict';
(function () {
  var APP_PACKAGE = 'com.nikhil.officetv';
  var hash = location.hash.replace(/^#/, '');
  var params = {};
  hash.split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) {
      try { params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* ignore */ }
    }
  });
  if (hash && history.replaceState) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
  var valid = /^[A-Za-z0-9.:-]{1,253}$/.test(params.h || '') && /^\d{1,5}$/.test(params.p || '') &&
    /^[A-Za-z0-9_-]{43}$/.test(params.k || '');
  var ua = navigator.userAgent || '';
  var android = /Android/i.test(ua);
  var ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var show = function (id) { document.getElementById(id).hidden = false; };

  if (ios) { show('ios'); return; }
  if (!android) { show('desktop'); return; }
  show('install');
  if (/[?&]install=1/.test(location.search)) return; // Fallback from the intent link: the app is not installed.
  if (!hash) return;
  if (!valid) { show('bad'); return; }

  var name = (params.n || 'Office TV').slice(0, 40);
  document.getElementById('tvName').textContent = name;
  var query = 'h=' + encodeURIComponent(params.h) + '&p=' + params.p + '&k=' + params.k + '&n=' + encodeURIComponent(name);
  // No fragment in the fallback: if the app is missing, the browser opens this page with ?install=1 only.
  var fallback = location.origin + location.pathname + '?install=1';
  var intent = 'intent://connect?' + query + '#Intent;scheme=officetvphone;package=' + APP_PACKAGE +
    ';S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
  var btn = document.getElementById('openBtn');
  btn.href = intent;
  show('open');
  document.getElementById('install').querySelector('h1').textContent = 'Not installed yet?';
  // Try at once; Chrome may require a tap, which the button covers.
  setTimeout(function () { location.href = intent; }, 50);
})();
