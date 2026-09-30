// Generates the canonical protocol test vectors (tv-app/tests/vectors.json).
// Both the Java (TV) and JavaScript (controller page) implementations must reproduce these exactly.
import { webcrypto as c } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const enc = new TextEncoder();
const hex = b => Buffer.from(b).toString('hex');
const b64u = b => Buffer.from(b).toString('base64url');
const sha = async s => new Uint8Array(await c.subtle.digest('SHA-256', enc.encode(s)));

const code = '7K3M9QX2TD';
const th = await sha('officetv/topic/v1:' + code);
const topic = 'otv' + hex(th.slice(0, 16));
const keyBytes = await sha('officetv/key/v1:' + code);
const key = await c.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
const iv = Uint8Array.from({ length: 12 }, (_, i) => i);
const plaintext = '{"v":1,"dir":"c2t","id":"abc123","ts":1760000000000,"cmd":"open","args":{"url":"https://docs.google.com/spreadsheets"}}';
const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(topic), tagLength: 128 }, key, enc.encode(plaintext)));
const envelope = 'otv1.' + b64u(iv) + '.' + b64u(ct);

const fileIv = Uint8Array.from({ length: 12 }, (_, i) => 100 + i);
const fileBytes = enc.encode('%PDF-1.4 tiny test file');
const fileCt = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv: fileIv, additionalData: enc.encode(topic + ':file'), tagLength: 128 }, key, fileBytes));

// Office TV 3.6+: 4-digit codes use the v2 derivation.
const short = '4821';
const shortTopic = 'otv2' + hex((await sha('officetv/topic/v2:' + short)).slice(0, 16));
const shortKeyBytes = await sha('officetv/key/v2:' + short);
const shortKey = await c.subtle.importKey('raw', shortKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
const shortPlain = '{"v":1,"dir":"c2t","id":"shortcode1","ts":1760000000000,"cmd":"ping","args":{}}';
const shortCt = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(shortTopic), tagLength: 128 }, shortKey, enc.encode(shortPlain)));

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify({
  code, displayCode: '7K3M9-QX2TD', topic, keyHex: hex(keyBytes),
  message: { ivHex: hex(iv), plaintext, envelope },
  file: { ivHex: hex(fileIv), aad: topic + ':file', plaintextHex: hex(fileBytes), ciphertextB64u: b64u(fileCt) },
  normalize: [
    { input: '7k3m9-qx2td', output: '7K3M9QX2TD' },
    { input: ' 7K3M9 QX2TD ', output: '7K3M9QX2TD' },
    { input: 'oiL3M-9QX2T', output: '0113M9QX2T' },
    { input: '7K3M9QX2T', output: null },
    { input: '7K3M9QX2TU', output: null },
    { input: '4821', output: '4821' },
    { input: ' 48-21 ', output: '4821' },
    { input: '0O12', output: '0012' },
    { input: '482', output: null },
    { input: '48213', output: null },
    { input: '48A1', output: null },
  ],
  short: { code: short, displayCode: short, topic: shortTopic, keyHex: hex(shortKeyBytes),
    message: { ivHex: hex(iv), plaintext: shortPlain, envelope: 'otv1.' + b64u(iv) + '.' + b64u(shortCt) } },
}, null, 2) + '\n');
console.log(topic, envelope.length);
