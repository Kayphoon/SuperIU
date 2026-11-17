import AppKit

@MainActor
final class CanvasView: NSView {
    weak var coordinator: OverlayWindowController?
    var displayFrame = CGRect.zero
    var image: CGImage?
    private let toolbar = NSStackView()
    private let instruction = NSTextField(labelWithString: "拖动框选 · Esc 取消")

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        toolbar.orientation = .horizontal
        toolbar.spacing = 6
        toolbar.edgeInsets = NSEdgeInsets(top: 6, left: 8, bottom: 6, right: 8)
        toolbar.wantsLayer = true
        toolbar.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        toolbar.layer?.cornerRadius = 8
        let actions: [(String, String, Selector)] = [
            ("选区", "V · 移动选区，拖动八个锚点调整", #selector(selectTool)),
            ("矩形", "R · 矩形标注", #selector(rectangleTool)),
            ("马赛克", "M · 马赛克", #selector(mosaicTool)),
            ("颜色", "1 红 / 2 黄 / 3 蓝", #selector(cycleColor)),
            ("线宽", "[ / ] · 2 / 4 / 6 pt", #selector(cycleWidth)),
            ("撤销", "⌘Z", #selector(undoAnnotation)),
            ("文字", "⇧Enter 或 ⌘C · 只复制文字", #selector(copyText)),
            ("复制", "Enter 或双击 · 复制图片", #selector(copyImage)),
            ("取消", "Esc", #selector(cancel))
        ]
        for (title, tooltip, action) in actions {
            let button = NSButton(title: title, target: self, action: action)
            button.bezelStyle = .rounded
            button.toolTip = tooltip
            button.setAccessibilityLabel(tooltip)
            button.setContentHuggingPriority(.required, for: .horizontal)
            toolbar.addArrangedSubview(button)
        }
        addSubview(toolbar)
        toolbar.isHidden = true
        instruction.font = .systemFont(ofSize: 14, weight: .medium)
        instruction.textColor = .white
        instruction.alignment = .center
        addSubview(instruction)
        setAccessibilityLabel("截图选区。拖动框选，箭头键微调，R 矩形，M 马赛克，Enter 复制，Shift Enter 识别文字，Escape 取消。")
    }

    required init?(coder: NSCoder) { nil }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    func refresh() {
        needsDisplay = true
        guard let coordinator else { return }
        let selection = local(coordinator.selection)
        toolbar.isHidden = selection.isNull || !bounds.contains(selection.center) || coordinator.isDragging
        toolbar.layoutSubtreeIfNeeded()
        let size = toolbar.fittingSize
        toolbar.frame = CGRect(
            x: min(max(selection.midX - size.width / 2, 8), max(8, bounds.width - size.width - 8)),
            y: max(8, min(selection.minY - size.height - 12, bounds.height - size.height - 8)),
            width: size.width, height: size.height
        )
        instruction.stringValue = coordinator.statusText
        instruction.frame = CGRect(x: 8, y: bounds.height - 44, width: max(0, bounds.width - 16), height: 24)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        if let image { context.draw(image, in: bounds) }
        guard let coordinator else { return }
        let selected = local(coordinator.selection)
        let mask = NSBezierPath(rect: bounds)
        if !selected.isNull { mask.appendRect(selected) }
        mask.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.38).setFill()
        mask.fill()
        guard !selected.isNull else { return }
        context.saveGState()
        context.clip(to: selected)
        for annotation in coordinator.visibleAnnotations {
            let rect = local(annotation.rect)
            switch annotation.kind {
            case .rectangle:
                annotation.color.setStroke()
                let path = NSBezierPath(rect: rect.insetBy(dx: annotation.lineWidth / 2, dy: annotation.lineWidth / 2))
                path.lineWidth = annotation.lineWidth
                path.stroke()
            case .mosaic:
                // A solid preview keeps the sensitive region hidden even while dragging.
                NSColor.black.setFill()
                rect.fill()
            }
        }
        context.restoreGState()
        NSColor.white.setStroke()
        let outline = NSBezierPath(rect: selected.insetBy(dx: 0.5, dy: 0.5))
        outline.lineWidth = 1
        outline.stroke()
        for handle in ResizeHandle.allCases {
            let point = handle.point(in: selected)
            let square = CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)
            NSColor.white.setFill()
            square.fill()
            NSColor.black.setStroke()
            square.frame()
        }
    }

    private func local(_ rect: CGRect) -> CGRect {
        rect.isNull ? .null : rect.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY)
    }

    private func global(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        return CGPoint(x: point.x + displayFrame.minX, y: point.y + displayFrame.minY)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if event.clickCount == 2, coordinator?.selection.contains(global(event)) == true {
            coordinator?.confirm(textOnly: false)
        } else {
            coordinator?.begin(at: global(event))
        }
    }
    override func mouseDragged(with event: NSEvent) { coordinator?.drag(to: global(event)) }
    override func mouseUp(with event: NSEvent) { coordinator?.end(at: global(event)) }

    override func keyDown(with event: NSEvent) {
        guard let coordinator else { return }
        let command = event.modifierFlags.contains(.command)
        switch event.keyCode {
        case 53: coordinator.cancel()
        case 36, 76: coordinator.confirm(textOnly: event.modifierFlags.contains(.shift))
        case 123: coordinator.nudge(dx: -1, dy: 0, fast: event.modifierFlags.contains(.shift))
        case 124: coordinator.nudge(dx: 1, dy: 0, fast: event.modifierFlags.contains(.shift))
        case 125: coordinator.nudge(dx: 0, dy: -1, fast: event.modifierFlags.contains(.shift))
        case 126: coordinator.nudge(dx: 0, dy: 1, fast: event.modifierFlags.contains(.shift))
        default:
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "c" where command: coordinator.confirm(textOnly: true)
            case "z" where command: coordinator.undo()
            case "r": coordinator.tool = .rectangle
            case "m": coordinator.tool = .mosaic
            case "v": coordinator.tool = .selection
            case "1": coordinator.colorIndex = 0
            case "2": coordinator.colorIndex = 1
            case "3": coordinator.colorIndex = 2
            case "[": coordinator.widthIndex = max(0, coordinator.widthIndex - 1)
            case "]": coordinator.widthIndex = min(2, coordinator.widthIndex + 1)
            default: super.keyDown(with: event)
            }
        }
        coordinator.refresh()
    }

    @objc private func selectTool() { coordinator?.tool = .selection; coordinator?.refresh() }
    @objc private func rectangleTool() { coordinator?.tool = .rectangle; coordinator?.refresh() }
    @objc private func mosaicTool() { coordinator?.tool = .mosaic; coordinator?.refresh() }
    @objc private func cycleColor() {
        guard let coordinator else { return }
        coordinator.colorIndex = (coordinator.colorIndex + 1) % 3
        coordinator.refresh()
    }
    @objc private func cycleWidth() {
        guard let coordinator else { return }
        coordinator.widthIndex = (coordinator.widthIndex + 1) % 3
        coordinator.refresh()
    }
    @objc private func undoAnnotation() { coordinator?.undo() }
    @objc private func copyText() { coordinator?.confirm(textOnly: true) }
    @objc private func copyImage() { coordinator?.confirm(textOnly: false) }
    @objc private func cancel() { coordinator?.cancel() }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}
