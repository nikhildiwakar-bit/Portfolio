// Lets 'node --test tv-app/tests/web/' (a directory) run the browser tests. Both files share one
// Chromium and one mock relay (harness.mjs).
import './site.test.mjs';
import './cast.test.mjs';
