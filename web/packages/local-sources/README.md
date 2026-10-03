# Selected local text, PDF and Office sources

This package acquires **explicitly selected local `.txt`, `.md`, `.pdf`, `.docx` and `.pptx` files** for the local LearnBridge edition. It performs bounded metadata inventory first, then reads an individually selected file from that inventory. PDF extraction is a separate macOS capability, using installed native PDFKit through the fixed Swift helper. Office extraction uses the existing isolated Python standard library without Microsoft Office or another dependency. It does not scan the home directory, infer a profile, create consent, call a model, execute discovered instructions or connect to a provider.

The paired runtime must obtain human metadata/content permission, load its trusted stored descriptor/inventory and check permission again after the asynchronous operation. A descriptor or inventory hash is a version check, **not an authentication or consent token**. Do not expose these functions as arbitrary-path tools to a cloud agent. Paths, filenames and file contents are private data and need separate destination-specific permission before remote serialization.

## Native acquisition prerequisite

The fixed worker executable is the repository's existing `.venv/bin/python3`. No Python dependency is installed or changed by this package. It uses only the standard library and runs with `-I -S -B -X utf8`: isolated imports, no site packages and no bytecode writes. The child receives only `TZ=UTC`, bounded JSON and fixed reviewed worker code. It receives no inherited provider keys, agent credentials, Python path or shell command.

`probeSourceCapability()` returns `available` only when this runtime has directory-relative `os.open`/`os.stat`, descriptor-based `os.scandir`, `O_DIRECTORY` and `O_NOFOLLOW`. Missing runtime/flags/platform returns `unsupported`. **There is no weaker Node path-based fallback.** A clean checkout that lacks `.venv` can still use manual tasks/notes; the source adapter remains unavailable until its documented local runtime prerequisite is satisfied.

`probePdfCapability()` is a cheap startup prerequisite check: it checks macOS, executable access to fixed `/usr/bin/swift` and read access to the bundled regular `pdf-text.swift`. It launches no child and returns `available` with `verification:'prerequisites_only'`; this does not prove that an SDK/framework can compile. An explicit `probePdfCapability({verify:true,signal})` compiles and runs a bounded no-document probe, returning `verification:'native_probe_passed'` on success. Every actual import still runs the native helper and can refuse an unavailable SDK/runtime. No dependency, toolchain or OCR package is installed. Missing prerequisite/native framework or a different platform returns `unsupported`. PDF readiness does not replace the required anchored Python acquisition worker.

`probeOfficeCapability()` also launches zero children. On macOS/Linux it checks executable access to the fixed project Python and read access to the regular bundled `office-text.py`, then returns `verification:'prerequisites_only'`. It does not establish successful extraction or replace the anchored acquisition check. Missing prerequisites or another platform return `unsupported`. Actual imports run the fixed parser and validate its version and record boundaries.

Initial live fixture environment: macOS arm64, Node v22.23.2, existing isolated Python 3.12.14. Linux has the same native capability probe but has not been verified here. Windows is unsupported by this adapter. These are acquisition guarantees for this worker; they do not confine other filesystem tools available to a host agent.

## API

All functions are asynchronous. Returned data is deeply frozen.

```js
const descriptor = await describeRoot(selectedAbsoluteFolder, { label: 'School notes' });
const inventory = await inventorySource(descriptor, {
  maxEntries: 500, maxFiles: 100, maxDepth: 8, signal,
});
const content = await readSelectedEntry(descriptor, inventory, selectedEntryId, {
  maxBytes: 256000, signal,
});
// content = {text, sha256, version, title}

// Inventory entries have kind text, markdown, pdf, docx or pptx. Dispatch explicitly:
const pdfContent = await readSelectedPdf(descriptor, inventory, selectedPdfId, {
  maxBytes: 48000, signal, // extracted text, not the original PDF byte limit
});
// pdfContent = {text, sha256, version, title, pdf}

const officeContent = await readSelectedOffice(descriptor, inventory, selectedOfficeId, {
  maxBytes: 48000, signal,
});
// officeContent = {text, sha256, version, title, office}
```

