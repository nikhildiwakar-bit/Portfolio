// A scripted fake Office TV for tests. It speaks the real protocol (tv/otv.js): it decrypts c2t
// commands, checks freshness like the TV does, and publishes encrypted t2c acks.
// Transport is injected: publish(topic, envelope) and getAttachment(url) -> Uint8Array.
import * as otv from '../../../tv/otv.js';

export async function createFakeTv({
    code,
    name = 'Fake TV',
    publish,
    getAttachment,
    silent = false,
    appsCount = 40,
    appsPerPart = 15,
    delayMs = 15,
    status = {},
} = {}) {
    const topic = await otv.deriveTopic(code);
    const key = await otv.deriveKey(code);
    const apps = [];
    for (let i = 1; i <= appsCount; i++) {
        apps.push({ label: 'App ' + String(i).padStart(2, '0'), pkg: 'com.example.app' + i });
    }
    const initialStatus = Object.assign({
        name, model: 'Fake LPH65', android: '11', appVersion: '1.2', flavor: 'full',
        accessibility: true, needsPermission: false, keepAwake: true, volume: 6, maxVolume: 15,
        lanUrls: ['http://192.168.1.50:8080'],
    }, status);
    const tv = {
        code, topic, key, apps, silent,
        commands: [],      // decrypted c2t messages that passed the checks
        files: [],         // {name, bytes} received through 'file'
        errors: [],        // protocol problems noticed by the fake TV
        acks: [],          // plaintext acks sent
        seen: new Set(),
        status: Object.assign({}, initialStatus),
    };

    /** Forget everything received and restore the initial status (between tests). */
    tv.reset = () => {
        tv.commands.length = 0;
        tv.files.length = 0;
        tv.errors.length = 0;
        tv.acks.length = 0;
        tv.status = Object.assign({}, initialStatus);
    };

    const result = (ok, msg, data) => ({ ok, msg, data: data || {} });

    async function run(m) {
        const a = m.args && typeof m.args === 'object' ? m.args : {};
        switch (m.cmd) {
            case 'ping': return [result(true, 'TV online hai.', Object.assign({}, tv.status))];
            case 'open':
                if (!a.url) return [result(false, 'Link khaali hai.')];
                return [result(true, 'Link TV par khul gaya.')];
            case 'youtube': return [result(true, 'Link TV par khul gaya.')];
            case 'key': return [result(true, a.key === 'play_pause' ? 'Play/Pause' : 'Done')];
            case 'volume':
                tv.status.volume = Math.round(a.percent * tv.status.maxVolume / 100);
                return [result(true, 'Volume ' + a.percent + '%')];
            case 'awake':
                tv.status.keepAwake = !!a.on;
                return [result(true, a.on ? 'Screen hamesha on rahegi.' : 'Screen normal time par band hogi.')];
            case 'app': return [result(true, 'App TV par khul gaya.')];
            case 'rename': {
                const n = String(a.name || '').trim();
                if (n.length < 1 || n.length > 40) return [result(false, 'Naam 1 se 40 akshar ka hona chahiye.')];
                tv.status.name = n;
                return [result(true, 'Naam badal diya.', Object.assign({}, tv.status))];
            }
            case 'apps': {
                const parts = [];
                for (let i = 0; i < apps.length; i += appsPerPart) parts.push(apps.slice(i, i + appsPerPart));
                if (!parts.length) parts.push([]);
                return parts.map(list => result(true, apps.length + ' apps mili.', { apps: list }));
            }
            case 'file': {
                if (!getAttachment) return [result(false, 'File download nahi hui.')];
                const enc = await getAttachment(a.url);
                if (!enc) return [result(false, 'File download nahi hui.')];
                const bytes = await otv.openFile(key, topic, a.iv, enc);
                if (!bytes) {
                    tv.errors.push('file did not decrypt');
                    return [result(false, 'File kharab hai.')];
                }
                if (bytes.length !== a.size) tv.errors.push('file size mismatch ' + bytes.length + ' != ' + a.size);
                tv.files.push({ name: a.name, bytes });
                return [result(true, a.name + ' TV par khul gaya.')];
            }
            default: return [result(false, 'Unknown: ' + m.cmd)];
        }
    }

    /** Feed every relay event of the topic here (ntfy JSON event objects). */
    tv.handle = async ev => {
        if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') return;
        if (!ev.message.startsWith('otv1.')) return;
        const m = await otv.open(key, topic, ev.message);
        if (!m || m.dir !== 'c2t') return;
        const t = typeof ev.time === 'number' ? ev.time : Date.now() / 1000;
        if (Math.abs(m.ts / 1000 - t) > 300) {
            tv.errors.push('stale command ' + m.id);
            return;
        }
        if (m.v !== 1 || typeof m.id !== 'string' || m.id.length < 10 || tv.seen.has(m.id)) {
            tv.errors.push('bad or repeated id ' + m.id);
            return;
        }
        tv.seen.add(m.id);
        tv.commands.push(m);
        if (tv.silent) return;
        const replies = await run(m);
        // Parts go out in reverse order to prove the controller does not rely on ordering.
        const order = replies.map((_, i) => i);
        if (order.length > 1) order.reverse();
        for (const i of order) {
            await new Promise(r => setTimeout(r, delayMs));
            const ack = Object.assign({ v: 1, dir: 't2c', id: otv.newId(), re: m.id, ts: Date.now() }, replies[i],
                { part: i, parts: replies.length });
            const env = await otv.seal(key, topic, ack);
            if (env.length >= otv.MAX_ENVELOPE_BYTES) tv.errors.push('ack envelope too big: ' + env.length);
            tv.acks.push(ack);
            await publish(topic, env);
        }
    };

    /** Commands received so far with a given cmd. */
    tv.received = cmd => tv.commands.filter(c => c.cmd === cmd);
    return tv;
}
