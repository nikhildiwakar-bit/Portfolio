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

## What you need

- **TV:** Android 5.0 or newer (Android TVs, Google TV, interactive panels such as Dahua or Panasonic), with a
  current **Android System WebView** (version 72 or newer; the TV's home screen tells you if it needs an
  update). Tested on a Dahua interactive panel ("Droidlogic t982_ar301", Android 11).
- **Laptop:** a laptop, Chromebook or MacBook with a current desktop browser.
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
- **Rename TV:** the name laptops see, for example "Conference Room".
- **New TV code** (asks first): laptops that saved the old code need the new one. Use it if the code was
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
| No sound | Press OK on the TV remote once. Share a browser tab with "Share tab audio", or the whole screen with system audio (Windows / ChromeOS). |

## Privacy and security

- Every message between the website and the TV is end-to-end encrypted with a key derived from the TV code
  (AES-256-GCM). ntfy.sh only sees random-looking text. The video itself never goes through ntfy.sh.
- The TV code travels only in URL fragments, which browsers never send to a server.
- The app has no web server and accepts nothing from the local network. It can only open its own receiver
  page on the website; it cannot be told to open other apps, links or files.
- The APK signing key (`app/officetv.keystore`) is in the repo so every build installs as an update over the
  last one. That is fine for sideloading in an office; a Play Store release would need its own key.

## Office TV 3.0 changes

Screen sharing from laptops is now the whole product. Removed: remote control (keys, volume, apps, links,
YouTube and Google-app shortcuts), Live Screen (TV to laptop), sending files, the QR code, and the same-Wi-Fi
LAN page with its PIN. Commands for those features get "This feature is not available on this TV app version."

## For developers

- `app/`: the Android app (Java, minSdk 21, targetSdk 33, no third-party libraries; flavors `full` and `lite`).
  `MainActivity` (home screen), `CastActivity` (WebRTC receiver in a WebView), `Commands` (`ping`, `cast`),
  `RelayManager` + `relay/` (pure-Java ntfy client and crypto), `ControlService` (foreground service, Wi-Fi
  lock, keep-awake), `BootReceiver` + `ServiceJob` (start at boot / watchdog), `CrashLog`, `Tls`.
  `src/debug/DebugHooks` adds test log lines and a loopback-only test API; `src/release` has no-op stubs.
- Protocol: [`PROTOCOL.md`](PROTOCOL.md). The website (`../tv/`) implements the other side.
- Build: Android SDK + JDK 17, `gradle assembleFullRelease assembleLiteRelease` (CI: `.github/workflows/tv-app.yml`
  publishes the `tv-app-latest` release).
- Tests without an Android SDK:
  - `sh tests/compile-check.sh` compiles all app sources (debug and release) against the Android 13 jar and
    rejects APIs missing on Android 5 → `COMPILE OK`.
  - `bash tests/jvm/run.sh`: relay client against a fake ntfy (https and http), test vectors, and the app's
    command contract (`tests/jvm/app/CommandsTest.java`).
  - `node --test tests/node/` and `node --test tests/web/` test the website.
- Emulator tests (`.github/workflows/tv-app-test.yml`, Android 5 to 14, phone and TV images, both flavors):
  `ci/smoke.sh` installs the debug APK, checks the home screen (code, link, no overlapping text), crashes and
  ANRs, the removed commands, screen sharing from the background (one screen per session, Back, stop), that the
  relay reaches CONNECTED, and a real encrypted `ping` + `cast start/stop` through ntfy.sh with
  `ci/relay-cast.mjs` (network problems and HTTP 429 are warnings). Screenshots are published as the
  `ci-screens` pre-release.
