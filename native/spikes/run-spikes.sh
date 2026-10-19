#!/bin/sh
# Builds the spike harness into a small app bundle and runs it.
# Usage: native/spikes/run-spikes.sh [video.mp4]
# Without a video it makes one with ffmpeg. Prints the JSON report on stdout.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${SPIKE_BUILD_DIR:-"$HERE/build"}
APP="$OUT/Spikes.app"
mkdir -p "$APP/Contents/MacOS"
VIDEO=${1:-"$OUT/clip.mp4"}
if [ ! -f "$VIDEO" ]; then
  ffmpeg -nostdin -y -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t 6 -c:v libx264 -pix_fmt yuv420p -g 30 -c:a aac -shortest -movflags +faststart "$VIDEO"
fi
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.reel.spikes</string>
  <key>CFBundleName</key><string>Spikes</string>
  <key>CFBundleExecutable</key><string>Spikes</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
swiftc -O -o "$APP/Contents/MacOS/Spikes" "$HERE/SpikeHarness.swift" -framework WebKit -framework AppKit
codesign --force --sign - "$APP" >/dev/null 2>&1
"$APP/Contents/MacOS/Spikes" "$VIDEO" "$REPO/editor/node_modules/mediabunny/dist/bundles/mediabunny.min.mjs"
