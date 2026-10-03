// Office TV "Connection info" (PROTOCOL.md section 8): reads RTCPeerConnection.getStats() on both sides.
// The TV page sends its numbers to the laptop over the WebRTC data channel every 2 s (never over the
// relay), and the laptop page shows both with a plain-English verdict. Pure functions, no DOM.
// Keep the syntax old-browser safe (no ?. or ??): the TV's WebView may be as old as version 72.

/** How often both sides read their stats. */
export const STATS_MS = 2000;
/** Numbers from the TV older than this are not shown (the TV stopped sending). */
export const RX_STALE_MS = 7000;
/** One screen refresh at 60 Hz: the laptop's capture wait, and the TV's paint when it cannot be measured. */
export const FRAME_MS = 17;

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const r0 = v => (v === null || v === undefined ? null : Math.round(v));
const r1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/** Stats entries as an array (RTCStatsReport, Map or array). */
export function statsList(report) {
    if (!report) return [];
    if (Array.isArray(report)) return report;
    const out = [];
    if (typeof report.forEach === 'function') report.forEach(r => { if (r && typeof r === 'object') out.push(r); });
    return out;
}

/** Average of `sum` per `count` item over the interval since `prev` (all time if nothing new), times scale. */
function perItem(cur, prev, sumKey, countKey, scale) {
    const s = num(cur && cur[sumKey]);
    const c = num(cur && cur[countKey]);
    if (s === null || c === null) return null;
    const ps = num(prev && prev[sumKey]);
    const pc = num(prev && prev[countKey]);
    if (ps !== null && pc !== null && c - pc > 0 && s >= ps) return (s - ps) / (c - pc) * scale;
    return c > 0 ? s / c * scale : null;
}

/** Change of a counter since `prev`, or null. */
function delta(cur, prev, key) {
    const a = num(cur && cur[key]);
    const b = num(prev && prev[key]);
    return a !== null && b !== null && a >= b ? a - b : null;
}

/** RFC 1918 / link-local / loopback / ULA addresses and mDNS names: the same local network. */
export function isPrivateAddress(a) {
    const s = String(a || '').toLowerCase();
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(s) || /^(fe80:|fc|fd|::1$)/.test(s) || /\.local$/.test(s);
}

/** The candidate pair in use: {rttMs, local, remote (candidate types), protocol, addresses, availableBps} or null. */
export function selectedPair(stats) {
    const list = statsList(stats);
    const byId = new Map(list.map(s => [s.id, s]));
    let pair = null;
    for (const t of list) {
        if (t.type === 'transport' && t.selectedCandidatePairId && byId.has(t.selectedCandidatePairId)) { pair = byId.get(t.selectedCandidatePairId); break; }
    }
    if (!pair) pair = list.find(s => s.type === 'candidate-pair' && s.selected === true) || null;
    if (!pair) pair = list.find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') || null;
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId) || {};
    const remote = byId.get(pair.remoteCandidateId) || {};
    const rtt = num(pair.currentRoundTripTime);
    return {
        rttMs: rtt === null ? null : rtt * 1000,
        local: local.candidateType || '',
        remote: remote.candidateType || '',
        protocol: String(local.protocol || remote.protocol || '').toLowerCase(),
        localAddress: local.address || local.ip || '',
        remoteAddress: remote.address || remote.ip || '',
        availableBps: num(pair.availableOutgoingBitrate),
    };
}

/**
 * How the laptop reaches the TV: 'direct' (host candidates, or peer-reflexive ones on a private or hidden
 * address: the same network), 'router' (server-reflexive: out through the router and back, e.g. different
 * networks or Wi-Fi client isolation), 'relay' (TURN), or '' when unknown.
 */
export function connectionPath(p) {
    if (!p || !p.local || !p.remote) return '';
    if (p.local === 'relay' || p.remote === 'relay') return 'relay';
    if (p.local === 'srflx' || p.remote === 'srflx') return 'router';
    const pub = a => !!a && !isPrivateAddress(a);
    if ((p.local === 'prflx' && pub(p.localAddress)) || (p.remote === 'prflx' && pub(p.remoteAddress))) return 'router';
    return 'direct';
}

