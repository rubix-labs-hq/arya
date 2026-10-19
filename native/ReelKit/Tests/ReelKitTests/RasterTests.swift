import CoreGraphics
import CoreText
import XCTest
@testable import ReelKit

final class RasterTests: XCTestCase {
    func testTitleCanvasMetricsMatchCSSFonts() throws {
        for (text, size, weight, width, height, top, bottom) in [("Golden",120.0,700.0,145,54,10,40),("MATTE",260.0,900.0,301,108,18,80)] {
            let drawn = try NativeRasterizer().title(["text":text,"font":"Helvetica Neue","size":size,"weight":weight,"align":"center"],state:[:],scale:1/3)
            XCTAssertEqual(drawn.image.width,width); XCTAssertEqual(drawn.image.height,height)
            let rows = nonemptyRows(drawn.image)
            XCTAssertEqual(rows.first,top); XCTAssertEqual(rows.last,bottom)
        }
    }

    func testBundledInterWrapAndAutoWidthFooter() throws {
        let fonts = Support.nativeDir.deletingLastPathComponent().appendingPathComponent("editor/web/fonts")
        for name in ["InterVariable.ttf","InterVariable-Italic.ttf","MrsSaintDelafield-Regular.ttf"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath:fonts.appendingPathComponent(name).path))
            CTFontManagerRegisterFontsForURL(fonts.appendingPathComponent(name) as CFURL,.process,nil)
        }
        let raster = NativeRasterizer()
        let heading = try raster.title(["text":"EDITABLE HEADINGS WRAP TO TWO LINES","font":"Inter","weight":800,"size":80,"tracking":-0.4,"lineHeight":0.94,"align":"left","box":["width":936,"height":150,"wrap":true,"alignY":"top"]],state:[:],scale:1)
        XCTAssertEqual(rowGroups(heading.image),2)
        let body = try raster.title(["text":"SHAPES, PATHS, GRADIENTS, AND EDITABLE TEXT.","font":"Inter","weight":900,"size":100,"tracking":-3,"lineHeight":0.94,"align":"left","box":["width":936,"height":282,"wrap":true]],state:[:],scale:1)
        XCTAssertEqual(rowGroups(body.image,maximumX:400),3)
        let footer = try raster.title(["text":"GO ON 43","font":"Inter","weight":800,"size":38,"tracking":2.66,"align":"left","box":["width":202,"height":38,"wrap":false]],state:[:],scale:1)
        XCTAssertEqual(rowGroups(footer.image),1)
        XCTAssertGreaterThan(footer.image.width,210,"auto-width text can extend beyond its nominal box")
        let script = CTFontCreateWithName("MrsSaintDelafield-Regular" as CFString,32,nil)
        XCTAssertEqual(CTFontCopyFamilyName(script) as String,"Mrs Saint Delafield")
    }
}

private func nonemptyRows(_ image:CGImage,maximumX:Int?=nil)->[Int] {
    let bytes=Array(try! XCTUnwrap(image.dataProvider?.data) as Data)
    return (0..<image.height).filter {y in (0..<min(image.width,maximumX ?? image.width)).contains {x in bytes[y*image.bytesPerRow+x*4+3]>0}}
}

private func rowGroups(_ image:CGImage,maximumX:Int?=nil)->Int {
    let rows=nonemptyRows(image,maximumX:maximumX)
    return rows.isEmpty ? 0 : zip(rows,rows.dropFirst()).reduce(1) { $0 + ($1.1 > $1.0+1 ? 1 : 0) }
}
