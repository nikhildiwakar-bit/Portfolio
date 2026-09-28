// Browser tests for the website's own screens (tv/index.html + tv/app.js): first visit, code checks,
// saved TVs, pairing links, unsupported browsers, storage fallback, English-only text and layout.
// Real screen sharing between two pages is in cast.test.mjs. Run: node --test tv-app/tests/web/
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CODE_A, CODE_B, HINGLISH, RECORD_DISPLAY, REPO, SHOTS, acquire, assertLayout, open, pageText, release, reset, savedTvs, sleep,
    text, until,
} from './harness.mjs';

let E;
before(async () => { E = await acquire(); });
after(release);
beforeEach(reset);

const RELAY = 'https://ntfy.sh';
const A = { name: 'Conference Room', code: CODE_A, relay: RELAY };
const B = { name: 'Reception', code: CODE_B, relay: RELAY };
const FAST = () => { window.__otvTest = { ackTimeoutMs: 1500, pingTimeoutMs: 1500 }; };
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('officetv.tvs') || '[]'));
const gdmCalls = page => page.evaluate(() => window.__gdm.calls.length);

test('first visit: a clean form; bad codes are explained without opening the picker or using the relay', async () => {
    const page = await open({ init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    assert.equal(await text(page, 'h1'), 'Show your laptop screen on the office TV');
    assert.ok(await page.isVisible('#setupCard'));
    assert.ok(await page.isHidden('#homeCard'));
    assert.equal(await text(page, '#connectBtn'), 'Connect and share screen');
    assert.equal(await text(page, '#setupTitle'), 'Connect to a TV');
    assert.ok(await page.isHidden('#setupBackRow'), 'nothing to go back to');

    await page.click('#connectBtn');
    assert.match(await text(page, '#codeErr'), /^Type the TV code/);
    assert.equal(await page.getAttribute('#code', 'aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'code');

    await page.fill('#code', '7K3M9');
    assert.equal(await text(page, '#codeHint'), '5 of 10 characters');
    await page.press('#code', 'Enter');
    assert.equal(await text(page, '#codeErr'), 'A TV code has 10 characters. This one has 5.');

    await page.fill('#code', '7K3M9-QX2TU');
    assert.match(await text(page, '#codeErr'), /never contain the letter U/, 'explained while typing');
    await page.fill('#code', '7K3M9-QX2T#');
    assert.match(await text(page, '#codeErr'), /only use the letters A to Z and the numbers 0 to 9/);
    await page.fill('#code', 'https://nikhildiwakar-bit.github.io/Portfolio/tv/#pair=7K3M9');
    assert.match(await text(page, '#codeHint'), /link is incomplete/);

    // Lower case, spaces and O for 0 are all fine.
    await page.fill('#code', '7k3m9 qx2td');
    assert.equal(await text(page, '#codeHint'), 'Looks good: 7K3M9-QX2TD');
    assert.ok(await page.isHidden('#codeErr'));
    assert.equal(await page.getAttribute('#code', 'aria-invalid'), null);

    assert.equal(await gdmCalls(page), 0, 'the screen picker never opened for a bad code');
    assert.equal(E.relay.requests.length, 0, 'a first visit uses no relay at all');
    await page.done();
});

test('a TV that does not answer: clear message, nothing saved, the capture is released', async () => {
    const page = await open({ init: [RECORD_DISPLAY, FAST] });
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', 'q4w8z-2m6n0');
    await page.fill('#tvName', 'Reception');
    await page.click('#connectBtn');
    await page.waitForSelector('#setupErr', { state: 'visible', timeout: 15000 });
    assert.equal(await text(page, '#setupErrTitle'), 'The TV did not answer.');
    assert.match(await text(page, '#setupErrText'), /Check that the code matches the one on the TV/);
    assert.ok(await page.isVisible('#setupCard'), 'back on the form, ready to fix the code');
    assert.equal(await page.inputValue('#code'), 'q4w8z-2m6n0');
    assert.equal(await page.inputValue('#tvName'), 'Reception');
    assert.deepEqual(await stored(page), [], 'a TV that never answered is not saved');
    assert.equal(await page.evaluate(() => window.__gdm.stream.getTracks().every(t => t.readyState === 'ended')), true);
    assert.equal(E.tvB.received('cast').length, 1);
    assert.equal(await text(page, '#connectBtn'), 'Connect and share screen');
    await page.done();
});

test('#pair link saves the TV, clears the fragment and pings it once; the relay stream then closes', async () => {
    const page = await open({ init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/#pair=' + CODE_A + '&name=' + encodeURIComponent('Conference Room'));
    assert.equal(await page.evaluate(() => location.hash), '', 'the code is removed from the address bar');
    assert.ok(await page.isVisible('#homeCard'));
    assert.equal(await text(page, '#homeTitle'), 'Your TV');
    assert.equal(await text(page, '#shareBtn'), 'Share my screen');
    await page.waitForFunction(() => /Online/.test(document.querySelector('.tv .tv-status').textContent));
    assert.equal(await text(page, '.tv .tv-name'), 'Conference Room');
    assert.equal(await page.getAttribute('.tv', 'aria-checked'), 'true');
    assert.deepEqual(await stored(page), [A]);
    await until(() => E.relay.sseCount(E.tvA.topic) === 0, 3000, 'idle stream closed');
    await sleep(1500);
    assert.equal(E.tvA.received('ping').length, 1, 'one ping, no polling');
    assert.equal(E.tvA.commands.length, 1);
    // A broken link opens the code form with an explanation.
    await page.goto(E.web.url + '/tv/#pair=7K3M9');
    await page.waitForSelector('#setupErr', { state: 'visible' });
    assert.equal(await text(page, '#setupErrTitle'), 'This TV link is incomplete.');
    assert.equal(await text(page, '#setupTitle'), 'Add a TV');
    await page.done();
});

test('saved TVs: pinged once each, keyboard selection, add another, forget', async () => {
    const page = await open({ init: [RECORD_DISPLAY, FAST, savedTvs([A, B], CODE_A)] });
    await page.goto(E.web.url + '/tv/');
    assert.equal(await text(page, '#homeTitle'), 'Your TVs');
    await page.waitForFunction(() => {
        const s = Array.from(document.querySelectorAll('.tv .tv-status')).map(e => e.textContent);
        return s[0] === 'Online' && s[1] === 'Not answering';
    }, null, { timeout: 8000 });
    assert.equal(E.tvA.received('ping').length, 1);
    assert.equal(E.tvB.received('ping').length, 1);
    assert.ok(await page.isHidden('#offlineHint'), 'the selected TV is online');

    await page.focus('.tv[data-code="' + CODE_A + '"]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getAttribute('.tv[data-code="' + CODE_B + '"]', 'aria-checked'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.code), CODE_B);
    assert.equal(await page.evaluate(() => localStorage.getItem('officetv.selected')), CODE_B);
    assert.ok(await page.isVisible('#offlineHint'));
    assert.match(await text(page, '#offlineHint'), /Open the Office TV app on the TV once, then try again\./);
    assert.equal(await text(page, '#forgetBtn'), 'Forget this TV');

    await page.click('#addBtn');
    assert.ok(await page.isVisible('#setupCard'));
    assert.equal(await text(page, '#setupTitle'), 'Add a TV');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'code');
    await page.click('#setupBack');
    assert.ok(await page.isVisible('#homeCard'));

    await page.click('#forgetBtn');
    assert.match(await text(page, '#forgetText'), /^Forget Reception on this laptop\?/);
    await page.click('#forgetNo');
    assert.ok(await page.isHidden('#forgetConfirm'));
    await page.click('#forgetBtn');
    await page.click('#forgetYes');
    assert.equal(await text(page, '#noticeTitle'), 'Forgot Reception.');
    assert.deepEqual(await stored(page), [A]);
    assert.equal(await text(page, '#homeTitle'), 'Your TV');
    assert.equal(await text(page, '#forgetBtn'), 'Forget this TV');
    await page.click('#forgetBtn');
    await page.click('#forgetYes');
    assert.ok(await page.isVisible('#setupCard'), 'no TVs left: back to the code form');
    assert.equal(await text(page, '#setupTitle'), 'Connect to a TV');
    assert.deepEqual(await stored(page), []);
    assert.equal(E.tvA.received('ping').length, 1, 'still just the one ping');
    await page.done();
});

test('unsupported browsers and phones get one clear sentence and use no relay', async () => {
    const msg = 'Screen sharing needs Chrome, Edge or Safari on a laptop, Chromebook or Mac.';
    let page = await open({ init: [() => { if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = undefined; }, savedTvs([A], CODE_A)] });
    await page.goto(E.web.url + '/tv/');
    assert.ok(await page.isVisible('#unsupportedCard'));
    assert.equal(await text(page, '#unsupText'), msg);
    assert.ok(await page.isHidden('#setupCard'));
    assert.ok(await page.isHidden('#homeCard'));
    await sleep(500);
    assert.equal(E.relay.requests.length, 0, 'no ping from a browser that cannot share');
    await page.done();

    page = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await page.goto(E.web.url + '/tv/');
    assert.ok(await page.isVisible('#unsupportedCard'));
    assert.equal(await text(page, '#unsupText'), msg);
    assert.ok(await page.isHidden('.steps'), 'no laptop steps on a phone');
    await assertLayout(page, 'phone 390');
    await page.screenshot({ path: join(SHOTS, 'phone-390-unsupported.png'), fullPage: true });
    await page.done();
});

test('works without localStorage (memory only, with a note)', async () => {
    const page = await open({ init: [() => {
        const no = () => { throw new DOMException('blocked', 'SecurityError'); };
        Storage.prototype.setItem = no;
        Storage.prototype.getItem = no;
    }] });
    await page.goto(E.web.url + '/tv/#pair=' + CODE_A + '&name=Conference%20Room');
    assert.ok(await page.isVisible('#homeCard'));
    assert.ok(await page.isVisible('#storageNote'));
    assert.equal(await text(page, '#storageNote'), 'This browser will forget the TV when you close the tab.');
    await page.waitForFunction(() => /Online/.test(document.querySelector('.tv .tv-status').textContent));
    await page.done();
});

test('page text is English only', async () => {
    const all = [];
    let page = await open({ init: [RECORD_DISPLAY, FAST] });
    await page.goto(E.web.url + '/tv/');
    all.push(await pageText(page));
    await page.fill('#code', 'q4w8z2m6n0');
    await page.click('#connectBtn');
    await page.waitForSelector('#setupErr', { state: 'visible', timeout: 15000 });
    all.push(await pageText(page));
    await page.goto(E.web.url + '/tv/#pair=' + CODE_A + '&name=Conference%20Room');
    await page.waitForFunction(() => /Online/.test(document.body.innerText));
    all.push(await pageText(page));
    await page.done();
    page = await open({ mobile: true, viewport: { width: 390, height: 844 } });
    await page.goto(E.web.url + '/tv/');
    all.push(await pageText(page));
    await page.goto(E.web.url + '/tv/receive.html');
    all.push(await pageText(page));
    await page.done();
    const visible = all.join('\n');
    assert.doesNotMatch(visible, HINGLISH);
    assert.doesNotMatch(visible, /[^\x00-\x7F…·“”‘’→–—]/, 'only English characters');
    // Every string literal in the scripts, including messages not shown in this test.
    for (const f of ['tv/app.js', 'tv/cast.js', 'tv/otv.js', 'tv/receive.js', 'tv/receive.html', 'tv/index.html']) {
        const src = readFileSync(join(REPO, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const strings = (src.match(/'(?:[^'\\\n]|\\.)*'|>[^<>{}]+</g) || []).join('\n');
        assert.doesNotMatch(strings, HINGLISH, f + ' is English');
        assert.doesNotMatch(strings, /[^\x00-\x7F…·“”‘’→–—]/, f + ' has only English characters');
    }
    // None of the removed features is left in the page.
    assert.doesNotMatch(visible, /\b(remote control|volume|YouTube|Live Screen|send a file|same Wi-Fi page|PIN|QR code)\b/i);
});

test('layout: 1440 light, 1366 dark, 390 and 360 dark; no overflow, overlap or clipped text', { timeout: 120000 }, async () => {
    // First visit on a laptop, light.
    let page = await open({ viewport: { width: 1440, height: 900 }, init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    await assertLayout(page, '1440 first visit');
    const cols = await page.evaluate(() => [document.getElementById('hero'), document.getElementById('panel')].map(e => Math.round(e.getBoundingClientRect().left)));
    assert.ok(cols[1] > cols[0] + 400, 'hero and card side by side');
    const btn = await page.$eval('#connectBtn', b => b.getBoundingClientRect().bottom);
    assert.ok(btn < 900, 'the main button is above the fold');
    await page.screenshot({ path: join(SHOTS, 'first-visit-1440-light.png') });
    await page.screenshot({ path: join(SHOTS, 'first-visit-1440-light-full.png'), fullPage: true });
    await page.done();

    // Returning visitor with two TVs, dark, 1366x768.
    page = await open({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark', init: [RECORD_DISPLAY, FAST, savedTvs([A, B], CODE_A)] });
    await page.goto(E.web.url + '/tv/');
    await page.waitForFunction(() => /Not answering/.test(document.body.innerText), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(12, 16, 19)', 'dark background');
    await assertLayout(page, '1366 dark home');
    const share = await page.$eval('#shareBtn', b => b.getBoundingClientRect().bottom);
    assert.ok(share < 768, 'Share my screen is above the fold');
    await page.screenshot({ path: join(SHOTS, 'home-1366-dark.png') });
    // The sharing panel while the TV opens the receiver (this fake TV has no receiver page).
    await page.click('#shareBtn');
    await page.waitForSelector('#livePanel', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => /Connecting to Conference Room/.test(document.getElementById('liveLabel').textContent));
    await assertLayout(page, '1366 dark connecting');
    await page.screenshot({ path: join(SHOTS, 'connecting-1366-dark.png') });
    await page.click('#stopBtn');
    await page.waitForSelector('#homeCard', { state: 'visible' });
    await page.done();

    // Narrow laptop window 390 (light) with an error, and 360 dark.
    page = await open({ viewport: { width: 390, height: 844 }, init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', '7K3M9-QX2TU');
    await assertLayout(page, '390 setup error');
    await page.screenshot({ path: join(SHOTS, 'setup-390.png'), fullPage: true });
    await page.done();

    page = await open({ viewport: { width: 360, height: 740 }, colorScheme: 'dark', init: [RECORD_DISPLAY, FAST, savedTvs([Object.assign({}, A, { name: 'Conference Room on the second floor, east wing' }), B], CODE_A)] });
    await page.goto(E.web.url + '/tv/');
    await page.waitForFunction(() => /Not answering/.test(document.body.innerText), null, { timeout: 8000 });
    await assertLayout(page, '360 dark home');
    await page.screenshot({ path: join(SHOTS, 'home-360-dark.png'), fullPage: true });
    await page.click('#addBtn');
    await assertLayout(page, '360 dark setup');
    await page.screenshot({ path: join(SHOTS, 'setup-360-dark.png'), fullPage: true });
    await page.done();
});