/** 'video/H264' -> 'H.264', 'video/VP8' -> 'VP8'. */
export function codecName(mime) {
    const m = String(mime || '').replace(/^video\//i, '');
    if (/^h264$/i.test(m)) return 'H.264';
    if (/^(h265|hevc)$/i.test(m)) return 'H.265';
    return m.toUpperCase();
}

/**
 * Hardware (true), software (false) or unknown (null), from powerEfficientEncoder/Decoder when the browser
 * reports it, else from the encoder/decoder name (e.g. 'ExternalDecoder' = the platform's hardware codec,
 * 'libvpx' / 'OpenH264' / 'FFmpeg' = software, '... (fallback from: ...)' = software fallback).
 */
export function hardwareFromImpl(name, powerEfficient) {
    if (powerEfficient === true || powerEfficient === false) return powerEfficient;
    const s = String(name || '');
    if (!s) return null;
    if (/fallback/i.test(s)) return false;
    if (/libvpx|openh264|ffmpeg|libaom|dav1d|rav1e|svt|software/i.test(s)) return false;
    if (/external|mediacodec|hardware|vaapi|v4l2|d3d11|dxva|videotoolbox|nvenc|nvdec|qsv|omx|c2\.|mediafoundation/i.test(s)) return true;
    return null;
}

/**
 * Hardware guess from navigator.mediaCapabilities (type 'webrtc') when getStats does not name the codec
 * implementation (Chrome hides it on pages that are not capturing, like the TV's receiver page).
 * how: 'decoding' | 'encoding'. Resolves true (power efficient = hardware), false, or null (unknown).
 */
export async function capabilityHardware(mc, how, s) {
    const fn = mc && mc[how + 'Info'];
    if (typeof fn !== 'function' || !s || !s.codec || !(s.width > 0) || !(s.height > 0)) return null;
    try {
        const r = await fn.call(mc, {
            type: 'webrtc',
            video: {
                contentType: s.codec + (s.fmtp ? ';' + s.fmtp : ''),
                width: s.width, height: s.height,
                bitrate: Math.max(100000, Math.round(s.bitrate || 5000000)),
                framerate: Math.max(1, Math.round(s.fps || 30)),
            },
        });
        return r && r.supported ? !!r.powerEfficient : null;
    } catch (e) {
        return null;
    }
}

/**
 * Remembers the mediaCapabilities answer per codec and size, so it is asked once, not every 2 s.
 * fill(s) sets s.hardware / s.hardwareFrom = 'capabilities' when getStats left them unknown.
 */
export function hardwareProbe(mc, how) {
    let key = null;
    let val = null;
    return async s => {
        if (!s || s.hardware !== null) return s;
        const k = [s.codec, s.fmtp, s.width, s.height].join('|');
        if (k !== key) {
            key = k;
            val = await capabilityHardware(mc, how, s);
        }
        if (val !== null) { s.hardware = val; s.hardwareFrom = 'capabilities'; }
        return s;
    };
}

/** The largest (most bytes) RTP stream of a type and kind. */
function mainStream(list, type, bytesKey) {
    return list.filter(s => s.type === type && (s.kind || s.mediaType) === 'video')
        .sort((a, b) => (b[bytesKey] || 0) - (a[bytesKey] || 0))[0] || null;
}

/**
 * Laptop side: the outgoing video from getStats(). prev = the previous result (for bitrate and
 * per-interval averages). Fields are null when the browser does not report them.
 */
export function parseSenderStats(report, prev) {
    const list = statsList(report);
    const byId = new Map(list.map(s => [s.id, s]));
    const o = mainStream(list, 'outbound-rtp', 'bytesSent') || {};
    const codec = byId.get(o.codecId) || {};
    const src = byId.get(o.mediaSourceId) || list.find(s => s.type === 'media-source' && s.kind === 'video') || {};
    const rin = byId.get(o.remoteId) || list.find(s => s.type === 'remote-inbound-rtp' && s.localId === o.id && o.id) || {};
    const pair = selectedPair(list) || {};
    const at = num(o.timestamp) || Date.now();
    const p = prev && prev.raw && prev.raw.ssrc === o.ssrc ? prev.raw : null;
    const dt = p ? (at - p.timestamp) / 1000 : 0;
    const bytes = delta(o, p, 'bytesSent');
    const frames = delta(o, p, 'framesSent');
    const fps = num(o.framesPerSecond);
    const rinRtt = num(rin.roundTripTime);
    const fraction = num(rin.fractionLost);
    const out = {
        at,
        codec: codec.mimeType || '',
        fmtp: codec.sdpFmtpLine || '',
        width: o.frameWidth || 0,
        height: o.frameHeight || 0,
        fps: fps !== null ? fps : (dt > 0 && frames !== null ? frames / dt : null),
        bitrate: dt > 0 && bytes !== null ? bytes * 8 / dt : null,
        targetBitrate: num(o.targetBitrate),
        availableBitrate: num(pair.availableBps),
        encoder: typeof o.encoderImplementation === 'string' ? o.encoderImplementation : '',
        powerEfficient: typeof o.powerEfficientEncoder === 'boolean' ? o.powerEfficientEncoder : null,
        hardware: null,
        hardwareFrom: '',
        limit: typeof o.qualityLimitationReason === 'string' ? o.qualityLimitationReason : '',
        encodeMs: perItem(o, p, 'totalEncodeTime', 'framesEncoded', 1000),
        pacerMs: perItem(o, p, 'totalPacketSendDelay', 'packetsSent', 1000),
        srcWidth: src.width || 0,
        srcHeight: src.height || 0,
        rttMs: num(pair.rttMs) !== null ? pair.rttMs : rinRtt !== null ? rinRtt * 1000 : null,
        lossPct: fraction !== null ? fraction * 100 : null,
        local: pair.local || '',
        remote: pair.remote || '',
        protocol: pair.protocol || '',
        path: connectionPath(pair),
        raw: {
            ssrc: o.ssrc, timestamp: at, bytesSent: o.bytesSent, framesSent: o.framesSent, framesEncoded: o.framesEncoded,
            totalEncodeTime: o.totalEncodeTime, packetsSent: o.packetsSent, totalPacketSendDelay: o.totalPacketSendDelay,
        },
    };
    out.hardware = hardwareFromImpl(out.encoder, out.powerEfficient);
    if (out.hardware !== null) out.hardwareFrom = 'stats';
    return out;
}

/** TV side: the incoming video from getStats(). prev = the previous result. */
export function parseReceiverStats(report, prev) {
    const list = statsList(report);
    const byId = new Map(list.map(s => [s.id, s]));
    const i = mainStream(list, 'inbound-rtp', 'bytesReceived') || {};
    const codec = byId.get(i.codecId) || {};
    const pair = selectedPair(list) || {};
    const at = num(i.timestamp) || Date.now();
    const p = prev && prev.raw && prev.raw.ssrc === i.ssrc ? prev.raw : null;
    const dt = p ? (at - p.timestamp) / 1000 : 0;
    const decoded = delta(i, p, 'framesDecoded');
    const dropped = delta(i, p, 'framesDropped');
    const lost = delta(i, p, 'packetsLost');
    const received = delta(i, p, 'packetsReceived');
    const fps = num(i.framesPerSecond);
    const allDecoded = num(i.framesDecoded);
    const allDropped = num(i.framesDropped);
    let dropPct = null;
    if (decoded !== null && dropped !== null && decoded + dropped > 0) dropPct = dropped / (decoded + dropped) * 100;
    else if (allDecoded !== null && allDropped !== null && allDecoded + allDropped > 0) dropPct = allDropped / (allDecoded + allDropped) * 100;
    const out = {
        at,
        codec: codec.mimeType || '',
        fmtp: codec.sdpFmtpLine || '',
        width: i.frameWidth || 0,
        height: i.frameHeight || 0,
        fps: fps !== null ? fps : (dt > 0 && decoded !== null ? decoded / dt : null),
        framesDecoded: allDecoded,
        framesDropped: allDropped,
        dropPct,
        decoder: typeof i.decoderImplementation === 'string' ? i.decoderImplementation : '',
        powerEfficient: typeof i.powerEfficientDecoder === 'boolean' ? i.powerEfficientDecoder : null,
        hardware: null,
        hardwareFrom: '',
        jitterMs: perItem(i, p, 'jitterBufferDelay', 'jitterBufferEmittedCount', 1000),
        decodeMs: perItem(i, p, 'totalDecodeTime', 'framesDecoded', 1000),
        lossPct: lost !== null && received !== null && lost + received > 0 ? lost / (lost + received) * 100 : null,
        freezes: num(i.freezeCount),
        rttMs: num(pair.rttMs),
        path: connectionPath(pair),
        raw: {
            ssrc: i.ssrc, timestamp: at, framesDecoded: i.framesDecoded, framesDropped: i.framesDropped, packetsLost: i.packetsLost,
            packetsReceived: i.packetsReceived, jitterBufferDelay: i.jitterBufferDelay, jitterBufferEmittedCount: i.jitterBufferEmittedCount,
            totalDecodeTime: i.totalDecodeTime,
        },
    };
    out.hardware = hardwareFromImpl(out.decoder, out.powerEfficient);
    if (out.hardware !== null) out.hardwareFrom = 'stats';
    return out;
}

/**
 * The TV's stats message for the data channel (JSON, about 350 bytes). extra: {tvMs} = measured time from
 * a frame arriving to it being on screen (requestVideoFrameCallback), {screen: 'WxH'} = the page's size in
 * device pixels. delayMs = estimated delay from the laptop to the TV screen (half the round trip + the TV's
 * part); the laptop adds its own capture and encode time for the total.
 */
export function receiverStatsMessage(rx, extra) {
    const e = extra || {};
    const measured = num(e.tvMs);
    let tv = measured;
    if (tv === null && (rx.jitterMs !== null || rx.decodeMs !== null)) tv = (rx.jitterMs || 0) + (rx.decodeMs || 0) + FRAME_MS;
    const net = rx.rttMs !== null ? rx.rttMs / 2 : null;
    return {
        type: 'stats', v: 1,
        codec: rx.codec, width: rx.width, height: rx.height,
        fps: r1(rx.fps), framesDecoded: rx.framesDecoded, framesDropped: rx.framesDropped, dropPct: r1(rx.dropPct),
        decoder: String(rx.decoder || '').slice(0, 80), powerEfficientDecoder: rx.powerEfficient,
        hardware: rx.hardware, hardwareFrom: rx.hardwareFrom || '',
        jitterMs: r1(rx.jitterMs), decodeMs: r1(rx.decodeMs), rttMs: r1(rx.rttMs), lossPct: r1(rx.lossPct), freezes: rx.freezes,
        tvMs: r0(tv), tvMsFrom: measured !== null ? 'measured' : 'estimated',
        delayMs: tv === null ? null : r0(tv + (net || 0)),
        screen: typeof e.screen === 'string' && /^\d{1,5}x\d{1,5}$/.test(e.screen) ? e.screen : '',
    };
}

/** Laptop side: checks a data channel message from the TV. Returns the stats or null (not a stats message). */
export function readReceiverMessage(data) {
    if (typeof data !== 'string' || data.length > 4096 || data[0] !== '{') return null;
    let m;
    try { m = JSON.parse(data); } catch (e) { return null; }
    if (!m || m.type !== 'stats') return null;
    const n = (v, max) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(v, max) : null);
    const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const b = v => (v === true || v === false ? v : null);
    return {
        codec: /^video\/[\w.-]{1,20}$/i.test(m.codec) ? m.codec : '',
        width: n(m.width, 16384) || 0, height: n(m.height, 16384) || 0,
        fps: n(m.fps, 1000), framesDecoded: n(m.framesDecoded, 1e12), framesDropped: n(m.framesDropped, 1e12), dropPct: n(m.dropPct, 100),
        decoder: s(m.decoder, 80), powerEfficient: b(m.powerEfficientDecoder), hardware: b(m.hardware),
        hardwareFrom: m.hardwareFrom === 'stats' || m.hardwareFrom === 'capabilities' ? m.hardwareFrom : '',
        jitterMs: n(m.jitterMs, 1e6), decodeMs: n(m.decodeMs, 1e6), rttMs: n(m.rttMs, 1e6), lossPct: n(m.lossPct, 100), freezes: n(m.freezes, 1e9),
        tvMs: n(m.tvMs, 1e6), tvMsFrom: m.tvMsFrom === 'measured' ? 'measured' : 'estimated', delayMs: n(m.delayMs, 1e6),
        screen: typeof m.screen === 'string' && /^\d{1,5}x\d{1,5}$/.test(m.screen) ? m.screen : '',
    };
}

