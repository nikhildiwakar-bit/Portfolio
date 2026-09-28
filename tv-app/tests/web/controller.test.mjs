// End-to-end tests for the controller page (tv/index.html + tv/app.js + tv/otv.js) in Chromium.
// A local mock relay imitates ntfy.sh; scripted fake TVs decrypt commands with otv.js and send acks,
// so the real crypto runs end to end. Run: node --test tv-app/tests/web/
// Screenshots go to $OTV_SHOTS (default: <tmp>/officetv-shots).
import test, { after, afterEach, before, beforeEach } from 'node:test';
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
const CODE_C = 'H7P2K9R4T1';
const LAN = 'http://192.168.1.50:8080/';

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (e) {
        const root = execSync('npm root -g').toString().trim();
        return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
    }
}

let chromium, browser, relay, relaySrv, web, tvA, tvB, tvC, tls;

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
    tvC = await createFakeTv(Object.assign({ code: CODE_C, name: 'Board Room' }, transport));
    relay.subscribe(tvA.topic, ev => tvA.handle(ev));
    relay.subscribe(tvB.topic, ev => tvB.handle(ev));
    relay.subscribe(tvC.topic, ev => tvC.handle(ev));
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

const contexts = new Set();

beforeEach(() => {
    tvA.reset();
    tvB.reset();
    tvC.reset();
    relay.rateLimit = false;
    relay.rateLimitCode = 42908;
    relay.errors.length = 0;
    relay.requests.length = 0;
    relay.posts.length = 0;
});

