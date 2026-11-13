#!/usr/bin/env bash
# Starts headless Chromium with CDP, then the recorder.
#
#   ./run.sh                        # HD 1920x1080, 60s segments, 7 days retention
#   QUALITY=sd ./run.sh             # force the sub stream (640x360, ~3x lighter)
#   CAMERA=Garage ./run.sh 30 7     # 30s segments, 7 days
#
# Requires: chromium, node >= 22, ffmpeg, a GPU with Vulkan (for HD).
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAMERA="${CAMERA:-NEW_EAGLE}"
QUALITY="${QUALITY:-sd}"   # hd is experimental: the canvas stalls after ~20s

# Where to write clips. Long runs fill the root partition quietly, so point STORAGE_ROOT at a
# big volume; without it the output stays inside the repo.
STORAGE_ROOT="${STORAGE_ROOT:-$BASE_DIR/recordings}"
if [ ! -d "$STORAGE_ROOT" ]; then
  echo "· aviso: $STORAGE_ROOT no existe, uso $BASE_DIR/recordings"
  STORAGE_ROOT="$BASE_DIR/recordings"
fi
OUT="${OUT:-$STORAGE_ROOT/$CAMERA}"
PROFILE="${PROFILE:-$BASE_DIR/.profile}"
PORT="${PORT:-9222}"
OUTPUT="${OUTPUT:-remux}"
UPS_W="${UPSCALE_W:-0}"
UPS_H="${UPSCALE_H:-0}"
SEG="${1:-60}"
KEEP_DAYS="${2:-7}"

CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable)}"

mkdir -p "$OUT" "$PROFILE"

# HD is HEVC decoded by wasm into a WebGL canvas. With swiftshader (software) the decoder
# produces no frames at all, so HD requires the vulkan backend, which hands WebGL to the
# real GPU. SD does not care either way.
if [ "$QUALITY" = "hd" ]; then
  # NOTE: don't use --mute-audio here. It silences Chromium's whole audio graph, including
  # the MediaStreamAudioDestination the recorder taps, so clips end up with a silent track.
  # Output is muted externally instead (pactl, by PID) which kills the device stream but
  # leaves the in-process graph producing samples.
  GL_FLAGS=(--use-gl=angle --use-angle=vulkan \
            --disable-background-timer-throttling \
            --disable-backgrounding-occluded-windows \
            --disable-renderer-backgrounding)
  WIN_SIZE=1920,1080
else
  GL_FLAGS=(--disable-gpu --use-gl=swiftshader)
  WIN_SIZE=1400,1500
fi

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  # A chromium killed while running leaves SingletonLock behind, and the next start then
  # aborts with "Failed to create ProcessSingleton" and no window at all.
  for f in SingletonLock SingletonSocket SingletonCookie; do
    [ -L "$PROFILE/$f" ] && rm -f "$PROFILE/$f"
  done

  echo "· starting chromium on port $PORT (gl: $QUALITY mode)"
  nohup "$CHROME_BIN" \
    --headless=new --no-sandbox "${GL_FLAGS[@]}" \
    --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" \
    --window-size="$WIN_SIZE" \
    --autoplay-policy=no-user-gesture-required \
    --disable-features=CalculateNativeWinOcclusion \
    about:blank >"$BASE_DIR/chromium.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Retention: drop segments older than KEEP_DAYS. Never deletes anything on the first runs.
pruned=$(find "$OUT" \( -name '*.mp4' -o -name '*.webm' \) -mtime +"$KEEP_DAYS" -print -delete | wc -l)
[ "$pruned" -gt 0 ] && echo "· pruned $pruned segments older than ${KEEP_DAYS}d"

echo "· recording $CAMERA -> $OUT ($QUALITY, ${SEG}s segments, ${KEEP_DAYS}d retention)"
exec node "$BASE_DIR/recorder.mjs" \
  --camera "$CAMERA" \
  --out "$OUT" \
  --segment "$SEG" \
  --port "$PORT" \
  --quality "$QUALITY" \
  --upscale-w "$UPS_W" \
  --upscale-h "$UPS_H" \
  --output "${OUTPUT:-remux}"
