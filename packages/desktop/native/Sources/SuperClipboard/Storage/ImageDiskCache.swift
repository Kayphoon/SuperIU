import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

public enum ClipboardError: LocalizedError {
    case imageTooLarge, encodingFailed, originalNotSaved, missingEntry, invalidCache, pasteboardWriteFailed
    public var errorDescription: String? {
        switch self {
        case .imageTooLarge: return "图片过大，未加入图片历史。"
        case .encodingFailed: return "无法编码图片。"
        case .originalNotSaved: return "此图片仅保留缩略图。开启图片历史后，新复制的原图才会存入缓存。"
        case .missingEntry: return "此记录已过期或被清理。"
        case .invalidCache: return "图片缓存数据无效。"
        case .pasteboardWriteFailed: return "无法写入系统剪贴板，请重试。"
        }
    }
}

@MainActor
public final class ImageDiskCache {
    public static let byteLimit = 50_000_000
    let directory: URL

    public init(directory: URL) { self.directory = directory }

    static func hash(_ image: CGImage) throws -> String {
        guard image.width > 0, image.height > 0, image.width <= 16_384, image.height <= 16_384,
              image.width * image.height <= 64_000_000, let data = image.dataProvider?.data else {
            throw ClipboardError.imageTooLarge
        }
        var hasher = SHA256()
        hasher.update(data: Data("\(image.width):\(image.height):\(image.bitsPerPixel):".utf8))
        hasher.update(data: data as Data)
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func thumbnail(_ image: CGImage) throws -> CGImage {
        let ratio = min(1, 128 / CGFloat(max(image.width, image.height)))
        let width = max(1, Int(CGFloat(image.width) * ratio))
        let height = max(1, Int(CGFloat(image.height) * ratio))
        guard let context = CGContext(data: nil, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw ClipboardError.encodingFailed
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let thumbnail = context.makeImage() else { throw ClipboardError.encodingFailed }
        return thumbnail
    }

    func thumbnail(at url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 128,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    func url(for hash: String) throws -> URL {
        guard hash.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw ClipboardError.invalidCache
        }
        return directory.appendingPathComponent(hash + ".png")
    }

    func ensureDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    func save(_ image: CGImage, hash: String, prepareSpace: (Int) throws -> Void) throws -> URL {
        let url = try url(for: hash)
        if FileManager.default.fileExists(atPath: url.path) { return url }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw ClipboardError.encodingFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ClipboardError.encodingFailed }
        // Reserve 8 MiB for bounded text and metadata. A single image may never
        // consume the whole directory budget, even before LRU reconciliation.
        guard data.length <= Self.byteLimit - 8 * 1024 * 1024 else { throw ClipboardError.imageTooLarge }
        try ensureDirectory()
        try prepareSpace(data.length)
        try (data as Data).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }

    func remove(_ hash: String) throws {
        let url = try url(for: hash)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    func files() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
    }

    func bytes() throws -> Int {
        try files().reduce(0) { sum, url in
            sum + (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        }
    }
}
