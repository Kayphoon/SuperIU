import AppKit
import CryptoKit

public struct ClipboardEntry {
    public enum Kind: String, Codable { case text, image }
    public let id: String
    public let kind: Kind
    public let text: String?
    public internal(set) var ocrText: String?
    public let thumbnail: CGImage?
    public internal(set) var imageURL: URL?
    public internal(set) var createdAt: Date
}

@MainActor
public final class ClipboardStore {
    public private(set) var entries: [ClipboardEntry] = []
    public private(set) var imagePersistenceEnabled = false
    public var onError: ((Error) -> Void)?
    private let cache: ImageDiskCache
    private let indexURL: URL
    private let maxTextBytes = 16 * 1024
    private let maxOCRBytes = 32 * 1024

    private struct SavedEntry: Codable {
        let id: String
        let kind: ClipboardEntry.Kind
        let text: String?
        let ocrText: String?
        let createdAt: Date
    }

    public init(directory: URL) throws {
        cache = ImageDiskCache(directory: directory)
        indexURL = directory.appendingPathComponent("history.json")
        guard FileManager.default.fileExists(atPath: indexURL.path) else { return }
        let size = try indexURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 8 * 1024 * 1024 else { throw ClipboardError.invalidCache }
        let saved = try JSONDecoder().decode([SavedEntry].self, from: Data(contentsOf: indexURL))
        guard saved.count <= 225 else { throw ClipboardError.invalidCache }
        imagePersistenceEnabled = true
        var seen = Set<String>()
        for row in saved {
            guard seen.insert(row.id).inserted else { continue }
            switch row.kind {
            case .text:
                guard let text = row.text, !text.isEmpty, text.utf8.count <= maxTextBytes,
                      row.id == "text:" + Self.digest(text) else { throw ClipboardError.invalidCache }
                entries.append(ClipboardEntry(id: row.id, kind: .text, text: text, ocrText: nil,
                                              thumbnail: nil, imageURL: nil, createdAt: row.createdAt))
            case .image:
                guard row.id.hasPrefix("image:"), (row.ocrText?.utf8.count ?? 0) <= maxOCRBytes else {
                    throw ClipboardError.invalidCache
                }
                let url = try cache.url(for: String(row.id.dropFirst(6)))
                guard FileManager.default.fileExists(atPath: url.path),
                      let thumbnail = cache.thumbnail(at: url) else { continue }
                entries.append(ClipboardEntry(id: row.id, kind: .image, text: nil, ocrText: row.ocrText,
                                              thumbnail: thumbnail, imageURL: url, createdAt: row.createdAt))
            }
        }
        try reconcile()
    }

