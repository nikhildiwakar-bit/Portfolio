// Browser tests for the TV's own LAN page (tv-app/app/src/main/assets/index.html), served statically
// with the JSON API (/api/*, see WebServer.java) mocked through Playwright routing.
// Run: node --test tv-app/tests/web/   Screenshots go to $OTV_SHOTS (default: <tmp>/officetv-shots).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStatic } from './servers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '../../app/src/main/assets');
const SHOTS = process.env.OTV_SHOTS || join(tmpdir(), 'officetv-shots');
const HINGLISH = /\b(nahi|karein|kholo|kholein|jodein|juda|kiya|dabaya|chalao|dikhao|hatao|badlo|aaya|akshar|jaise|mein|baaki|zyada|hamesha|jagao|chuniye|daalein|chahiye|hua|ho raha|sirf|bina|kahin)\b/i;

let browser, web;

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (e) {
        const root = execSync('npm root -g').toString().trim();
        return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
    }
}

before(async () => {
    const { chromium } = await loadPlaywright();
    mkdirSync(SHOTS, { recursive: true });
    web = await startStatic(ASSETS);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
    browser = await chromium.launch({ env, args: ['--no-proxy-server'] });
});

after(async () => {
    if (browser) await browser.close();
    if (web) await web.close();
});

function mockApi(status) {
    const calls = [];
    const apps = Array.from({ length: 24 }, (_, i) => ({ label: 'App ' + (i + 1), pkg: 'com.example.app' + (i + 1) }));
    const files = [{ name: 'Quarterly review 2026 final version.pptx', size: 1 }, { name: 'Agenda.pdf', size: 1 }];
    const handler = async route => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        const body = req.method() === 'POST' && path !== '/api/upload' ? JSON.parse(req.postData() || '{}') : null;
        calls.push({ path, body, pin: req.headers()['x-pin'] });
        let json;
        if (path === '/api/status') json = status;
        else if (path === '/api/apps') json = apps;
        else if (path === '/api/files') json = files;
        else if (path === '/api/open') json = { ok: true, msg: 'Opened the link on the TV.' };
        else if (path === '/api/key') json = { ok: true, msg: 'Done' };
        else if (path === '/api/upload') json = { ok: true, msg: 'Opened the file on the TV.' };
        else json = { ok: true, msg: 'Done.' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    };
    return { calls, handler };
}

async function open(viewport, colorScheme, status) {
    const ctx = await browser.newContext({ viewport, colorScheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    const api = mockApi(status);
    await page.route('**/api/**', api.handler);
    await page.goto(web.url + '/index.html?pin=1234');
    await page.waitForFunction(() => document.getElementById('pill').textContent === 'Connected');
    return { page, ctx, errors, api };
}

const STATUS = {
    name: 'Conference Dahua', android: '11', accessibility: true, needsPermission: false, volume: 6, maxVolume: 15,
    keepAwake: true, appVersion: '1.2', flavor: 'full', port: 8080, chrome: true, youtubeApp: true,
};

async function layoutProblems(page) {
    return page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const out = [];
        if (document.documentElement.scrollWidth > w) out.push('scrollWidth ' + document.documentElement.scrollWidth);
        for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width && el.offsetParent !== null && getComputedStyle(el).position !== 'fixed' && (r.right > w + 1 || r.left < -1)) {
                out.push('outside ' + el.tagName + '.' + el.className);
            }
        }
        for (const box of document.querySelectorAll('header, .brand, .row, .chips, .keys, .vol, .grid2, .col, .apps, .switch, .actions, .list li')) {
            const kids = Array.from(box.children).filter(k => k.offsetParent !== null && getComputedStyle(k).position === 'static');
            for (let a = 0; a < kids.length; a++) {
                for (let b = a + 1; b < kids.length; b++) {
                    const r1 = kids[a].getBoundingClientRect();
                    const r2 = kids[b].getBoundingClientRect();
                    const x = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
                    const y = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
                    if (x > 1 && y > 1) out.push('overlap in ' + box.className + ': ' + kids[a].tagName + ' / ' + kids[b].tagName);
                }
            }
        }
        return out.slice(0, 8);
    });
}

test('LAN page: English text, status, Chrome tip, actions and PIN header', async () => {
    const { page, ctx, errors, api } = await open({ width: 390, height: 844 }, 'light', STATUS);
    assert.equal(await page.textContent('#tvName'), 'Conference Dahua');
    assert.equal(await page.isVisible('#chromeTip'), true);
    assert.match(await page.textContent('#chromeTip'), /Tip: turn on Desktop site in Chrome on the TV/);
    assert.equal(await page.isVisible('#banner'), false);
    const text = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[placeholder],[aria-label]')]
        .map(e => (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')).join(' ')
        + document.getElementById('banner').textContent + document.querySelector('script:not([src])').textContent.match(/'[^'\n]*'/g).join(' '));
    assert.doesNotMatch(text, HINGLISH);
    await page.fill('#url', 'https://example.com');
    await page.click('#openForm button');
    await page.waitForFunction(() => /Opened the link/.test(document.getElementById('toast').textContent));
    await page.click('button[data-key="next_slide"]');
    await page.click('#loadApps');
    await page.waitForSelector('#apps button');
    assert.equal(await page.locator('#apps button').count(), 24);
    assert.equal(await page.locator('#files li').count(), 2);
    const openCall = api.calls.find(c => c.path === '/api/open');
    assert.deepEqual(openCall.body, { url: 'https://example.com' });
    assert.equal(openCall.pin, '1234');
    assert.deepEqual(api.calls.find(c => c.path === '/api/key').body, { key: 'next_slide' });
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('LAN page: permission banner, no Chrome tip without Chrome', async () => {
    const { page, ctx, errors } = await open({ width: 390, height: 844 }, 'light', Object.assign({}, STATUS, { needsPermission: true, chrome: false }));
    assert.equal(await page.isVisible('#banner'), true);
    assert.equal(await page.isVisible('#chromeTip'), false);
    assert.deepEqual(errors, []);
    await ctx.close();
});

test('LAN page layout: screenshots at 390x844 and 1280x800, no overflow or overlap', { timeout: 60000 }, async () => {
    for (const [vp, scheme, name] of [[{ width: 390, height: 844 }, 'light', 'lan-390'], [{ width: 1280, height: 800 }, 'light', 'lan-1280'],
        [{ width: 360, height: 740 }, 'dark', 'lan-360-dark'], [{ width: 1280, height: 800 }, 'dark', 'lan-1280-dark']]) {
        const { page, ctx, errors } = await open(vp, scheme, Object.assign({}, STATUS, { needsPermission: true }));
        await page.click('#loadApps');
        await page.waitForSelector('#apps button');
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.deepEqual(await layoutProblems(page), [], name);
        await page.screenshot({ path: join(SHOTS, name + '.png') });
        await page.screenshot({ path: join(SHOTS, name + '-full.png'), fullPage: true });
        assert.deepEqual(errors, []);
        await ctx.close();
    }
});
