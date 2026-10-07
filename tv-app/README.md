# Office TV

Show your laptop screen on the office TV, like a Chromecast, without cables, adapters or IP addresses.

```
Laptop, Chromebook or MacBook                     Office TV (Android)
  browser: nikhildiwakar-bit.github.io/Portfolio/tv   Office TV app
  enter the TV code, pick what to share  ─────────▶  your screen, full size, with sound
```

1. Install the **Office TV** app on the TV once (below). The TV shows a code such as `7K3M9-QX2TD`.
2. On the laptop, open **nikhildiwakar-bit.github.io/Portfolio/tv** and enter the code.
3. The browser asks what to share (a tab, a window or the whole screen). Pick one and it appears on the TV.
   Next time, the website remembers the TV: one click on **Share my screen**.
4. Stop from the laptop (the browser's "Stop sharing" bar), or press **Back** on the TV remote.

The browser's screen picker and its one click are required by every browser for privacy; nothing can skip it.

**Android phones (3.3+):** the TV's home screen also shows a QR code. On an Android phone on the same Wi-Fi,
scan it with the camera, install Office TV once (the same `OfficeTV.apk`), open the link with Office TV and tap
**Start now**. The phone screen appears on the TV with low delay, sent straight over the local network (no
internet, no browser). On Android 10 and newer the phone's sound plays on the TV too (3.5+): the first time,
allow Office TV to **record audio** when Android asks. It only takes the sound of apps playing on the phone, never
the microphone. Some apps block capture (for example apps that forbid recording) and stay silent on the TV. On
Android 5–9 the phone sends the picture only. Press **Back** on the remote or **Stop** on the phone to end it.
iPhones are not supported.

## What you need

- **TV:** Android 5.0 or newer (Android TVs, Google TV, interactive panels such as Dahua or Panasonic), with a
  current **Android System WebView** (version 72 or newer; the TV's home screen tells you if it needs an
  update). Tested on a Dahua interactive panel ("Droidlogic t982_ar301", Android 11).
- **Laptop:** a laptop, Chromebook or MacBook with a current desktop browser.
- **Phone (optional):** an Android phone (Android 5.0+; the sound needs Android 10+) on the same Wi-Fi as the
  TV. The network must let devices reach each other (TCP port 47300; guest Wi-Fi with client isolation blocks it).
- **Network:** both need internet. The video goes directly from the laptop to the TV, so it works best when
  both are on the same office network. The network must allow `ntfy.sh` (the free service that passes the
  first encrypted "hello" messages between the website and the TV).

## Install on the TV

1. Download the APK (no login needed):
   **https://github.com/nikhildiwakar-bit/Portfolio/releases/download/tv-app-latest/OfficeTV.apk**
   Open the link in the TV's browser, or download it on a PC and copy it to a USB stick.
2. Open the file with the TV's file manager and choose **Install**. If Android asks, allow installing from
   this source.
3. Open **Office TV**. The home screen shows the TV code and the website address.

`OfficeTV-lite.apk` (same release) is the same app without the Accessibility service, for TVs where Play
Protect or "Restricted setting" blocks it.

## One-time setup (Android 10 and newer)

Android 10+ only lets an app open a full-screen view by itself if you allow it. Until then the home screen
shows **Allow Office TV to open automatically**:

- **OfficeTV.apk:** press **Open Accessibility settings** → **Office TV** → **On**. The service only lets the
  app open its screen-sharing view; it reads nothing on the screen and presses nothing.
  If Android says "Restricted setting" (Android 13+), use **Use "Display over other apps" instead**.
- **OfficeTV-lite.apk:** press **Allow "Display over other apps"** → allow Office TV.

The row disappears once it is done. Without it, sharing still works while the Office TV home screen is open.

## The TV's home screen

- The **TV code** and where to enter it, in large type for people across the room.
- **Status:** "Online · Ready for screen sharing", or what to do: "No internet" (check Wi-Fi or the cable),
  "Can't reach the connection service" (the network blocks ntfy.sh; ask IT to allow it), "Can't connect
  securely" (fix the TV's date and time), "Busy right now" (the free service's limit; it retries by itself).
- **Keep screen on** (default on): the TV does not go to sleep.
- **Share an Android phone:** a QR code with the TV's local address and a secret, and the TV address as text.
  It updates by itself when the TV's IP address changes.
- **Rename TV:** the name laptops and phones see, for example "Conference Room".
- **New TV code** (asks first): laptops that saved the old code need the new one, and phones must scan the
  new QR code (a connected phone is disconnected). Use it if the code was
  shared with someone who should no longer use this TV.
- A small line at the bottom with the Android, model, app and WebView versions and the last crash, if any
  (for support).

Office TV starts by itself when the TV powers on or the app is updated, and keeps running in the background.

## Troubleshooting

| What you see | What to do |
|---|---|
| The laptop says the TV needs a one-time setup | Do the setup above on the TV. |
| "Update Android System WebView" (TV or laptop) | Update **Android System WebView** (or Google Chrome) in the TV's app store. |
| The TV shows "Waiting for the laptop…" and nothing comes | The laptop and the TV cannot reach each other directly. Put both on the same office network (not a guest Wi-Fi that isolates devices). |
| "Can't load screen sharing" on the TV | The TV has no internet, or the website is down. Check the TV's network and share again. |
| The phone says "not found on this Wi-Fi" | Put the phone on the same Wi-Fi as the TV (not a guest network that isolates devices), and check the TV is on with Office TV installed. |
| The phone says the QR code is out of date | The TV code was changed. Scan the QR code on the TV again. |
| The phone says the TV is busy | Another phone is mirroring. Stop it there (or press Back on the remote), then try again. |
| The TV shows "Show this phone's screen on a TV" instead of its code | Android describes this display like a phone. Tap **This device is the TV: show the TV code** at the bottom; the TV remembers it. |
| No sound from the laptop | Press OK on the TV remote once. Share a browser tab with "Share tab audio", or the whole screen with system audio (Windows / ChromeOS). |
| No sound from the phone | The phone needs Android 10 or newer, the TV needs Office TV 3.5 or newer, and Office TV on the phone needs the **record audio** permission (allow it when Android asks, or in the phone's Settings → Apps → Office TV → Permissions → **Microphone**; only the sound of apps playing on the phone is sent, never the microphone). Some apps block capture, for example apps that forbid recording. |

## Privacy and security

- Every message between the website and the TV is end-to-end encrypted with a key derived from the TV code
  (AES-256-GCM). ntfy.sh only sees random-looking text. The video itself never goes through ntfy.sh.
- The TV code travels only in URL fragments, which browsers never send to a server.
- The app has no web server. Its only local-network listener is the phone mirroring port (47300): it
  accepts a phone only if it proves it knows the TV's 32-byte secret from the QR code (HMAC-SHA256 challenge),
  shows one phone at a time, and only shows its picture and plays its sound; it cannot be told to open apps,
  links or files. The TV proves the same secret back, so a phone never streams to the wrong device. The video and
  sound on the local network are not encrypted (like Miracast/Chromecast on a trusted network); use **New TV
  code** to replace the secret.
- On the phone, **record audio** is used only while mirroring, for the sound of apps playing on the phone
  (Android's playback capture). The microphone is never opened, and nothing is saved.
- The phone QR link keeps the TV details in the URL fragment, which the browser never sends to a server;
  `tv/phone.html` only hands it to the app.
- The APK signing key (`app/officetv.keystore`) is in the repo so every build installs as an update over the
  last one. That is fine for sideloading in an office; a Play Store release would need its own key.

## Office TV 3.0 changes

Screen sharing from laptops is now the whole product. Removed: remote control (keys, volume, apps, links,
YouTube and Google-app shortcuts), Live Screen (TV to laptop), sending files, the QR code, and the same-Wi-Fi
LAN page with its PIN. Commands for those features get "This feature is not available on this TV app version."

## Office TV 3.3 changes

Android phone mirroring: QR code on the TV home screen, `PhoneSendActivity` + `PhoneSendService` on the phone
(MediaProjection + hardware H.264 encoder), `PhoneServer` + `PhoneMirrorActivity` on the TV (TCP on the local
network, MediaCodec decoder on a SurfaceView). Status objects list the `phone` feature. Expected delay on a
good Wi-Fi: about 60–120 ms glass to glass at 1080p60 (longer on slow TV decoders or busy Wi-Fi).

## Office TV 3.3.1 changes

Fixed: pressing Back on the TV during phone mirroring closed Office TV (the goodbye message to the phone was
sent from the main thread). The home screen keeps the TV code in view on small or portrait screens. Large touch
panels that report a phone-sized screen are recognised as TVs, and the phone screen has a **This device is the
TV** button as a fallback. Laptops now send the picture at the TV's own screen size (for example 1920 x 1080
instead of 2560 x 1440): it looks the same on the TV and is much lighter for its decoder, which lowers the delay
on slow TV chips.

## Office TV 3.4 changes

Phones without the app: the TV's QR code now also carries the TV code, so `tv/phone.html` can share the phone's
screen straight from the browser (the same WebRTC casting as a laptop) where the phone's browser supports screen
capture. Tap **Share this phone's screen**, then **Start now**. Browsers without screen capture fall back to the
Office TV app.

## Office TV 3.5 changes

Phone mirroring with sound: on Android 10 and newer, the sound of the apps playing on the phone plays on the TV
with the picture. It needs one extra permission, **record audio**, which Android asks for the first time; Office
TV only takes the sound of apps playing on the phone, never the microphone. Some apps block capture (for example
apps that forbid recording) and stay silent on the TV. On Android 5–9 phones mirroring stays video only. The
sound travels as uncompressed 16-bit PCM, 48 kHz stereo, in 10 ms chunks on the same connection as the picture
(about 1.5 Mbit/s, PROTOCOL.md section 10); the TV keeps at most about 150 ms of it waiting, so it stays in step
with the picture. A TV with an older Office TV shows the picture without sound.

## Office TV 4.3 changes (guest sharing)

- A laptop on another network (a guest on mobile data or a hotspot) can share with the 4-digit code: the TV
  shows "A guest laptop wants to share its screen" with a 3-digit number that the guest's laptop shows too.
  OK on the remote (or a tap on the panel) allows it; Back or "Don't allow" refuses; no answer in 90 s
  refuses. Nothing from the laptop (picture, sound or direct video) reaches the screen before the OK.
- Laptops on the school network connect as before, with no question.
- For guests behind mobile data, set up the free TURN relay once: see turn-worker/README.md.

## Office TV 4.2 changes (long meetings)

- Wi-Fi hiccups no longer end a share: the laptop reconnects as often as needed (for up to 90 s each time),
  the TV waits 2 minutes, and dead relay connections are found in 3 s instead of 35 s.
- The laptop keeps its screen on while sharing (screen wake lock, while the Office TV tab is visible).
- The TV home screen shows why the last share ended, and warns when Android is set to turn the screen off
  without the remote (Settings > Energy saver / Power: set to Never; on Dahua panels also turn off eco /
  no-operation standby).
- Direct video recovers from a lost key frame on a still screen, and Wi-Fi trouble no longer shrinks the picture.

## Office TV 3.7 changes

- Direct video: on Chrome/Edge (Windows, ChromeOS, Ubuntu, Mac) the laptop encodes the screen itself
  (WebCodecs, H.264 hardware first) and sends it over the `otv-video` data channel; the TV app decodes it
  with MediaCodec in low-latency mode straight onto a SurfaceView, not inside the browser. If either side
  cannot do this, the normal WebRTC video is used.
- Automatic quality per laptop: 1080p60, then 900p60, 720p60, 720p30 when the laptop or network is slow.
- Sound plays on the TV only, as its own track (no lip-sync delay on the picture).
- The phone option is removed from the TV app.

## For developers

- `app/`: the Android app (Java, minSdk 21, targetSdk 33, one library: ZXing core for the QR code; flavors
  `full` and `lite`). The same APK is the TV receiver and the phone sender (`Device.isPhone`). Phone mirroring:
  `mirror/MirrorProtocol` (pure Java), `PhoneServer`, `PhoneMirrorActivity`, `PhoneAudioPlayer` (TV),
  `PhoneSendActivity`, `PhoneSendService`, `PhoneAudioCapture` (phone), `Qr` (QR code and LAN address).
  `MainActivity` (home screen), `CastActivity` (WebRTC receiver in a WebView), `Commands` (`ping`, `cast`),
  `RelayManager` + `relay/` (pure-Java ntfy client and crypto), `ControlService` (foreground service, Wi-Fi
  lock, keep-awake), `BootReceiver` + `ServiceJob` (start at boot / watchdog), `CrashLog`, `Tls`.
  `src/debug/DebugHooks` adds test log lines and a loopback-only test API (status, commands, a test tone);
  `src/release` has no-op stubs.
- Protocol: [`PROTOCOL.md`](PROTOCOL.md). The website (`../tv/`) implements the other side.
- Build: Android SDK + JDK 17, `gradle assembleFullRelease assembleLiteRelease` (CI: `.github/workflows/tv-app.yml`
  publishes the `tv-app-latest` release).
- Tests without an Android SDK:
  - `sh tests/compile-check.sh` compiles all app sources (debug and release) against the Android 13 jar and
    rejects APIs missing on Android 5 → `COMPILE OK`.
  - `bash tests/jvm/run.sh`: relay client against a fake ntfy (https and http), test vectors, and the app's
    command contract (`tests/jvm/app/CommandsTest.java`), and the phone mirroring handshake, framing, CONFIG,
    AUDIO_CONFIG and AUDIO, Annex-B, QR link and a TCP loopback session
    (`tests/jvm/mirror/MirrorProtocolTest.java`). Needs the org.json,
    android-all and ZXing core jars (see the script header).
  - `node --test tests/node/` and `node --test tests/web/` test the website.
- Emulator tests (`.github/workflows/tv-app-test.yml`, Android 5 to 14, phone and TV images, both flavors):
  `ci/smoke.sh` installs the debug APK, checks the home screen (code, link, no overlapping text), crashes and
  ANRs, the removed commands, screen sharing from the background (one screen per session, Back, stop), that the
  relay reaches CONNECTED, and a real encrypted `ping` + `cast start/stop` through ntfy.sh with
  `ci/relay-cast.mjs` (network problems and HTTP 429 are warnings). Screenshots are published as the
  `ci-screens` pre-release. On API 29, 30, 33 and 34 `ci/phone-smoke.sh` then mirrors the emulator to itself
  over 127.0.0.1 (PROJECT_MEDIA granted with appops, RECORD_AUDIO with `pm grant`) and checks the handshake,
  that `PhoneMirrorActivity` resumes and decodes frames, that the phone sends its sound and the TV plays it (a
  440 Hz test tone from the debug test API must reach the TV's player with rms ≥ 300; a quiet emulator capture
  is a warning), what the TV gets at phone media volume 0 (INFO), Back, and that an old QR code is refused.
