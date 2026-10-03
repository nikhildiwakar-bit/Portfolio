// Browser tests for the website's own screens (tv/index.html + tv/app.js): the one home card, code checks,
// errors (wrong code, relay limit), pairing links, no saved TVs, unsupported browsers, storage fallback,
// English-only text and layout. Real screen sharing between two pages is in cast.test.mjs.
// Run: node --test tv-app/tests/web/
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CODE_A, CODE_B, CODE_OLD, HINGLISH, NTFY_ONLY, RECORD_DISPLAY, REPO, SHOTS, acquire, assertLayout, oldSavedTvs, open, pageText,
    release, reset, sleep, text, timeouts, until,
} from './harness.mjs';

let E;
before(async () => { E = await acquire(); });
after(release);
beforeEach(reset);

const FAST = timeouts({ ackTimeoutMs: 1500 });
const gdmCalls = page => page.evaluate(() => window.__gdm.calls.length);
const storedKeys = page => page.evaluate(() => Object.keys(localStorage).filter(k => /^officetv\./.test(k)).sort());
/** WebSocket handshakes the local MQTT broker has seen so far. */
const upgrades = () => (E.broker ? E.broker.upgrades : 0);

test('home: one clean card; bad codes are explained without opening the picker or using the relay', async () => {
    const up0 = upgrades();
    const page = await open({ init: [RECORD_DISPLAY, oldSavedTvs([{ name: 'Old TV', code: CODE_OLD, relay: 'https://ntfy.sh' }], CODE_OLD)] });
    await page.goto(E.web.url + '/tv/');
    assert.equal(await text(page, 'h1'), 'Share your screen on the TV');
    assert.ok(await page.isVisible('#homeCard'));
    const field = await page.$eval('#code', el => ({
        inputmode: el.getAttribute('inputmode'), autocomplete: el.getAttribute('autocomplete'), placeholder: el.placeholder,
        focused: document.activeElement === el, value: el.value,
    }));
    assert.deepEqual(field, { inputmode: 'numeric', autocomplete: 'off', placeholder: '4-digit code', focused: true, value: '' });
    assert.equal(await text(page, '#shareBtn'), 'Share screen');
    assert.equal(await text(page, '#codeNote'), 'The code is on the TV. It changes every time Office TV opens.');
    // No saved-TV list any more: nothing to pick, forget or add, and the old list is deleted.
    assert.equal(await page.$$eval('.tv, #tvName, #forgetBtn, #addBtn, #setupCard, #soundToggle', l => l.length), 0);
    assert.deepEqual(await storedKeys(page), [], 'the saved-TV list of older versions is removed');

    await page.click('#shareBtn');
    assert.equal(await text(page, '#codeErr'), 'Type the code shown on the TV.');
    assert.equal(await page.getAttribute('#code', 'aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'code');

    await page.fill('#code', '48');
    await page.press('#code', 'Enter');
    assert.equal(await text(page, '#codeErr'), 'The code on the TV has 4 digits. This one has 2.');
    await page.fill('#code', '48213');
    await page.press('#code', 'Enter');
    assert.equal(await text(page, '#codeErr'), 'The code on the TV has 4 digits. This one has 5.');
    await page.fill('#code', '48213456789');
    assert.equal(await text(page, '#codeErr'), 'The code on the TV has 4 digits. This one has 11.', 'explained while typing');
    await page.fill('#code', '7K3M9-QX2TU');
    assert.match(await text(page, '#codeErr'), /never contain the letter U/, 'explained while typing');
    await page.fill('#code', '48#1');
    assert.match(await text(page, '#codeErr'), /^Remove "#"\. The code on the TV has only numbers/);
    await page.fill('#code', '7K3M9');
    await page.press('#code', 'Enter');
    assert.equal(await text(page, '#codeErr'), 'Older TV codes have 10 letters and numbers. This one has 5.');
    await page.fill('#code', 'https://nikhildiwakar-bit.github.io/Portfolio/tv/#pair=7K3M9');
    await page.press('#code', 'Enter');
    assert.match(await text(page, '#codeErr'), /link is incomplete/);

    // Spaces are fine; so are old 10-symbol codes in lower case with O for 0.
    for (const ok of [' 48 21 ', '7k3m9 qx2td', '7K3M9-QX2TD']) {
        await page.fill('#code', ok);
        assert.ok(await page.isHidden('#codeErr'), ok);
        assert.equal(await page.getAttribute('#code', 'aria-invalid'), null);
    }
    assert.equal(await gdmCalls(page), 0, 'the screen picker never opened for a bad code');
    assert.equal(E.relay.requests.length, 0, 'the home screen uses no relay at all');
    assert.equal(upgrades(), up0, 'and no MQTT broker');
    await assertLayout(page, '1366 home');
    await page.done();
});

test('a code no TV answers: "No TV answered with code 7390.", the code stays typed, the capture is released', async () => {
    const page = await open({ init: [RECORD_DISPLAY, FAST] });
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', CODE_B);
    await page.press('#code', 'Enter');
    assert.equal(await gdmCalls(page), 1, 'Enter opens the picker');
    assert.equal(await page.evaluate(() => window.__gdm.calls[0].active), true, 'inside the key press (user gesture)');
    await page.waitForSelector('#notice', { state: 'visible', timeout: 15000 });
    assert.equal(await text(page, '#noticeTitle'), 'No TV answered with code 7390.');
    assert.equal(await text(page, '#noticeText'), 'Check the code on the TV.');
    assert.equal(await page.getAttribute('#notice', 'class'), 'notice bad');
    assert.ok(await page.isVisible('#homeCard'), 'back on the card, ready to fix the code');
    assert.equal(await page.inputValue('#code'), CODE_B);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'code', 'the code is selected for retyping');
    assert.equal(await page.evaluate(() => window.__gdm.stream.getTracks().every(t => t.readyState === 'ended')), true);
    assert.equal(E.tvB.received('cast').length, 1);
    assert.deepEqual(await storedKeys(page), [], 'nothing is saved');
    await until(() => E.relay.sseCount(E.tvB.topic) === 0, 5000, 'relay stream closed');
    await assertLayout(page, 'no answer');
    await page.screenshot({ path: join(SHOTS, 'no-answer-1366.png') });
    await page.done();
});

test('the relay limit (MQTT blocked, ntfy used up): a clear message, never a silent failure', async () => {
    const page = await open({ init: [RECORD_DISPLAY, FAST], relay: NTFY_ONLY });
    await page.goto(E.web.url + '/tv/');
    E.relay.rateLimit = true;
    E.relay.rateLimitCode = 42908;
    await page.fill('#code', CODE_A);
    await page.click('#shareBtn');
    await page.waitForSelector('#notice', { state: 'visible', timeout: 15000 });
    assert.equal(await text(page, '#noticeTitle'), 'The free relay limit for today has been reached.');
    assert.match(await text(page, '#noticeText'), /try again later/);
    E.relay.rateLimitCode = 42901;
    await page.click('#shareBtn');
    await until(async () => await text(page, '#noticeTitle') === 'Too many attempts in a short time.', 15000, 'burst limit message');
    assert.equal(await text(page, '#noticeText'), 'Wait a minute, then try again.');
    E.relay.rateLimitCode = 42908;
    await page.done([/status of 429/]);
});

test('#pair link: the code goes into the field (not saved), the fragment is cleared, nothing is pinged', async () => {
    const up0 = upgrades();
    const page = await open({ init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/#pair=' + CODE_A + '&name=' + encodeURIComponent('Conference Room'));
    assert.equal(await page.evaluate(() => location.hash), '', 'the code is removed from the address bar');
    assert.equal(await page.inputValue('#code'), CODE_A);
    assert.equal(await text(page, '#shareBtn'), 'Share screen');
    await sleep(800);
    assert.equal(E.relay.requests.length, 0, 'no ping, no relay stream');
    assert.equal(upgrades(), up0, 'no MQTT connection');
    assert.deepEqual(await storedKeys(page), []);
    // A broken link explains itself.
    await page.goto(E.web.url + '/tv/#pair=7K3M9');
    await page.waitForSelector('#notice', { state: 'visible' });
    assert.equal(await text(page, '#noticeTitle'), 'This TV link is incomplete.');
    assert.equal(await text(page, '#noticeText'), 'Type the code shown on the TV instead.');
    await page.done();
});

test('unsupported browsers and phones get one clear sentence and use no relay', async () => {
    const msg = 'Screen sharing needs Chrome, Edge or Safari on a laptop, Chromebook or Mac.';
    let page = await open({ init: [() => { if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = undefined; }] });
    await page.goto(E.web.url + '/tv/');
    assert.ok(await page.isVisible('#unsupportedCard'));
    assert.equal(await text(page, '#unsupText'), msg);
    assert.ok(await page.isHidden('#homeCard'));
    await sleep(300);
    assert.equal(E.relay.requests.length, 0);
    await page.done();

    page = await open({ viewport: { width: 390, height: 844 }, mobile: true });
    await page.goto(E.web.url + '/tv/');
    assert.ok(await page.isVisible('#unsupportedCard'));
    assert.equal(await text(page, '#unsupText'), msg);
    assert.ok(await page.isHidden('#help'), 'no laptop help on a phone');
    await assertLayout(page, 'phone 390');
    await page.screenshot({ path: join(SHOTS, 'phone-390-unsupported.png'), fullPage: true });
    await page.done();
});

test('works without localStorage', async () => {
    const page = await open({ init: [RECORD_DISPLAY, FAST, () => {
        const no = () => { throw new DOMException('blocked', 'SecurityError'); };
        Storage.prototype.setItem = no;
        Storage.prototype.getItem = no;
        Storage.prototype.removeItem = no;
    }] });
    await page.goto(E.web.url + '/tv/');
    assert.ok(await page.isVisible('#homeCard'));
    await page.fill('#code', CODE_B);
    await page.click('#shareBtn');
    await page.waitForSelector('#notice', { state: 'visible', timeout: 15000 });
    assert.equal(await text(page, '#noticeTitle'), 'No TV answered with code 7390.');
    await page.done();
});

test('page text is English only', async () => {
    const all = [];
    let page = await open({ init: [RECORD_DISPLAY, FAST] });
    await page.goto(E.web.url + '/tv/');
    all.push(await pageText(page));
    await page.fill('#code', CODE_B);
    await page.click('#shareBtn');
    await page.waitForSelector('#notice', { state: 'visible', timeout: 15000 });
    all.push(await pageText(page));
    await page.done();
    page = await open({ mobile: true, viewport: { width: 390, height: 844 } });
    await page.goto(E.web.url + '/tv/');
    all.push(await pageText(page));
    await page.goto(E.web.url + '/tv/receive.html');
    all.push(await pageText(page));
    await page.goto(E.web.url + '/tv/phone.html');
    all.push(await pageText(page));
    await page.done();
    const visible = all.join('\n');
    assert.doesNotMatch(visible, HINGLISH);
    assert.doesNotMatch(visible, /[^\x00-\x7F…·“”‘’→–—]/, 'only English characters');
    // Every string literal in the scripts, including messages not shown in this test.
    for (const f of ['tv/app.js', 'tv/cast.js', 'tv/otv.js', 'tv/stats.js', 'tv/steady.js', 'tv/tick.js', 'tv/receive.js', 'tv/receive.html',
        'tv/index.html', 'tv/phone.js', 'tv/phone.html']) {
        const src = readFileSync(join(REPO, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const strings = (src.match(/'(?:[^'\\\n]|\\.)*'|>[^<>{}]+</g) || []).join('\n');
        assert.doesNotMatch(strings, HINGLISH, f + ' is English');
        assert.doesNotMatch(strings, /[^\x00-\x7F…·“”‘’→–—]/, f + ' has only English characters');
    }
    // None of the removed features is left in the page.
    assert.doesNotMatch(visible, /\b(remote control|volume control|YouTube|Live Screen|send a file|same Wi-Fi page|PIN)\b/i);
    const site = readFileSync(join(REPO, 'tv/index.html'), 'utf8') + readFileSync(join(REPO, 'tv/app.js'), 'utf8');
    assert.doesNotMatch(site, /Your TVs?\b|Forget this TV|Add another|Play sound here too|Sound on the TV only|Not answering/);
});

test('layout: 1920 dark, 1440 light, 1366 dark (connecting), 390 and 360; no overflow, overlap or clipped text', { timeout: 120000 }, async () => {
    let page = await open({ viewport: { width: 1440, height: 900 }, init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    await assertLayout(page, '1440 home');
    const btn = await page.$eval('#shareBtn', b => b.getBoundingClientRect());
    const card = await page.$eval('#homeCard', b => b.getBoundingClientRect());
    assert.ok(btn.bottom < 700, 'Share screen is well above the fold');
    assert.ok(Math.abs(card.left + card.width / 2 - 720) < 2, 'the card is centered');
    await page.screenshot({ path: join(SHOTS, 'home-1440-light.png') });
    await page.screenshot({ path: join(SHOTS, 'home-1440-light-full.png'), fullPage: true });
    await page.done();

    page = await open({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark', init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(12, 16, 19)', 'dark background');
    await page.fill('#code', CODE_A);
    await assertLayout(page, '1920 dark home');
    await page.screenshot({ path: join(SHOTS, 'home-1920-dark.png') });
    await page.done();

    // The sharing panel while the TV opens the receiver (this fake TV has no receiver page), dark, 1366 x 768.
    page = await open({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark', init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', CODE_A);
    await page.click('#shareBtn');
    await page.waitForSelector('#livePanel', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => /Connecting to Conference Room/.test(document.getElementById('liveLabel').textContent));
    assert.equal(await text(page, '#stopBtn'), 'Cancel');
    await assertLayout(page, '1366 dark connecting');
    await page.screenshot({ path: join(SHOTS, 'connecting-1366-dark.png') });
    await page.click('#stopBtn');
    await page.waitForSelector('#homeCard', { state: 'visible' });
    assert.equal(await text(page, '#noticeTitle'), 'Sharing stopped.');
    await until(() => E.tvA.received('cast').some(c => c.args.action === 'stop'), 8000, 'the TV is told to close its receiver');
    await until(() => E.relay.sseCount(E.tvA.topic) === 0, 12000, 'then the relay connection closes');
    assert.equal(await text(page, '#shareLabel'), 'Share again', 'one click shares again');
    assert.equal(await page.inputValue('#code'), CODE_A, 'the code is still typed in');
    await assertLayout(page, '1366 dark stopped');
    await page.screenshot({ path: join(SHOTS, 'stopped-1366-dark.png') });
    await page.fill('#code', '1234');
    assert.equal(await text(page, '#shareLabel'), 'Share screen', 'another code: Share screen');
    await page.done();

    // Narrow laptop windows with an error.
    page = await open({ viewport: { width: 390, height: 844 }, init: [RECORD_DISPLAY] });
    await page.goto(E.web.url + '/tv/');
    await page.fill('#code', '7K3M9-QX2TU');
    await assertLayout(page, '390 error');
    await page.screenshot({ path: join(SHOTS, 'home-390-error.png'), fullPage: true });
    await page.done();

    page = await open({ viewport: { width: 360, height: 740 }, colorScheme: 'dark', init: [RECORD_DISPLAY, FAST] });
    await page.goto(E.web.url + '/tv/');
    await assertLayout(page, '360 dark home');
    await page.screenshot({ path: join(SHOTS, 'home-360-dark.png'), fullPage: true });
    await page.fill('#code', CODE_B);
    await page.click('#shareBtn');
    await page.waitForSelector('#notice', { state: 'visible', timeout: 15000 });
    await assertLayout(page, '360 dark no answer');
    await page.screenshot({ path: join(SHOTS, 'no-answer-360-dark.png'), fullPage: true });
    await page.done();
});
