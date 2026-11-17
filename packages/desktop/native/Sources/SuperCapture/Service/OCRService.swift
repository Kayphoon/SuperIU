import Foundation
import Vision
import CoreGraphics

public enum OCRFailure: LocalizedError {
    case empty
    public var errorDescription: String? { "选区中未识别到文字，剪贴板未改变。" }
}

// An actor serializes expensive Vision work; the host accepts only one image job
// at a time, so full-resolution images cannot accumulate behind this actor.
public actor OCRService {
    public init() {}

    public func recognize(_ image: CGImage) throws -> String {
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
        request.automaticallyDetectsLanguage = true
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        try Task.checkCancellation()
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
