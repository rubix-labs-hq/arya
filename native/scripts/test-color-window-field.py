#!/usr/bin/env python3
"""Execute the production Color window field lifecycle with its real controller."""
from pathlib import Path
import argparse
import importlib.util
import subprocess
import tempfile


def field_source(root):
    spec = importlib.util.spec_from_file_location('color_window_checks', root / 'native/scripts/test-color-window.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    controls = (root / 'native/App/Shared/NativeEditor/NativeColorWindowControls.swift').read_text()
    field = helper.block(controls, 'private struct NativeColorWindowNumberField: View {')
    declarations = field[:field.index('    var body: some View {')]
    declarations = declarations.replace('private struct NativeColorWindowNumberField: View {', '@MainActor final class ColorWindowNumberFieldChecks {')
    for wrapper in ['@ObservedObject ', '@State private ', '@FocusState private ']:
        declarations = declarations.replace(wrapper, '')
    declarations = declarations.replace('var focused: Bool', 'var focused = false').replace('private func ', 'func ')
    declarations += '''
    init(controller: NativeColorWindowController, property: String, value: Double) {
        self.controller = controller; self.property = property; self.value = value
        self.text = String(format: "%.4g", value)
    }
}
'''
    for event in ['.onSubmit { finish(); focused = false }', 'if next { beginEditing() } else { finish() }',
                  '.onChange(of: text) { _, next in textChanged(next) }', '.onDisappear { cancelEditing() }',
                  '.onExitCommand { cancelEditing() }']:
        assert event in field, event
    return helper.controller_source(root) + '\n' + declarations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract-only', type=Path, help='Write extracted Swift without starting a compiler.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    source = field_source(root)
    if args.extract_only:
        args.extract_only.parent.mkdir(parents=True, exist_ok=True)
        args.extract_only.write_text(source)
        print('Extracted production field lifecycle and controller. No compiler started.')
        return
    with tempfile.TemporaryDirectory(prefix='reel-color-window-field-') as directory:
        temp = Path(directory)
        swift = temp / 'Field.swift'
        swift.write_text(source)
        binary = temp / 'field'
        subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(swift),
                        str(root / 'native/scripts/color-window-field-tests.swift'), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    main()
