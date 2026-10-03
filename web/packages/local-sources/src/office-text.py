"""Fixed, bounded OOXML text parser. Input/output only; never extract or fetch."""
import hashlib
import io
import json
import posixpath
import re
import stat
import struct
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

VERSION = 'stdlib_ooxml.v1'
MAX_ORIGINAL = 4_000_000
MAX_ENTRIES = 1000
MAX_EXPANDED = 8_000_000
MAX_XML = 2_000_000
MAX_SECTIONS = 1000
MAX_NODES = 100_000
MAX_DEPTH = 64
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
OFFICE_REL = R + '/officeDocument'
SLIDE_REL = R + '/slide'


class Refused(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason


def refuse(reason, status='unsupported'):
    raise Refused(status, reason)


def safe_name(name, directory=False):
    if (not name or len(name) > 1024 or len(name.encode('utf-8')) > 2048
            or name != unicodedata.normalize('NFC', name)
            or name.startswith('/') or '\\' in name or ':' in name or '%' in name
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in name)):
        refuse('unsafe_archive_path')
    parts = name[:-1].split('/') if directory and name.endswith('/') else name.split('/')
    if any(not part or part in ('.', '..') for part in parts):
        refuse('unsafe_archive_path')
    return name


def xml_tree(data):
    if len(data) > MAX_XML:
        refuse('xml_budget_exceeded', 'budget_exceeded')
    try:
        text = data.decode('utf-8-sig', 'strict')
    except UnicodeDecodeError:
        refuse('unsupported_xml_encoding')
    if '\x00' in text or re.search(r'<!\s*(DOCTYPE|ENTITY)\b', text, re.I):
        refuse('unsafe_xml_declaration')
    declaration = re.match(r'^\s*<\?xml\s+([^?]*)\?>', text, re.I)
    if declaration:
        encoding = re.search(r'\bencoding\s*=\s*([\'"])([^\'"]+)\1', declaration[1], re.I)
        if encoding and encoding[2].lower() not in ('utf-8', 'utf8'):
            refuse('unsupported_xml_encoding')
    try:
        root = ET.fromstring(text)
    except (ET.ParseError, ValueError):
        refuse('malformed_xml', 'malformed')
    stack, count = [(root, 1)], 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH or len(node.attrib) > 32:
            refuse('xml_budget_exceeded', 'budget_exceeded')
        if any(len(k) > 2048 or len(v) > 4096 for k, v in node.attrib.items()):
            refuse('xml_budget_exceeded', 'budget_exceeded')
        stack.extend((child, depth + 1) for child in node)
    return root


