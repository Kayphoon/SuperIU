import AppKit

private final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
public final class OverlayWindowController {
    enum Tool { case selection, rectangle, mosaic }
    private enum Gesture {
        case create(CGPoint), move(CGPoint, CGRect), resize(ResizeHandle, CGRect), annotate(CGPoint)
    }

    private var panels: [CapturePanel] = []
    private var frames: [DisplayFrame] = []
    private var captureTask: Task<Void, Never>?
    private var screenObserver: NSObjectProtocol?
    private var keyMonitor: Any?
    private var gesture: Gesture?
    private var annotations: [CaptureAnnotation] = []
    private var pendingAnnotation: CaptureAnnotation?
    private var generation = 0
    private var isPresented = false
    private let grabber = ScreenGrabber()
    private let colors: [NSColor] = [.systemRed, .systemYellow, .systemBlue]
    private let widths: [CGFloat] = [2, 4, 6]
    var selection = CGRect.null
    var tool: Tool = .selection
    var colorIndex = 0
    var widthIndex = 0
    var isDragging: Bool { gesture != nil }
    var visibleAnnotations: [CaptureAnnotation] { annotations + (pendingAnnotation.map { [$0] } ?? []) }
    var statusText: String {
        if isPresented && frames.isEmpty { return "正在读取屏幕 · Esc 取消" }
        let toolName: String
        switch tool {
        case .selection: toolName = "选区"
        case .rectangle: toolName = "矩形"
        case .mosaic: toolName = "马赛克"
        }
        let colorName = ["红", "黄", "蓝"][colorIndex]
        return selection.isNull ? "拖动框选 · Esc 取消" :
            "\(Int(selection.width)) × \(Int(selection.height)) · \(toolName) · \(colorName) · \(Int(widths[widthIndex])) pt · Enter 复制 · ⇧Enter 文字 · Esc 取消"
    }

    public var onCapture: ((CGImage, Bool) -> Void)?
    public var onError: ((Error) -> Void)?

