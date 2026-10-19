#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-ui-geometry.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\n' > "$TEST_DIR/NativeUIGeometry.swift"
awk '/^enum NativeExportDimensions \{/ { copy = 1 } copy { print } copy && /^\}$/ { exit }' \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeDeliverPanel.swift" >> "$TEST_DIR/NativeUIGeometry.swift"
awk '/^enum NativeCanvasCoordinates \{/ { copy = 1 } copy { print } copy && /^\}$/ { exit }' \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeDrawingOverlay.swift" >> "$TEST_DIR/NativeUIGeometry.swift"
awk '/^enum NativeWorkspaceLayout \{/ { copy = 1 } copy { print } copy && /^\}$/ { exit }' \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeEditorView.swift" >> "$TEST_DIR/NativeUIGeometry.swift"
cp "$SCRIPT_DIR/ui-geometry-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/NativeUIGeometry.swift" \
    "$TEST_DIR/main.swift" -o "$TEST_DIR/ui-geometry-tests"
"$TEST_DIR/ui-geometry-tests"
