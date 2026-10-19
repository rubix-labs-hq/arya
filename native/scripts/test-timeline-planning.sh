#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-timeline-planning.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\nimport CoreFoundation\n' > "$TEST_DIR/NativeTimelinePlanning.swift"
awk '/^enum NativeTimelineMarkerEditing \{/ { copy = 1 } copy { print } copy && /^}/ { exit }' \
    "$REPO_DIR/native/App/Shared/NativeEditor/NativeTimeline.swift" >> "$TEST_DIR/NativeTimelinePlanning.swift"
awk '/^\/\/ BEGIN TIMELINE PLANNING/ { copy = 1; next } /^\/\/ END TIMELINE PLANNING/ { copy = 0 } copy' \
    "$REPO_DIR/native/App/Shared/NativeEditor/NativeTimeline.swift" >> "$TEST_DIR/NativeTimelinePlanning.swift"
cp "$SCRIPT_DIR/timeline-planning-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/NativeTimelinePlanning.swift" \
    "$TEST_DIR/main.swift" -o "$TEST_DIR/timeline-planning-tests"
"$TEST_DIR/timeline-planning-tests" "$TEST_DIR/core-fixtures.json"
node "$SCRIPT_DIR/timeline-core-tests.mjs" "$TEST_DIR/core-fixtures.json"
