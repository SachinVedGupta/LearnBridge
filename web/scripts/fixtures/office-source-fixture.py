"""Create only disposable synthetic Office import fixtures; no Office dependency.

CLI: python -I -S -B office-source-fixture.py OUTPUT_DIR
Reusable: make_fixtures(path), docx_parts(paragraphs), pptx_parts(slides, order).
The output directory must be absent or empty. Existing files are never replaced.
"""

import base64
import io
import os
from pathlib import Path
import struct
import sys
import warnings
import zipfile
from xml.sax.saxutils import escape


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_R = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
PPTX_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
PPTX_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'


def content_types(overrides, defaults=None):
    defaults = defaults or [("rels", "application/vnd.openxmlformats-package.relationships+xml"),
                            ("xml", "application/xml")]
    entries = [f'<Default Extension="{escape(ext)}" ContentType="{escape(kind)}"/>'
               for ext, kind in defaults]
    entries += [f'<Override PartName="/{escape(name)}" ContentType="{escape(kind)}"/>'
                for name, kind in overrides]
    return XML_DECLARATION + f'<Types xmlns="{CONTENT_TYPES}">' + "".join(entries) + "</Types>"


def relationships(items):
    entries = []
    for identifier, kind, target, mode in items:
        mode_attribute = f' TargetMode="{mode}"' if mode else ""
        entries.append(f'<Relationship Id="{escape(identifier)}" Type="{escape(kind)}" '
                       f'Target="{escape(target)}"{mode_attribute}/>')
    return XML_DECLARATION + f'<Relationships xmlns="{PACKAGE_R}">' + "".join(entries) + "</Relationships>"


def paragraph(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def document(body):
    return XML_DECLARATION + f'<w:document xmlns:w="{W}" xmlns:r="{R}">' + "<w:body>" + body + "</w:body></w:document>"


def docx_parts(paragraphs):
    return {
        "[Content_Types].xml": content_types([("word/document.xml", DOCX_MAIN)]),
        "_rels/.rels": relationships([("rDocument", R + "/officeDocument", "word/document.xml", None)]),
        "word/document.xml": document("".join(paragraph(text) for text in paragraphs)),
    }


def slide(text):
    shape = (f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Synthetic text"/>'
             '<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody>'
             '<a:bodyPr/><a:lstStyle/><a:p><a:r>'
             f'<a:t>{escape(text)}</a:t></a:r><a:endParaRPr/></a:p>'
             '</p:txBody></p:sp>') if text else ""
    return (XML_DECLARATION + f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}">'
            '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/>'
            '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
            + shape + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/>'
            '</p:clrMapOvr></p:sld>')


def pptx_parts(slides, order):
    """slides maps physical file numbers to text; order is presentation order."""
    slide_ids = "".join(f'<p:sldId id="{255 + number}" r:id="rSlide{number}"/>' for number in order)
    parts = {
        "[Content_Types].xml": content_types([("ppt/presentation.xml", PPTX_MAIN)] +
                                             [(f"ppt/slides/slide{number}.xml", PPTX_SLIDE) for number in slides]),
        "_rels/.rels": relationships([("rPresentation", R + "/officeDocument", "ppt/presentation.xml", None)]),
        "ppt/presentation.xml": (XML_DECLARATION + f'<p:presentation xmlns:p="{P}" xmlns:r="{R}">'
                                 + "<p:sldIdLst>" + slide_ids + "</p:sldIdLst>"
                                 '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
                                 '</p:presentation>'),
        "ppt/_rels/presentation.xml.rels": relationships([
            (f"rSlide{number}", R + "/slide", f"slides/slide{number}.xml", None) for number in slides]),
    }
    parts.update({f"ppt/slides/slide{number}.xml": slide(text) for number, text in slides.items()})
    return parts


def package_bytes(parts, extra_entries=()):
    stream = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # The duplicate-name case is intentional.
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, value in list(parts.items()) + list(extra_entries):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100600 << 16
                archive.writestr(info, value.encode("utf-8") if isinstance(value, str) else value)
    return stream.getvalue()


