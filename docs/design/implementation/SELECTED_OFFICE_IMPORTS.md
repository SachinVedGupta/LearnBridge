# Selected DOCX and PPTX evidence imports

Status: **available — verified local synthetic slice**. Selected DOCX/PPTX acquisition, immutable storage, paired runtime readback, actual MCP selected-context disclosure and dashboard behavior have measured proof on the current macOS host. Review findings are fixed. Genuine Office-authored document interoperability, Linux execution and a Codex/Claude model turn using Office evidence are **not verified**.

## Student behavior and initial scope

A student selects a narrow local folder, reviews its metadata inventory and explicitly imports one DOCX or PPTX file. LearnBridge shows extracted evidence with paragraph or slide positions and discloses omissions. A separate reviewed sharing action permits an agent to use that immutable snapshot. Inventory does not read document bodies, import does not enable broader folder access, and extraction does not generate a tutor answer or change the original document.

The initial implementation reads the selected original through the existing anchored, no-follow file-descriptor worker. A fixed Python helper receives bounded bytes through a private pipe, opens the OOXML package in memory and returns bounded text evidence. It uses Python standard-library ZIP/XML support; it does not launch Word, PowerPoint, LibreOffice, a shell, macros, OCR, an external converter or a browser. Nothing is extracted to disk or fetched from document relationships. The original Office bytes are not saved in the student workspace.

