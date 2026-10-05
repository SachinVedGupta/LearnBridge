import Foundation
import AVFoundation
import AppKit
guard CommandLine.arguments.count >= 4, CommandLine.arguments.count <= 8 else { exit(1) }
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let generator = AVAssetImageGenerator(asset: asset); generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
var pixels: [[Int]] = []
for value in CommandLine.arguments.dropFirst(2) {
    guard let seconds = Double(value), let image = try? generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 60000), actualTime: nil) else { exit(1) }
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let color = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?.usingColorSpace(.deviceRGB) else { exit(1) }
    pixels.append([Int(color.redComponent * 255), Int(color.greenComponent * 255), Int(color.blueComponent * 255)])
}
let value: [String: Any] = ["pixels": pixels, "duration": CMTimeGetSeconds(asset.duration), "audio_tracks": asset.tracks(withMediaType: .audio).count, "video_tracks": asset.tracks(withMediaType: .video).count]
guard let output = try? JSONSerialization.data(withJSONObject: value) else { exit(1) }
FileHandle.standardOutput.write(output)
