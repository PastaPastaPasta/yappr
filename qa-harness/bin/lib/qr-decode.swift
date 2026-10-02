// Decodes QR codes in an image with Core Image (no third-party deps). Prints one payload per line.
import CoreImage
import Foundation

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: qr-decode <image>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = CIImage(contentsOf: url) else {
  FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
  exit(1)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let found = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
if found.isEmpty {
  FileHandle.standardError.write("no QR code found\n".data(using: .utf8)!)
  exit(1)
}
found.forEach { print($0) }
