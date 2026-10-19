#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
if [[ $# -gt 0 ]]; then shift; fi
case "$MODE" in
  run|--verify|--debug|--logs|--telemetry) ;;
  *) echo "usage: $0 [run|--verify|--debug|--logs|--telemetry] [app arguments]" >&2; exit 2 ;;
esac

BUILD_DIR="$ROOT_DIR/build/DerivedData"
APP_BUNDLE="$BUILD_DIR/Build/Products/Debug/Arya.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/Arya"
owned_process() {
  /usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | awk -v executable="$APP_BINARY" '$0 == "n" executable { found = 1 } END { exit !found }'
}

# Stop only the app built by this checkout. Other Arya checkouts stay open.
for pid in $(pgrep -x Arya 2>/dev/null || true); do
  if owned_process "$pid"; then
    kill -TERM "$pid"
    for attempt in {1..50}; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Arya is still closing. Wait for this checkout's app to finish, then run again." >&2
      exit 1
    fi
  fi
done

xcodebuild -project "$ROOT_DIR/native/Reel.xcodeproj" -scheme Reel \
  -configuration Debug -destination 'platform=macOS' -derivedDataPath "$BUILD_DIR" \
  -clonedSourcePackagesDirPath "$ROOT_DIR/build/SourcePackages" build

case "$MODE" in
  --debug) lldb -- "$APP_BINARY" "$@" ;;
  --logs)
    /usr/bin/open -n "$APP_BUNDLE" --args "$@"
    /usr/bin/log stream --info --style compact --predicate 'process == "Arya"'
    ;;
  --telemetry)
    /usr/bin/open -n "$APP_BUNDLE" --args "$@"
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "app.reel"'
    ;;
  --verify)
    /usr/bin/open -n "$APP_BUNDLE" --args "$@"
    sleep 1
    verified=false
    for pid in $(pgrep -x Arya 2>/dev/null || true); do
      if owned_process "$pid"; then verified=true; break; fi
    done
    if [[ "$verified" != true ]]; then echo "Arya did not start." >&2; exit 1; fi
    echo "Arya is running at $APP_BUNDLE"
    ;;
  run) /usr/bin/open -n "$APP_BUNDLE" --args "$@" ;;
esac