/**
 * Where the delay goes: {total, laptop (capture + encode + send queue), network (half the round trip),
 * tv (arrival to screen), tvFrom: 'measured' | 'estimated'}, or null without the TV's numbers.
 * Not included: the TV panel's own picture processing after the picture leaves Android.
 */
export function delayBreakdown(tx, rx) {
    if (!tx || !rx || rx.tvMs === null || rx.tvMs === undefined) return null;
    const laptop = FRAME_MS + (num(tx.encodeMs) || 0) + (num(tx.pacerMs) || 0);
    const rtt = num(tx.rttMs) !== null ? tx.rttMs : num(rx.rttMs);
    const network = rtt !== null ? rtt / 2 : 0;
    return { total: laptop + network + rx.tvMs, laptop, network, tv: rx.tvMs, tvFrom: rx.tvMsFrom };
}

const PATH_TEXT = { direct: 'Direct connection', router: 'Through the router', relay: 'Through a relay server' };
const LEVELS = ['good', 'wait', 'warn', 'bad'];
const fmtMs = v => Math.round(v) + ' ms';
const fmtPct = v => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + '%';

/** '15 Mbps', '4.8 Mbps', '640 kbps'. */
export function formatBitrate(bps) {
    if (bps === null || bps === undefined || !isFinite(bps)) return '';
    if (bps >= 10e6) return Math.round(bps / 1e6) + ' Mbps';
    if (bps >= 1e6) return Math.round(bps / 1e5) / 10 + ' Mbps';
    return Math.round(bps / 1e3) + ' kbps';
}

