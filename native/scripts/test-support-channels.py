#!/usr/bin/env python3
"""Support channel separation. No build or network.

iOS, iPadOS and Mac App Store: Arya Pro through In-App Purchase only, never a website payment link.
Mac direct download (Developer ID): free, with a website tip link compiled only with ARYA_DIRECT_DISTRIBUTION.
The Mac App Store edition shares the iOS target and must not set that flag.
Browser editors: website link from the local server route or the hosted publish step only."""
import argparse
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().source_root.resolve()
native, editor = root / 'native', root / 'editor'
checks = 0


def check(value, message):
    global checks
    assert value, message
    checks += 1


FLAG = 'ARYA_DIRECT_DISTRIBUTION'
DOMAINS = re.compile(r'editwitharya|stripe\.com|checkout\.|paypal|ko-fi|patreon|buymeacoffee|https?://', re.I)
WEBSITE = re.compile(r'editwitharya|stripe\.com|checkout\.|paypal|ko-fi|patreon|buymeacoffee|/support/|channel=', re.I)


def text(path):
    return path.read_text(errors='replace')


# 1. Nothing the iOS target compiles names the website or a checkout. Mac-only Swift is checked below.
ios_sources = [p for d in ('App/iOS', 'App/Shared', 'ReelKit/Sources') for p in (native / d).rglob('*.swift')]
check(ios_sources, 'iOS sources found')
for path in ios_sources:
    # Help links and the privacy policy (required next to a subscription) are not payment destinations.
    source = re.sub(r'https://editwitharya\.app/(?:download/#mac|install/#accounts|install/#figma|privacy/)', '', text(path))
    hits = WEBSITE.findall(source)
    check(not hits, f'{path.relative_to(root)} names a website payment link: {sorted(set(hits))}')

# 2. Editor files bundled into both native apps (bundle-editor.sh copies web/, core/, agent/).
bundle = text(native / 'scripts/bundle-editor.sh')
check('"$EDITOR/web/"' in bundle and '"$EDITOR/core/"' in bundle and '"$EDITOR/agent/"' in bundle and 'routes' not in bundle,
      'Native apps bundle web, core and agent, never routes')
for d in ('web', 'core', 'agent'):
    for path in (editor / d).rglob('*'):
        if path.is_file() and path.suffix in {'.js', '.mjs', '.html', '.json', '.css'} and 'node_modules' not in path.parts:
            # The link validator checks the /support/ path itself but must hold no domain.
            pattern = DOMAINS if path == editor / 'web/ui/support-link.js' else WEBSITE
            # Existing help/download links are not payment destinations.
            source = re.sub(r'https://editwitharya\.app/(?:download/#mac|install/#accounts|install/#figma)', '', text(path))
            hits = pattern.findall(source)
            check(not hits, f'{path.relative_to(root)} is bundled into the apps and names {sorted(set(hits))}')

# 3. The Mac link is compiled only behind the opt-in flag.
link = text(native / 'App/macOS/NativeSupportLink.swift')
body = link.split('// BEGIN SUPPORT LINK', 1)[1].split('// END SUPPORT LINK', 1)[0]
inner = body.split(f'#if {FLAG}\n', 1)
check(len(inner) == 2 and inner[1].rstrip().endswith('#endif') and inner[1].count('#endif') == 1, 'Whole Mac link file is inside the flag')
check('https://editwitharya.app/support/?channel=mac-direct' in inner[1], 'Mac direct channel URL')
check('editwitharya' not in inner[0], 'No URL before the flag')
for path in native.rglob('*.swift'):
    source = text(path)
    if path.name == 'NativeSupportLink.swift' or not re.search(r'\bNativeSupportLink(View)?\b', source):
        continue
    depth_flag, stack = [], []
    for number, line in enumerate(source.splitlines(), 1):
        s = line.strip()
        if s.startswith('#if '): stack.append(FLAG in s)
        elif s.startswith('#elseif '): stack[-1] = FLAG in s and '!' not in s
        elif s.startswith('#else'): stack[-1] = False
        elif s.startswith('#endif'): stack.pop()
        elif re.search(r'\bNativeSupportLink(View)?\b', s): depth_flag.append((number, bool(stack) and stack[-1]))
    for number, guarded in depth_flag:
        check(guarded, f'{path.relative_to(root)}:{number} uses the Mac link outside #if {FLAG}')

# 4. Only the Mac target sets the flag, in both configurations; the iOS target never builds the file.
project = text(native / 'Reel.xcodeproj/project.pbxproj')
configs = re.findall(r'/\* (?:Debug|Release) \*/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n(.*?)\n\t\t\t\};', project, re.S)
flagged = [c for c in configs if FLAG in c]
check(len(flagged) == 2 and all('SDKROOT = macosx;' in c and 'PRODUCT_BUNDLE_IDENTIFIER = app.reel.Reel;' in c for c in flagged), 'Flag only in the Mac target Debug and Release')
check(not any(FLAG in c for c in configs if 'SDKROOT = iphoneos;' in c), 'iOS configurations never set the flag')


def sources_phase(target):
    block = re.search(r'/\* ' + re.escape(target) + r' \*/ = \{\n\t\t\tisa = PBXNativeTarget;.*?buildPhases = \((.*?)\);', project, re.S).group(1)
    phase = re.search(r'([0-9A-F]{24}) /\* Sources \*/', block).group(1)
    return re.search(phase + r' /\* Sources \*/ = \{.*?files = \((.*?)\);', project, re.S).group(1)


check('NativeSupportLink.swift' in sources_phase('Reel'), 'Mac target builds the link file')
check('NativeSupportLink.swift' not in sources_phase('Reel iOS'), 'iOS target never builds the link file')
check('NativeSupport.swift in Sources' not in sources_phase('Reel'), 'Mac target never builds StoreKit purchases')
spec = text(native / 'project.yml')
mac_spec = spec.split('\n  Reel:\n', 1)[1].split('\n  Reel iOS:\n', 1)[0]
check(FLAG in mac_spec and spec.count(FLAG) == 1, 'XcodeGen sets the flag on the Mac target only')
check('Distribution requires a Developer ID Application signature.' in text(native / 'scripts/release.py'), 'The flagged Mac target ships only through the Developer ID release script')

# 5. Browser editors: the link comes from the server route or the hosted publish step.
route = text(editor / 'routes/support.mjs')
check("SUPPORT_URL = 'https://editwitharya.app/support/?channel=local-editor'" in route, 'Local editor channel URL')
link_js = text(editor / 'web/ui/support-link.js')
check("{ 'browser-local': 'web-beta', http: 'local-editor' }" in link_js and "kind !== 'http'" in link_js, 'Only browser host kinds resolve a link')
check('arya-support-url' not in text(editor / 'web/browser-local.html'), 'Source page carries no link; publishing adds it')
publish = text(root / 'site/scripts/prepare-public.mjs')
check("new URL('/support/?channel=web-beta', site)" in publish and 'arya-support-url' in publish, 'Hosted publish adds the web-beta link')
check('"source": "web/ui/support-link.js"' in text(editor / 'browser-public-files.json'), 'Hosted build ships the link module')
settings = text(editor / 'web/ui/settings.js')
check(settings.count('s.supportURL') == 3 and 'support-link' not in settings, 'Settings only shows a resolved link')

print(f'Support channel contracts passed: {checks}', flush=True)
