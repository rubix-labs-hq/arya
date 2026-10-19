import AppKit
import WebKit

/// The editor's web view. Files dragged in from Finder are imported by the app directly
/// (copied into the project's media folder) instead of crossing into the page as bytes, so
/// a multi-gigabyte clip imports at disk speed. Drags inside the page (media onto the
/// timeline) carry no file URLs and reach the editor as usual.
final class ReelWebView: WKWebView {
    var onDropFiles: (([URL]) -> Void)?

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        fileURLs(sender).isEmpty ? super.prepareForDragOperation(sender) : true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        onDropFiles?(urls)
        return true
    }
}
