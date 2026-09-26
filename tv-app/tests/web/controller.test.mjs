// End-to-end tests for the controller page (tv/index.html + tv/app.js + tv/otv.js) in Chromium.
// A local mock relay imitates ntfy.sh; scripted fake TVs decrypt commands with otv.js and send acks,
// so the real crypto runs end to end. Run: node --test tv-app/tests/web/
// Screenshots go to $OTV_SHOTS (default: <tmp>/officetv-shots).
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRelay } from './mock-relay.mjs';
import { makeCert, startRelayServers, startStatic } from './servers.mjs';
import { createFakeTv } from '../node/fake-tv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SHOTS = process.env.OTV_SHOTS || join(tmpdir(), 'officetv-shots');
const CODE_A = '7K3M9QX2TD';
const CODE_B = 'Q4W8Z2M6N0';
const LAN = 'http://192.168.1.50:8080/';

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (e) {
        const root = execSync('npm root -g').toString().trim();
        return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
    }
}

let chromium, browser, relay, relaySrv, web, tvA, tvB, tls;

before(async () => {
    ({ chromium } = await loadPlaywright());
    mkdirSync(SHOTS, { recursive: true });
    relay = createRelay();
    tls = makeCert('ntfy.sh');
    relaySrv = await startRelayServers(relay, { tls });
    web = await startStatic(REPO);
    const transport = { publish: (t, env) => relay.publish(t, env), getAttachment: async url => relay.attachmentBytes(url) };
    tvA = await createFakeTv(Object.assign({ code: CODE_A, name: 'Conference Dahua' }, transport));
    tvB = await createFakeTv(Object.assign({ code: CODE_B, name: 'Reception Panasonic', silent: true }, transport));
    relay.subscribe(tvA.topic, ev => tvA.handle(ev));
    relay.subscribe(tvB.topic, ev => tvB.handle(ev));
    // Keep the sandbox proxy away from Chromium; map ntfy.sh to the local HTTPS mock relay.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
    const args = ['--no-proxy-server'];
    if (tls) args.push('--host-resolver-rules=MAP ntfy.sh 127.0.0.1:' + relaySrv.httpsPort);
    browser = await chromium.launch({ env, args });
});

after(async () => {
    if (browser) await browser.close();
    if (relaySrv) await relaySrv.close();
    if (web) await web.close();
});

beforeEach(() => {
    tvA.reset();
    tvB.reset();
    relay.rateLimit = false;
    relay.errors.length = 0;
});

const pairUrl = (code, name, relayUrl = relaySrv.httpUrl) =>
    web.url + '/tv/#pair=' + code + '&name=' + encodeURIComponent(name) + '&relay=' + encodeURIComponent(relayUrl);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 10000, what = 'condition') {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await sleep(25);
    }
}

/** New isolated browser context + page that records console errors. */
async function open({ viewport = { width: 1366, height: 768 }, colorScheme = 'light', init } = {}) {
    const ctx = await browser.newContext({ viewport, colorScheme, ignoreHTTPSErrors: true });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.errors = errors;
    page.done = async (allowed = []) => {
        const bad = errors.filter(t => !allowed.some(re => re.test(t)));
        await ctx.close();
        assert.deepEqual(bad, [], 'console errors');
    };
    return page;
}

async function toastText(page, re, ms = 10000) {
    await page.waitForFunction(src => new RegExp(src).test(document.getElementById('toastText').textContent),
        re.source, { timeout: ms });
    return page.textContent('#toastText');
}

async function pairA(page, opts = {}) {
    await page.goto(pairUrl(CODE_A, 'Conference Dahua', opts.relay));
    await toastText(page, /Conference Dahua jud gaya/);
}

const lastCmd = (tv, cmd) => until(() => tv.received(cmd).slice(-1)[0], 10000, cmd + ' command');

async function noHorizontalOverflow(page) {
    return page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const offenders = [];
        for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed'
                && !el.closest('.sr-only') && el.offsetParent !== null) offenders.push(el.tagName + '#' + el.id + '.' + el.className);
        }
        return { scroll: document.documentElement.scrollWidth, width: w, offenders: offenders.slice(0, 5) };
    });
}

