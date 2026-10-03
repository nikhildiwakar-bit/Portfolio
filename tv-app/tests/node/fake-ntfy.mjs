// An in-memory stand-in for ntfy.sh for the Node tests: topics, EventSource subscribers (SSE 'open' and
// 'message' events with ntfy's JSON, since= replay of the cache) and publish by POST through an injected fetch.
// mode: 'ok' | 'network' | 429 | 'daily' | 500 switches what a POST gets.
let seq = 0;

export function makeNtfy({ openDelayMs = 5, clockSkewS = 0 } = {}) {
    const ntfy = {
        subs: new Map(), posts: [], cache: [], sources: [], log: [], mode: 'ok', skew: clockSkewS,
        now() { return Math.floor(Date.now() / 1000) + this.skew; },
        subscribe(topic, fn) {
            if (!this.subs.has(topic)) this.subs.set(topic, new Set());
            this.subs.get(topic).add(fn);
            return () => this.subs.get(topic).delete(fn);
        },
        /** Delivers a message event to every subscriber of the topic (and keeps it for since=). */
        publish(topic, message, { cache = true } = {}) {
            const ev = { id: 'n' + (++seq).toString(36).padStart(9, '0'), time: this.now(), event: 'message', topic, message };
            if (cache) this.cache.push(ev);
            for (const fn of Array.from(this.subs.get(topic) || [])) fn(ev);
            return ev;
        },
        postsTo(topic) { return this.posts.filter(p => p.topic === topic); },
        open(topic) { return this.sources.filter(s => s.topic === topic && s.readyState === 1).length; },
    };
    class FakeES {
        constructor(url) {
            const u = new URL(url);
            this.url = url;
            this.readyState = 0;
            this.listeners = {};
            this.topic = u.pathname.split('/')[1];
            this.since = u.searchParams.get('since');
            ntfy.sources.push(this);
            ntfy.log.push('es:' + u.pathname + u.search);
            this._t = setTimeout(() => this._open(), openDelayMs);
        }
        _open() {
            if (this.readyState === 2) return;
            this.readyState = 1;
            const send = ev => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); };
            this.unsub = ntfy.subscribe(this.topic, send);
            ntfy.log.push('open');
            if (this.onopen) this.onopen({});
            const data = JSON.stringify({ id: 'o' + (++seq), time: ntfy.now(), event: 'open', topic: this.topic });
            for (const f of this.listeners.open || []) f({ data });
            if (this.since) {
                const list = ntfy.cache.filter(e => e.topic === this.topic);
                const i = list.findIndex(e => e.id === this.since);
                for (const ev of i >= 0 ? list.slice(i + 1) : list) send(ev);
            }
        }
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
        close() {
            this.readyState = 2;
            clearTimeout(this._t);
            if (this.unsub) this.unsub();
        }
        /** A dropped stream; permanent = what a browser does after e.g. HTTP 502 (it stops retrying). */
        drop(permanent) {
            if (this.unsub) this.unsub();
            this.unsub = null;
            this.readyState = permanent ? 2 : 0;
            if (this.onerror) this.onerror({});
            if (!permanent) this._t = setTimeout(() => this._open(), 20);
        }
    }
    ntfy.EventSource = FakeES;
    ntfy.fetch = async (url, opts) => {
        const u = new URL(url);
        const topic = u.pathname.slice(1);
        ntfy.log.push('post:' + u.search);
        if (ntfy.mode === 'network') throw new TypeError('Failed to fetch');
        if (ntfy.mode === 429) return new Response('{"code":42901,"http":429,"error":"limit reached"}', { status: 429 });
        if (ntfy.mode === 'daily') return new Response('{"code":42908,"http":429,"error":"limit reached: daily message quota reached"}', { status: 429 });
        if (ntfy.mode === 500) return new Response('oops', { status: 500 });
        ntfy.posts.push({ url, topic, body: opts.body, query: u.search });
        return new Response(JSON.stringify(ntfy.publish(topic, opts.body, { cache: u.searchParams.get('cache') !== 'no' })), { status: 200 });
    };
    return ntfy;
}
