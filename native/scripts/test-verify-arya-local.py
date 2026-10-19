#!/usr/bin/env python3
"""Runner behavior tests: disposable Git trees and subprocesses, no app compiler."""
import importlib.util
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import fcntl
import json
import io
import os
import plistlib
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('local_verification', Path(__file__).with_name('verify-arya-local.py'))
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arya-runner-tests-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.repo = self.base / 'repo'; self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        (self.repo / '.gitignore').write_text('build/\n')
        (self.repo / 'source.txt').write_text('committed\n')
        self.commit('initial')
        self.sha = runner.source_snapshot(self.repo)['gitSHA']
        self.out = self.base / 'evidence'

    def commit(self, message):
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Local Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message], check=True)

    def phase(self, name, program, **kwargs):
        return runner.Phase(name, [[sys.executable, '-c', program]], **kwargs)

    def test_audio_planner_gate_builds_and_checks_real_backend_history(self):
        phase = next(p for p in runner.catalog(Path(__file__).resolve().parents[2]) if p.name == 'native-processing')
        checks = [c for c in phase.commands if 'native/scripts/test-audio-effect-planning.py' in c]
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0][-2:], ['--reelkit-build', '{work}/native/ReelKit/.build/debug'])
        self.assertEqual(phase.commands[0][:2], ['{swift}', 'build'])
        self.assertIn('{work}/native/ReelKit', phase.commands[0])
        self.assertIn('swift', phase.tools)
        self.assertIn('native/ReelKit/Package.swift', phase.files)

    def test_catalog_http_preloads_actually_resolve_in_node(self):
        source_root = Path(__file__).resolve().parents[2]
        destination = self.repo / 'native/scripts/local-http-ownership.mjs'
        destination.parent.mkdir(parents=True)
        shutil.copy2(source_root / 'native/scripts/local-http-ownership.mjs', destination)
        environment = dict(os.environ, TMPDIR=str(self.base),
                           ARYA_OWNED_SERVER=str(self.repo / 'editor/server.mjs'))
        checked = 0
        for phase in runner.catalog(source_root):
            for command in phase.commands:
                if '--import' not in command:
                    continue
                preload = command[command.index('--import') + 1]
                result = subprocess.run([shutil.which('node'), '--import', preload,
                                         '--eval', 'console.log("preload-ready")'],
                                        cwd=self.repo, env=environment, text=True,
                                        capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'preload-ready')
                checked += 1
        self.assertGreater(checked, 1)

    def test_site_catalog_discovers_new_test_and_runs_stable_explicit_inputs(self):
        scripts = self.repo / 'site/scripts'; scripts.mkdir(parents=True)
        tests = self.repo / 'site/test'; tests.mkdir()
        (scripts / 'build.mjs').write_text('console.log("owned site fixture build")\n')
        for name in ['site.test.mjs', 'release-readiness.test.mjs']:
            (tests / name).write_text("import test from 'node:test'; test(" + json.dumps(name) + ", () => {});\n")
        initial = next(p for p in runner.catalog(self.repo) if p.name == 'site')
        self.assertEqual(initial.commands[1][4:], ['site/test/release-readiness.test.mjs', 'site/test/site.test.mjs'])
        (tests / 'availability-failures.test.mjs').write_text("import test from 'node:test'; test('new availability guard executed', () => {});\n")
        (tests / 'notes.mjs').write_text("throw new Error('non-test module must not execute');\n")
        nested = tests / 'nested'; nested.mkdir()
        (nested / 'hidden.test.mjs').write_text("throw new Error('nested test is outside this catalog');\n")
        self.commit('new website test fixture')
        phase = next(p for p in runner.catalog(self.repo) if p.name == 'site')
        expected = ['site/test/availability-failures.test.mjs', 'site/test/release-readiness.test.mjs', 'site/test/site.test.mjs']
        self.assertEqual(phase.commands[1], ['{node}', '--test', '--test-reporter=tap', '--test-concurrency=1', *expected])
        self.assertEqual(phase.files, ('site/scripts/build.mjs', *expected))
        self.assertEqual(phase.tools, ('node',))
        code, report = self.run_plan([phase])
        self.assertEqual(code, 0)
        self.assertEqual(report['phases']['site']['status'], 'passed')
        self.assertEqual(report['phases']['site']['testCounts'], [{'executed': 3, 'skipped': 0}])
        self.assertIn('new availability guard executed', (self.out / 'site-1-1.log').read_text())
        self.assertEqual(report['source']['files'][expected[0]]['sha256'], runner.digest((tests / 'availability-failures.test.mjs').read_bytes()))

    def test_site_catalog_without_test_files_blocks_before_build_or_default_discovery(self):
        scripts = self.repo / 'site/scripts'; scripts.mkdir(parents=True)
        (scripts / 'build.mjs').write_text("throw new Error('empty catalog must block before build');\n")
        self.commit('empty website test fixture')
        phase = next(p for p in runner.catalog(self.repo) if p.name == 'site')
        self.assertEqual(phase.commands[1], ['{node}', '--test', '--test-reporter=tap', '--test-concurrency=1'])
        code, report = self.run_plan([phase])
        state = report['phases']['site']
        self.assertEqual(code, 2)
        self.assertEqual(state['status'], 'blocked')
        self.assertIn('No site test files found', state['reason'])
        self.assertEqual(state['attempts'], [])
        self.assertFalse(report['complete'])
        self.assertFalse(report['safeChecksPassed'])

    def run_plan(self, phases, **kwargs):
        return runner.verify(self.repo, phases, [p.name for p in phases], self.out, **kwargs)

    def test_serial_failfast_and_resume_only_failed_work(self):
        write = "from pathlib import Path; p=Path('{out}/order'); p.write_text((p.read_text() if p.exists() else '')+'A')"
        fail = "from pathlib import Path; import sys; p=Path('{out}/permit'); sys.exit(0 if p.exists() else 7)"
        finish = "from pathlib import Path; p=Path('{out}/order'); p.write_text(p.read_text()+'C')"
        phases = [self.phase('first', write), self.phase('gate', fail), self.phase('last', finish)]
        code, report = self.run_plan(phases)
        self.assertEqual(code, 1); self.assertEqual((self.out/'order').read_text(), 'A')
        self.assertEqual(report['phases']['last']['status'], 'not_run')
        (self.out/'permit').touch()
        code, report = self.run_plan(phases, resume=True)
        self.assertEqual(code, 0); self.assertTrue(report['complete'])
        self.assertEqual((self.out/'order').read_text(), 'AC')
        self.assertEqual(len(report['phases']['first']['attempts']), 1)
        self.assertEqual(len(report['phases']['gate']['attempts']), 2)

    def test_resume_rejects_modified_passed_log(self):
        phase = self.phase('pass', "print('verified')")
        self.run_plan([phase])
        (self.out/'pass-1-0.log').write_text('forged')
        with self.assertRaisesRegex(ValueError, 'Passed evidence'): self.run_plan([phase], resume=True)

    def test_exact_sha_and_changed_head_reject(self):
        phase = self.phase('pass', 'pass')
        with self.assertRaisesRegex(ValueError, 'Git SHA'): self.run_plan([phase], expect_sha='0'*40)
        self.assertFalse(self.out.exists())
        self.run_plan([phase], expect_sha=self.sha)
        (self.repo/'source.txt').write_text('next commit')
        self.commit('changed')
        with self.assertRaisesRegex(ValueError, 'different source'): self.run_plan([phase], resume=True)

    def test_dirty_content_hash_and_same_head_resume_rejection(self):
        (self.repo/'source.txt').write_text('dirty one')
        phase = self.phase('pass', 'pass')
        _, report = self.run_plan([phase])
        self.assertTrue(report['source']['dirty']); self.assertEqual(report['source']['gitSHA'], self.sha)
        self.assertEqual(report['source']['files']['source.txt']['sha256'], runner.digest(b'dirty one'))
        (self.repo/'source.txt').write_text('dirty two')
        with self.assertRaisesRegex(ValueError, 'different source'): self.run_plan([phase], resume=True)

    def test_clean_gate_and_source_change_during_command(self):
        (self.repo/'source.txt').write_text('dirty')
        with self.assertRaisesRegex(ValueError, 'Source is dirty'): self.run_plan([self.phase('none', 'pass')], require_clean=True)
        # A command touching source outside the copy cannot obtain passing evidence.
        program = "from pathlib import Path; Path(" + repr(str(self.repo/'source.txt')) + ").write_text('changed during run')"
        code, report = self.run_plan([self.phase('mutator', program), self.phase('later', 'pass')])
        self.assertEqual(code, 1); self.assertIn('Source changed', report['phases']['mutator']['reason'])
        self.assertEqual(report['phases']['later']['status'], 'not_run')

    def test_optional_missing_is_explicit_and_never_complete(self):
        optional = self.phase('fixture', "raise RuntimeError('must not run')", files=('absent.mov',), optional=True)
        code, report = self.run_plan([optional, self.phase('safe', 'pass')])
        self.assertEqual(code, 3); self.assertFalse(report['safeChecksPassed']); self.assertTrue(report['executedChecksPassed']); self.assertFalse(report['complete'])
        self.assertEqual(report['phases']['fixture']['status'], 'skipped_fixture')
        self.assertEqual(report['phases']['safe']['status'], 'passed')

    def test_missing_tool_blocks_without_install_or_later_command(self):
        blocked = self.phase('dependency', "raise RuntimeError('must not run')", tools=('arya-missing-tool-fixture',))
        code, report = self.run_plan([blocked, self.phase('later', 'pass')])
        self.assertEqual(code, 2); self.assertEqual(report['phases']['dependency']['status'], 'blocked')
        self.assertEqual(report['phases']['dependency']['attempts'], [])
        self.assertEqual(report['phases']['later']['status'], 'not_run')

    def test_owned_timeout_kills_term_ignoring_descendant(self):
        child = "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=Path('{out}/heartbeat');\nwhile True: p.write_text(str(time.time_ns())); time.sleep(0.03)"
        program = "import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); Path('{out}/child.pid').write_text(str(p.pid)); time.sleep(30)"
        code, report = self.run_plan([self.phase('timeout', program, timeout=0.3)])
        self.assertEqual(code, 1); self.assertEqual(report['phases']['timeout']['reason'], 'timeout')
        heartbeat = self.out/'heartbeat'
        self.assertTrue(heartbeat.exists(), 'Descendant must have started')
        time.sleep(0.15); stopped = heartbeat.read_text(); time.sleep(0.15)
        self.assertEqual(stopped, heartbeat.read_text(), 'Owned descendant continued running after timeout cleanup')

    def test_group_signal_accepts_eperm_only_when_no_live_member_remains(self):
        listing = lambda members: subprocess.CompletedProcess([], 0, stdout=members, stderr='')
        with patch.object(runner.os, 'killpg', side_effect=PermissionError(1, 'Operation not permitted')):
            with patch.object(runner.subprocess, 'run', return_value=listing('  41  4242 Z\n  42  999 S\n')):
                runner.signal_group(4242, signal.SIGKILL)
            with patch.object(runner.subprocess, 'run', return_value=listing('  41  4242 Z\n  43  4242 S\n')):
                with self.assertRaises(PermissionError): runner.signal_group(4242, signal.SIGKILL)
        with patch.object(runner.os, 'killpg', side_effect=ProcessLookupError()):
            runner.signal_group(4242, signal.SIGKILL)
        with patch.object(runner.os, 'killpg', side_effect=PermissionError(1, 'Operation not permitted')):
            with patch.object(runner.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['ps'])):
                with self.assertRaises(PermissionError): runner.signal_group(4242, signal.SIGKILL)

    def test_persistence_test_writers_compile_the_hook_build_beside_the_shipped_helper(self):
        work, output = self.base / 'work', self.base / 'out'
        (work / 'editor/core').mkdir(parents=True); output.mkdir()
        (work / 'editor/core/project-writer.c').write_text('#include <stdio.h>\nint main(void){\n#ifdef ARYA_PERSISTENCE_TESTING\nputs("hooks");\n#else\nputs("plain");\n#endif\nreturn 0;}\n')
        with self.assertRaises(ValueError): runner.persistence_test_writers(work, output)
        (work / 'editor/core/project-writer').write_bytes(b'shipped helper')
        env, hashes = runner.persistence_test_writers(work, output)
        self.assertEqual(env['ARYA_LOCK_PRODUCTION_BINARY'], str(work / 'editor/core/project-writer'))
        self.assertEqual(env['ARYA_DRAFT_PRODUCTION_BINARY'], env['ARYA_LOCK_PRODUCTION_BINARY'])
        self.assertEqual(env['ARYA_DRAFT_TEST_BINARY'], env['ARYA_LOCK_TEST_BINARY'])
        self.assertEqual(subprocess.run([env['ARYA_LOCK_TEST_BINARY']], capture_output=True, text=True, check=True).stdout, 'hooks\n')
        self.assertEqual(env['ARYA_LOCK_TEST_SHA256'], runner.digest(Path(env['ARYA_LOCK_TEST_BINARY']).read_bytes()))
        self.assertEqual(hashes[env['ARYA_LOCK_PRODUCTION_BINARY']], runner.digest(b'shipped helper'))

    def test_normal_exit_cleans_owned_background_child(self):
        child = "import time; from pathlib import Path; p=Path('{out}/heartbeat');\nwhile True: p.write_text(str(time.time_ns())); time.sleep(0.03)"
        program = "import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);\nwhile not Path('{out}/heartbeat').exists(): time.sleep(0.01)"
        code,report=self.run_plan([self.phase('background',program)])
        self.assertEqual(code,0);self.assertGreater(report['phases']['background']['attempts'][0]['ownedProcessGroup'],0)
        time.sleep(0.15); stopped=(self.out/'heartbeat').read_text();time.sleep(0.15)
        self.assertEqual(stopped,(self.out/'heartbeat').read_text())

    def test_resume_refuses_recorded_active_group_without_killing_it(self):
        phase=self.phase('pass','pass');self.run_plan([phase])
        manifest=self.out/'manifest.json';report=json.loads(manifest.read_text())
        report['phases']['pass']['status']='running'
        report['phases']['pass']['attempts'][0]['ownedProcessGroup']=os.getpgrp()
        manifest.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError,'may still be active'):self.run_plan([phase],resume=True)
        # This test process still executes; refusal sent no signal to its group.
        self.assertTrue(self.repo.exists())

    def test_secrets_excluded_and_stable_node_path(self):
        program = "import os,json; print(json.dumps(dict(os.environ)))"
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'fixture-secret', 'NODE': '/wrong/node'}):
            _, report = self.run_plan([self.phase('environment', program, tools=('node',))])
        value = json.loads((self.out/'environment-1-0.log').read_text().splitlines()[-1])
        self.assertNotIn('ANTHROPIC_API_KEY', value)
        self.assertEqual(value['NODE'], shutil.which('node'))
        self.assertEqual(value.get('HOME'), os.environ.get('HOME'))
        self.assertEqual(value['TMPDIR'], str(self.out/'tmp'))
        self.assertIn('sha256', report['toolEvidence']['python'])

    def test_workspace_isolation_and_resume_removes_stale_generated_source(self):
        mutate = "from pathlib import Path; Path('source.txt').write_text('copy only'); Path('stale.txt').touch()"
        phases = [self.phase('mutate-copy', mutate), self.phase('retry', "from pathlib import Path; import sys; sys.exit(0 if Path('{out}/permit').exists() and not Path('stale.txt').exists() else 1)")]
        self.run_plan(phases)
        self.assertEqual((self.repo/'source.txt').read_text(), 'committed\n')
        (self.out/'permit').touch()
        code, _ = self.run_plan(phases, resume=True)
        self.assertEqual(code, 0); self.assertEqual((self.out/'workspace/source.txt').read_text(), 'committed\n')

    def test_output_and_workspace_symlink_refused(self):
        self.out.symlink_to(self.repo)
        with self.assertRaisesRegex(ValueError, 'symlinks'): self.run_plan([self.phase('pass', 'pass')])
        self.out.unlink()
        self.run_plan([self.phase('pass', 'pass')])
        shutil.rmtree(self.out/'workspace'); (self.out/'workspace').symlink_to(self.repo)
        with self.assertRaisesRegex(ValueError, 'workspace symlink'): self.run_plan([self.phase('pass', 'pass')], resume=True)
        self.assertEqual((self.repo/'source.txt').read_text(), 'committed\n')

    def test_zero_and_skipped_test_reports_are_not_all_pass(self):
        for output, expected in [('# tests 0\n# skipped 0', 'failed'), ('# tests 3\n# skipped 1', 'passed_with_skips')]:
            self.out = self.base / ('zero' if expected=='failed' else 'skipped')
            phase = runner.Phase('counts', [[sys.executable, '-c', 'print('+repr(output)+')', '--test']])
            code, report = self.run_plan([phase])
            self.assertEqual(report['phases']['counts']['status'], expected)
            self.assertFalse(report['complete'])
            self.assertEqual(code, 1 if expected=='failed' else 3)

    def test_list_is_read_only_without_prerequisites(self):
        before = runner.source_snapshot(self.repo)
        result = subprocess.run([sys.executable, str(Path(runner.__file__)), '--repo', str(self.repo), '--list'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ios-simulator-build', result.stdout)
        self.assertEqual(before, runner.source_snapshot(self.repo)); self.assertFalse(self.out.exists())

    def ios_fixture(self):
        app = self.base/'Fixture.app'; app.mkdir()
        (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Arya','CFBundleIdentifier':'fixture.arya'}))
        for name in ['Arya', 'Assets.car', 'editor/reel-core.js', 'editor/arya-music.js', 'editor/web/index.html', 'editor/core/project.js', 'editor/vendor/preact/LICENSE', 'editor/vendor/htm/LICENSE', 'editor/vendor/mediabunny/LICENSE', 'editor/web/fonts/LICENSE-Inter.txt']:
            file=app/name; file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(b'fixture')
        return app

    def test_resource_evidence_rejects_artifact_tamper_on_resume(self):
        app=self.ios_fixture()
        phase=runner.Phase('resources',[],action='ios-resources')
        code,report=self.run_plan([phase],ios_app=app)
        self.assertEqual(code,0)
        self.assertEqual(report['phases']['resources']['artifactFiles'][str(app/'Assets.car')],runner.digest(b'fixture'))
        (app/'Assets.car').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'Passed artifact'):self.run_plan([phase],ios_app=app,resume=True)

    def test_resource_gate_rejects_desktop_helper_and_path_traversal(self):
        app=self.ios_fixture();(app/'Helpers').mkdir();(app/'Helpers/project-writer').touch()
        with self.assertRaisesRegex(ValueError,'omit desktop'):runner.inspect_resources(app,True)
        (app/'Helpers/project-writer').unlink()
        (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'../elsewhere'}))
        with self.assertRaisesRegex(ValueError,'Unsafe bundle executable'):runner.inspect_resources(app,True)

    def test_changed_ignored_dependency_bytes_reject_resume(self):
        (self.repo/'.gitignore').write_text('build/\nnode_modules/\n');self.commit('ignore installed dependencies')
        dependency=self.repo/'editor/node_modules/fixture/package.json';dependency.parent.mkdir(parents=True);dependency.write_text('version one')
        phase=self.phase('pass','pass');_,report=self.run_plan([phase])
        self.assertEqual(report['installedInputs']['editor/node_modules/fixture/package.json'],runner.digest(b'version one'))
        dependency.write_text('version two')
        with self.assertRaisesRegex(ValueError,'different source'):self.run_plan([phase],resume=True)

    def preparation_fixture(self, original=False):
        core=self.repo/'editor/core';core.mkdir(parents=True)
        (self.repo/'.gitignore').write_text('build/\neditor/core/project-writer\neditor/core/project-writer.prepared.json\n')
        self.commit('ignore prepared outputs')
        if original:
            (core/'project-writer').write_text('original-binary');(core/'project-writer.prepared.json').write_text('original-manifest')
        program="from pathlib import Path; core=Path('editor/core'); core.mkdir(parents=True,exist_ok=True); (core/'project-writer').open('x').write('prepared-binary'); (core/'project-writer.prepared.json').open('x').write('prepared-manifest')"
        return self.phase('prepare',program,action='prepare')

    def test_prepare_removes_only_existing_owned_copies(self):
        phase=self.preparation_fixture(original=True);code,report=self.run_plan([phase])
        self.assertEqual(code,0)
        self.assertEqual((self.repo/'editor/core/project-writer').read_text(),'original-binary')
        self.assertEqual((self.repo/'editor/core/project-writer.prepared.json').read_text(),'original-manifest')
        self.assertEqual((self.out/'workspace/editor/core/project-writer').read_text(),'prepared-binary')
        self.assertIn('prepared-writer/project-writer',report['phases']['prepare']['evidence'])

    def test_prepare_absent_originals_stays_out_of_source(self):
        phase=self.preparation_fixture();code,_=self.run_plan([phase])
        self.assertEqual(code,0);self.assertFalse((self.repo/'editor/core/project-writer').exists())
        self.assertFalse((self.repo/'editor/core/project-writer.prepared.json').exists())
        self.assertEqual((self.out/'workspace/editor/core/project-writer.prepared.json').read_text(),'prepared-manifest')

    def test_resume_restores_exact_preparation_after_workspace_reset(self):
        phase=self.preparation_fixture()
        later=self.phase('later',"from pathlib import Path; import sys; assert Path('editor/core/project-writer').read_text()=='prepared-binary'; sys.exit(0 if Path('{out}/permit').exists() else 1)")
        code,_=self.run_plan([phase,later]);self.assertEqual(code,1)
        (self.out/'permit').touch();shutil.rmtree(self.out/'workspace')
        code,report=self.run_plan([phase,later],resume=True)
        self.assertEqual(code,0);self.assertEqual(len(report['phases']['prepare']['attempts']),1)
        self.assertTrue(report['phases']['prepare']['workspacePreparationRestored'])
        self.assertEqual((self.out/'workspace/editor/core/project-writer').read_bytes(),(self.out/'prepared-writer/project-writer').read_bytes())
        self.assertFalse((self.repo/'editor/core/project-writer').exists())

    def test_term_interrupt_cleans_real_child_and_writes_manifest(self):
        driver=self.base/'driver.py'
        child="import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=Path('{out}/term-heartbeat');\nwhile True: p.write_text(str(time.time_ns())); time.sleep(0.03)"
        driver.write_text("import importlib.util,sys; from pathlib import Path; spec=importlib.util.spec_from_file_location('fixture_runner',"+repr(str(Path(runner.__file__).resolve()))+"); module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module); phases=[module.Phase('term',[[sys.executable,'-c',"+repr(child)+"]]),module.Phase('later',[[sys.executable,'-c','pass']])]; code,report=module.verify(Path("+repr(str(self.repo))+"),phases,['term','later'],Path("+repr(str(self.out))+"));sys.exit(code)")
        with (self.base/'driver.log').open('wb') as log:
            process=subprocess.Popen([sys.executable,str(driver)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            group=None
            try:
                deadline=time.monotonic()+10
                while process.poll() is None and time.monotonic()<deadline:
                    if (self.out/'term-heartbeat').exists():
                        report=json.loads((self.out/'manifest.json').read_text())
                        attempts=report['phases']['term']['attempts']
                        if attempts and attempts[-1].get('ownedProcessGroup'):break
                    time.sleep(0.02)
                self.assertTrue((self.out/'term-heartbeat').exists(),(self.base/'driver.log').read_text())
                report=json.loads((self.out/'manifest.json').read_text());group=report['phases']['term']['attempts'][0]['ownedProcessGroup']
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=7),1)
                report=json.loads((self.out/'manifest.json').read_text())
                self.assertEqual(report['phases']['term']['status'],'interrupted');self.assertEqual(report['phases']['later']['status'],'not_run');self.assertFalse(report['complete'])
                time.sleep(0.15); stopped=(self.out/'term-heartbeat').read_text();time.sleep(0.15)
                self.assertEqual(stopped,(self.out/'term-heartbeat').read_text())
            finally:
                if process.poll() is None:process.kill();process.wait(timeout=2)
                if group:
                    try:os.killpg(group,signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_zero_and_skipped_real_unittest_summaries_all_catalog_scripts(self):
        for name in sorted(runner.UNITTEST_SCRIPTS):
            for skipped in [False,True]:
                with self.subTest(script=name,skipped=skipped):
                    file=self.repo/name
                    file.write_text("import unittest\n"+("class Fixture(unittest.TestCase):\n @unittest.skip('fixture skip')\n def test_skipped(self):pass\n" if skipped else "")+"unittest.main(exit=False)\n")
                    self.out=self.base/(name+('-skip' if skipped else '-zero'))
                    phase=runner.Phase('unittest',[[sys.executable,name]])
                    code,report=self.run_plan([phase])
                    self.assertEqual(code,3 if skipped else 1);self.assertFalse(report['complete'])
                    self.assertEqual(report['phases']['unittest']['status'],'passed_with_skips' if skipped else 'failed')
                    self.assertEqual(report['phases']['unittest']['testCounts'],[{'executed':1 if skipped else 0,'skipped':1 if skipped else 0}])

    def test_swift_report_counts_zero_and_skips(self):
        self.assertEqual(runner.test_counts(['/usr/bin/swift','test'], 'Executed 0 tests'), {'executed': 0, 'skipped': 0})
        self.assertEqual(runner.test_counts(['/usr/bin/swift','test'], "Test Case '-[Suite testFixture]' skipped (0.001 seconds).\nExecuted 3 tests\nExecuted 4 tests"), {'executed': 4, 'skipped': 1})

    def storage_run(self, name, age=10, status='passed'):
        run = self.repo / 'build/local-verification' / name
        run.mkdir(parents=True)
        for directory in runner.STORAGE_DIRS:
            folder = run / directory; folder.mkdir()
            (folder / 'generated').write_text('disposable compiler output')
        (run / '.lock').touch()
        (run / 'check.log').write_text('verified result\n')
        (run / 'prepared-writer').mkdir()
        (run / 'prepared-writer/writer').write_text('small hashed evidence')
        report = {'finished': (datetime.now(timezone.utc) - timedelta(days=age)).isoformat(),
                  'phases': {'check': {'status': status}}, 'storage': runner.storage_receipt(run)}
        runner.write_json(run / 'manifest.json', report)
        return run

    def storage_cleanup(self, **options):
        with patch.object(runner, 'verification_open_paths', return_value=[]):
            return runner.cleanup_verification_runs(self.repo, **options)

    def keep_two_storage_runs(self):
        return [self.storage_run('newest', age=8), self.storage_run('second-newest', age=9)]

    def test_storage_cleanup_previews_then_removes_only_owned_old_artifacts(self):
        old = self.storage_run('old', age=30)
        newest = self.keep_two_storage_runs()
        protected = self.repo / 'build/releases/current/Arya.dmg'
        protected.parent.mkdir(parents=True); protected.write_text('release installer')
        unknown = old / 'source-backup'; unknown.mkdir(); (unknown / 'source.swift').write_text('unique source')
        self.assertEqual([item['run'] for item in self.storage_cleanup()['eligible']], ['old'])
        self.assertTrue((old / 'workspace/generated').exists(), 'Preview must not delete files')
        result = self.storage_cleanup(apply=True)
        self.assertEqual([item['run'] for item in result['removed']], ['old'])
        for directory in runner.STORAGE_DIRS: self.assertFalse((old / directory).exists())
        self.assertEqual((old / 'check.log').read_text(), 'verified result\n')
        self.assertTrue((old / 'prepared-writer/writer').exists())
        self.assertTrue((old / 'source-backup/source.swift').exists())
        self.assertEqual(protected.read_text(), 'release installer')
        self.assertTrue(all((run / 'workspace/generated').exists() for run in newest))
        self.assertTrue(json.loads((old / 'manifest.json').read_text())['storage']['prunedAt'])
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])

    def test_storage_cleanup_keeps_recent_pinned_and_unfinished_runs(self):
        recent = self.storage_run('recent', age=1)
        pinned = self.storage_run('pinned', age=30); (pinned / '.keep-artifacts').write_text('Owner investigation until October 20')
        active = self.storage_run('active', age=30, status='running')
        self.storage_run('current', age=0)
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        for run in [recent, pinned, active]: self.assertTrue((run / 'workspace/generated').exists())

    def test_storage_cleanup_refuses_open_files_and_explicit_inputs(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        with patch.object(runner, 'verification_open_paths', return_value=[str(old / 'workspace/generated')]):
            self.assertEqual(runner.cleanup_verification_runs(self.repo, apply=True)['removed'], [])
        self.assertEqual(self.storage_cleanup(apply=True, preserve=[old / 'mac-derived/Arya.app'])['removed'], [])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_fails_closed_without_open_file_inventory(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        with patch.object(runner, 'verification_open_paths', return_value=None):
            result = runner.cleanup_verification_runs(self.repo, apply=True)
        self.assertEqual(result['removed'], []); self.assertTrue(result['skipped'])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_obeys_active_verifier_lock(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        with (old / '.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.storage_cleanup(apply=True)
        self.assertEqual(result['removed'], [])
        self.assertIn({'run': 'old', 'reason': 'Run is locked'}, result['skipped'])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_rechecks_pin_and_open_files_under_lock(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        original_flock = fcntl.flock
        def pin_on_lock(fd, flags):
            original_flock(fd, flags)
            (old / '.keep-artifacts').write_text('Pin created as cleanup acquired the lock')
        with patch.object(runner.fcntl, 'flock', side_effect=pin_on_lock):
            self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        (old / '.keep-artifacts').unlink()
        def inspect_open_files():
            with (old / '.lock').open('rb') as another_lock:
                with self.assertRaises(BlockingIOError): original_flock(another_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return [str(old / 'workspace/generated')]
        with patch.object(runner, 'verification_open_paths', side_effect=inspect_open_files):
            self.assertEqual(runner.cleanup_verification_runs(self.repo, apply=True)['removed'], [])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_rejects_replaced_lock(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        original_flock = fcntl.flock
        def replace_on_lock(fd, flags):
            original_flock(fd, flags)
            (old / '.lock').unlink(); (old / '.lock').touch()
        with patch.object(runner.fcntl, 'flock', side_effect=replace_on_lock):
            result = self.storage_cleanup(apply=True)
        self.assertEqual(result['removed'], [])
        self.assertIn('Run lock changed', result['errors'][0]['reason'])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_skips_malformed_manifests_without_blocking_checks(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        original = json.loads((old / 'manifest.json').read_text())
        cases = [[], dict(original, storage=None), dict(original, phases=[]), dict(original, phases={'check': None})]
        for malformed in cases:
            with self.subTest(manifest=malformed):
                runner.write_json(old / 'manifest.json', malformed)
                result = self.storage_cleanup(apply=True)
                self.assertEqual(result['errors'], [])
                self.assertEqual(result['removed'], [])
                self.assertTrue((old / 'workspace/generated').exists())

    def test_partial_cleanup_records_pruning_before_deletion_and_refuses_resume(self):
        self.out = self.repo / 'build/local-verification/actual'
        phase = self.phase('pass', 'pass')
        _, report = self.run_plan([phase])
        report['finished'] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        runner.write_json(self.out / 'manifest.json', report); self.keep_two_storage_runs()
        original_rmtree = shutil.rmtree
        removed = []
        def interrupted_delete(path, **options):
            disk = json.loads((self.out / 'manifest.json').read_text())
            self.assertIn('pruningStartedAt', disk['storage'])
            original_rmtree(path, **options)
            removed.append(path)
            raise OSError('Injected failure after deleting the first directory')
        with patch.object(runner.shutil, 'rmtree', side_effect=interrupted_delete) as removal:
            removal.avoids_symlink_attacks = True
            result = self.storage_cleanup(apply=True)
        self.assertTrue(result['errors'])
        self.assertEqual(len(removed), 1)
        self.assertFalse((self.out / removed[0]).exists())
        with self.assertRaisesRegex(ValueError, 'pruned; start a new'): self.run_plan([phase], resume=True)
        self.assertEqual(len(self.storage_cleanup(apply=True)['removed']), 1)
        self.assertTrue((self.out / 'pass-1-0.log').exists())

    def test_storage_cleanup_preserves_replaced_directory_and_symlink_target(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        original = old / 'workspace'; original.rename(old / 'original-workspace')
        original.mkdir(); (original / 'unique.txt').write_text('new data')
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        self.assertEqual((original / 'unique.txt').read_text(), 'new data')
        shutil.rmtree(original); original.symlink_to(self.repo, target_is_directory=True)
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        self.assertEqual((self.repo / 'source.txt').read_text(), 'committed\n')

    def test_storage_cleanup_rejects_unregistered_run_and_traversal_receipt(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        report = json.loads((old / 'manifest.json').read_text())
        report['storage']['artifacts']['../../releases'] = [0, 0]
        runner.write_json(old / 'manifest.json', report)
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        report.pop('storage'); runner.write_json(old / 'manifest.json', report)
        self.assertEqual(self.storage_cleanup(apply=True)['removed'], [])
        self.assertTrue((old / 'workspace/generated').exists())

    def test_storage_cleanup_rejects_symlinked_root_and_run(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        alias = old.parent / 'alias'; alias.symlink_to(self.repo, target_is_directory=True)
        self.assertEqual(self.storage_cleanup(apply=True)['errors'], [])
        base = old.parent; base.rename(self.repo / 'build/saved-runs')
        base.symlink_to(self.repo / 'build/saved-runs', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Unsafe verification storage'): self.storage_cleanup(apply=True)
        self.assertEqual((self.repo / 'source.txt').read_text(), 'committed\n')

    def test_real_verifier_registers_storage_and_rejects_pruned_resume(self):
        self.out = self.repo / 'build/local-verification/actual'
        phase = self.phase('pass', "print('passed')")
        code, report = self.run_plan([phase])
        self.assertEqual(code, 0)
        original_log = (self.out / 'pass-1-0.log').read_bytes()
        self.assertEqual(report['storage']['owner'], runner.STORAGE_OWNER)
        report['finished'] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        runner.write_json(self.out / 'manifest.json', report)
        self.keep_two_storage_runs()
        self.assertEqual(len(self.storage_cleanup(apply=True)['removed']), 1)
        with self.assertRaisesRegex(ValueError, 'pruned; start a new'): self.run_plan([phase], resume=True)
        self.assertEqual((self.out / 'pass-1-0.log').read_bytes(), original_log)

    def test_cli_previews_by_default_and_verification_automatically_prunes(self):
        old = self.storage_run('old', age=30); self.keep_two_storage_runs()
        with patch.object(runner, 'verification_open_paths', return_value=[]), redirect_stdout(io.StringIO()):
            with patch.object(sys, 'argv', ['verify-arya-local.py', '--repo', str(self.repo), '--cleanup']):
                self.assertEqual(runner.main(), 0)
            self.assertTrue((old / 'workspace/generated').exists())
            phase = self.phase('pass', "print('cli passed')")
            with patch.object(runner, 'catalog', return_value=[phase]), patch.object(sys, 'argv', ['verify-arya-local.py', '--repo', str(self.repo), '--phase', 'pass']):
                self.assertEqual(runner.main(), 0)
        self.assertFalse((old / 'workspace').exists())
        current = [p for p in old.parent.iterdir() if p.name not in {'old', 'newest', 'second-newest'}]
        self.assertEqual(len(current), 1)
        self.assertTrue((current[0] / 'workspace/source.txt').exists())
        self.assertEqual((old / 'check.log').read_text(), 'verified result\n')

if __name__ == '__main__': unittest.main()