test('pairs from the #pair fragment, removes it, saves the TV and pings once', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => location.pathname), '/tv/');
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs')));
    assert.deepEqual(saved, [{ name: 'Conference Dahua', code: CODE_A, relay: relaySrv.httpUrl }]);
    const chip = page.locator('.tv-chip[data-code="' + CODE_A + '"]');
    assert.equal(await chip.getAttribute('aria-pressed'), 'true');
    assert.match(await chip.textContent(), /Conference Dahua/);
    assert.equal(await chip.locator('.dot').getAttribute('class'), 'dot online');
    assert.match(await page.textContent('#barMeta'), /Fake LPH65 · Android 11 · App 1\.2 · Online/);
    assert.equal(await page.isVisible('#pairCard'), false);
    assert.equal(tvA.received('ping').length, 1, 'exactly one ping, no polling');
    await sleep(1500);
    assert.equal(tvA.received('ping').length, 1, 'still one ping');
    // reload: TV is remembered and pinged again once
    await page.reload();
    await until(() => tvA.received('ping').length === 2, 8000, 'ping after reload');
    assert.match(await page.textContent('.tv-chip[data-code="' + CODE_A + '"]'), /Conference Dahua/);
    assert.deepEqual(tvA.errors, []);
    await page.done();
});

test('typed code: explains bad codes, accepts lowercase with spaces, uses https://ntfy.sh by default', async t => {
    if (!tls) return t.skip('openssl not available for the ntfy.sh HTTPS mock');
    const page = await open();
    await page.goto(web.url + '/tv/');
    assert.equal(await page.isVisible('#pairCard'), true);
    assert.equal(await page.isVisible('#controls'), false);
    const submit = async code => {
        await page.fill('#pairCode', code);
        await page.click('#pairSubmit');
        return page.textContent('#pairErr');
    };
    assert.match(await submit(''), /TV code likhein/);
    assert.match(await submit('7K3M9QX2TU'), /"U" nahi hota/);
    assert.equal(await page.getAttribute('#pairCode', 'aria-invalid'), 'true');
    assert.match(await submit('7K3M9-QX2'), /10 akshar.*Abhi 8 likhe hain, 2 baaki/);
    assert.match(await submit('7K3M9QX2TD7'), /1 zyada/);
    assert.match(await submit('7K3M9#QX2T'), /"#" nahi hota/);
    // live hint while typing
    await page.fill('#pairCode', '7k3m9');
    assert.match(await page.textContent('#pairHelp'), /5\/10/);
    assert.equal(tvA.commands.length, 0);
    await page.fill('#pairName', 'Board Room');
    await page.fill('#pairCode', ' 7k3m9 - qx2td ');
    assert.match(await page.textContent('#pairHelp'), /Code theek hai: 7K3M9-QX2TD/);
    await page.click('#pairSubmit');
    await toastText(page, /Board Room jud gaya/);
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs')));
    assert.deepEqual(saved, [{ name: 'Board Room', code: CODE_A, relay: 'https://ntfy.sh' }]);
    const post = relay.requests.find(r => r.method === 'POST' && r.path === '/' + tvA.topic + '?firebase=no');
    assert.ok(post && post.tls && post.host === 'ntfy.sh', 'POST went to https://ntfy.sh');
    assert.match(post.contentType, /^text\/plain/);
    assert.ok(relay.requests.some(r => r.method === 'GET' && r.path === '/' + tvA.topic + '/sse' && r.tls));
    assert.ok(!relay.requests.some(r => r.method === 'OPTIONS' && r.path.startsWith('/' + tvA.topic + '?firebase')),
        'command POST is a CORS simple request (no preflight)');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.code), CODE_A, 'focus moves to the new TV chip');
    await page.done();
});

test('a broken pairing link shows the code form with an explanation', async () => {
    const page = await open();
    await page.goto(web.url + '/tv/#pair=7K3M9&name=X');
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.match(await page.textContent('#pairErr'), /Pairing link adhoora/);
    await page.done();
});

