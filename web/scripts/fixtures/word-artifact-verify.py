"""Independent fixture verifier for LearnBridge's fixed Word-text format."""
import hashlib
import io
import json
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
CP = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
         'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/custom.xml']


def verify(request, original):
    assert set(request) == {'expected_text', 'expected_manifest'}
    assert len(original) <= 512000
    expected = request['expected_text'].replace('\r\n', '\n').replace('\r', '\n')
    assert original[-22:-18] == b'PK\x05\x06'
    end = struct.unpack('<4s4H2IH', original[-22:])
    assert end[1:5] == (0, 0, 6, 6) and end[-1] == 0
    assert end[5] + end[6] == len(original) - 22
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        assert archive.namelist() == PARTS and archive.comment == b''
        assert archive.testzip() is None
        offset, content = 0, {}
        for member in archive.infolist():
            assert member.header_offset == offset and not member.is_dir()
            assert member.compress_type == zipfile.ZIP_STORED and member.flag_bits == 0x800
            assert member.date_time == (1980, 1, 1, 0, 0, 0)
            assert member.extract_version == member.create_version == 20 and member.create_system == 0
            assert member.extra == member.comment == b'' and member.external_attr == 0
            header = struct.unpack_from('<4s5H3I2H', original, offset)
            name = member.filename.encode('utf-8')
            assert header[:6] == (b'PK\x03\x04', 20, 0x800, 0, 0, 0x21)
            assert header[6:9] == (member.CRC, member.file_size, member.file_size)
            assert header[9:] == (len(name), 0)
            assert original[offset + 30:offset + 30 + len(name)] == name
            raw = archive.read(member)
            assert b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw
            content[member.filename] = ET.fromstring(raw)
            offset += 30 + len(name) + member.file_size
        assert offset == archive.start_dir == end[6]
    types = content[PARTS[0]]
    assert types.tag == '{' + CT + '}Types'
    assert [{key: value for key, value in node.attrib.items()} for node in types] == [
        {'Extension': 'rels', 'ContentType': 'application/vnd.openxmlformats-package.relationships+xml'},
        {'Extension': 'xml', 'ContentType': 'application/xml'},
        {'PartName': '/word/document.xml', 'ContentType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'},
        {'PartName': '/word/styles.xml', 'ContentType': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'},
        {'PartName': '/docProps/custom.xml', 'ContentType': 'application/vnd.openxmlformats-officedocument.custom-properties+xml'}]
    for name, relations in [('_rels/.rels', [
            {'Id': 'rId1', 'Type': R + '/officeDocument', 'Target': 'word/document.xml'},
            {'Id': 'rId2', 'Type': R + '/custom-properties', 'Target': 'docProps/custom.xml'}]),
            ('word/_rels/document.xml.rels', [{'Id': 'rId1', 'Type': R + '/styles', 'Target': 'styles.xml'}])]:
        root = content[name]
        assert root.tag == '{' + RELS + '}Relationships'
        assert all(node.tag == '{' + RELS + '}Relationship' for node in root)
        assert [node.attrib for node in root] == relations
    document = content['word/document.xml']
    assert document.tag == '{' + W + '}document' and len(document) == 1
    body = document[0]
    assert body.tag == '{' + W + '}body'
    assert all(node.tag == '{' + W + '}p' for node in list(body)[:-1])
    paragraphs = []
    for paragraph in list(body)[:-1]:
        assert len(paragraph) == 2 and paragraph[0].tag == '{' + W + '}pPr'
        assert len(paragraph[0]) == 1 and paragraph[0][0].tag == '{' + W + '}pStyle'
        assert paragraph[0][0].attrib == {'{' + W + '}val': 'Normal'}
        run = paragraph[1]
        assert run.tag == '{' + W + '}r'
        pieces = []
        for node in run:
            if node.tag == '{' + W + '}t':
                assert node.attrib == {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'} and len(node) == 0
                pieces.append(node.text or '')
            else:
                assert node.tag == '{' + W + '}tab' and not node.attrib and len(node) == 0
                pieces.append('\t')
        paragraphs.append(''.join(pieces))
    assert '\n'.join(paragraphs) == expected and len(paragraphs) <= 1000
    section = body[-1]
    assert section.tag == '{' + W + '}sectPr' and len(section) == 2
    assert section[0].tag == '{' + W + '}pgSz' and section[0].attrib == {'{' + W + '}w': '12240', '{' + W + '}h': '15840'}
    assert section[1].tag == '{' + W + '}pgMar' and section[1].attrib == {
        '{' + W + '}' + name: value for name, value in [('top', '1440'), ('right', '1440'), ('bottom', '1440'),
                                                      ('left', '1440'), ('header', '720'), ('footer', '720'), ('gutter', '0')]}
    allowed = {'document', 'body', 'p', 'pPr', 'pStyle', 'r', 't', 'tab', 'sectPr', 'pgSz', 'pgMar'}
    assert all(node.tag.startswith('{' + W + '}') and node.tag[len(W) + 2:] in allowed for node in document.iter())
    styles = content['word/styles.xml']
    assert styles.tag == '{' + W + '}styles'
    assert [node.get('{' + W + '}val') for node in styles.iter('{' + W + '}sz')] == ['22']
    assert [node.get('{' + W + '}val') for node in styles.iter('{' + W + '}color')] == ['000000']
    assert all(node.get('{' + W + '}ascii') == 'Calibri' for node in styles.iter('{' + W + '}rFonts'))
    custom = content['docProps/custom.xml']
    assert custom.tag == '{' + CP + '}Properties' and len(custom) == 1
    prop = custom[0]
    assert prop.tag == '{' + CP + '}property' and prop.attrib == {
        'fmtid': '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}', 'pid': '2', 'name': 'LearnBridgeManifest'}
    assert len(prop) == 1 and prop[0].tag == '{' + VT + '}lpwstr' and not prop[0].attrib
    manifest = json.loads(prop[0].text)
    assert manifest == request['expected_manifest']
    assert manifest['original_text_sha256'] == hashlib.sha256(request['expected_text'].encode('utf-8')).hexdigest()
    assert manifest['normalized_text_sha256'] == hashlib.sha256(expected.encode('utf-8')).hexdigest()
    assert manifest['paragraph_count'] == len(paragraphs)
    return {'status': 'PASS', 'sha256': hashlib.sha256(original).hexdigest(), 'byte_length': len(original),
            'paragraph_count': len(paragraphs), 'part_count': len(PARTS),
            'normalized_text_sha256': manifest['normalized_text_sha256'], 'external_relationships': 0}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.readline(200001))
        original = sys.stdin.buffer.read(512001)
        result = verify(request, original)
        print(json.dumps(result, separators=(',', ':')))
    except Exception:
        sys.stderr.write('WORD_TEXT_FIXTURE_VERIFICATION_FAILED\n')
        sys.exit(1)