def encrypted_flag_bytes(value, selected="word/document.xml"):
    """Flag one valid ZIP member encrypted without retaining a password or key.

    This is a parser-refusal fixture, not a genuine password-protected document.
    Patch both central and local flag fields so ordinary ZipFile reports bit 0.
    """
    output = bytearray(value)
    with zipfile.ZipFile(io.BytesIO(value)) as archive:
        info = archive.getinfo(selected)
        local_flag = struct.unpack_from("<H", output, info.header_offset + 6)[0]
        struct.pack_into("<H", output, info.header_offset + 6, local_flag | 1)
        position = archive.start_dir
        for current in archive.infolist():
            if output[position:position + 4] != b"PK\x01\x02":
                raise ValueError("Unexpected synthetic central directory")
            name_size, extra_size, comment_size = struct.unpack_from("<HHH", output, position + 28)
            if current.filename == selected:
                central_flag = struct.unpack_from("<H", output, position + 8)[0]
                struct.pack_into("<H", output, position + 8, central_flag | 1)
            position += 46 + name_size + extra_size + comment_size
    return bytes(output)


def make_fixtures(output_dir):
    root = Path(output_dir)
    if root.exists():
        if root.is_symlink() or not root.is_dir() or any(root.iterdir()):
            raise ValueError("Fixture output must be absent or an empty regular directory")
    else:
        root.mkdir(mode=0o700, parents=True)
    os.chmod(root, 0o700)
    regular_docx = docx_parts([
        "Synthetic course note λ café résumé.",
        "Read this evidence, then explain one idea.",
    ])
    ordered_slides = {1: "First file, second presentation slide café.",
                      2: "Second file, first presentation slide λ."}
    fixtures = {
        "text.docx": package_bytes(regular_docx),
        "ordered.pptx": package_bytes(pptx_parts(ordered_slides, [2, 1])),
        "blank.docx": package_bytes(docx_parts([""])),
        "blank.pptx": package_bytes(pptx_parts({1: ""}, [1])),
        "unsafe.docx": package_bytes(regular_docx, [("../escape.txt", "MUST NOT BE EXTRACTED")]),
        "duplicate.docx": package_bytes(regular_docx, [("word/document.xml", document(paragraph("DUPLICATE MUST NOT WIN")))]),
        "encrypted.docx": encrypted_flag_bytes(package_bytes(regular_docx)),
        "malformed.docx": b"Synthetic fixture: this is not a ZIP archive.\n",
    }
    entities = dict(regular_docx)
    entities["word/document.xml"] = (XML_DECLARATION + '<!DOCTYPE w:document [<!ENTITY payload "ENTITY MUST NEVER EXPAND">]>'
                                     + f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&payload;'
                                     '</w:t></w:r></w:p></w:body></w:document>')
    fixtures["entity.docx"] = package_bytes(entities)
    utf16 = dict(regular_docx)
    utf16["word/document.xml"] = regular_docx["word/document.xml"].replace('encoding="UTF-8"', 'encoding="UTF-16"').encode("utf-16")
    fixtures["utf16.docx"] = package_bytes(utf16)
    macro = dict(regular_docx)
    macro["[Content_Types].xml"] = content_types([
        ("word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml"),
        ("word/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
    ])
    macro["word/vbaProject.bin"] = b"Synthetic inert macro marker; never executable."
    fixtures["macro.docx"] = package_bytes(macro)
    bomb = dict(regular_docx)
    bomb["word/document.xml"] = document(paragraph("B" * 9_000_000))
    fixtures["bomb.docx"] = package_bytes(bomb)
    external = pptx_parts(ordered_slides, [2, 1])
    external["ppt/_rels/presentation.xml.rels"] = relationships([
        ("rSlide2", R + "/slide", "https://example.invalid/never-fetch.xml", "External"),
        ("rSlide1", R + "/slide", "slides/slide1.xml", None),
    ])
    fixtures["relationship.pptx"] = package_bytes(external)
    missing = pptx_parts(ordered_slides, [2, 1])
    del missing["ppt/slides/slide2.xml"]
    fixtures["missing-slide.pptx"] = package_bytes(missing)
    revisions = dict(regular_docx)
    revised_body = (paragraph("Visible base paragraph.")
                    + '<w:p><w:ins w:id="1" w:author="Synthetic" w:date="2020-01-01T00:00:00Z">'
                    '<w:r><w:t>INSERTED TRACKED CONTENT MUST BE OMITTED.</w:t></w:r></w:ins>'
                    '<w:del w:id="2" w:author="Synthetic" w:date="2020-01-01T00:00:00Z">'
                    '<w:r><w:delText>DELETED TRACKED CONTENT MUST BE OMITTED.</w:delText></w:r></w:del></w:p>'
                    '<w:p><w:r><w:pict><v:shape id="SyntheticShape" style="width:20pt;height:20pt">'
                    '<v:textbox><w:txbxContent><w:p><w:r><w:t>TEXTBOX MUST NOT BE DUPLICATED OR IMPORTED.</w:t>'
                    '</w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>')
    revisions["word/document.xml"] = document(revised_body).replace(f'xmlns:r="{R}"', f'xmlns:r="{R}" xmlns:v="urn:schemas-microsoft-com:vml"')
    revisions["word/media/image1.png"] = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4msAAAAASUVORK5CYII=")
    fixtures["revisions.docx"] = package_bytes(revisions)
    mc = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    markup_docx = docx_parts(["Visible legitimate base."])
    markup_body = ('<w:p><w:r><w:t>Visible legitimate base.</w:t></w:r>'
                   '<mc:AlternateContent><mc:Choice Requires="w14"><w:r>'
                   '<w:t>CHOICE DOCX CANARY MUST BE OMITTED.</w:t></w:r></mc:Choice>'
                   '<mc:Fallback><w:r><w:t>FALLBACK DOCX CANARY MUST BE OMITTED.</w:t>'
                   '</w:r></mc:Fallback></mc:AlternateContent><x:payload><w:r>'
                   '<w:t>FOREIGN DOCX CANARY MUST BE OMITTED.</w:t></w:r></x:payload></w:p>')
    markup_docx["word/document.xml"] = document(markup_body).replace(
        f'xmlns:r="{R}"', f'xmlns:r="{R}" xmlns:mc="{mc}" '
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:x="urn:synthetic:unknown"')
    fixtures["markup.docx"] = package_bytes(markup_docx)
    markup_pptx = pptx_parts({1: "Visible legitimate base."}, [1])
    extra_runs = ('<mc:AlternateContent><mc:Choice Requires="a14"><a:r>'
                  '<a:t>CHOICE PPTX CANARY MUST BE OMITTED.</a:t></a:r></mc:Choice>'
                  '<mc:Fallback><a:r><a:t>FALLBACK PPTX CANARY MUST BE OMITTED.</a:t>'
                  '</a:r></mc:Fallback></mc:AlternateContent><x:payload><a:r>'
                  '<a:t>FOREIGN PPTX CANARY MUST BE OMITTED.</a:t></a:r></x:payload>')
    markup_pptx["ppt/slides/slide1.xml"] = markup_pptx["ppt/slides/slide1.xml"].replace(
        f'xmlns:r="{R}"', f'xmlns:r="{R}" xmlns:mc="{mc}" '
        'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:x="urn:synthetic:unknown"').replace(
        '<a:endParaRPr/>', extra_runs + '<a:endParaRPr/>')
    fixtures["markup.pptx"] = package_bytes(markup_pptx)
    wrong_type = pptx_parts({1: "Slide content type must be validated."}, [1])
    wrong_type["[Content_Types].xml"] = content_types([
        ("ppt/presentation.xml", PPTX_MAIN), ("ppt/slides/slide1.xml", "application/xml")])
    fixtures["wrong-content-type.pptx"] = package_bytes(wrong_type)
    missing_type = pptx_parts({1: "Missing slide content type must be rejected."}, [1])
    missing_type["[Content_Types].xml"] = content_types([("ppt/presentation.xml", PPTX_MAIN)])
    fixtures["missing-content-type.pptx"] = package_bytes(missing_type)
    for name, value in fixtures.items():
        descriptor = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(value)
    return tuple(root / name for name in fixtures)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: office-source-fixture.py OUTPUT_DIR")
    make_fixtures(sys.argv[1])
