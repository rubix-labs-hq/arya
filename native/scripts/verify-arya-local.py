#!/usr/bin/env python3
"""Serial local checks with exact source evidence. Never installs or publishes."""
import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

@dataclass
class Phase:
    name: str
    commands: list
    tools: tuple = ()
    files: tuple = ()
    optional: bool = False
    policy: str = ''
    timeout: int = 1800
    action: str = ''

EXCLUDED_BROWSER = set()
UNITTEST_SCRIPTS = {'test-verify-arya-local.py', 'test-node-runtime.py', 'test-arya-installer.py', 'test-release.py', 'test-public-readiness-read.py'}
NATIVE_SKIP = 'testBrowserGoldenFramesThroughMetal|testRealPersonAlphaWithPreservedAudio'
STORAGE_DIRS = ('workspace', 'tmp', 'module-cache', 'swift-cache', 'swift-config', 'swift-security', 'mac-derived', 'ios-derived', 'person-fixture', 'persistence-test-writers')
STORAGE_OWNER = 'arya-local-verifier-v1'

def directory_identity(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode): raise ValueError('Artifact directory was replaced: ' + str(path))
    return [info.st_dev, info.st_ino]

def storage_receipt(output):
    return {'owner': STORAGE_OWNER, 'directory': directory_identity(output),
            'artifacts': {name: directory_identity(output / name) for name in STORAGE_DIRS if (output / name).exists()}}

def write_storage_report(run_fd, report):
    temporary = '.cleanup-' + uuid.uuid4().hex + '.json'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=run_fd)
    try:
        with os.fdopen(descriptor, 'w') as target:
            json.dump(report, target, indent=2, sort_keys=True); target.write('\n')
            target.flush(); os.fsync(target.fileno())
        os.replace(temporary, 'manifest.json', src_dir_fd=run_fd, dst_dir_fd=run_fd)
    finally:
        try: os.unlink(temporary, dir_fd=run_fd)
        except FileNotFoundError: pass

def verification_open_paths():
    """Fail closed when this host cannot inspect files open by the current user."""
    executable = shutil.which('lsof')
    if not executable: return None
    try:
        result = subprocess.run([executable, '-nP', '-a', '-u', str(os.getuid()), '-p', '^' + str(os.getpid()), '-F', 'n'], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired): return None
    if result.returncode != 0: return None
    return [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]

