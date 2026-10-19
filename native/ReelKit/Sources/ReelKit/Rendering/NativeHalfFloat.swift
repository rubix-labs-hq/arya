import Foundation

/// IEEE binary16 storage for Metal textures on both Intel and Apple Silicon.
enum NativeHalfFloat {
    static func bits(_ value: Float) -> UInt16 {
        let raw = value.bitPattern, sign = UInt16((raw >> 16) & 0x8000)
        let exponent = Int((raw >> 23) & 255), fraction = raw & 0x7fffff
        if exponent == 255 { return sign | (fraction == 0 ? 0x7c00 : 0x7e00 | UInt16(fraction >> 13)) }
        if exponent > 142 { return sign | 0x7c00 }
        if exponent < 102 { return sign }
        if exponent < 113 {
            let mantissa = fraction | 0x800000, shift = 126 - exponent
            let truncated = mantissa >> shift, remainder = mantissa & ((1 << shift) - 1), halfway: UInt32 = 1 << (shift - 1)
            let rounded = truncated + (remainder > halfway || remainder == halfway && truncated & 1 == 1 ? 1 : 0)
            return sign | UInt16(rounded)
        }
        let truncated = UInt32(exponent - 112) << 10 | fraction >> 13, remainder = fraction & 0x1fff
        let rounded = truncated + (remainder > 0x1000 || remainder == 0x1000 && truncated & 1 == 1 ? 1 : 0)
        return sign | UInt16(rounded)
    }

    static func value(_ bits: UInt16) -> Float {
        let sign = UInt32(bits & 0x8000) << 16, exponent = UInt32((bits >> 10) & 31)
        var fraction = UInt32(bits & 1023)
        if exponent == 0 {
            if fraction == 0 { return Float(bitPattern: sign) }
            var normalizedExponent: UInt32 = 113
            while fraction & 1024 == 0 { fraction <<= 1; normalizedExponent -= 1 }
            return Float(bitPattern: sign | normalizedExponent << 23 | (fraction & 1023) << 13)
        }
        return Float(bitPattern: sign | (exponent == 31 ? 255 : exponent + 112) << 23 | fraction << 13)
    }
}
