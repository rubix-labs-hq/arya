#!/usr/bin/env python3
"""Actual creation/core/filesystem and extracted session-opening tests; no app build or UI."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--source-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--base-root',type=Path)
parser.add_argument('--contracts-only',action='store_true')
args=parser.parse_args()
root=args.source_root.resolve()
session=(root/'native/App/Shared/EditorSession.swift').read_text()
view=(root/'native/App/Shared/EditorView.swift').read_text()
app=(root/'native/App/iOS/ReelIOSApp.swift').read_text()

def section(text,begin,end):
    return text.split(begin,1)[1].split(end,1)[0]

def method(text,signature):
    start=text.index(signature)
    opening=text.index('{',start)
    depth=1;pos=opening+1
    while depth:
        if text[pos]=='{':depth+=1
        elif text[pos]=='}':depth-=1
        pos+=1
    return text[start:pos]

checks=0

def check(value,message):
    global checks
    assert value,message
    checks+=1

creation=section(session,'// BEGIN PROJECT CREATION','// END PROJECT CREATION')
policy=section(view,'// BEGIN WELCOME LAYOUT','// END WELCOME LAYOUT')
opening=method(session,'func open(_ url: URL, completion:')
legacy_opening=method(session,'func open(_ url: URL, prepare:')
creating=method(session,'func createNewProject(')
legacy_creation=method(session,'func create(at ')
page_drain=method(session,'private func awaitPreviousPageDrain(')
recovery_request=method(session,'struct NativeProjectRecoveryRequest: Identifiable')
check('newProject: { presentation.presentSheet(.newProject) }' in app,'New must present creation, not importer')
check('PickerPurpose' not in app and 'session.create(at:' not in app,'New must not use legacy selected-folder creation')
check('session.open(url)' in app and 'NativeProjectPickerOutcome.folder(result)' in app,'Open keeps folder picker and cancel/access outcome')
check('.sheet(item: sheetBinding(sheetRequest))' in app and 'NativeNewProjectSheet(session: session,' in app,'Distinct model-driven sheet routes')
check('open(url, completion: nil, prepare: prepare)' in legacy_opening and 'completion: ((Result<Void, Error>) -> Void)?,\n' in opening,'Legacy signature forwards explicitly; completion overload has no default to steal trailing closures')
check('withCheckedThrowingContinuation' in creating and 'continuation.resume(with: $0)' in creating,'Creation waits for actual startup completion/error')
check('NativeProjectCreation.create(in: documents' in creating and 'coreScript: editor.coreScript' in creating,'Session uses strict local helper and real project factory')
check('Task.checkCancellation()' in creating,'Already-cancelled creation never begins')
check('return try core.fileText(project: core.newProject' in creation,'Persist actual shared-core project format')
check('options: .withoutOverwriting' in creation and '.atomic' not in creation,'File reservation must never overwrite')
check('Darwin.mkdir' in creation and 'code == EEXIST' in creation,'Folder reservation must fail deterministically on collision')
check('Darwin.rmdir' in creation and 'removeItem' not in creation,'Rollback must never recursively erase unexpected contents')
check('self.backend === backend else { completion?(.failure(CancellationError()))' in opening,'Superseded open completes its waiter')
check(opening.index('guard self.backend === backend',opening.index('catch {',opening.index('Task {'))) < opening.index('self.close()',opening.index('Task {')),'Failure close is guarded by current backend identity')
check('if completion == nil { self.error' in opening,'New errors stay in sheet; legacy Open retains its alert')
check('.buttonStyle(.borderedProminent)' in view and '.buttonStyle(.bordered)' in view,'Welcome primary actions have real button surfaces')
check('.fixedSize(horizontal: true, vertical: false)' in view and 'ViewThatFits(in: .horizontal)' in view,'Noncompressing landscape actions fall back when labels do not fit')
check('NativeWelcomeLayout.horizontalActions(width: geometry.size.width' in view and 'dynamicTypeSize.isAccessibilitySize' in view,'Actual welcome consumes tested geometry/accessibility policy')
check('ScrollView {' in view and '.frame(maxWidth: 560)' in view,'Welcome short-height content has bounded width and vertical access')
check('reel.project.json' not in view,'Welcome avoids storage implementation explanation')
check('welcome.newProject' in view and 'welcome.openProject' in view,'Stable accessible first-run controls')
check('Section("Location")' in view and 'Arya’s Projects folder in Files' in view,'Creation states its Files location')
check('.safeAreaInset(edge: .bottom)' in view and '.presentationDetents([.large])' in view,'Create remains outside keyboard-scrolling form without forced phone width')
check('.interactiveDismissDisabled(creating)' in view and 'creating = false' in view,'In-progress action prevents losing completion; all outcomes clear busy')
check('failure = error is CancellationError' in view,'Creation failures are recoverable in-sheet')
check('try await session.createNewProject' in view and view.index('try await session.createNewProject') < view.index('dismissPresentation()',view.index('try await session.createNewProject')),'Dismiss only after startup success')
if args.base_root:
    base=(args.base_root/'native/App/Shared/EditorSession.swift').read_text()
    for signature in ['func open(recent:', 'func create(at ', 'func close()', 'private func refreshDocument(', 'private func makeWebView()']:
        check(method(base,signature)==method(session,signature),f'Legacy lifecycle unchanged: {signature}')
    check(section((args.base_root/'native/App/iOS/ReelIOSApp.swift').read_text(),'// BEGIN PROJECT PICKER OUTCOME','// END PROJECT PICKER OUTCOME')==section(app,'// BEGIN PROJECT PICKER OUTCOME','// END PROJECT PICKER OUTCOME'),'Open cancellation and provider failures unchanged')
print(f'First-run source contracts passed: {checks}',flush=True)
if args.contracts_only:raise SystemExit(0)

# The isolated candidate has only owned files; shared core inputs come from the live repository.
repo=Path(__file__).resolve()
while not (repo/'native/ReelKit/Sources/ReelKit/ReelCore.swift').exists():
    if repo==repo.parent:raise RuntimeError('Cannot find shared core repository')
    repo=repo.parent

swift=r'''
import Foundation
import Darwin
import os

var assertions=0
func expect(_ value: @autoclosure () -> Bool,_ message:String){
    assertions += 1
    if !value(){ fatalError(message) }
}
func rejects(_ message:String,_ action:()throws->Void){
    do {try action();fatalError("expected failure: \(message)")}catch{assertions += 1}
}
struct TestFailure:LocalizedError { var errorDescription:String?{"fixture failure"} }

@MainActor final class Gate {
    var waiting:[CheckedContinuation<Void,Error>]=[]
    func wait()async throws{try await withCheckedThrowingContinuation{waiting.append($0)}}
    func finish(_ error:Error?=nil){let all=waiting;waiting=[];for c in all{if let error{c.resume(throwing:error)}else{c.resume()}}}
}
struct ProjectFolder {let root:URL;init(root:URL){self.root=root}}
@MainActor final class ReelBackend {
    static var nextGate:Gate?;static var failInit=false
    let gate:Gate?;let folder:URL;var newCalls=0
    init(folder:ProjectFolder,coreScript:URL,platform:Int?,writeAdmission:@escaping @Sendable () throws -> Void = {},projectFileAccess:ProjectFileAccess=ProjectFileAccess(),event:@escaping(String,String)->Void)throws{
        if Self.failInit{throw TestFailure()};self.folder=folder.root;gate=Self.nextGate
    }
    func start()async throws{try await gate?.wait()}
    func currentProject()async->String?{nil}
    // No recovery snapshots exist, so a failed legacy Open keeps its alert route.
    func projectRecoveryOffer()async throws->NativeProjectRecoveryOffer{NativeProjectRecoveryOffer(observedToken:"",choices:[])}
    func currentVersion()async->Int{0}
    func handle(method:String,path:String,body:String)async throws->JSON {
        expect(method=="POST" && path=="/api/new","legacy prepare still calls project endpoint")
        newCalls += 1
        let parsed=try JSON.parse(body) as! [String:Any]
        expect(parsed["name"] as? String==folder.lastPathComponent,"legacy folder-name payload retained")
        return .null
    }
}
final class ProjectFileAccess: @unchecked Sendable {init(){}}
@MainActor final class AssistantMock {var restores=0;func restoreHistory(from backend:ReelBackend)async{restores += 1}}
@MainActor final class EditorMock {var onRefresh:(()async->Void)?;var calls=0;func refresh()async{calls += 1;await onRefresh?()}}
@MainActor enum ProjectBookmarks {static var remembered:[URL]=[];static func remember(_ url:URL)->[URL]{remembered.append(url);return remembered}}
struct EditorBundle {let coreScript:URL}
struct SchemeHandler {static let scheme="reel";static let host="editor"}
struct HostScript {static func source(sessionID:String)->String{sessionID}}
struct WKUserScript {
    enum InjectionTime {case atDocumentStart};enum ContentWorld{case page}
    init(source:String,injectionTime:InjectionTime,forMainFrameOnly:Bool,in:ContentWorld){}
}
@MainActor final class Scripts{var clears=0;var adds=0;func removeAllUserScripts(){clears += 1};func addUserScript(_ script:WKUserScript){adds += 1}}
@MainActor final class Config{let userContentController=Scripts()}
@MainActor final class WebMock{let configuration=Config();var loads=0;func load(_ request:URLRequest){loads += 1}}
let log=Logger(subsystem:"test.arya",category:"open")
@MainActor final class Harness {
    var backend:ReelBackend?;var folder:URL?;var accessing:URL?;var recents:[URL]=[]
    var backendID=UUID().uuidString;var sessionID=UUID().uuidString;var error:String?;var pageReady=false
    let platform:Int?=nil;let editor=EditorBundle(coreScript:URL(fileURLWithPath:"/unused"))
    let nativeEditor=EditorMock();let webView=WebMock();var closes=0;var documentRefreshes=0
    let assistant=AssistantMock();var projectRecoveryRequest:NativeProjectRecoveryRequest?
    private var pageWorkerDrainTask:Task<Void,Error>?
    // EXTRACTED PAGE DRAIN
    func close(){closes += 1;backend=nil;folder=nil;accessing=nil;backendID=UUID().uuidString;sessionID=UUID().uuidString}
    func refreshDocument(backend:ReelBackend,folder:URL){documentRefreshes += 1}
    func push(_ name:String,_ json:String){}
    // EXTRACTED OPEN
    // EXTRACTED LEGACY CREATE
}
@MainActor final class Outcome {
    var calls=0;var result:Result<Void,Error>?
    func receive(_ value:Result<Void,Error>){calls += 1;result=value}
    var succeeded:Bool{if case .success?=result{return true};return false}
    var cancelled:Bool{if case .failure(let e)?=result{return e is CancellationError};return false}
}
@main struct FirstRunTests {
    @MainActor static func drain()async{for _ in 0..<100{await Task.yield()}}
    @MainActor static func main()async throws {
        let fm=FileManager.default
        let scratch=URL(fileURLWithPath:CommandLine.arguments[2],isDirectory:true)
        func documents(_ name:String)throws->URL{let p=scratch.appendingPathComponent(name,isDirectory:true);try fm.createDirectory(at:p,withIntermediateDirectories:true);return p}
        let script=URL(fileURLWithPath:CommandLine.arguments[1])
        let request=try NativeProjectCreation.Request(name:"  First Arya  ",width:1080,height:1920,fps:25)
        expect(request.name=="First Arya","trim name")
        let docs=try documents("success")
        let target=try NativeProjectCreation.create(in:docs,request:request){try NativeProjectCreation.projectText($0,coreScript:script)}
        expect(target.deletingLastPathComponent()==docs.appendingPathComponent("Projects",isDirectory:true),"app-owned location")
        let file=target.appendingPathComponent("reel.project.json")
        let saved=try Data(contentsOf:file)
        let core=try ReelCore(scriptURL:script)
        let parsed=try JSON.parse(core.migrate(fileText:String(decoding:saved,as:UTF8.self))) as! [String:Any]
        expect(parsed["name"] as? String==request.name,"actual shared-core name")
        expect((parsed["width"] as? NSNumber)?.intValue==1080,"portrait width")
        expect((parsed["height"] as? NSNumber)?.intValue==1920,"portrait height")
        expect((parsed["fps"] as? NSNumber)?.doubleValue==25,"frame rate")
        expect(!(parsed["tracks"] as? [Any] ?? []).isEmpty,"shared-core default tracks retained")
        rejects("existing project"){_ = try NativeProjectCreation.create(in:docs,request:request){_ in "overwrite"}}
        expect(try! Data(contentsOf:file)==saved,"existing project bytes unchanged")
        for name in ["", "  ", ".", "..", ".hidden", "bad/name", "bad\\name", "bad:name", "x\ny", "x\u{0}y",String(repeating:"x",count:201)] {
            rejects("invalid name"){_ = try NativeProjectCreation.Request(name:name,width:1920,height:1080,fps:30)}
        }
        for values in [(15,1080,30.0),(1920,9000,30.0),(1920,1080,Double.nan),(1920,1080,0.0),(1920,1080,121.0)]{
            rejects("invalid format"){_ = try NativeProjectCreation.Request(name:"Valid",width:values.0,height:values.1,fps:values.2)}
        }
        let unicode=try NativeProjectCreation.Request(name:"Cafe\u{301}",width:1920,height:1080,fps:30)
        expect(unicode.name=="Café","canonical equivalent names map to same folder")
        let brokenDocs=try documents("factory-error")
        rejects("factory error"){_ = try NativeProjectCreation.create(in:brokenDocs,request:request){_ in throw TestFailure()}}
        expect((try! fm.contentsOfDirectory(atPath:brokenDocs.path)).isEmpty,"factory failure leaves no folder")
        let cancelledDocs=try documents("cancel")
        var generated=0
        rejects("cancel before generation"){_ = try NativeProjectCreation.create(in:cancelledDocs,request:request,cancelled:{true}){_ in generated += 1;return "test"}}
        expect(generated==0 && (try! fm.contentsOfDirectory(atPath:cancelledDocs.path)).isEmpty,"cancel leaves no generation/files")
        var cancellationChecks=0
        rejects("cancel after generation"){_ = try NativeProjectCreation.create(in:cancelledDocs,request:request,cancelled:{cancellationChecks += 1;return cancellationChecks==2}){_ in "test"}}
        expect((try! fm.contentsOfDirectory(atPath:cancelledDocs.path)).isEmpty,"post-generation cancel leaves no folders")
        cancellationChecks=0
        rejects("cancel after reserve"){_ = try NativeProjectCreation.create(in:cancelledDocs,request:request,cancelled:{cancellationChecks += 1;return cancellationChecks==4}){_ in "test"}}
        let cancelledTarget=cancelledDocs.appendingPathComponent("Projects").appendingPathComponent(request.name)
        expect(!fm.fileExists(atPath:cancelledTarget.path),"empty reservation removed on cancellation")
        let raceDocs=try documents("write-race")
        let raceTarget=raceDocs.appendingPathComponent("Projects").appendingPathComponent(request.name)
        let raceFile=raceTarget.appendingPathComponent("reel.project.json")
        var calls=0
        rejects("racing file writer"){_ = try NativeProjectCreation.create(in:raceDocs,request:request,cancelled:{calls += 1;if calls==4{try! Data("preserve racer".utf8).write(to:raceFile)};return false}){_ in "overwrite"}}
        expect(try! String(contentsOf:raceFile,encoding:.utf8)=="preserve racer","exclusive file write preserves racing contents")
        let extraDocs=try documents("cancel-unexpected")
        let extraTarget=extraDocs.appendingPathComponent("Projects").appendingPathComponent(request.name)
        let marker=extraTarget.appendingPathComponent("keep.txt")
        calls=0
        rejects("cancel with unexpected contents"){_ = try NativeProjectCreation.create(in:extraDocs,request:request,cancelled:{calls += 1;if calls==4{try! Data("keep".utf8).write(to:marker)};return calls==4}){_ in "test"}}
        expect(try! String(contentsOf:marker,encoding:.utf8)=="keep","cleanup never recursively deletes unexpected files")
        let fileCollision=docs.appendingPathComponent("Projects").appendingPathComponent("File")
        try Data("keep file".utf8).write(to:fileCollision)
        rejects("ordinary file collision"){_ = try NativeProjectCreation.create(in:docs,request:NativeProjectCreation.Request(name:"File",width:1920,height:1080,fps:30)){_ in "test"}}
        expect(try! String(contentsOf:fileCollision,encoding:.utf8)=="keep file","ordinary file unchanged")
        let external=try documents("external")
        let linkedDocs=try documents("symlink-projects")
        try fm.createSymbolicLink(at:linkedDocs.appendingPathComponent("Projects"),withDestinationURL:external)
        rejects("Projects symlink"){_ = try NativeProjectCreation.create(in:linkedDocs,request:request){_ in "test"}}
        expect((try! fm.contentsOfDirectory(atPath:external.path)).isEmpty,"never writes through Projects symlink")
        let blockedDocs=try documents("file-projects")
        try Data("keep".utf8).write(to:blockedDocs.appendingPathComponent("Projects"))
        rejects("Projects file"){_ = try NativeProjectCreation.create(in:blockedDocs,request:request){_ in "test"}}
        let linkedTarget=docs.appendingPathComponent("Projects").appendingPathComponent("Link")
        try fm.createSymbolicLink(at:linkedTarget,withDestinationURL:external)
        rejects("target symlink collision"){_ = try NativeProjectCreation.create(in:docs,request:NativeProjectCreation.Request(name:"Link",width:1920,height:1080,fps:30)){_ in "test"}}
        expect((try! fm.contentsOfDirectory(atPath:external.path)).isEmpty,"target symlink never followed")
        for (w,h) in [(320.0,568.0),(390,844),(430,932),(768,1024),(1032,1376)]{
            expect(!NativeWelcomeLayout.horizontalActions(width:w,height:h,accessibility:false),"portrait stacks")
        }
        for (w,h) in [(844.0,390.0),(1376,1032),(960,600),(608,300)]{
            expect(NativeWelcomeLayout.horizontalActions(width:w,height:h,accessibility:false),"wide landscape allows measured row")
            expect(!NativeWelcomeLayout.horizontalActions(width:w,height:h,accessibility:true),"large text stacks")
        }
        for (w,h) in [(607.0,300.0),(Double.nan,600),(960,Double.infinity),(960,-1),(0,600)]{
            expect(!NativeWelcomeLayout.horizontalActions(width:w,height:h,accessibility:false),"invalid/narrow does not use horizontal row")
        }
        // Extracted production open method, instrumented backend/web/document boundaries only.
        let first=URL(fileURLWithPath:"/tmp/arya-first")
        let newer=URL(fileURLWithPath:"/tmp/arya-newer")
        let success=Harness();let successResult=Outcome()
        ReelBackend.nextGate=nil
        success.open(first,completion:successResult.receive)
        await drain()
        expect(successResult.calls==1 && successResult.succeeded,"startup success completes once")
        expect(success.folder==first && success.backend != nil && success.webView.loads==1,"successful editor remains open")
        expect(success.documentRefreshes==1,"document lifecycle preserved")
        let legacyCreate=Harness()
        let legacyFolder=scratch.appendingPathComponent("legacy-create")
        legacyCreate.create(at:legacyFolder)
        await drain()
        expect(legacyCreate.folder==legacyFolder && legacyCreate.backend?.newCalls==1,"actual legacy trailing-closure create remains functional")
        expect(legacyCreate.webView.loads==1,"legacy create still loads editor")
        let initFailure=Harness();let initResult=Outcome();ReelBackend.failInit=true
        initFailure.open(first,completion:initResult.receive);ReelBackend.failInit=false
        expect(initResult.calls==1 && !initResult.succeeded && initFailure.folder==nil,"init error completes New and leaves welcome")
        expect(initFailure.error==nil,"New error belongs to form")
        let failed=Harness();let failedResult=Outcome();let failedGate=Gate();ReelBackend.nextGate=failedGate
        failed.open(first,completion:failedResult.receive);await drain();failedGate.finish(TestFailure());await drain()
        expect(failedResult.calls==1 && !failedResult.succeeded && failed.backend==nil && failed.folder==nil,"current startup failure closes failed editor")
        expect(failed.error==nil && failed.webView.loads==0,"failed New retains local error and does not load empty web editor")
        let legacy=Harness();let legacyGate=Gate();ReelBackend.nextGate=legacyGate
        legacy.open(first);await drain();legacyGate.finish(TestFailure());await drain()
        expect(legacy.error?.contains("fixture failure")==true && legacy.folder==nil,"legacy Open failure alerts and returns welcome")
        for failOld in [false,true] {
            let switched=Harness();let old=Outcome();let current=Outcome();let oldGate=Gate();var prepared=false
            ReelBackend.nextGate=oldGate
            switched.open(first,completion:old.receive,prepare:{_ in prepared=true});await drain()
            ReelBackend.nextGate=nil
            switched.open(newer,completion:current.receive);await drain()
            let newBackend=switched.backend;let closeCount=switched.closes
            oldGate.finish(failOld ? TestFailure():nil);await drain()
            expect(old.calls==1 && old.cancelled,"stale startup completes waiter as cancellation")
            expect(current.calls==1 && current.succeeded,"new startup succeeded")
            expect(switched.backend===newBackend && switched.folder==newer && switched.closes==closeCount,"stale completion never closes newer session")
            expect(switched.error==nil && switched.webView.loads==1 && !prepared,"stale completion cannot error/load/prepare a newer project")
        }
        // Same URL is also a new backend generation, not permission to close its replacement.
        let same=Harness();let oldSame=Outcome();let sameGate=Gate();ReelBackend.nextGate=sameGate
        same.open(first,completion:oldSame.receive);await drain();ReelBackend.nextGate=nil;same.open(first);await drain()
        let sameBackend=same.backend;sameGate.finish(TestFailure());await drain()
        expect(oldSame.cancelled && same.backend===sameBackend && same.folder==first,"same-folder replacement is identity-guarded")
        let duringRefresh=Harness();let refreshOutcome=Outcome()
        duringRefresh.nativeEditor.onRefresh={duringRefresh.nativeEditor.onRefresh=nil;duringRefresh.open(newer)}
        duringRefresh.open(first,completion:refreshOutcome.receive);await drain()
        expect(refreshOutcome.calls==1 && refreshOutcome.cancelled && duringRefresh.folder==newer,"replacement during refresh completes stale waiter")
        expect(duringRefresh.documentRefreshes==1 && duringRefresh.webView.loads==1,"stale refresh cannot install document or page")
        print("First-run actual creation/core/filesystem + welcome/open-lifecycle assertions passed: \(assertions)")
    }
}
'''
swift=swift.replace('    // EXTRACTED OPEN',legacy_opening+'\n'+opening).replace('    // EXTRACTED LEGACY CREATE',legacy_creation).replace('    // EXTRACTED PAGE DRAIN',page_drain)
with tempfile.TemporaryDirectory(prefix='arya-first-run-') as tmp:
    tmp=Path(tmp)
    bundled=tmp/'reel-core.js'
    subprocess.run(['node',str(repo/'native/scripts/bundle-core.mjs'),'--out',str(bundled)],check=True,cwd=repo)
    fixture=tmp/'first-run.swift'
    recovery=(repo/'native/ReelKit/Sources/ReelKit/NativeProjectRecovery.swift').read_text()
    recovery_types=method(recovery,'public struct NativeProjectRecoveryChoice')+'\n'+method(recovery,'public struct NativeProjectRecoveryOffer')
    fixture.write_text(creation+'\n'+policy+'\n'+recovery_types+'\n'+recovery_request+'\n'+swift)
    binary=tmp/'first-run-tests'
    subprocess.run(['swiftc','-j1','-module-cache-path',str(tmp/'module-cache'),'-parse-as-library','-o',str(binary),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(repo/'native/ReelKit/Sources/ReelKit/ReelCore.swift'),str(fixture)],check=True,cwd=repo)
    scratch=tmp/'documents';scratch.mkdir()
    subprocess.run([str(binary),str(bundled),str(scratch)],check=True,cwd=repo)
