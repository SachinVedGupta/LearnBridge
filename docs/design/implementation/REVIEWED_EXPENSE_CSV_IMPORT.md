# Reviewed local expense CSV import

## Implemented student workflow

The local **Expense CSV import** screen turns a single student-selected UTF-8 CSV into a saved review preview, then imports only the exact valid rows the student confirms into the existing Life expenses. Refunds remain negative and currencies remain separate. Opening the screen reads saved workspace metadata; it does not search the laptop, access a bank, read selected files automatically or share transactions with a model.

1. Export or prepare a small CSV with the documented columns below. Bank-specific layouts are not guessed. The student can transform their export into this schema before selecting it.
2. Enter a stable simple source label, such as `student-expenses`, and select one local CSV. A source label is a student statement, not proof of a bank account or financial institution.
3. Click **Preview this selected CSV**. The browser reads that explicit File as bytes, decodes with a fatal UTF-8 decoder and hashes the original bytes. Invalid encoding, an oversized file or a file/label changed during reading sends no preview. The runtime verifies the same original byte hash before persistence.
4. Inspect the dates, descriptions, signed amounts, currencies, categories, source line ranges, invalid reasons and duplicate status. The original CSV and parsed evidence are available in an inspector. No expense is confirmed by previewing.
5. For each intended row, explicitly check **I reviewed this exact row amount/currency/category and want it confirmed**. Every checkbox starts unchecked. Select 1–50 valid rows, then click **Confirm and import only my selected rows atomically**. No inferred selection or bulk default approval is used.
6. The runtime rechecks the displayed preview revision/hash, every selected row hash and current imported source identities. It publishes all selected confirmed expenses and their durable review receipt in one SQLite transaction, or publishes none. Remaining rows need a separate explicit review; a 100-row file can use two 50-row batches.
7. Inspect the receipt and confirmed per-currency totals in this screen or the existing Life screen. Exact retries after a lost response return the original receipt without adding transactions. **Forget this saved CSV preview** removes its current preview while leaving imported expenses intact; historical local revisions and backups have separate retention.

The imported expense date/description/category are validated through the existing Life domain. Description and category whitespace is trimmed in the normalized expense, and that exact normalized value is displayed before confirmation. Original cell text and file bytes are retained separately. Imported expenses keep the existing `student_entered` source label and add a distinct `student_reviewed_local_csv` source receipt; the feature does not claim authenticated bank data.

## Documented CSV schema and precise values

The first row is exactly:

```csv
date,description,amount,currency,category,reference
2026-10-04,"Lunch, café",12.50,CAD,food,receipt-001
2026-10-04,Book refund,-5.00,CAD,school,refund-001
2026-10-05,Textbook,10.01,USD,school,receipt-002
```

`reference` may be omitted only by omitting that entire last header/column. Header spelling, case and order must match; aliases, extra headers and varying row column counts are not accepted as transactions. A leading UTF-8 BOM is allowed and retained in the original file hash.

| Field | Accepted value |
| --- | --- |
| `date` | Exact valid calendar date `YYYY-MM-DD`; impossible dates are invalid |
| `description` | Nonempty literal description, at most 300 characters; displayed normalized value is trimmed |
| `amount` | Plain signed decimal with 1–7 whole digits and optional 1–2 fraction digits; `12`, `12.5`, `12.50`, `-2.25` accepted; no rounding, exponent, leading plus or locale separators |
| `currency` | Exactly three uppercase letters; this does not validate an ISO currency registry or select exchange rates |
| `category` | Nonempty student-defined category, at most 100 characters; normalized value is trimmed |
| `reference` | Optional exact source reference, up to 160 UTF-8 bytes; not normalized for identity |

Amounts are converted directly to integer cents; `12.50 → 1250`, `-2.25 → -225` and `10.01 → 1001`. Magnitudes above 999,999,999 cents are rejected. All values use this explicit two-decimal convention; currencies with other minor-unit conventions need a future deliberate schema. Known confirmed totals and category totals use the existing Life calculation. No exchange-rate conversion, estimated amounts or claims about coverage of missing periods are added.

