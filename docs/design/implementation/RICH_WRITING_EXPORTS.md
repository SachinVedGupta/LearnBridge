# Reviewed rich writing exports

## What is implemented

The local Writing screen offers two additional downloads for a current, human-reviewed **accepted alternative** or **applied revision**:

- **Formatted Word (.docx):** a deterministic, inert Office Open XML file with paragraph/heading styles, real Word bullet and numbered lists, and simple bold/italic runs.
- **Printable LaTeX source (.tex):** a standalone article with the same bounded formatting, escaped literal source characters, and source provenance in a comment. It is source for separate compilation, not a generated PDF.

These use the existing writing review gate. They do not create or accept a proposal, modify its source, grant sharing, contact a model, read new folders or start an external converter. The existing exact Markdown and literal Word exports remain available.

## Exact content and supported formatting

The formatter receives the **saved accepted copy**, including its existing LearnBridge provenance appendix, or the exact current applied document revision. It never substitutes the proposal payload for the saved copy.

Only this intentionally small Markdown subset is interpreted:

| Input | Output |
| --- | --- |
| `# Heading`, `## Heading`, `### Heading` | Heading levels 1–3 |
| `- Item`, `+ Item`, `* Item` at column zero | A flat bullet list item |
| `1. Item` or `1) Item`, numbers 1–9999 at column zero | A flat numbered item retaining its explicit source number |
| Balanced `**bold**` or `__bold__` | A bold run |
| Balanced `*italic*` or `_italic_` | An italic run |
| A physical line | One paragraph, including blank and final lines |

Emphasis is non-nested, cannot contain backslashes or additional emphasis markers, and underscore emphasis cannot begin or end within a word. Unsupported syntax remains literal: links, images, HTML, tables, deeper headings, indented nested lists, unmatched markers and fenced-code blocks. No hyperlink or image relationship is generated. The parser does not promise full CommonMark compatibility.

CRLF/CR becomes LF. Supported formatting removes its syntax markers; bullet markers become bullets and numbered markers become decimal markers. The original source hash pins the reviewed saved original, while a distinct rendered-text hash describes the transformed plain text. This is an explicit transformation, not a claim that formatted output retains every literal Markdown byte.

## Review and authority contract

The paired local browser sends exactly `{ expected_revision, payload_hash }` to either:

```text
POST /api/local/v1/writing/items/:id/export-formatted-docx
POST /api/local/v1/writing/items/:id/export-tex
```

The normal runtime enforces its existing cookie, nonce, same-origin and strict JSON boundaries. The rich adapter accepts only a paired session and POST, then calls the unchanged `createWritingService().exportWordArtifact()` reviewed export gate. That gate verifies the exact current writing-record revision/payload hash, accepted/applied state, saved accepted/applied copy and selected source pins. Edited or deleted sources/copies, stale reviews, pending/rejected/forgotten proposals and another workspace's IDs fail without preparing a file. Original academic restrictions and model-output fact-review labels remain intact; formatting cannot authorize a completed graded revision.

The formatter separately reuses `createWordTextArtifact()`'s strict text, Unicode, provenance and byte validation. It emits no saved workspace files. The response contains the file bytes/text, MIME, safe bounded filename, byte count, artifact SHA-256, reviewed document pin, source references and immutable rendering manifest.

Before a download link is created, the browser verifies the file's byte count/SHA-256, format, MIME, filename and source/record/review pins against the exact item currently displayed. A changed item, source refresh or session reset cancels an in-flight result. A duplicate click cannot duplicate the same in-flight export. Created Blob URLs expire after 30 seconds or immediately when their controller is reset; their download copies remain until the student removes them separately.

## Container and LaTeX boundaries

Word uses seven fixed ZIP entries: content types, package relationships, document, styles, numbering, document relationships and custom properties. Entries are stored uncompressed with CRC32 and fixed metadata. There are no external relationships, macros, embedded objects, field instructions, HTML chunks, filesystem paths or fetched resources. Discontinuous numbered items begin a new numbering instance so that `3`, `4`, `9` do not silently become `1`, `2`, `3`.

LaTeX commands and the article preamble are fixed generator strings. User backslashes, braces, `%`, `$`, `&`, `#`, `_`, `~`, `^` and tabs are escaped or rendered using fixed literal macros. Source such as `\input{...}`, `\write18{...}` or `\end{document}` is printed as literal text rather than executed. There is no renderer invocation or shell-escape request in the application. The manifest correctly records `compiler: not_run` and `visual_review: pending` for every normal source download. Unicode font support and actual compilation remain the receiving editor's responsibility.

Limits: 80,000 UTF-8 input bytes, 1,000 physical paragraphs, ten source-document pins, 4,000 formatted runs, 100 emphasis pairs per line and 512,000 output bytes. The original literal-container budget is also checked before formatting.

## Verification completed

Run:

```sh
cd web
node --test scripts/local-rich-writing-artifact.test.mjs scripts/local-rich-writing-routes.test.mjs scripts/local-rich-writing-http.test.mjs
```

The **27 cases** verify:

- An independent Python `zipfile`/`ElementTree` reader reopens the real Word bytes, checks every ZIP entry and CRC, parses styles/runs/numbering, compares explicitly authored expected paragraphs and source/rendered hashes, and rejects corrupted/trailing data. Its expected formatted content is independently specified; it does not reuse the generator's Markdown parser.
- macOS `textutil` independently reopens the real formatted Word file and extracts its displayed heading/body without supported Markdown markers.
- The real writing gate/storage rejects unauthorized, unreviewed, stale and cross-workspace items, retains graded scaffolding policy, and preserves deterministic bytes through restart and a fresh verified backup restore.
- Actual HTTP/runtime/SQLite checks cover both routes, paired cookie/nonce/Origin, strict bodies/methods, stale sources, applied revisions, graded scaffolding, session invalidation and zero workspace mutations.
- The **actual shipped `mountWritingUI` controller** invokes both real HTTP routes, verifies real artifact bytes and prepares matching Blobs/links. DOM, cleanup clock and download-click observation are synthetic; these tests explicitly do not claim a browser saved a file or reviewed its visual layout.
- The built-in desktop LaTeX compiler successfully compiled one isolated synthetic generated `.tex` with heading/emphasis, café Unicode, lists, `%`, `&` and an escaped literal `\input` command. This single fixture proves that source, not every possible document or font. It does not turn source export into a PDF feature.

## Live verification still required

1. In a disposable student-owned local workspace, create a small report containing the supported headings/emphasis/lists and one literal unsupported link/command.
2. Review and accept its exact current draft. Download both new formats through the actual browser.
3. Observe a saved file for each, independently reopen it, compare the saved byte counts/SHA-256 to their HTTP receipts, and inspect the Word layout in a document application.
4. Open/compile the saved `.tex` in the built-in editor or a compatible local TeX editor, then inspect its pages. Record compilation and visual review separately from artifact-generation proof.
5. Edit a selected source and confirm that both exports fail; refresh and confirm the current controls disappear. Record that documents, tasks, grants and unrelated sources were preserved.

PDF generation, arbitrary Markdown, reference/citation layout, tables, images, equation parsing, collaborative editing, direct cloud document writes and multi-page visual conformance remain separate features. No production dependencies or authentication/configuration changes are introduced by this slice.