    private static func digest(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func setImagePersistenceEnabled(_ enabled: Bool) throws {
        guard enabled != imagePersistenceEnabled else { return }
        if enabled {
            // Enabling applies to future copies; do not fetch old originals from
            // the system pasteboard or synthesize them from thumbnails.
            try cache.ensureDirectory()
            imagePersistenceEnabled = true
            do { try reconcile() } catch { imagePersistenceEnabled = false; throw error }
        } else {
            // This directory belongs exclusively to this module.
            if FileManager.default.fileExists(atPath: cache.directory.path) {
                try FileManager.default.removeItem(at: cache.directory)
            }
            imagePersistenceEnabled = false
            for index in entries.indices { entries[index].imageURL = nil }
        }
    }

    @discardableResult
    public func recordText(_ text: String) -> String? {
        guard !text.isEmpty, text.utf8.count <= maxTextBytes else { return nil }
        let id = "text:" + Self.digest(text)
        entries.removeAll { $0.id == id }
        entries.insert(ClipboardEntry(id: id, kind: .text, text: text, ocrText: nil,
                                      thumbnail: nil, imageURL: nil, createdAt: Date()), at: 0)
        do { try reconcile() } catch { onError?(error) }
        return id
    }

    @discardableResult
    public func recordImage(_ image: CGImage) throws -> String? {
        let hash = try ImageDiskCache.hash(image)
        let thumbnail = try ImageDiskCache.thumbnail(image)
        let id = "image:" + hash
        let previousOCR = entries.first(where: { $0.id == id })?.ocrText
        let url: URL?
        if imagePersistenceEnabled {
            url = try cache.save(image, hash: hash) { incomingBytes in
                while try cache.bytes() + incomingBytes > ImageDiskCache.byteLimit - 8 * 1024 * 1024 {
                    guard let index = entries.lastIndex(where: { $0.kind == .image && $0.imageURL != nil }) else {
                        throw ClipboardError.imageTooLarge
                    }
                    let removed = entries.remove(at: index)
                    if let file = removed.imageURL { try FileManager.default.removeItem(at: file) }
                }
            }
        } else { url = nil }
        entries.removeAll { $0.id == id }
        entries.insert(ClipboardEntry(id: id, kind: .image, text: nil, ocrText: previousOCR,
                                      thumbnail: thumbnail, imageURL: url, createdAt: Date()), at: 0)
        try reconcile()
        return entries.contains(where: { $0.id == id }) ? id : nil
    }

    public func attachOCR(_ text: String, to id: String) {
        guard text.utf8.count <= maxOCRBytes,
              let index = entries.firstIndex(where: { $0.id == id && $0.kind == .image }) else { return }
        entries[index].ocrText = text
        do { try reconcile() } catch { onError?(error) }
    }

    public func search(_ query: String) -> [ClipboardEntry] {
        guard !query.isEmpty else { return entries }
        return entries.filter {
            ($0.text ?? "").localizedCaseInsensitiveContains(query) ||
            ($0.ocrText ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    public func copy(_ id: String, to pasteboard: NSPasteboard) throws {
        guard let entry = entries.first(where: { $0.id == id }) else { throw ClipboardError.missingEntry }
        switch entry.kind {
        case .text:
            guard let text = entry.text else { throw ClipboardError.missingEntry }
            pasteboard.clearContents()
            guard pasteboard.setString(text, forType: .string) else { throw ClipboardError.pasteboardWriteFailed }
        case .image:
            guard let url = entry.imageURL else { throw ClipboardError.originalNotSaved }
            guard FileManager.default.fileExists(atPath: url.path) else { throw ClipboardError.missingEntry }
            // PNG bytes are transient; the history holds only its path/thumbnail.
            let data = try Data(contentsOf: url)
            pasteboard.clearContents()
            guard pasteboard.setData(data, forType: .png) else { throw ClipboardError.pasteboardWriteFailed }
        }
    }

    public func clear() throws {
        if FileManager.default.fileExists(atPath: cache.directory.path) {
            try FileManager.default.removeItem(at: cache.directory)
        }
        entries.removeAll()
        if imagePersistenceEnabled { try reconcile() }
    }

    // The monitor calls maintenance only after a pasteboard change. No display
    // timer or periodic directory scan runs while the system is idle.
    public func prune() throws { try reconcile() }

    private func reconcile() throws {
        let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        var textCount = 0, imageCount = 0
        var kept: [ClipboardEntry] = []
        for entry in entries {
            switch entry.kind {
            case .text:
                textCount += 1
                if textCount <= 200 { kept.append(entry) }
            case .image:
                imageCount += 1
                if imageCount <= 25 && entry.createdAt >= cutoff { kept.append(entry) }
            }
        }
        entries = kept
        guard imagePersistenceEnabled else { return }
        try cache.ensureDirectory()
        var retainedFiles = Set(entries.compactMap { $0.imageURL?.lastPathComponent })
        for file in try cache.files() where file.lastPathComponent != "history.json" {
            if !retainedFiles.contains(file.lastPathComponent) { try FileManager.default.removeItem(at: file) }
        }
        // Reserve enough for the largest possible bounded metadata index before
        // committing it, so the final directory can never exceed 50 MB.
        while try cache.bytes() > ImageDiskCache.byteLimit - 8 * 1024 * 1024,
              let index = entries.lastIndex(where: { $0.kind == .image && $0.imageURL != nil }) {
            let removed = entries.remove(at: index)
            if let file = removed.imageURL {
                try FileManager.default.removeItem(at: file)
                retainedFiles.remove(file.lastPathComponent)
            }
        }
        var saved = entries.compactMap { entry -> SavedEntry? in
            guard entry.kind == .text || entry.imageURL != nil else { return nil }
            return SavedEntry(id: entry.id, kind: entry.kind, text: entry.text, ocrText: entry.ocrText,
                              createdAt: entry.createdAt)
        }
        var data = try JSONEncoder().encode(saved)
        while data.count > 8 * 1024 * 1024, let removed = entries.popLast() {
            if let file = removed.imageURL, FileManager.default.fileExists(atPath: file.path) {
                try FileManager.default.removeItem(at: file)
            }
            saved.removeAll { $0.id == removed.id }
            data = try JSONEncoder().encode(saved)
        }
        try data.write(to: indexURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: indexURL.path)
        guard try cache.bytes() <= ImageDiskCache.byteLimit else { throw ClipboardError.invalidCache }
    }
}
