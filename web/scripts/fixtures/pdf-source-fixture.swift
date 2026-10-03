import Foundation
import PDFKit
import CoreGraphics
import CoreText

// Disposable synthetic fixture generation only. This never opens a real PDF.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
func makePDF(_ kinds: [String]) -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    let consumer = CGDataConsumer(data: data as CFMutableData)!
    let context = CGContext(consumer: consumer, mediaBox: &box, nil)!
    for (index, kind) in kinds.enumerated() {
        context.beginPDFPage(nil)
        if kind == "image" {
            let provider = CGDataProvider(data: Data(repeating: 255, count: 16) as CFData)!
            let image = CGImage(width: 2, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 8,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
            context.draw(image, in: CGRect(x: 40, y: 600, width: 100, height: 100))
        } else {
            context.textMatrix = .identity
            context.textPosition = CGPoint(x: 40, y: 740)
            let font = CTFontCreateWithName("Helvetica" as CFString, 12, nil)
            let text = index == 0 ? "Recursion λ café résumé." : "Base cases end recursion."
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text,
                attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
            CTLineDraw(line, context)
        }
        context.endPDFPage()
    }
    context.closePDF()
    return data as Data
}
let text = makePDF(["text", "text"])
try text.write(to: directory.appendingPathComponent("text.pdf"))
try makePDF(["image"]).write(to: directory.appendingPathComponent("image.pdf"))
try makePDF(["text", "image"]).write(to: directory.appendingPathComponent("mixed.pdf"))
try makePDF(Array(repeating: "text", count: 201)).write(to: directory.appendingPathComponent("many.pdf"))
let document = PDFDocument(data: text)!
let encrypted = document.dataRepresentation(options: [PDFDocumentWriteOption.userPasswordOption: "synthetic-student-password", PDFDocumentWriteOption.ownerPasswordOption: "synthetic-owner-password"])!
try encrypted.write(to: directory.appendingPathComponent("encrypted.pdf"))
print("synthetic_pdf_fixtures_ready")
