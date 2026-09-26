// Unit tests for tv/otv.js. Run: node --test tv-app/tests/node/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as otv from '../../../tv/otv.js';

const V = JSON.parse(readFileSync(new URL('../vectors.json', import.meta.url), 'utf8'));
const fromHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const hex = b => Buffer.from(b).toString('hex');

test('exports and constants', () => {
    assert.equal(otv.ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    assert.equal(otv.CONTROLLER_URL, 'https://nikhildiwakar-bit.github.io/Portfolio/tv/');
    assert.equal(otv.DEFAULT_RELAY, 'https://ntfy.sh');
    for (const f of ['normalizeCode', 'displayCode', 'deriveTopic', 'deriveKey', 'seal', 'sealText', 'open',
        'sealFile', 'b64url', 'unb64url', 'newId', 'parsePairFragment']) {
        assert.equal(typeof otv[f], 'function', f);
    }
    assert.equal(typeof otv.TvLink, 'function');
});

test('normalizeCode vectors', () => {
    for (const { input, output } of V.normalize) assert.equal(otv.normalizeCode(input), output, JSON.stringify(input));
    assert.equal(otv.normalizeCode(V.code), V.code);
});

test('normalizeCode edge cases', () => {
    assert.equal(otv.normalizeCode(''), null);
    assert.equal(otv.normalizeCode(null), null);
    assert.equal(otv.normalizeCode(12345), null);
    assert.equal(otv.normalizeCode('7K3M9-QX2TD-'), '7K3M9QX2TD');
    assert.equal(otv.normalizeCode('7k3m9\tqx2td\n'), '7K3M9QX2TD');
    assert.equal(otv.normalizeCode('7K3M9QX2TDX'), null);
    assert.equal(otv.normalizeCode('7K3M9#QX2T'), null);
    assert.equal(otv.normalizeCode('ooooo-lllll'), '0000011111');
});

test('displayCode', () => {
    assert.equal(otv.displayCode(V.code), V.displayCode);
    assert.equal(otv.displayCode('7k3m9 qx2td'), V.displayCode);
    assert.equal(otv.displayCode('bad'), '');
});

test('deriveTopic and key bytes', async () => {
    assert.equal(await otv.deriveTopic(V.code), V.topic);
    assert.equal((await otv.deriveTopic(V.code)).length, 35);
    assert.equal(await otv.deriveTopic(V.displayCode.toLowerCase()), V.topic);
    assert.equal(hex(await otv.deriveKeyBytes(V.code)), V.keyHex);
    await assert.rejects(otv.deriveTopic('nope'));
    const key = await otv.deriveKey(V.code);
    assert.equal(key.algorithm.name, 'AES-GCM');
    assert.equal(key.algorithm.length, 256);
    assert.deepEqual([...key.usages].sort(), ['decrypt', 'encrypt']);
});

test('sealText with vector IV reproduces the envelope byte for byte', async () => {
    const key = await otv.deriveKey(V.code);
    const env = await otv.sealText(key, V.topic, V.message.plaintext, fromHex(V.message.ivHex));
    assert.equal(env, V.message.envelope);
    // seal() of the parsed object gives the same bytes because JSON.stringify keeps key order.
    const env2 = await otv.seal(key, V.topic, JSON.parse(V.message.plaintext), fromHex(V.message.ivHex));
    assert.equal(env2, V.message.envelope);
});

test('open() returns the plaintext object', async () => {
    const key = await otv.deriveKey(V.code);
    const obj = await otv.open(key, V.topic, V.message.envelope);
    assert.deepEqual(obj, JSON.parse(V.message.plaintext));
    // padded base64url is accepted too
    const [p, iv, ct] = V.message.envelope.split('.');
    const pad = s => s + '='.repeat((4 - s.length % 4) % 4);
    assert.deepEqual(await otv.open(key, V.topic, [p, pad(iv), pad(ct)].join('.')), obj);
});

test('open() returns null for tampered or foreign input and never throws', async () => {
    const key = await otv.deriveKey(V.code);
    const env = V.message.envelope;
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    const cases = [
        flip(env, env.length - 3),                        // ciphertext / tag
        flip(env, 6),                                     // iv
        env.replace('otv1.', 'otv2.'),
        env + '.x',
        'otv1..',
        'otv1.!!!.???',
        'hello',
        '',
        null,
        undefined,
        42,
        'otv1.' + otv.b64url(new Uint8Array(12)) + '.' + otv.b64url(new Uint8Array(8)),
    ];
    for (const c of cases) assert.equal(await otv.open(key, V.topic, c), null, String(c).slice(0, 40));
    // wrong topic (AAD) or wrong key
    assert.equal(await otv.open(key, V.topic + 'x', env), null);
    const other = await otv.deriveKey('0000000000');
    assert.equal(await otv.open(other, V.topic, env), null);
    // valid crypto but not a JSON object
    const arr = await otv.sealText(key, V.topic, '[1,2]');
    assert.equal(await otv.open(key, V.topic, arr), null);
    const notJson = await otv.sealText(key, V.topic, 'plain text');
    assert.equal(await otv.open(key, V.topic, notJson), null);
});

test('seal() round trip with random IV', async () => {
    const key = await otv.deriveKey(V.code);
    const msg = { v: 1, dir: 't2c', id: otv.newId(), re: 'abc', ok: true, msg: 'Link TV par khul gaya.', data: { x: 'हिंदी' } };
    const a = await otv.seal(key, V.topic, msg);
    const b = await otv.seal(key, V.topic, msg);
    assert.notEqual(a, b);
    assert.match(a, /^otv1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(await otv.open(key, V.topic, a), msg);
});

test('file vector decrypts with AAD topic + ":file", and sealFile matches it', async () => {
    const key = await otv.deriveKey(V.code);
    assert.equal(V.file.aad, V.topic + ':file');
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromHex(V.file.ivHex), additionalData: new TextEncoder().encode(V.file.aad), tagLength: 128 },
        key, otv.unb64url(V.file.ciphertextB64u));
    assert.equal(hex(new Uint8Array(pt)), V.file.plaintextHex);
    const sealed = await otv.sealFile(key, V.topic, fromHex(V.file.plaintextHex), fromHex(V.file.ivHex));
    assert.equal(sealed.iv, otv.b64url(fromHex(V.file.ivHex)));
    assert.equal(otv.b64url(sealed.data), V.file.ciphertextB64u);
    assert.ok(sealed.data instanceof Uint8Array);
    const back = await otv.openFile(key, V.topic, sealed.iv, sealed.data);
    assert.equal(hex(back), V.file.plaintextHex);
    // message AAD must not open a file and vice versa
    assert.equal(await otv.openFile(key, V.topic, V.message.envelope.split('.')[1], otv.unb64url(V.message.envelope.split('.')[2])), null);
    const tampered = sealed.data.slice();
    tampered[0] ^= 1;
    assert.equal(await otv.openFile(key, V.topic, sealed.iv, tampered), null);
    // random-IV sealFile round trip
    const big = new Uint8Array(randomBytes(70000));
    const s2 = await otv.sealFile(key, V.topic, big);
    assert.equal(otv.unb64url(s2.iv).length, 12);
    assert.equal(s2.data.length, big.length + 16);
    assert.deepEqual(await otv.openFile(key, V.topic, s2.iv, s2.data), big);
});

