// Office TV steady frame rate (steady.js): a dedicated worker that posts a tick every 33 ms. Timers on a
// background tab's main thread are throttled (down to once a second or less), a worker's are not, and the
// page handles its message events at once, so the laptop keeps sending about 30 frames per second even
// while the Office TV tab is hidden behind the shared window.
// Messages in: a number = the tick interval in ms (restarts the timer), 0 = stop.
var timer = null;

function start(ms) {
    clearInterval(timer);
    timer = setInterval(function () { postMessage(1); }, ms);
}

onmessage = function (e) {
    var ms = Number(e && e.data);
    if (ms > 0) start(Math.max(5, Math.min(1000, ms)));
    else {
        clearInterval(timer);
        timer = null;
    }
};

start(33);
