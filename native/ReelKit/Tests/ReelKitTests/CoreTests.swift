import Foundation
@testable import ReelKit
import XCTest

/// The shared core gives the same answers in JavaScriptCore as in Node, byte for byte.
final class CoreParityTests: XCTestCase {
    var core: ReelCore!
    var parity: [String: Any]!

    override func setUpWithError() throws {
        core = try ReelCore(scriptURL: try Support.core())
        parity = parse(try String(contentsOf: Support.parity, encoding: .utf8))
    }

    func testOpsMatchNode() throws {
        let project = try XCTUnwrap(parity["project"] as? String)
        let cases = try XCTUnwrap(parity["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for c in cases {
            let ops = try XCTUnwrap(c["ops"] as? String)
            let expected = try XCTUnwrap(c["expected"] as? String, "Node failed on \(ops)")
            XCTAssertEqual(try core.applyOpsJSON(project: project, ops: ops), expected, ops)
            // The parts the backend stores are the same project text.
            let parts = try core.applyOps(project: project, ops: ops)
            XCTAssertEqual(parse(expected)["log"] as? [String], try JSON.parse(parts.log) as? [String])
            XCTAssertTrue(expected.hasPrefix("{\"project\":\(parts.project),"), ops)
        }
    }

    func testBadOpThrowsTheCoreMessage() throws {
        let failing = object(parity["failing"])
        XCTAssertThrowsError(try core.applyOps(project: parity["project"] as! String, ops: failing["ops"] as! String)) { error in
            XCTAssertEqual((error as? ReelCore.ScriptError)?.message, failing["error"] as? String)
        }
    }

    func testHelpersMatchNode() throws {
        let project = parity["project"] as! String
        XCTAssertEqual(try core.fileText(project: project), parity["fileText"] as? String)
        XCTAssertEqual(try core.outline(project: project), parity["outline"] as? String)
        XCTAssertEqual(try core.opsDoc(), parity["opsDoc"] as? String)
        XCTAssertEqual(try core.newProject(name: "Fresh", options: "{\"width\":1080,\"height\":1920,\"fps\":25}"), parity["newProject"] as? String)
        XCTAssertEqual(try core.migrate(fileText: "{\"version\":1,\"name\":\"Old\",\"width\":640,\"height\":360,\"fps\":24,\"tracks\":[]}"), parity["migrated"] as? String)
    }

    func testBridgeHelpers() throws {
        let project = parity["project"] as! String
        let ops = "[{\"op\":\"append\",\"src\":\"media/new.mp4\"},{\"op\":\"update\",\"id\":\"c1\",\"set\":{\"src\":\"media/a.mp4\"}}]"
        XCTAssertEqual(try core.unknownSources(project: project, ops: ops), ["media/new.mp4"])
        let withImport = try core.prependImport(ops: ops, assets: "{\"media/new.mp4\":{\"duration\":3}}")
        XCTAssertTrue(withImport.hasPrefix("[{\"op\":\"import\",\"assets\":{\"media/new.mp4\":{\"duration\":3}}},{\"op\":\"append\""))
        XCTAssertEqual(try core.field("{\"ops\":[1,2],\"who\":\"x\"}", "ops"), "[1,2]")
        XCTAssertEqual(try core.field("{}", "ops"), "null")
        XCTAssertEqual(try core.assetKeys(project: project).sorted(), ["media/a.mp4", "media/b.mp4", "media/m.m4a"])
        XCTAssertNotNil(try core.asset(project: project, src: "media/a.mp4"))
        XCTAssertNil(try core.asset(project: project, src: "nope.mp4"))
        let forgot = try core.forget(project: project, paths: "[\"media/b.mp4\"]")
        XCTAssertEqual(try core.assetKeys(project: forgot).sorted(), ["media/a.mp4", "media/m.m4a"])
        XCTAssertEqual(try core.duration(project: project), 0)
    }

    func testExpressionsRunWithoutJavaScript() throws {
        // Expressions are Reel's own language: JavaScript in one is refused, not run.
        let project = parity["project"] as! String
        let added = try core.applyOps(project: project, ops: "[{\"op\":\"add_title\",\"text\":\"x\",\"start\":0,\"dur\":1}]").project
        XCTAssertThrowsError(try core.applyOps(project: added, ops: "[{\"op\":\"expression\",\"id\":\"c1\",\"prop\":\"x\",\"expr\":\"globalThis.ReelCore = 1\"}]"))
    }
}

final class JSONTests: XCTestCase {
    func testSerialization() throws {
        let value = JSON.compact([
            ("s", .string("a\"b\\c\n\u{1}é")), ("i", 3), ("d", 0.1), ("neg", -2.5), ("big", .number(1e20)),
            ("b", true), ("n", .some(.null)), ("skip", nil), ("arr", [1, "x"]), ("raw", .raw("{\"k\":[1]}")),
        ])
        XCTAssertEqual(value.text, #"{"s":"a\"b\\c\n\u0001é","i":3,"d":0.1,"neg":-2.5,"big":1e+20,"b":true,"n":null,"arr":[1,"x"],"raw":{"k":[1]}}"#)
        let round = try JSONSerialization.jsonObject(with: Data(value.text.utf8)) as! [String: Any]
        XCTAssertEqual(round["s"] as? String, "a\"b\\c\n\u{1}é")
        XCTAssertEqual(JSON(any: try JSON.parse("{\"b\":[true,1.5,null],\"a\":\"x\"}")).text, "{\"a\":\"x\",\"b\":[true,1.5,null]}")
    }
}

final class ByteRangeTests: XCTestCase {
    func testParsing() {
        XCTAssertEqual(ByteRange(header: "bytes=0-99", size: 1000), ByteRange(header: "bytes=0-99", size: 1000))
        let r = ByteRange(header: "bytes=100-199", size: 1000)!
        XCTAssertEqual([r.start, r.end, r.length], [100, 199, 100])
        let open = ByteRange(header: "bytes=900-", size: 1000)!
        XCTAssertEqual([open.start, open.end], [900, 999])
        let suffix = ByteRange(header: "bytes=-10", size: 1000)!
        XCTAssertEqual([suffix.start, suffix.end], [990, 999])
        let clamped = ByteRange(header: "bytes=990-5000", size: 1000)!
        XCTAssertEqual(clamped.end, 999)
        XCTAssertNil(ByteRange(header: "bytes=1000-", size: 1000))
        XCTAssertNil(ByteRange(header: "bytes=5-2", size: 1000))
        XCTAssertNil(ByteRange(header: "items=0-1", size: 1000))
        XCTAssertNil(ByteRange(header: nil, size: 1000))
    }
}

final class ProjectFolderTests: XCTestCase {
    func testConfinement() throws {
        let root = try Support.tempFolder()
        let folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: root.appendingPathComponent("media/a.mp4").path, contents: Data([1]))
        XCTAssertEqual(folder.relative(try folder.resolve("media/a.mp4")), "media/a.mp4")
        XCTAssertEqual(folder.relative(try folder.resolve(root.appendingPathComponent("media/a.mp4").path)), "media/a.mp4")
        XCTAssertThrowsError(try folder.resolve("../outside.mp4"))
        XCTAssertThrowsError(try folder.resolve("media/../../outside.mp4"))
        XCTAssertThrowsError(try folder.resolve("/etc/hosts"))
        XCTAssertThrowsError(try folder.resolve(""))
        // A symbolic link inside the project that points outside it is refused too.
        let outside = try Support.tempFolder("elsewhere")
        FileManager.default.createFile(atPath: outside.appendingPathComponent("secret.txt").path, contents: Data("x".utf8))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: outside)
        XCTAssertThrowsError(try folder.resolve("link/secret.txt"))
    }

