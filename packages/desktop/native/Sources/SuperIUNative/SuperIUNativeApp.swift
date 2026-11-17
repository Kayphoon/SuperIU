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
    private var pendingInput = Data()
    private var discardingInput = false
    private var settings = NativeSettings()
    private var captureItem: NSMenuItem?
    private var historyItem: NSMenuItem?
    private var persistenceItem: NSMenuItem?
    private var clearItem: NSMenuItem?
    private var resetClear: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: false)
            let store = try ClipboardStore(directory: caches.appendingPathComponent("com.superiu.capture", isDirectory: true))
            self.store = store
            settings.imagePersistenceEnabled = store.imagePersistenceEnabled
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
            let hosted = CommandLine.arguments.contains("--hosted")
            if !hosted {
                do { try keys.start() } catch {
                    fputs("SuperIU Capture: \(error.localizedDescription)\n", stderr)
                    announce(error.localizedDescription)
                }
            }
            monitor?.start()
            if hosted {
                FileHandle.standardInput.readabilityHandler = { [weak self] handle in
                    let data: Data
                    do { data = try handle.read(upToCount: 4096) ?? Data() } catch {
                        fputs("SuperIU Capture stdin: \(error.localizedDescription)\n", stderr)
                        DispatchQueue.main.async { NSApp.terminate(nil) }
                        return
                    }
                    DispatchQueue.main.async {
                        guard let self else { return }
                        if data.isEmpty {
                            NSApp.terminate(nil)
                            return
                        }
                        self.receiveInput(data)
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

    private func receiveInput(_ data: Data) {
        for byte in data {
            if byte == 10 {
                if discardingInput {
                    discardingInput = false
                    continue
                }
                if pendingInput.last == 13 { pendingInput.removeLast() }
                let line = pendingInput
                pendingInput.removeAll(keepingCapacity: true)
                if line == Data("quit".utf8) {
                    NSApp.terminate(nil)
                    return
                }
                handleRequest(line)
            } else if !discardingInput {
                guard pendingInput.count < 8192 else {
                    pendingInput.removeAll(keepingCapacity: true)
                    discardingInput = true
                    emit("SUPERIU_NATIVE_RESPONSE ", NativeResponse(id: 0, ok: false,
                                                                   error: NativeSettingsError.lineTooLong.localizedDescription))
                    continue
                }
                pendingInput.append(byte)
            }
        }
    }

    private func handleRequest(_ data: Data) {
        let decoder = JSONDecoder()
        let id = (try? decoder.decode(NativeRequestID.self, from: data).id) ?? 0
        do {
            guard id > 0 else { throw NativeSettingsError.invalidRequest }
            let request = try decoder.decode(NativeRequest.self, from: data)
            guard let store else { throw NativeSettingsError.unavailable }
            switch request.action {
            case "getSettings":
                break
            case "configure":
                guard let configuration = request.settings else { throw NativeSettingsError.invalidRequest }
                try configuration.validate()
                try keys.configure(capture: configuration.captureShortcut, history: configuration.historyShortcut) {
                    try store.setImagePersistenceEnabled(configuration.imagePersistenceEnabled)
                }
                settings = configuration
                updateMenu()
                history?.reload()
            case "clearHistory":
                try store.clear()
                resetClear?.cancel()
                clearItem?.title = "清空历史"
                history?.reload()
            default:
                throw NativeSettingsError.invalidRequest
            }
            settings.imagePersistenceEnabled = store.imagePersistenceEnabled
            emit("SUPERIU_NATIVE_RESPONSE ", NativeResponse(id: id, ok: true, settings: settings))
        } catch {
            let message = error is DecodingError ? NativeSettingsError.invalidRequest.localizedDescription
                                                : error.localizedDescription
            emit("SUPERIU_NATIVE_RESPONSE ", NativeResponse(id: id > 0 ? id : 0, ok: false, error: message))
        }
    }

    private func emit<Value: Encodable>(_ prefix: String, _ value: Value) {
        do {
            let data = try JSONEncoder().encode(value)
            print(prefix + String(decoding: data, as: UTF8.self))
            fflush(stdout)
        } catch {
            fputs("SuperIU Capture response: \(error.localizedDescription)\n", stderr)
        }
    }

    private func installMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "viewfinder", accessibilityDescription: "SuperIU 截图与剪贴板")
        let menu = NSMenu()
        let capture = action("截图", #selector(capture))
        menu.addItem(capture)
        captureItem = capture
        let history = action("剪贴板历史", #selector(showHistory))
        menu.addItem(history)
        historyItem = history
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
        updateMenu()
    }

    private func updateMenu() {
        captureItem?.keyEquivalent = settings.captureShortcut.keyEquivalent
        captureItem?.keyEquivalentModifierMask = settings.captureShortcut.menuModifiers
        historyItem?.keyEquivalent = settings.historyShortcut.keyEquivalent
        historyItem?.keyEquivalentModifierMask = settings.historyShortcut.menuModifiers
        persistenceItem?.state = settings.imagePersistenceEnabled ? .on : .off
    }

    private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self
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
            settings.imagePersistenceEnabled = store.imagePersistenceEnabled
            persistenceItem?.state = store.imagePersistenceEnabled ? .on : .off
            history?.reload()
            emit("SUPERIU_NATIVE_SETTINGS ", settings)
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
