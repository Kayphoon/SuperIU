import AppKit

@MainActor
final class CopyNotice {
    private var panel: NSPanel?
    private var dismiss: DispatchWorkItem?

    func show(_ text: String) {
        close()
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
                ?? NSScreen.main else { return }
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.alignment = .center
        label.frame = CGRect(x: 16, y: 12, width: 328, height: 40)
        let window = NSPanel(contentRect: CGRect(x: screen.visibleFrame.midX - 180,
                                                 y: screen.visibleFrame.minY + 72, width: 360, height: 64),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.backgroundColor = .windowBackgroundColor
        window.hasShadow = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.ignoresMouseEvents = true
        window.contentView?.addSubview(label)
        window.orderFrontRegardless()
        panel = window
        let work = DispatchWorkItem { [weak self] in self?.close() }
        dismiss = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    func close() {
        dismiss?.cancel()
        dismiss = nil
        panel?.close()
        panel = nil
    }
}