def cleanup_verification_runs(repo, *, apply=False, preserve=(), now=None):
    """Prune only registered artifacts in old, idle verifier runs. Keep evidence."""
    base = repo.resolve() / 'build/local-verification'
    result = {'removed': [], 'eligible': [], 'skipped': [], 'errors': [], 'keepNewest': 2, 'olderThanDays': 7}
    if not base.exists(): return result
    if base.resolve() != base or not base.is_dir(): raise ValueError('Unsafe verification storage directory')
    now = now or datetime.now(timezone.utc)
    preserved = [Path(path).resolve() for path in preserve if path]
    candidates = []

    def inspect(run):
        if run.resolve() != run or not run.is_dir(): raise ValueError('Run path is not a real directory')
        for name in ['.lock', 'manifest.json']:
            if not stat.S_ISREG((run / name).lstat().st_mode): raise ValueError('Unsafe run metadata: ' + name)
        report = json.loads((run / 'manifest.json').read_text())
        if not isinstance(report, dict): raise ValueError('Unrecognized run manifest')
        storage = report.get('storage', {})
        if not isinstance(storage, dict): raise ValueError('Unrecognized storage receipt')
        if storage.get('owner') != STORAGE_OWNER or storage.get('directory') != directory_identity(run): raise ValueError('Run has no matching storage ownership receipt')
        if storage.get('prunedAt'): raise ValueError('Run artifacts were already pruned')
        phases = report.get('phases')
        if not isinstance(phases, dict) or not phases or not all(isinstance(phase, dict) for phase in phases.values()): raise ValueError('Unrecognized phase results')
        if not report.get('finished') or any(phase.get('status') not in {'passed', 'passed_with_skips', 'failed', 'interrupted', 'blocked', 'not_run', 'skipped_policy', 'skipped_fixture'} for phase in phases.values()): raise ValueError('Run has not finished')
        finished = datetime.fromisoformat(report['finished'])
        if finished.tzinfo is None: raise ValueError('Run finish time has no timezone')
        artifacts = storage.get('artifacts', {})
        if not isinstance(artifacts, dict) or not artifacts or not set(artifacts).issubset(STORAGE_DIRS): raise ValueError('Unrecognized artifact ownership receipt')
        for name, identity in artifacts.items():
            path = run / name
            if path.is_symlink() or (path.exists() and directory_identity(path) != identity): raise ValueError('Artifact directory was replaced: ' + name)
        return report, finished

    for run in sorted(base.iterdir()):
        try:
            report, finished = inspect(run)
            candidates.append((finished, run))
        except (OSError, ValueError, KeyError, TypeError) as error:
            result['skipped'].append({'run': run.name, 'reason': str(error)})
    candidates.sort(key=lambda pair: (pair[0], pair[1].name), reverse=True)
    old = candidates[2:]
    for finished, run in old:
        if (now - finished).total_seconds() < 7 * 86400: continue
        if (run / '.keep-artifacts').exists() or (run / '.keep-artifacts').is_symlink():
            result['skipped'].append({'run': run.name, 'reason': 'Artifacts are pinned'}); continue
        if any(path == run or path.is_relative_to(run) for path in preserved):
            result['skipped'].append({'run': run.name, 'reason': 'Run is in use'}); continue
        try:
            fd = os.open(run / '.lock', os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held, current = os.fstat(lock.fileno()), (run / '.lock').lstat()
                if [held.st_dev, held.st_ino] != [current.st_dev, current.st_ino]: raise ValueError('Run lock changed during cleanup')
                report, actual_finished = inspect(run)
                if actual_finished != finished: raise ValueError('Run changed during cleanup')
                if (run / '.keep-artifacts').exists() or (run / '.keep-artifacts').is_symlink():
                    result['skipped'].append({'run': run.name, 'reason': 'Artifacts are pinned'}); continue
                opened = verification_open_paths()
                if opened is None:
                    result['skipped'].append({'run': run.name, 'reason': 'Open files could not be inspected; no artifacts were removed'}); continue
                if any(path == str(run) or path.startswith(str(run) + '/') for path in opened):
                    result['skipped'].append({'run': run.name, 'reason': 'Run is in use'}); continue
                names = [name for name in report['storage']['artifacts'] if (run / name).exists()]
                result['eligible'].append({'run': run.name, 'artifacts': names})
                if not apply: continue
                if not shutil.rmtree.avoids_symlink_attacks: raise ValueError('This Python cannot safely remove artifact trees')
                run_fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    info = os.fstat(run_fd)
                    if [info.st_dev, info.st_ino] != report['storage']['directory']: raise ValueError('Run changed during cleanup')
                    report['storage']['pruningStartedAt'] = utc()
                    write_storage_report(run_fd, report)
                    for name in names:
                        info = os.stat(name, dir_fd=run_fd, follow_symlinks=False)
                        if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != report['storage']['artifacts'][name]: raise ValueError('Artifact directory changed during cleanup')
                        shutil.rmtree(name, dir_fd=run_fd)
                    report['storage'].update(prunedAt=utc(), removedArtifacts=names)
                    write_storage_report(run_fd, report)
                finally: os.close(run_fd)
                result['removed'].append({'run': run.name, 'artifacts': names})
        except BlockingIOError:
            result['skipped'].append({'run': run.name, 'reason': 'Run is locked'})
        except (OSError, ValueError, KeyError, TypeError) as error:
            result['errors'].append({'run': run.name, 'reason': str(error)})
    return result

def dependency_files():
    return tuple('editor/node_modules/' + name + '/package.json' for name in ['preact', 'htm', 'mediabunny'])

def catalog(repo):
    node = '{node}'
    py = '{python}'
    tests = sorted('editor/test/' + p.name for p in (repo / 'editor/test').glob('*.test.mjs') if p.name not in EXCLUDED_BROWSER)
    site_tests = sorted('site/test/' + p.name for p in (repo / 'site/test').glob('*.test.mjs'))
    swift = ['{swift}', 'test', '--package-path', '{work}/native/ReelKit', '--jobs', '1', '--skip-update', '--disable-sandbox', '--cache-path', '{out}/swift-cache', '--config-path', '{out}/swift-config', '--security-path', '{out}/swift-security']
    def helpers(name, files):
        commands = [[py if file.endswith('.py') else '{sh}' if file.endswith('.sh') else node, 'native/scripts/' + file, *(['.', '.'] if file == 'test-mobile-track-delete.mjs' else [])] for file in files.split()]
        tools = ('python', 'sh', 'node', 'swiftc')
        inputs = tuple('native/scripts/' + file for file in files.split())
        for command in commands:
            if command[1] == 'native/scripts/test-audio-effect-planning.py':
                command.extend(['--reelkit-build', '{work}/native/ReelKit/.build/debug'])
                # This phase can run alone. Build its real backend before the history checks.
                commands.insert(0, [swift[0], 'build', *swift[2:]])
                tools += ('swift',)
                inputs += ('native/ReelKit/Package.swift',)
                break
        return Phase(name, commands, tools, inputs)
    phases = [
        Phase('runner-contracts', [[py, '-I', '-S', '-B', 'native/scripts/test-verify-arya-local.py'], [node, '--test', '--test-reporter=tap', '--test-concurrency=1', 'native/scripts/test-local-http-ownership.mjs']], ('python', 'node', 'git'), ('native/scripts/verify-arya-local.py', 'native/scripts/local-http-ownership.mjs', 'native/scripts/test-verify-arya-local.py', 'native/scripts/test-local-http-ownership.mjs')),
        Phase('persistence-check', [[node, 'editor/scripts/prepare-project-writer.mjs', 'prepare', 'editor/core'], [node, 'editor/scripts/prepare-project-writer.mjs', 'validate', 'editor/core']], ('node', 'clang', 'codesign', 'lipo', 'xcrun'), ('editor/scripts/prepare-project-writer.mjs',), action='prepare'),
        Phase('browser-tests', [[node, '--import', './native/scripts/local-http-ownership.mjs', '--test', '--test-reporter=tap', '--test-concurrency=1', *tests]], ('node', 'clang', 'codesign', 'lipo', 'xcrun', 'ffmpeg', 'ffprobe'), tuple(tests) + dependency_files() + ('native/scripts/local-http-ownership.mjs',)),
        Phase('native-backend', [swift + ['--skip', NATIVE_SKIP]], ('swift', 'node', 'ffmpeg', 'ffprobe', 'clang'), ('native/ReelKit/Package.swift',) + dependency_files(), timeout=5400),
        Phase('native-golden', [swift + ['--filter', 'testBrowserGoldenFramesThroughMetal']], ('swift', 'node', 'ffmpeg'), tuple('editor/test/golden/' + name for name in ['basics-1.png','basics-4.png','basics-6.png','motion-0.5.png','motion-3.png','comps-nodes-matte-2.png']), optional=True),
        Phase('native-person-fixture', [swift + ['--filter', 'testRealPersonAlphaWithPreservedAudio']], ('swift', 'node', 'ffmpeg'), optional=True, action='person'),
        helpers('native-geometry', 'test-change-receipts.sh test-ui-geometry.sh test-displayed-frame.py test-viewer-geometry.py test-vector-editing.py test-panel-gestures.py'),
        helpers('native-selection', 'test-source-selection.sh test-source-dispatch.py test-session-dispatch.py test-source-playback.py test-library-selection.sh'),
        helpers('native-timeline', 'test-timeline-planning.sh test-timeline-range.py test-timecode-entry.py test-motion-graph.py test-motion-drafts.py test-color-node-graph.py'),
        helpers('native-processing', 'test-inspector-workflows.sh test-native-title-appearance.py test-interchange-import.py test-tracking-request.py test-audio-workflows.py test-audio-effect-planning.py test-audio-meter.py test-audio-bus-clock.py test-audio-bus-playback.py test-color-workflows.py test-color-draft-preview.py test-color-sampling.py test-color-reference-look.py test-color-panel-typecheck.py test-color-window.py test-color-window-field.py test-color-window-contract.py test-multicam-workflows.sh test-multicam-commit.py test-render-preview.py'),
        helpers('native-parity', 'test-transcript-drafts.py test-transcript-preview.py test-native-shorts.py test-native-responsive.py test-native-motion-route.py test-mobile-first-run.py test-mobile-keyboard.py test-document-admission.py test-native-files-import.py test-native-haptics.py test-native-assistant-routing-contracts.py test-assistant-editor-controls.py test-native-music-outcome-contracts.py test-native-music-identity-contracts.py test-delivery-history.py test-delivery-range.py test-import-outcomes.py test-mobile-track-delete.py test-mobile-track-delete.mjs test-recent-projects.py'),
        Phase('mac-build', [['{xcodebuild}', '-project', 'native/Reel.xcodeproj', '-scheme', 'Reel', '-configuration', 'Debug', '-destination', 'generic/platform=macOS', '-derivedDataPath', '{out}/mac-derived', '-jobs', '1', '-disableAutomaticPackageResolution', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build'], ['{python}', '-I', '-S', '-B', 'native/scripts/check-native-dylibs.py', '{out}/mac-derived/Build/Products/Debug/Arya.app']], ('xcodebuild', 'node', 'clang', 'codesign', 'lipo', 'xcrun', 'python'), ('native/Reel.xcodeproj/project.pbxproj', 'native/scripts/check-native-dylibs.py') + dependency_files()),
        Phase('ios-simulator-build', [['{xcodebuild}', '-project', 'native/Reel.xcodeproj', '-scheme', 'Reel iOS', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', '{out}/ios-derived', '-jobs', '1', '-disableAutomaticPackageResolution', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build'], ['{python}', '-I', '-S', '-B', 'native/scripts/check-native-dylibs.py', '{out}/ios-derived/Build/Products/Debug-iphonesimulator/Arya.app']], ('xcodebuild', 'node', 'python'), ('native/Reel.xcodeproj/project.pbxproj', 'native/scripts/check-native-dylibs.py') + dependency_files()),
        Phase('mac-resources', [], ('python',), ('native/scripts/verify-arya-notices.py', 'THIRD_PARTY_NOTICES.md'), action='mac-resources'),
        Phase('ios-resources', [], ('python',), ('native/scripts/verify-arya-notices.py', 'THIRD_PARTY_NOTICES.md'), action='ios-resources'),
        Phase('runtime-installer-contracts', [[py, '-I', '-S', '-B', 'native/scripts/test-node-runtime.py'], [py, '-I', '-S', '-B', 'native/scripts/test-arya-installer.py']], ('python',), ('native/scripts/test-node-runtime.py', 'native/scripts/test-arya-installer.py')),
        Phase('release-contracts', [[py, '-I', '-S', '-B', 'native/scripts/test-release.py']], ('python', 'node', 'clang', 'codesign', 'lipo', 'xcrun'), ('native/scripts/test-release.py',)),
        Phase('site', [[node, 'site/scripts/build.mjs'], [node, '--test', '--test-reporter=tap', '--test-concurrency=1', *site_tests]], ('node',), ('site/scripts/build.mjs', *site_tests)),
        Phase('source-reader', [[node, 'scripts/public-readiness.mjs', '--self-test'], [node, '--test', '--test-reporter=tap', '--test-concurrency=1', 'scripts/test-public-readiness.mjs', 'scripts/test-third-party-notices.mjs'], [node, 'scripts/check-third-party-notices.mjs'], [py, '-I', '-S', '-B', 'scripts/test-public-readiness-read.py']], ('node', 'python'), ('scripts/public-readiness.mjs', 'scripts/test-public-readiness.mjs', 'scripts/test-third-party-notices.mjs', 'scripts/check-third-party-notices.mjs', 'scripts/test-public-readiness-read.py', 'THIRD_PARTY_NOTICES.md')),
        Phase('store-notice-contracts', [[py, '-I', '-S', '-B', 'native/scripts/test-arya-notices.py'], [py, '-I', '-S', '-B', 'native/scripts/test-arya-store-app.py'], [py, '-I', '-S', '-B', 'native/scripts/verify-arya-store-app.py', '--root', '.']], ('python',), ('native/scripts/verify-arya-notices.py', 'native/scripts/test-arya-notices.py', 'native/scripts/verify-arya-store-app.py', 'native/scripts/test-arya-store-app.py')),
    ]
    for name in reversed(['renderer-regressions', 'figma-text-smoke', 'golden', 'processing-smoke']):
        refs = tuple('editor/test/golden/' + ref for ref in ['basics-1.png','basics-4.png','basics-6.png','motion-0.5.png','motion-3.png','comps-nodes-matte-2.png']) if name == 'golden' else ()
        phases.insert(3, Phase('browser-' + name, [[node, '--import', './native/scripts/local-http-ownership.mjs', 'editor/scripts/' + name + '.mjs']], ('node', 'ffmpeg', 'ffprobe'), ('native/scripts/local-http-ownership.mjs', 'editor/scripts/' + name + '.mjs') + dependency_files() + refs + ('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',), action='http'))
    return phases

def digest(data): return hashlib.sha256(data).hexdigest()
def utc(): return datetime.now(timezone.utc).isoformat()
def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    if path.is_symlink() or temporary.is_symlink(): raise ValueError('Unsafe evidence symlink: ' + str(path))
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    temporary.replace(path)
def git(repo, *args): return subprocess.check_output(['git', '-C', str(repo), *args])

def source_snapshot(repo):
    sha = git(repo, 'rev-parse', 'HEAD').decode().strip()
    status = git(repo, 'status', '--porcelain=v1', '-z').decode('utf8', 'surrogateescape')
    names = set(git(repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')) - {b''}
    files = {}
    for raw in sorted(names):
        name = os.fsdecode(raw)
        file = repo / name
        if file.is_symlink(): files[name] = {'type': 'symlink', 'target': os.readlink(file)}
        elif file.is_file(): files[name] = {'type': 'file', 'sha256': digest(file.read_bytes()), 'mode': file.stat().st_mode & 0o777}
        elif not file.exists(): files[name] = {'type': 'missing'}
        else: raise ValueError('Unsupported source path: ' + name)
    value = {'gitSHA': sha, 'dirty': bool(status), 'porcelain': status, 'files': files}
    value['fingerprint'] = digest(json.dumps(value, sort_keys=True).encode())
    return value

def tool_paths(names):
    found = {'python': sys.executable, 'sh': shutil.which('sh')}
    for name in names: found[name] = sys.executable if name == 'python' else shutil.which(name)
    return found

def tool_receipts(found):
    receipts = {}
    for name, file in found.items():
        if not file: receipts[name] = None; continue
        flag = '-version' if name in {'ffmpeg', 'ffprobe', 'xcodebuild', 'lipo'} else '--version'
        try:
            version = subprocess.run([file, flag], capture_output=True, text=True, timeout=10, env={k:v for k,v in os.environ.items() if k in {'PATH','HOME','LANG','LC_ALL','DEVELOPER_DIR'}})
            detail = {'exitCode': version.returncode, 'output': (version.stdout + version.stderr)[:4096]}
        except (OSError, subprocess.TimeoutExpired) as error: detail = {'error': str(error)}
        receipts[name] = {'path': file, 'realpath': str(Path(file).resolve()), 'sha256': digest(Path(file).read_bytes()), 'versionProbe': detail}
    return receipts

def copy_workspace(repo, work, snapshot):
    if work.is_symlink(): raise ValueError('Unsafe workspace symlink')
    if work.exists(): shutil.rmtree(work)
    work.mkdir()
    for name, info in snapshot['files'].items():
        source, destination = repo / name, work / name
        if info['type'] == 'missing': continue
        if info['type'] == 'symlink': raise ValueError('Source symlinks require manual review: ' + name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and (destination.is_symlink() or not destination.is_file()): raise ValueError('Unsafe workspace path: ' + name)
        shutil.copyfile(source, destination)
        destination.chmod(info['mode'])
        if digest(destination.read_bytes()) != info['sha256']: raise ValueError('Source changed during copy: ' + name)
    # Copy installed dependencies and existing prepared outputs. Preparation later occurs only inside this copy.
    for name in ['editor/node_modules', 'editor/core/project-writer', 'editor/core/project-writer.prepared.json']:
        source, destination = repo / name, work / name
        if not source.exists() or destination.exists(): continue
        if source.is_dir(): shutil.copytree(source, destination, symlinks=False)
        else: destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, destination); shutil.copymode(source, destination)

def ignored_inputs(repo):
    files = {}
    for name in ['editor/node_modules', 'editor/core/project-writer', 'editor/core/project-writer.prepared.json']:
        root = repo / name
        paths = sorted(root.rglob('*')) if root.is_dir() else [root]
        for path in paths:
            if path.is_symlink() and not path.resolve().is_relative_to(root.resolve() if root.is_dir() else root.parent.resolve()): raise ValueError('Installed input symlink escapes its root: ' + str(path))
            if path.is_file(): files[str(path.relative_to(repo))] = digest(path.read_bytes())
            elif path.is_symlink() and not path.exists(): raise ValueError('Dangling installed input: ' + str(path))
    return files

def reset_owned_preparation(work):
    # work is the freshly recreated owned source copy, never the original repo.
    for name in ['editor/core/project-writer', 'editor/core/project-writer.prepared.json']:
        file = work / name
        if file.is_symlink() or file.parent.is_symlink() or (file.exists() and not file.is_file()): raise ValueError('Unsafe owned preparation output: ' + name)
        file.unlink(missing_ok=True)

@contextmanager
def termination_handler():
    def terminate(signum, frame): raise KeyboardInterrupt('SIGTERM')
    previous = signal.signal(signal.SIGTERM, terminate)
    try: yield
    finally: signal.signal(signal.SIGTERM, previous)

def live_group_members(group):
    listing = subprocess.run(['ps', '-axo', 'pid=,pgid=,stat='], capture_output=True, text=True, check=True).stdout
    return [int(fields[0]) for fields in map(str.split, listing.splitlines()) if len(fields) == 3 and int(fields[1]) == group and not fields[2].startswith('Z')]

def signal_group(group, sig):
    try: os.killpg(group, sig)
    except ProcessLookupError: pass
    except PermissionError as refused:
        # macOS answers EPERM for a group whose remaining members are all zombies.
        # Only a live member that refused the signal is a cleanup failure.
        # A member that is still exiting can refuse briefly, so recheck before failing.
        for _ in range(20):
            try: members = live_group_members(group)
            except (OSError, subprocess.CalledProcessError, ValueError): raise refused
            if not members: return
            time.sleep(0.1)
        raise

def stop_owned_group(child):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if child.poll() is None:
        signal_group(child.pid, signal.SIGTERM)
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: pass
    # One KILL catches descendants even if the immediate command already exited.
    signal_group(child.pid, signal.SIGKILL)
    if child.poll() is None:
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: raise RuntimeError('Owned process did not stop')

def execute(argv, cwd, env, log, timeout, on_start=None):
    if log.is_symlink(): raise ValueError('Unsafe log symlink')
    with termination_handler(), log.open('wb') as target:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=target, stderr=subprocess.STDOUT, start_new_session=True)
        cleaned = False
        try:
            if on_start: on_start(child.pid)
            return child.wait(timeout=timeout), ''
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            reason = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else 'interrupted'
            cleaned = True
            stop_owned_group(child)
            return child.returncode, reason
        finally:
            # A single cleanup for the group created here also covers evidence
            # write errors and background children left after normal completion.
            if not cleaned: stop_owned_group(child)

def test_counts(argv, log):
    total = re.search(r'^Ran (\d+) tests?\b', log, re.M)
    python_scripts = [Path(argument).name for argument in argv if argument.endswith('.py')]
    if python_scripts and (total or any(name in UNITTEST_SCRIPTS for name in python_scripts)):
        skipped = re.search(r'\bskipped=(\d+)', log)
        return {'executed': int(total[1]) if total else 0, 'skipped': int(skipped[1]) if skipped else 0}
    if '--test' in argv:
        executed = re.search(r'^# tests (\d+)$', log, re.M)
        skipped = re.search(r'^# skipped (\d+)$', log, re.M)
        return {'executed': int(executed[1]) if executed else 0, 'skipped': int(skipped[1]) if skipped else 0}
    if len(argv) > 1 and Path(argv[0]).name == 'swift' and argv[1] == 'test':
        totals = re.findall(r'Executed (\d+) tests?', log)
        return {'executed': max(map(int, totals), default=0), 'skipped': len(re.findall(r"Test Case .* skipped ", log))}
    return None

HELPER_PHASES = {'browser-tests', 'native-backend'}

def persistence_test_writers(work, output):
    """The publication-lock and draft-privacy fixtures compare the shipped writer with a build
    of the same source that has its test hooks. Without both they fail or skip."""
    production = work / 'editor/core/project-writer'
    if production.is_symlink() or not production.is_file(): raise ValueError('The prepared persistence helper is missing from the owned copy')
    folder = output / 'persistence-test-writers'
    if folder.is_symlink(): raise ValueError('Unsafe output symlink: persistence-test-writers')
    folder.mkdir(exist_ok=True)
    testing = folder / 'project-writer-testing'
    if testing.is_symlink(): raise ValueError('Unsafe test writer symlink')
    testing.unlink(missing_ok=True)
    subprocess.run(['/usr/bin/clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-mmacosx-version-min=14.0', '-DARYA_PERSISTENCE_TESTING', str(work / 'editor/core/project-writer.c'), '-o', str(testing)], check=True, capture_output=True, timeout=120)
    hashes = {str(production): digest(production.read_bytes()), str(testing): digest(testing.read_bytes())}
    env = {'ARYA_LOCK_PRODUCTION_BINARY': str(production), 'ARYA_LOCK_PRODUCTION_SHA256': hashes[str(production)],
           'ARYA_LOCK_TEST_BINARY': str(testing), 'ARYA_LOCK_TEST_SHA256': hashes[str(testing)],
           'ARYA_DRAFT_PRODUCTION_BINARY': str(production), 'ARYA_DRAFT_TEST_BINARY': str(testing)}
    return env, hashes

def inspect_resources(app, ios):
    resources = app if ios else app / 'Contents/Resources'
    info = app / 'Info.plist' if ios else app / 'Contents/Info.plist'
    value = plistlib.loads(info.read_bytes())
    if Path(value['CFBundleExecutable']).name != value['CFBundleExecutable'] or value['CFBundleExecutable'] in {'', '.', '..'}: raise ValueError('Unsafe bundle executable name')
    executable = app / value['CFBundleExecutable'] if ios else app / 'Contents/MacOS' / value['CFBundleExecutable']
    required = [info, executable, resources / 'editor/reel-core.js', resources / 'editor/arya-music.js', resources / 'editor/web/index.html', resources / 'editor/core/project.js', resources / 'editor/vendor/preact/LICENSE', resources / 'editor/vendor/htm/LICENSE', resources / 'editor/vendor/mediabunny/LICENSE', resources / 'Assets.car', resources / 'editor/web/fonts/LICENSE-Inter.txt']
    if ios and ((app / 'Helpers/project-writer').exists() or (resources / 'editor/core/project-writer.prepared.json').exists()): raise ValueError('iOS bundle must omit desktop persistence helper')
    if not ios:
        required += [app / 'Contents/Helpers/project-writer', resources / 'editor/core/project-writer.prepared.json', resources / 'editor/agent/output-stream.mjs', resources / 'editor/agent/assistant-catalog.mjs', resources / 'editor/agent/catalog-discovery.mjs', resources / 'editor/core/assistant-routing.mjs']
    for file in required:
        if not file.is_file() or file.is_symlink(): raise ValueError('Missing/nonregular bundle resource: ' + str(file))
    return {'bundleID': value.get('CFBundleIdentifier'), 'files': {str(file): digest(file.read_bytes()) for file in required}, 'signatureValidated': False, 'privacyInventoryClosed': False, 'scope': 'Required file presence and SHA256 only; no signature, runtime, 136-byte parity, or complete resource inventory acceptance'}

def verify(repo, phases, names, output, *, resume=False, expect_sha=None, require_clean=False, person_fixture=None, mac_app=None, ios_app=None):
    repo = repo.resolve()
    output = Path(os.path.abspath(output))
    if output.resolve() != output: raise ValueError('Output path may not traverse symlinks')
    allowed = [repo / 'build', Path(tempfile.gettempdir()).resolve()]
    if not any(output.is_relative_to(base) for base in allowed): raise ValueError('Use a new repo/build or temporary output directory')
    if output.exists() != resume: raise ValueError('Output must be new, or use --resume on existing evidence')
    snapshot = source_snapshot(repo)
    if expect_sha and snapshot['gitSHA'] != expect_sha: raise ValueError('Git SHA differs from --expect-sha')
    if require_clean and snapshot['dirty']: raise ValueError('Source is dirty; --require-clean rejected it')
    plan = [asdict(p) for p in phases if p.name in names]
    if not plan or len(plan) != len(names): raise ValueError('Unknown or repeated phase selection')
    runner_sha = digest(Path(__file__).read_bytes())
    options = {k: str(v) if v else None for k,v in {'person_fixture': person_fixture, 'mac_app': mac_app, 'ios_app': ios_app}.items()}
    if person_fixture: options['personSHA256'] = digest(Path(person_fixture).read_bytes())
    tools = tool_paths({name for p in phases if p.name in names for name in p.tools})
    tool_evidence = tool_receipts(tools)
    inputs = ignored_inputs(repo)
    environment = {key: os.environ.get(key) for key in ['PATH', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']}
    host = {'system': platform.system(), 'release': platform.release(), 'machine': platform.machine(), 'macOS': platform.mac_ver()[0]}
    external_inputs = {file: digest(Path(file).read_bytes()) for phase in phases if phase.name in names for file in phase.files if Path(file).is_absolute() and Path(file).is_file()}

    key = digest(json.dumps({'source': snapshot['fingerprint'], 'runner': runner_sha, 'plan': plan, 'options': options, 'tools': tool_evidence, 'inputs': inputs, 'environment': environment, 'externalInputs': external_inputs, 'host': host}, sort_keys=True).encode())
    output.mkdir(parents=True, exist_ok=resume)
    for name in ['.lock', 'manifest.json']:
        if (output / name).is_symlink(): raise ValueError('Unsafe output symlink: ' + name)
    with (output / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest_path = output / 'manifest.json'
        if resume:
            report = json.loads(manifest_path.read_text())
            if report.get('storage', {}).get('pruningStartedAt') or report.get('storage', {}).get('prunedAt'): raise ValueError('Run artifacts were pruned; start a new verification run')
            if report['resumeKey'] != key:
                write_json(output / ('resume-rejected-' + uuid.uuid4().hex + '.json'), {'at': utc(), 'actualSource': snapshot, 'reason': 'Source/runner/selection/options changed'})
                raise ValueError('Resume evidence belongs to different source/runner/options')
            for state in report['phases'].values():
                if state['status'] == 'running':
                    for attempt in state.get('attempts', []):
                        group = attempt.get('ownedProcessGroup')
                        if group:
                            try: os.killpg(group, 0)
                            except ProcessLookupError: continue
                            except PermissionError: pass
                            raise ValueError('Recorded command group may still be active; resume refused without sending any signal')
                if state['status'] in {'passed', 'passed_with_skips'}:
                    for file, expected in state.get('evidence', {}).items():
                        path = output / file
                        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected: raise ValueError('Passed evidence missing/changed: ' + file)
                    for file, expected in state.get('artifactFiles', {}).items():
                        path = Path(file)
                        if not path.is_file() or path.is_symlink() or digest(path.read_bytes()) != expected: raise ValueError('Passed artifact missing/changed: ' + file)
        else:
            report = {'schemaVersion': 1, 'complete': False, 'started': utc(), 'resumeKey': key, 'runnerSHA256': runner_sha, 'source': snapshot, 'plan': plan, 'options': options, 'phases': {p.name: {'status': 'pending', 'attempts': []} for p in phases if p.name in names}}
        report['toolEvidence'] = tool_evidence
        report['installedInputs'] = inputs
        report['externalInputs'] = external_inputs
        report['environment'] = environment
        report['host'] = host
        report['safety'] = {'developmentAdHocSigning': 'Existing development helper and disposable test signatures only', 'distributionSigning': False, 'credentialCreation': False, 'uploads': False, 'dependencyInstallation': False, 'repositoryCodeTrusted': True}
        write_json(manifest_path, report)
        work = output / 'workspace'
        try:
            copy_workspace(repo, work, snapshot)
            if ignored_inputs(repo) != inputs: raise ValueError('Installed inputs changed while copying')
        except (OSError, ValueError) as error:
            report.update(setupError=str(error), complete=False, finished=utc())
            write_json(manifest_path, report); raise
        report['tools'] = tools
        env = {k:v for k,v in os.environ.items() if k in {'PATH','HOME','LANG','LC_ALL','DEVELOPER_DIR'}}
        for directory in [name for name in STORAGE_DIRS if name != 'workspace'] + ['prepared-writer']:
            path = output / directory
            if path.is_symlink(): raise ValueError('Unsafe output symlink: ' + directory)
            path.mkdir(exist_ok=True)
        report['storage'] = storage_receipt(output)
        write_json(manifest_path, report)
        env.update({'ARYA_OWNED_SERVER': str(work / 'editor/server.mjs'), 'NODE': tools.get('node') or '', 'SWIFT_BACKTRACE': 'enable=yes,interactive=no', 'CLANG_MODULE_CACHE_PATH': str(output / 'module-cache'), 'SWIFTPM_MODULECACHE_OVERRIDE': str(output / 'module-cache'), 'TMPDIR': str(output / 'tmp')})
        (output / 'tmp').mkdir(exist_ok=True)
        for phase in phases:
            if phase.name in names and phase.action == 'prepare' and report['phases'][phase.name]['status'] == 'passed':
                reset_owned_preparation(work)
                (work / 'editor/core').mkdir(parents=True, exist_ok=True)
                for name in ['project-writer', 'project-writer.prepared.json']:
                    shutil.copy2(output / 'prepared-writer' / name, work / 'editor/core' / name)
                report['phases'][phase.name]['workspacePreparationRestored'] = True
        substitutions = {'work': str(work), 'out': str(output), **{k:v or k for k,v in tools.items()}}
        failed = False
        for phase in phases:
            if phase.name not in names: continue
            state = report['phases'][phase.name]
            if state['status'] in {'passed', 'passed_with_skips'}: continue
            if failed: state.update(status='not_run', reason='Fail-fast stopped after an earlier failure'); continue
            state.update(status='running', started=utc()); write_json(manifest_path, report)
            print(phase.name + ': running', flush=True)
            if phase.policy: state.update(status='skipped_policy', reason=phase.policy); continue
            missing = [name for name in phase.tools if not tools.get(name)] + [name for name in phase.files if not (work / name).is_file()]
            if phase.name == 'browser-tests' and not any(argument.endswith('.test.mjs') for argument in phase.commands[0]): missing.append('No browser test files found')
            if phase.name == 'site' and not any(argument.endswith('.test.mjs') for command in phase.commands for argument in command): missing.append('No site test files found')
            if phase.action == 'person' and not person_fixture: missing.append('--person-fixture was not supplied')
            if missing:
                state.update(status='skipped_fixture' if phase.optional else 'blocked', reason='Missing prerequisites: ' + ', '.join(missing)); failed = not phase.optional; continue
            attempt = len(state['attempts']) + 1
            evidence = {}; artifacts = {}; counts = []; result = 0; reason = ''; skipped = False
            if phase.action == 'person':
                target = output / 'person-fixture/project/media/person.mov'; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(person_fixture, target); env['REEL_PERSON_FIXTURE'] = str(target)
            try:
                if phase.action == 'prepare': reset_owned_preparation(work)
                if phase.name in HELPER_PHASES:
                    writers, hashes = persistence_test_writers(work, output)
                    env.update(writers); artifacts.update(hashes)
                env['ARYA_GUARD_FAILFAST'] = '1' if phase.action == 'http' else '0'
                commands = phase.commands
                if phase.action.endswith('resources'):
                    app = Path(ios_app) if phase.action == 'ios-resources' and ios_app else Path(mac_app) if phase.action == 'mac-resources' and mac_app else output / ('ios-derived/Build/Products/Debug-iphonesimulator/Arya.app' if phase.action == 'ios-resources' else 'mac-derived/Build/Products/Debug/Arya.app')
                    resources = inspect_resources(app, phase.action == 'ios-resources')
                    artifacts = resources['files']
                    file = output / f'{phase.name}-{attempt}.json'; write_json(file, resources); evidence[str(file.relative_to(output))] = digest(file.read_bytes())
                    if 'native/scripts/verify-arya-notices.py' in phase.files:
                        commands = [['{python}', '-I', '-S', '-B', 'native/scripts/verify-arya-notices.py', '--root', '{work}', '--app', str(app), '--platform', 'ios' if phase.action == 'ios-resources' else 'macos', '--expected-notice-sha256', snapshot['files']['THIRD_PARTY_NOTICES.md']['sha256']]]
                for index, command in enumerate(commands):
                    argv = [argument.format_map(substitutions) for argument in command]
                    log = output / f'{phase.name}-{attempt}-{index}.log'
                    ownership = output / f'{phase.name}-{attempt}-{index}.ownership.jsonl'
                    if ownership.is_symlink(): raise ValueError('Unsafe ownership log symlink')
                    env['ARYA_OWNERSHIP_LOG'] = str(ownership)
                    state['attempts'].append({'argv': argv, 'cwd': str(work), 'log': log.name, 'at': utc()})
                    def started(pid):
                        state['attempts'][-1]['ownedProcessGroup'] = pid
                        write_json(manifest_path, report)
                    result, reason = execute(argv, work, env, log, phase.timeout, on_start=started)
                    evidence[log.name] = digest(log.read_bytes())
                    if ownership.exists(): evidence[ownership.name] = digest(ownership.read_bytes())
                    if result != 0 or reason: break
                    count = test_counts(argv, log.read_text(errors='replace'))
                    if count:
                        counts.append(count)
                        if count['executed'] == 0: result, reason = 1, 'Command reported zero tests'; break
                        skipped = skipped or count['skipped'] > 0
                if phase.action == 'prepare' and result == 0 and not reason:
                    for name in ['project-writer', 'project-writer.prepared.json']:
                        source = work / 'editor/core' / name
                        cached = output / 'prepared-writer' / name
                        if source.is_symlink() or not source.is_file() or cached.is_symlink(): raise ValueError('Unsafe/missing prepared helper artifact')
                        shutil.copy2(source, cached)
                        evidence[str(cached.relative_to(output))] = digest(cached.read_bytes())
                if source_snapshot(repo)['fingerprint'] != snapshot['fingerprint']: result, reason = 1, 'Source changed during verification'
            except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error: result, reason = 1, str(error)
            state.update(status='interrupted' if reason == 'interrupted' else 'failed' if result else 'passed_with_skips' if skipped else 'passed', exitCode=result, reason=reason, evidence=evidence, artifactFiles=artifacts, testCounts=counts, finished=utc())
            failed = result != 0
            write_json(manifest_path, report)
            print(phase.name + ': ' + state['status'], flush=True)
        report['finished'] = utc()
        states = [state['status'] for state in report['phases'].values()]
        report['selectedChecksPassed'] = all(state == 'passed' for state in states)
        report['executedChecksPassed'] = not any(state in {'failed','blocked','interrupted','not_run','pending','running'} for state in states)
        report['safeChecksPassed'] = report['selectedChecksPassed']
        report['complete'] = report['selectedChecksPassed']
        report['catalogComplete'] = set(names) == {phase.name for phase in phases} and report['complete']
        report['sourceAfter'] = source_snapshot(repo)
        report['sourceStable'] = report['sourceAfter']['fingerprint'] == snapshot['fingerprint']
        if not report['sourceStable']: report.update(complete=False, catalogComplete=False, selectedChecksPassed=False, safeChecksPassed=False, executedChecksPassed=False)
        write_json(manifest_path, report)
        return (1 if not report['sourceStable'] or any(s in {'failed','interrupted'} for s in states) else 2 if any(s in {'blocked','not_run','pending','running'} for s in states) else 0 if report['complete'] else 3), report

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--cleanup', action='store_true', help='Preview stale managed-run artifact cleanup; keep the two newest runs and seven days of artifacts')
    parser.add_argument('--apply', action='store_true', help='Apply --cleanup instead of previewing it')
    parser.add_argument('--phase', action='append', default=[])
    parser.add_argument('--all', action='store_true', help='Run safe local checks including existing ad hoc development signatures; optional skips remain incomplete')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--resume', type=Path)
    parser.add_argument('--expect-sha')
    parser.add_argument('--require-clean', action='store_true')
    parser.add_argument('--person-fixture', type=Path)
    parser.add_argument('--mac-app', type=Path)
    parser.add_argument('--ios-app', type=Path)
    args = parser.parse_args()
    if args.apply and not args.cleanup: parser.error('--apply requires --cleanup')
    if args.cleanup:
        if args.all or args.phase or args.output or args.resume or args.list: parser.error('--cleanup cannot be combined with verification options')
        try:
            result = cleanup_verification_runs(args.repo, apply=args.apply)
            print(json.dumps(result, indent=2))
            return 1 if result['errors'] else 0
        except (ValueError, OSError) as error:
            print('Cleanup refused: ' + str(error), file=sys.stderr); return 2
    phases = catalog(args.repo.resolve())
    if args.list:
        for phase in phases: print(json.dumps(asdict(phase)))
        return 0
    if args.all == bool(args.phase): parser.error('Choose --all or one/more --phase names')
    if args.resume and args.output: parser.error('--resume and --output are mutually exclusive')
    output = args.resume or args.output or args.repo.resolve() / 'build/local-verification' / (datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
    try:
        preserved = [output, args.mac_app, args.ios_app, args.person_fixture]
        housekeeping = cleanup_verification_runs(args.repo, apply=True, preserve=preserved)
        if housekeeping['removed'] or housekeeping['errors']: print(json.dumps({'artifactCleanup': housekeeping}), flush=True)
        code, report = verify(args.repo, phases, [p.name for p in phases] if args.all else args.phase, output, resume=bool(args.resume), expect_sha=args.expect_sha, require_clean=args.require_clean, person_fixture=args.person_fixture, mac_app=args.mac_app, ios_app=args.ios_app)
        housekeeping = cleanup_verification_runs(args.repo, apply=True, preserve=preserved)
        if housekeeping['removed'] or housekeeping['errors']: print(json.dumps({'artifactCleanup': housekeeping}), flush=True)
        print(json.dumps({'manifest': str(output / 'manifest.json'), 'gitSHA': report['source']['gitSHA'], 'sourceDirty': report['source']['dirty'], 'safeChecksPassed': report['safeChecksPassed'], 'complete': report['complete'], 'catalogComplete': report['catalogComplete']}))
        return code
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Verification not completed: ' + str(error), file=sys.stderr); return 2

if __name__ == '__main__':
    with termination_handler():
        try: sys.exit(main())
        except KeyboardInterrupt:
            print('Verification interrupted; no complete result was claimed', file=sys.stderr)
            sys.exit(1)