Quoted commas, embedded newlines and doubled quotes are supported. Original CRLF, LF, Unicode and BOM bytes remain pinned. Formula strings, HTML, URLs and paths are rendered as inert text and are never evaluated, fetched or opened.

Rows expose explicit reasons such as `unexpected_quote`, `text_after_closing_quote`, `unclosed_quoted_field`, `wrong_column_count`, `invalid_calendar_date`, `invalid_decimal_amount_no_rounding`, `invalid_currency_code` and `invalid_description_category_or_reference`. An unfinished quoted field consumes its ambiguous remainder as one invalid row; the parser does not invent recovered transactions from later physical lines. A bad header or global size/row budget fails the whole preview. Invalid rows create no expense and cannot be selected.

## Identity, duplicates and atomic review

With a nonempty reference, source identity is a canonical SHA-256 of the exact student origin label, the reference identity tag and reference. Repeated references within one file are visibly rejected after the first occurrence. A reference already imported in that origin remains a duplicate even if a later file changes its date, amount, description or filename; importing is not an automatic correction of an existing expense. A different origin is intentionally a different identity.

Without a reference, identity uses the exact origin label, original file SHA-256 and logical row ordinal. An exact reimport is deduplicated regardless of filename. Two identical purchases on separate source rows remain distinct transactions. **Changed files without references can repeat old purchases**, because the changed file hash creates new identities; the UI and saved preview explicitly require the student to review those duplicates themselves. There is no implied cross-file purchase matching.

The preview is an additive `administration_item` tagged `category: expense_import_preview`, `format: expense_import_preview_v1`. It stores original CSV/bytes/hash, schema, parsed rows/physical line ranges, exact normalized candidates, row hashes, a canonical preview hash, limitations and creation operation identity. The current view computes imported/selectable status against both its review journal and the current Life records.

Commit input binds `{ expected_revision, preview_hash, selected_rows: [{ row_number, row_hash }] }` and an explicit `Idempotency-Key`. Unknown, repeated, invalid, already imported, changed or stale rows reject the entire selected batch. Reuse of a commit key with different body/reviewer is rejected. A matching committed retry returns its journal receipt even after the first response was lost; it never creates another expense.

The dedicated trusted `LocalStore.commitExpenseImportBatch({ creates, preview_update })` publishes at most 50 tagged `expense` records and exactly one CAS update to the tagged preview. It uses the existing private SQLite transaction/readback, validates every ID/current revision/tag before writing and has a 520,000-byte total batch budget. The general workspace batch stays capped at four records. This narrow primitive does not allow arbitrary workspace updates, SQL, callbacks or executable operations.

Each imported expense includes the preview ID, original file hash, origin/filename, row number/hash, reference, paired local reviewer identity and review time. The atomically saved receipt contains selected row/created expense IDs, request/preview/file hashes, reviewer/time and exact signed per-currency selection totals. Historical receipts describe what was imported; they do not authorize a future automatic import or attest to a bank's identity.

## API and boundaries

`createExpenseImportService({ store, clock })` exposes `state`, `get`, `preview`, `commit` and `forget`. The optional clock returns integer epoch milliseconds. The runtime owns one service instance. Routes use the standard paired cookie/nonce, same-origin, strict JSON/no-query and current authorization checks.

| Route | Request and result |
| --- | --- |
| `GET /api/local/v1/expense-import/state` | Saved preview metadata/counts, confirmed Life totals, limits and explicit capabilities |
| `POST /api/local/v1/expense-import/previews` | `{ origin, filename, csv_text, file_sha256 }`, `Idempotency-Key`; returns `{ preview }`; exact creation retries reuse the saved record |
| `GET /api/local/v1/expense-import/previews/:id` | Full exact saved source, rows, current selectable status and receipt journal |
| `POST /api/local/v1/expense-import/previews/:id/commit` | Exact revision/preview/selected-row pins above, `Idempotency-Key`; returns `{ preview, receipt, replayed }` |
| `DELETE /api/local/v1/expense-import/previews/:id` | `{ expected_revision, preview_hash }`; deletes current preview and reports retention; imported expenses remain |