const parseSize = s => {
    const m = /^(\d+)x(\d+)$/.exec(s || '');
    return m ? { w: +m[1], h: +m[2] } : null;
};

/**
 * Plain-English summary: {text, level: 'good' | 'wait' | 'warn' | 'bad', hints: [...], delay}.
 * text is like "Direct connection · H.264 hardware · ~180 ms delay"; hints explain what slows it down.
 */
export function connectionVerdict(tx, rx) {
    const hints = [];
    let level = 'good';
    const add = (lvl, text) => {
        hints.push(text);
        if (LEVELS.indexOf(lvl) > LEVELS.indexOf(level)) level = lvl;
    };
    if (!tx || !tx.codec) return { text: 'Measuring…', level: 'wait', hints: [], delay: null };
    const codec = codecName(tx.codec);
    const isH264 = codec === 'H.264';
    const dec = rx ? rx.hardware : null;
    const enc = tx.hardware;
    const delay = delayBreakdown(tx, rx);

    let codecPart = codec;
    if (dec === false) codecPart = codec + ' software on the TV';
    else if (enc === false) codecPart = codec + ' software on the laptop';
    else if (dec === true || enc === true) codecPart = codec + ' hardware';
    const parts = [PATH_TEXT[tx.path] || '', codecPart];
    if (delay) parts.push('~' + Math.round(delay.total / 10) * 10 + ' ms delay');
    const text = parts.filter(Boolean).join(' · ');

    if (!rx) add('wait', 'Waiting for the numbers from the TV…');
    if (dec === false) add('bad', 'The TV is decoding in software (' + codec + ') — slow on this TV');
    else if (!isH264 && dec === null) add('warn', 'Using ' + codec + ' instead of H.264 — TVs usually decode only H.264 in hardware');
    if (enc === false) add('warn', 'The laptop is encoding in software (' + (tx.encoder || codec) + ') — this can cost sharpness and add delay');
    if (tx.limit === 'cpu') add('warn', 'The laptop\'s processor is the limit, so it sends fewer frames per second');
    else if (tx.limit === 'bandwidth') {
        add('warn', 'Not enough network bandwidth for the full picture' + (tx.availableBitrate ? ' (' + formatBitrate(tx.availableBitrate) + ' available)' : ''));
    }
    // tx.steady (set by CastSender): false = this browser cannot keep the frame rate up (steady.js), so a
    // still screen goes out at about 1 fps and TVs that hold each frame until the next show changes late.
    if (tx.steady === false && num(tx.fps) !== null && tx.fps < 10) {
        const f = Math.max(1, Math.round(tx.fps));
        add('warn', 'This browser sends a still screen at only ' + f + (f === 1 ? ' frame' : ' frames') + ' per second, so changes can reach the TV late. Chrome or Edge keep it at 60');
    }
    if (tx.width && tx.srcWidth && tx.width < tx.srcWidth * 0.95) {
        add('warn', 'Sending ' + tx.width + ' x ' + tx.height + ', less than the captured ' + tx.srcWidth + ' x ' + tx.srcHeight);
    }
    if (tx.path === 'relay') add('warn', 'The picture goes through a relay server, which adds delay');
    else if (tx.path === 'router') add('warn', 'The laptop and the TV are not connected directly (different networks or Wi-Fi isolation), which adds delay');
    if (tx.protocol === 'tcp') add('warn', 'Connected over TCP because UDP is blocked, which adds delay');
    const rtt = num(tx.rttMs) !== null ? tx.rttMs : rx ? num(rx.rttMs) : null;
    const loss = Math.max(tx.lossPct || 0, (rx && rx.lossPct) || 0);
    if (rtt !== null && rtt >= 50) add(rtt >= 150 ? 'bad' : 'warn', 'Weak Wi-Fi (high round-trip: ' + fmtMs(rtt) + ')');
    else if (loss >= 2) add('warn', 'Weak Wi-Fi (' + fmtPct(loss) + ' of the packets are lost)');
    if (rx) {
        if (num(rx.dropPct) !== null && rx.dropPct >= 5) add(rx.dropPct >= 15 ? 'bad' : 'warn', 'The TV is dropping frames (' + fmtPct(rx.dropPct) + ') — it cannot keep up');
        if (num(tx.fps) !== null && num(rx.fps) !== null && tx.fps >= 10 && rx.fps < tx.fps * 0.7) {
            add('warn', 'The TV shows ' + Math.round(rx.fps) + ' of the ' + Math.round(tx.fps) + ' frames per second the laptop sends');
        }
        if (num(rx.decodeMs) !== null && rx.decodeMs >= 30) add('warn', 'The TV takes ' + fmtMs(rx.decodeMs) + ' to decode each frame — its decoder is slow');
        if (num(rx.jitterMs) !== null && rx.jitterMs >= 80) add('warn', 'The TV waits ' + fmtMs(rx.jitterMs) + ' for late packets (uneven Wi-Fi)');
        const scr = parseSize(rx.screen);
        if (scr && rx.width && scr.w < rx.width * 0.9 && scr.h < rx.height * 0.9) {
            add('warn', 'The TV\'s Android screen is only ' + scr.w + ' x ' + scr.h + ', so the ' + rx.width + ' x ' + rx.height + ' picture is scaled down to that');
        }
    }
    if (delay && delay.total >= 400) {
        const parts2 = [['on the TV', delay.tv], ['on the laptop', delay.laptop], ['on the network', delay.network]].sort((a, b) => b[1] - a[1]);
        add('warn', 'Most of the delay is ' + parts2[0][0] + ' (' + fmtMs(parts2[0][1]) + ')');
    }
    return { text, level, hints, delay };
}

