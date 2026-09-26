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
  ],
}, null, 2) + '\n');
console.log(topic, envelope.length);
