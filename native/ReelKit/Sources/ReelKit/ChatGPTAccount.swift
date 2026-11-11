import CryptoKit
import Foundation
import Security

// Sign in with ChatGPT, "ChatGPT plan usage" for open-source apps that run on the user's device.
// https://developers.openai.com/siwc/token-sharing-open-source (sign-in, profiles-and-sessions,
// token-reference, errors-and-recovery; all read 2026-11-10).
// Tokens live only in this actor and in the host's secure store. They never reach the UI,
// status JSON, logs, URLs other than OpenAI's endpoints, project files or agent tools.

public struct ChatGPTAccountError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public let code: String
    public init(_ message: String, code: String) { self.message = message; self.code = code }
    public var errorDescription: String? { message }
}

public struct ChatGPTEndpoints: Sendable, Equatable {
    public let issuer: String
    public let authorize: URL
    public let token: URL
    public let revoke: URL
    public let jwks: URL
    public let api: URL
    /// Production values from https://auth.openai.com/.well-known/openid-configuration.
    public static let production = ChatGPTEndpoints(
        issuer: "https://auth.openai.com",
        authorize: URL(string: "https://auth.openai.com/api/accounts/authorize")!,
        token: URL(string: "https://auth.openai.com/api/accounts/oauth/token")!,
        revoke: URL(string: "https://auth.openai.com/api/accounts/oauth/revoke")!,
        jwks: URL(string: "https://auth.openai.com/.well-known/jwks.json")!,
        api: URL(string: "https://api.openai.com/v1")!)
}

public struct ChatGPTHTTPResponse: Sendable {
    public let status: Int
    public let data: Data
    public let headers: [String: String]
    public init(status: Int, data: Data, headers: [String: String] = [:]) { self.status = status; self.data = data; self.headers = headers }
}

public typealias ChatGPTHTTPTransport = @Sendable (URLRequest) async throws -> ChatGPTHTTPResponse

/// The host's protected credential storage. On Apple platforms this is the Keychain.
public protocol ChatGPTVaultStore: Sendable {
    /// Returns nil when nothing is saved. Throws when the store cannot be read right now
    /// (locked, interaction refused); the caller must treat that as unknown, never as empty.
    func read(userInitiated: Bool) throws -> Data?
    func write(_ data: Data) throws
}

public struct ChatGPTCredential: Sendable {
    public let accessToken: String
    public let api: URL
    public let identity: String
}

public struct ChatGPTModel: Sendable, Equatable {
    public let slug: String
    public let displayName: String
}

/// Everything the UI may know. No token, client ID, state, nonce or verifier.
public struct ChatGPTStatus: Sendable, Equatable {
    public enum Storage: String, Sendable { case unchecked, unavailable, unreadable, ready }
    public enum Phase: String, Sendable { case idle, waiting, exchanging, done, failed, cancelled, expired }
    public struct Account: Sendable, Equatable, Identifiable {
        public let id: String
        public let email: String
        public let signedIn: Bool
        public let planUsage: Bool
        public let active: Bool
    }
    public var storage: Storage = .unchecked
    public var signedIn = false
    public var planUsage = false
    public var signOutCleanupRequired = false
    public var email = ""
    public var active: String?
    public var accounts: [Account] = []
    public var welcome = false
    public var phase: Phase = .idle
    public var message = ""
    public var warning: String?
    /// Stable digest of issued client, account subject and sign-in session. It changes on a new
    /// sign-in, a switch or sign-out, and survives token refresh. Used to bind sharing permission.
    public var identity: String?
    public init() {}

    public var json: JSON {
        .object([("supported", true), ("storage", .string(storage.rawValue)), ("signedIn", .bool(signedIn)), ("planUsage", .bool(planUsage)), ("signOutCleanupRequired", .bool(signOutCleanupRequired)),
                 ("email", .string(email)), ("active", active.map(JSON.string) ?? .null),
                 ("accounts", .array(accounts.map { .object([("id", .string($0.id)), ("email", .string($0.email)), ("signedIn", .bool($0.signedIn)), ("planUsage", .bool($0.planUsage)), ("active", .bool($0.active))]) })),
                 ("welcome", .bool(welcome)), ("usageURL", .string(ChatGPTAccountService.usageURL.absoluteString)),
                 ("attempt", .object([("state", .string(phase.rawValue)), ("message", .string(message)), ("startURL", .null)])),
                 ("error", warning.map(JSON.string) ?? .null)])
    }
}

struct ChatGPTRecord: Codable, Equatable {
    var clientID: String
    var subject: String
    var email: String
    var issuer: String
    var idToken: String?
    var accessToken: String?
    var refreshToken: String?
    var expiresAt: Double?
    var earliestRefreshAt: Double?
    var scopes: [String]
    var invalid: Bool
    var session: String?
    var savedAt: Double?
}

struct ChatGPTVault: Codable, Equatable {
    var version: Int
    var hostID: String?
    var active: String?
    var welcomed: Bool
    var accounts: [ChatGPTRecord]
    static let empty = ChatGPTVault(version: 1, hostID: nil, active: nil, welcomed: false, accounts: [])
}

