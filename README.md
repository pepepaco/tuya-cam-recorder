# tuya-cam-recorder

Record Tuya / SmartLife IP cameras to local MP4 files, without the cloud subscription and
without trusting the microSD slot.

It drives the vendor's **own web player** in headless Chromium via the DevTools Protocol.
Nothing about the proprietary WebRTC signaling is reimplemented: the browser negotiates
exactly as it would for a human, and the resulting `<video>` is captured with
`MediaRecorder`. You get real video with audio, straight to disk.

```
Chromium (headless, CDP)  ->  vendor player  ->  <video>  ->  MediaRecorder  ->  ffmpeg  ->  .mp4
```

## Why this exists

Some Tuya-based cameras (this was built against a `sp` category camera on
`protect-us.ismartlife.me`) push you toward a paid cloud plan in ways that look like
hardware faults:

- the microSD card is reported as "failed" even when it reads fine in a PC;
- opening the SD recordings disconnects the camera;
- the SD (sub) stream negotiates WebRTC, completes ICE **and** DTLS, then never sends a
  single video packet, so the player sits on a black screen while PTZ still works.

If you are in that situation, recording the live stream yourself is the sane fallback.
This tool does not defeat any protection; it uses the same session and the same player a
browser would.

## Requirements

- `chromium` (or Chrome/Edge) with DevTools Protocol
- `node` >= 22 (global `fetch` and `WebSocket`, no npm install needed)
- `ffmpeg`

Arch:

```bash
sudo pacman -S chromium nodejs ffmpeg
```

## Install

```bash
git clone <url-de-este-repositorio>
cd tuya-cam-recorder
chmod +x run.sh
```

## First run: log in once

The session lives in a Chromium profile (`.profile/`), which is gitignored. Log in once and
the profile keeps working for days:

```bash
# 1. start headless chromium (run.sh does this too, but do it once explicitly)
chromium --headless=new --no-sandbox --disable-gpu --use-gl=swiftshader \
  --remote-debugging-port=9222 --user-data-dir="$PWD/.profile" \
  --window-size=1400,1500 2>&1 &

# 2. print the login QR, then scan it with the SmartLife / iSmartLife app
node qr.mjs

# 3. check the session
node -e "import('./cdp.mjs').then(async ({attach})=>{
  const c = await attach(9222);
  console.log(await c.eval('location.href'));
})"
```

The QR expires in about a minute — run `node qr.mjs` right before scanning.

### How long does the session last?

There is **no refresh token**. Auth is a `s-sid` cookie (`httpOnly`) with a fixed
expiration of about **2.5–3 days**, plus a `fast-sid`. When it lapses the app answers
`USER_SESSION_LOSS` / `USER_SESSION_INVALID` and redirects to `/login`; there is no renewal
endpoint in the web client.

There are two ways to keep going:

**1. Re-scan the QR** every few days:

```bash
node qr.mjs --wait     # writes qr.png and waits until the scan lands
```

**2. Email + password login** (`reauth.mjs`). The session chain is:

```
POST /api/login/token          -> { token, pbKey }
POST /api/private/email/login  { countryCode, email, passwd: md5hex(password),
                                 token, ifencrypt: 0, options: '{"group":1}" }
                               -> Set-Cookie: s-sid, fast-sid
```

`ifencrypt: 0` with a plain MD5 is what the web client sends; an RSA-encrypted payload
(`ifencrypt: 1`) is also accepted by the backend.

Store the password in the system keyring once — **never in a file or shell history**:

```bash
secret-tool store --label="Tuya camera" service tuya-cam-recorder account you@example.com
node reauth.mjs --email you@example.com --country 52    # login + inject cookies
node reauth.mjs --email you@example.com --check         # is the session alive?
```

**Read this before relying on it.** One email can map to *several* Tuya identities:

| identity | `partnerIdentity` | contains |
|---|---|---|
| SmartLife consumer account | e.g. `p1000018` | your cameras, homes |
| Tuya IoT developer account | `p1000000` | nothing |

Password login resolves to whichever identity owns the password. If you ever signed up
on the Tuya IoT platform with the same email, that is a different uid with an empty
device list — the login succeeds, and the recorder then sees no cameras. `reauth.mjs`
therefore counts devices before injecting anything and **aborts if the account is empty**,
so it can never silently replace a working session with the wrong account.

If that happens, the camera account has no known password (it may have been created via
QR/Google), and the QR scan is the only way in. Everything else in this repo still works.

