import CryptoKit
import Foundation
import ImageIO

/// A read-only Figma client with device credentials and a confidential OAuth broker.
public actor Figma {
    public struct Credential: Codable, Sendable {
        public var accessToken: String
        public var method: String
        public var handle: String?
        public var refreshToken: String?
        public var expiresAt: Date?
        public var brokerURL: URL?
        public init(accessToken: String, method: String = "pat", handle: String? = nil, refreshToken: String? = nil, expiresAt: Date? = nil, brokerURL: URL? = nil) {
            self.accessToken = accessToken; self.method = method; self.handle = handle
            self.refreshToken = refreshToken; self.expiresAt = expiresAt; self.brokerURL = brokerURL
        }
    }
    public struct OAuthConfiguration: Codable, Sendable {
        public var clientID: String
        public var clientSecret: String
        public var redirectURI: String
        public init(clientID: String, clientSecret: String, redirectURI: String) {
            self.clientID = clientID; self.clientSecret = clientSecret; self.redirectURI = redirectURI
        }
    }
    public struct Response: Sendable {
        public let data: Data
        public let status: Int
        public let headers: [String: String]
        public init(data: Data, status: Int = 200, headers: [String: String] = [:]) { self.data = data; self.status = status; self.headers = headers }
    }
    public struct PreparedImport: Sendable {
        public let nodes: String
        public let options: String
        public let warnings: [String]
    }
    public struct Failure: Error, LocalizedError, Equatable {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var errorDescription: String? { message }
    }
    public typealias Transport = @Sendable (URLRequest, Int) async throws -> Response
    public typealias CredentialReader = @Sendable () throws -> Credential?
    public typealias CredentialWriter = @Sendable (Credential?) throws -> Void
    private let readCredential: CredentialReader
    private let writeCredential: CredentialWriter
    private let oauthConfiguration: @Sendable () throws -> OAuthConfiguration?
    private let brokerConfiguration: @Sendable () throws -> URL?
    private let transport: Transport
    private let core: ReelCore
    private var generation = 0
    private var refreshing: Task<Credential, Error>?
    private var refreshID: UUID?
    private var pending: (state: String, verifier: String, config: OAuthConfiguration, created: Date)?
    private var pendingBroker: (state: String, verifier: String, broker: FigmaOAuthBroker, created: Date)?
    private static let maxJSON = 32 * 1024 * 1024
    private static let maxImage = 100 * 1024 * 1024

    public init(coreScript: URL, readCredential: @escaping CredentialReader, writeCredential: @escaping CredentialWriter,
                oauthConfiguration: @escaping @Sendable () throws -> OAuthConfiguration? = { nil }, brokerConfiguration: @escaping @Sendable () throws -> URL? = { nil }, transport: Transport? = nil) throws {
        core = try ReelCore(scriptURL: coreScript)
        self.readCredential = readCredential; self.writeCredential = writeCredential
        self.oauthConfiguration = oauthConfiguration; self.brokerConfiguration = brokerConfiguration; self.transport = transport ?? Self.liveTransport
    }

    public func status() async throws -> JSON {
        let credential = try readCredential()
        return .object([("connected", .bool(credential != nil)), ("handle", .str(credential?.handle) ?? .null),
                        ("method", .str(credential?.method) ?? .null), ("oauth", .bool(try brokerConfiguration() != nil || oauthConfiguration() != nil)), ("broker", .bool(try brokerConfiguration() != nil))])
    }

    public func connect(token: String) async throws -> JSON {
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.count <= 512, token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { throw Failure("Enter a valid Figma personal access token.") }
        generation += 1
        pending = nil; pendingBroker = nil; refreshing?.cancel(); refreshing = nil; refreshID = nil
        let expected = generation
        var credential = Credential(accessToken: token)
        let me = try await api("/v1/me", credential: credential)
        guard generation == expected else { throw CancellationError() }
        credential.handle = me["handle"] as? String
        try writeCredential(credential)
        return try await status()
    }

    public func disconnect() async throws -> JSON {
        generation += 1; pending = nil; pendingBroker = nil; refreshing?.cancel(); refreshing = nil; refreshID = nil
        try writeCredential(nil)
        return try await status()
    }

    public func beginOAuth() async throws -> URL {
        generation += 1; let expected = generation
        pending = nil; pendingBroker = nil; refreshing?.cancel(); refreshing = nil; refreshID = nil
        if let endpoint = try brokerConfiguration() {
            let broker = try FigmaOAuthBroker(endpoint: endpoint, transport: transport)
            let state = Self.random(), verifier = Self.random() + Self.random()
            let url = try await broker.start(state: state, verifier: verifier)
            guard generation == expected else { throw CancellationError() }
            pendingBroker = (state, verifier, broker, Date())
            return url
        }
        guard let config = try oauthConfiguration(), !config.clientID.isEmpty, !config.clientSecret.isEmpty,
              let redirect = URL(string: config.redirectURI), redirect.scheme != nil, redirect.user == nil, redirect.password == nil else { throw Failure("Configure your Figma OAuth app, or connect with a personal access token.") }
        let state = Self.random(), verifier = Self.random() + Self.random()
        pending = (state, verifier, config, Date())
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var components = URLComponents(string: "https://www.figma.com/oauth")!
        components.queryItems = [URLQueryItem(name: "client_id", value: config.clientID), URLQueryItem(name: "redirect_uri", value: config.redirectURI),
                                 URLQueryItem(name: "scope", value: "current_user:read,file_content:read"), URLQueryItem(name: "state", value: state),
                                 URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256")]
        return components.url!
    }

    public func completeOAuth(callback: URL) async throws -> JSON {
        if let pending = pendingBroker {
            pendingBroker = nil
            guard Date().timeIntervalSince(pending.created) < 600 else { throw Failure("The Figma sign-in session has expired. Try again.") }
            generation += 1; let expected = generation
            let data = try await pending.broker.complete(callback: callback, state: pending.state, verifier: pending.verifier)
            var credential = try Self.credential(data); credential.brokerURL = pending.broker.endpoint
            let me = try await api("/v1/me", credential: credential)
            guard generation == expected else { throw CancellationError() }
            credential.handle = me["handle"] as? String
            try writeCredential(credential); return try await status()
        }
        guard let pending else { throw Failure("The Figma sign-in session has expired. Try again.") }
        self.pending = nil
        guard Date().timeIntervalSince(pending.created) < 600,
              let received = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let expected = URLComponents(string: pending.config.redirectURI),
              received.scheme == expected.scheme, received.host == expected.host, received.port == expected.port, received.path == expected.path,
              received.user == nil, received.password == nil, received.fragment == nil else { throw Failure("Figma returned an unexpected sign-in callback.") }
        let items = received.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1, items.first(where: { $0.name == "state" })?.value == pending.state,
              items.filter({ $0.name == "code" }).count == 1, let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw Failure("Figma sign-in did not return a valid authorization code.") }
        generation += 1
        let expectedGeneration = generation
        let data = try await oauth("/v1/oauth/token", config: pending.config, values: ["redirect_uri": pending.config.redirectURI, "code": code, "grant_type": "authorization_code", "code_verifier": pending.verifier])
        var credential = try Self.credential(data)
        let me = try await api("/v1/me", credential: credential)
        guard generation == expectedGeneration else { throw CancellationError() }
        credential.handle = me["handle"] as? String
        try writeCredential(credential)
        return try await status()
    }

    public func frames(body: JSON, folder: ProjectFolder) async throws -> JSON {
        let b = try Self.object(body.text), ref = try Self.reference(b)
        let data: [String: Any], target: [String: Any], frames: [[String: Any]]
        if let node = ref.node {
            data = try await api("/v1/files/\(ref.key)/nodes", query: ["ids": node, "depth": "1"])
            guard let doc = ((data["nodes"] as? [String: Any])?[node] as? [String: Any])?["document"] as? [String: Any] else { throw Failure("Figma could not find that node.") }
            target = doc
            let children = Self.frameLike(doc["children"] as? [[String: Any]] ?? [])
            frames = ["CANVAS", "SECTION"].contains(doc["type"] as? String ?? "") ? children : [doc] + children.filter { ($0["type"] as? String) != "GROUP" }
        } else {
            data = try await api("/v1/files/\(ref.key)", query: ["depth": "2"])
            guard let document = data["document"] as? [String: Any], let page = (document["children"] as? [[String: Any]])?.first else { throw Failure("That Figma file has no pages.") }
            target = page; frames = Self.frameLike(page["children"] as? [[String: Any]] ?? [])
        }
        var thumbnails: [String: String] = [:]
        let list = Array(frames.prefix(60)), ids = list.compactMap { $0["id"] as? String }
        if !ids.isEmpty {
            let widest = list.map { n -> Double in let box = n["absoluteBoundingBox"] as? [String: Any] ?? [:]; return max(box["width"] as? Double ?? 1, box["height"] as? Double ?? 1) }.max() ?? 1
            if let rendered = try? await api("/v1/images/\(ref.key)", query: ["ids": ids.joined(separator: ","), "format": "png", "scale": String(max(0.01, min(1, 360 / widest)))]), let images = rendered["images"] as? [String: Any] {
                for id in ids { if let source = images[id] as? String, let path = try? await saveImage(source, folder: folder, directory: ".reel/cache/figma/\(ref.key)", name: id) { thumbnails[id] = path } }
            }
        }
        let result = frames.map { n -> JSON in
            let id = n["id"] as? String ?? "", box = n["absoluteBoundingBox"] as? [String: Any] ?? [:]
            let thumb = thumbnails[id]
            return .object([("id", .string(id)), ("name", JSON(any: n["name"])), ("type", JSON(any: n["type"])), ("width", JSON(any: box["width"])), ("height", JSON(any: box["height"])),
                            ("thumbnail", thumb.map { .string("/cache/" + $0.dropFirst(".reel/cache/".count)) } ?? .null), ("thumbnailPath", .str(thumb) ?? .null)])
        }
        return .object([("fileKey", .string(ref.key)), ("fileName", JSON(any: data["name"])), ("target", JSON(any: ["id": target["id"] ?? "", "name": target["name"] ?? "", "type": target["type"] ?? ""])), ("frames", .array(result))])
    }

    public func prepareImport(body: JSON, folder: ProjectFolder, mcp: Bool = false) async throws -> PreparedImport {
        let expectedGeneration = generation
        var b = try Self.object(body.text), warnings: [String] = [], images: [String: Any] = [:], assets: [String: Any] = [:]
        let smart = (b["mode"] as? String) == "smartAnimate"
        let source: Any, key: String
        var downloads: [(String, String, Double?)] = []
        for (id, value) in b["images"] as? [String: Any] ?? [:] {
            guard let image = value as? [String: Any], let path = image["src"] as? String else { throw Failure("Image \(id) needs a project media path.") }
            let url = try folder.resolve(path)
            guard ProjectFolder.isMedia(url.lastPathComponent) else { throw Failure("Image \(id) needs a supported media file.") }
            try Task.checkCancellation()
            let metadata = try await MediaProbe.probe(url)
            let asset = try Self.object(metadata.text)
            guard let width = asset["width"] as? Double, let height = asset["height"] as? Double,
                  width.isFinite, height.isFinite, width > 0, height > 0 else { throw Failure("Image \(id) has no image data.") }
            let relative = folder.relative(url)
            var mapped: [String: Any] = ["src": relative, "width": width, "height": height]
            if let scale = image["scale"] as? Double {
                guard scale.isFinite, scale > 0 else { throw Failure("Image \(id) needs a positive scale.") }
                mapped["scale"] = scale
            }
            images[id] = mapped
            assets[relative] = asset
        }
        if mcp {
            guard let value = b["xml"] ?? b["nodes"], value is String || value is [String: Any] || value is [Any] else { throw Failure("Provide Figma MCP nodes or metadata XML.") }
            source = value; key = try Self.fileKey(b["fileKey"] as? String ?? "mcp")
            if smart { guard let to = b["toXml"] ?? b["toNodes"] else { throw Failure("Smart Animate needs a second frame.") }; b["toNodes"] = to }
            for (id, value) in b["assets"] as? [String: Any] ?? [:] { if let url = value as? String { downloads.append((id, url, nil)) } }
        } else {
            let ref = try Self.reference(b); key = ref.key
            guard let node = ref.node else { throw Failure("Choose a frame link that includes its node ID.") }
            var ids = [node]
            if smart { guard let to = Self.nodeID(b["toNodeId"] as? String ?? b["to"] as? String) else { throw Failure("Smart Animate needs a second frame.") }; ids.append(to) }
            let data = try await api("/v1/files/\(key)/nodes", query: ["ids": ids.joined(separator: ","), "geometry": "paths"])
            let nodes = data["nodes"] as? [String: Any] ?? [:]
            let documents = try ids.map { id -> [String: Any] in guard let value = (nodes[id] as? [String: Any])?["document"] as? [String: Any] else { throw Failure("Figma could not find frame \(id).") }; return value }
            source = documents[0]
            if smart { b["toNodes"] = documents[1] }
            let plan = try Self.object(core.figmaAssets(nodes: JSON(any: smart ? documents : documents[0]).text, options: JSON(any: b).text))
            let renders = plan["renders"] as? [String] ?? []
            for start in stride(from: 0, to: renders.count, by: 40) {
                let ids = Array(renders[start..<min(start + 40, renders.count)])
                let data = try await api("/v1/images/\(key)", query: ["ids": ids.joined(separator: ","), "format": "png", "scale": "2"])
                let urls = data["images"] as? [String: Any] ?? [:]
                for id in ids { if let url = urls[id] as? String { downloads.append((id, url, 2)) } else { warnings.append("Figma returned no render for node \(id).") } }
            }
            let fills = plan["fills"] as? [String] ?? []
            if !fills.isEmpty {
                let data = try await api("/v1/files/\(key)/images")
                let urls = (data["meta"] as? [String: Any])?["images"] as? [String: Any] ?? data["images"] as? [String: Any] ?? [:]
                for id in fills { if let url = urls[id] as? String { downloads.append((id, url, nil)) } else { warnings.append("Figma returned no image fill \(id).") } }
            }
        }
        for (id, url, scale) in downloads {
            try Task.checkCancellation()
            do {
                let path = try await saveImage(url, folder: folder, directory: "media/figma/\(key)", name: id)
                let metadata = try await MediaProbe.probe(folder.resolve(path))
                let asset = try Self.object(metadata.text)
                guard (asset["width"] as? Double ?? 0) > 0, (asset["height"] as? Double ?? 0) > 0 else { throw Failure("Downloaded asset has no image.") }
                images[id] = ["src": path, "width": asset["width"]!, "height": asset["height"]!]
                if let scale { var image = images[id] as! [String: Any]; image["scale"] = scale; images[id] = image }
                assets[path] = asset
            } catch is CancellationError { throw CancellationError() }
            catch { warnings.append("Asset \(id) could not be imported: \(error.localizedDescription)") }
        }
        b["images"] = images; b["assets"] = assets; b["mcp"] = mcp
        guard generation == expectedGeneration else { throw CancellationError() }
        return PreparedImport(nodes: JSON(any: source).text, options: JSON(any: b).text, warnings: warnings)
    }

    public func importPlan(project: String, prepared: PreparedImport) throws -> JSON {
        var result = try Self.object(core.figmaImport(project: project, nodes: prepared.nodes, options: prepared.options))
        result["warnings"] = prepared.warnings + (result["warnings"] as? [String] ?? [])
        return JSON(any: result)
    }

    private func currentCredential() async throws -> Credential {
        guard let credential = try readCredential() else { throw Failure("Connect your Figma account first.") }
        if credential.method == "oauth", let expiry = credential.expiresAt, expiry.timeIntervalSinceNow < 300, credential.refreshToken != nil { return try await refresh(credential) }
        return credential
    }

    private func refresh(_ previous: Credential) async throws -> Credential {
        if let refreshing { return try await refreshing.value }
        let expected = generation
        let id = UUID()
        let task = Task { () throws -> Credential in
            guard let refreshToken = previous.refreshToken else { throw Failure("Reconnect Figma to renew this session.") }
            let data: [String: Any]
            if let endpoint = previous.brokerURL {
                data = try await FigmaOAuthBroker(endpoint: endpoint, transport: self.transport).refresh(refreshToken)
            } else {
                guard let config = try self.oauthConfiguration() else { throw Failure("Reconnect Figma to renew this session.") }
                data = try await self.oauth("/v1/oauth/token", config: config, values: ["refresh_token": refreshToken, "grant_type": "refresh_token"])
            }
            var next = try Self.credential(data)
            next.refreshToken = next.refreshToken ?? previous.refreshToken; next.handle = previous.handle; next.brokerURL = previous.brokerURL
            guard self.generation == expected else { throw CancellationError() }
            try self.writeCredential(next)
            return next
        }
        refreshing = task
        refreshID = id
        defer { if refreshID == id { refreshing = nil; refreshID = nil } }
        return try await task.value
    }

    private func api(_ path: String, query: [String: String] = [:], credential supplied: Credential? = nil) async throws -> [String: Any] {
        var credential: Credential
        if let supplied { credential = supplied } else { credential = try await currentCredential() }
        for attempt in 0..<2 {
            var components = URLComponents(string: "https://api.figma.com" + path)!
            if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
            var request = URLRequest(url: components.url!)
            request.setValue(credential.accessToken, forHTTPHeaderField: credential.method == "oauth" ? "Authorization" : "X-Figma-Token")
            if credential.method == "oauth" { request.setValue("Bearer " + credential.accessToken, forHTTPHeaderField: "Authorization") }
            let response = try await send(request, limit: Self.maxJSON)
            if attempt == 0, supplied == nil, [401, 403].contains(response.status), credential.method == "oauth", credential.refreshToken != nil {
                credential = try await refresh(credential); continue
            }
            if path == "/v1/me", [401, 403].contains(response.status) {
                throw Failure("Figma did not accept this token. Check it is current and has File content (read), file_content:read, and Current user (read), current_user:read, access.")
            }
            return try Self.read(response)
        }
        throw Failure("Reconnect Figma to continue.")
    }

    private func oauth(_ path: String, config: OAuthConfiguration, values: [String: String]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "https://api.figma.com" + path)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("Basic " + Data((config.clientID + ":" + config.clientSecret).utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        request.httpBody = Data(values.sorted { $0.key < $1.key }.map { Self.escape($0.key) + "=" + Self.escape($0.value) }.joined(separator: "&").utf8)
        return try Self.read(try await send(request, limit: Self.maxJSON))
    }

    private func send(_ request: URLRequest, limit: Int) async throws -> Response {
        for attempt in 0..<2 {
            try Task.checkCancellation()
            let response: Response
            do { response = try await transport(request, limit) }
            catch is CancellationError { throw CancellationError() }
            catch { throw Failure("Figma could not be reached. Check your connection and try again.") }
            guard response.data.count <= limit else { throw Failure("Figma returned a file larger than the import limit.") }
            if response.status == 429, attempt == 0 {
                let delay = min(10, max(0, Double(response.headers["retry-after"] ?? "2") ?? 2))
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)); continue
            }
            return response
        }
        throw Failure("Figma rate limit reached. Try again later.")
    }

    private func saveImage(_ source: String, folder: ProjectFolder, directory: String, name: String) async throws -> String {
        let data: Data
        if source.hasPrefix("data:") {
            guard let comma = source.firstIndex(of: ","), source[..<comma].hasSuffix(";base64"), let value = Data(base64Encoded: String(source[source.index(after: comma)...])), value.count <= Self.maxImage else { throw Failure("The image data URL is invalid or too large.") }
            data = value
        } else if let initial = URL(string: source), initial.scheme == "https" || (initial.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(initial.host ?? "")) {
            var url = initial, value: Data?
            for hop in 0...4 {
                guard url.user == nil, url.password == nil, url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else { throw Failure("The image URL uses an unsupported connection.") }
                let response = try await send(URLRequest(url: url), limit: Self.maxImage)
                if (300..<400).contains(response.status), let location = response.headers["location"], let next = URL(string: location, relativeTo: url)?.absoluteURL, hop < 4 { url = next; continue }
                guard (200..<300).contains(response.status) else { throw Failure("Figma image download failed.") }
                value = response.data; break
            }
            guard let value else { throw Failure("The image redirected too many times.") }; data = value
        } else {
            let path = source.hasPrefix("file:") ? URL(string: source)?.path ?? "" : source
            let file = try folder.resolve(path)
            let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size <= Self.maxImage else { throw Failure("The image is larger than the import limit.") }; data = try Data(contentsOf: file)
        }
        guard data.count <= Self.maxImage, let image = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(image) > 0,
              let type = CGImageSourceGetType(image) as String?, let ext = ["public.png": "png", "public.jpeg": "jpg", "com.compuserve.gif": "gif", "org.webmproject.webp": "webp", "public.heic": "heic", "public.tiff": "tiff"][type] else { throw Failure("Figma did not return a supported raster image.") }
        let clean = String(name.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }.prefix(80))
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(20)
        let relative = "\(directory)/\(clean.isEmpty ? "node" : clean)-\(digest).\(ext)"
        let file = try Self.checkedOutput(folder, relative)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = try Self.checkedOutput(folder, relative)
        if FileManager.default.fileExists(atPath: file.path) {
            guard try Data(contentsOf: file) == data else { throw Failure("An existing imported image has different bytes.") }
        } else { try data.write(to: file, options: .atomic) }
        return relative
    }

    private static func checkedOutput(_ folder: ProjectFolder, _ relative: String) throws -> URL {
        do { return try folder.output(relative) }
        catch { throw Failure("Figma image output must stay in the project and cannot use symbolic links.") }
    }
    private static func object(_ text: String) throws -> [String: Any] {
        guard let value = try JSON.parse(text) as? [String: Any] else { throw Failure("Figma returned unreadable data.") }; return value
    }
    private static func read(_ response: Response) throws -> [String: Any] {
        guard (200..<300).contains(response.status) else {
            switch response.status {
            case 401, 403: throw Failure("Figma refused access. Check your token scopes and file sharing.")
            case 404: throw Failure("Figma could not find that file or node.")
            case 429: throw Failure("Figma rate limit reached. Try again later.")
            default: throw Failure("Figma request failed with status \(response.status).")
            }
        }
        return try object(String(decoding: response.data, as: UTF8.self))
    }
    private static func credential(_ data: [String: Any]) throws -> Credential {
        guard let token = data["access_token"] as? String, !token.isEmpty, token.count <= 2048, token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { throw Failure("Figma did not return an access token.") }
        if let refresh = data["refresh_token"] as? String { guard !refresh.isEmpty, refresh.count <= 4096, refresh.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { throw Failure("Figma returned an invalid refresh credential.") } }
        if let expiry = data["expires_in"] as? Double { guard expiry.isFinite, expiry > 0 else { throw Failure("Figma returned an invalid token lifetime.") } }
        return Credential(accessToken: token, method: "oauth", refreshToken: data["refresh_token"] as? String, expiresAt: (data["expires_in"] as? Double).map { Date().addingTimeInterval($0) })
    }
    private static func fileKey(_ value: String) throws -> String {
        guard (1...128).contains(value.count), value.range(of: "^[A-Za-z0-9]+$", options: .regularExpression) != nil else { throw Failure("That Figma file key is invalid.") }; return value
    }
    private static func nodeID(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.count < 512 else { return nil }
        let id = value.replacingOccurrences(of: "-", with: ":")
        return id.range(of: "^[A-Za-z0-9:;_]+$", options: .regularExpression) != nil ? id : nil
    }
    private static func reference(_ body: [String: Any]) throws -> (key: String, node: String?) {
        if let key = body["fileKey"] as? String { return (try fileKey(key), nodeID(body["nodeId"] as? String)) }
        guard let text = body["url"] as? String, let url = URLComponents(string: text), url.scheme == "https", ["www.figma.com", "figma.com"].contains(url.host ?? ""), url.user == nil, url.password == nil else { throw Failure("Enter a Figma design or file link.") }
        let parts = url.path.split(separator: "/")
        guard parts.count >= 2, ["design", "file", "proto"].contains(String(parts[0])) else { throw Failure("Enter a Figma design or file link.") }
        return (try fileKey(String(parts[1])), nodeID(body["nodeId"] as? String ?? url.queryItems?.first(where: { $0.name == "node-id" })?.value))
    }
    private static func frameLike(_ nodes: [[String: Any]]) -> [[String: Any]] { nodes.filter { ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION"].contains($0["type"] as? String ?? "") && ($0["visible"] as? Bool) != false } }
    private static func random() -> String { base64URL(Data((0..<32).map { _ in UInt8.random(in: 0...255) })) }
    private static func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    private static func escape(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
    private static let liveTransport: Transport = { request, limit in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 90; configuration.timeoutIntervalForResource = 120
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure("Figma returned an invalid response.") }
        if response.expectedContentLength > Int64(limit) { throw Failure("Figma returned a file larger than the import limit.") }
        var data = Data(), buffer = [UInt8](); buffer.reserveCapacity(32768)
        for try await byte in bytes {
            buffer.append(byte)
            if data.count + buffer.count > limit { throw Failure("Figma returned a file larger than the import limit.") }
            if buffer.count == 32768 { data.append(contentsOf: buffer); buffer.removeAll(keepingCapacity: true); try Task.checkCancellation() }
        }
        data.append(contentsOf: buffer)
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields { headers[String(describing: key).lowercased()] = String(describing: value) }
        return Response(data: data, status: http.statusCode, headers: headers)
    }
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
}
