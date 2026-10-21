import AuthenticationServices
import Foundation
import ReelKit
import Security
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class NativeFigma: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var connected = false
    @Published private(set) var handle: String?
    @Published private(set) var message: String?
    @Published private(set) var working = false
    @Published private(set) var oauthConfigured = false
    @Published private(set) var brokerConfigured = false
    private weak var session: EditorSession?
    private var client: Figma?
    private var authentication: ASWebAuthenticationSession?
    #if os(macOS)
    private var hasRequestedCredentialAccess = false
    #endif

    init(session: EditorSession) {
        self.session = session
        super.init()
        #if os(macOS)
        brokerConfigured = (try? FigmaCredentials.broker()) != nil
        oauthConfigured = brokerConfigured
        #else
        refreshStoredStatus()
        #endif
    }
    var snapshot: JSON { .object([("available", true), ("connected", .bool(connected)), ("handle", .str(handle) ?? .null), ("oauth", .bool(oauthConfigured)), ("broker", .bool(brokerConfigured))]) }

    func connect(token: String) async throws {
        try await operation {
            let status = try await self.service().connect(token: token)
            #if os(macOS)
            self.hasRequestedCredentialAccess = true
            #endif
            self.accept(status); self.message = "Figma connected."
        }
    }
    func disconnect() async throws {
        authentication?.cancel(); authentication = nil
        let status = try await service().disconnect()
        accept(status); message = "Figma disconnected."
    }
    func configureOAuth(clientID: String, clientSecret: String?, redirectURI: String) throws {
        guard !working else { throw Figma.Failure("Wait for the current Figma operation to finish.") }
        guard !clientID.isEmpty, clientID.count <= 256 else { throw Figma.Failure("Enter your Figma OAuth app ID.") }
        guard redirectURI == "reelfigma://oauth/callback" else { throw Figma.Failure("Register reelfigma://oauth/callback in your Figma OAuth app and use that redirect URL here.") }
        let existing = try FigmaCredentials.oauth(access: .userInitiated)
        let storedSecret = existing?.clientID == clientID ? existing?.clientSecret ?? "" : ""
        let secret = clientSecret.flatMap { $0.isEmpty ? nil : $0 } ?? storedSecret
        guard !secret.isEmpty, secret.count <= 512 else { throw Figma.Failure("Enter your Figma OAuth app secret.") }
        try FigmaCredentials.saveOAuth(.init(clientID: clientID, clientSecret: secret, redirectURI: redirectURI))
        #if os(macOS)
        hasRequestedCredentialAccess = true
        #endif
        oauthConfigured = true; message = "OAuth settings saved in Keychain."
    }
    func oauthSettings() -> (clientID: String, redirectURI: String) {
        #if os(macOS)
        guard hasRequestedCredentialAccess else { return ("", "reelfigma://oauth/callback") }
        #endif
        let config = try? FigmaCredentials.oauth()
        return (config?.clientID ?? "", config?.redirectURI ?? "reelfigma://oauth/callback")
    }
    func brokerSetting() -> String { (try? FigmaCredentials.broker())?.absoluteString ?? "" }
    func configureBroker(_ endpoint: String) throws {
        guard !working else { throw Figma.Failure("Wait for the current Figma operation to finish.") }
        try FigmaCredentials.saveBroker(endpoint)
        refreshStoredStatus(); message = "Figma sign-in service settings saved."
    }
    func beginOAuth() async throws {
        try await operation {
            if try FigmaCredentials.broker() == nil {
                guard let config = try FigmaCredentials.oauth(access: .userInitiated), config.redirectURI == "reelfigma://oauth/callback" else { throw Figma.Failure("Public Figma sign-in is not configured for this build. Advanced connections can use a personal access token or developer OAuth app.") }
            }
            #if os(macOS)
            self.hasRequestedCredentialAccess = true
            #endif
            let client = try self.service(), url = try await client.beginOAuth()
            defer { self.authentication = nil }
            let callback: URL = try await withCheckedThrowingContinuation { continuation in
                let authentication = ASWebAuthenticationSession(url: url, callbackURLScheme: "reelfigma") { callback, error in
                    if let callback { continuation.resume(returning: callback) }
                    else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        continuation.resume(throwing: Figma.Failure("Figma sign-in was canceled."))
                    } else { continuation.resume(throwing: error ?? Figma.Failure("Figma sign-in could not finish. Try again.")) }
                }
                authentication.presentationContextProvider = self
                self.authentication = authentication
                if !authentication.start() { self.authentication = nil; continuation.resume(throwing: Figma.Failure("The system browser could not start Figma sign-in.")) }
            }
            self.accept(try await client.completeOAuth(callback: callback))
            self.message = "Figma connected."
        }
    }

    func handle(method: String, path: String, body: String?) async throws -> JSON? {
        let route = URLComponents(string: path)?.path ?? path
        guard route.hasPrefix("/api/figma/") else { return nil }
        guard let b = try JSON.parse(body ?? "{}") as? [String: Any] else { throw Figma.Failure("The Figma request must be an object.") }
        switch (method, route) {
        case ("GET", "/api/figma/status"):
            #if os(macOS)
            guard hasRequestedCredentialAccess else { return snapshot }
            #endif
            let status = try await service().status(); accept(status); return status
        case ("POST", "/api/figma/token"):
            try await connect(token: b["token"] as? String ?? ""); return try await service().status()
        case ("POST", "/api/figma/disconnect"):
            try await disconnect(); return try await service().status()
        case ("GET", "/api/figma/oauth/start"):
            try await beginOAuth(); return .object([("started", true), ("connected", .bool(connected))])
        case ("POST", "/api/figma/frames"):
            guard let backend = session?.backend else { throw Figma.Failure("Open a project folder first.") }
            return try await service().frames(body: JSON(any: b), folder: backend.folder)
        case ("POST", "/api/figma/import"), ("POST", "/api/figma/import-mcp"):
            return try await importFrame(b, mcp: route.hasSuffix("import-mcp"))
        default: throw Figma.Failure("That Figma operation is unavailable.")
        }
    }

    private func importFrame(_ body: [String: Any], mcp: Bool) async throws -> JSON {
        guard let session, let backend = session.backend else { throw Figma.Failure("Open a project folder first.") }
        let sessionID = session.sessionID
        let service = try service()
        let prepared = try await service.prepareImport(body: JSON(any: body), folder: backend.folder, mcp: mcp)
        guard session.backend === backend, session.sessionID == sessionID else { throw CancellationError() }
        let snapshot = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        let fields = try JSON.parse(snapshot.text) as? [String: Any] ?? [:]
        guard let project = fields["project"] as? [String: Any], let version = fields["version"] as? Int else { throw Figma.Failure("Create a project before importing a frame.") }
        let plan = try await service.importPlan(project: JSON(any: project).text, prepared: prepared)
        var result = try JSON.parse(plan.text) as? [String: Any] ?? [:]
        guard session.backend === backend, session.sessionID == sessionID else { throw CancellationError() }
        let applied = try await backend.editOperations(ops: JSON(any: result["ops"]), who: (body["who"] as? String) == "claude" ? "claude" : "you",
                                                       summary: "Imported Figma \(result["name"] as? String ?? "frame")", expectedVersion: version)
        let appliedFields = try JSON.parse(applied.text) as? [String: Any] ?? [:]
        result.removeValue(forKey: "ops"); result["created"] = appliedFields["created"]; result["version"] = appliedFields["version"]
        if (body["placeOnTimeline"] as? Bool) == true, let p = appliedFields["project"] as? [String: Any] {
            let destination = (body["comp"] as? String).flatMap { (p["comps"] as? [String: Any])?[$0] as? [String: Any] } ?? p
            let clips = (destination["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
            result["clip"] = clips.first { ($0["comp"] as? String) == (result["comp"] as? String) }?["id"]
        }
        message = "Imported \(result["name"] as? String ?? "Figma frame")."
        return JSON(any: result)
    }
    private func service() throws -> Figma {
        if let client { return client }
        guard let session else { throw Figma.Failure("The editor session is closed.") }
        let client = try Figma(coreScript: session.editor.coreScript, readCredential: { try FigmaCredentials.read() }, writeCredential: { try FigmaCredentials.save($0) }, oauthConfiguration: { try FigmaCredentials.oauth() }, brokerConfiguration: { try FigmaCredentials.broker() })
        self.client = client; return client
    }
    private func accept(_ status: JSON) {
        let b = (try? JSON.parse(status.text) as? [String: Any]) ?? [:]
        connected = b["connected"] as? Bool ?? false; handle = b["handle"] as? String; oauthConfigured = b["oauth"] as? Bool ?? false; brokerConfigured = b["broker"] as? Bool ?? false
        session?.push("figma", status.text)
    }
    #if os(macOS)
    func checkSavedConnection() throws {
        guard !working else { throw Figma.Failure("Wait for the current Figma operation to finish.") }
        hasRequestedCredentialAccess = true
        do {
            let stored = try FigmaCredentials.read(access: .userInitiated)
            let oauth = try FigmaCredentials.oauth(access: .userInitiated)
            connected = stored != nil; handle = stored?.handle
            brokerConfigured = (try? FigmaCredentials.broker()) != nil
            oauthConfigured = brokerConfigured || oauth != nil
            message = stored != nil ? "Saved Figma connection is available." : oauth != nil ? "Saved OAuth settings are available. Sign in with Figma to connect." : "No saved Figma connection was found."
        } catch {
            message = "The saved Figma connection could not be read. Retry the saved connection check. " + error.localizedDescription
            throw error
        }
    }
    #endif

    private func refreshStoredStatus() {
        #if os(macOS)
        guard hasRequestedCredentialAccess else {
            brokerConfigured = (try? FigmaCredentials.broker()) != nil
            oauthConfigured = brokerConfigured
            return
        }
        #endif
        let stored = try? FigmaCredentials.read()
        connected = stored != nil; handle = stored?.handle; brokerConfigured = (try? FigmaCredentials.broker()) != nil; oauthConfigured = brokerConfigured || (try? FigmaCredentials.oauth()) != nil
    }
    private func operation(_ body: () async throws -> Void) async throws {
        guard !working else { throw Figma.Failure("Wait for the current Figma operation to finish.") }
        working = true; message = nil
        defer { working = false }
        do { try await body() } catch { message = error.localizedDescription; throw error }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        #endif
    }
}

private enum FigmaCredentials {
    private static let service = "app.reel.figma"
    private static func query(_ account: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] }
    static func read(access: NativeCredentialReadAccess = .passive) throws -> Figma.Credential? { try decode("credential", access: access) }
    static func oauth(access: NativeCredentialReadAccess = .passive) throws -> Figma.OAuthConfiguration? { try decode("oauth-app", access: access) }
    static func save(_ value: Figma.Credential?) throws { try store(value, account: "credential") }
    static func saveOAuth(_ value: Figma.OAuthConfiguration) throws { try store(value, account: "oauth-app") }
    static func broker() throws -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: "reel.figma.brokerURL") ?? Bundle.main.object(forInfoDictionaryKey: "ReelFigmaBrokerURL") as? String,
              !raw.isEmpty else { return nil }
        return try validateBroker(raw)
    }
    static func saveBroker(_ raw: String) throws {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { UserDefaults.standard.removeObject(forKey: "reel.figma.brokerURL") }
        else { UserDefaults.standard.set(try validateBroker(value).absoluteString, forKey: "reel.figma.brokerURL") }
    }
    private static func validateBroker(_ raw: String) throws -> URL {
        guard raw.utf8.count <= 2048, let parts = URLComponents(string: raw), parts.scheme == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", parts.port == nil || parts.port == 443, let url = parts.url else {
            throw Figma.Failure("The Figma sign-in service must be an HTTPS origin without a path, query or credentials.")
        }
        return url
    }
    private static func decode<T: Decodable>(_ account: String, access: NativeCredentialReadAccess = .passive) throws -> T? {
        var request = NativeCredentialReadAccess.request(query(account), access: access); request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = try NativeCredentialReadAccess.perform(access: access) { SecItemCopyMatching(request as CFDictionary, &result) }
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Figma.Failure("Unlock Keychain to use your Figma connection.") }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private static func store<T: Encodable>(_ value: T?, account: String) throws {
        try NativeCredentialReadAccess.perform(access: .userInitiated) {
            let request = query(account)
            guard let value else {
                let status = SecItemDelete(request as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { throw Figma.Failure("Keychain could not remove the Figma connection.") }; return
            }
            let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
            let updated = SecItemUpdate(request as CFDictionary, values as CFDictionary)
            let status = updated == errSecItemNotFound ? SecItemAdd(request.merging(values) { _, new in new } as CFDictionary, nil) : updated
            guard status == errSecSuccess else { throw Figma.Failure("Keychain could not save the Figma connection.") }
        }
    }
}