`describeRoot` refuses traversal, linked roots, the whole home directory, broad/system roots and known private credential/agent/dependency directories. It canonicalizes the selected root, then opens every canonical component relative to a directory descriptor with no-follow rules. The root device/inode must match the selected identity.

`inventorySource` reads names/types/sizes/timestamps only. Every eligible file has an opaque UUID, relative path, a file snapshot and a complete root-to-parent directory identity chain. UUIDs remain stable for an unchanged path/device/inode under the same root identity; inventory IDs are new UUIDs and metadata versions are deterministic. Inventory does not read file bodies. It never descends into secret/agent/auth/dependency/cache folders or follows symbolic links; hard links and special files are excluded. Unknown types are counted without publishing their filenames.

Budgets are hard maxima, with default/hard ceilings of 500 visited entries, 100 eligible files, depth 8 and 256,000 bytes per selected text read. Anchored worker operations have a five-second deadline. File/entry/depth limits, permission failures, cancellation and changed sources remain explicit coverage outcomes. Hitting a limit conservatively reports `partial`, even when that limit happens to coincide with the last entry. Cancellation retains observed metadata accounting but returns no usable content. Inventory is not a grant to newly created files. PDF/DOCX/PPTX files above 4,000,000 bytes are excluded before any body read.

`readSelectedEntry` validates the complete stored inventory, selected entry and bounded byte request. It opens each parent relative to its pinned directory descriptor with `O_NOFOLLOW`; it then opens the final regular file without following links and with non-blocking protection against a substituted FIFO. Before any body read it compares the opened file's device/inode, size, nanosecond mtime/ctime and link count to the approved snapshot. It reopens/checks the current root/parent chain and current leaf entry before extraction. Extraction reads the **same opened file descriptor**, then checks the version/chain again before returning exact UTF-8 text and its SHA-256 hash.

Renaming a root/parent, substituting a symlink/leaf, adding a hard link or changing the file version causes refusal. Concurrent in-place writes are checked between chunks and after reading; an unstable buffer is quarantined rather than returned. This does not promise that an OS makes ordinary mutable-file content reads atomic: bytes from an authorized object may already have been read before an in-place change is detected. The proved path boundary is that substitution cannot make the worker read a different unapproved inode's body.

## PDF text and page evidence

`readSelectedEntry` explicitly refuses a PDF; it cannot accidentally import ASCII PDF syntax as a text note. `readSelectedPdf` acquires the original bytes from the same approved, opened worker file descriptor with the existing pre-read/chunk/post-read checks. A bounded private pipe returns those bytes to the fixed native parser. It accepts no selected file path, password, executable, PDF script, URL or shell command. The helper constructs `PDFDocument(data:)` and reads page strings; it does not activate links, attachments, PDF JavaScript or a viewer.

The parser uses a private temporary home and module cache and inherits no API keys, Python options, agent configuration or shell startup settings. Original PDF bytes travel through stdin only; argv contains the fixed helper/cache paths. Native stderr is discarded and bounded, including malformed-file diagnostics. Temporary code caches are removed after confirmed child exit and process-group cleanup. PDF bytes are not written to parser temporary files. Cancellation/time/output failure terminates the native process group, escalates to a kill and withholds any partial or late text. Cleanup timers repeat the kill request; they never substitute for the operating system's exit acknowledgement. Pipe cleanup waits for that acknowledgement too, so an exceptional kernel-delayed exit can delay shutdown rather than release a late result or remove a cache that a process still uses.

After native parsing, the adapter revalidates the original approved root/parent chain and leaf snapshot before returning **any** text or unavailable result. A source changed during parsing requires a fresh inventory. Runtime permission/session/revocation must still be rechecked by the caller after this asynchronous operation.

