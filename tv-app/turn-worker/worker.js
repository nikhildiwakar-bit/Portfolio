// Office TV TURN credentials service (a Cloudflare Worker). GET /ice returns short-lived TURN servers from
// Cloudflare Realtime TURN, so a guest laptop on another network can still reach a TV through a relay.
// The TURN key's ID and API token stay here as Worker secrets (TURN_KEY_ID, TURN_KEY_API_TOKEN); the laptop
// page and the TV only ever see credentials that expire after 8 hours. Media stays end-to-end encrypted
// (DTLS-SRTP): the relay forwards packets it cannot read.

const ALLOWED_ORIGINS = ['https://nikhildiwakar-bit.github.io'];
const TTL_S = 8 * 3600;
const CACHE_S = 3600; // one set of credentials per hour is enough for everyone

function cors(origin) {
    const h = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
    if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
}

function json(body, status, origin, extra = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors(origin), extra),
    });
}

let cached = null; // {at, body} per Worker instance

async function handle(request, env) {
    const f = globalThis.fetch;
    const now = Date.now;
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET' || url.pathname !== '/ice') return json({ error: 'not found' }, 404, origin);
    // Browsers send Origin on cross-origin fetches: only the Office TV pages may ask.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'forbidden' }, 403, origin);
    if (!env || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'TURN key not configured' }, 500, origin);
    if (cached && now() - cached.at < CACHE_S * 1000) return json(cached.body, 200, origin);
    const r = await f('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(env.TURN_KEY_ID)
        + '/credentials/generate-ice-servers', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_S }),
    });
    if (!r.ok) return json({ error: 'TURN service error ' + r.status }, 502, origin);
    const data = await r.json();
    const body = { iceServers: Array.isArray(data && data.iceServers) ? data.iceServers : [] };
    if (!body.iceServers.length) return json({ error: 'no ICE servers' }, 502, origin);
    cached = { at: now(), body };
    return json(body, 200, origin);
}

export default { fetch: (request, env) => handle(request, env) };
