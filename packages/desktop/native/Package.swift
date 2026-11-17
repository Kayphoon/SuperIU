// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SuperIUNative",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SuperCapture", targets: ["SuperCapture"]),
        .library(name: "SuperClipboard", targets: ["SuperClipboard"]),
        .executable(name: "SuperIUNative", targets: ["SuperIUNative"])
    ],
    targets: [
        .target(name: "SuperCapture"),
        .target(name: "SuperClipboard"),
        .executableTarget(name: "SuperIUNative", dependencies: ["SuperCapture", "SuperClipboard"]),
        .testTarget(name: "SuperCaptureTests", dependencies: ["SuperCapture"]),
        .testTarget(name: "SuperClipboardTests", dependencies: ["SuperClipboard"])
    ]
)
