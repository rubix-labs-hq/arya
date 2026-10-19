import Foundation
import XCTest
@testable import ReelKit

final class CompanionPairingOfferTests: XCTestCase {
    private func link(_ endpoint: String, version: String = "1", extra: [URLQueryItem] = []) throws -> URL {
        var parts = URLComponents()
        parts.scheme = "reelcompanion"; parts.host = "offer"
        parts.queryItems = [URLQueryItem(name: "version", value: version), URLQueryItem(name: "endpoint", value: endpoint)] + extra
        return try XCTUnwrap(parts.url)
    }

    func testHTTPSRootCanonicalizesAndRoundTripsEndpointOnly() throws {
        for (input, expected) in [
            ("HTTPS://BRIDGE.EXAMPLE.TEST:443", "https://bridge.example.test/"),
            ("https://bridge.example.test:8443/", "https://bridge.example.test:8443/"),
            ("https://bridge.example.test./", "https://bridge.example.test./"),
            ("https://192.168.1.20/", "https://192.168.1.20/"),
            ("https://[2001:db8::20]/", "https://[2001:db8::20]/"),
            ("https://[2001:db8::20]:8443/", "https://[2001:db8::20]:8443/"),
        ] {
            let offer = try CompanionPairingOffer(endpoint: input)
            XCTAssertEqual(offer.endpoint, expected)
            XCTAssertEqual(try CompanionPairingOffer(link: offer.link), offer)
            let parts = try XCTUnwrap(URLComponents(url: offer.link, resolvingAgainstBaseURL: false))
            XCTAssertEqual(parts.queryItems?.map(\.name), ["version", "endpoint"])
            XCTAssertNil(parts.user); XCTAssertNil(parts.password); XCTAssertNil(parts.fragment)
            XCTAssertLessThanOrEqual(offer.link.absoluteString.utf8.count, CompanionPairingOffer.maximumLinkBytes)
        }
    }

    func testUnknownDuplicateMissingAndUnsupportedFieldsDeny() throws {
        let endpoint = "https://bridge.example.test/"
        for fields in [
            [URLQueryItem(name: "token", value: "PRIVATE_TOKEN")],
            [URLQueryItem(name: "nonce", value: "nonce")],
            [URLQueryItem(name: "sharing", value: "approved")],
            [URLQueryItem(name: "version", value: "1")],
            [URLQueryItem(name: "endpoint", value: endpoint)],
        ] {
            XCTAssertThrowsError(try CompanionPairingOffer(link: link(endpoint, extra: fields)))
        }
        for version in ["0", "2", "true", "01", ""] {
            XCTAssertThrowsError(try CompanionPairingOffer(link: link(endpoint, version: version)))
        }
        for value in ["reelcompanion://offer", "reelcompanion://offer?version=1", "reelcompanion://offer?endpoint=https%3A%2F%2Fbridge.example.test%2F", "reelcompanion://offer?version=1&endpoint"] {
            XCTAssertThrowsError(try CompanionPairingOffer(link: XCTUnwrap(URL(string: value))))
        }
    }

    func testWrongRouteCredentialsFragmentAndPathDeny() throws {
        let valid = try link("https://bridge.example.test/")
        for value in [
            valid.absoluteString.replacingOccurrences(of: "reelcompanion:", with: "reelagent:"),
            valid.absoluteString.replacingOccurrences(of: "//offer?", with: "//connect?"),
            valid.absoluteString.replacingOccurrences(of: "//offer?", with: "//offer/?"),
            valid.absoluteString.replacingOccurrences(of: "//offer?", with: "//offer:443?"),
            valid.absoluteString.replacingOccurrences(of: "//offer?", with: "//user:secret@offer?"),
            valid.absoluteString + "#PRIVATE_TOKEN",
        ] { XCTAssertThrowsError(try CompanionPairingOffer(link: XCTUnwrap(URL(string: value)))) }
    }

    func testLoopbackUnspecifiedAndAmbiguousNumericAliasesDeny() throws {
        for host in ["localhost", "LOCALHOST", "localhost.", "sub.localhost", "localhost.example.test", "127.0.0.1", "127.1.2.3", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "127.0x0.0.1", "127.0.0x0.1", "127.0.0.0x1", "127.0x00000001", "0177.0x0.0.1", "0.0.0.0", "0.1.2.3", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[::7f00:1]"] {
            XCTAssertThrowsError(try CompanionPairingOffer(endpoint: "https://\(host)/"), host)
        }
        for host in ["0xc0.0250.1.20", "0xc0a80114", "0300.0250.1.20"] {
            XCTAssertThrowsError(try CompanionPairingOffer(endpoint: "https://\(host)/"), "Ambiguous non-loopback numeric aliases also fail: \(host)")
        }
    }