struct NativeFigmaSettings: View {
    @ObservedObject var figma: NativeFigma
    @State private var token = ""
    @State private var clientID = ""
    @State private var secret = ""
    @State private var redirect = ""
    @State private var brokerURL = ""
    @State private var developerOptions = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("Figma account") {
                if figma.connected {
                    Text("Connected as \(figma.handle ?? "your account")")
                    Button("Disconnect", role: .destructive) { Task { do { try await figma.disconnect() } catch { self.error = error.localizedDescription } } }.disabled(figma.working)
                } else if figma.brokerConfigured {
                    Text("Connect your Figma account to import editable frames.")
                    Button("Connect with Figma") { signIn() }.disabled(figma.working)
                } else {
                    Text("Public Figma sign-in is not configured for this build.")
                    Text("Connect with a personal access token below to import your frames.").font(.caption).foregroundStyle(.secondary)
                }
                #if os(macOS)
                Button("Check saved Figma connection") {
                    do { try figma.checkSavedConnection(); loadSettings(); error = nil }
                    catch { self.error = error.localizedDescription }
                }.disabled(figma.working)
                #endif
                if figma.working { ProgressView("Connecting to Figma") }
            }
            Section("Personal access token") {
                Group {
                    SecureField("Personal access token", text: $token).textContentType(.password)
                    Button("Connect token") { Task { defer { token = "" }; do { try await figma.connect(token: token); error = nil } catch { self.error = error.localizedDescription } } }.disabled(token.isEmpty || figma.working)
                    Link("Create a personal access token", destination: URL(string: "https://www.figma.com/settings")!)
                    Text("Allow File content (read), file_content:read, and Current user (read), current_user:read. Credentials stay in this device's Keychain.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                Toggle("Developer options", isOn: $developerOptions)
                if developerOptions {
                DisclosureGroup("Developer OAuth app") {
                    TextField("Client ID", text: $clientID)
                    SecureField("Client secret", text: $secret).textContentType(.password)
                    TextField("Registered redirect URL", text: $redirect)
                    Button("Save OAuth settings") {
                        defer { secret = "" }
                        do { try figma.configureOAuth(clientID: clientID, clientSecret: secret.isEmpty ? nil : secret, redirectURI: redirect); error = nil }
                        catch { self.error = error.localizedDescription }
                    }.disabled(figma.working)
                    Button("Sign in with your OAuth app") { signIn() }.disabled(!figma.oauthConfigured || figma.working)
                    Link("Register your OAuth app", destination: URL(string: "https://www.figma.com/developers/apps")!)
                    Text("Register reelfigma://oauth/callback. Its client secret stays in Keychain. A configured public sign-in service takes precedence.").font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("Developer sign-in service") {
                    TextField("HTTPS service origin", text: $brokerURL)
                    Button("Save service origin") { do { try figma.configureBroker(brokerURL); error = nil } catch { self.error = error.localizedDescription } }.disabled(figma.working)
                    Text("Set this only for a trusted Arya sign-in service. Leave it empty to use this build's configured origin, if any.").font(.caption).foregroundStyle(.secondary)
                }
            }
            }
            if let message = error ?? figma.message { Text(message).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped).padding()
        .onAppear { loadSettings() }
        .onDisappear { token = ""; secret = "" }
    }
    private func loadSettings() {
        let settings = figma.oauthSettings(); clientID = settings.clientID; redirect = settings.redirectURI; brokerURL = figma.brokerSetting()
    }
    private func signIn() { Task { do { try await figma.beginOAuth(); error = nil } catch { self.error = error.localizedDescription } } }
}
