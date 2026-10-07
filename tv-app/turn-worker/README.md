# Office TV guest relay (TURN) — one-time setup

Guest sharing (Office TV 4.3+) lets a laptop on **another network** (a guest on mobile data or a hotspot)
share to a TV after someone at the TV presses **OK**. Two networks often cannot reach each other directly,
so the picture then goes through a **TURN relay**. This folder is a tiny Cloudflare Worker that hands out
TURN passwords that expire after 8 hours. The real Cloudflare key stays inside the Worker.

Without this setup, guest sharing still works when the two networks can reach each other (often from home
broadband, rarely from mobile data). With it, it works almost everywhere.

**Cost:** Cloudflare Realtime TURN includes 1,000 GB a month free, then US$0.05 per GB. One hour of a guest
sharing a full-HD screen is about 2-3 GB, so a school stays in the free part. Laptops on the school Wi-Fi
never use the relay (they connect straight to the TV).

**Privacy:** the relay forwards encrypted packets (DTLS-SRTP). It cannot see the screen or hear the sound.

## Steps (about 10 minutes, all in the browser)

1. Open <https://dash.cloudflare.com> and sign up (free) or log in.
2. **Create the TURN key**
   - In the left menu open **Realtime** (older name: *Calls*) → **TURN Server** → **Create**.
   - Name: `office-tv`. Create it.
   - Copy the **Turn Token ID** and the **API Token** into a note. The API token is shown only once.
3. **Create the Worker**
   - Left menu: **Workers & Pages** → **Create** → **Create Worker**.
   - Name: `office-tv-turn` → **Deploy**.
   - Click **Edit code**, delete everything in `worker.js`, paste the whole of
     [`worker.js`](./worker.js) from this folder, then click **Deploy**.
4. **Add the two secrets**
   - Open the Worker → **Settings** → **Variables and Secrets** → **Add**:
     - Type **Secret**, name `TURN_KEY_ID`, value = the Turn Token ID.
     - Type **Secret**, name `TURN_KEY_API_TOKEN`, value = the API Token.
   - Click **Deploy**.
5. **Check it**: open `https://office-tv-turn.<your-account>.workers.dev/ice` in a browser. You should see
   text starting with `{"iceServers":[`. If you see `TURN key not configured`, redo step 4.
6. **Send that address** (ending in `/ice`) to the developer. It goes into `ICE_URL` in `tv/cast.js`, and
   the website and the next TV app release use it.

Never send the API Token itself to anyone. If it leaks, delete the TURN key in Cloudflare and make a new one.

## For developers

- `GET /ice` → `{"iceServers":[...]}` from `POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers`
  (ttl 8 h), cached for an hour per Worker instance. Browsers from other sites get 403 (Origin check).
- Clients: `loadIceServers()` in `tv/cast.js` (STUN only if `ICE_URL` is empty, the Worker is down, or it
  takes over 2.5 s). Tests: `tv-app/tests/node/turn-worker.test.mjs`, `tv-app/tests/node/guest.test.mjs`.