test('b64url / unb64url', () => {
    for (let n = 0; n < 40; n++) {
        const b = crypto.getRandomValues(new Uint8Array(n));
        const s = otv.b64url(b);
        assert.equal(s, Buffer.from(b).toString('base64url'));
        assert.doesNotMatch(s, /[=+/]/);
        assert.deepEqual(otv.unb64url(s), b);
        assert.deepEqual(otv.unb64url(Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')), b);
    }
    const big = new Uint8Array(randomBytes(200000));
    assert.equal(otv.b64url(big), Buffer.from(big).toString('base64url'));
    assert.throws(() => otv.unb64url('a+b/'));
    assert.throws(() => otv.unb64url('abcde'));
    assert.throws(() => otv.unb64url('ab=c'));
});

test('newId format', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
        const id = otv.newId();
        assert.match(id, /^[0-9a-z]{10,}$/);
        seen.add(id);
    }
    assert.equal(seen.size, 2000);
    assert.ok(otv.newId(4).length >= 10);
});

test('parsePairFragment', () => {
    assert.deepEqual(otv.parsePairFragment('#pair=7K3M9-QX2TD&name=Conference%20Dahua'),
        { code: '7K3M9QX2TD', name: 'Conference Dahua', relay: 'https://ntfy.sh' });
    assert.deepEqual(otv.parsePairFragment('#pair=7k3m9qx2td&name=Reception+TV&relay=https%3A%2F%2Fntfy.example.com%2F'),
        { code: '7K3M9QX2TD', name: 'Reception TV', relay: 'https://ntfy.example.com' });
    assert.deepEqual(otv.parsePairFragment('pair=7K3M9QX2TD'), { code: '7K3M9QX2TD', name: '', relay: 'https://ntfy.sh' });
    assert.deepEqual(otv.parsePairFragment(otv.CONTROLLER_URL + '#pair=7K3M9QX2TD&relay=http%3A%2F%2F127.0.0.1%3A8080'),
        { code: '7K3M9QX2TD', name: '', relay: 'http://127.0.0.1:8080' });
    assert.equal(otv.parsePairFragment('#pair=7K3M9QX2TU')?.code, undefined);
    assert.equal(otv.parsePairFragment('#pair=7K3M9'), null);
    assert.equal(otv.parsePairFragment('#name=abc'), null);
    assert.equal(otv.parsePairFragment('#pair=7K3M9QX2TD&relay=javascript%3Aalert(1)'), null);
    assert.equal(otv.parsePairFragment('#pair=7K3M9QX2TD&relay=ftp%3A%2F%2Fx'), null);
    assert.equal(otv.parsePairFragment(''), null);
    assert.equal(otv.parsePairFragment('#'), null);
    assert.equal(otv.parsePairFragment(null), null);
    const long = otv.parsePairFragment('#pair=7K3M9QX2TD&name=' + 'x'.repeat(100));
    assert.equal(long.name.length, 40);
    assert.equal(otv.parsePairFragment('#pair=7K3M9QX2TD&name=%0Aa%09b').name, 'a b');
});

