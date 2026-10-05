"""Independent zipfile/ElementTree oracle for synthetic formatted Word files."""
import hashlib
import io
import json
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
         'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels',
         'docProps/custom.xml']


def verify(request, original):
    assert set(request) == {'expected_text', 'expected_paragraphs', 'expected_manifest'}
    assert len(original) <= 512000 and original[-22:-18] == b'PK\x05\x06'
    end = struct.unpack('<4s4H2IH', original[-22:])
    assert end[1:5] == (0, 0, 7, 7) and end[-1] == 0
    assert end[5] + end[6] == len(original) - 22
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        assert archive.namelist() == PARTS and archive.comment == b''
        assert archive.testzip() is None
        offset, content = 0, {}
        for member in archive.infolist():
            assert member.header_offset == offset and not member.is_dir()
            assert member.compress_type == zipfile.ZIP_STORED and member.flag_bits == 0x800
            assert member.date_time == (1980, 1, 1, 0, 0, 0)
            assert member.extra == member.comment == b'' and member.external_attr == 0
            assert member.file_size == member.compress_size
            name = member.filename.encode('utf-8')
            header = struct.unpack_from('<4s5H3I2H', original, offset)
            assert header[:6] == (b'PK\x03\x04', 20, 0x800, 0, 0, 0x21)
            assert header[6:9] == (member.CRC, member.file_size, member.file_size)
            assert header[9:] == (len(name), 0)
            assert original[offset + 30:offset + 30 + len(name)] == name
            raw = archive.read(member)
            assert b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw
            content[member.filename] = ET.fromstring(raw)
            offset += 30 + len(name) + member.file_size
        assert offset == archive.start_dir == end[6]
    for name, expected_targets in [('_rels/.rels', ['word/document.xml', 'docProps/custom.xml']),
                                   ('word/_rels/document.xml.rels', ['styles.xml', 'numbering.xml'])]:
        relations = content[name]
        assert relations.tag == '{' + RELS + '}Relationships'
        assert [node.get('Target') for node in relations] == expected_targets
        assert all(node.tag == '{' + RELS + '}Relationship' and 'TargetMode' not in node.attrib for node in relations)
    numbering = content['word/numbering.xml']
    abstract = {node.get('{' + W + '}abstractNumId'): node for node in numbering.findall('{' + W + '}abstractNum')}
    numbers = {}
    for node in numbering.findall('{' + W + '}num'):
        num_id = node.get('{' + W + '}numId')
        abstract_id = node.find('{' + W + '}abstractNumId').get('{' + W + '}val')
        level = abstract[abstract_id].find('{' + W + '}lvl')
        kind = level.find('{' + W + '}numFmt').get('{' + W + '}val')
        override = node.find('{' + W + '}lvlOverride')
        start = int(override.find('{' + W + '}startOverride').get('{' + W + '}val')) if override is not None else 1
        numbers[num_id] = [kind, start]
    body = content['word/document.xml'].find('{' + W + '}body')
    assert body[-1].tag == '{' + W + '}sectPr'
    parsed = []
    rendered = []
    for paragraph in list(body)[:-1]:
        assert paragraph.tag == '{' + W + '}p'
        properties = paragraph.find('{' + W + '}pPr')
        style = properties.find('{' + W + '}pStyle').get('{' + W + '}val')
        num_properties = properties.find('{' + W + '}numPr')
        prefix = ''
        number = None
        if num_properties is not None:
            num_id = num_properties.find('{' + W + '}numId').get('{' + W + '}val')
            kind, next_number = numbers[num_id]
            if kind == 'bullet':
                prefix = '• '
            else:
                number = next_number
                prefix = str(number) + '. '
                numbers[num_id][1] += 1
        runs = []
        for run in paragraph.findall('{' + W + '}r'):
            properties = run.find('{' + W + '}rPr')
            bold = properties is not None and properties.find('{' + W + '}b') is not None
            italic = properties is not None and properties.find('{' + W + '}i') is not None
            pieces = []
            for node in run:
                if node.tag == '{' + W + '}t':
                    assert node.attrib == {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'} and len(node) == 0
                    pieces.append(node.text or '')
                elif node.tag == '{' + W + '}tab':
                    assert not node.attrib and len(node) == 0
                    pieces.append('\t')
                else:
                    assert node.tag == '{' + W + '}rPr'
                    assert all(child.tag in ['{' + W + '}b', '{' + W + '}i'] for child in node)
            runs.append({'text': ''.join(pieces), 'bold': bold, 'italic': italic})
        parsed.append({'style': style, 'number': number, 'bullet': prefix == '• ', 'runs': runs})
        rendered.append(prefix + ''.join(run['text'] for run in runs))
    assert parsed == request['expected_paragraphs']
    assert all(node.tag.split('}')[-1] not in ['hyperlink', 'instrText', 'fldSimple', 'drawing', 'object', 'altChunk'] for node in content['word/document.xml'].iter())
    styles = content['word/styles.xml']
    assert [node.get('{' + W + '}styleId') for node in styles.findall('{' + W + '}style')] == ['Normal', 'ListParagraph', 'Heading1', 'Heading2', 'Heading3']
    assert [node.get('{' + W + '}val') for node in styles.iter('{' + W + '}outlineLvl')] == ['0', '1', '2']
    manifest = json.loads(content['docProps/custom.xml'].find('.//{' + VT + '}lpwstr').text)
    assert manifest == request['expected_manifest']
    assert manifest['original_text_sha256'] == hashlib.sha256(request['expected_text'].encode('utf-8')).hexdigest()
    assert manifest['rendered_text_sha256'] == hashlib.sha256('\n'.join(rendered).encode('utf-8')).hexdigest()
    assert manifest['paragraph_count'] == len(parsed)
    assert manifest['run_count'] == sum(len(p['runs']) for p in parsed)
    return {'status': 'PASS', 'sha256': hashlib.sha256(original).hexdigest(), 'byte_length': len(original),
            'paragraph_count': len(parsed), 'part_count': len(PARTS), 'external_relationships': 0}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.readline(250001))
        original = sys.stdin.buffer.read(512001)
        print(json.dumps(verify(request, original), separators=(',', ':')))
    except Exception:
        sys.stderr.write('RICH_WRITING_FIXTURE_VERIFICATION_FAILED\n')
        sys.exit(1)