def archive_parts(original):
    if original.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        refuse('encrypted_or_legacy_container', 'encrypted')
    try:
        archive = zipfile.ZipFile(io.BytesIO(original))
    except (zipfile.BadZipFile, ValueError):
        refuse('malformed_archive', 'malformed')
    with archive:
        members = archive.infolist()
        if len(members) > MAX_ENTRIES or sum(item.file_size for item in members) > MAX_EXPANDED:
            refuse('archive_budget_exceeded', 'budget_exceeded')
        seen, infos = set(), {}
        for item in members:
            if item.orig_filename != item.filename:
                refuse('unsafe_archive_path')
            name = safe_name(item.orig_filename, item.is_dir())
            folded = name.casefold().rstrip('/')
            if folded in seen:
                refuse('duplicate_archive_part')
            seen.add(folded)
            if item.flag_bits & (1 | 64):
                refuse('encrypted_archive', 'encrypted')
            if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                refuse('unsupported_compression')
            mode = (item.external_attr >> 16) & 0xffff
            if item.create_system == 3 and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                refuse('unsafe_archive_entry_type')
            offset = item.header_offset
            if offset < 0 or offset + 30 > len(original):
                refuse('malformed_archive', 'malformed')
            header = struct.unpack_from('<4s5H3I2H', original, offset)
            if header[0] != b'PK\x03\x04' or header[2] & (1 | 64):
                refuse('encrypted_archive' if header[2] & (1 | 64) else 'malformed_archive',
                       'encrypted' if header[2] & (1 | 64) else 'malformed')
            local_name = original[offset + 30:offset + 30 + header[-2]]
            try:
                decoded = local_name.decode('utf-8' if header[2] & 0x800 else 'cp437')
            except UnicodeDecodeError:
                refuse('malformed_archive', 'malformed')
            if decoded != item.orig_filename or header[2] != item.flag_bits or header[3] != item.compress_type:
                refuse('malformed_archive', 'malformed')
            if header[1] != item.extract_version or 0xffffffff in (header[7], header[8]):
                refuse('unsupported_zip_metadata')
            data_start = offset + 30 + header[-2] + header[-1]
            data_end = data_start + item.compress_size
            if data_end > archive.start_dir or data_start > len(original):
                refuse('malformed_archive', 'malformed')
            if not header[2] & 8:
                if (header[6], header[7], header[8]) != (item.CRC, item.compress_size, item.file_size):
                    refuse('malformed_archive', 'malformed')
            else:
                # Streaming ZIPs put the final CRC/sizes in a data descriptor.
                # Never trust contradictory local or trailing metadata merely
                # because ZipFile chooses the central directory's values.
                if any(local not in (0, expected) for local, expected in zip(header[6:9], (item.CRC, item.compress_size, item.file_size))):
                    refuse('malformed_archive', 'malformed')
                descriptor = data_end + (4 if original[data_end:data_end + 4] == b'PK\x07\x08' else 0)
                if descriptor + 12 > archive.start_dir or struct.unpack_from('<3I', original, descriptor) != (item.CRC, item.compress_size, item.file_size):
                    refuse('malformed_archive', 'malformed')
            if re.search(r'(^|/)(vbaproject|vbadata)\b|\.(bin|exe|dll|js|vbs|hta)$', name, re.I):
                refuse('embedded_code_unsupported')
            infos[name] = item
        parts, expanded = {}, 0
        for name, item in infos.items():
            if item.is_dir():
                continue
            try:
                with archive.open(item) as stream:
                    data = stream.read(min(item.file_size + 1, MAX_EXPANDED - expanded + 1))
                    if stream.read(1) or len(data) != item.file_size:
                        refuse('archive_budget_exceeded', 'budget_exceeded')
            except (zipfile.BadZipFile, RuntimeError, EOFError, ValueError, NotImplementedError):
                refuse('malformed_archive', 'malformed')
            expanded += len(data)
            if expanded > MAX_EXPANDED:
                refuse('archive_budget_exceeded', 'budget_exceeded')
            if name.lower().endswith(('.xml', '.rels')):
                parts[name] = xml_tree(data)
        return parts, set(infos)


def resolve_target(owner, target):
    if (not target or len(target) > 1024 or '\\' in target or ':' in target
            or '%' in target or '?' in target or '#' in target
            or target.startswith('//') or any(ord(ch) < 32 for ch in target)):
        refuse('unsafe_relationship')
    path = posixpath.normpath(target[1:] if target.startswith('/') else posixpath.join(posixpath.dirname(owner), target))
    if path in ('.', '..') or path.startswith('../'):
        refuse('unsafe_relationship')
    return safe_name(path)


def relationships(parts, owner, reasons):
    name = posixpath.join(posixpath.dirname(owner), '_rels', posixpath.basename(owner) + '.rels') if owner else '_rels/.rels'
    root = parts.get(name)
    if root is None:
        return {}
    if root.tag != '{' + RELS + '}Relationships':
        refuse('malformed_relationships', 'malformed')
    result = {}
    for node in root:
        if node.tag != '{' + RELS + '}Relationship' or set(node.attrib) - {'Id', 'Type', 'Target', 'TargetMode'}:
            refuse('malformed_relationships', 'malformed')
        identifier, kind, target = (node.get(key) for key in ('Id', 'Type', 'Target'))
        if not identifier or identifier in result or not kind or not target:
            refuse('malformed_relationships', 'malformed')
        mode = node.get('TargetMode', 'Internal')
        if mode == 'External':
            if kind != R + '/hyperlink':
                refuse('external_relationship_unsupported')
            reasons.add('external_relationships_not_followed')
            result[identifier] = (kind, None)
        elif mode == 'Internal':
            result[identifier] = (kind, resolve_target(owner, target))
        else:
            refuse('unsafe_relationship')
    return result