test('link without scheme, Meet code, Sheets chip, YouTube search, keys, keyboard and volume', async () => {
    const page = await open();
    await pairA(page);
    await page.fill('#url', 'meet.google.com/abc-defg-hij');
    await page.click('#openForm button');
    assert.equal((await lastCmd(tvA, 'open')).args.url, 'https://meet.google.com/abc-defg-hij');
    assert.equal(await toastText(page, /Link TV par khul gaya/), 'Link TV par khul gaya.');
    assert.equal(await page.inputValue('#url'), 'meet.google.com/abc-defg-hij', 'the typed link stays for re-use');

    await page.fill('#url', 'xyz-abcd-pqr');
    await page.press('#url', 'Enter');
    await until(() => tvA.received('open').length === 2, 8000, 'meet code');
    assert.equal(tvA.received('open')[1].args.url, 'https://meet.google.com/xyz-abcd-pqr');

    await page.click('button[data-url="https://docs.google.com/spreadsheets"]');
    await until(() => tvA.received('open').length === 3, 8000, 'sheets');
    assert.equal(tvA.received('open')[2].args.url, 'https://docs.google.com/spreadsheets');

    await page.fill('#yt', 'lofi hindi songs');
    await page.click('#ytForm button');
    assert.deepEqual((await lastCmd(tvA, 'youtube')).args, { q: 'lofi hindi songs' });

    await page.click('button[data-key="next_slide"]');
    assert.equal((await lastCmd(tvA, 'key')).args.key, 'next_slide');
    assert.equal(await toastText(page, /Agli slide/), 'Agli slide.');

    await page.click('h1');                       // focus outside inputs
    await page.keyboard.press('ArrowLeft');
    await until(() => tvA.received('key').length === 2, 8000, 'keyboard key');
    assert.equal(tvA.received('key')[1].args.key, 'prev_slide');
    await page.focus('#yt');
    await page.keyboard.press('ArrowRight');       // typing in a field must not change slides
    await sleep(300);
    assert.equal(tvA.received('key').length, 2);

    await page.locator('#vol').fill('70');
    assert.equal((await lastCmd(tvA, 'volume')).args.percent, 70);
    assert.equal(await page.textContent('#volOut'), '70%');
    assert.deepEqual(tvA.errors, []);
    await page.done();
});

test('apps list arrives in several parts (out of order) and a tap opens the app', async () => {
    const page = await open();
    await pairA(page);
    await page.click('#loadApps');
    await toastText(page, /40 apps mili/);
    const labels = await page.$$eval('#apps button', bs => bs.map(b => b.textContent));
    assert.equal(labels.length, 40);
    assert.deepEqual(labels, tvA.apps.map(a => a.label));
    assert.equal(tvA.acks.filter(a => a.re === tvA.received('apps')[0].id).length, 3, 'ack came in 3 parts');
    await page.fill('#appFilter', 'app 3');
    assert.equal(await page.locator('#apps button').count(), 11);
    await page.click('#apps button:has-text("App 33")');
    assert.equal((await lastCmd(tvA, 'app')).args.pkg, 'com.example.app33');
    await toastText(page, /App TV par khul gaya/);
    await page.done();
});

