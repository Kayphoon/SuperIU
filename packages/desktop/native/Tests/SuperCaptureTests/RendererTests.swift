import AppKit
import XCTest
@testable import SuperCapture

final class RendererTests: XCTestCase {
    private func image(width: Int = 32, height: Int = 32, checker: Bool = false) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
                                             bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpaceCreateDeviceRGB(),
                                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        for y in 0..<height {
            for x in 0..<width {
                context.setFillColor((checker && (x + y) % 2 == 0 ? NSColor.white : NSColor.black).cgColor)
                context.fill(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        return try XCTUnwrap(context.makeImage())
    }

    func testMosaicRemovesOriginalCheckerboardPixels() throws {
        let source = try image(checker: true)
        let rect = CGRect(x: 0, y: 0, width: 32, height: 32)
        let result = try AnnotationRenderer.render(frames: [DisplayFrame(frame: rect, image: source)],
                                                   selection: rect,
                                                   annotations: [CaptureAnnotation(kind: .mosaic, rect: rect,
                                                                                   color: .red, lineWidth: 2)])
        let bytes = try XCTUnwrap(result.dataProvider?.data)
        let pointer = try XCTUnwrap(CFDataGetBytePtr(bytes))
        // 16x16 pixelation cells must be flat; the source alternates every pixel.
        XCTAssertEqual(pointer[0], pointer[4])
        XCTAssertEqual(pointer[0], pointer[15 * 4])
        XCTAssertEqual(result.width, 32)
    }

    func testMixedScaleDisplaysComposeAtHighestScale() throws {
        let first = DisplayFrame(frame: CGRect(x: -16, y: 0, width: 16, height: 16),
                                 image: try image(width: 32, height: 32))
        let second = DisplayFrame(frame: CGRect(x: 0, y: 0, width: 16, height: 16),
                                  image: try image(width: 16, height: 16))
        let result = try AnnotationRenderer.render(frames: [first, second],
                                                   selection: CGRect(x: -8, y: 0, width: 16, height: 16),
                                                   annotations: [])
        XCTAssertEqual(result.width, 32)
        XCTAssertEqual(result.height, 32)
    }

    func testEmptySelectionIsRejected() {
        XCTAssertThrowsError(try AnnotationRenderer.render(frames: [], selection: .null, annotations: []))
    }
}
