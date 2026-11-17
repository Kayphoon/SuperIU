import AppKit
import ScreenCaptureKit

public enum CaptureError: LocalizedError {
    case permissionRequired, displayUnavailable, invalidSelection, allocationFailed

    public var errorDescription: String? {
        switch self {
        case .permissionRequired: return "请在系统设置 → 隐私与安全性 → 屏幕与系统录音中允许 SuperIU Capture，然后重试。"
        case .displayUnavailable: return "显示器已改变，请重新截图。"
        case .invalidSelection: return "选区为空或过大，请缩小选区。"
        case .allocationFailed: return "无法创建截图图像。"
        }
    }
}

public struct DisplayFrame {
    public let frame: CGRect
    public let image: CGImage
}

@MainActor
public final class ScreenGrabber {
    public init() {}

    public func capture() async throws -> [DisplayFrame] {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            throw CaptureError.permissionRequired
        }
        let screens = NSScreen.screens
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ownApplications = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        var frames: [DisplayFrame] = []
        for screen in screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                  let display = content.displays.first(where: { $0.displayID == number.uint32Value }) else {
                throw CaptureError.displayUnavailable
            }
            let filter = SCContentFilter(display: display, excludingApplications: ownApplications, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = CGDisplayPixelsWide(display.displayID)
            configuration.height = CGDisplayPixelsHigh(display.displayID)
            configuration.showsCursor = false
            configuration.capturesAudio = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            try Task.checkCancellation()
            frames.append(DisplayFrame(frame: screen.frame, image: image))
        }
        guard screens.map(\.frame) == NSScreen.screens.map(\.frame) else {
            throw CaptureError.displayUnavailable
        }
        return frames
    }
}