test('file under 15 MB is encrypted, uploaded and opened; over 15 MB is refused with help', async () => {
    const page = await open();
    await pairA(page);
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    const filesBefore = relay.files.size;
    await page.setInputFiles('#file', { name: 'Sales.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: bytes });
    assert.equal(await toastText(page, /Sales\.pptx TV par khul gaya/, 20000), 'Sales.pptx TV par khul gaya.');
    assert.equal(tvA.files.length, 1);
    assert.equal(tvA.files[0].name, 'Sales.pptx');
    assert.ok(Buffer.from(tvA.files[0].bytes).equals(bytes), 'TV decrypted exactly the bytes we picked');
    const upload = relay.posts.find(p => p.query === '?filename=otv.bin&firebase=no');
    assert.equal(upload.size, bytes.length + 16, 'relay only saw ciphertext + tag');
    assert.equal(relay.files.size, filesBefore + 1);
    const stored = Array.from(relay.files.values()).pop();
    assert.ok(!Buffer.from(stored).subarray(0, 64).equals(bytes.subarray(0, 64)), 'stored attachment is not plaintext');
    assert.equal(await page.getAttribute('#progBar', 'aria-valuenow'), '100');

    const big = Buffer.alloc(15 * 1000 * 1000 + 1, 1);
    await page.setInputFiles('#file', { name: 'Launch video.mp4', mimeType: 'video/mp4', buffer: big });
    const t = await toastText(page, /15 MB tak hi/);
    assert.match(t, /Google Drive/);
    assert.equal(await page.getAttribute('#toastLink', 'href'), LAN);
    assert.equal(await page.isVisible('#fileMsg'), true);
    assert.match(await page.textContent('#fileMsg'), /15\.0 MB ki hai.*Google Drive.*Same Wi-Fi page/);
    assert.equal(await page.getAttribute('#fileLan', 'href'), LAN);
    await sleep(300);
    assert.equal(relay.files.size, filesBefore + 1, 'nothing uploaded for the big file');
    assert.equal(tvA.received('file').length, 1);
    assert.deepEqual(tvA.errors, []);
    await page.done();
});

test('"Sab TV" sends to every TV and reports the one that never answers', { timeout: 60000 }, async () => {
    const page = await open();
    await pairA(page);
    await page.goto(pairUrl(CODE_B, 'Reception Panasonic'));        // second TV (never answers)
    await until(() => tvB.received('ping').length === 1, 8000, 'ping to B');
    const all = page.locator('.tv-chip[data-code="all"]');
    await all.click();
    assert.match(await all.textContent(), /Sab TV \(2\)/);
    assert.equal(await page.isDisabled('#loadApps'), true, 'apps need a single TV');
    await page.click('button[data-url="https://www.google.com"]');
    await until(() => tvB.received('open').length === 1 && tvA.received('open').length === 1, 8000, 'both TVs got it');
    const t = await toastText(page, /2 mein se 1 TV par ho gaya/, 25000);
    assert.match(t, /Reception Panasonic: TV se jawab nahi aaya\. TV on hai aur internet se juda hai\? TV par Office TV app ek baar kholein\./);
    const rows = await page.$$eval('#resultsList li', lis => lis.map(li => ({ cls: li.className, text: li.textContent })));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { cls: 'ok', text: 'Conference DahuaLink TV par khul gaya.' });
    assert.equal(rows[1].cls, 'bad');
    assert.match(rows[1].text, /^Reception PanasonicTV se jawab nahi aaya/);
    assert.equal(await page.getAttribute('.tv-chip[data-code="' + CODE_B + '"] .dot', 'class'), 'dot offline');
    assert.equal(await page.getAttribute('.tv-chip[data-code="' + CODE_A + '"] .dot', 'class'), 'dot online');
    assert.deepEqual(tvA.errors, []);
    assert.deepEqual(tvB.errors, []);
    await page.done();
});

test('rate limit (HTTP 429) explains the free daily limit and offers the Same Wi-Fi page', async () => {
    const page = await open();
    await pairA(page);
    relay.rateLimit = true;
    await page.click('button[data-key="play_pause"]');
    const t = await toastText(page, /free limit/);
    assert.match(t, /Aaj ki free limit poori ho gayi/);
    assert.match(t, /Same Wi-Fi page/);
    assert.equal(await page.isVisible('#toastLink'), true);
    assert.equal(await page.getAttribute('#toastLink', 'href'), LAN);
    assert.equal(await page.textContent('#toastLink'), 'Same Wi-Fi page');
    assert.equal(tvA.received('key').length, 0);
    relay.rateLimit = false;
    await page.click('button[data-key="play_pause"]');
    assert.equal(await toastText(page, /Play\/Pause dabaya/), 'Play/Pause dabaya.');
    // Chromium itself logs the 429 response as a console error; nothing else is allowed.
    await page.done([/status of 429/]);
});

test('keep-awake toggle sends awake off/on and follows the TV status', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.isChecked('#awake'), true);
    await page.click('#awake');
    assert.deepEqual((await lastCmd(tvA, 'awake')).args, { on: false });
    await toastText(page, /Screen normal time par band hogi/);
    assert.equal(await page.isChecked('#awake'), false);
    await page.click('#awake');
    await until(() => tvA.received('awake').length === 2, 8000, 'awake on');
    assert.deepEqual(tvA.received('awake')[1].args, { on: true });
    await toastText(page, /Screen hamesha on rahegi/);
    assert.equal(await page.isChecked('#awake'), true);
    // The TV says keep-awake is off: a refresh updates the switch.
    tvA.status.keepAwake = false;
    await page.click('#refreshBtn');
    await toastText(page, /TV online hai/);
    assert.equal(await page.isChecked('#awake'), false);
    await page.done();
});

test('permission banner: Accessibility (full) and "Display over other apps" (lite)', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.isVisible('#permBanner'), false);
    tvA.status.needsPermission = true;
    await page.click('#refreshBtn');
    await page.waitForSelector('#permBanner', { state: 'visible' });
    assert.match(await page.textContent('#permText'), /Accessibility on karein/);
    tvA.status.flavor = 'lite';
    await page.click('#refreshBtn');
    await page.waitForFunction(() => /Display over other apps/.test(document.getElementById('permText').textContent));
    tvA.status.needsPermission = false;
    tvA.status.flavor = 'full';
    tvA.status.accessibility = false;
    await page.click('#refreshBtn');
    await page.waitForSelector('#permBanner', { state: 'hidden' });
    assert.equal(await page.isVisible('#a11yNote'), true);
    await page.done();
});