test('pairLink round-trips through parsePairFragment', () => {
    const link = otv.pairLink('7K3M9QX2TD', 'Sales & Ops TV', 'https://ntfy.sh');
    assert.ok(link.startsWith(otv.CONTROLLER_URL + '#pair=7K3M9QX2TD&name='));
    assert.ok(!link.includes('relay='));
    assert.deepEqual(otv.parsePairFragment(link), { code: '7K3M9QX2TD', name: 'Sales & Ops TV', relay: 'https://ntfy.sh' });
    const link2 = otv.pairLink('7K3M9QX2TD', '', 'http://127.0.0.1:9/');
    assert.equal(otv.parsePairFragment(link2).relay, 'http://127.0.0.1:9');
});

test('mergeAcks joins multi-part apps in part order', () => {
    const r = otv.mergeAcks([
        { part: 2, parts: 3, ok: true, msg: '', data: { apps: [{ label: 'E' }] } },
        { part: 0, parts: 3, ok: true, msg: '5 apps', data: { apps: [{ label: 'A' }, { label: 'B' }] } },
        { part: 1, parts: 3, ok: true, msg: '', data: { apps: [{ label: 'C' }, { label: 'D' }] } },
    ]);
    assert.deepEqual(r, { ok: true, msg: '5 apps', data: { apps: ['A', 'B', 'C', 'D', 'E'].map(label => ({ label })) } });
    assert.equal(otv.mergeAcks([{ ok: true }, { ok: false, part: 1 }]).ok, false);
    assert.deepEqual(otv.mergeAcks([{ ok: true, msg: 'x' }]), { ok: true, msg: 'x', data: {} });
});
