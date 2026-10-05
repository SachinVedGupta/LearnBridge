import Foundation
import CoreFoundation
import AVFoundation
import AppKit
import CoreVideo

// This fixed native worker accepts only LearnBridge-created absolute file URLs.
// No URL requests, user-selected commands, source PDFs or model instructions run.
func fail() -> Never { exit(1) }
func emit(_ value: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count < 16_384 else { fail() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(0)
}
var bytes = Data()
while true {
    guard let part = try? FileHandle.standardInput.read(upToCount: min(65_536, 65_537 - bytes.count)), !part.isEmpty else { break }
    bytes.append(part); if bytes.count > 65_536 { fail() }
}
guard let input = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      Set(input.keys) == Set(["directory", "segments", "operation"]), input["operation"] as? String == "export",
      let directory = input["directory"] as? String, directory.hasPrefix("/"),
      UUID(uuidString: URL(fileURLWithPath: directory).lastPathComponent) != nil,
      let rows = input["segments"] as? [[String: Any]], rows.count > 0, rows.count <= 8 else { fail() }
let root = URL(fileURLWithPath: directory, isDirectory: true)
let keys: Set<String> = ["audio", "image", "duration_seconds"]
let output = root.appendingPathComponent("lecture.mp4"), videoOnly = root.appendingPathComponent("video-only.mp4")
guard !FileManager.default.fileExists(atPath: output.path), !FileManager.default.fileExists(atPath: videoOnly.path) else { fail() }
let width = 1280, height = 720, timescale: CMTimeScale = 60_000
var audioAssets: [AVURLAsset] = [], images: [CGImage] = [], durations: [Double] = []
for (index, row) in rows.enumerated() {
    let label = String(format: "%02d", index + 1)
    guard Set(row.keys) == keys, row["audio"] as? String == "slide-\(label).wav", row["image"] as? String == "slide-\(label).png",
          let number = row["duration_seconds"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue <= 300 else { fail() }
    let asset = AVURLAsset(url: root.appendingPathComponent("slide-\(label).wav"))
    let actual = CMTimeGetSeconds(asset.duration)
    guard actual.isFinite, actual > 0, abs(actual - number.doubleValue) <= 0.005,
          asset.tracks(withMediaType: .audio).count == 1,
          let data = try? Data(contentsOf: root.appendingPathComponent("slide-\(label).png")), data.count <= 2_000_000,
          let bitmap = NSBitmapImageRep(data: data), bitmap.pixelsWide > 0, bitmap.pixelsWide <= 1600,
          bitmap.pixelsHigh > 0, bitmap.pixelsHigh <= 1600, let image = bitmap.cgImage else { fail() }
    audioAssets.append(asset); images.append(image); durations.append(actual)
}
let total = durations.reduce(0, +)
guard total <= 1200 else { fail() }
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: videoOnly, fileType: .mp4) } catch { fail() }
let inputVideo = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_200_000, AVVideoMaxKeyFrameIntervalKey: 30]])
inputVideo.expectsMediaDataInRealTime = false; inputVideo.mediaTimeScale = timescale
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inputVideo, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferCGBitmapContextCompatibilityKey as String: true])
guard writer.canAdd(inputVideo) else { fail() }; writer.add(inputVideo)
guard writer.startWriting() else { fail() }; writer.startSession(atSourceTime: .zero)
func pixel(_ image: CGImage) -> CVPixelBuffer {
    var value: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, nil, &value) == kCVReturnSuccess, let result = value else { fail() }
    CVPixelBufferLockBaseAddress(result, []); defer { CVPixelBufferUnlockBaseAddress(result, []) }
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(result), width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(result), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { fail() }
    context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let scale = min(Double(width) / Double(image.width), Double(height) / Double(image.height)), w = Double(image.width) * scale, h = Double(image.height) * scale
    context.interpolationQuality = .high; context.draw(image, in: CGRect(x: (Double(width) - w) / 2, y: (Double(height) - h) / 2, width: w, height: h))
    return result
}
func append(_ image: CGImage, at seconds: Double) {
    let deadline = Date().addingTimeInterval(15)
    while !inputVideo.isReadyForMoreMediaData { if writer.status != .writing || Date() > deadline { fail() }; Thread.sleep(forTimeInterval: 0.005) }
    guard adaptor.append(pixel(image), withPresentationTime: CMTime(seconds: seconds, preferredTimescale: timescale)) else { fail() }
}
var cursor = 0.0
for index in images.indices { append(images[index], at: cursor); cursor += durations[index] }
// A final frame and explicit end session fix the last static slide's duration.
let finalTime = max(total - 1.0 / 30.0, durations.dropLast().reduce(0, +) + 0.00005)
if finalTime > 0 && finalTime < total { append(images.last!, at: finalTime) }
inputVideo.markAsFinished(); writer.endSession(atSourceTime: CMTime(seconds: total, preferredTimescale: timescale))
let videoDone = DispatchSemaphore(value: 0); writer.finishWriting { videoDone.signal() }
guard videoDone.wait(timeout: .now() + 30) == .success, writer.status == .completed else { fail() }
let composition = AVMutableComposition(), videoAsset = AVURLAsset(url: videoOnly)
guard let sourceVideo = videoAsset.tracks(withMediaType: .video).first,
      let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail() }
do {
    try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(seconds: total, preferredTimescale: timescale)), of: sourceVideo, at: .zero)
    var start = CMTime.zero
    for asset in audioAssets {
        guard let audio = asset.tracks(withMediaType: .audio).first else { fail() }
        try audioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: asset.duration), of: audio, at: start)
        start = CMTimeAdd(start, asset.duration)
    }
} catch { fail() }
guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality), exporter.supportedFileTypes.contains(.mp4) else { fail() }
exporter.outputURL = output; exporter.outputFileType = .mp4; exporter.shouldOptimizeForNetworkUse = true
let complete = DispatchSemaphore(value: 0); exporter.exportAsynchronously { complete.signal() }
guard complete.wait(timeout: .now() + 90) == .success, exporter.status == .completed else { fail() }
let saved = AVURLAsset(url: output), video = saved.tracks(withMediaType: .video), audio = saved.tracks(withMediaType: .audio), duration = CMTimeGetSeconds(saved.duration)
guard video.count == 1, audio.count == 1, duration.isFinite, abs(duration - total) <= 0.05,
      abs(CMTimeGetSeconds(audio[0].timeRange.duration) - total) <= 0.05,
      abs(CMTimeGetSeconds(video[0].timeRange.duration) - total) <= 0.05 else { fail() }
emit(["status": "available", "duration_seconds": duration, "audio_duration_seconds": CMTimeGetSeconds(audio[0].timeRange.duration),
      "video_duration_seconds": CMTimeGetSeconds(video[0].timeRange.duration), "width": width, "height": height,
      "audio_tracks": audio.count, "video_tracks": video.count, "renderer_version": "macos_avfoundation_lecture.v1"])
