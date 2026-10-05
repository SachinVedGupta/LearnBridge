import Foundation
import CoreFoundation
import PDFKit
import AppKit

// Fixed reviewed page renderer: short header and immutable bytes, no file/URL.
func emit(_ value: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= 3_000_000 else { exit(1) }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(0)
}
var input = Data()
while true {
    guard let part = try? FileHandle.standardInput.read(upToCount: min(65_536, 4_000_257 - input.count)), !part.isEmpty else { break }
    input.append(part); if input.count > 4_000_256 { emit(["status": "budget_exceeded"]) }
}
guard let boundary = input.firstIndex(of: 10), boundary <= 255,
      let header = try? JSONSerialization.jsonObject(with: input.prefix(boundary)) as? [String: Any],
      Set(header.keys) == Set(["operation", "physical_page"]), header["operation"] as? String == "render",
      let number = header["physical_page"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == Double(number.intValue), number.intValue > 0, number.intValue <= 200 else { exit(1) }
let bytes = Data(input.suffix(from: input.index(after: boundary)))
guard bytes.count <= 4_000_000, bytes.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: bytes), !document.isEncrypted, !document.isLocked,
      document.pageCount <= 200, document.pageCount >= number.intValue, let page = document.page(at: number.intValue - 1) else { exit(1) }
let bounds = page.bounds(for: .mediaBox)
guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0, bounds.width <= 20_000, bounds.height <= 20_000 else { exit(1) }
let scale = min(1200.0 / Double(bounds.width), 1600.0 / Double(bounds.height))
let image = page.thumbnail(of: NSSize(width: ceil(Double(bounds.width) * scale), height: ceil(Double(bounds.height) * scale)), for: .mediaBox)
guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), bitmap.pixelsWide > 0, bitmap.pixelsWide <= 1600,
      bitmap.pixelsHigh > 0, bitmap.pixelsHigh <= 1600, let png = bitmap.representation(using: .png, properties: [:]), png.count <= 2_000_000 else { emit(["status": "budget_exceeded"]) }
var regions: [[String: Any]] = []
if page.rotation == 0, let text = page.string {
    let lines = text.components(separatedBy: "\n")
    var offset = 0
    for line in lines {
        let length = line.utf16.count
        if regions.count < 150, length > 0, length <= 512, let selected = page.selection(for: NSRange(location: offset, length: length)) {
            let rect = selected.bounds(for: page).intersection(bounds)
            if !rect.isEmpty {
                regions.append(["text": line, "x": (rect.minX - bounds.minX) / bounds.width, "y": (bounds.maxY - rect.maxY) / bounds.height,
                                "width": rect.width / bounds.width, "height": rect.height / bounds.height])
            }
        }
        offset += length + 1
    }
}
emit(["status": "available", "renderer_version": "macos_pdfkit_page.v1", "physical_page": number.intValue, "page_count": document.pageCount,
      "width": bitmap.pixelsWide, "height": bitmap.pixelsHigh, "png_base64": png.base64EncodedString(), "text_regions": regions, "text_coordinates_available": page.rotation == 0])