Why not just use the password for the consumer account? The public login path
(`/api/jy/init` -> `securekey` -> `POST /api/password/login` with
`{countryCode, userName, password: md5hex, securekey, domain}`) is gated by a slider
captcha served from `captcha.cdn5th.com`, and answers `验证失败` (verification failed)
without solving it. This project does not automate captchas. The private endpoint used
above has no captcha, which is exactly why it is the one that works headlessly — and why
it can land you on the wrong identity.

## Record

Output defaults to a USB/external path so a long run cannot fill your home partition.
Point it anywhere with `STORAGE_ROOT`, and it falls back to `./recordings` if that path is
missing (e.g. the drive is unplugged):

```bash
./run.sh                                   # -> /run/media/<you>/<UUID>/camaras/NEW_EAGLE
STORAGE_ROOT=/mnt/bigdisk ./run.sh 60 30   # custom root
OUT=/tmp/captures ./run.sh                 # fully explicit
```


```bash
./run.sh                 # 60s segments, 14 days retention
./run.sh 30 7            # 30s segments, 7 days retention
CAMERA="Front Door" ./run.sh    # camera name as shown in the sidebar
```

Output goes to `recordings/<camera>/YYYYMMDD_HHMMSS_NNN.mp4`.

`run.sh` prunes segments older than the retention window, so it can run forever without
filling the disk.

### Options

| Env | Default | Meaning |
|---|---|---|
| `CAMERA` | `NEW_EAGLE` | device name exactly as in the left sidebar |
| `OUT` | `./recordings/$CAMERA` | output directory |
| `SEGMENT` / arg 1 | `60` | seconds per file |
| retention / arg 2 | `14` | days to keep |
| `PORT` | `9222` | CDP port |
| `PROFILE` | `./.profile` | Chromium profile (session) |
| `CHROME_BIN` | autodetect | browser binary |
| `BASE_URL` | `https://protect-us.ismartlife.me` | regional endpoint |

### Still images instead of video

```bash
node snapshot.mjs "NEW_EAGLE"
```

## ⚠️ Password re-authentication only works for the Tuya account

`reauth.mjs` logs in through `/api/private/email/login`, which is the **Tuya** channel.
It works when the camera is a device **you own on the Tuya app (orange icon)**.

It does **not** work for:

- **Smart Life** accounts (blue icon) and other sub-brand/OEM apps built on the same cloud;
- cameras that were only **shared** with an account;
- cameras owned by a Smart Life account even if the email is the same as your Tuya one.

Why: one email can front several Tuya identities, and each has its own password and its own
device list. Password login resolves by *which identity owns the password*, not by the email
you type, so it always lands on the identity that holds it. If that is the wrong one you get
a valid session with zero cameras — the login "works" and finds nothing.

Verified on a real account:

| identity | `partnerIdentity` | devices |
|---|---|---|
| Tuya (orange app) | `p1000000` | 0 until the camera was re-linked to it |
| Smart Life (blue app) | `p1000018` | all of them |

The QR path (`relogin.sh`, `qr.mjs`) is different and always correct: the QR token carries
no identity, so the **scanning app injects whatever account it is logged into**. Log in to
the app that owns the cameras and scan from there.

Practical rules:

1. If the camera is on Smart Life, put it on the Tuya app (re-link it, matching the
   `partnerIdentity` your password belongs to) — then password re-auth works.
2. Otherwise use the QR every few days; it is the only reliable path for sub-brand accounts.
3. Sharing a camera to another account is not ownership: shared devices appear in
   `/api/new/playback/shareList`, not in `roomList`, and this recorder only reads `roomList`.

## Browse the recordings

```bash
node server.mjs                       # http://127.0.0.1:8099
./relogin.sh                          # renew the session (QR inside the recorder's profile)
```

`server.mjs` serves a local gallery: the newest clips grouped by day, a player that chains
clips on end, keyboard shortcuts (space, arrows, `f`), and a "follow the newest" mode that
refreshes every minute. Media is served with HTTP range support, so seeking works.

## Quality: what is actually recorded

`QUALITY=sd` (default) records the sub stream: **640x360 native**, VP8 + Opus, remuxed into
Matroska without re-encoding. Measured sharpness (variance of the Laplacian) on a real clip:

| Source | Sharpness |
|---|---|
| The portal's own snapshot button (640x360, raw) | 2533 |
| **This recorder, native + remux** | **2412** |
| An earlier build that upscaled to 1280x720 and re-encoded to H.264 | 142 |

The upscale was a 17x loss of detail while quadrupling the file size. Resampling cannot add
information: a 1280x720 frame made from 640x360 is the same data interpolated, and the PSNR
round-trip test (1280 -> 640 -> 1280 against the original, 39.7 dB) confirms the content is
really 640x360. Two avoidable recompressions made it worse than the camera's own output.