const LIMIT_TEXT = { none: 'Nothing', cpu: 'The laptop\'s processor', bandwidth: 'Network bandwidth', other: 'Other' };
const PATH_ROW = {
    direct: 'Direct, same network',
    router: 'Through the router (not direct)',
    relay: 'Through a relay server',
};
const hwText = (name, hw, from) => {
    const kind = hw === true ? 'hardware' : hw === false ? 'software' : '';
    if (name && kind) return name + ' · ' + kind;
    if (kind) return kind + (from === 'capabilities' ? ' (reported by the web engine)' : '');
    return name || 'Not reported';
};

/** Rows for the details: [{k, label, value}]. Empty values are shown as "…" (not measured yet). */
export function connectionRows(tx, rx, verdict) {
    const rows = [];
    const row = (k, label, value) => rows.push({ k, label, value: value === null || value === undefined || value === '' ? '…' : String(value) });
    const t = tx || {};
    const v = verdict || connectionVerdict(tx, rx);
    row('codec', 'Codec', t.codec ? codecName(t.codec) + ' (' + t.codec + ')' : '');
    let res = t.width && t.height ? t.width + ' x ' + t.height : '';
    if (res && t.srcWidth && (t.srcWidth !== t.width || t.srcHeight !== t.height)) res += ' (captured ' + t.srcWidth + ' x ' + t.srcHeight + ')';
    row('res', 'Resolution sent', res);
    row('fps', 'Frame rate sent', t.fps !== null && t.fps !== undefined ? Math.round(t.fps) + ' fps' : '');
    let rate = formatBitrate(t.bitrate);
    if (rate && t.availableBitrate) rate += ' (network allows ' + formatBitrate(t.availableBitrate) + ')';
    row('bitrate', 'Bitrate', rate);
    row('encoder', 'Laptop encoder', t.codec ? hwText(t.encoder, t.hardware, t.hardwareFrom) : '');
    row('limit', 'Limited by', t.limit ? LIMIT_TEXT[t.limit] || t.limit : '');
    row('rtt', 'Round trip', t.rttMs !== null && t.rttMs !== undefined ? fmtMs(t.rttMs) : '');
    let path = PATH_ROW[t.path] || '';
    if (path) path += ' (' + t.local + ' / ' + t.remote + (t.protocol ? ', ' + t.protocol.toUpperCase() : '') + ')';
    row('path', 'Connection', path);
    const r = rx || null;
    const wait = r ? null : 'Waiting for the TV…';
    row('tvfps', 'TV frame rate', r ? (r.fps !== null ? Math.round(r.fps) + ' fps decoded' : '') : wait);
    row('tvdrop', 'TV dropped frames', r ? (r.framesDropped !== null ? r.framesDropped + (r.dropPct !== null ? ' (' + fmtPct(r.dropPct) + ')' : '') : '') : wait);
    row('tvdecoder', 'TV decoder', r ? hwText(r.decoder, r.hardware, r.hardwareFrom) : wait);
    row('tvjitter', 'TV jitter buffer', r ? (r.jitterMs !== null ? fmtMs(r.jitterMs) + ' per frame' : '') : wait);
    row('tvdecode', 'TV decode time', r ? (r.decodeMs !== null ? fmtMs(r.decodeMs) + ' per frame' : '') : wait);
    row('tvscreen', 'TV screen', r ? (r.screen ? r.screen.replace('x', ' x ') + ' pixels' : '') : wait);
    const d = v.delay;
    row('delay', 'Estimated delay', d
        ? '~' + fmtMs(d.total) + ' (laptop ' + Math.round(d.laptop) + ' + network ' + Math.round(d.network) + ' + TV ' + Math.round(d.tv) + ' ms' + (d.tvFrom === 'measured' ? ', TV part measured' : '') + ')'
        : wait);
    return rows;
}