public actor ChatGPTAccountService {
    public static let resource = "https://api.openai.com/v1"
    public static let scopes = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]
    public static let planScope = "chatgpt.tokens.use.direct"
    public static let usageURL = URL(string: "https://chatgpt.com/settings/usage")!
    static let registrationClient = "dynamic_agent_client"
    static let agentName = "Arya"
    static let unusableRefresh: Set<String> = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]
    static let refreshMargin: TimeInterval = 5 * 60
    static let skew: TimeInterval = 60

    public typealias Opener = @Sendable (URL) async -> Bool
    public typealias Observer = @Sendable (ChatGPTStatus) -> Void

    private struct Attempt {
        let id: UUID
        var phase: ChatGPTStatus.Phase
        var message: String
        let registration: Bool
        let clientID: String
        let subject: String?
        let verifier: String
        let state: String
        let nonce: String
        let redirect: String
        let authorizeURL: URL
        let listener: ChatGPTLoopbackListener
        var timer: Task<Void, Never>?
    }

    private let store: ChatGPTVaultStore
    private let endpoints: ChatGPTEndpoints
    private let http: ChatGPTHTTPTransport
    private let opener: Opener
    private let now: @Sendable () -> Date
    private let retryDelays: [Double]
    private let attemptTimeout: Double
    private let listen: ChatGPTLoopbackListener.Factory

    private var storage: ChatGPTStatus.Storage = .unchecked
    private var vault: ChatGPTVault?
    private var attempt: Attempt?
    private var lastPhase: (ChatGPTStatus.Phase, String) = (.idle, "")
    private var refreshing: Task<ChatGPTCredential, Error>?
    private var generation = 0
    private var signingOut: Set<String> = []
    private struct PendingSignOut { var refreshToken: String?; var revocationConfirmed: Bool }
    private var pendingSignOuts: [String: PendingSignOut] = [:]
    private var keys: [String: SecKey] = [:]
    private var observers: [UUID: Observer] = [:]
    private var warning: String?

    public init(store: ChatGPTVaultStore, endpoints: ChatGPTEndpoints = .production, http: ChatGPTHTTPTransport? = nil,
                opener: @escaping Opener, now: @escaping @Sendable () -> Date = { Date() },
                retryDelays: [Double] = [0.5, 1.5, 4], attemptTimeout: Double = 600,
                listen: @escaping ChatGPTLoopbackListener.Factory = ChatGPTLoopbackListener.live) {
        self.store = store; self.endpoints = endpoints; self.http = http ?? Self.liveHTTP; self.opener = opener; self.now = now
        self.retryDelays = retryDelays; self.attemptTimeout = attemptTimeout; self.listen = listen
    }

    // MARK: Status

    public func subscribe(_ observer: @escaping Observer) -> UUID {
        let id = UUID(); observers[id] = observer; return id
    }
    public func unsubscribe(_ id: UUID) { observers.removeValue(forKey: id) }

    private func notify() {
        let value = currentStatus()
        for observer in observers.values { observer(value) }
    }

    public func status() -> ChatGPTStatus { currentStatus() }

    private func currentStatus() -> ChatGPTStatus {
        var result = ChatGPTStatus()
        result.storage = storage
        result.phase = attempt?.phase ?? lastPhase.0
        result.message = attempt?.message ?? lastPhase.1
        result.warning = storage == .unreadable ? "The saved ChatGPT connection is unreadable. Continue with ChatGPT to replace it." : warning
        result.signOutCleanupRequired = !pendingSignOuts.isEmpty
        guard let vault else { return result }
        let active = vault.accounts.first { $0.clientID == vault.active }
        result.signedIn = active.map(hasSession) ?? false
        result.planUsage = active.map(planUsage) ?? false
        result.email = active?.email ?? ""
        result.active = active.map { Self.publicID($0.clientID) }
        result.accounts = vault.accounts.map { .init(id: Self.publicID($0.clientID), email: $0.email, signedIn: hasSession($0), planUsage: planUsage($0), active: $0.clientID == vault.active) }
        result.welcome = result.planUsage && !vault.welcomed
        result.identity = active.flatMap { planUsage($0) ? Self.identity($0) : nil }
        return result
    }

    /// Reads the saved vault once per process. A passive read never prompts; failures leave the
    /// state unknown so nothing is overwritten. After a successful read this actor is authoritative.
    @discardableResult public func load(userInitiated: Bool) -> ChatGPTStatus {
        guard storage != .ready, storage != .unreadable else { return currentStatus() }
        do {
            if let data = try store.read(userInitiated: userInitiated) {
                if let decoded = Self.decode(data) { vault = decoded; storage = .ready } else { vault = nil; storage = .unreadable }
            } else { vault = nil; storage = .ready }
        } catch {
            storage = .unavailable
        }
        notify()
        return currentStatus()
    }

    static func decode(_ data: Data) -> ChatGPTVault? {
        guard data.count <= 512 * 1024, let value = try? JSONDecoder().decode(ChatGPTVault.self, from: data), value.version == 1,
              value.accounts.count <= 32, value.accounts.allSatisfy({ validClient($0.clientID) }),
              value.hostID.map(validHostID) ?? true else { return nil }
        return value
    }

    private func persist(_ value: ChatGPTVault) throws {
        let data = try JSONEncoder().encode(value)
        try store.write(data)
        vault = value
        storage = .ready
    }

    // MARK: Sign-in

    /// One attempt at a time. `account` picks a saved registration; `newAccount` registers another.
    /// Returns whether the system browser opened.
    @discardableResult
    public func signIn(account selected: String? = nil, newAccount: Bool = false, enablePlan: Bool = false) async throws -> Bool {
        guard pendingSignOuts.isEmpty else { throw ChatGPTAccountError("Finish signing out after unlocking your Mac before connecting another ChatGPT account.", code: "chatgpt_storage") }
        if storage == .unchecked || storage == .unavailable { load(userInitiated: true) }
        guard storage == .ready || storage == .unreadable else {
            throw ChatGPTAccountError("Keychain could not be read. Unlock your Mac and try again; your saved ChatGPT connection was not changed.", code: "chatgpt_storage")
        }
        finishAttempt(.cancelled, "Replaced by a newer sign-in.", close: true)
        var saved = vault ?? .empty
        var record: ChatGPTRecord?
        if !newAccount {
            if let selected {
                record = saved.accounts.first { Self.publicID($0.clientID) == selected }
                guard record != nil else { throw ChatGPTAccountError("That ChatGPT account is no longer saved. Continue with ChatGPT to add it again.", code: "chatgpt_unknown_account") }
            } else { record = saved.accounts.first { $0.clientID == saved.active } }
            if record?.invalid == true { record = nil }
        }
        if saved.hostID == nil {
            // The host ID names this installation and is persisted before its first sign-in.
            saved.hostID = "urn:uuid:" + UUID().uuidString.lowercased()
            do { try persist(saved) } catch {
                throw ChatGPTAccountError("Keychain could not save Arya's sign-in identifier. Unlock your Mac and try again.", code: "chatgpt_storage")
            }
        }
        let host = saved.hostID!
        let id = UUID()
        let verifier = try Self.random(), state = try Self.random(), nonce = try Self.random()
        let listener = try await listen { [weak self] request in
            await self?.callback(id, request) ?? .refused
        }
        let redirect = "http://127.0.0.1:\(listener.port)/auth/callback"
        let url = Self.authorizeURL(endpoints.authorize, registration: record == nil, clientID: record?.clientID ?? Self.registrationClient,
                                    host: host, idTokenHint: record?.idToken, loginHint: record?.email, redirect: redirect,
                                    state: state, nonce: nonce, verifier: verifier, enablePlan: enablePlan)
        // A newer attempt may have started while the listener opened.
        finishAttempt(.cancelled, "Replaced by a newer sign-in.", close: true)
        var current = Attempt(id: id, phase: .waiting, message: "", registration: record == nil, clientID: record?.clientID ?? Self.registrationClient,
                              subject: record?.subject, verifier: verifier, state: state, nonce: nonce, redirect: redirect, authorizeURL: url, listener: listener, timer: nil)
        let timeout = attemptTimeout
        current.timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.expire(id)
        }
        attempt = current
        warning = nil
        notify()
        return await opener(url)
    }

    /// Opens the same pending attempt's page again. The URL never leaves this actor otherwise.
    public func reopenSignInPage() async -> Bool {
        guard let current = attempt, current.phase == .waiting else { return false }
        return await opener(current.authorizeURL)
    }

    @discardableResult public func cancelSignIn() -> Bool {
        guard let current = attempt, [.waiting, .exchanging].contains(current.phase) else { return false }
        finishAttempt(.cancelled, "ChatGPT sign-in was cancelled. Manual editing still works without an account.", close: true)
        notify()
        return true
    }

    private func expire(_ id: UUID) {
        guard attempt?.id == id, attempt?.phase == .waiting else { return }
        finishAttempt(.expired, "ChatGPT sign-in timed out. Continue with ChatGPT to try again.", close: true)
        notify()
    }

    private func finishAttempt(_ phase: ChatGPTStatus.Phase, _ message: String, close: Bool) {
        guard let current = attempt else { return }
        current.timer?.cancel()
        if close { current.listener.close() } else { current.listener.stop() }
        if [.waiting, .exchanging].contains(current.phase) { lastPhase = (phase, message) }
        else { lastPhase = (current.phase, current.message) }
        attempt = nil
    }

    static func authorizeURL(_ base: URL, registration: Bool, clientID: String, host: String, idTokenHint: String?, loginHint: String?,
                             redirect: String, state: String, nonce: String, verifier: String, enablePlan: Bool) -> URL {
        var items: [(String, String)] = [("client_id", clientID)]
        if registration { items.append(("agent_name_hint", agentName)) }
        items.append(("ext_agent_host_id", host))
        if !registration, let idTokenHint, !idTokenHint.isEmpty { items.append(("id_token_hint", idTokenHint)) }
        if !registration, let loginHint, !loginHint.isEmpty { items.append(("login_hint", loginHint)) }
        items += [("response_type", "code"), ("redirect_uri", redirect), ("scope", scopes.joined(separator: " ")), ("resource", resource),
                  ("state", state), ("nonce", nonce), ("code_challenge_method", "S256"), ("code_challenge", challenge(verifier))]
        if enablePlan { items.append(("prompt", "consent")) }
        return URL(string: base.absoluteString + "?" + form(items))!
    }

    static func challenge(_ verifier: String) -> String { base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    private func callback(_ id: UUID, _ request: ChatGPTLoopbackListener.Request) -> ChatGPTLoopbackListener.Response {
        guard var current = attempt, current.id == id, current.phase == .waiting else {
            return .init(status: 400, title: "Sign-in not recognized", text: "This sign-in does not match the one Arya started. Start again from Arya's Assistant settings.")
        }
        guard Self.same(request.query["state"] ?? "", current.state) else {
            // A stray or forged request does not end the real attempt.
            return .init(status: 400, title: "Sign-in not recognized", text: "This sign-in does not match the one Arya started. Start again from Arya's Assistant settings.")
        }
        if let error = request.query["error"] {
            let declined = error == "access_denied"
            finishAttempt(declined ? .cancelled : .failed, declined ? "ChatGPT sign-in was cancelled. Manual editing still works without an account." : "ChatGPT sign-in failed (\(Self.safeCode(error) ?? "unknown error")). Try again.", close: false)
            notify()
            return .init(status: 200, title: declined ? "Sign-in cancelled" : "Sign-in failed", text: "Return to Arya. You can close this tab.")
        }
        current.phase = .exchanging
        current.timer?.cancel()
        current.listener.stop()
        attempt = current
        notify()
        let code = request.query["code"], client = request.query["client_id"]
        Task { await self.complete(id, code: code, callbackClient: client) }
        return .init(status: 200, title: "Finishing sign-in", text: "Return to Arya to finish. You can close this tab.")
    }

    private func complete(_ id: UUID, code: String?, callbackClient: String?) async {
        do { try await exchange(id, code: code, callbackClient: callbackClient) }
        catch {
            guard attempt?.id == id, attempt?.phase == .exchanging else { return }
            let message = (error as? ChatGPTAccountError)?.message ?? "ChatGPT sign-in failed. Try again."
            // The callback page may still be on its way to the browser, so only stop listening.
            finishAttempt(.failed, message, close: false)
            notify()
        }
    }

    private func exchange(_ id: UUID, code: String?, callbackClient: String?) async throws {
        guard let current = attempt, current.id == id else { return }
        var clientID = current.clientID
        if current.registration {
            guard let callbackClient, Self.validClient(callbackClient) else { throw ChatGPTAccountError("ChatGPT did not finish registering Arya. Continue with ChatGPT to try again.", code: "chatgpt_registration") }
            clientID = callbackClient
        } else if let callbackClient, !callbackClient.isEmpty, callbackClient != clientID {
            throw ChatGPTAccountError("ChatGPT returned a different app registration. Arya kept your saved connection. Try again.", code: "chatgpt_registration")
        }
        guard let code, !code.isEmpty, code.count <= 4096 else { throw ChatGPTAccountError("ChatGPT returned no sign-in code. Try again.", code: "chatgpt_registration") }
        let response = try await post(endpoints.token, [("grant_type", "authorization_code"), ("client_id", clientID), ("code", code),
                                                         ("code_verifier", current.verifier), ("redirect_uri", current.redirect), ("resource", Self.resource)])
        let body = Self.object(response.data)
        guard (200..<300).contains(response.status) else {
            if Self.safeCode(body["error"]) == "invalid_grant" { throw ChatGPTAccountError("The ChatGPT sign-in code expired. Continue with ChatGPT again.", code: "chatgpt_code_expired") }
            throw ChatGPTAccountError("ChatGPT sign-in failed (\(Self.safeCode(body["error"]) ?? String(response.status))).", code: "chatgpt_exchange")
        }
        let tokens = try tokenSet(body, previous: nil)
        let claims = try await verifyIdentity(body["id_token"], clientID: clientID, nonce: current.nonce, subject: current.registration ? nil : current.subject)
        guard attempt?.id == id, attempt?.phase == .exchanging else {
            // Cancelled while the code was being exchanged: end the new session.
            if let refresh = tokens.refreshToken { let client = clientID; Task { _ = await self.revoke(refresh, client: client) } }
            return
        }
        var saved = vault ?? .empty
        if let existing = saved.accounts.first(where: { $0.clientID == clientID }), existing.subject != claims.subject {
            throw ChatGPTAccountError("ChatGPT returned a registration that belongs to another account. Arya kept your saved connections.", code: "chatgpt_account_mismatch")
        }
        saved.accounts.removeAll { $0.clientID == clientID || ($0.invalid && $0.subject == claims.subject) }
        var record = ChatGPTRecord(clientID: clientID, subject: claims.subject, email: String(claims.email.prefix(320)), issuer: endpoints.issuer,
                                   idToken: body["id_token"] as? String, accessToken: nil, refreshToken: nil, expiresAt: nil, earliestRefreshAt: nil,
                                   scopes: [], invalid: false, session: try Self.random(), savedAt: now().timeIntervalSince1970)
        tokens.apply(to: &record)
        saved.accounts.append(record)
        saved.accounts = Array(saved.accounts.suffix(32))
        saved.active = clientID
        do { try persist(saved) } catch {
            if let refresh = tokens.refreshToken { let client = clientID; Task { _ = await self.revoke(refresh, client: client) } }
            throw ChatGPTAccountError("Keychain could not save the ChatGPT sign-in. Unlock your Mac and try again.", code: "chatgpt_storage")
        }
        generation += 1
        refreshing = nil
        warning = nil
        let plan = record.scopes.contains(Self.planScope)
        finishAttempt(.done, plan ? "Signed in. Arya can use your ChatGPT plan." : "Signed in, but ChatGPT plan usage was not allowed. Turn it on to use the assistant.", close: false)
        notify()
    }

    // MARK: Sign-out

    public struct SignOutResult: Sendable, Equatable {
        public let signedOut: Bool
        public let revocationConfirmed: Bool
    }

    /// Ends the renewable session: revoke first, then clear locally even when revocation is not
    /// confirmed. The registration (client ID and identity) and the host ID stay for a later sign-in.
    public func signOut(account selected: String? = nil) async -> SignOutResult {
        finishAttempt(.cancelled, "ChatGPT sign-in was cancelled.", close: true)
        guard storage == .ready, let saved = vault else { return .init(signedOut: false, revocationConfirmed: true) }
        let selectedRecord: ChatGPTRecord?
        if let selected { selectedRecord = saved.accounts.first { Self.publicID($0.clientID) == selected } }
        else { selectedRecord = saved.accounts.first { pendingSignOuts[$0.clientID] != nil } ?? saved.accounts.first { $0.clientID == saved.active } }
        guard let record = selectedRecord,
              record.accessToken != nil || record.refreshToken != nil || pendingSignOuts[record.clientID] != nil else { return .init(signedOut: false, revocationConfirmed: true) }
        let clientID = record.clientID
        guard !signingOut.contains(clientID) else { return .init(signedOut: false, revocationConfirmed: false) }
        var pending = pendingSignOuts[clientID] ?? PendingSignOut(refreshToken: record.refreshToken, revocationConfirmed: record.refreshToken == nil)
        pendingSignOuts[clientID] = pending
        generation += 1
        refreshing = nil
        signingOut.insert(clientID)
        notify()
        if !pending.revocationConfirmed, let refresh = pending.refreshToken {
            pending.revocationConfirmed = await revoke(refresh, client: clientID)
            if pending.revocationConfirmed { pending.refreshToken = nil }
        }
        signingOut.remove(clientID)
        if var latest = vault, let index = latest.accounts.firstIndex(where: { $0.clientID == clientID }) {
            Self.clearSession(&latest.accounts[index], keepHint: false)
            do {
                try persist(latest)
                pendingSignOuts.removeValue(forKey: clientID)
                if pendingSignOuts.isEmpty { warning = nil }
            } catch {
                vault = latest
                pendingSignOuts[clientID] = pending
                warning = "Keychain could not remove the saved ChatGPT tokens. Arya stopped using them. Unlock your Mac, then choose Finish signing out."
            }
        }
        generation += 1
        notify()
        return .init(signedOut: true, revocationConfirmed: pending.revocationConfirmed)
    }

    func revoke(_ token: String, client: String) async -> Bool {
        for index in 0...retryDelays.count {
            if let response = try? await post(endpoints.revoke, [("token", token), ("token_type_hint", "refresh_token"), ("client_id", client)], timeout: 8) {
                if response.status == 200 { return true }
                if response.status < 500 { return false }
            }
            if index < retryDelays.count { try? await Task.sleep(nanoseconds: UInt64(retryDelays[index] * 1_000_000_000)) }
        }
        return false
    }

    public func acknowledgeWelcome() throws {
        guard storage == .ready, var saved = vault, !saved.welcomed else { return }
        saved.welcomed = true
        try persist(saved)
        notify()
    }

    // MARK: Tokens

    private func hasSession(_ record: ChatGPTRecord) -> Bool {
        guard !record.invalid, !signingOut.contains(record.clientID), record.accessToken != nil else { return false }
        return record.refreshToken != nil || (record.expiresAt ?? 0) > now().timeIntervalSince1970
    }
    private func planUsage(_ record: ChatGPTRecord) -> Bool { hasSession(record) && record.scopes.contains(Self.planScope) }
    private func fresh(_ record: ChatGPTRecord) -> Bool {
        let remaining = (record.expiresAt ?? 0) - now().timeIntervalSince1970
        return remaining > Self.refreshMargin || ((record.earliestRefreshAt ?? 0) > now().timeIntervalSince1970 && remaining > 60)
    }
    static func identity(_ record: ChatGPTRecord) -> String {
        SHA256.hash(data: Data("chatgpt\n\(record.clientID)\n\(record.subject)\n\(record.session ?? "")".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func credential(_ record: ChatGPTRecord) -> ChatGPTCredential {
        ChatGPTCredential(accessToken: record.accessToken ?? "", api: endpoints.api, identity: Self.identity(record))
    }
    private static func signInRequired(_ message: String = "Sign in to ChatGPT in Assistant settings to use your plan.") -> ChatGPTAccountError {
        ChatGPTAccountError(message, code: "chatgpt_sign_in_required")
    }

    /// A current access token for the active account. `identity` pins the run to the account that
    /// started it. One renewal runs at a time; it is not cancelled with the request that awaited it,
    /// so a rotated refresh token is always saved.
    public func credential(expecting identity: String?) async throws -> ChatGPTCredential {
        if let task = refreshing {
            let value = try await task.value
            if let identity, value.identity != identity { throw ChatGPTAccountError("The ChatGPT account changed during this request. Send it again to use the current account.", code: "chatgpt_account_changed") }
            return value
        }
        guard storage == .ready, let saved = vault, let record = saved.accounts.first(where: { $0.clientID == saved.active }), hasSession(record) else { throw Self.signInRequired() }
        if let identity, Self.identity(record) != identity { throw ChatGPTAccountError("The ChatGPT account changed during this request. Send it again to use the current account.", code: "chatgpt_account_changed") }
        guard record.scopes.contains(Self.planScope) else { throw ChatGPTAccountError("ChatGPT plan usage is off for this sign-in. Turn it on in Assistant settings.", code: "chatgpt_plan_disabled") }
        if fresh(record) { return credential(record) }
        let task = Task { try await self.renew() }
        refreshing = task
        let result = await task.result
        if refreshing == task { refreshing = nil }
        let value = try result.get()
        if let identity, value.identity != identity { throw ChatGPTAccountError("The ChatGPT account changed during this request. Send it again to use the current account.", code: "chatgpt_account_changed") }
        return value
    }

    private func renew() async throws -> ChatGPTCredential {
        let started = generation
        guard let saved = vault, let record = saved.accounts.first(where: { $0.clientID == saved.active }), hasSession(record) else { throw Self.signInRequired() }
        if fresh(record) { return credential(record) }
        let clientID = record.clientID
        let stillValid = (record.expiresAt ?? 0) - now().timeIntervalSince1970 > 60
        guard let refresh = record.refreshToken else {
            if stillValid { return credential(record) }
            clearAndSave(clientID, keepHint: true)
            throw Self.signInRequired("Your ChatGPT sign-in expired. Continue with ChatGPT to sign in again.")
        }
        let response: ChatGPTHTTPResponse
        do { response = try await post(endpoints.token, [("grant_type", "refresh_token"), ("client_id", clientID), ("refresh_token", refresh), ("resource", Self.resource)]) }
        catch {
            if stillValid, current(clientID, refresh: refresh, generation: started) != nil { return credential(record) }
            throw ChatGPTAccountError("OpenAI could not be reached to renew your ChatGPT sign-in. Check your connection and try again.", code: "chatgpt_refresh_unavailable")
        }
        let body = Self.object(response.data)
        // Sign-out or a switch during the request: never write the result back.
        guard let latest = current(clientID, refresh: refresh, generation: started) else {
            if (200..<300).contains(response.status), let rotated = body["refresh_token"] as? String { Task { _ = await self.revoke(rotated, client: clientID) } }
            throw ChatGPTAccountError("The ChatGPT account changed during this request. Send it again to use the current account.", code: "chatgpt_account_changed")
        }
        guard (200..<300).contains(response.status) else {
            let code = Self.safeCode(body["error"]) ?? ""
            if Self.unusableRefresh.contains(code) {
                clearAndSave(clientID, keepHint: true)
                throw Self.signInRequired("Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.")
            }
            if code == "invalid_client" {
                clearAndSave(clientID, keepHint: false, invalid: true)
                throw Self.signInRequired("OpenAI no longer accepts Arya's registration for this ChatGPT account. Continue with ChatGPT to register Arya again.")
            }
            if stillValid { return credential(latest) }
            throw ChatGPTAccountError("OpenAI could not renew your ChatGPT sign-in (\(code.isEmpty ? String(response.status) : code)). Try again shortly.", code: "chatgpt_refresh_unavailable")
        }
        let tokens = try tokenSet(body, previous: latest)
        var idToken: String?
        if body["id_token"] != nil {
            _ = try await verifyIdentity(body["id_token"], clientID: clientID, nonce: nil, subject: latest.subject)
            idToken = body["id_token"] as? String
        }
        guard var updated = vault, let index = updated.accounts.firstIndex(where: { $0.clientID == clientID }),
              current(clientID, refresh: refresh, generation: started) != nil else {
            if let rotated = tokens.refreshToken, rotated != refresh { Task { _ = await self.revoke(rotated, client: clientID) } }
            throw ChatGPTAccountError("The ChatGPT account changed during this request. Send it again to use the current account.", code: "chatgpt_account_changed")
        }
        tokens.apply(to: &updated.accounts[index])
        if let idToken { updated.accounts[index].idToken = idToken }
        updated.accounts[index].savedAt = now().timeIntervalSince1970
        do { try persist(updated); warning = nil } catch {
            // The old refresh token is already spent. Keep the new one for this session.
            vault = updated
            warning = "Keychain could not save the renewed ChatGPT sign-in. It works until Arya quits; then sign in again."
            notify()
        }
        return credential(updated.accounts[index])
    }

    private func current(_ clientID: String, refresh: String, generation started: Int) -> ChatGPTRecord? {
        guard generation == started, let saved = vault, saved.active == clientID,
              let record = saved.accounts.first(where: { $0.clientID == clientID }), record.refreshToken == refresh, hasSession(record) else { return nil }
        return record
    }

    private func clearAndSave(_ clientID: String, keepHint: Bool, invalid: Bool = false) {
        guard var saved = vault, let index = saved.accounts.firstIndex(where: { $0.clientID == clientID }) else { return }
        Self.clearSession(&saved.accounts[index], keepHint: keepHint)
        if invalid { saved.accounts[index].invalid = true }
        generation += 1
        do { try persist(saved) } catch { vault = saved }
        notify()
    }

    static func clearSession(_ record: inout ChatGPTRecord, keepHint: Bool) {
        record.accessToken = nil; record.refreshToken = nil; record.expiresAt = nil; record.earliestRefreshAt = nil
        record.scopes = []; record.session = nil
        if !keepHint { record.idToken = nil }
    }

    struct TokenSet {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Double
        let earliestRefreshAt: Double?
        let scopes: [String]
        func apply(to record: inout ChatGPTRecord) {
            record.accessToken = accessToken; record.refreshToken = refreshToken; record.expiresAt = expiresAt
            record.earliestRefreshAt = earliestRefreshAt; record.scopes = scopes
        }
    }

    private func tokenSet(_ body: [String: Any], previous: ChatGPTRecord?) throws -> TokenSet {
        let unreadable = ChatGPTAccountError("OpenAI returned an unreadable sign-in response.", code: "chatgpt_exchange")
        guard let access = body["access_token"] as? String, Self.usableToken(access),
              (body["token_type"] as? String).map({ $0.lowercased() == "bearer" }) ?? (body["token_type"] == nil),
              let expires = (body["expires_in"] as? NSNumber)?.doubleValue, expires.isFinite, expires > 0, expires <= 86_400 else { throw unreadable }
        if let refresh = body["refresh_token"], !((refresh as? String).map(Self.usableToken) ?? false) { throw unreadable }
        if let scope = body["scope"], !(scope is String) { throw unreadable }
        // Plan usage is decided only by granted scopes. A missing list grants nothing new.
        let scopes = (body["scope"] as? String).map { Array($0.split(whereSeparator: \.isWhitespace).map(String.init).prefix(32)) } ?? previous?.scopes ?? []
        return TokenSet(accessToken: access, refreshToken: body["refresh_token"] as? String ?? previous?.refreshToken,
                        expiresAt: now().timeIntervalSince1970 + expires, earliestRefreshAt: Self.timestamp(body["earliest_refresh_at"]), scopes: scopes)
    }

    // MARK: Models

    public func models() async throws -> [ChatGPTModel] {
        let current = try await credential(expecting: nil)
        var request = URLRequest(url: current.api.appendingPathComponent("models"))
        request.setValue("Bearer \(current.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15
        let response: ChatGPTHTTPResponse
        do { response = try await http(request) } catch { throw ChatGPTAccountError("Arya could not reach OpenAI to list ChatGPT models.", code: "chatgpt_network") }
        let body = Self.object(response.data, limit: 2 * 1024 * 1024)
        guard (200..<300).contains(response.status) else {
            let code = Self.safeCode((body["error"] as? [String: Any])?["code"]) ?? String(response.status)
            throw ChatGPTAccountError("OpenAI did not list ChatGPT models (\(code)).", code: response.status == 401 ? "chatgpt_not_authorized" : "chatgpt_models")
        }
        guard let rows = body["models"] as? [Any] else { throw ChatGPTAccountError("OpenAI returned an unreadable model list.", code: "chatgpt_models") }
        // Keep display models in the server's order. Show display_name; send slug.
        return Array(rows.compactMap { $0 as? [String: Any] }.filter { $0["visibility"] as? String == "list" && Self.validSlug($0["slug"] as? String ?? "") }
            .prefix(256).map { item in
                let slug = item["slug"] as! String
                let name = (item["display_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return ChatGPTModel(slug: slug, displayName: name.isEmpty ? slug : String(name.prefix(160)))
            })
    }

    // MARK: ID token

    struct Claims { let subject: String; let email: String }

    /// Mirrors https://developers.openai.com/siwc/website#6-verify-the-id-token.
    func verifyIdentity(_ value: Any?, clientID: String, nonce: String?, subject: String?) async throws -> Claims {
        func reject(_ message: String, _ code: String = "chatgpt_identity") -> ChatGPTAccountError { ChatGPTAccountError(message, code: code) }
        guard let token = value as? String, token.count <= 16_384 else { throw reject("OpenAI did not return an identity token.") }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, let headerData = Self.base64URLDecode(parts[0]), let claimData = Self.base64URLDecode(parts[1]),
              let signature = Self.base64URLDecode(parts[2]),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let claims = try? JSONSerialization.jsonObject(with: claimData) as? [String: Any] else { throw reject("OpenAI returned an unreadable identity token.") }
        guard header["alg"] as? String == "RS256", let kid = header["kid"] as? String, !kid.isEmpty, header["crit"] == nil else { throw reject("OpenAI returned an identity token Arya cannot verify.") }
        let key = try await signingKey(kid)
        var error: Unmanaged<CFError>?
        guard SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data((parts[0] + "." + parts[1]).utf8) as CFData, signature as CFData, &error) else {
            throw reject("The ChatGPT identity token signature is invalid.")
        }
        let seconds = now().timeIntervalSince1970
        let audience: [String] = (claims["aud"] as? String).map { [$0] } ?? (claims["aud"] as? [Any])?.compactMap { $0 as? String } ?? []
        guard claims["iss"] as? String == endpoints.issuer, audience.contains(clientID),
              audience.count == 1 || claims["azp"] as? String == clientID else { throw reject("The ChatGPT identity token was not issued to Arya.") }
        guard let exp = (claims["exp"] as? NSNumber)?.doubleValue, let iat = (claims["iat"] as? NSNumber)?.doubleValue, exp.isFinite, iat.isFinite,
              exp + Self.skew >= seconds, iat - Self.skew <= seconds,
              (claims["nbf"] as? NSNumber).map({ $0.doubleValue - Self.skew <= seconds }) ?? (claims["nbf"] == nil) else { throw reject("The ChatGPT identity token has expired. Try again.") }
        guard let sub = claims["sub"] as? String, !sub.isEmpty, sub.count <= 256,
              claims["sid"] == nil || !((claims["sid"] as? String)?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) else { throw reject("The ChatGPT identity token has no usable account identity.") }
        if let nonce { guard Self.same(claims["nonce"] as? String ?? "", nonce) else { throw reject("The ChatGPT sign-in did not match this attempt. Try again.") } }
        if let subject, sub != subject {
            throw reject("ChatGPT returned a different account than the one you chose. Arya kept your saved connection. Choose Use a different account to add another one.", "chatgpt_account_mismatch")
        }
        return Claims(subject: sub, email: claims["email"] as? String ?? "")
    }

    // Keys rotate, so an unfamiliar kid triggers one refetch. ID tokens only arrive from the token
    // endpoint over TLS, once per sign-in or refresh.
    private func signingKey(_ kid: String) async throws -> SecKey {
        if keys[kid] == nil { try await loadKeys() }
        guard let key = keys[kid] else { throw ChatGPTAccountError("OpenAI sign-in could not be verified. Try again.", code: "chatgpt_identity") }
        return key
    }

    private func loadKeys() async throws {
        var request = URLRequest(url: endpoints.jwks)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15
        guard let response = try? await http(request), response.status == 200 else { throw ChatGPTAccountError("OpenAI signing keys are unavailable. Try again shortly.", code: "chatgpt_identity") }
        var loaded: [String: SecKey] = [:]
        for jwk in (Self.object(response.data, limit: 64 * 1024)["keys"] as? [Any] ?? []).compactMap({ $0 as? [String: Any] }) {
            guard jwk["kty"] as? String == "RSA", let kid = jwk["kid"] as? String, !kid.isEmpty,
                  (jwk["use"] as? String).map({ $0 == "sig" }) ?? true, (jwk["alg"] as? String).map({ $0 == "RS256" }) ?? true,
                  let n = (jwk["n"] as? String).flatMap(Self.base64URLDecode), let e = (jwk["e"] as? String).flatMap(Self.base64URLDecode),
                  let key = Self.rsaPublicKey(modulus: n, exponent: e), SecKeyGetBlockSize(key) * 8 >= 2048 else { continue }
            loaded[kid] = key
        }
        keys = loaded
    }

    /// Builds an RSA public key from JWK `n` and `e` as a PKCS#1 RSAPublicKey DER structure.
    static func rsaPublicKey(modulus: Data, exponent: Data) -> SecKey? {
        func integer(_ bytes: Data) -> Data {
            var value = Data(bytes.drop { $0 == 0 })
            if value.isEmpty { value = Data([0]) }
            if value.first! & 0x80 != 0 { value.insert(0, at: 0) }
            return Data([0x02]) + length(value.count) + value
        }
        func length(_ count: Int) -> Data {
            if count < 0x80 { return Data([UInt8(count)]) }
            var bytes: [UInt8] = []; var value = count
            while value > 0 { bytes.insert(UInt8(value & 0xff), at: 0); value >>= 8 }
            return Data([0x80 | UInt8(bytes.count)] + bytes)
        }
        guard !modulus.isEmpty, !exponent.isEmpty, modulus.count <= 1024, exponent.count <= 16 else { return nil }
        let content = integer(modulus) + integer(exponent)
        let der = Data([0x30]) + length(content.count) + content
        return SecKeyCreateWithData(der as CFData, [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary, nil)
    }

    // MARK: HTTP

    private func post(_ url: URL, _ values: [(String, String)], timeout: TimeInterval = 20) async throws -> ChatGPTHTTPResponse {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(Self.form(values).utf8)
        return try await http(request)
    }

    static let liveHTTP: ChatGPTHTTPTransport = { request in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 60
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: ChatGPTNoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count <= 4 * 1024 * 1024 else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        if let id = response.value(forHTTPHeaderField: "x-request-id") { headers["x-request-id"] = id }
        return ChatGPTHTTPResponse(status: response.statusCode, data: data, headers: headers)
    }

    // MARK: Helpers

    /// The UI sees a short opaque label for each registration, never its client ID.
    public static func publicID(_ clientID: String) -> String {
        String(base64URL(Data(SHA256.hash(data: Data("arya-chatgpt:\(clientID)".utf8)))).prefix(16))
    }
    static func validClient(_ value: String) -> Bool {
        value != registrationClient && value.count >= 3 && value.count <= 200 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_.:-".contains($0)) }
    }
    static func validHostID(_ value: String) -> Bool {
        value.range(of: "^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    public static func validSlug(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._:-".contains($0)) }
    }
    static func usableToken(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 16_384 && value.allSatisfy { $0.isASCII && !$0.isWhitespace && !$0.isNewline }
    }
    static func safeCode(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 80,
              value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "_.-".contains($0)) }) else { return nil }
        return value
    }
    static func timestamp(_ value: Any?) -> Double? {
        if let number = (value as? NSNumber)?.doubleValue, number.isFinite { return number > 1e12 ? number / 1000 : number }
        if let text = value as? String, let date = ISO8601DateFormatter().date(from: text) { return date.timeIntervalSince1970 }
        return nil
    }
    static func object(_ data: Data, limit: Int = 256 * 1024) -> [String: Any] {
        guard data.count <= limit, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }
    static func same(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count, !x.isEmpty else { return false }
        return zip(x, y).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw ChatGPTAccountError("Arya could not create a secure sign-in value.", code: "chatgpt_random") }
        return base64URL(Data(bytes))
    }
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func base64URLDecode(_ value: String) -> Data? {
        guard value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return Data(base64Encoded: text)
    }
    static func form(_ values: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
        allowed.insert(charactersIn: "-._~")
        return values.map { "\($0.0.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&")
    }
}

final class ChatGPTNoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
