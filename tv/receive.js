// Screen sharing receiver. The Office TV app opens this page full screen in its own WebView with
// #s=<session>&code=<pairing code>[&relay=<url>]. The fragment never leaves the device; it is removed
// from the address bar right away. See PROTOCOL.md section 8.
import { CastReceiver, parseReceiverFragment } from './cast.js?v=1';

const $ = id => document.getElementById(id);
const video = $('video');
const bridge = window.OfficeTvCast || null; // provided by the TV app (close() only)

function show(text, sub) {
    $('status').hidden = !text;
    $('statusText').textContent = text || '';
    $('statusSub').textContent = sub || '';
}

const END_TEXT = {
    stopped: 'Screen sharing ended.',
    disconnected: 'The connection to the laptop was lost.',
    timeout: 'The laptop did not connect in time.',
    error: 'Screen sharing could not start.',
};

function finish(reason) {
    video.srcObject = null;
    $('sound').hidden = true;
    show(END_TEXT[reason] || END_TEXT.stopped, 'Returning to the previous screen…');
    setTimeout(() => {
        if (bridge && typeof bridge.close === 'function') bridge.close();
    }, reason === 'stopped' ? 800 : 3000);
}

async function play(stream) {
    if (video.srcObject !== stream) video.srcObject = stream;
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
        show('This page shows a laptop screen on an office TV.', 'Start it with "Share my screen" on the Office TV Remote page.');
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
            else if (s === 'playing') show('');
        },
        ontrack: stream => { play(stream); },
        onend: reason => finish(reason),
    }));
    window.__otvCast = rx; // for tests
    document.addEventListener('keydown', unmute);
    document.addEventListener('click', unmute);
    rx.start().catch(() => rx.end('error'));
}

main();