def docx_sections(root, reasons):
    if root.tag != '{' + W + '}document':
        refuse('unsupported_document_namespace')
    bodies = root.findall('{' + W + '}body')
    if len(bodies) != 1:
        refuse('malformed_document', 'malformed')
    sections = []
    omitted = {'ins', 'del', 'moveFrom', 'moveTo'}
    containers = {'tbl', 'tr', 'tc', 'sdt', 'sdtContent', 'customXml'}

    def paragraph(node):
        output = []
        def visit(child):
            local = child.tag.removeprefix('{' + W + '}')
            if not child.tag.startswith('{' + W + '}'):
                reasons.add('unsupported_markup_omitted'); return
            if child.tag in {'{' + W + '}' + key for key in omitted}:
                reasons.add('revisions_omitted'); return
            if local in ('drawing', 'pict', 'txbxContent'):
                reasons.add('drawings_omitted')
                if child.tag == '{' + W + '}txbxContent' or any(nested.tag == '{' + W + '}txbxContent' for nested in child.iter()):
                    reasons.add('text_boxes_omitted')
                return
            if child.tag == '{' + W + '}p':
                reasons.add('nested_stories_omitted'); return
            if child.tag == '{' + W + '}t': output.append(child.text or '')
            elif child.tag == '{' + W + '}tab': output.append('\t')
            elif child.tag in ('{' + W + '}br', '{' + W + '}cr'): output.append('\n')
            elif local in ('r', 'hyperlink', 'fldSimple', 'sdt', 'sdtContent', 'smartTag', 'customXml'):
                for nested in child: visit(nested)
            elif local not in ('pPr', 'rPr', 'sdtPr', 'proofErr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'commentReference', 'fldChar', 'instrText'):
                reasons.add('unsupported_markup_omitted')
        for child in node: visit(child)
        return ''.join(output)

    def walk(node):
        for child in node:
            local = child.tag.removeprefix('{' + W + '}')
            if child.tag == '{' + W + '}p': sections.append(paragraph(child))
            elif child.tag in {'{' + W + '}' + key for key in omitted}: reasons.add('revisions_omitted')
            elif child.tag in {'{' + W + '}' + key for key in containers}: walk(child)
            elif local not in ('sectPr', 'sdtPr', 'tcPr', 'trPr', 'tblPr', 'tblGrid'):
                reasons.add('unsupported_body_content_omitted')
            if len(sections) > MAX_SECTIONS: refuse('section_budget_exceeded', 'budget_exceeded')
    walk(bodies[0])
    return sections


def pptx_sections(parts, root, reasons, overrides):
    if root.tag != '{' + P + '}presentation': refuse('unsupported_document_namespace')
    relation = relationships(parts, 'ppt/presentation.xml', reasons)
    lists = root.findall('{' + P + '}sldIdLst')
    if len(lists) > 1: refuse('malformed_presentation', 'malformed')
    sections, seen_ids, seen_parts = [], set(), set()
    for node in ([] if not lists else lists[0]):
        identifier, number = node.get('{' + R + '}id'), node.get('id')
        if node.tag != '{' + P + '}sldId' or not identifier or not number or number in seen_ids:
            refuse('malformed_presentation', 'malformed')
        seen_ids.add(number)
        entry = relation.get(identifier)
        if not entry or entry[0] != SLIDE_REL or not entry[1] or entry[1] in seen_parts:
            refuse('unsafe_slide_relationship')
        name = entry[1]
        if not re.fullmatch(r'ppt/slides/[^/]+\.xml', name): refuse('unsafe_slide_relationship')
        if overrides.get('/' + name) != 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml':
            refuse('unsupported_slide_content_type')
        seen_parts.add(name)
        slide = parts.get(name)
        if slide is None or slide.tag != '{' + P + '}sld': refuse('missing_or_malformed_slide', 'malformed')
        paragraphs = []
        def paragraph_text(paragraph):
            runs = []
            def visit(child):
                if child.tag == '{' + A + '}t': runs.append(child.text or '')
                elif child.tag == '{' + A + '}br': runs.append('\n')
                elif child.tag in ('{' + A + '}r', '{' + A + '}fld'):
                    for nested in child: visit(nested)
                elif child.tag not in ('{' + A + '}pPr', '{' + A + '}rPr', '{' + A + '}endParaRPr'):
                    reasons.add('unsupported_markup_omitted')
            for child in paragraph: visit(child)
            return ''.join(runs)
        allowed = {'{' + P + '}' + key for key in ('sld', 'cSld', 'spTree', 'grpSp', 'sp', 'txBody', 'graphicFrame')}
        allowed.update('{' + A + '}' + key for key in ('graphic', 'graphicData', 'tbl', 'tr', 'tc', 'txBody'))
        def walk(node):
            for child in node:
                if child.tag == '{' + A + '}p': paragraphs.append(paragraph_text(child))
                elif child.tag in allowed: walk(child)
                elif any(nested.tag in ('{' + A + '}t', '{' + A + '}p') for nested in child.iter()):
                    reasons.add('unsupported_markup_omitted')
        walk(slide)
        sections.append('\n'.join(paragraphs))
        if len(sections) > MAX_SECTIONS: refuse('section_budget_exceeded', 'budget_exceeded')
    return sections


def extract(original, kind, max_text):
    parts, names = archive_parts(original)
    reasons = {'layout_not_preserved'}
    types = parts.get('[Content_Types].xml')
    if types is None or types.tag != '{' + CT + '}Types': refuse('missing_content_types', 'malformed')
    if any('macroenabled' in (node.get('ContentType') or '').lower() or 'vba' in (node.get('ContentType') or '').lower() for node in types):
        refuse('embedded_code_unsupported')
    expected = 'word/document.xml' if kind == 'docx' else 'ppt/presentation.xml'
    main_type = 'application/vnd.openxmlformats-officedocument.' + ('wordprocessingml.document.main+xml' if kind == 'docx' else 'presentationml.presentation.main+xml')
    overrides, extensions = {}, set()
    for node in types:
        if node.tag == '{' + CT + '}Override':
            name = node.get('PartName', '')
            if not name.startswith('/') or name in overrides or not node.get('ContentType'):
                refuse('malformed_content_types', 'malformed')
            safe_name(name[1:]); overrides[name] = node.get('ContentType')
        elif node.tag == '{' + CT + '}Default':
            extension = node.get('Extension', '').casefold()
            if not extension or extension in extensions or not node.get('ContentType'):
                refuse('malformed_content_types', 'malformed')
            extensions.add(extension)
        else:
            refuse('malformed_content_types', 'malformed')
    if overrides.get('/' + expected) != main_type: refuse('unsupported_main_content_type')
    links = relationships(parts, '', reasons)
    main = [target for relation, target in links.values() if relation == OFFICE_REL]
    if main != [expected] or expected not in parts: refuse('missing_or_unsupported_main_part', 'malformed')
    # Validate every relationship part. No target is fetched or extracted.
    for name in parts:
        if name.endswith('.rels') and name != '_rels/.rels':
            match = re.fullmatch(r'(.*?)/?_rels/([^/]+)\.rels', name)
            if not match: refuse('malformed_relationships', 'malformed')
            relationships(parts, posixpath.join(match[1], match[2]), reasons)
    if any('/media/' in name for name in names): reasons.add('images_omitted')
    if any('/notesSlides/' in name for name in names): reasons.add('notes_omitted')
    if any('/charts/' in name for name in names): reasons.add('charts_omitted')
    if any(re.search(r'word/(header|footer)[^/]*\.xml$', name) for name in names): reasons.add('headers_footers_omitted')
    if any(name in names for name in ('word/footnotes.xml', 'word/endnotes.xml')): reasons.add('notes_omitted')
    if any('comments' in name.lower() for name in names): reasons.add('comments_omitted')
    sections = docx_sections(parts[expected], reasons) if kind == 'docx' else pptx_sections(parts, parts[expected], reasons, overrides)
    if not any(text.strip() for text in sections):
        return {'status': 'text_unavailable', 'parser_version': VERSION, 'document_type': kind,
                'section_count': len(sections), 'sections': [],
                'reasons': sorted((reasons - {'layout_not_preserved'}) | {'no_extractable_text'})}
    joined = '\n\n'.join(f'[{kind.upper()} {"paragraph" if kind == "docx" else "slide"} {index}]\n{text}' for index, text in enumerate(sections, 1))
    if len(joined.encode('utf-8')) > max_text: refuse('text_budget_exceeded', 'budget_exceeded')
    if any(not text.strip() for text in sections): reasons.add('sections_without_extractable_text')
    return {'status': 'available', 'parser_version': VERSION, 'document_type': kind,
            'section_count': len(sections), 'sections': sections, 'reasons': sorted(reasons)}


def main():
    header = sys.stdin.buffer.readline(4097)
    request = {}
    try:
        request = json.loads(header)
        if set(request) != {'document_type', 'max_text_bytes'} or request['document_type'] not in ('docx', 'pptx'):
            refuse('invalid_parser_request', 'malformed')
        max_text = request['max_text_bytes']
        if isinstance(max_text, bool) or not isinstance(max_text, int) or not 1 <= max_text <= 256_000:
            refuse('invalid_parser_request', 'malformed')
        original = sys.stdin.buffer.read(MAX_ORIGINAL + 1)
        if len(original) > MAX_ORIGINAL: refuse('archive_budget_exceeded', 'budget_exceeded')
        result = extract(original, request['document_type'], max_text)
    except Refused as error:
        result = {'status': error.status, 'parser_version': VERSION, 'document_type': request.get('document_type', 'docx'),
                  'section_count': 0, 'sections': [], 'reasons': [error.reason]}
    except Exception:
        result = {'status': 'malformed', 'parser_version': VERSION, 'document_type': request.get('document_type', 'docx'),
                  'section_count': 0, 'sections': [], 'reasons': ['malformed_document']}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
