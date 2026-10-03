// A scripted fake Office TV for tests. It speaks the real protocol (tv/otv.js): it decrypts c2t
// commands, checks freshness like the TV does, and publishes encrypted t2c acks. The website uses only
// 'ping' and 'cast'. Transport is injected: publish(topic, envelope, via) where via is the transport the
// command came over ('ntfy' or 'mqtt'; the real TV acks on that transport). Feed it with handle(ntfyEvent)
// for ntfy and handle({event: 'message', message: envelope}, 'mqtt', <broker>) for an MQTT broker. The same
// command over another connection (a second broker, or the website's ntfy copy) is counted in duplicates and
// not answered again; the same id twice over one connection is an error.
import * as otv from '../../../tv/otv.js';

export async function createFakeTv({
    code,
    name = 'Fake TV',
    publish,
    silent = false,
    delayMs = 15,
    status = {},
} = {}) {
    const topic = await otv.deriveTopic(code);
    const key = await otv.deriveKey(code);
    const initialStatus = Object.assign({ name, model: 'Fake LPH65', android: '11', appVersion: '2.5', flavor: 'full' }, status);
    const tv = {
        code, topic, key, silent,
        commands: [],      // decrypted c2t messages that passed the checks
        errors: [],        // protocol problems noticed by the fake TV
        acks: [],          // plaintext acks sent
        vias: [],          // transport of each accepted command, in order
        duplicates: 0,     // copies of an accepted command that came over another transport
        seen: new Map(),   // id -> Set of transports it came over
        status: Object.assign({}, initialStatus),
        castAck: null,     // optional override: (args) => {ok, msg, data}
        oncast: null,      // (session) => void, like CastActivity opening the receiver
        oncaststop: null,  // (session) => void
    };

    /** Forget everything received and restore the initial status (between tests). */
    tv.reset = () => {
        tv.commands.length = 0;
        tv.errors.length = 0;
        tv.acks.length = 0;
        tv.vias.length = 0;
        tv.duplicates = 0;
        tv.silent = silent;
        tv.castAck = null;
        tv.oncast = null;
        tv.oncaststop = null;
        tv.status = Object.assign({}, initialStatus);
    };

    const result = (ok, msg, data) => ({ ok, msg, data: data || {} });

    function run(m) {
        const a = m.args && typeof m.args === 'object' ? m.args : {};
        switch (m.cmd) {
            case 'ping': return result(true, 'The TV is online.', Object.assign({}, tv.status));
            case 'cast':
                if (a.action === 'stop') {
                    if (typeof tv.oncaststop === 'function') tv.oncaststop(a.session);
                    return result(true, 'Screen sharing stopped on the TV.');
                }
                if (!/^[a-z0-9]{12,32}$/.test(String(a.session || ''))) return result(false, 'Invalid screen sharing session.');
                if (typeof tv.castAck === 'function') return tv.castAck(a);
                if (typeof tv.oncast === 'function') tv.oncast(a.session);
                return result(true, 'The TV is ready to show your screen.');
            default: return result(false, 'This TV app does not support that command. Please update Office TV on the TV.');
        }
    }

    /**
     * Feed every relay event of the topic here (ntfy JSON event objects); via = the transport it came over,
     * source = the connection (e.g. which broker; like the real TV, one copy per broker is normal).
     */
    tv.handle = async (ev, via = 'ntfy', source = via) => {
        if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') return;
        if (!ev.message.startsWith('otv1.')) return;
        const m = await otv.open(key, topic, ev.message);
        if (!m || m.dir !== 'c2t') return;
        const t = typeof ev.time === 'number' ? ev.time : Date.now() / 1000;
        if (Math.abs(m.ts / 1000 - t) > 300) {
            tv.errors.push('stale command ' + m.id);
            return;
        }
        if (m.v !== 1 || typeof m.id !== 'string' || m.id.length < 10) {
            tv.errors.push('bad id ' + m.id);
            return;
        }
        const seen = tv.seen.get(m.id);
        if (seen) {
            if (seen.has(source)) tv.errors.push('repeated id ' + m.id + ' over ' + source);
            else tv.duplicates++;
            seen.add(source);
            return;
        }
        tv.seen.set(m.id, new Set([source]));
        tv.commands.push(m);
        tv.vias.push(via);
        if (tv.silent) return;
        const reply = run(m);
        await new Promise(r => setTimeout(r, delayMs));
        const ack = Object.assign({ v: 1, dir: 't2c', id: otv.newId(), re: m.id, ts: Date.now() }, reply, { part: 0, parts: 1 });
        const env = await otv.seal(key, topic, ack);
        if (env.length >= otv.MAX_ENVELOPE_BYTES) tv.errors.push('ack envelope too big: ' + env.length);
        tv.acks.push(ack);
        await publish(topic, env, via);
    };

    /** Commands received so far with a given cmd. */
    tv.received = cmd => tv.commands.filter(c => c.cmd === cmd);
    return tv;
}
