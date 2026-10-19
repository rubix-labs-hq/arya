#!/usr/bin/env python3
"""Exercise the actual native Deliver range selector without building an app."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
args = parser.parse_args()
source = (args.source_root / 'native/App/Shared/NativeEditor/NativeDeliverPanel.swift').read_text()
start = source.index('enum NativeExportDimensions {')
level = 0
for end in range(source.index('{', start), len(source)):
    if source[end] == '{': level += 1
    if source[end] == '}':
        level -= 1
        if level == 0: break
helper = source[start:end+1]
fixture = r'''
import Foundation
import CoreFoundation
var checks = 0
func expect(_ value: @autoclosure () -> Bool, _ message: String) { checks += 1; if !value() { fatalError(message) } }
let project: [String: Any] = ["range": ["in": 1, "out": 2], "comps": ["nested": ["range": ["in": 3, "out": 7]], "unmarked": ["duration": 8]]]
func range(_ comp: String?, _ duration: Double = 8) -> ClosedRange<Double>? { NativeExportDimensions.markedRange(project: project, composition: comp, duration: duration) }
expect(range(nil) == 1...2, "Main timeline lost its range")
expect(range("nested") == 3...7, "Composition range was replaced with the timeline range")
expect(range("nested", 5) == 3...5, "Marked range did not clamp to composition duration")
expect(range("unmarked") == nil, "Unmarked composition inherited the main timeline range")
expect(range("missing") == nil, "Missing composition inherited a range")
expect(range("nested", 0) == nil, "Empty composition accepted a range")
expect(range("nested", .nan) == nil, "Nonfinite composition duration accepted a range")
expect(range("nested", 2) == nil, "Range outside composition accepted an empty export")
for bad in [["in": Double.nan,"out": 4.0], ["in": 2.0,"out": Double.infinity], ["in": 5.0,"out": 2.0], ["in": 2.0,"out": 2.0]] {
    expect(NativeExportDimensions.markedRange(project:["range":bad],composition:nil,duration:8) == nil, "Invalid numeric range was accepted")
}
expect(NativeExportDimensions.markedRange(project:["range":["in":true,"out":4]],composition:nil,duration:8) == nil, "Boolean range was accepted")
expect(NativeExportDimensions.markedRange(project:["range":["in":"2","out":4]],composition:nil,duration:8) == nil, "String range was accepted")
expect(NativeExportDimensions.markedRange(project:["range":["in":-2,"out":4]],composition:nil,duration:8) == 0...4, "Negative marked start did not clamp")
print("Actual native Deliver marked-range assertions passed: \(checks)")
'''
with tempfile.TemporaryDirectory(prefix='arya-delivery-range-') as directory:
    temp = Path(directory); main = temp/'main.swift'; main.write_text('import Foundation\n' + helper + '\n' + fixture)
    binary = temp/'delivery-range-tests'
    subprocess.run(['swiftc','-j1','-module-cache-path',str(temp/'module-cache'),str(main),'-o',str(binary)],check=True,timeout=120)
    subprocess.run([str(binary)],check=True,timeout=30)
