import Foundation

public enum ResizeHandle: CaseIterable {
    case bottomLeft, bottom, bottomRight, right, topRight, top, topLeft, left

    public func point(in rect: CGRect) -> CGPoint {
        switch self {
        case .bottomLeft: return CGPoint(x: rect.minX, y: rect.minY)
        case .bottom: return CGPoint(x: rect.midX, y: rect.minY)
        case .bottomRight: return CGPoint(x: rect.maxX, y: rect.minY)
        case .right: return CGPoint(x: rect.maxX, y: rect.midY)
        case .topRight: return CGPoint(x: rect.maxX, y: rect.maxY)
        case .top: return CGPoint(x: rect.midX, y: rect.maxY)
        case .topLeft: return CGPoint(x: rect.minX, y: rect.maxY)
        case .left: return CGPoint(x: rect.minX, y: rect.midY)
        }
    }

    public func resized(_ rect: CGRect, to point: CGPoint, within bounds: CGRect) -> CGRect {
        let x = min(max(point.x, bounds.minX), bounds.maxX)
        let y = min(max(point.y, bounds.minY), bounds.maxY)
        var lowX = rect.minX, highX = rect.maxX, lowY = rect.minY, highY = rect.maxY
        switch self {
        case .bottomLeft: lowX = min(x, highX - 1); lowY = min(y, highY - 1)
        case .bottom: lowY = min(y, highY - 1)
        case .bottomRight: highX = max(x, lowX + 1); lowY = min(y, highY - 1)
        case .right: highX = max(x, lowX + 1)
        case .topRight: highX = max(x, lowX + 1); highY = max(y, lowY + 1)
        case .top: highY = max(y, lowY + 1)
        case .topLeft: lowX = min(x, highX - 1); highY = max(y, lowY + 1)
        case .left: lowX = min(x, highX - 1)
        }
        return CGRect(x: lowX, y: lowY, width: highX - lowX, height: highY - lowY)
    }
}

public enum SelectionGeometry {
    public static func rectangle(from start: CGPoint, to end: CGPoint, within bounds: CGRect) -> CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
               width: abs(start.x - end.x), height: abs(start.y - end.y)).intersection(bounds)
    }

    public static func moved(_ rect: CGRect, by delta: CGSize, within bounds: CGRect) -> CGRect {
        let x = min(max(rect.minX + delta.width, bounds.minX), bounds.maxX - rect.width)
        let y = min(max(rect.minY + delta.height, bounds.minY), bounds.maxY - rect.height)
        return CGRect(origin: CGPoint(x: x, y: y), size: rect.size)
    }

    // CGImage cropping uses a top-left origin; AppKit screen coordinates use bottom-left.
    public static func pixels(for selection: CGRect, screen: CGRect, width: Int, height: Int) -> CGRect {
        let local = selection.intersection(screen)
        guard !local.isNull, screen.width > 0, screen.height > 0 else { return .null }
        let sx = CGFloat(width) / screen.width
        let sy = CGFloat(height) / screen.height
        return CGRect(x: (local.minX - screen.minX) * sx,
                      y: (screen.maxY - local.maxY) * sy,
                      width: local.width * sx, height: local.height * sy).integral
            .intersection(CGRect(x: 0, y: 0, width: width, height: height))
    }
}