afterEach(async () => {
    // A failed test never reaches page.done(); close its pages so their streams do not leak into the next test.
    for (const c of Array.from(contexts)) await c.close().catch(() => {});
    contexts.clear();
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
    contexts.add(ctx);
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.errors = errors;
    page.done = async (allowed = []) => {
        const bad = errors.filter(t => !allowed.some(re => re.test(t)));
        contexts.delete(ctx);
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
    await toastText(page, /Conference Dahua is connected/);
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
    assert.match(await submit(''), /Type the TV code/);
    assert.match(await submit('7K3M9QX2TU'), /never contain "U"/);
    assert.equal(await page.getAttribute('#pairCode', 'aria-invalid'), 'true');
    assert.match(await submit('7K3M9-QX2'), /10 characters.*You typed 8, 2 missing/);
    assert.match(await submit('7K3M9QX2TD7'), /1 too many/);
    assert.match(await submit('7K3M9#QX2T'), /never contain "#"/);
    // live hint while typing
    await page.fill('#pairCode', '7k3m9');
    assert.match(await page.textContent('#pairHelp'), /5\/10/);
    assert.equal(tvA.commands.length, 0);
    await page.fill('#pairName', 'Board Room');
    await page.fill('#pairCode', ' 7k3m9 - qx2td ');
    assert.match(await page.textContent('#pairHelp'), /Code looks good: 7K3M9-QX2TD/);
    await page.click('#pairSubmit');
    await toastText(page, /Board Room is connected/);
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
    assert.match(await page.textContent('#pairErr'), /pairing link is incomplete/);
    await page.done();
});

test('link without scheme, Meet code, Sheets chip, YouTube search, keys, keyboard and volume', async () => {
    const page = await open();
    await pairA(page);
    await page.fill('#url', 'meet.google.com/abc-defg-hij');
    await page.click('#openForm button');
    assert.equal((await lastCmd(tvA, 'open')).args.url, 'https://meet.google.com/abc-defg-hij');
    assert.equal(await toastText(page, /Opened the link on the TV/), 'Opened the link on the TV.');
    assert.equal(await page.inputValue('#url'), 'meet.google.com/abc-defg-hij', 'the typed link stays for re-use');

    await page.fill('#url', 'xyz-abcd-pqr');
    await page.press('#url', 'Enter');
    await until(() => tvA.received('open').length === 2, 8000, 'meet code');
    assert.equal(tvA.received('open')[1].args.url, 'https://meet.google.com/xyz-abcd-pqr');

    await page.click('button[data-url="https://docs.google.com/spreadsheets/u/0/"]');
    await until(() => tvA.received('open').length === 3, 8000, 'sheets');
    assert.equal(tvA.received("open")[2].args.url, "https://docs.google.com/spreadsheets/u/0/");

    await page.fill('#yt', 'lofi hindi songs');
    await page.click('#ytForm button');
    assert.deepEqual((await lastCmd(tvA, 'youtube')).args, { q: 'lofi hindi songs' });

    await page.click('button[data-key="next_slide"]');
    assert.equal((await lastCmd(tvA, 'key')).args.key, 'next_slide');
    assert.equal(await toastText(page, /Next slide/), 'Next slide.');

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
    await toastText(page, /40 apps found/);
    const labels = await page.$$eval('#apps button', bs => bs.map(b => b.textContent));
    assert.equal(labels.length, 40);
    assert.deepEqual(labels, tvA.apps.map(a => a.label));
    assert.equal(tvA.acks.filter(a => a.re === tvA.received('apps')[0].id).length, 3, 'ack came in 3 parts');
    await page.fill('#appFilter', 'app 3');
    assert.equal(await page.locator('#apps button').count(), 10);   // App 30 ... App 39
    await page.click('#apps button:has-text("App 33")');
    assert.equal((await lastCmd(tvA, 'app')).args.pkg, 'com.example.app33');
    await toastText(page, /Opened the app on the TV/);
    await page.done();
});

test('file under 15 MB is encrypted, uploaded and opened; over 15 MB is refused with help', async () => {
    const page = await open();
    await pairA(page);
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    const filesBefore = relay.files.size;
    await page.setInputFiles('#file', { name: 'Sales.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: bytes });
    assert.equal(await toastText(page, /Opened Sales\.pptx on the TV/, 20000), 'Opened Sales.pptx on the TV.');
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
    const t = await toastText(page, /only files up to 15 MB/);
    assert.match(t, /Google Drive/);
    assert.equal(await page.getAttribute('#toastLink', 'href'), LAN);
    assert.equal(await page.isVisible('#fileMsg'), true);
    assert.match(await page.textContent('#fileMsg'), /This file is 15\.1 MB.*Google Drive.*Same Wi-Fi page/);
    assert.equal(await page.getAttribute('#fileLan', 'href'), LAN);
    await sleep(300);
    assert.equal(relay.files.size, filesBefore + 1, 'nothing uploaded for the big file');
    assert.equal(tvA.received('file').length, 1);
    assert.deepEqual(tvA.errors, []);
    await page.done();
});

test('"All TVs" sends to every TV and reports the one that never answers', { timeout: 60000 }, async () => {
    const page = await open();
    await pairA(page);
    await page.goto(pairUrl(CODE_B, 'Reception Panasonic'));        // second TV (never answers)
    await until(() => tvB.received('ping').length === 1, 8000, 'ping to B');
    const all = page.locator('.tv-chip[data-code="all"]');
    await all.click();
    assert.match(await all.textContent(), /All TVs \(2\)/);
    assert.equal(await page.isDisabled('#loadApps'), true, 'apps need a single TV');
    await page.click('button[data-url="https://www.google.com"]');
    await until(() => tvB.received('open').length === 1 && tvA.received('open').length === 1, 8000, 'both TVs got it');
    const t = await toastText(page, /Done on 1 of 2 TVs/, 25000);
    assert.match(t, /Reception Panasonic: The TV did not answer\. Is it on and connected to the internet\? Open the Office TV app on the TV once\./);
    const rows = await page.$$eval('#resultsList li', lis => lis.map(li => ({ cls: li.className, text: li.textContent })));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { cls: 'ok', text: 'Conference DahuaOpened the link on the TV.' });
    assert.equal(rows[1].cls, 'bad');
    assert.match(rows[1].text, /^Reception PanasonicThe TV did not answer/);
    assert.equal(await page.getAttribute('.tv-chip[data-code="' + CODE_B + '"] .dot', 'class'), 'dot offline');
    assert.equal(await page.getAttribute('.tv-chip[data-code="' + CODE_A + '"] .dot', 'class'), 'dot online');
    assert.deepEqual(tvA.errors, []);
    assert.deepEqual(tvB.errors, []);
    await page.done();
});

test('"All TVs" file send: every TV gets its own encrypted upload', async () => {
    const page = await open();
    await pairA(page);
    await page.goto(pairUrl(CODE_C, 'Board Room'));
    await toastText(page, /Board Room is connected/);
    await page.click('.tv-chip[data-code="all"]');
    const bytes = Buffer.from('%PDF-1.4 sab tv test '.repeat(5000));
    await page.setInputFiles('#file', { name: 'Agenda.pdf', mimeType: 'application/pdf', buffer: bytes });
    await toastText(page, /Done on all 2 TVs/, 20000);
    for (const tv of [tvA, tvC]) {
        assert.equal(tv.files.length, 1);
        assert.ok(Buffer.from(tv.files[0].bytes).equals(bytes));
    }
    const uploads = relay.posts.filter(p => p.query === '?filename=otv.bin&firebase=no');
    assert.deepEqual(uploads.map(u => u.topic).sort(), [tvA.topic, tvC.topic].sort());
    const rows = await page.$$eval('#resultsList li', lis => lis.map(li => li.textContent));
    assert.deepEqual(rows, ['Conference DahuaOpened Agenda.pdf on the TV.', 'Board RoomOpened Agenda.pdf on the TV.']);
    await page.done();
});

test('rate limit (HTTP 429) explains the free daily limit and offers the Same Wi-Fi page', async () => {
    const page = await open({ viewport: { width: 390, height: 844 } });
    await pairA(page);
    relay.rateLimit = true;
    await page.click('button[data-key="play_pause"]');
    const t = await toastText(page, /free limit/);
    assert.match(t, /Today's free limit has been reached/);
    assert.match(t, /Same Wi-Fi page/);
    assert.equal(await page.isVisible('#toastLink'), true);
    assert.equal(await page.getAttribute('#toastLink', 'href'), LAN);
    assert.equal(await page.textContent('#toastLink'), 'Same Wi-Fi page');
    await page.screenshot({ path: join(SHOTS, 'phone-390-rate-limit.png') });
    assert.equal(tvA.received('key').length, 0);
    relay.rateLimitCode = 42901;                  // short burst limit: different advice
    await page.click('button[data-key="next_slide"]');
    assert.match(await toastText(page, /Wait 1 minute/), /Too many commands/);
    relay.rateLimit = false;
    await page.click('button[data-key="play_pause"]');
    assert.equal(await toastText(page, /Pressed Play\/Pause/), 'Pressed Play/Pause.');
    // Chromium itself logs the 429 response as a console error; nothing else is allowed.
    await page.done([/status of 429/]);
});

test('keep-awake toggle sends awake off/on and follows the TV status', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.isChecked('#awake'), true);
    await page.click('#awake');
    assert.deepEqual((await lastCmd(tvA, 'awake')).args, { on: false });
    await toastText(page, /turn off at the usual time/);
    assert.equal(await page.isChecked('#awake'), false);
    await page.click('#awake');
    await until(() => tvA.received('awake').length === 2, 8000, 'awake on');
    assert.deepEqual(tvA.received('awake')[1].args, { on: true });
    await toastText(page, /screen will stay on/);
    assert.equal(await page.isChecked('#awake'), true);
    // The TV says keep-awake is off: a refresh updates the switch.
    tvA.status.keepAwake = false;
    await page.click('#refreshBtn');
    await toastText(page, /The TV is online/);
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
    assert.match(await page.textContent('#permText'), /turn on Accessibility/);
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
    assert.match(await page.textContent('#renameErr'), /Type a name/);
    await page.fill('#renameInput', 'Board Room');
    await page.click('#renameOk');
    assert.deepEqual((await lastCmd(tvA, 'rename')).args, { name: 'Board Room' });
    await toastText(page, /Renamed to Board Room/);
    assert.match(await page.textContent('.tv-chip[data-code="' + CODE_A + '"]'), /Board Room/);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs')))[0].name, 'Board Room');
    await page.click('#removeBtn');
    assert.match(await page.textContent('#removeText'), /Remove "Board Room" from this browser/);
    await page.click('#removeOk');
    await toastText(page, /Removed Board Room/);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('officetv.tvs'))), []);
    assert.equal(await page.isVisible('#pairCard'), true);
    assert.equal(await page.isVisible('#controls'), false);
    await page.done();
});

