import SwiftUI

struct NativeBrandMark: View {
    var body: some View {
        ZStack {
            CutAStems().fill(NativeEditorStyle.text)
            CutACrossbar().fill(NativeEditorStyle.accent)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private struct CutAStems: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: 7, y: 54))
            path.addLines([CGPoint(x: 28, y: 10), CGPoint(x: 38, y: 10), CGPoint(x: 17, y: 54)])
            path.closeSubpath()
            path.move(to: CGPoint(x: 38, y: 20))
            path.addLines([CGPoint(x: 58, y: 54), CGPoint(x: 46, y: 54), CGPoint(x: 32, y: 30)])
            path.closeSubpath()
            return path.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64)
                .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
        }
    }

    private struct CutACrossbar: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: 25, y: 34))
            path.addLines([CGPoint(x: 44, y: 34), CGPoint(x: 49, y: 43), CGPoint(x: 21, y: 43)])
            path.closeSubpath()
            return path.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64)
                .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
        }
    }
}

struct NativeBrandWordmark: View {
    var body: some View {
        Image("AryaWordmark")
            .resizable()
            .scaledToFit()
            .accessibilityLabel("Arya")
    }
}
