import AppKit

public struct CaptureAnnotation {
    public enum Kind { case rectangle, mosaic }
    public let kind: Kind
    public let rect: CGRect
    public let color: NSColor
    public let lineWidth: CGFloat

    public init(kind: Kind, rect: CGRect, color: NSColor, lineWidth: CGFloat) {
        self.kind = kind
        self.rect = rect
        self.color = color
        self.lineWidth = lineWidth
    }
}

public enum AnnotationRenderer {
    public static func render(frames: [DisplayFrame], selection: CGRect,
                              annotations: [CaptureAnnotation]) throws -> CGImage {
        guard !selection.isNull, selection.width >= 1, selection.height >= 1 else {
            throw CaptureError.invalidSelection
        }
        let scale = frames.map { CGFloat($0.image.width) / $0.frame.width }.max() ?? 1
        let width = ceil(selection.width * scale), height = ceil(selection.height * scale)
        guard width * height <= 64_000_000,
              let context = CGContext(data: nil, width: Int(width), height: Int(height),
                                      bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw CaptureError.invalidSelection
        }
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -selection.minX, y: -selection.minY)
        for display in frames {
            let intersection = selection.intersection(display.frame)
            guard !intersection.isNull,
                  let crop = display.image.cropping(to: SelectionGeometry.pixels(
                    for: intersection, screen: display.frame, width: display.image.width, height: display.image.height
                  )) else { continue }
            context.draw(crop, in: intersection)
        }
        // Redactions go first so a later rectangle cannot reveal their source pixels.
        for annotation in annotations where annotation.kind == .mosaic {
            let rect = annotation.rect.intersection(selection)
            guard !rect.isNull, rect.width >= 1, rect.height >= 1,
                  let current = context.makeImage() else { continue }
            let pixelRect = SelectionGeometry.pixels(for: rect, screen: selection,
                                                     width: Int(width), height: Int(height))
            guard let crop = current.cropping(to: pixelRect),
                  let small = CGContext(data: nil, width: max(1, crop.width / 16),
                                        height: max(1, crop.height / 16), bitsPerComponent: 8, bytesPerRow: 0,
                                        space: CGColorSpaceCreateDeviceRGB(),
                                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw CaptureError.allocationFailed
            }
            small.interpolationQuality = .low
            small.draw(crop, in: CGRect(x: 0, y: 0, width: small.width, height: small.height))
            guard let mosaic = small.makeImage() else { throw CaptureError.allocationFailed }
            context.saveGState()
            context.interpolationQuality = .none
            context.draw(mosaic, in: rect)
            context.restoreGState()
        }
        for annotation in annotations where annotation.kind == .rectangle {
            context.setStrokeColor(annotation.color.cgColor)
            context.setLineWidth(annotation.lineWidth)
            context.stroke(annotation.rect.insetBy(dx: annotation.lineWidth / 2, dy: annotation.lineWidth / 2))
        }
        guard let image = context.makeImage() else { throw CaptureError.allocationFailed }
        return image
    }
}
