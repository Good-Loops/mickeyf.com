// Host-side verification only. This file is not part of the iOS app or its archive.
import Foundation
import ImageIO
import Vision

do {
    guard CommandLine.arguments.count == 2,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "LudolumeScreenshot", code: 1)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: " ").lowercased()
    let navigationMatches = ["home", "entertainment", "connect", "account"].filter { text.contains($0) }.count
    let result: [String: Any] = [
        "width": image.width, "height": image.height,
        "home": text.contains("welcome") && text.contains("glad"),
        "navigation": navigationMatches >= 2
    ]
    let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
} catch {
    // Never print recognized text: store artifacts should not acquire incidental account or log data.
    FileHandle.standardError.write(Data("Native Home image recognition failed.\n".utf8))
    exit(1)
}