test('Live Screen sends "screen" start and opens the TV LAN page with #live in a new tab', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.isVisible('#liveBtn'), true);
    assert.match(await page.getAttribute('#liveBtn', 'title'), /same Wi-Fi as the TV/);
    const ctx = page.context();
    // The LAN address is not reachable in the test; answer it locally.
    await ctx.route('http://192.168.1.50:8080/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>LAN</title>ok' }));
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#liveBtn')]);
    assert.deepEqual((await lastCmd(tvA, 'screen')).args, { action: 'start' });
    await until(() => popup.url() === 'http://192.168.1.50:8080/#live', 10000, 'live tab url');
    const t = await toastText(page, /Start now/);
    assert.match(t, /Live Screen works when this laptop is on the same Wi-Fi as the TV\./);
    assert.equal(await page.getAttribute('#toastLink', 'href'), 'http://192.168.1.50:8080/#live');
    await popup.close();
    await page.done();
});

test('Live Screen: no LAN address closes the tab and explains; hidden for All TVs', async () => {
    const page = await open();
    const saved = tvA.status.lanUrls;
    tvA.status.lanUrls = [];
    try {
        await pairA(page);
        const ctx = page.context();
        const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#liveBtn')]);
        await toastText(page, /did not report its Wi-Fi address/);
        await until(() => popup.isClosed(), 5000, 'tab closed');
        await page.goto(pairUrl(CODE_C, 'Board Room'));
        await toastText(page, /Board Room is connected/);
        await page.click('.tv-chip[data-code="all"]');
        assert.equal(await page.isVisible('#liveBtn'), false, 'Live Screen needs a single TV');
    } finally {
        tvA.status.lanUrls = saved;
    }
    await page.done();
});

