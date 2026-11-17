import AppKit
import SuperClipboard

@MainActor
final class HistoryPanel: NSWindowController, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private let store: ClipboardStore
    private let search = NSSearchField()
    private let table = NSTableView()
    private let message = NSTextField(labelWithString: "")
    private var rows: [ClipboardEntry] = []
    var onError: ((Error) -> Void)?

    init(store: ClipboardStore) {
        self.store = store
        let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 560, height: 480),
                            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.title = "剪贴板历史"
        panel.minSize = CGSize(width: 400, height: 320)
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = true
        panel.level = .floating
        super.init(window: panel)
        let content = NSView()
        panel.contentView = content
        search.placeholderString = "搜索文字或截图中的文字"
        search.delegate = self
        search.setAccessibilityLabel("搜索剪贴板历史")
        search.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(search)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("entry")))
        table.headerView = nil
        table.rowHeight = 64
        table.delegate = self
        table.dataSource = self
        table.target = self
        table.doubleAction = #selector(copySelected)
        scroll.documentView = table
        content.addSubview(scroll)
        let copy = NSButton(title: "复制", target: self, action: #selector(copySelected))
        copy.bezelStyle = .rounded
        copy.keyEquivalent = "\r"
        copy.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(copy)
        message.font = .systemFont(ofSize: 12)
        message.textColor = .secondaryLabelColor
        message.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(message)
        NSLayoutConstraint.activate([
            search.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            search.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            search.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: search.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: search.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: copy.topAnchor, constant: -12),
            copy.trailingAnchor.constraint(equalTo: search.trailingAnchor),
            copy.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            message.leadingAnchor.constraint(equalTo: search.leadingAnchor),
            message.trailingAnchor.constraint(lessThanOrEqualTo: copy.leadingAnchor, constant: -8),
            message.centerYAnchor.constraint(equalTo: copy.centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        reload()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(search)
    }

    func reload() {
        rows = store.search(search.stringValue)
        table.reloadData()
        message.stringValue = rows.isEmpty ? "暂无记录" : "\(rows.count) 条 · 双击或 Enter 复制"
    }

    func controlTextDidChange(_ obj: Notification) { reload() }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let entry = rows[row]
        let view = NSStackView()
        view.orientation = .horizontal
        view.spacing = 12
        if let thumbnail = entry.thumbnail {
            let image = NSImageView()
            image.image = NSImage(cgImage: thumbnail, size: NSSize(width: thumbnail.width, height: thumbnail.height))
            image.imageScaling = .scaleProportionallyUpOrDown
            image.widthAnchor.constraint(equalToConstant: 56).isActive = true
            image.heightAnchor.constraint(equalToConstant: 56).isActive = true
            view.addArrangedSubview(image)
        }
        let text: String
        switch entry.kind {
        case .text: text = entry.text ?? ""
        case .image:
            let metadata = entry.ocrText?.isEmpty == false ? entry.ocrText : nil
            text = metadata ?? (entry.imageURL == nil ? "图片 · 未保存原图" : "图片")
        }
        let label = NSTextField(wrappingLabelWithString: text)
        label.maximumNumberOfLines = 2
        label.lineBreakMode = .byTruncatingTail
        view.addArrangedSubview(label)
        view.setAccessibilityLabel(text)
        return view
    }

    @objc private func copySelected() {
        let row = table.selectedRow
        guard rows.indices.contains(row) else { return }
        do {
            try store.copy(rows[row].id, to: .general)
            window?.orderOut(nil)
        } catch { onError?(error) }
    }
}
