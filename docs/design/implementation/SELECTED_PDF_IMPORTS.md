# Selected PDF handouts

Students can import one reviewed PDF from a narrowly selected local folder, inspect its extracted text, and separately share that immutable snapshot with their Codex or Claude host. This extends the existing text/Markdown onboarding flow. It does not read files automatically or enable broader agent access.

The Sources screen lists metadata first. An explicit import reads the approved original file through the no-follow Python worker, passes its bytes through a private pipe to fixed native macOS PDFKit, then checks the source and browser authorization again. The extractor receives no student file path, password, provider keys or configurable executable. Original bytes are not stored in the workspace. The startup capability check launches no child; actual extraction verifies the native runtime. Linux PDF extraction and OCR remain unavailable.

Each available snapshot pins the original PDF SHA-256, extracted text SHA-256 and file metadata version separately. Physical pages start at one; printed labels remain separate and can be unknown. Exact page-body UTF-8 ranges and hashes exclude generated headers. The saved text contains `[PDF page N]` markers. Agent context carries the same page evidence and instructs the host to cite physical pages and acknowledge partial coverage. This is evidence extraction, not a generated tutor answer.

The original PDF is limited to 4,000,000 bytes and 200 pages. The dashboard saves at most 48,000 extracted text bytes. Metadata and total-result bounds can reject a document earlier; native parsing has a 30-second deadline. Oversized, changed, cancelled or unavailable results cannot become usable imports. A text/image mixture is explicitly partial. Scans, encrypted files and malformed documents save no snapshot and show a concrete text-export next step. No page contents are inferred.

Schema v4 stores text and immutable provenance atomically. Existing v1–v3 migrations/checksums remain unchanged. Backup and fresh-root restore validate lineage, ownership, page ranges/hashes and coverage; source revocation withholds future saved reads and agent context. Copies already exported or shared cannot be recalled. The source list omits text and PDF page bodies.

Verify from the repository root:

```sh
node --test web/scripts/source-pdf.test.mjs
node --test web/scripts/local-pdf-storage.test.mjs
node --test web/scripts/source-pdf-runtime.test.mjs
```

The native suite creates actual synthetic PDFs with CoreGraphics/PDFKit. It exercises Unicode, printed labels, image-only/mixed/encrypted/malformed documents, limits, cancellation, source swaps and confirmed child cleanup. Storage tests check exact page-body offsets even when header text repeats, immutable retries, historical migration checksums, crash rollback and backup recovery. Runtime tests execute paired HTTP import/readback, the actual MCP SDK's selected-context call and fresh-root restoration, and reject a result after folder revocation. These tests use disposable synthetic documents; no personal PDF or university account was accessed. Platform-specific native tests are explicitly skipped outside macOS rather than treated as a portable pass.
