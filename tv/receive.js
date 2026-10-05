// Screen sharing receiver. The Office TV app opens this page full screen in its own WebView with
// #s=<session>&code=<pairing code>[&ip=<TV LAN IPv4>][&relay=<url>] (Office TV 3.6+ serves it from the app
// itself, so it opens without the internet). The fragment never leaves the device; it is removed from the
// address bar right away. `ip` lets the laptop reach the TV's real address at once and, for 4-digit codes,
// limits sharing to laptops on the same network. See PROTOCOL.md section 8.
import { CastReceiver, parseReceiverFragment } from './cast.js?v=12';

const $ = id => document.getElementById(id);
const video = $('video');
const bridge = window.OfficeTvCast || null; // provided by the TV app (close() only)

function show(text, sub) {
    $('status').hidden = !text;
    $('statusText').textContent = text || '';
    $('statusSub').textContent = sub || '';
}

function note(text) {
    $('note').hidden = !text;
    $('note').textContent = text || '';
}

const END_TEXT = {
    stopped: 'Screen sharing ended.',
    disconnected: 'The connection to the laptop was lost.',
    timeout: 'The laptop did not connect in time.',
    error: 'Screen sharing could not start.',
    network: 'Screen sharing works only from a laptop on the same network as this TV.',
};
const END_SUB = { network: 'Connect the laptop to the same Wi-Fi as this TV, then share again.' };

function finish(reason) {
    video.srcObject = null;
    note('');
    $('sound').hidden = true;
    show(END_TEXT[reason] || END_TEXT.stopped, END_SUB[reason] || 'Returning to the previous screen…');
    setTimeout(() => {
        if (bridge && typeof bridge.close === 'function') bridge.close();
    }, reason === 'stopped' ? 800 : reason === 'network' ? 6000 : 3000);
}

const T0 = (performance && performance.now) ? performance.now() : 0;
const since = () => Math.round(performance.now() - T0) + 'ms';

// No picture-in-picture, no controls, no remote-playback UI: the video is only ever painted full screen.
try { video.disablePictureInPicture = true; } catch (e) { /* optional */ }
try { video.disableRemotePlayback = true; } catch (e) { /* optional */ }
video.controls = false;

// Per-frame timing for the laptop's "Connection info" (no buffering, nothing is held back): the time from
// a frame's last packet arriving to it being on screen (receiveTime -> expectedDisplayTime), averaged over
// each 2 s stats interval.
const timing = { sum: 0, n: 0, first: true };

function watchFrames(stream) {
    if (typeof video.requestVideoFrameCallback !== 'function') {
        video.addEventListener('playing', () => console.info('[otv] rx page +' + since() + ' playing'), { once: true });
        return;
    }
    const onFrame = (now, meta) => {
        if (video.srcObject !== stream) return; // a new stream has its own loop
        if (timing.first) {
            timing.first = false;
            console.info('[otv] rx page +' + since() + ' first-frame ' + (meta && meta.width) + 'x' + (meta && meta.height));
        }
        const d = meta && typeof meta.receiveTime === 'number' && typeof meta.expectedDisplayTime === 'number'
            ? meta.expectedDisplayTime - meta.receiveTime : -1;
        if (d >= 0 && d < 10000) { timing.sum += d; timing.n++; }
        video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
}

/** Extra numbers for the stats message: measured TV-side delay (ms, null if unknown) and the page size in device pixels. */
function frameStats() {
    const tvMs = timing.n ? timing.sum / timing.n : null;
    timing.sum = 0;
    timing.n = 0;
    const dpr = window.devicePixelRatio || 1;
    return { tvMs, screen: Math.round(window.innerWidth * dpr) + 'x' + Math.round(window.innerHeight * dpr) };
}

async function play(stream) {
    if (video.srcObject !== stream) { video.srcObject = stream; watchFrames(stream); }
    video.muted = false;
    try {
        await video.play();
        $('sound').hidden = true;
    } catch (e) {
        // Autoplay with sound was blocked: play muted, unmute on the first key press.
        video.muted = true;
        try { await video.play(); } catch (e2) { /* stays paused until a key press */ }
        $('sound').hidden = !stream.getAudioTracks().length;
    }
}

function unmute() {
    if (!video.srcObject) return;
    video.muted = false;
    video.play().then(() => { $('sound').hidden = true; }).catch(() => { video.muted = true; });
}

function main() {
    const params = parseReceiverFragment(location.hash);
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    if (!params) {
        show('This page shows a laptop screen on an office TV.',
            'To share a screen, open nikhildiwakar-bit.github.io/Portfolio/tv on a laptop.');
        return;
    }
    if (typeof RTCPeerConnection !== 'function') {
        show('This TV cannot receive screen sharing.', 'Please update Android System WebView or Google Chrome on the TV.');
        return;
    }
    show('Waiting for the laptop…', 'Screen sharing is starting.');
    const rx = new CastReceiver(Object.assign({}, params, {
        onstate: s => {
            if (s === 'connecting') show('Connecting to the laptop…');
            else if (s === 'playing') { show(''); note(''); }
            else if (s === 'reconnecting') note('Reconnecting to the laptop…');
        },
        ontrack: stream => { play(stream); },
        onend: reason => finish(reason),
        extraStats: frameStats,
        video: window.OfficeTvVideo || null, // Office TV 3.7+: the laptop's stream decoded by the TV's hardware
    }));
    window.__otvCast = rx; // for tests
    document.addEventListener('keydown', unmute);
    document.addEventListener('click', unmute);
    // The TV app closing this screen: close the connection so the laptop knows at once.
    window.addEventListener('pagehide', () => rx.end('stopped'));
    rx.start().catch(() => rx.end('error'));
}

main();