test('keeps working after the relay drops the event stream', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(relay.sseCount(tvA.topic), 1);
    relay.dropStreams(tvA.topic);
    await page.click('button[data-key="home"]');                 // sent while the stream is reconnecting
    assert.equal((await lastCmd(tvA, 'key')).args.key, 'home');
    assert.equal(await toastText(page, /Pressed Home/), 'Pressed Home.');
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
    await toastText(page, /Next slide/);
    await page.done();
});

const HINGLISH = /\b(nahi|karein|kholo|kholein|jodein|jod|juda|jud|kiya|dabaya|dabayein|chalao|dikhao|hatao|badlo|aaya|akshar|jaise|mein|baaki|zyada|sab|rahe|gaya|gayi|hamesha|jagao|chunein|likhein|madad|dein|haan|naam|pehle|kuch)\b/i;

/** All user-visible text of the page, including placeholders, labels and titles. */
const pageText = page => page.evaluate(() => {
    const bits = [document.body.innerText, document.title];
    for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
        bits.push(el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '');
    }
    for (const el of document.querySelectorAll('[hidden], template, dialog')) bits.push(el.textContent);
    return bits.join('\n');
});

async function assertLayout(page, what) {
    const o = await noHorizontalOverflow(page);
    const w = page.viewportSize().width;
    assert.ok(o.scroll <= w && o.offenders.length === 0, what + ' overflow: ' + JSON.stringify(o));
    const overlaps = await page.evaluate(() => {
        // Sibling boxes inside the same flex/grid container must never overlap.
        const out = [];
        const vis = el => el.offsetParent !== null && getComputedStyle(el).position !== 'absolute' && getComputedStyle(el).position !== 'fixed';
        for (const box of document.querySelectorAll('.top, .brand, .picker, .tvbar, .actions, .row, .chips, .keys, .vol, .grid2, .col, .apps-tools, .apps, .switch, .progress-label, .pair-actions, .results .head, .dlg-actions, header, .list li')) {
            const kids = Array.from(box.children).filter(vis);
            for (let a = 0; a < kids.length; a++) {
                for (let b = a + 1; b < kids.length; b++) {
                    const r1 = kids[a].getBoundingClientRect();
                    const r2 = kids[b].getBoundingClientRect();
                    if (!r1.width || !r2.width) continue;
                    const x = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
                    const y = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
                    if (x > 1 && y > 1) out.push((box.id || box.className) + ': ' + kids[a].tagName + '#' + kids[a].id + ' / ' + kids[b].tagName + '#' + kids[b].id);
                }
            }
        }
        // Text that is clipped without an ellipsis (content wider than its box).
        for (const el of document.querySelectorAll('button, .chip, .key, h1, h2, h3, label, .meta, .help, .note')) {
            if (el.offsetParent === null) continue;
            const cs = getComputedStyle(el);
            if (cs.textOverflow === 'ellipsis' || el.closest('.apps, .sr-only') || el.querySelector('.nm')) continue;
            if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible') out.push('clipped ' + el.tagName + '#' + el.id + ' ' + el.textContent.trim().slice(0, 30));
        }
        return out.slice(0, 8);
    });
    assert.deepEqual(overlaps, [], what + ' overlaps');
}

