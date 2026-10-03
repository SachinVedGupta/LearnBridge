import Foundation
import CoreFoundation
import PDFKit

// Reviewed fixed helper. Input is a short JSON header followed by PDF bytes on
// stdin. No path, password, script, network URL or executable is accepted.
let maximumPDFBytes = 4_000_000
let maximumPages = 200
let maximumTextBytes = 256_000
let parserVersion = "macos_pdfkit.v1"

func emit(_ value: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= 128_000 else {
        FileHandle.standardOutput.write(Data("{\"status\":\"budget_exceeded\"}\n".utf8))
        exit(0)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(0)
}

func unavailable(_ status: String, _ count: Int = 0) -> Never {
    emit(["status": status, "parser_version": parserVersion, "page_count": count, "pages": []])
}

var input = Data()
while true {
    do {
        guard let part = try FileHandle.standardInput.read(upToCount: min(65_536, maximumPDFBytes + 257 - input.count)), !part.isEmpty else { break }
        input.append(part)
        if input.count > maximumPDFBytes + 256 { unavailable("budget_exceeded") }
    } catch { unavailable("malformed") }
}
guard let boundary = input.firstIndex(of: 10), boundary <= 255,
      let header = try? JSONSerialization.jsonObject(with: input.prefix(boundary)) as? [String: Any],
      let operation = header["operation"] as? String else { unavailable("malformed") }
let pdfData = Data(input.suffix(from: input.index(after: boundary)))
if operation == "probe" {
    guard Set(header.keys) == Set(["operation"]), pdfData.isEmpty else { unavailable("malformed") }
    emit(["status": "available", "parser_version": parserVersion, "probe": true])
}
guard operation == "extract", Set(header.keys) == Set(["operation", "max_text_bytes"]),
      let limitNumber = header["max_text_bytes"] as? NSNumber,
      CFGetTypeID(limitNumber) != CFBooleanGetTypeID(),
      limitNumber.doubleValue == Double(limitNumber.intValue),
      limitNumber.intValue >= 1, limitNumber.intValue <= maximumTextBytes else { unavailable("malformed") }
if pdfData.count > maximumPDFBytes { unavailable("budget_exceeded") }
guard pdfData.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: pdfData) else { unavailable("malformed") }
if document.pageCount > maximumPages { unavailable("budget_exceeded", document.pageCount) }
if document.isEncrypted || document.isLocked { unavailable("encrypted", document.pageCount) }
if document.pageCount < 1 { unavailable("malformed") }
var pages: [[String: Any]] = []
var textBytes = 0
var readablePages = 0
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { unavailable("malformed", document.pageCount) }
    let text = page.string ?? ""
    if text.contains("\0") { unavailable("text_unavailable", document.pageCount) }
    textBytes += text.utf8.count
    if textBytes > limitNumber.intValue { unavailable("budget_exceeded", document.pageCount) }
    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { readablePages += 1 }
    var value: [String: Any] = ["physical_page": index + 1, "text": text]
    if let label = page.label, !label.isEmpty, label.utf16.count <= 128, label.utf8.count <= 128,
       !label.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { value["printed_label"] = label }
    pages.append(value)
}
emit(["status": readablePages > 0 ? "available" : "text_unavailable", "parser_version": parserVersion, "page_count": document.pageCount, "pages": pages])