This is a deliberately limited OOXML text reader, not an Office renderer or complete standards validator. ECMA-376 separates the markup vocabulary from the Open Packaging Conventions; a file extension alone does not establish package identity. Validate package relationships and content types before attributing text to DOCX or PPTX. [ECMA-376 standard and its four parts](https://ecma-international.org/publications-and-standards/standards/ecma-376/).

Initial supported packages use the familiar transitional OOXML namespaces and canonical `word/document.xml` or `ppt/presentation.xml` main parts. A valid document outside the supported subset must receive an explicit unavailable/unsupported result, rather than speculative extraction. Encrypted packages, legacy `.doc`/`.ppt`, macro-enabled formats, OCR and password handling remain outside this increment.

## Acquisition and authority

1. Validate the reviewed source descriptor, inventory version and explicitly selected entry. Extension eligibility is metadata only.
2. Open the approved directory chain and regular file by anchored file descriptors with `O_NOFOLLOW`. Reject links, multiple hard links, changed ancestors, changed file identity and size/budget violations. Read bounded original bytes only after authorization.
3. Preserve the original SHA-256 and byte length separately from the extracted-text hash. Pass only bytes and fixed extraction options to the fixed helper; never pass a student path, arbitrary executable, network token or password.
4. Parse under a fixed process deadline and strict stdout/stderr limits. Diagnostic messages and source excerpts stay private; return only allowlisted result states and bounded reason codes.
5. Revalidate the selected source chain and file snapshot after parsing. Recheck request authorization before persistence. Cancellation, revocation or replacement during extraction withholds the result.
6. Validate the returned structure, text hashes and UTF-8 ranges before saving text and Office provenance atomically. Revocation must withhold future saved reads and agent context as it does for existing source snapshots.

Do not replace the existing anchored worker with a later path-based file read. Do not accept a successful parser result as evidence that the selected file is still authorized or unchanged.

## Evidence contract

An available result has the existing outer selected-source fields: `text`, extracted-text `sha256`, selected file `version`, reviewed `title`, and an `office` object. Office provenance starts at schema version 1:

```json
{
  "schema_version": 1,
  "format": "office_text",
  "parser_version": "stdlib_ooxml.v1",
  "document_type": "docx",
  "source_sha256": "<SHA-256 of original package bytes>",
  "source_bytes": 1234,
  "section_count": 1,
  "sections": [
    {
      "position": 1,
      "unit": "paragraph",
      "text": "Synthetic course note λ café résumé.",
      "sha256": "<SHA-256 of this exact UTF-8 section text>",
      "byte_range": { "start": 19, "end": 59 }
    }
  ],
  "extraction_status": "available",
  "coverage": { "state": "partial", "reasons": ["layout_not_preserved"] }
}
```

The range example assumes the outer text starts with `[DOCX paragraph 1]\n` followed by the shown 40-byte body; original size and hashes are placeholders. Tests must calculate and assert actual ranges rather than copy them. The document-type discriminator is `docx` or `pptx`; section units are `paragraph` or `slide` respectively. Positions start at one and refer to body-paragraph or presentation-slide order, never inferred page numbers or slide filenames. The serialized field names and status/reason constraints must match the implemented validator before release.

Every available import is **partial**, with `layout_not_preserved` included even when all supported text is extracted. Section ranges identify exact UTF-8 bytes in the joined outer `text`, excluding any generated citation marker and separators. Section hashes cover only the exact section body. Preserve empty sections where they carry a meaningful position, with empty hashes and zero-width ranges. `section_count` and the section list must agree; no truncation may silently renumber sections or imply full coverage.

Unavailable, encrypted, malformed, unsupported or budget-rejected results cannot become usable saved source snapshots. Do not substitute an empty successful import for textless documents. Statuses use a closed documented set; coverage reasons intentionally use a bounded extensible contract: a nonempty list of at most 20 unique strings matching `^[a-z_]{1,80}$`, rather than a closed enumeration. Available results require `layout_not_preserved`. The fixed helper supplies reason codes; failures must not expose raw parser exceptions, archive paths or body content. Storage and restore validation must preserve these same constraints.

## DOCX extraction semantics

The main WordprocessingML story is represented by a document body containing paragraphs and runs; text lives in the text elements within those runs. Headers, footers, comments, footnotes and other stories are separate parts. The importer should expose its smaller supported body-text scope rather than imply those stories were reviewed. [Microsoft: WordprocessingML structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document).

For this increment:

- Validate the unique internal root office-document relationship, non-macro document content type, main document root namespace and body.
- Read supported body paragraphs in document order. Preserve text-run boundaries without adding spaces that were absent in the source; retain explicit tabs and line breaks under a documented normalization policy.
- Use namespace-qualified element names. A foreign element named `t`, `p` or `body` is not WordprocessingML evidence.
- Omit tracked insertion/deletion/move regions, field instructions, embedded objects, drawings and text-box stories. Report omissions through partial coverage; do not choose a tracked-revision state on the student's behalf.
- Traverse supported body tables, rows/cells, content controls and custom-XML containers in body order under the XML/section bounds; this is text traversal and does not preserve table layout. Do not count an inner text-box paragraph both as part of an outer paragraph and again as its own section.
- Do not expand automatic fields, retrieve hyperlink destinations, infer page boundaries or copy the document's instructions into agent authority.

A naive `body.iter(paragraph)` followed by `paragraph.iter(text)` can duplicate nested text-box text. The extractor needs a defined traversal boundary, rather than a global descendant search that silently combines distinct stories.

## PPTX extraction semantics

PresentationML stores slides in separate parts. The presentation's slide-ID list determines the slide order, and each list entry identifies its slide through a relationship ID. Resolve that relationship to the corresponding internal slide part; lexical sorting of `slide1.xml`, `slide2.xml`, or ZIP entry order is not sufficient. [Microsoft: presentation structure](https://learn.microsoft.com/en-us/office/open-xml/presentation/structure-of-a-presentationml-document), [Microsoft: slide-ID and relationship-based text retrieval](https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-get-all-the-text-in-a-slide-in-a-presentation).

For this increment:

- Validate the internal root office-document relationship, presentation content type and presentation namespace.
- Read exactly one supported slide-ID list in document order. Require nonempty, unique relationship IDs and reject unresolved, ambiguous or repeated slide-part targets.
- Build a unique relationship map from the presentation's relationships part. For selected slides, require the expected slide relationship type and an internal, canonical supported target naming an actual ZIP part of the slide content type.
- Reject required targets with an external scheme/authority, `TargetMode="External"`, a query or fragment, backslashes, ambiguous percent encoding, traversal or an unsupported path. Never dereference them.
- Extract supported DrawingML paragraph text from the selected slide body in a defined XML order. Preserve run text and explicit line breaks; make no claim that XML shape order equals visual reading order.
- Notes, slide masters/layout text, hidden-slide interpretation, charts, SmartArt, media, animations and embedded documents are outside the initial text scope. Disclose detected omissions where feasible. Do not import unreferenced slide files just because they exist in the package.

A missing required slide or malformed relationship cannot produce a seemingly complete prefix of the deck. Return a concrete failure and retain no usable partial snapshot of that failed package.

## ZIP and XML refusal checks

Python exposes ZIP metadata and bounded stream reads, but package safety must be enforced by LearnBridge. ZIP archives can contain duplicate names, unsafe names and very large expanded content. [Python: ZIP APIs and decompression pitfalls](https://docs.python.org/3.12/library/zipfile.html).

Before reading any selected XML part, validate the entire member inventory:

- Bound original bytes, entry count, each declared expanded size, aggregate declared expanded size, compressed size and expansion ratio. Limit actual reads independently; metadata is not sufficient proof of bounded expansion.
- Inspect the original member name as well as its normalized name. Reject NUL/control characters, absolute or drive paths, backslashes, empty/dot/traversal path segments and duplicate names or aliases under the chosen conservative canonical-name policy. Python's `ZipInfo` can retain an original name while normalizing the public filename, so checking only `filename` is insufficient.
- Reject encrypted/strong-encryption flags, ZIP symlink/device entries, unsupported compression methods and malformed/overlapping entries reported by the ZIP library. Permit only the explicitly supported storage/deflate methods.
- Reject macro-enabled main content types and VBA project parts, including disguised `.docx`/`.pptx` packages. Never read or execute embedded binary payloads.
- Read selected XML through a capped stream and verify CRC/size errors. Never call `extract`, `extractall`, a path-based reader or an external archive executable.

Python's XML documentation warns that default XML processing is not a complete untrusted-input security boundary. Use explicit refusal rules and resource budgets instead of assuming an installed Expat version makes arbitrary XML safe. [Python: XML vulnerabilities](https://docs.python.org/3.12/library/xml.html).

- Support strict UTF-8 XML only initially, optionally with its UTF-8 BOM. Reject UTF-16/UTF-32, a conflicting encoding declaration, NULs and any decoding fallback. A raw byte substring check for DTDs can miss UTF-16 markup.
- Prohibit DTDs, entity declarations and external entities before text expansion. Use a robust decoded-input preflight under the strict encoding contract, or Expat declaration/entity callbacks that raise immediately; disable parameter-entity parsing. Built-in XML character references remain supported. [Python: Expat declaration/entity callbacks](https://docs.python.org/3.12/library/pyexpat.html).
- Bound XML depth, total nodes, attributes and produced text; reject a document exceeding any bound instead of persisting truncated evidence. No XInclude expansion, external schema resolution or external relationship loading is permitted.
- Resolve only trusted namespace-qualified element names. Markup-compatibility alternatives, unknown extensions and unsupported root namespaces need explicit omission/refusal semantics, not accidental descendant matching.

The fixed helper must impose process time and memory/resource limits appropriate to the supported platform. Parent cancellation must terminate and confirm process/group exit before reporting completion or releasing private temporary state. The acquisition worker and parser bounds are independent and cumulative.

The implemented initial constants are: original package 4,000,000 bytes; ZIP entry count 1,000; aggregate expanded package 8,000,000 bytes; each XML part 2,000,000 bytes; XML depth 64; 100,000 XML nodes per part; 1,000 extracted sections; extracted text up to 256,000 bytes at the pure-adapter ceiling, with a 48,000-byte default; provenance metadata 96,000 bytes; total result 128,000 bytes; fixed parser deadline 5 seconds. XML additionally limits attribute count and lengths. These declared/read/deadline bounds must be tested; they are not a proof of an operating-system memory sandbox. A separate compression-ratio limit and OS resource limit are review recommendations, not currently measured guarantees.

## Implementation sequence and release checklist

1. **Pure adapter and helper.** Add DOCX/PPTX inventory eligibility, fixed helper prerequisites, bounded byte transport, safe package parsing, exact section provenance and source revalidation. Keep the helper executable/options private to package code. Publish documented constants for original ZIP bytes, ZIP entries, expanded member/aggregate bytes, XML depth/nodes, sections, text/result bytes and wall-clock time.
2. **Pure hostile-fixture verification.** Run real selected-file acquisition against the synthetic matrix below. Assert exact extraction and a concrete refusal for every unsafe case. Prove cancellation, source changes and deadline cleanup against real child processes.
3. **Storage.** Add a migration without rewriting old migrations/checksums. Store provenance and immutable text atomically; validate hashes, ranges, ownership and source lineage on read and fresh-root restore. Failed or unavailable extraction must create no usable snapshot.
4. **Runtime and agent context.** Add authenticated selected imports/readbacks using existing pairing/consent rules. Inventory/list responses omit document bodies. Agent context exposes only separately selected, still-authorized snapshots, with section evidence and the partial-coverage instruction.
5. **Dashboard.** Display exact format and extraction limitations, import one explicit selection, review readback, share separately, and show actionable text-export guidance for unsupported cases. Verify stale or revoked sources and retry behavior.
6. **Release evidence.** Record the exact test commands/results and supported operating systems. Keep each unverified boundary visible. Update this document's status only after parser, storage, runtime/MCP and dashboard checks have measured proof.

## Synthetic verification matrix

Generate fixtures from the repository root:

```sh
.venv/bin/python -I -S -B web/scripts/fixtures/office-source-fixture.py /tmp/learnbridge-office-fixtures
```

The output directory must be absent or empty. The generator refuses overwrite and uses inert synthetic data only. Tests should use a fresh disposable directory rather than relying on the example path remaining empty.

| Fixture | Required objective result |
| --- | --- |
| `text.docx` | Exact two paragraphs: `Synthetic course note λ café résumé.` and `Read this evidence, then explain one idea.`; exact text/section hashes and UTF-8 ranges; available partial coverage. |
| `ordered.pptx` | First section is `Second file, first presentation slide λ.` from slide2; second is `First file, second presentation slide café.` from slide1. Neither ZIP order nor filename order decides positions. |
| `blank.docx`, `blank.pptx` | Text unavailable; no usable saved snapshot or fabricated content. |
| `unsafe.docx` | A `../escape.txt` member causes refusal; no extracted file and no body leakage. |
| `duplicate.docx` | Duplicate main-document entries cause refusal, never first/last entry wins. |
| `entity.docx` | DTD/internal entity rejected before expansion; payload marker absent from returned evidence and logs. |
| `utf16.docx` | Strict encoding refusal; no permissive alternate decode. |
| `macro.docx` | Macro-enabled content type and inert VBA marker rejected, despite `.docx` extension. |
| `bomb.docx` | More than 8 MB declared expanded XML with a tiny compressed archive is rejected by the aggregate expanded-size bound. No oversized XML tree is built. |
| `relationship.pptx` | Required external slide target rejected; no network request. |
| `missing-slide.pptx` | Missing referenced slide rejected; no misleading prefix import. |
| `revisions.docx` | Only `Visible base paragraph.` is eligible body evidence; tracked-change and text-box markers are omitted and never duplicated; limitations disclosed. |
| `markup.docx`, `markup.pptx` | Only `Visible legitimate base.` is text evidence; Choice, Fallback and foreign-wrapper canaries are omitted with disclosed partial coverage. Mutually exclusive markup branches are never concatenated. |
| `wrong-content-type.pptx`, `missing-content-type.pptx` | A selected slide with a conflicting or absent slide content-type override is refused despite a valid presentation main part and slide XML root. |
| `encrypted.docx` | Central and local encrypted flag bits are set; importer refuses. This tests encryption detection, not decryption of a genuine password-protected Office file. |
| `malformed.docx` | Non-ZIP bytes refused with a safe allowlisted result. |

Additional required parser regressions: a NUL member-name alias; duplicate case/percent aliases under the chosen policy; absolute/backslash/drive paths; symlink ZIP attributes; a central/local filename mismatch; wrong root MIME/namespace; duplicate relationship IDs; invalid slide relationship type; repeated slide target; unreferenced slide exclusion; strict UTF-8 DTD and UTF-16 entity variants; oversized XML depth/node/attribute/text budgets; tabs/newlines and multibyte text at the exact output bound; repeated generated-marker text inside a body; stale inventory, pre/post-parse file and folder swaps, cancellation and process cleanup.

Integration regressions must separately show: source revocation before persistence prevents a snapshot; a repeat import is immutable/idempotent; saved list responses reveal no body; paired readback preserves section evidence; actual MCP selected context includes only authorized snapshots; fresh-root backup restore validates lineage/hash/ranges; revoked/stale evidence is withheld; and the dashboard communicates partial text scope. No university account, personal document or live external action is needed for these proofs.

## Evidence recorded so far

Reproduce the implemented Office and adjacent runtime/storage checks from the repository root:

```sh
node --test web/scripts/source-office.test.mjs
node --test web/scripts/local-office-storage.test.mjs
node --test web/scripts/source-office-runtime.test.mjs web/scripts/source-pdf-runtime.test.mjs web/scripts/source-runtime.test.mjs
```

- The fixture generator was run with the existing isolated `.venv` Python against a new disposable directory. All 15 requested fixture filenames were created.
- Structural readback confirmed the exact Unicode DOCX paragraphs, PPTX slide-ID order and relationship targets, duplicate document entry, expanded-size bomb, UTF-16 BOM and both encrypted flag fields. The encrypted member requires a password under ordinary `ZipFile.read`.
- A second generator invocation against the populated directory failed without replacing its files.
- Independent review reproduced two format-attribution gaps on synthetic packages: both mutually exclusive markup-compatibility branches and foreign-wrapper text were returned together, and a selected slide with a conflicting content type was returned as available. Regression fixtures were added and the parser now omits unsupported subtrees and validates each selected slide content type.
- The generator now includes four additional regression files (`markup.docx`, `markup.pptx`, `wrong-content-type.pptx`, `missing-content-type.pptx`) for 19 total fixtures. A second disposable run confirmed all 19 files and parsed the additional XML/relationship metadata to verify their intended canaries and type conflicts.
- A separate direct invocation of the actual fixed helper with the 19 synthetic packages passed **19/19 expected statuses**. Exact Unicode paragraphs and slide order matched; both markup formats returned only the legitimate base with an omission reason; conflicting and missing slide content types were refused. Tracked-change and text-box content stayed omitted while blank paragraph positions were retained.
- An independent final run of `node --test web/scripts/source-office.test.mjs` passed **18/18 tests, with no skips**. The suite exercised actual anchored reads and fixed parser children, exact original/text/section provenance, metadata-only inventory, NUL/path aliases, DTD/encoding/macro/relationship refusals, budgets, table/Unicode/empty positions, pre-read link substitutions, post-parse file/root mutation, cancellation, deadline termination and confirmed process/group exit. A delayed-observation test proves a cleanup timer cannot substitute for an actual exit acknowledgement. Added ZIP consistency tests reject contradictory local CRC/size fields and a modified streaming descriptor, while accepting an actual ZIP created by a nonseekable writer.
- An independent run of `node --test web/scripts/source-inventory.test.mjs web/scripts/source-runtime.test.mjs` passed **31/31 existing regressions, with no skips**. Those regressions preserve existing acquisition and authorization barriers; they are not Office-specific runtime integration proof.
- The integration owner measured **13 passing runtime tests**: 5 Office-specific, 3 existing PDF-specific and 5 existing source-authorization tests. The Office flow exercised paired HTTP import, exact saved DOCX paragraphs and PPTX slide order, actual MCP selected-context readback, restart and fresh-root backup restore. Unavailable/malformed/encrypted/DTD documents saved no snapshot; capability denial did not fall through to a text reader; revocation and logout during extraction withheld the result.
- The integration owner measured **45 passing storage/runtime regressions** as a separate combined run. The Office storage coverage includes exact Unicode/section hash/range provenance, immutable retries and body-free metadata, source-grant enforcement/revocation, transactional and SIGKILL recovery, additive migration/checksum preservation and validated Office/PDF backup restore. This is a combined regression count, not 45 Office-only tests.
- The existing PDF acquisition/parser regression passed **12/12 tests** in a separate measured run. This checks adjacent PDF behavior remained working; it is not additional Office interoperability proof.
- The integration owner exercised the actual local dashboard with three synthetic files. Inventory remained metadata-only. Selected DOCX paragraphs preserved the exact Unicode text, PPTX sections followed slide2→slide1 presentation order, and the saved readback preserved partial coverage and the original source hash. The blank DOCX returned unavailable and did not create a third snapshot.
- Desktop and 390-pixel mobile checks found **0 console errors**. Mobile client width and scroll width were both 390 pixels, with no horizontal overflow. Local screenshots: `artifacts/local-office-import-desktop.jpg` and `artifacts/local-office-import-mobile.jpg`.
- These distinct measurements establish the **local synthetic Office import → saved readback → reviewed MCP context/dashboard slice** on the current macOS host. They do not establish genuine Word/PowerPoint/LibreOffice document interoperability, Linux runtime behavior, visual layout fidelity or a Codex/Claude model turn using those snapshots. The MCP proof is an actual selected-context tool call, not a model inference result.

### Review findings resolved

Independent hostile-input review found that a normal synthetic DOCX with a contradictory local ZIP-header CRC, compressed size or uncompressed size had been returned as available. Python's ZIP reader uses central CRC/size values, so local-field disagreements were not rejected automatically.

This is fixed: the parser validates local/central names, flags, method and extract version; it requires matching local CRC/compressed/uncompressed values for entries without the data-descriptor flag, refuses ZIP64 sentinels, and validates final descriptor CRC/sizes for streaming entries. Real synthetic regressions cover all three contradictory local fields and positive/negative streaming descriptors. The earlier markup-compatibility/foreign-wrapper and selected-slide content-type findings are also fixed and covered. Independent review found no further material issue in the inspected package boundaries. These checks still do not constitute complete ZIP or OOXML standards validation.