    func testEndpointMustBeCredentialFreeRootHTTPSWithinBounds() throws {
        for endpoint in [
            "http://192.168.1.20/", "http://127.0.0.1:8877/", "https://user:PRIVATE_TOKEN@bridge.example.test/",
            "https://bridge.example.test/api/", "https://bridge.example.test/%2F", "https://bridge.example.test/?token=PRIVATE_TOKEN",
            "https://bridge.example.test/#PRIVATE_TOKEN", "https://bridge.example.test:0/", "https://bridge.example.test:65536/",
            " https://bridge.example.test/", "https://bridge.example.test/\n", "https://bridge.example.test/\u{0}",
            "https://" + String(repeating: "a", count: 2_048) + "/",
        ] { XCTAssertThrowsError(try CompanionPairingOffer(endpoint: endpoint)) }
        let oversized = try link("https://bridge.example.test/", extra: [URLQueryItem(name: "unused", value: String(repeating: "x", count: 4_096))])
        XCTAssertThrowsError(try CompanionPairingOffer(link: oversized))
    }

    func testInvalidOfferErrorsNeverEchoSecretPayloadAndReplayStaysAddressOnly() throws {
        let raw = try link("https://bridge.example.test/?token=PRIVATE_TOKEN")
        do { _ = try CompanionPairingOffer(link: raw); XCTFail("A URL token must be rejected") }
        catch { XCTAssertFalse(error.localizedDescription.contains("PRIVATE_TOKEN")) }
        let offer = try CompanionPairingOffer(endpoint: "https://bridge.example.test/")
        XCTAssertEqual(try CompanionPairingOffer(link: offer.link), try CompanionPairingOffer(link: offer.link))
        XCTAssertFalse(offer.link.absoluteString.contains("token"))
        XCTAssertFalse(offer.link.absoluteString.contains("sharing"))
    }

    func testRawNumericAndEncodedHostsDenyInDirectAndVersionedLinkForms() throws {
        for host in [
            "0177.0.0.1", "127.1", "2130706433", "0x7f000001", "127.0x0.0.1", "127.0.0x0.1", "127.0.0.0x1", "127.0x00000001", "0177.0x0.0.1",
            "0192.168.1.20", "192.168.001.20", "0300.0250.1.20", "0xc0.0250.1.20", "0xc0a80114",
            "127.0.0.1.", "0177.0.0.1.", "127.0x0.0.1.", "192.168.1.20.",
            "%31%39%32.168.1.20", "%62ridge.example.test", "bridge%2Eexample.test", "[fe80::20%25en0]", "[::ffff:0177.0.0.1]", "[::ffff:192.168.001.20]",
        ] {
            let endpoint = "https://\(host)/"
            let versioned = try link(endpoint)
            let fields = try XCTUnwrap(URLComponents(url: versioned, resolvingAgainstBaseURL: false)?.queryItems)
            XCTAssertEqual(fields.first(where: { $0.name == "endpoint" })?.value, endpoint, "The once-decoded query must preserve raw endpoint text")
            XCTAssertThrowsError(try CompanionPairingOffer(endpoint: endpoint), "Direct raw host: \(host)")
            XCTAssertThrowsError(try CompanionPairingOffer(link: versioned), "Versioned raw host: \(host)")
        }
    }

    func testRawAuthorityAndPortCannotBeReinterpretedByFoundation() throws {
        for endpoint in [
            "https:///bridge.example.test/", "https://bridge.example.test//", "https://bridge.example.test\\owner/",
            "https://bridge.example.test@other.example.test/", "https://2001:db8::20/", "https://[192.168.1.20]/",
            "https://[2001:db8::20]extra/", "https://bridge.example.test:/", "https://bridge.example.test:08443/",
            "https://bridge.example.test:+443/", "https://bridge.example.test:443:1/", "https://brídge.example.test/",
        ] {
            XCTAssertThrowsError(try CompanionPairingOffer(endpoint: endpoint))
            XCTAssertThrowsError(try CompanionPairingOffer(link: link(endpoint)))
        }
    }
}
