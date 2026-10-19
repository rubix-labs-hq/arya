import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor
enum NativeHandoff {
    static let type = "app.reel.project"
    #if os(iOS)
    private static let documentURLKey = UIDocument.userActivityURLKey
    #else
    private static let documentURLKey = NSUserActivityDocumentURLKey
    #endif

    static func activity(folder: URL, name: String) -> NSUserActivity? {
        let file = folder.appendingPathComponent("reel.project.json")
        guard (try? file.resourceValues(forKeys: [.isUbiquitousItemKey]).isUbiquitousItem) == true else { return nil }
        let activity = NSUserActivity(activityType: type)
        activity.title = "Edit \(name) in Arya"
        activity.userInfo = [documentURLKey: file]
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = false
        activity.becomeCurrent()
        return activity
    }

    static func folder(from activity: NSUserActivity) -> URL? {
        guard activity.activityType == type,
              let file = activity.userInfo?[documentURLKey] as? URL,
              file.isFileURL, file.lastPathComponent == "reel.project.json" else { return nil }
        return file.deletingLastPathComponent()
    }
}
