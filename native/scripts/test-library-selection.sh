#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
KIT_DIR="$NATIVE_DIR/ReelKit/Sources/ReelKit"
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-library-selection.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
# Print the top-level declaration that starts with $2 in file $1, through its matching closing brace.
extract() {
    awk -v marker="$2" '
        index($0, marker) == 1 { found = 1 }
        found { print; depth += gsub(/[{]/, "{") - gsub(/[}]/, "}"); if (depth == 0) exit }
        END { if (!found) exit 1 }
    ' "$1"
}
# NativeLibraryModel imports ReelKit only for ReelLUTInspection; compile the production definitions it needs.
{
    printf 'import Foundation\nimport CryptoKit\n'
    extract "$KIT_DIR/Rendering/ReelMetalRenderer.swift" 'public struct ReelRenderingError: Error, LocalizedError {'
    extract "$KIT_DIR/Rendering/NativeGradeTextures.swift" 'public enum ReelLUTInspection {'
    extract "$KIT_DIR/Rendering/NativeGradeTextures.swift" 'struct NativeLUTSource {'
    extract "$KIT_DIR/Rendering/NativeGradeTextures.swift" 'struct NativeCube {'
} > "$TEST_DIR/ReelKitSubset.swift"
sed '/^import ReelKit$/d' "$NATIVE_DIR/App/Shared/NativeEditor/NativeLibraryModel.swift" > "$TEST_DIR/NativeLibraryModel.swift"
cp "$SCRIPT_DIR/library-selection-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$KIT_DIR/JSON.swift" "$TEST_DIR/ReelKitSubset.swift" \
    "$TEST_DIR/NativeLibraryModel.swift" \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeSelectionAIContext.swift" \
    "$TEST_DIR/main.swift" -o "$TEST_DIR/library-selection-tests"
"$TEST_DIR/library-selection-tests"