    public init() {
        preparePanels()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.cancel()
                self?.preparePanels()
            }
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.isPresented, event.keyCode != 48,
                      self.panels.contains(where: { $0 === event.window }),
                      let canvas = event.window?.contentView as? CanvasView else { return event }
                canvas.keyDown(with: event)
                return nil
            }
        }
    }

    public func present() {
        guard captureTask == nil, !isPresented else { return }
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            onError?(CaptureError.permissionRequired)
            return
        }
        generation += 1
        let token = generation
        selection = .null
        annotations.removeAll()
        tool = .selection
        isPresented = true
        // Show the prewarmed transparent panels before ScreenCaptureKit replies.
        // The filter excludes this helper, so the overlays never enter the image.
        for panel in panels {
            (panel.contentView as? CanvasView)?.refresh()
            panel.orderFrontRegardless()
        }
        let mouse = NSEvent.mouseLocation
        let activePanel = panels.first(where: { $0.frame.contains(mouse) }) ?? panels.first
        activePanel?.makeKey()
        activePanel?.makeFirstResponder(activePanel?.contentView)
        captureTask = Task { [weak self] in
            guard let self else { return }
            do {
                let images = try await grabber.capture()
                try Task.checkCancellation()
                guard token == generation else { return }
                frames = images
                for (panel, display) in zip(panels, images) {
                    guard let canvas = panel.contentView as? CanvasView else { continue }
                    canvas.displayFrame = display.frame
                    canvas.image = display.image
                    panel.setFrame(display.frame, display: false)
                    canvas.refresh()
                }
            } catch is CancellationError {
                // A screen change or explicit cancel invalidates the in-flight capture.
            } catch {
                if token == generation {
                    cancel()
                    onError?(error)
                }
            }
            if token == generation { captureTask = nil }
        }
    }

    private func preparePanels() {
        for panel in panels { panel.close() }
        panels = NSScreen.screens.map { screen in
            let panel = CapturePanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                     backing: .buffered, defer: false)
            panel.level = .screenSaver
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.hidesOnDeactivate = false
            panel.isFloatingPanel = true
            panel.isReleasedWhenClosed = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            let view = CanvasView(frame: CGRect(origin: .zero, size: screen.frame.size))
            view.autoresizingMask = [.width, .height]
            view.displayFrame = screen.frame
            view.coordinator = self
            panel.contentView = view
            return panel
        }
    }

    private var desktop: CGRect { frames.reduce(CGRect.null) { $0.union($1.frame) } }

    func refresh() {
        for panel in panels { (panel.contentView as? CanvasView)?.refresh() }
    }

    func begin(at point: CGPoint) {
        guard isPresented, !frames.isEmpty else { return }
        if tool != .selection, selection.contains(point), annotations.count < 200 {
            gesture = .annotate(point)
        } else if !selection.isNull,
                  let handle = ResizeHandle.allCases.first(where: {
                      let p = $0.point(in: selection)
                      return abs(p.x - point.x) <= 10 && abs(p.y - point.y) <= 10
                  }) {
            gesture = .resize(handle, selection)
        } else if selection.contains(point) {
            gesture = .move(point, selection)
        } else {
            annotations.removeAll()
            selection = .null
            gesture = .create(point)
        }
        refresh()
    }

    func drag(to point: CGPoint) {
        guard let gesture else { return }
        switch gesture {
        case .create(let start):
            selection = SelectionGeometry.rectangle(from: start, to: point, within: desktop)
        case .move(let start, let original):
            // Marks stay attached to their original desktop pixels when selection changes.
            selection = SelectionGeometry.moved(original, by: CGSize(width: point.x - start.x, height: point.y - start.y),
                                                within: desktop)
        case .resize(let handle, let original):
            selection = handle.resized(original, to: point, within: desktop)
        case .annotate(let start):
            let rect = SelectionGeometry.rectangle(from: start, to: point, within: selection)
            pendingAnnotation = CaptureAnnotation(kind: tool == .mosaic ? .mosaic : .rectangle, rect: rect,
                                                  color: colors[colorIndex], lineWidth: widths[widthIndex])
        }
        refresh()
    }

    func end(at point: CGPoint) {
        drag(to: point)
        if let pendingAnnotation, pendingAnnotation.rect.width >= 1, pendingAnnotation.rect.height >= 1 {
            annotations.append(pendingAnnotation)
        }
        pendingAnnotation = nil
        gesture = nil
        if selection.width < 1 || selection.height < 1 { selection = .null }
        refresh()
    }

    func nudge(dx: CGFloat, dy: CGFloat, fast: Bool) {
        guard !selection.isNull else { return }
        let step: CGFloat = fast ? 10 : 1
        selection = SelectionGeometry.moved(selection, by: CGSize(width: dx * step, height: dy * step), within: desktop)
        refresh()
    }

    func undo() {
        if !annotations.isEmpty { annotations.removeLast() }
        refresh()
    }

    func confirm(textOnly: Bool) {
        guard isPresented, !frames.isEmpty, gesture == nil else { return }
        do {
            let image = try AnnotationRenderer.render(frames: frames, selection: selection, annotations: annotations)
            cancel()
            onCapture?(image, textOnly)
        } catch {
            onError?(error)
        }
    }

    public func cancel() {
        generation += 1
        captureTask?.cancel()
        captureTask = nil
        isPresented = false
        for panel in panels {
            panel.orderOut(nil)
            (panel.contentView as? CanvasView)?.image = nil
            panel.contentView?.layer?.contents = nil
            panel.contentView?.needsDisplay = true
        }
        frames.removeAll()
        annotations.removeAll()
        pendingAnnotation = nil
        gesture = nil
        selection = .null
    }

    public func stop() {
        cancel()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        for panel in panels { panel.close() }
        panels.removeAll()
    }
}