The original-byte ceiling is 4,000,000 bytes; the page ceiling is 200. Extracted text defaults to 48,000 UTF-8 bytes and cannot exceed 256,000. PDF metadata cannot exceed 96,000 bytes and the combined returned record cannot exceed 128,000; duplicated per-page text means that this record budget can be reached before the text ceiling. The native process has a 30-second deadline, in addition to the two bounded acquisition/version-check worker operations. Exceeding a limit returns `BUDGET_EXCEEDED` with no usable partial text. These byte/page/time limits do not promise a fixed peak-memory bound inside the operating system's native PDF parser.

The returned `sha256` hashes the exact extracted joined text. `version` remains the approved file **metadata snapshot hash**. `pdf.source_sha256` separately hashes the **original PDF bytes**. They are different identities and must not be substituted for each other. `pdf.parser_version` is the fixed reviewed adapter version `macos_pdfkit.v1`; extraction behavior also follows the installed OS framework, so byte-exact source and text hashes remain authoritative.

Available text joins all physical pages in order as `[PDF page N]\n<page text>`, separated by two newlines. Every page has `{physical_page, printed_label:null|string, text, sha256, byte_range:{start,end}}`; byte ranges point to the exact page text in the joined UTF-8 buffer, excluding the generated header. Physical pages are one-based. Printed labels come only from PDFKit, must fit both 128 UTF-16 characters and 128 UTF-8 bytes, and may be unknown; they are not substituted for physical page numbers. Oversized labels are omitted as `null`. Blank pages have an empty range and their empty-text hash.

`pdf` contains `schema_version:1`, `format:'pdf_text'`, `parser_version`, `source_sha256`, `source_bytes`, `page_count`, `pages`, `extraction_status` and `coverage`. All returned data is deeply frozen. Results distinguish:

- `available`, with complete coverage when every page has extractable text, or partial coverage and `pages_without_extractable_text` when some do not.
- `text_unavailable`, with `no_extractable_text`; image-only, blank and other pages without text cannot be distinguished reliably. No OCR or inferred page content is supplied.
- `encrypted`, with `encrypted_document`; no password is requested or accepted.
- `malformed`, with `malformed_document`; native diagnostics are never exposed.

Unavailable documents return empty text and its SHA-256, no usable page excerpts, and `coverage.state:'unavailable'`. The paired runtime should show that result and avoid saving it as an available imported source. Merely naming an inventory entry `pdf` is not an extraction or sharing permission.

## Office text and section evidence

`readSelectedEntry` refuses DOCX/PPTX rather than importing ZIP syntax as text. `readSelectedOffice` uses the same anchored original-file acquisition and post-parse root/parent/leaf revalidation as PDF. The fixed `office-text.py` receives only a bounded JSON header and original bytes through stdin. The interpreter runs with isolated imports, no site packages and no bytecode writes; it inherits only `TZ=UTC`. File paths, passwords, shell commands, relationship URLs and alternate executables are not parser inputs. It does not extract archive members to disk, open relationships, invoke Office, run macros or render a document.

Limits are 4,000,000 original bytes, 1,000 ZIP entries and 8,000,000 declared/actual total uncompressed bytes. Every archive member is checked before parsing for canonical safe names, NUL aliases, case-insensitive duplicates, encryption flags, regular entry types, matching local/central names, CRC/size metadata and supported stored/deflate compression. Ordinary ZIP headers must match central CRC/sizes; streaming ZIP descriptors are supported only when their trailing CRC/sizes match. ZIP64 sentinel metadata is unsupported in this bounded slice. Expanded member reads are bounded and CRC checked. XML parts are limited to 2,000,000 bytes each and 8,000,000 aggregate bytes through the archive limit; each tree permits at most 100,000 nodes and depth 64. XML is strict UTF-8, with a matching declaration when supplied. DTDs, declared entities, other encodings and malformed XML are refused. No XML resolver or network fetch is used.

