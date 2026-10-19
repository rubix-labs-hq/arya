#!/usr/bin/env python3
"""Exercise production indexed audio edits, core application and backend history."""
from pathlib import Path
import argparse
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=repo / 'native/App/Shared/NativeEditor/NativeAudioEffects.swift')
    parser.add_argument('--reelkit-build', type=Path)
    args = parser.parse_args()
    source = args.source.read_text()
    helper = 'import Foundation\n' + source.split('// BEGIN AUDIO EFFECT PLANNING\n')[1].split('// END AUDIO EFFECT PLANNING')[0]
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    with tempfile.TemporaryDirectory(prefix='reel-audio-effects-') as folder:
        temp = Path(folder)
        swift = temp / 'Planner.swift'
        swift.write_text(helper)
        core = temp / 'reel-core.js'
        subprocess.run(['node', str(repo / 'native/scripts/bundle-core.mjs'), '--out', str(core)], cwd=repo, check=True)
        binary = temp / 'planner-checks'
        common = ['swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'module-cache')]
        subprocess.run(common + [str(kit / 'JSON.swift'), str(kit / 'ReelCore.swift'), str(swift), str(Path(__file__).with_name('audio-effect-planning-tests.swift')), '-o', str(binary)], check=True)
        scenarios = temp / 'scenarios.json'
        subprocess.run([str(binary), str(core), str(scenarios)], check=True)
        verify_curves(repo, scenarios)
        typecheck_view(repo, temp, source)
        if args.reelkit_build:
            backend_checks(repo, temp, args.reelkit_build.resolve(), helper, core, scenarios)
        else:
            print('Backend persistence/undo checks were not run. Pass --reelkit-build with current ReelKit products to run them.')


def verify_curves(repo, scenarios):
    js = r'''
import fs from 'node:fs'; import assert from 'node:assert/strict';
import {applyOps} from './editor/core/project.js'; import {audioPlan} from './editor/core/audio-plan.js';
const rows=JSON.parse(fs.readFileSync(process.argv[1])); let checks=0;
for(const row of rows) {
 const p=JSON.parse(row.project), op=row.ops[0], comp=op.comp;
 const scoped=p=>comp ? {...p,...p.comps[comp],comps:p.comps,assets:p.assets} : p;
 const before=audioPlan(scoped(p),0,3).buses[0].items[0], next=applyOps(p,row.ops).project;
 const after=audioPlan(scoped(next),0,3).buses[0].items[0], fx=op.set.fx;
 assert.deepEqual(after.gain,before.gain);assert.deepEqual(after.pan,before.pan);checks+=2;
 if(fx.length===2) {
  const hasOriginal=fx.some(f=>f.metadata?.name==='Original'),hasDuck=fx.some(f=>f.owner==='duck-fixture');
  if(hasOriginal) { const index=fx.findIndex(f=>f.metadata?.name==='Original');assert.deepEqual(after.chain[index+1].curves,before.chain[1].curves);checks++; }
  if(hasDuck) {const index=fx.findIndex(f=>f.owner==='duck-fixture');assert.deepEqual(after.chain[index+1].curves,before.chain[3].curves);checks++; }
 } else {
  assert.deepEqual(after.chain[1].curves,before.chain[1].curves);assert.deepEqual(after.chain[3].curves,before.chain[3].curves);checks+=2;
  const bands=fx[1].params.bands, old=p.tracks[0].clips[0].fx[1].params.bands;
  for(let i=0;i<bands.length;i++) {
   const original=old.findIndex(b=>b.type===bands[i].type),prop=original===1?'freq':'gain';
   assert.deepEqual(after.chain[2].curves[`bands.${i}.${prop}`],before.chain[2].curves[`bands.${original}.${prop}`]);checks++;
  }
 }
}
console.log(`Passed ${checks} actual audio-plan curve preservation checks.`);
'''
    subprocess.run(['node', '--input-type=module', '-e', js, str(scenarios)], cwd=repo, check=True)


def typecheck_view(repo, temp, source):
    project = (repo / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
    stubs = block(project, 'extension Dictionary where Key == String, Value == Any {')
    stubs += r'''
struct NativeNumberRow: View {
 init(_ name:String,value:Double,range:ClosedRange<Double>,change:@escaping(Double)->Void) {}
 var body:some View {EmptyView()}
}
struct EffectInitializerChecks: View {
 var body:some View {
  VStack {
   NativeAudioEffects(effects: []) { values in let _: [String:Any] = ["fx": values] }
   NativeAudioEffects(onEdit: { edit in let _: [[String:Any]] = edit.effects }, effects: [])
  }
 }
}
'''
    swift = temp / 'EffectView.swift'
    swift.write_text(source + '\n' + stubs)
    for sdk, target in [('macosx', 'arm64-apple-macos14.0'), ('iphonesimulator', 'arm64-apple-ios17.0-simulator')]:
        sdk_path = subprocess.check_output(['xcrun', '--sdk', sdk, '--show-sdk-path'], text=True).strip()
        subprocess.run(['swiftc', '-typecheck', '-sdk', sdk_path, '-target', target, '-module-cache-path', str(temp / ('cache-' + sdk)), str(swift)], check=True)
    print('The complete production effect view and both initializer call styles typecheck for macOS and iOS simulator.')


def backend_checks(repo, temp, products, helper, core, scenarios):
    module = products / 'Modules'
    link = list(map(str, sorted((products / 'ReelKit.build').glob('*.o'))))
    if link: link += list(map(str, sorted((products / 'NativeProjectIO.build').glob('*.o'))))
    if (products / 'libReelKit.a').exists():
        module = products
        link = ['-L', str(products), '-lReelKit']
    if not link or not (module / 'ReelKit.swiftmodule').exists():
        raise SystemExit('No ReelKit module/library found in --reelkit-build.')
    source = 'import ReelKit\n' + helper + r'''
@main struct BackendHistoryChecks {
 static func main() async throws {
  let rows=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))) as! [[String:Any]]
  var checks=0
  func check(_ value:Bool,_ message:String) {checks+=1;precondition(value,message)}
  for row in rows {
   let root=URL(fileURLWithPath:CommandLine.arguments[3]).appendingPathComponent(UUID().uuidString)
   try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
   let project=row["project"] as! String
   try Data(project.utf8).write(to:root.appendingPathComponent("reel.project.json"))
   let backend=try ReelBackend(folder:ProjectFolder(root:root),coreScript:URL(fileURLWithPath:CommandLine.arguments[1])) {_,_ in}
   try await backend.start()
   guard let before=await backend.currentProject() else { throw NativeAudioEffectPlanner.Failure("The backend did not load its fixture project at \(root.path), actual file \(backend.folder.projectFile.path)") };let version=await backend.currentVersion()
   let body:[String:Any]=["ops":row["ops"]!,"expectedVersion":version,"who":"you","returnProject":true]
   _=try await backend.handle(method:"POST",path:"/api/ops",body:JSON(any:body).text)
   let after=await backend.currentProject()!,afterVersion=await backend.currentVersion()
   check(after != before && afterVersion==version+1,"One batch commits once")
   _=try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
   let undone=await backend.currentProject()
   check(undone==before,"One real backend undo restores the exact prior project text")
   _=try await backend.handle(method:"POST",path:"/api/redo",body:"{}")
   let redone=await backend.currentProject()
   check(redone==after,"One real backend redo restores the exact edited project text")
   let staleBefore=await backend.currentProject(),staleVersion=await backend.currentVersion()
   do {_=try await backend.handle(method:"POST",path:"/api/ops",body:JSON(any:body).text);preconditionFailure("Stale request must reject")} catch {}
   let unchanged=await backend.currentProject(),unchangedVersion=await backend.currentVersion()
   check(unchanged==staleBefore && unchangedVersion==staleVersion,"A stale request cannot create a mutation or history entry")
   await backend.stop()
  }
  print("Passed \(checks) actual backend atomic commit, exact undo/redo and stale-version checks.")
 }
}
'''
    swift = temp / 'Backend.swift'
    swift.write_text(source)
    binary = temp / 'backend-checks'
    # ReelKit imports its NativeProjectIO C target. Expose that module to this client from the tracked header.
    project_io = temp / 'NativeProjectIO'; project_io.mkdir()
    (project_io / 'module.modulemap').write_text('module NativeProjectIO {\n    umbrella header "%s"\n    export *\n}\n' % (repo / 'native/ReelKit/Sources/NativeProjectIO/include/NativeProjectIO.h'))
    subprocess.run(['swiftc', '-parse-as-library', '-I', str(module), '-I', str(project_io), '-module-cache-path', str(temp / 'module-cache'), str(swift)] + link + ['-o', str(binary)], check=True)
    subprocess.run([str(binary), str(core), str(scenarios), str(temp / 'backend-folders')], check=True)


if __name__ == '__main__':
    main()
