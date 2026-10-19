#!/usr/bin/env python3
"""Run the actual store XCTest cases with only Foundation/CryptoKit, no app/package build."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
args = parser.parse_args()
root = args.source_root.resolve()
kit = root / 'native/ReelKit'
tests = (kit / 'Tests/ReelKitTests/DeliveryHistoryTests.swift').read_text().replace('@testable import ReelKit', '')
names = re.findall(r'    func (test\w+)\(\) throws', tests)
if not names:
    raise SystemExit('No actual delivery XCTest cases found')
platform = Path(subprocess.check_output(['xcrun', '--sdk', 'macosx', '--show-sdk-platform-path'], text=True).strip())
frameworks = platform / 'Developer/Library/Frameworks'
swift_support = platform / 'Developer/usr/lib'
if not (frameworks / 'XCTest.framework').is_dir():
    raise SystemExit('Installed Xcode XCTest framework is required; no tools are installed automatically')
with tempfile.TemporaryDirectory(prefix='arya-delivery-swift-') as directory:
    temp = Path(directory)
    test_source = temp / 'tests.swift'; test_source.write_text(tests.replace('    func test', '    @objc func test'))
    main = temp / 'main.swift'
    main.write_text('import Foundation\nimport XCTest\nlet suite = XCTestSuite(name: "Delivery store fixtures")\n' +
        '\n'.join(f'suite.addTest(DeliveryHistoryTests(selector: #selector(DeliveryHistoryTests.{name})))' for name in names) +
        f'\nsuite.run()\nguard let result = suite.testRun, result.executionCount == {len(names)}, result.skipCount == 0, result.totalFailureCount == 0 else {{ fatalError("Delivery fixtures did not all pass") }}\n')
    binary = temp / 'delivery-history-tests'
    subprocess.run(['swiftc', '-j1', '-I', str(swift_support), '-L', str(swift_support), '-Xlinker', '-rpath', '-Xlinker', str(swift_support), '-F', str(frameworks), '-Xlinker', '-rpath', '-Xlinker', str(frameworks), '-module-cache-path', str(temp/'module-cache'), '-o', str(binary),
        str(kit/'Sources/ReelKit/ProjectFolder.swift'), str(kit/'Sources/ReelKit/JSON.swift'),
        str(kit/'Sources/ReelKit/NativeDeliveryHistory.swift'), str(test_source), str(main)], check=True, timeout=120)
    subprocess.run([str(binary)], check=True, timeout=60)
print(f'Actual delivery store XCTest cases passed: {len(names)}', flush=True)