The main relationship and content type must match the selected DOCX/PPTX type. Slide order comes from `ppt/presentation.xml` and its unique internal slide relationships, with each selected slide's content type checked; it never comes from sorting `slideN.xml`. Internal targets must remain within the archive. External hyperlinks are not followed and add `external_relationships_not_followed`; other external relationships are unsupported. Macro content types and embedded code parts are unsupported. These conservative boundaries can refuse some valid Office documents; there is no permissive fallback.

DOCX extracts supported main-body paragraphs in XML order, including table cells and supported content controls. Tabs and line breaks are retained. It excludes tracked revisions, nested text boxes and unfamiliar or mutually exclusive markup branches rather than choosing/inventing their rendered appearance. PPTX extracts supported slide text and table paragraphs in XML order. Neither path claims visual reading order, pagination, formula evaluation, image text or Office rendering. Observable images, notes, comments, headers/footers, charts, revisions or unsupported markup add specific omission reasons. Available Office coverage is **always `partial`**, with mandatory `layout_not_preserved`.

The maximum section count is 1,000; extracted text defaults to 48,000 UTF-8 bytes and has a 256,000 hard ceiling. Metadata is bounded to 96,000 bytes and the combined result to 128,000, so repeated section text/metadata may hit the record limit earlier. The parser deadline is five seconds, in addition to bounded acquisition and revalidation workers. Any byte/tree/section/time limit returns `BUDGET_EXCEEDED` without truncated usable text. Cancellation/output failure kills the owned child process group, waits for actual exit acknowledgement and withholds every late result. Cleanup deadlines request termination; they never stand in for observed exit.

Available joined text is `[DOCX paragraph N]\n<text>` or `[PPTX slide N]\n<text>`, separated by two newlines. One-based section positions include blank sections; `byte_range:{start,end}` points only to that section's exact text in the joined UTF-8 buffer. The returned `sha256` hashes joined text; `version` is the approved metadata snapshot; `office.source_sha256` hashes original ZIP bytes separately. Each section also hashes its own text. These identities are not interchangeable.

The deeply frozen `office` record is `{schema_version:1,format:'office_text',parser_version:'stdlib_ooxml.v1',document_type:'docx'|'pptx',source_sha256,source_bytes,section_count,sections,extraction_status,coverage}`. Each section is `{position,unit:'paragraph'|'slide',text,sha256,byte_range}`. Reasons are a bounded extensible contract: at most 20 unique lowercase/underscore identifiers, each at most 80 characters. The fixed versioned parser supplies them; source text is never treated as an instruction or reason identifier.

Unavailable states are `text_unavailable`, `encrypted`, `malformed` or `unsupported`. They return empty text/hash, no sections/excerpts and `coverage.state:'unavailable'`. Textless documents retain observable omission reasons, such as `images_omitted` or `revisions_omitted`, alongside `no_extractable_text`. An OLE container is labelled `encrypted_or_legacy_container` because this slice does not distinguish encrypted OOXML from a misnamed legacy binary document. The runtime must not save unavailable records as usable sources. This slice supports transitional OOXML namespaces only; strict/other document formats require a separate parser capability. Runtime destination consent, persistence and removal remain caller-owned checks.

## Stored shape

- Descriptor: `schema_version`, `kind`, `root`, `label`, `identity` (`dev`, `ino` decimal strings), `version`.
- Inventory: `schema_version`, `id`, `source_version`, `version`, `entries`, `counts`, `coverage`, `exclusions`, `budget`, `retrieved_at`.
- Entry: `id`, `relativePath`, `kind` (`text`/`markdown`/`pdf`/`docx`/`pptx`), `title`, `snapshot`, `directories`.
- Snapshot: decimal-string `dev`, `ino`, `mtimeNs`, `ctimeNs`; numeric `size`, `nlink=1`; metadata `version` hash.
- Directory: `relativePath` and `identity` with decimal-string `dev`, `ino`, `mtimeNs`, `ctimeNs`. The ordered chain begins at `relativePath=""` and includes every parent prefix.
- Counts: numeric `entriesVisited`, `directoriesVisited`, `eligibleFiles`, `excludedEntries`, `totalBytes`.
- Exclusions: counters `secret`, `symlink`, `special`, `unsupportedType`, `hardlink`, `depth`, `permission`, `changed`.
- Coverage: state `complete`/`partial`/`cancelled`/`blocked` and reasons `entry_limit`, `file_limit`, `depth_limit`, `permission_denied`, `source_changed`, `cancelled`, `time_limit`.

