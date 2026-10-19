// swift-tools-version: 5.10
// ReelKit: the Reel backend in Swift. It owns a project folder, applies edits with the shared
// JavaScript core in JavaScriptCore, and makes media derivatives with AVFoundation. It has no
// UI and no WebKit, so the web-hosted app today and a native editor later can both use it.

import PackageDescription

let package = Package(
    name: "ReelKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "ReelKit", targets: ["ReelKit"]),
    ],
    targets: [
        .target(name: "NativeProjectIO", publicHeadersPath: "include"),
        .target(name: "ReelKit", dependencies: ["NativeProjectIO"]),
        .testTarget(name: "ReelKitTests", dependencies: ["ReelKit"], resources: [.copy("Fixtures")]),
    ]
)