test('rename sends "rename" and remove forgets the TV', async () => {
    const page = await open();
    await pairA(page);
    await page.click('#renameBtn');
    assert.equal(await page.inputValue('#renameInput'), 'Conference Dahua');
    await page.fill('#renameInput', '   ');
    await page.click('#renameOk');
    assert.match(await page.textContent('#renameErr'), /Naam likhein/);
    await page.fill('#renameInput', 'Board Room');
    await page.click('#renameOk');
    assert.deepEqual((await lastCmd(tvA, 'rename')).args, { name: 'Board Room' });
    await toastText(page, /Naam badal diya: Board Room/);
    assert.match(await page.textContent('.tv-chip[data-code="' + CODE_A + '"]'), /Board Room/);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs')))[0].name, 'Board Room');
    await page.click('#removeBtn');
    assert.match(await page.textContent('#removeText'), /"Board Room" ko is browser se hatana hai/);
    await page.click('#removeOk');
    await toastText(page, /Board Room hata diya/);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs'))), []);
    assert.equal(await page.isVisible('#pairCard'), true);
    assert.equal(await page.isVisible('#controls'), false);
    await page.done();
});

test('keeps working after the relay drops the event stream', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(relay.sseCount(tvA.topic), 1);
    relay.dropStreams(tvA.topic);
    await page.click('button[data-key="home"]');                 // sent while the stream is reconnecting
    assert.equal((await lastCmd(tvA, 'key')).args.key, 'home');
    assert.equal(await toastText(page, /Home dabaya/), 'Home dabaya.');
    assert.equal(relay.sseCount(tvA.topic), 1);
    await page.done([/ERR_(INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|CONNECTION)/]);
});

test('works without localStorage (memory only, with a note)', async () => {
    const page = await open({
        init: () => {
            Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
        },
    });
    await pairA(page);
    assert.equal(await page.isVisible('#storageNote'), true);
    await page.click('button[data-key="next_slide"]');
    await toastText(page, /Agli slide/);
    await page.done();
});

test('layout: screenshots (1366x768 light, 390x844 dark) and no horizontal scroll at 360 px', { timeout: 60000 }, async () => {
    // First run, phone width
    let page = await open({ viewport: { width: 360, height: 740 } });
    await page.goto(web.url + '/tv/');
    let o = await noHorizontalOverflow(page);
    assert.ok(o.scroll <= 360, 'first run overflow: ' + JSON.stringify(o));
    await page.screenshot({ path: join(SHOTS, 'first-run-360.png'), fullPage: true });
    await page.done();

    // Desktop light with two TVs and the apps list
    page = await open({ viewport: { width: 1366, height: 768 } });
    await pairA(page);
    await page.goto(pairUrl(CODE_B, 'Reception Panasonic with a very long name'));
    await page.click('.tv-chip[data-code="' + CODE_A + '"]');
    await page.click('#loadApps');
    await toastText(page, /40 apps mili/);
    await page.screenshot({ path: join(SHOTS, 'desktop-1366-light.png') });
    await page.screenshot({ path: join(SHOTS, 'desktop-1366-light-full.png'), fullPage: true });
    const cols = await page.$$eval('#controls > .col', els => els.map(e => Math.round(e.getBoundingClientRect().left)));
    assert.equal(cols.length, 2);
    assert.ok(cols[1] > cols[0] + 300, 'two columns on a laptop');
    await page.done();

    // Phone dark
    page = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await pairA(page);
    await page.goto(pairUrl(CODE_B, 'Reception Panasonic with a very long name'));
    await page.click('.tv-chip[data-code="' + CODE_A + '"]');
    await page.click('#loadApps');
    await toastText(page, /40 apps mili/);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(11, 16, 32)', 'dark background');
    await page.screenshot({ path: join(SHOTS, 'phone-390-dark.png') });
    await page.screenshot({ path: join(SHOTS, 'phone-390-dark-full.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.click('.tv-chip[data-code="all"]');
    await page.click('button[data-key="mute"]');
    await page.waitForSelector('#results', { state: 'visible', timeout: 25000 });
    o = await noHorizontalOverflow(page);
    assert.ok(o.scroll <= 360, 'paired overflow: ' + JSON.stringify(o));
    await page.screenshot({ path: join(SHOTS, 'phone-360-dark-all.png'), fullPage: true });
    await page.done();
});
