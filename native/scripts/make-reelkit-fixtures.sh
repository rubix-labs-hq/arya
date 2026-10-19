#!/bin/sh
# Regenerates the ReelKit media fixtures from FFmpeg's built-in test sources.
# Every frame and sample is synthetic, so the files carry no third-party rights.
set -eu
out="$(cd "$(dirname "$0")/../ReelKit/Tests/ReelKitTests/Fixtures" && pwd)"
ff() { ffmpeg -nostdin -v error -y -fflags +bitexact "$@"; }

ff -f lavfi -i testsrc=size=320x180:rate=30:duration=2 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 1 -flags:v +bitexact -flags:a +bitexact -shortest "$out/clip.mp4"
ff -f lavfi -i testsrc=size=320x180:rate=25:duration=1 -c:v libx264 -pix_fmt yuv420p -flags:v +bitexact "$out/upright.mov"
ff -display_rotation 90 -i "$out/upright.mov" -c copy "$out/rotated.mov"
rm "$out/upright.mov"
ff -f lavfi -i sine=frequency=660:sample_rate=44100:duration=1.5 -af volume=-2dB -ac 2 -c:a aac -flags:a +bitexact "$out/tone.m4a"
ff -f lavfi -i testsrc=size=64x48:rate=1 -frames:v 1 -pix_fmt rgb24 "$out/still.png"
echo "Wrote clip.mp4, rotated.mov, tone.m4a and still.png to $out"
