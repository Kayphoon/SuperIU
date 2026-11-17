import AppKit
import SuperCapture
import SuperClipboard

@main
@MainActor
enum SuperIUNativeApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = CaptureAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class CaptureAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var store: ClipboardStore?
    private var monitor: PasteboardMonitor?
    private var overlay: OverlayWindowController?
    private var history: HistoryPanel?
    private let keys = GlobalHotKeys()
    private let ocr = OCRService()
    private let notice = CopyNotice()
    private var ocrTask: Task<Void, Never>?
    private var pendingInput = ""
    private var persistenceItem: NSMenuItem?
    private var clearItem: NSMenuItem?
    private var resetClear: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: false)
            let store = try ClipboardStore(directory: caches.appendingPathComponent("com.superiu.capture", isDirectory: true))
            self.store = store
            monitor = PasteboardMonitor(store: store)
            store.onError = { [weak self] error in self?.show(error) }
            monitor?.onError = { [weak self] error in self?.show(error) }
            let overlay = OverlayWindowController()
            overlay.onCapture = { [weak self] image, textOnly in self?.captured(image, textOnly: textOnly) }
            overlay.onError = { [weak self] error in self?.show(error) }
            self.overlay = overlay
            let history = HistoryPanel(store: store)
            history.onError = { [weak self] error in self?.show(error) }
            self.history = history
            installMenu()
            keys.capture = { [weak self] in self?.capture() }
            keys.history = { [weak self] in self?.showHistory() }
            do { try keys.start() } catch {
                fputs("SuperIU Capture: \(error.localizedDescription)\n", stderr)
                announce(error.localizedDescription)
            }
            monitor?.start()
            if CommandLine.arguments.contains("--hosted") {
                FileHandle.standardInput.readabilityHandler = { [weak self] handle in
                    let data = handle.availableData
                    DispatchQueue.main.async {
                        guard let self else { return }
                        if data.isEmpty {
                            NSApp.terminate(nil)
                            return
                        }
                        self.pendingInput += String(decoding: data, as: UTF8.self)
                        if self.pendingInput.contains("quit\n") || self.pendingInput.utf8.count > 1024 {
                            NSApp.terminate(nil)
                        }
                    }
                }
            }
            print("SUPERIU_NATIVE_READY")
            fflush(stdout)
        } catch {
            fputs("SuperIU Capture: \(error.localizedDescription)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    private func installMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "viewfinder", accessibilityDescription: "SuperIU 截图与剪贴板")
        let menu = NSMenu()
        menu.addItem(action("截图", #selector(capture), key: "2"))
        menu.addItem(action("剪贴板历史", #selector(showHistory), key: "v"))
        menu.addItem(.separator())
        let persistence = action("保存图片历史到缓存（最多 25 张 / 50 MB）", #selector(togglePersistence))
        persistence.state = store?.imagePersistenceEnabled == true ? .on : .off
        menu.addItem(persistence)
        persistenceItem = persistence
        let clear = action("清空历史", #selector(clearHistory))
        menu.addItem(clear)
        clearItem = clear
        menu.addItem(.separator())
        menu.addItem(action("退出截图与剪贴板", #selector(quit)))
        item.menu = menu
        statusItem = item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        if !key.isEmpty { item.keyEquivalentModifierMask = [.command, .shift] }
        return item
    }

    @objc private func capture() {
        guard ocrTask == nil else {
            announce("正在识别文字，请稍后再截图。")
            return
        }
        notice.close()
        history?.window?.orderOut(nil)
        overlay?.present()
    }

    @objc private func showHistory() {
        overlay?.cancel()
        history?.present()
    }

    private func captured(_ image: CGImage, textOnly: Bool) {
        guard let monitor, let store else { return }
        let initialChange = NSPasteboard.general.changeCount
        let id: String?
        do {
            id = textOnly ? nil : try monitor.copyImage(image)
            if !textOnly { announce("图片已复制") }
        } catch { show(error); return }
        ocrTask = Task { [weak self] in
            guard let self else { return }
            defer { ocrTask = nil }
            do {
                let text = try await ocr.recognize(image)
                try Task.checkCancellation()
                if textOnly {
                    guard !text.isEmpty else { throw OCRFailure.empty }
                    // Never clobber a newer copy made while Vision was running.
                    guard NSPasteboard.general.changeCount == initialChange else {
                        announce("剪贴板已改变，识别结果未覆盖新内容。")
                        return
                    }
                    try monitor.copyText(text)
                    announce("文字已复制")
                } else if let id {
                    store.attachOCR(text, to: id)
                    history?.reload()
                }
            } catch is CancellationError {
                // Termination cancels the single owned OCR job.
            } catch { show(error) }
        }
    }

    @objc private func togglePersistence() {
        guard let store else { return }
        do {
            try store.setImagePersistenceEnabled(!store.imagePersistenceEnabled)
            persistenceItem?.state = store.imagePersistenceEnabled ? .on : .off
            history?.reload()
        } catch { show(error) }
    }

    @objc private func clearHistory() {
        guard let clearItem else { return }
        if clearItem.title != "确认清空历史" {
            clearItem.title = "确认清空历史"
            resetClear?.cancel()
            let reset = DispatchWorkItem { [weak self] in self?.clearItem?.title = "清空历史" }
            resetClear = reset
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: reset)
            statusItem?.menu?.cancelTrackingWithoutAnimation()
            statusItem?.button?.performClick(nil)
            return
        }
        resetClear?.cancel()
        clearItem.title = "清空历史"
        do { try store?.clear(); history?.reload() } catch { show(error) }
    }

    private func announce(_ text: String) {
        guard let button = statusItem?.button else { return }
        button.toolTip = text
        notice.show(text)
        NSAccessibility.post(element: button, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    private func show(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "SuperIU 截图"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "好")
        alert.runModal()
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        FileHandle.standardInput.readabilityHandler = nil
        resetClear?.cancel()
        ocrTask?.cancel()
        ocrTask = nil
        overlay?.stop()
        monitor?.stop()
        keys.stop()
        history?.close()
        notice.close()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    }
}
