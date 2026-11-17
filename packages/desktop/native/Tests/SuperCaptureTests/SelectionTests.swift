import XCTest
@testable import SuperCapture

final class SelectionTests: XCTestCase {
    func testReverseDragOnNegativeDisplayCoordinates() {
        let bounds = CGRect(x: -1440, y: -200, width: 2880, height: 1100)
        let rect = SelectionGeometry.rectangle(from: CGPoint(x: 200, y: 200),
                                               to: CGPoint(x: -1200, y: -100), within: bounds)
        XCTAssertEqual(rect, CGRect(x: -1200, y: -100, width: 1400, height: 300))
    }

    func testAllEightHandlesKeepOppositeEdgesAndClampAtBounds() {
        let original = CGRect(x: 10, y: 20, width: 100, height: 80)
        let bounds = CGRect(x: 0, y: 0, width: 200, height: 200)
        let cases: [(ResizeHandle, CGPoint, CGRect)] = [
            (.bottomLeft, CGPoint(x: -10, y: -10), CGRect(x: 0, y: 0, width: 110, height: 100)),
            (.bottom, CGPoint(x: 50, y: 30), CGRect(x: 10, y: 30, width: 100, height: 70)),
            (.bottomRight, CGPoint(x: 150, y: 10), CGRect(x: 10, y: 10, width: 140, height: 90)),
            (.right, CGPoint(x: 180, y: 150), CGRect(x: 10, y: 20, width: 170, height: 80)),
            (.topRight, CGPoint(x: 210, y: 210), CGRect(x: 10, y: 20, width: 190, height: 180)),
            (.top, CGPoint(x: 50, y: 150), CGRect(x: 10, y: 20, width: 100, height: 130)),
            (.topLeft, CGPoint(x: 5, y: 110), CGRect(x: 5, y: 20, width: 105, height: 90)),
            (.left, CGPoint(x: 0, y: 30), CGRect(x: 0, y: 20, width: 110, height: 80))
        ]
        for (handle, point, expected) in cases {
            XCTAssertEqual(handle.resized(original, to: point, within: bounds), expected)
        }
    }

    func testHandleCannotInvertTheSelection() {
        let original = CGRect(x: 10, y: 20, width: 100, height: 80)
        XCTAssertEqual(ResizeHandle.left.resized(original, to: CGPoint(x: 150, y: 40),
                                                within: CGRect(x: 0, y: 0, width: 200, height: 200)),
                       CGRect(x: 109, y: 20, width: 1, height: 80))
    }

    func testMoveClampsWithoutShrinking() {
        XCTAssertEqual(SelectionGeometry.moved(CGRect(x: 20, y: 30, width: 40, height: 60),
                                               by: CGSize(width: 500, height: -500),
                                               within: CGRect(x: 0, y: 0, width: 100, height: 100)),
                       CGRect(x: 60, y: 0, width: 40, height: 60))
    }

    func testRetinaPixelCropFlipsVerticalOrigin() {
        let screen = CGRect(x: -1440, y: 100, width: 1440, height: 900)
        XCTAssertEqual(SelectionGeometry.pixels(for: CGRect(x: -1400, y: 800, width: 100, height: 50),
                                                screen: screen, width: 2880, height: 1800),
                       CGRect(x: 80, y: 300, width: 200, height: 100))
    }
}
