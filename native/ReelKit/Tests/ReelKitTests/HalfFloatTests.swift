import XCTest
@testable import ReelKit

final class HalfFloatTests: XCTestCase {
    func testEveryBinary16ValueRoundTripsAndKnownBoundariesRoundToEven() {
        for raw in UInt32(0)...65535 {
            let bits = UInt16(raw), value = NativeHalfFloat.value(bits)
            if bits & 0x7c00 == 0x7c00 && bits & 1023 != 0 { XCTAssertTrue(value.isNaN) }
            else { XCTAssertEqual(NativeHalfFloat.bits(value), bits) }
        }
        for (value, bits): (Float, UInt16) in [(0,0),(-0.0,0x8000),(1,0x3c00),(-2,0xc000),(65504,0x7bff),(65520,0x7c00),(Float.infinity,0x7c00),(-Float.infinity,0xfc00),(0.00006103515625,0x0400),(0.000000059604644775390625,1),(0.0000000298023223876953125,0),(1.00048828125,0x3c00),(1.00146484375,0x3c02)] {
            XCTAssertEqual(NativeHalfFloat.bits(value), bits)
        }
    }

    #if arch(arm64)
    func testPortableConversionMatchesNativeHalfForEveryValueAndFloatSamples() {
        for raw in UInt32(0)...65535 {
            let bits = UInt16(raw), reference = Float(Float16(bitPattern: bits))
            let actual = NativeHalfFloat.value(bits)
            if reference.isNaN { XCTAssertTrue(actual.isNaN) } else { XCTAssertEqual(actual.bitPattern, reference.bitPattern) }
        }
        var state: UInt32 = 0x9e3779b9
        for _ in 0..<200000 {
            state = state &* 1664525 &+ 1013904223
            let value = Float(bitPattern: state), actual = NativeHalfFloat.bits(value)
            if value.isNaN { XCTAssertTrue(NativeHalfFloat.value(actual).isNaN) }
            else { XCTAssertEqual(actual, Float16(value).bitPattern) }
        }
    }
    #endif
}
