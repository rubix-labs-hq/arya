#!/usr/bin/env python3
"""Run the production timecode entry parser (NativeTimecodeField.parse) against typed inputs."""
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
editor = repo / 'native/App/Shared/NativeEditor'
controls = (editor / 'NativeControls.swift').read_text()
project = (editor / 'NativeProject.swift').read_text()


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


source = 'import Foundation\n' + block(project, 'func nativeTimecode(') + '\n'
source += 'enum Timecode {\n' + block(controls, '    static func parse(') + '\n}\n'
source += r'''
var checks = 0
func expect(_ text: String, _ fps: Double, _ current: Double, _ expected: Double?, _ label: String) {
    checks += 1
    let value = Timecode.parse(text, current: current, fps: fps)
    switch (value, expected) {
    case (nil, nil): return
    case let (value?, expected?) where abs(value - expected) < 1e-9: return
    default: fatalError("\(label): \(text) gave \(String(describing: value)), expected \(String(describing: expected))")
    }
}
expect("00:00:15:20", 30, 0, 15 + 20.0 / 30, "Full timecode")
expect("15:20", 30, 0, 15 + 20.0 / 30, "Seconds and frames")
expect("1520", 30, 0, 15 + 20.0 / 30, "Digits read right to left as frames then seconds")
expect("10000", 30, 0, 60, "Five digits reach minutes")
expect("1000000", 25, 0, 3600, "Seven digits reach hours")
expect("12", 24, 0, 0.5, "Two digits are frames")
expect("1:00:00", 30, 0, 60, "Minutes, seconds and frames")
expect("2;00", 30, 0, 2, "Drop-frame separator reads as a separator")
expect("+10", 30, 4, 4 + 10.0 / 30, "Plus moves later by frames")
expect("-1:00", 30, 4, 3, "Minus moves earlier by seconds and frames")
expect("::15", 30, 0, 0.5, "Empty fields read as zero")
expect("", 30, 3, nil, "Empty text is not a timecode")
expect("abc", 30, 3, nil, "Letters are not a timecode")
expect("1:2:3:4:5", 30, 3, nil, "More than four fields is not a timecode")
expect("123456789", 30, 3, nil, "More than eight digits is not a timecode")
expect(nativeTimecode(37.5, fps: 30), 30, 0, 37.5, "A formatted timecode reads back exactly")
expect("１２", 30, 3, nil, "Full-width digits are not a timecode")
expect("١٢:٠٠", 30, 3, nil, "Arabic-Indic digits are not a timecode")
// Fractional rates: frame numbers count at the rounded rate, time uses the real rate, as displayed.
for fps in [23.976, 29.97, 59.94, 24, 25] {
    for frame in [0, 1, 17, 718, 17_982, 107_892] {
        checks += 1
        let time = Double(frame) / fps
        let shown = nativeTimecode(time, fps: fps)
        guard let back = Timecode.parse(shown, current: 0, fps: fps) else { fatalError("\(shown) at \(fps) did not parse") }
        guard nativeTimecode(back, fps: fps) == shown, abs(back * fps - Double(frame)) < 1e-6 else {
            fatalError("\(shown) at \(fps) read back as frame \(back * fps), expected \(frame)")
        }
    }
}
checks += 1
guard let minute = Timecode.parse("1:00:00", current: 0, fps: 29.97), nativeTimecode(minute, fps: 29.97) == "00:01:00:00" else {
    fatalError("1:00:00 at 29.97 must display 00:01:00:00")
}
checks += 1
guard let late = Timecode.parse("00:09:59:12", current: 0, fps: 29.97), nativeTimecode(late, fps: 29.97) == "00:09:59:12" else {
    fatalError("00:09:59:12 at 29.97 must read back unchanged")
}
print("Timecode entry parser checks passed: \(checks)")
'''
with tempfile.TemporaryDirectory() as temp:
    path = Path(temp) / 'main.swift'
    path.write_text(source)
    binary = Path(temp) / 'timecode-checks'
    subprocess.run(['swiftc', '-module-cache-path', str(Path(temp) / 'cache'), str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
