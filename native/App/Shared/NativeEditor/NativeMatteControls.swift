import SwiftUI

/// A matte uses the shared operation, so it is saved with the project and undone
/// in the same history as timeline edits and assistant changes.
struct NativeMatteControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip

    private let modes = [
        ("", "None"), ("alpha", "Alpha"), ("alphaInverted", "Alpha inverted"),
        ("luma", "Luma"), ("lumaInverted", "Luma inverted"),
    ]
    private var candidates: [NativeClip] {
        model.tracks.filter { $0.kind == "video" }.flatMap(\.clips)
            .filter { $0.id != clip.id && !["null", "adjustment", "caption", "audio"].contains($0.kind) }
    }
    var body: some View {
        let matte = clip.fields.dictionary("matte")
        let mode = matte.string("mode")
        let source = matte.string("source")
        let version = model.version
        GroupBox("Track matte") {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Matte mode", selection: Binding(get: { mode }, set: { value in
                    let value: Any = value.isEmpty ? NSNull() : ["mode": value, "source": source] as [String: Any]
                    model.edit(["op": "matte", "id": clip.id, "matte": value], expectedVersion: version)
                })) {
                    ForEach(modes, id: \.0) { Text($0.1).tag($0.0) }
                }
                .accessibilityIdentifier("native.matte.mode")
                if !mode.isEmpty {
                    Picker("Matte source", selection: Binding(get: { source }, set: { value in
                        model.edit(["op": "matte", "id": clip.id, "matte": ["mode": mode, "source": value]], expectedVersion: version)
                    })) {
                        Text("Layer above").tag("")
                        if !source.isEmpty && !candidates.contains(where: { $0.id == source }) {
                            Text("Unavailable layer (\(source))").tag(source)
                        }
                        ForEach(candidates, id: \.id) { Text("\($0.name) (\($0.id))").tag($0.id) }
                    }
                    .accessibilityIdentifier("native.matte.source")
                    Text("The source controls this layer's visibility and is hidden from the composite. Where the source has no picture, its matte is transparent.")
                        .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                }
            }.padding(4)
        }
        .disabled(model.tracks.first(where: { $0.clips.contains(where: { $0.id == clip.id }) })?.fields.flag("locked") == true)
    }
}
