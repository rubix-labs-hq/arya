import SwiftUI

struct NativeCurveEditor: View {
    let points: [[Double]]
    let commit: ([[Double]]) -> Void
    @State private var draft: [[Double]] = []
    @State private var selected: Int?
    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                let values = draft.isEmpty ? points : draft
                var grid = Path()
                for step in 0...4 {
                    let t = Double(step) / 4
                    grid.move(to: CGPoint(x: size.width * t, y: 0)); grid.addLine(to: CGPoint(x: size.width * t, y: size.height))
                    grid.move(to: CGPoint(x: 0, y: size.height * t)); grid.addLine(to: CGPoint(x: size.width, y: size.height * t))
                }
                context.stroke(grid, with: .color(.secondary.opacity(0.25)), lineWidth: 1)
                var curve = Path()
                for (index, point) in values.enumerated() where point.count == 2 {
                    let position = CGPoint(x: point[0] * size.width, y: (1 - point[1]) * size.height)
                    if index == 0 { curve.move(to: position) } else { curve.addLine(to: position) }
                    context.fill(Path(ellipseIn: CGRect(x: position.x - 4, y: position.y - 4, width: 8, height: 8)), with: .color(.accentColor))
                }
                context.stroke(curve, with: .color(.accentColor), lineWidth: 2)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                if selected == nil {
                    draft = points
                    let distances = draft.map { hypot($0[0] * geometry.size.width - value.startLocation.x, (1 - $0[1]) * geometry.size.height - value.startLocation.y) }
                    if let distance = distances.min(), distance < 24 { selected = distances.firstIndex(of: distance) }
                    else if draft.count < 16 { draft.append([0, 0]); selected = draft.count - 1 }
                }
                guard let selected else { return }
                draft[selected] = [min(1, max(0, value.location.x / geometry.size.width)), min(1, max(0, 1 - value.location.y / geometry.size.height))]
            }.onEnded { _ in
                guard selected != nil else { return }
                let sorted = draft.sorted { $0[0] < $1[0] }
                var unique: [[Double]] = []
                for point in sorted where unique.last.map({ point[0] - $0[0] > 0.001 }) ?? true { unique.append(point) }
                if unique.count >= 2 { commit(unique) }
                selected = nil; draft = []
            })
        }.frame(height: 140).accessibilityLabel("Color curve. Drag a point or touch the graph to add a point.")
    }
}