test('page text is English only, with no Hinglish left', async () => {
    const page = await open();
    await page.goto(web.url + '/tv/');
    let text = await pageText(page);
    assert.doesNotMatch(text, HINGLISH);
    await pairA(page);
    await page.goto(pairUrl(CODE_C, 'Board Room'));
    await toastText(page, /Board Room is connected/);
    await page.click('.tv-chip[data-code="all"]');
    await page.click('button[data-key="home"]');
    await toastText(page, /Done on all 2 TVs/);
    text = await pageText(page);
    assert.doesNotMatch(text, HINGLISH);
    const src = (await (await fetch(web.url + '/tv/app.js')).text()).replace(/^\s*\/\/.*$/gm, '');
    const strings = src.match(/'(?:[^'\\\n]|\\.)*'/g).join('\n');
    assert.doesNotMatch(strings, HINGLISH, 'app.js strings are English');
    await page.done();
});

test('Chrome tip shows only when the TV reports chrome: true', async () => {
    const page = await open();
    await pairA(page);
    assert.equal(await page.isVisible('#chromeTip'), false);
    tvA.status.chrome = true;
    await page.click('#refreshBtn');
    await page.waitForSelector('#chromeTip', { state: 'visible' });
    assert.match(await page.textContent('#chromeTip'),
        /Tip: Sign in to your Google account once in Chrome on the TV, and turn on Desktop site \(Chrome ⋮ → Settings → Site settings → Desktop site\) for the full computer view\./);
    tvA.status.chrome = false;
    await page.click('#refreshBtn');
    await page.waitForSelector('#chromeTip', { state: 'hidden' });
    await page.done();
});

async function pairedTwo(page) {
    await pairA(page);
    await page.goto(pairUrl(CODE_B, 'Reception Panasonic with a very long name'));
    await page.click('.tv-chip[data-code="' + CODE_A + '"]');
    await page.click('#loadApps');
    await toastText(page, /40 apps found/);
    await page.evaluate(() => window.scrollTo(0, 0));
}

test('layout: screenshots at 1440 light, 1366 dark, 390, 360; no overflow or overlap', { timeout: 120000 }, async () => {
    // First run, phone and laptop width
    for (const vp of [{ width: 360, height: 740 }, { width: 1440, height: 900 }]) {
        const page = await open({ viewport: vp });
        await page.goto(web.url + '/tv/');
        await assertLayout(page, 'first run ' + vp.width);
        await page.screenshot({ path: join(SHOTS, 'first-run-' + vp.width + '.png'), fullPage: true });
        await page.done();
    }

    // Laptop light, 1440x900
    tvA.status.chrome = true;
    let page = await open({ viewport: { width: 1440, height: 900 } });
    await pairedTwo(page);
    await assertLayout(page, '1440 light');
    await page.screenshot({ path: join(SHOTS, 'desktop-1440-light.png') });
    await page.screenshot({ path: join(SHOTS, 'desktop-1440-light-full.png'), fullPage: true });
    const cols = await page.$$eval('#controls > .col', els => els.map(e => Math.round(e.getBoundingClientRect().left)));
    assert.equal(cols.length, 2);
    assert.ok(cols[1] > cols[0] + 300, 'two columns on a laptop');
    await page.done();

    // Laptop dark, 1366x768
    page = await open({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
    await pairedTwo(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(10, 17, 21)', 'dark background');
    await assertLayout(page, '1366 dark');
    await page.screenshot({ path: join(SHOTS, 'desktop-1366-dark.png') });
    await page.screenshot({ path: join(SHOTS, 'desktop-1366-dark-full.png'), fullPage: true });
    await page.done();

    // Phone 390x844 (light)
    page = await open({ viewport: { width: 390, height: 844 } });
    await pairedTwo(page);
    await assertLayout(page, '390');
    await page.screenshot({ path: join(SHOTS, 'phone-390.png') });
    await page.screenshot({ path: join(SHOTS, 'phone-390-full.png'), fullPage: true });
    await page.done();

    // Phone 360x740 dark, "All TVs" with the results list
    page = await open({ viewport: { width: 360, height: 740 }, colorScheme: 'dark' });
    await pairedTwo(page);
    await assertLayout(page, '360 dark');
    await page.screenshot({ path: join(SHOTS, 'phone-360-dark.png') });
    await page.click('.tv-chip[data-code="all"]');
    await page.click('button[data-key="mute"]');
    await page.waitForSelector('#results', { state: 'visible', timeout: 25000 });
    await assertLayout(page, '360 all TVs');
    await page.screenshot({ path: join(SHOTS, 'phone-360-dark-all.png'), fullPage: true });
    await page.done();
});