    func testNames() throws {
        XCTAssertEqual(ProjectFolder.cleanFileName("../../evil name?.mp4"), "evil name_.mp4")
        XCTAssertEqual(ProjectFolder.cleanFileName(".."), "upload.bin")
        let dir = try Support.tempFolder()
        FileManager.default.createFile(atPath: dir.appendingPathComponent("a.mp4").path, contents: nil)
        XCTAssertEqual(ProjectFolder.freeName(in: dir, for: "a.mp4").lastPathComponent, "a-1.mp4")
        XCTAssertTrue(ProjectFolder.isMedia("x.MOV"))
        XCTAssertFalse(ProjectFolder.isMedia("notes.txt"))
    }
}

final class EditorBundleTests: XCTestCase {
    func testResourcesAndPluginIndex() throws {
        let root = try Support.tempFolder("editor")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("web/ui/plugins"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("core"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("vendor/htm/dist"), withIntermediateDirectories: true)
        try Data("<html>".utf8).write(to: root.appendingPathComponent("web/index.html"))
        try Data("x".utf8).write(to: root.appendingPathComponent("web/ui/plugins/b.js"))
        try Data("x".utf8).write(to: root.appendingPathComponent("web/ui/plugins/a.js"))
        try Data("x".utf8).write(to: root.appendingPathComponent("core/project.js"))
        try Data("x".utf8).write(to: root.appendingPathComponent("vendor/htm/dist/htm.module.js"))
        let bundle = EditorBundle(root: root)
        XCTAssertEqual(bundle.pluginIndex(), "import './plugins/a.js'\nimport './plugins/b.js'\nexport const loaded = [\"a.js\",\"b.js\"]\n")
        guard case .file(let index, let type)? = bundle.resource(path: "/") else { return XCTFail("no index") }
        XCTAssertEqual(index.lastPathComponent, "index.html")
        XCTAssertEqual(type, "text/html; charset=utf-8")
        guard case .file(_, let js)? = bundle.resource(path: "/vendor/htm/dist/htm.module.js") else { return XCTFail("no vendor file") }
        XCTAssertEqual(js, "text/javascript; charset=utf-8")
        XCTAssertNotNil(bundle.resource(path: "/core/project.js"))
        XCTAssertNotNil(bundle.resource(path: "/core/../core/project.js")) // only the file name counts, as on the server
        XCTAssertNil(bundle.resource(path: "/vendor/../core/project.js"))
        XCTAssertNil(bundle.resource(path: "/../editor/web/index.html"))
        XCTAssertNil(bundle.resource(path: "/missing.js"))
        // No plugins folder: an empty index, like the Node server's.
        try fm.removeItem(at: root.appendingPathComponent("web/ui/plugins"))
        XCTAssertEqual(bundle.pluginIndex(), "\nexport const loaded = []\n")
    }
}
