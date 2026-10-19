"""Prepare real Foundation helpers for controlled transcript controller fixtures."""
from pathlib import Path


def foundation_support(repo: Path, source_root: Path, helper_root: Path | None, controller: str) -> str:
    store_path = Path('native/ReelKit/Sources/ReelKit/NativeTranscriptStore.swift')
    store = (source_root / store_path if (source_root / store_path).exists() else repo / store_path).read_text()
    locale = store[store.index('    public static func localeID('):store.index('    static func file(')]
    validation = store[store.index('    public static func validate('):store.index('    public static func read(')]
    support = 'public enum NativeTranscriptStore {\n' + locale + validation + '}\n'
    if 'NativeTimedTranscriptImport' in controller:
        name = Path('native/ReelKit/Sources/ReelKit/NativeTimedTranscriptImport.swift')
        candidates = [source_root / name]
        if helper_root is not None:
            candidates.append(helper_root / name)
        path = next((value for value in candidates if value.exists()), None)
        if path is None:
            raise SystemExit('The controller uses timed import. Assemble its helper dependency or pass --helper-root to its exact source candidate.')
        text = path.read_text()
        support += '\n'.join(line for line in text.splitlines() if not line.startswith('import ')) + '\n'
    return support


def seek_word_method(panel: str) -> str:
    start = panel.index('    private func seekWord(_ index: Int) {')
    opening = panel.index('{', start)
    depth = 0
    for index in range(opening, len(panel)):
        if panel[index] == '{':
            depth += 1
        elif panel[index] == '}':
            depth -= 1
            if depth == 0:
                return panel[start:index + 1] + '\n'
    raise ValueError('The transcript source preview method has no closing brace.')