Known secret filenames are excluded before inspection. Arbitrary allowed text can still contain sensitive information; filename rules are not a guarantee that notes contain no credentials. This package grants no cloud processing or external write access.

## Verify

From the repository root:

```sh
node --test web/scripts/source-inventory.test.mjs
node --test web/scripts/source-pdf.test.mjs
node --test web/scripts/source-office.test.mjs
```

The verified run passed **26 real native acquisition cases**, with no skips. Tests use only marked disposable synthetic roots. Native checkpoint barriers deliberately replace the actual root, parent or leaf between check/open/read phases. The worker reports actual source-body read device/inode/byte observations to the test-only constructor, and adversarial cases assert zero outside-body reads. Tests also prove metadata-only inventory, deterministic versions, secret exclusions, strict input validation, hard-link/version refusal, budget coverage, cancellation, FIFO refusal, exact Unicode across pipe chunks and quarantine of an in-place write.

`createSourceAdapterForTests({onPhase,onBodyRead})` is an explicit test constructor. Production method options reject callbacks; a request cannot change the worker executable or replace native filesystem functions. The observer operates on synthetic native phase receipts and does not substitute a mocked reader.

The PDF suite generates disposable text, mixed/image-only, encrypted and 201-page PDFs through installed CoreGraphics/PDFKit, plus minimal synthetic labelled PDFs. It performs actual native extraction and proves Unicode byte ranges, original/page/text hashes, metadata-only inventory, no-follow substitution refusal, changed-source quarantine, explicit unavailable outcomes, budgets, cancellation, label bounds and termination of stopped real native processes. A real-child regression holds the observed exit/close events beyond the old cleanup fallback deadline and verifies that the promise and private cache remain until those events are delivered. A separate startup check instruments child creation and proves zero launches. macOS native cases are explicitly platform-gated on other systems; the unsupported-platform contract has its own executed assertion. The trusted test constructor additionally accepts `pdfTimeoutMs` only to reduce the fixed native deadline, and emits `before_pdf_parse`, `pdf_process_started` and `after_pdf_parse` phase receipts without document text or bytes. These knobs are rejected by production read options.

The Office suite passed **18 actual anchored/native cases, with no skips**, using 19 named synthetic ZIP/XML fixtures plus additional adversarial archives. It proves deterministic DOCX paragraph/PPTX presentation order, exact Unicode hashes/ranges, explicit omissions, empty/encrypted/unsupported states, macro/DTD/encoding/path/NUL/duplicate/relationship/content-type refusal, ordinary/streaming ZIP metadata consistency, every byte/tree/section/result budget, zero outside-body reads, changed-source quarantine and cancellation. Stopped real Python children are terminated before settlement; a delayed-exit regression proves the cleanup fallback does not release a late result. Startup instrumentation proves zero child launches. The test-only constructor permits a reduced `officeTimeoutMs` and emits text-free `before_office_parse`, `office_process_started`, `after_office_parse` receipts; production read options reject those knobs. Existing text acquisition/runtime regressions also passed 31/31. Linux capability is implemented but these live proofs ran on macOS; no personal Office documents were accessed.

Runtime consent/revocation, private storage lineage/purge, paired HTTP policy and cloud-host output filtering require their independent suites. This adapter pass does not establish full onboarding or a supported real MCP host workflow.
