import SwiftUI

struct NativeRenderQueue: View {
    @ObservedObject var model: NativeEditorModel

    private var jobs: [[String: Any]] {
        model.jobs.filter { $0.string("kind") == "export" }
            .sorted { $0.number("created") < $1.number("created") }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Render queue").font(.subheadline.weight(.semibold))
            Text("Exports run in order. Keep the project open until they finish. Changing the timeline or its media cancels pending exports; completed files remain in Saved exports.")
                .font(.caption).foregroundStyle(NativeEditorStyle.muted)
            if jobs.isEmpty {
                Text("Choose your settings, then export to add a render.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            }
            ForEach(jobs, id: \.jobID) { job in
                let spec = job.dictionary("spec")
                let name = job.string("output", spec.string("out", job.string("id")))
                let state = job.string("state")
                let active = ["queued", "running", "rendering"].contains(state)
                let cancelled = job.string("error").lowercased().contains("cancelled")
                VStack(alignment: .leading, spacing: 5) {
                    Text((name as NSString).lastPathComponent).font(.caption.weight(.semibold)).lineLimit(2)
                    Text(NativeDeliverPanel.presetName(spec.string("preset"))).font(.caption2).foregroundStyle(.secondary)
                    HStack {
                        Text(cancelled ? "Cancelled" : state == "queued" ? "Waiting" : state == "done" ? "Completed" : state.capitalized)
                            .font(.caption).accessibilityIdentifier("native.render.state")
                        Spacer()
                        if active {
                            Button("Cancel") {
                                model.perform { _ = try await model.call("/api/jobs/cancel", ["id": job.string("id")]) }
                            }.accessibilityLabel("Cancel \((name as NSString).lastPathComponent)")
                        }
                    }
                    if active { ProgressView(value: min(1, max(0, job.number("progress")))) }
                    if !job.string("deliveryWarning").isEmpty { Text(job.string("deliveryWarning")).font(.caption).foregroundStyle(.orange) }
                    if !cancelled && !job.string("error").isEmpty { Text(job.string("error")).font(.caption).foregroundStyle(.red) }
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

private extension Dictionary where Key == String, Value == Any {
    var jobID: String { string("id") }
}