Limits: one file up to 40,000 original bytes, 100 logical data rows, 50 selected rows per reviewed commit, 100 saved current previews, 100,000 normalized preview bytes, 120,000 persisted preview/journal bytes, 90,000-byte preview JSON request and 10,000-byte commit/delete request. JSON escaping and repeated evidence can make a source under the raw-file limit exceed the normalized preview budget; it fails before persistence, with no silent truncation. Choose fewer rows or shorter descriptions. A 100-row short-value fixture is verified across two 50-row commits.

Origins must be simple 1–80-character `[A-Za-z0-9._-]` labels starting with an alphanumeric character. Filenames are bounded CSV names, not paths. Unknown fields, accessors, sparse or decorated selection arrays, duplicate selected rows, cross-workspace IDs and forged hashes fail. The shipped controller suppresses late responses after reset/switch/source refresh, and detached old review/forget controls issue no requests. There is no bank connection, URL import, file discovery, provider call, OCR, formula evaluation, model processing, money transfer or financial advice.

## Objective verification completed

```sh
cd web
node --test scripts/expense-import-*.test.mjs scripts/local-expense-import-storage.test.mjs scripts/local-life*.test.mjs
```

All **52 combined import/storage/Life cases pass**, including **21 new import cases** and **five dedicated actual SQLite batch cases**:

- Independent expected parsing of BOM/CRLF, quoted comma/newline/doubled quotes and physical source lines; visible malformed-row rejection without guessed recovery.
- Exact cents for two currencies and a refund, whole/one/two decimal forms, invalid dates, rounding/exponent/locale/overflow denial and inert formula/URL text.
- Preview creates zero expenses; explicit selected subset creates only those confirmed Life records and the correct per-currency totals. Unrelated private documents/tasks/grants/sources are preserved.
- Same-reference/in-file/reimport identities, renamed exact files, changed reference files, separate origins and distinct identical purchases without references. Changed no-reference files carry the explicit duplicate limitation.
- Revisions, source/row hash tampering, invalid/duplicate/oversized selected batches and a concurrent imported source reject the whole batch before partial publication.
- Maximum 100 logical rows via two explicit 50-row commits; oversized normalized source fails before persistence.
- A real SQL abort after the first expense rolls back every expense, preview revision and receipt. The narrow storage gate rejects unrelated tags while retaining the general four-record cap.
- Actual committed batch followed by simulated lost response: durable retry returns the original receipt without a duplicate. Restart and a fresh verified backup restore preserve exact source/journal/totals.
- Real paired HTTP enforces cookie/nonce/origin/method/query/body/ID boundaries; stale sessions fail after restart. Forgetting preserves imported expenses and reports historical retention.
- The shipped controller against real HTTP reads only the chosen File, starts all row confirmations unchecked, imports an explicit two-row subset, shows invalid/refund/currency/hash evidence and receipt, and forgets only the preview.
- Fatal UTF-8 rejection, changed file/label during reading, late responses after reset and detached former review/forget controls send no unauthorized mutation or expose stale source content.

The controller tests use a synthetic DOM with real File bytes, SQLite and HTTP. Separately, the integrated root agent verified the actual native browser file chooser using `/tmp/learnbridge-synthetic-expenses.csv`, original SHA-256 `eb42e1d1050095e4a36306cf930ea7285b99170193e6a22183d0c176db1ff94d`. Three valid rows were individually reviewed and imported; the invalid amount `2.999` was excluded. The exact `12.50 CAD` expense and `-5.00 CAD` refund produced `7.50 CAD`, while `2.00 USD` stayed separate. The actual Daily life screen matched all three records, and root independently read back exactly three SQLite expenses. Screenshot evidence is `/tmp/learnbridge-expense-import-browser.png`. This proves that synthetic file's native selection/review/import, separately from the controller tests; it does not establish bank-specific export compatibility. No personal bank data was used.

## Remaining feature gates

This implements the selected documented CSV and reviewed transaction portion of [F20](../FEATURES_PRODUCTIVITY.md#f20--budget-and-student-administration). It does not complete the full budget/administration feature. Next independent slices are explicit per-category budget variance, selected receipt OCR with separate parser/privacy approvals, and official scholarship/admin requirement evidence with unresolved eligibility. Bank-specific mappings, purchase matching across changed reference-free files and automatic financial account access need their own explicit contracts and acceptance evidence.