`QUALITY=hd` records the main stream: 2304x1296 HEVC over a data channel, decoded by wasm
into a WebGL canvas. It works and the detail is real, but it is **not usable unattended**:

- it needs hardware WebGL (`--use-gl=angle --use-angle=vulkan`); swiftshader yields no frames;
- the canvas stops being painted every 1-4 minutes, cutting the segment and then waiting
  40-55s for the camera to accept a new session. Measured coverage: roughly two thirds.

Use it for a deliberate look at one hour, not for a 7-day archive.

### Output container

`OUTPUT=remux` (default) copies the streams into the container without touching the pixels,
which also fixes the missing duration. `OUTPUT=transcode` re-encodes to H.264 (smaller
files, softer picture). `OUTPUT=none` keeps the browser's raw `.webm`.

## Audio

Clips carry the camera's audio track (`AUDIO=on`, default) but nothing plays while
recording: the page is muted before capture starts, and the gallery opens muted with a
🔇 button in the header. If you only want video, `AUDIO=off` drops the track.

Known gap: in HD mode there is no `<video>` element to take audio from (the player uses an
`<audio>` element without a `srcObject`, fed through Web Audio), so HD segments are
currently **video only**. SD mode records audio.

## Session alerts

`watcher.mjs` checks two things every 30 minutes and sends a desktop notification
(`notify-send`) when either fails:

- the cookies in the recorder's browser no longer authenticate (`USER_SESSION_INVALID`);
- no new clip has appeared for 15 minutes while the session looked fine.

Notifications are throttled to one per 6 hours so a long outage does not spam you.

```bash
systemctl --user status tuya-cam-recorder tuya-cam-gallery tuya-cam-watch
```

Three user units, all `enabled`, so they survive reboots and logout (`loginctl enable-linger`).

## Device sharing does not move the camera

A camera shared to a second account shows up as *shared*, not owned: it does not appear in
`roomList`, only in `/api/new/playback/shareList`. The web portal can display a share invite
but has **no endpoint to accept one** — acceptance only happens in the mobile app. If the
recorder logs in as the recipient account, discovery has to read `shareList` too.

## Run it as a user service

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/tuya-cam-recorder.service <<EOF
[Unit]
Description=Tuya camera recorder
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PWD
ExecStart=$PWD/run.sh 60 14
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now tuya-cam-recorder
journalctl --user -u tuya-cam-recorder -f
```

Enable lingering so it keeps running when you are logged out:
`sudo loginctl enable-linger $USER`.

## How it handles the flaky stream

The vendor player's stream drops after an unprompted interval and gives you roughly a
minute to hit retry before it stops trying. The recorder:

1. polls the `<video>` element for a **live video track with real dimensions** — a track
   alone is not enough, the element reads `0x0` while no frames arrive;
2. on a drop, re-selects the device in the sidebar (more reliable than the in-tile retry);
3. if that fails, reloads `/playback` and starts over.

Segments cut short by a drop are still written and marked `[cut short]` in the log.

## Gotchas found the hard way

- **React ignores `element.click()`.** Use `Input.dispatchMouseEvent` at the element centre.
- **The player's control strip is laid out inside the current viewport.** With a small
  window the controls fall off-screen and clicks land on nothing. `setViewport(1400,1500)`
  is not cosmetic.
- **A `<video>` with a `live` track and `videoWidth === 2` is not playing.** That is an
  audio-only negotiation; check `videoWidth > 100`.
- **Leftover `MediaRecorder` instances corrupt the next file.** If a previous recorder is
  still active it keeps emitting chunks, and the new blob loses its EBML header. Always
  drain it, and keep the chunk buffer per-recorder instead of on a global.
- **`MediaRecorder` writes webm without duration**, so players show "N/A". Re-encoding to
  H.264 fixes it and shrinks the file ~3×.
- **Reusing one CDP tab back-to-back leaves a dead socket.** Reload the page between runs.

## Limitations

- Records the **live** stream only. Cloud/SD recordings are not downloaded.
- Captures whatever the player negotiated. If the player picks the sub stream you get
  ~640×360; switching to the main stream is manual in the UI.
- One headless browser per account session; it is not a multi-camera farm (though
  `CAMERA` can point at another device on a second instance with its own `PORT`/`OUT`).
- Needs internet to the vendor cloud. Nothing local-only.

## Legal

For cameras and accounts you own. Respect Tuya's terms of service and your local privacy
law, and do not point this at anything you are not authorized to record.

MIT licensed.
