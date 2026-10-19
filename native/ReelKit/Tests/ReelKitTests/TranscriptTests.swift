import Foundation
import Darwin
import Speech
@testable import ReelKit
import XCTest

final class TranscriptTests: XCTestCase {
    func makeBackend(transcribe: @escaping ReelBackend.TranscriptRecognizer = { _,_,_,_ in throw ReelBackend.APIError("Unexpected live recognition") }) async throws -> (ReelBackend, ProjectFolder) {
        let root = try Support.tempFolder("transcript"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: root.appendingPathComponent("media/talk.mp4"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), transcribe: transcribe) { _,_ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/import", body: "{\"paths\":[\"media/talk.mp4\"]}")
        return (backend, folder)
    }
    let words: [[String: Any]] = [["t":0.1,"end":0.3,"text":"Hello"],["t":0.4,"end":0.7,"text":"world."]]

    func testLocaleValidationRejectsMalformedInputAndCanonicalizesTags() async throws {
        for invalid in ["@", "", "-", "en--US", "en-US-US", "en@calendar=gregorian", "en-variant-variant", String(repeating: "a", count: 65)] {
            XCTAssertThrowsError(try NativeTranscriptStore.localeID(invalid), invalid)
        }
        XCTAssertEqual(try NativeTranscriptStore.localeID("EN_us"), "en-US")
        XCTAssertEqual(try NativeTranscriptStore.localeID("zh_hant_tw"), "zh-Hant-TW")
        XCTAssertEqual(try NativeTranscriptStore.localeID("es_419"), "es-419")
        let (backend, _) = try await makeBackend()
        defer { Task { await backend.stop() } }
        do {
            _ = try await backend.handle(method: "GET", path: "/api/transcript?src=media/talk.mp4&locale=%40", body: nil)
            XCTFail("Accepted a malformed locale")
        } catch { XCTAssertTrue(error.localizedDescription.contains("language tag")) }
    }

    func testStaleCorrectionsAreRejectedButFreshRecognitionReplacesThem() async throws {
        let recognized = JSON(any: ["words": [["t": 0.1, "end": 0.3, "text": "Replacement"]], "status": "complete"])
        let (backend, folder) = try await makeBackend { _, _, _, _ in recognized }
        defer { Task { await backend.stop() } }
        _ = try NativeTranscriptStore.save(src: "media/talk.mp4", locale: "en-US", words: words, expectedRevision: 0, folder: folder)
        let transcriptFile = try NativeTranscriptStore.file(src: "media/talk.mp4", locale: "en-US", folder: folder)
        let before = try Data(contentsOf: transcriptFile)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(100)], ofItemAtPath: folder.resolve("media/talk.mp4").path)
        for revision in [Optional(1), nil] {
            XCTAssertThrowsError(try NativeTranscriptStore.save(src: "media/talk.mp4", locale: "en-US", words: words, expectedRevision: revision, folder: folder)) { error in
                XCTAssertTrue(error.localizedDescription.contains("source changed"))
            }
            XCTAssertEqual(try Data(contentsOf: transcriptFile), before)
        }
        let result = parse(try await backend.handle(method: "POST", path: "/api/analyze", body: "{\"src\":\"media/talk.mp4\",\"locale\":\"en-US\",\"kind\":\"transcript\"}").text)
        XCTAssertEqual(result["revision"] as? Int, 2)
        XCTAssertEqual(result["status"] as? String, "complete")
        XCTAssertEqual(object((result["words"] as? [Any])?.first)["text"] as? String, "Replacement")
        let reloaded = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(reloaded["status"] as? String, "complete")
    }

    func testDurableCorrectionsLocaleRevisionAndLinkedOutputProtection() async throws {
        let (backend, folder) = try await makeBackend()
        defer { Task { await backend.stop() } }
        let saved = parse(try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any:["src":"media/talk.mp4","locale":"en-US","words":words,"revision":0]).text).text)
        XCTAssertEqual(saved["revision"] as? Int, 1)
        let reloaded = parse(try await backend.handle(method:"GET",path:"/api/transcript?src=media/talk.mp4&locale=en-US",body:nil).text)
        XCTAssertEqual(object((reloaded["words"] as? [Any])?.first)["text"] as? String,"Hello")
        let other = parse(try await backend.handle(method:"GET",path:"/api/transcript?src=media/talk.mp4&locale=fr-FR",body:nil).text)
        XCTAssertEqual(other["revision"] as? Int,0)
        do { _ = try await backend.handle(method:"POST",path:"/api/transcript",body:JSON(any:["src":"media/talk.mp4","locale":"en-US","words":words,"revision":0]).text); XCTFail("Accepted stale revision") } catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
        let before = try Data(contentsOf: folder.projectFile)
        let target = try NativeTranscriptStore.file(src:"media/talk.mp4",locale:"en-US",folder:folder)
        try FileManager.default.removeItem(at:target)
        try FileManager.default.createSymbolicLink(at:target,withDestinationURL:folder.projectFile)
        do { _ = try NativeTranscriptStore.save(src:"media/talk.mp4",locale:"en-US",words:words,expectedRevision:nil,folder:folder); XCTFail("Accepted linked transcript") } catch { }
        XCTAssertEqual(try Data(contentsOf:folder.projectFile),before)
    }

    func testBrowserNativeCorrectionsSurviveProjectCopyAndSourceChanges() async throws {
        let (_, folder) = try await makeBackend()
        try setExactModificationTime(folder.resolve("media/talk.mp4"), seconds: 1_800_000_000, nanoseconds: 123_456_300)
        let locale = try NativeTranscriptStore.localeID("en_US")
        XCTAssertEqual(locale,"en-US")
        _ = try NativeTranscriptStore.save(src:"media/talk.mp4",locale:locale,words:words,expectedRevision:0,metadata:["status":"partial","onDevice":true,"provider":"apple-speech","warnings":["Review ending"]],folder:folder)
        let repo = Support.nativeDir.deletingLastPathComponent()
        let script = """
        import {pathToFileURL} from 'node:url'; import path from 'node:path';
        const {createTranscriptRoutes}=await import(pathToFileURL(path.join(process.argv[2],'editor/routes/transcript.mjs')));
        const root=process.argv[1], routes=createTranscriptRoutes({root,resolveMedia:src=>path.join(root,src),getProject:()=>({assets:{'media/talk.mp4':{duration:120,hasAudio:true}}}),getVersion:()=>1});
        const first=routes.get({},new URLSearchParams({src:'media/talk.mp4',locale:'en-US'}));
        if(first.words[0]?.text!=='Hello'||first.revision!==1)throw new Error(JSON.stringify(first));
        const second=routes.save({src:'media/talk.mp4',locale:'en-US',revision:1,words:[{t:.1,end:.3,text:'Corrected'}]});
        console.log(JSON.stringify(second));
        """
        let node=Process(); node.executableURL=URL(fileURLWithPath:ProcessInfo.processInfo.environment["NODE"] ?? "/opt/homebrew/bin/node"); node.arguments=["--input-type=module","-e",script,folder.root.path,repo.path]
        let output=Pipe(); node.standardOutput=output; node.standardError=output
        try node.run(); node.waitUntilExit()
        let text=String(data:output.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? ""
        XCTAssertEqual(node.terminationStatus,0,text)
        let native=parse(try NativeTranscriptStore.read(src:"media/talk.mp4",locale:locale,folder:folder).text)
        XCTAssertEqual(native["revision"] as? Int,2); XCTAssertEqual(native["status"] as? String,"partial")
        XCTAssertEqual(native["provider"] as? String,"apple-speech"); XCTAssertEqual(native["onDevice"] as? Bool,true)
        XCTAssertEqual(object((native["words"] as? [Any])?.first)["text"] as? String,"Corrected")
        let destination=try Support.tempFolder("copy").appendingPathComponent("moved")
        try FileManager.default.copyItem(at:folder.root,to:destination)
        let copied=ProjectFolder(root:destination)
        let relocated=parse(try NativeTranscriptStore.read(src:"media/talk.mp4",locale:locale,folder:copied).text)
        XCTAssertEqual(relocated["status"] as? String,"partial"); XCTAssertEqual(relocated["revision"] as? Int,2)
        let source=try copied.resolve("media/talk.mp4")
        try FileManager.default.setAttributes([.modificationDate:Date().addingTimeInterval(100)],ofItemAtPath:source.path)
        let stale=parse(try NativeTranscriptStore.read(src:"media/talk.mp4",locale:locale,folder:copied).text)
        XCTAssertEqual(stale["status"] as? String,"stale"); XCTAssertEqual(stale["revision"] as? Int,2); XCTAssertEqual((stale["words"] as? [Any])?.count,0)
    }

    func testExactFingerprintPreservesBothRuntimeWritesAtRoundingBoundaries() throws {
        for (seconds,nanos) in [(1_800_000_000,123_456_300),(1_800_000_000,123_456_499),(1_800_000_000,999_999_500),(-1,999_999_500)] {
            let root=try Support.tempFolder("timestamp-\(seconds)-\(nanos)"),folder=ProjectFolder(root:root),source=root.appendingPathComponent("media/talk.wav")
            try FileManager.default.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
            try Data([1,2,3]).write(to:source)
            try setExactModificationTime(source,seconds:seconds,nanoseconds:nanos)
            let saved=parse(try NativeTranscriptStore.save(src:"media/talk.wav",locale:"en-US",words:words,expectedRevision:0,folder:folder).text)
            XCTAssertEqual(saved["fingerprint"] as? String,"v2|3|\(seconds)|\(nanos)")
            let node=try nodeTranscript(root:root,script:"""
            const first=routes.get({},query);
            if(first.words[0]?.text!=='Hello'||first.revision!==1)throw new Error(JSON.stringify(first));
            console.log(JSON.stringify(routes.save({src:'media/talk.wav',locale:'en-US',revision:1,words:[{t:.1,end:.3,text:'Node correction'}]})));
            """)
            XCTAssertEqual(node["revision"] as? Int,2)
            let native=parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:folder).text)
            XCTAssertEqual(object((native["words"] as? [Any])?.first)["text"] as? String,"Node correction")
            _=try NativeTranscriptStore.save(src:"media/talk.wav",locale:"en-US",words:[["t":0.1,"end":0.3,"text":"Swift correction"]],expectedRevision:2,folder:folder)
            let read=try nodeTranscript(root:root,script:"console.log(JSON.stringify(routes.get({},query))); ")
            XCTAssertEqual(read["revision"] as? Int,3)
            XCTAssertEqual(object((read["words"] as? [Any])?.first)["text"] as? String,"Swift correction")
            let destination=try Support.tempFolder("timestamp-copy").appendingPathComponent("moved")
            try FileManager.default.copyItem(at:root,to:destination)
            let copied=ProjectFolder(root:destination)
            let copy=parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:copied).text)
            XCTAssertEqual(copy["revision"] as? Int,3)
            XCTAssertEqual(copy["status"] as? String,"complete")
            XCTAssertEqual(try nodeTranscript(root:destination,script:"console.log(JSON.stringify(routes.get({},query))); ")["revision"] as? Int,3)
            try setExactModificationTime(copied.resolve("media/talk.wav"),seconds:seconds,nanoseconds:nanos+1)
            let stale=parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:copied).text)
            XCTAssertEqual(stale["status"] as? String,"stale")
            XCTAssertEqual(try nodeTranscript(root:destination,script:"console.log(JSON.stringify(routes.get({},query))); ")["status"] as? String,"stale")
        }
    }

    func testLegacyFingerprintsPreserveCorrectionsAndUpgradeOnlyOnSave() throws {
        for (legacy,nativeSave) in [("3|1800000000123.456",false),("3|1800000000123.457",true),("3|-0.001",false)] {
            let root=try Support.tempFolder("legacy-transcript"),folder=ProjectFolder(root:root),source=root.appendingPathComponent("media/talk.wav")
            try FileManager.default.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
            try Data([1,2,3]).write(to:source)
            let negative=legacy.contains("|-")
            try setExactModificationTime(source,seconds:negative ? -1:1_800_000_000,nanoseconds:negative ? 999_999_500:123_456_300)
            var saved=parse(try NativeTranscriptStore.save(src:"media/talk.wav",locale:"en-US",words:words,expectedRevision:0,metadata:["status":"partial","provider":"apple-speech","warnings":["Review ending"]],folder:folder).text)
            saved["fingerprint"]=legacy
            let record=try NativeTranscriptStore.file(src:"media/talk.wav",locale:"en-US",folder:folder),bytes=Data(JSON(any:saved).text.utf8)
            try bytes.write(to:record)
            XCTAssertEqual(parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:folder).text)["status"] as? String,"partial")
            XCTAssertEqual(try nodeTranscript(root:root,script:"console.log(JSON.stringify(routes.get({},query))); ")["status"] as? String,"partial")
            XCTAssertEqual(try Data(contentsOf:record),bytes)
            let upgraded: [String:Any]
            if nativeSave { upgraded=parse(try NativeTranscriptStore.save(src:"media/talk.wav",locale:"en-US",words:words,expectedRevision:1,folder:folder).text) }
            else { upgraded=try nodeTranscript(root:root,script:"console.log(JSON.stringify(routes.save({src:'media/talk.wav',locale:'en-US',revision:1,words:[{t:.1,end:.3,text:'Corrected legacy'}]}))); ") }
            XCTAssertEqual(upgraded["revision"] as? Int,2)
            XCTAssertEqual(upgraded["status"] as? String,"partial")
            XCTAssertEqual(upgraded["provider"] as? String,"apple-speech")
            XCTAssertTrue((upgraded["fingerprint"] as? String)?.hasPrefix("v2|")==true)
            XCTAssertEqual(parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:folder).text)["revision"] as? Int,2)
            XCTAssertEqual(try nodeTranscript(root:root,script:"console.log(JSON.stringify(routes.get({},query))); ")["revision"] as? Int,2)
        }
    }

    func testLegacyFingerprintCompatibilityStopsAtOneMicrosecondAndRejectsMalformedRecords() throws {
        let root=try Support.tempFolder("legacy-limits"),folder=ProjectFolder(root:root),source=root.appendingPathComponent("media/talk.wav")
        try FileManager.default.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data([1,2,3]).write(to:source)
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_000)
        var fields=parse(try NativeTranscriptStore.save(src:"media/talk.wav",locale:"en-US",words:words,expectedRevision:0,folder:folder).text)
        let record=try NativeTranscriptStore.file(src:"media/talk.wav",locale:"en-US",folder:folder)
        func assertStatus(_ expected:String) throws {
            XCTAssertEqual(parse(try NativeTranscriptStore.read(src:"media/talk.wav",locale:"en-US",folder:folder).text)["status"] as? String,expected)
            XCTAssertEqual(try nodeTranscript(root:root,script:"console.log(JSON.stringify(routes.get({},query))); ")["status"] as? String,expected)
        }
        fields["fingerprint"]="3|1800000000123.457"
        let legacy=Data(JSON(any:fields).text.utf8);try legacy.write(to:record)
        try assertStatus("complete")
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_455_999)
        try assertStatus("stale")
        try Data([4,5,6]).write(to:source)
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_656_300)
        try assertStatus("stale")
        XCTAssertEqual(try Data(contentsOf:record),legacy)
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_300)
        for malformed in ["03|1800000000123.457","3|1800000000123.457\n","3|1800000000123.45","3|1800000000123.4570","3|NaN","v2|3|1800000000|123456301","v3|3|1800000000|123456300"] {
            fields["fingerprint"]=malformed
            try Data(JSON(any:fields).text.utf8).write(to:record)
            try assertStatus("stale")
        }
    }

    private func setExactModificationTime(_ file:URL,seconds:Int,nanoseconds:Int) throws {
        var times=[timespec(tv_sec:seconds,tv_nsec:nanoseconds),timespec(tv_sec:seconds,tv_nsec:nanoseconds)]
        guard file.path.withCString({Darwin.utimensat(AT_FDCWD,$0,&times,0)})==0 else {throw NSError(domain:NSPOSIXErrorDomain,code:Int(errno))}
    }

    private func nodeTranscript(root:URL,script:String) throws -> [String:Any] {
        let repo=Support.nativeDir.deletingLastPathComponent()
        let preamble="""
        import {pathToFileURL} from 'node:url'; import path from 'node:path';
        const {createTranscriptRoutes}=await import(pathToFileURL(path.join(process.argv[2],'editor/routes/transcript.mjs')));
        const root=process.argv[1], routes=createTranscriptRoutes({root,resolveMedia:src=>path.join(root,src),getProject:()=>({assets:{'media/talk.wav':{duration:120,hasAudio:true}}}),getVersion:()=>1});
        const query=new URLSearchParams({src:'media/talk.wav',locale:'en-US'});
        """
        let node=Process();node.executableURL=URL(fileURLWithPath:ProcessInfo.processInfo.environment["NODE"] ?? "/opt/homebrew/bin/node");node.arguments=["--input-type=module","-e",preamble+script,root.path,repo.path]
        let output=Pipe(),diagnostics=Pipe();node.standardOutput=output;node.standardError=diagnostics
        try node.run();node.waitUntilExit()
        let text=String(data:output.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? ""
        let errors=String(data:diagnostics.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? ""
        guard node.terminationStatus==0 else {throw ReelBackend.APIError(text+errors)}
        return parse(text)
    }

    func testAsyncCachedTranscriptAndNestedCaptionJobResultUndo() async throws {
        let (backend, _) = try await makeBackend()
        defer { Task { await backend.stop() } }
        _ = try await backend.handle(method:"POST",path:"/api/transcript",body:JSON(any:["src":"media/talk.mp4","locale":"en-US","words":words]).text)
        _ = try await backend.editOperations(ops:.array([.object([("op","add_comp"),("name","Nested")]),.object([("op","add_clip"),("comp","k1"),("src","media/talk.mp4"),("start",2),("dur",1)])]))
        let job = parse(try await backend.handle(method:"POST",path:"/api/captions/from-transcript",body:"{\"src\":\"media/talk.mp4\",\"locale\":\"en-US\",\"comp\":\"k1\",\"id\":\"c1\",\"style\":\"karaoke\",\"apply\":true,\"wait\":false}").text)
        let id = try XCTUnwrap(job["id"] as? String)
        let terminal = parse(try await backend.handle(method:"GET",path:"/api/analysis/jobs/wait?id=\(id)&timeout=2000",body:nil).text)
        XCTAssertEqual(terminal["state"] as? String,"done",terminal.description)
        XCTAssertEqual(object(terminal["result"])["applied"] as? Bool,true)
        let projectText = await backend.currentProject()
        let project = parse(try XCTUnwrap(projectText))
        XCTAssertFalse((project["tracks"] as? [[String:Any]] ?? []).contains { $0["kind"] as? String == "caption" })
        let nested = object(object(project["comps"])["k1"])
        let track = (nested["tracks"] as? [[String:Any]] ?? []).first { $0["kind"] as? String == "caption" }
        XCTAssertEqual(object(track?["style"])["preset"] as? String,"karaoke")
        let cue = object((track?["clips"] as? [Any])?.first)
        XCTAssertEqual(cue["start"] as? Double,2.1)
        XCTAssertEqual(object((cue["words"] as? [Any])?.first)["t"] as? Double,0)
        _ = try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
        let undoneText = await backend.currentProject()
        let undone = parse(try XCTUnwrap(undoneText))
        XCTAssertFalse((object(object(undone["comps"])["k1"])["tracks"] as? [[String:Any]] ?? []).contains { $0["kind"] as? String == "caption" })
    }

    func testCancelledRecognitionCannotSaveOrCommitCaptions() async throws {
        let gate = TranscriptGate(), payload = JSON(any:["words":words,"status":"complete","onDevice":true])
        let (backend,folder) = try await makeBackend { _,_,_,_ in await gate.wait(); return payload }
        defer { Task { await backend.stop() } }
        _ = try await backend.editOperations(ops:.array([.object([("op","add_clip"),("src","media/talk.mp4"),("dur",1)])]))
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let job = parse(try await backend.handle(method:"POST",path:"/api/captions/from-transcript",body:"{\"src\":\"media/talk.mp4\",\"locale\":\"en-US\",\"id\":\"c1\",\"apply\":true,\"wait\":false}").text)
        for _ in 0..<100 { if await gate.entered { break }; try await Task.sleep(nanoseconds:10_000_000) }
        let id = try XCTUnwrap(job["id"] as? String)
        _ = try await backend.handle(method:"POST",path:"/api/jobs/cancel",body:JSON(any:["id":id]).text)
        await gate.release(); try await Task.sleep(nanoseconds:30_000_000)
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(before,after); XCTAssertEqual(version,afterVersion)
        let saved = parse(try NativeTranscriptStore.read(src:"media/talk.mp4",locale:"en-US",folder:folder).text)
        XCTAssertEqual(saved["revision"] as? Int,0)
        let result = parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(id)&timeout=0",body:nil).text)
        XCTAssertEqual(result["state"] as? String,"failed"); XCTAssertEqual(result["error"] as? String,"cancelled")
    }

    func testSourceNanosecondChangeDuringRecognitionCannotSaveDurableWords() async throws {
        let gate=TranscriptGate(),payload=JSON(any:["words":[["t":0.1,"end":0.3,"text":"Old recognition"]],"status":"complete"])
        let (backend,folder)=try await makeBackend { _,_,_,_ in await gate.wait();return payload }
        defer { Task {await backend.stop()} }
        let source=try folder.resolve("media/talk.mp4")
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_300)
        _=try NativeTranscriptStore.save(src:"media/talk.mp4",locale:"en-US",words:words,expectedRevision:0,folder:folder)
        let record=try NativeTranscriptStore.file(src:"media/talk.mp4",locale:"en-US",folder:folder),before=try Data(contentsOf:record)
        let project=await backend.currentProject(),version=await backend.currentVersion(),original=try Data(contentsOf:source)
        let roundedBefore=try ProjectFolder.cacheKey(source,"transcript-source")
        let job=parse(try await backend.handle(method:"POST",path:"/api/analyze",body:#"{"src":"media/talk.mp4","locale":"en-US","kind":"transcript","force":true,"wait":false}"#).text)
        for _ in 0..<100 { if await gate.entered {break};try await Task.sleep(nanoseconds:10_000_000) }
        let entered=await gate.entered
        XCTAssertTrue(entered)
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_301)
        XCTAssertEqual(try ProjectFolder.cacheKey(source,"transcript-source"),roundedBefore)
        await gate.release()
        let id=try XCTUnwrap(job["id"] as? String)
        let final=parse(try await backend.handle(method:"GET",path:"/api/jobs/wait?id=\(id)&timeout=2000",body:nil).text)
        XCTAssertEqual(final["state"] as? String,"failed")
        XCTAssertTrue((final["error"] as? String)?.contains("source changed")==true)
        XCTAssertEqual(try Data(contentsOf:record),before)
        let read=parse(try NativeTranscriptStore.read(src:"media/talk.mp4",locale:"en-US",folder:folder).text)
        XCTAssertEqual(read["status"] as? String,"stale");XCTAssertEqual(read["revision"] as? Int,1)
        let after=await backend.currentProject(),afterVersion=await backend.currentVersion()
        XCTAssertEqual(after,project);XCTAssertEqual(afterVersion,version)
        XCTAssertEqual(try Data(contentsOf:source),original)
    }

    func testForcedRecognitionBypassesCompleteRawCacheWithoutDeletingIt() throws {
        let root = try Support.tempFolder("forced-raw-speech-cache"), folder = ProjectFolder(root: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("media/talk.wav"), locale = Locale(identifier: "en-US")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: file)
        let source = try NativeTranscriptStore.sourceIdentity(file.path, folder: folder)
        let cache = try Transcriber.cacheFile(file: file, cacheDir: folder.cacheDir, locale: locale, allowServer: false, folder: folder)
        try FileManager.default.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = Data(JSON(any: ["locale": locale.identifier, "words": words, "status": "complete"]).text.utf8)
        try bytes.write(to: cache)
        let cached = try XCTUnwrap(Transcriber.readCachedTranscript(out: cache, file: file, source: source, locale: locale, force: false, folder: folder))
        XCTAssertEqual(object((parse(cached.text)["words"] as? [Any])?.first)["text"] as? String, "Hello")
        XCTAssertNil(try Transcriber.readCachedTranscript(out: cache, file: file, source: source, locale: locale, force: true, folder: folder))
        XCTAssertEqual(try Data(contentsOf: cache), bytes)
        XCTAssertEqual(try Data(contentsOf: file), Data([1, 2, 3]))
    }

    func testForcedTranscriptRequestUsesInjectedRecognizerAndReplacesSavedWords() async throws {
        let fresh = JSON(any: ["words": [["t": 0.1, "end": 0.3, "text": "Fresh recognition"]], "status": "complete"])
        let (backend, folder) = try await makeBackend { _, locale, allowServer, _ in
            XCTAssertEqual(locale.identifier, "en-US"); XCTAssertFalse(allowServer)
            return fresh
        }
        defer { Task { await backend.stop() } }
        _ = try NativeTranscriptStore.save(src: "media/talk.mp4", locale: "en-US", words: words, expectedRevision: 0, folder: folder)
        let project = await backend.currentProject(), version = await backend.currentVersion()
        let file = try folder.resolve("media/talk.mp4"), sourceBytes = try Data(contentsOf: file)
        let ordinary = parse(try await backend.handle(method: "POST", path: "/api/analyze", body: #"{"src":"media/talk.mp4","locale":"en-US","kind":"transcript"}"#).text)
        XCTAssertEqual(object((ordinary["words"] as? [Any])?.first)["text"] as? String, "Hello")
        let forced = parse(try await backend.handle(method: "POST", path: "/api/analyze", body: #"{"src":"media/talk.mp4","locale":"en-US","kind":"transcript","force":true}"#).text)
        XCTAssertEqual(object((forced["words"] as? [Any])?.first)["text"] as? String, "Fresh recognition")
        XCTAssertEqual(forced["revision"] as? Int, 2)
        let reopened = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(object((reopened["words"] as? [Any])?.first)["text"] as? String, "Fresh recognition")
        let afterProject = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(afterProject, project); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try Data(contentsOf: file), sourceBytes)
    }

    func testRawSpeechCacheMissesExactSourceChangeWithoutRequestingPermission() async throws {
        let root=try Support.tempFolder("raw-speech-cache"),folder=ProjectFolder(root:root),source=root.appendingPathComponent("media/talk.wav"),locale=Locale(identifier:"en-US")
        try FileManager.default.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data([1,2,3]).write(to:source)
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_300)
        let cache=try Transcriber.cacheFile(file:source,cacheDir:folder.cacheDir,locale:locale,allowServer:false,folder:folder)
        try FileManager.default.createDirectory(at:cache.deletingLastPathComponent(),withIntermediateDirectories:true)
        let cached=JSON(any:["locale":locale.identifier,"words":words,"status":"complete"]),bytes=Data(cached.text.utf8)
        try bytes.write(to:cache)
        let hit=parse(try await Transcriber.transcribe(file:source,cacheDir:folder.cacheDir,locale:locale,projectFolder:folder).text)
        XCTAssertEqual(object((hit["words"] as? [Any])?.first)["text"] as? String,"Hello")
        let roundedBefore=try ProjectFolder.cacheKey(source,"speech-v2",locale.identifier,"on-device")
        try setExactModificationTime(source,seconds:1_800_000_000,nanoseconds:123_456_301)
        XCTAssertEqual(try ProjectFolder.cacheKey(source,"speech-v2",locale.identifier,"on-device"),roundedBefore)
        let changed=try Transcriber.cacheFile(file:source,cacheDir:folder.cacheDir,locale:locale,allowServer:false,folder:folder)
        XCTAssertNotEqual(changed,cache)
        let work=Task { () throws -> JSON in
            withUnsafeCurrentTask {$0?.cancel()}
            return try await Transcriber.transcribe(file:source,cacheDir:folder.cacheDir,locale:locale,projectFolder:folder)
        }
        do {_=try await work.value;XCTFail("source change reused old raw speech cache")}
        catch is CancellationError {} catch {XCTFail("unexpected error \(error)")}
        XCTAssertFalse(FileManager.default.fileExists(atPath:changed.path))
        XCTAssertEqual(try Data(contentsOf:cache),bytes)
    }

    func testSuspendedRawSpeechPublicationRejectsNanosecondAndResolvedPathChanges() async throws {
        for changePath in [false,true] {
            let root=try Support.tempFolder("raw-publication"),folder=ProjectFolder(root:root),media=root.appendingPathComponent("media")
            try FileManager.default.createDirectory(at:media,withIntermediateDirectories:true)
            let original=media.appendingPathComponent("original.wav"),replacement=media.appendingPathComponent("replacement.wav"),input=media.appendingPathComponent("input.wav")
            try Data([1,2,3]).write(to:original);try Data([4,5,6]).write(to:replacement)
            for file in [original,replacement] {try setExactModificationTime(file,seconds:1_800_000_000,nanoseconds:123_456_300)}
            try FileManager.default.createSymbolicLink(at:input,withDestinationURL:original)
            let source=try NativeTranscriptStore.sourceIdentity(input.path,folder:folder),cache=try Transcriber.cacheFile(file:input,cacheDir:folder.cacheDir,locale:Locale(identifier:"en-US"),allowServer:false,folder:folder)
            let gate=TranscriptGate(),payload=JSON(any:["locale":"en-US","words":words,"status":"complete"])
            let work=Task { () throws -> JSON in
                await gate.wait()
                return try Transcriber.publish(payload,to:cache,file:input,source:source,folder:folder)
            }
            for _ in 0..<100 {if await gate.entered {break};try await Task.sleep(nanoseconds:10_000_000)}
            let entered=await gate.entered;XCTAssertTrue(entered)
            if changePath {
                try FileManager.default.removeItem(at:input)
                try FileManager.default.createSymbolicLink(at:input,withDestinationURL:replacement)
            } else {try setExactModificationTime(original,seconds:1_800_000_000,nanoseconds:123_456_301)}
            await gate.release()
            do {_=try await work.value;XCTFail("changed raw recognition was published")}
            catch {XCTAssertTrue(error.localizedDescription.contains("source changed"))}
            XCTAssertFalse(FileManager.default.fileExists(atPath:cache.path))
            XCTAssertEqual(try Data(contentsOf:original),Data([1,2,3]))
            XCTAssertEqual(try Data(contentsOf:replacement),Data([4,5,6]))
        }
    }

    func testWindowBoundariesDeduplicateOverlapAndReportPartial() async throws {
        let log = WindowLog()
        let result = try await Transcriber.transcribeWindows(file:URL(fileURLWithPath:"/unused"),duration:100,locale:"en-US",onDevice:true) { _,from,length in
            await log.add(from,length)
            if from > 80 { throw ReelBackend.APIError("Fixture failure") }
            return .init(words:[.init(t:0.6,end:0.8,text:"word")])
        }
        let ranges = await log.items
        XCTAssertEqual(ranges.count,3); XCTAssertTrue(ranges.allSatisfy { $0.1 <= 46 })
        let fields = parse(result.text)
        XCTAssertEqual(fields["status"] as? String,"partial"); XCTAssertEqual((fields["words"] as? [Any])?.count,2)
        let windows = try Transcriber.windows(duration:14_400)
        XCTAssertEqual(windows.count,320); XCTAssertThrowsError(try Transcriber.windows(duration:14_401))
    }

    func testSpeechCompletionCancellationBeforeRegistrationAndTimeout() async throws {
        let gate = SpeechCompletion(); gate.cancel()
        do { let _:Transcriber.Segment = try await withCheckedThrowingContinuation { gate.install($0); gate.finishWords() }; XCTFail("Cancellation lost") } catch { XCTAssertTrue(error is CancellationError) }
        let timeout = SpeechCompletion(); timeout.setWords([.init(t:0,end:1,text:"partial")])
        let result = try await withCheckedThrowingContinuation { timeout.install($0); timeout.scheduleTimeout(seconds:0.01) }
        XCTAssertTrue(result.partial); XCTAssertTrue(result.warning?.contains("timed out") == true)
    }

    func testAuthorizationCancellationTimeoutAndLateReplies() async throws {
        let cancelled = SpeechAuthorizationCompletion()
        cancelled.complete(.failure(CancellationError()))
        do {
            let _: SFSpeechRecognizerAuthorizationStatus = try await withCheckedThrowingContinuation { cancelled.install($0) }
            XCTFail("Cancellation before registration was lost")
        } catch { XCTAssertTrue(error is CancellationError) }
        cancelled.complete(.success(.authorized))

        let pending = AuthorizationRequests()
        let task = Task { try await Transcriber.requestAuthorization(request: { pending.add($0) }) }
        for _ in 0..<100 { if pending.count == 1 { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(pending.count, 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("A cancelled permission wait completed") }
        catch { XCTAssertTrue(error is CancellationError) }
        pending.reply(.authorized)

        let timedOut = AuthorizationRequests()
        do {
            _ = try await Transcriber.requestAuthorization(timeout: 0.01, request: { timedOut.add($0) })
            XCTFail("A withheld permission reply never timed out")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Speech permission request timed out")) }
        timedOut.reply(.denied)
    }

    func testAuthorizationReplyAndCancellationRaceCompletesOnce() async throws {
        for _ in 0..<64 {
            let gate = SpeechAuthorizationCompletion()
            let task = Task { try await withCheckedThrowingContinuation { gate.install($0) } }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { gate.complete(.success(.authorized)) }
                group.addTask { gate.complete(.failure(CancellationError())) }
            }
            do { let reply = try await task.value; XCTAssertEqual(reply, .authorized) }
            catch { XCTAssertTrue(error is CancellationError) }
            gate.complete(.success(.denied))
        }
        let granted = try await Transcriber.requestAuthorization(timeout: 0.01, request: { $0(.authorized) })
        XCTAssertEqual(granted, .authorized)
    }

    func testCancelledAuthorizationWorkersReleaseAllAnalysisSlots() async throws {
        let requests = AuthorizationRequests()
        let admission = NativeProcessingAdmission(capturedByteLimit: 64 * 1024 * 1024)
        let root = try Support.tempFolder("transcript-admission"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: folder.mediaDir.appendingPathComponent("talk.mp4"))
        let core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: core.newProject(name: "Authorization cancellation"), ops: JSON(any: [[
            "op": "import", "assets": ["media/talk.mp4": ["kind": "video", "duration": 1, "hasAudio": true, "hasVideo": true]]
        ]]).text).project
        // Seed the imported project before startup so thumbnail work cannot consume a fixture slot.
        try Data(core.fileText(project: project).utf8).write(to: folder.projectFile)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), transcribe: { _, _, _, _ in
            defer { requests.didExit() }
            _ = try await Transcriber.requestAuthorization(request: { requests.add($0) })
            return JSON(any: ["words": [["t": 0.1, "end": 0.3, "text": "Late"]], "status": "complete"])
        }, processingAdmission: admission, events: { _, _ in })
        try await backend.start()
        defer { Task { await backend.stop() } }
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let source = try folder.resolve("media/talk.mp4"), sourceBytes = try Data(contentsOf: source)
        let initialAdmission = admission.snapshot()
        XCTAssertEqual(initialAdmission.active + initialAdmission.queued, 0)
        var ids: [String] = []
        for _ in 0..<8 {
            let started = parse(try await backend.handle(method: "POST", path: "/api/analyze", body: "{\"src\":\"media/talk.mp4\",\"locale\":\"en-US\",\"kind\":\"transcript\",\"wait\":false}" ).text)
            ids.append(try XCTUnwrap(started["id"] as? String))
        }
        for _ in 0..<100 { if requests.count == 1 { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(requests.count, 1, "Only the active job may enter authorization")
        let occupied = admission.snapshot()
        XCTAssertEqual(occupied.active, 1); XCTAssertEqual(occupied.queued, 7)
        for (index, id) in ids.enumerated() {
            let job = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=0", body: nil).text)
            XCTAssertEqual(job["state"] as? String, index == 0 ? "running" : "queued")
        }
        // Cancel queued jobs first so none can enter authorization when the active job drains.
        for id in ids.dropFirst() { _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": try XCTUnwrap(ids.first)]).text)
        for id in ids {
            var receipt: [String: Any] = [:]
            for _ in 0..<100 {
                receipt = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=0", body: nil).text)
                if receipt["state"] as? String == "failed", receipt["draining"] as? Bool == false { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTAssertEqual(receipt["state"] as? String, "failed")
            XCTAssertEqual(receipt["error"] as? String, "cancelled")
            XCTAssertEqual(receipt["draining"] as? Bool, false, "Every canceled job must release its actual worker lease")
        }
        XCTAssertEqual(requests.count, 1, "Canceled queued jobs must not start authorization")
        XCTAssertEqual(requests.exited, 1, "The active authorization worker must exit without a system callback")
        let drained = admission.snapshot()
        XCTAssertEqual(drained.active, 0); XCTAssertEqual(drained.queued, 0)
        XCTAssertEqual(drained.capturedBytes, 0); XCTAssertEqual(drained.workerBytes, 0)
        let ninth = parse(try await backend.handle(method: "POST", path: "/api/analyze", body: "{\"src\":\"media/talk.mp4\",\"locale\":\"en-US\",\"kind\":\"transcript\",\"wait\":false}" ).text)
        let ninthID = try XCTUnwrap(ninth["id"] as? String, "Cancelled workers kept all analysis slots occupied")
        for _ in 0..<100 { if requests.count == 2 { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(requests.count, 2)
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": ninthID]).text)
        var ninthReceipt: [String: Any] = [:]
        for _ in 0..<100 {
            ninthReceipt = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(ninthID)&timeout=0", body: nil).text)
            if ninthReceipt["state"] as? String == "failed", ninthReceipt["draining"] as? Bool == false { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(ninthReceipt["state"] as? String, "failed")
        XCTAssertEqual(ninthReceipt["error"] as? String, "cancelled")
        XCTAssertEqual(ninthReceipt["draining"] as? Bool, false)
        XCTAssertEqual(requests.exited, 2)
        let finalAdmission = admission.snapshot()
        XCTAssertEqual(finalAdmission.active, 0); XCTAssertEqual(finalAdmission.queued, 0)
        XCTAssertEqual(finalAdmission.capturedBytes, 0); XCTAssertEqual(finalAdmission.workerBytes, 0)
        requests.reply(.authorized)
        try await Task.sleep(nanoseconds: 20_000_000)
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(before, after); XCTAssertEqual(version, afterVersion)
        let saved = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(saved["revision"] as? Int, 0)
        let savedFile = try NativeTranscriptStore.file(src: "media/talk.mp4", locale: "en-US", folder: folder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: savedFile.path))
        XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
    }

    func testBoundedDecodeUsesSelectedSourceRange() async throws {
        let folder = ProjectFolder(root:try Support.tempFolder("decode")), file=folder.root.appendingPathComponent("minute.wav")
        let rate=16000, count=rate*60
        let samples=(0..<count).map { Float($0 < rate*45 ? 0.1 : 0.3) }
        try NativeAudioProcessing.write(.init(channels:[samples],rate:rate),to:file)
        let tail = try await Transcriber.monoSamples(file:file,rate:Double(rate),from:45,duration:15)
        XCTAssertLessThanOrEqual(tail.count,rate*16); XCTAssertGreaterThan(tail.count,rate*14)
        XCTAssertEqual(Double(tail[100]),0.3,accuracy:0.0001)
    }
}

private final class AuthorizationRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [Transcriber.AuthorizationCallback] = []
    private var exitCount = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return replies.count }
    var exited: Int { lock.lock(); defer { lock.unlock() }; return exitCount }
    func add(_ reply: @escaping Transcriber.AuthorizationCallback) { lock.lock(); replies.append(reply); lock.unlock() }
    func didExit() { lock.lock(); exitCount += 1; lock.unlock() }
    func reply(_ status: SFSpeechRecognizerAuthorizationStatus) {
        lock.lock(); let pending = replies; replies.removeAll(); lock.unlock()
        for reply in pending { reply(status) }
    }
}

private actor TranscriptGate {
    var entered=false
    var continuation:CheckedContinuation<Void,Never>?
    func wait() async { entered=true; await withCheckedContinuation { continuation=$0 } }
    func release() { continuation?.resume(); continuation=nil }
}
private actor WindowLog { var items:[(Double,Double)]=[]; func add(_ from:Double,_ length:Double) { items.append((from,length)) } }
