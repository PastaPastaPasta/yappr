// Prints the payload of every QR code in an image, one per line (Core Image: macOS only,
// no third-party code). Used by qr-bridge.mjs; exits 1 when the image holds none.
import CoreImage
import Foundation

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("usage: qr-decode <image>\n".data(using: .utf8)!)
  exit(2)
}
guard let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else {
  FileHandle.standardError.write("cannot read the image\n".data(using: .utf8)!)
  exit(1)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let found = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
if found.isEmpty {
  FileHandle.standardError.write("no QR code found\n".data(using: .utf8)!)
  exit(1)
}
found.forEach { print($0) }
