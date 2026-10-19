import Foundation
import CoreText
import CoreGraphics

let args = CommandLine.arguments
let fontURL = URL(fileURLWithPath: args[1])
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
let descriptors = CTFontManagerCreateFontDescriptorsFromURL(fontURL as CFURL)! as! [CTFontDescriptor]
let variation = [NSNumber(value: 2003265652): NSNumber(value: Double(args[4])!)]
let descriptor = CTFontDescriptorCreateCopyWithAttributes(descriptors[0], [kCTFontVariationAttribute: variation] as CFDictionary)
let font = CTFontCreateWithFontDescriptor(descriptor, CGFloat(Double(args[3])!), nil)
let attributed = NSAttributedString(string: args[2], attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
let line = CTLineCreateWithAttributedString(attributed)
var commands: [String] = []
func number(_ value: CGFloat) -> String { String(format: "%.3f", Double(value)) }
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let count = CTRunGetGlyphCount(run)
  var glyphs = [CGGlyph](repeating: 0, count: count)
  var positions = [CGPoint](repeating: .zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
  for index in 0..<count {
    guard let path = CTFontCreatePathForGlyph(font, glyphs[index], nil) else { continue }
    let offset = positions[index]
    func point(_ p: CGPoint) -> String { "\(number(p.x + offset.x)) \(number(-p.y - offset.y))" }
    path.applyWithBlock { pointer in
      let element = pointer.pointee
      switch element.type {
      case .moveToPoint: commands.append("M" + point(element.points[0]))
      case .addLineToPoint: commands.append("L" + point(element.points[0]))
      case .addQuadCurveToPoint: commands.append("Q" + point(element.points[0]) + " " + point(element.points[1]))
      case .addCurveToPoint: commands.append("C" + point(element.points[0]) + " " + point(element.points[1]) + " " + point(element.points[2]))
      case .closeSubpath: commands.append("Z")
      @unknown default: break
      }
    }
  }
}
let result: [String: Any] = ["d": commands.joined(), "width": CTLineGetTypographicBounds(line, nil, nil, nil)]
let json = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
