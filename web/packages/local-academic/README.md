# Academic exports and bounded Avenue reads

This independently implemented package normalizes student-selected academic exports and wraps an already reviewed MCP client with a bounded read-only policy. It has no external dependencies, file access, environment/credential discovery, browser launcher or model calls. No Avenue source code is vendored.

## Manual export and review

`normalizeAcademicExport(raw, { selectedCourseIds, previous? })` accepts only the explicit version-one shape below. A student must choose the export and courses in the host UI. Parsing a file or receiving a snapshot does not approve connected-account reads or cloud processing.

Example export template; replace fixture fields using the student's chosen sources, preserving unknown dates:

```json
{
  "schema_version": 1,
  "institution": {
    "name": "Example University",
    "origin": "https://learn.example.edu",
    "timezone": "America/Toronto"
  },
  "account_ref": "local-student-opaque-reference",
  "retrieved_at": "2026-10-02T12:00:00Z",
  "courses": [
    {"source_id": "781264", "title": "Software design", "code": "DESIGN", "url": "/d2l/home/781264"}
  ],
  "assignments": [
    {"source_id": "101", "course_id": "781264", "title": "Design questions", "description": "Read the prompt and list questions.", "due": "2026-10-05", "url": "/d2l/le/content/781264/Home"},
    {"source_id": "102", "course_id": "781264", "title": "Lab preparation", "due": "TBD"}
  ],
  "announcements": [
    {"source_id": "201", "course_id": "781264", "title": "Office hours", "body": "Bring your questions.", "published_at": "2026-10-02T11:30:00-04:00"}
  ],
  "materials": [
    {"source_id": "topic:301", "course_id": "781264", "title": "Lecture 1", "body": "Optional selected text.", "url": "/d2l/le/content/781264/viewContent/301/View", "type": "topic"}
  ],
  "coverage": {
    "courses": {"state": "unknown"},
    "assignments": {"state": "partial"},
    "announcements": {"state": "unknown"},
    "materials": {"state": "partial"}
  },
  "errors": []
}
```

All four category arrays are required and can be empty. `coverage` and `errors` are optional. Each coverage entry accepts `complete`, `partial`, `unavailable` or `unknown`; this is reported source coverage, not proof that the institution returned every item. Omitted coverage stays `unknown`. Errors contain only `{category,course_id?,code}`; arbitrary messages and credential fields are rejected.

Rows use a source ID unique within their category/course. IDs can be a positive integer or a bounded opaque string. `course_id` is the institution's course/source ID, not a local task UUID. All links must be HTTPS at the selected institution origin, with no credentials or token-like query parameters; relative institution links are resolved. External resource links need a future separately scoped adapter.

Typical normalized assignment:

```json
{
  "id": "stable-owner-and-source-bound-uuid",
  "source_id": "101",
  "course_id": "781264",
  "title": "Design questions",
  "url": "https://learn.example.edu/d2l/le/content/781264/Home",
  "description": "Read the prompt and list questions.",
  "deadline": {"precision": "date", "date": "2026-10-05", "timezone": "America/Toronto", "original": "2026-10-05"},
  "source_hash": "sha256-of-this-normalized-source-row"
}
```

IDs remain stable when source content changes and differ across account/institution/category/course boundaries. An explicit offset/Z ISO timestamp becomes a canonical UTC instant while retaining the original source text. Date-only input remains a date. Missing, invalid, timezone-less or locale-formatted dates remain `unknown` with their original text and a review warning; no midnight, due time or timezone is guessed. Explicit deadline objects may be supplied using `precision: date|instant|unknown` and the corresponding field.

Exact duplicate rows collapse with a counted warning. Conflicting variants of one source ID remain in `conflicts` and are omitted from authoritative records until review. Invalid/unsafe rows produce partial coverage with redacted warning codes. Top-level schema/accessor/prototype/size errors reject the export. Existing snapshot hashes are verified before comparison; `changes` lists added/changed/unchanged/missing IDs. `missing` is review information and never deletes a local task or proves that an item was removed from the LMS.

The result is a `learnbridge-academic-snapshot` with normalized categories, selected course IDs, coverage counts, errors, warnings, conflicts, changes and `snapshot_hash`. It contains no automatic task creation, submission, profile confirmation or storage side effect. The host owns preview, explicit import approval, persistence and revision rules.

## Injected MCP adapter

```js
import { createAvenueReadAdapter, academicExportFromAvenueReads, normalizeAcademicExport } from '@learnbridge/local-academic';

const adapter = createAvenueReadAdapter({
  client: reviewedClient,
  institutionOrigin: 'https://learn.example.edu',
  accountRef: 'local-student-opaque-reference',
  selectedCourseIds: ['781264'],
  session: verifiedSessionMetadata,
  proof: 'fixture',
});
await adapter.probe();
const result = await adapter.read('get_assignments', { orgUnitId: 781264 });
const exported = academicExportFromAvenueReads([result], {
  institution: selectedInstitution,
  courses: selectedCourseMetadata,
  accountRef: 'local-student-opaque-reference',
  retrievedAt: new Date().toISOString(),
  selectedCourseIds: ['781264'],
});
const preview = normalizeAcademicExport(exported, { selectedCourseIds: ['781264'] });
```

`reviewedClient` implements `listTools(params, {signal})` and `callTool({name,arguments}, {signal})`; an official SDK client can be wrapped to that interface by the host. The adapter does not establish a transport or launch upstream code.

Trusted session metadata is `{account_ref,institution_origin,verified_at,expires_at}` with UTC timestamps. **These fields are not authentication proof when provided by a browser/model.** The host must bind the actual configured MCP client to the student's independently verified institution session and approved scope; it must never accept an HTTP-provided `session` object as permission. Live proof is a host-configured mode after that verification, not something a student can claim by editing an export. The current package's tests use only `fixture` proof.

Without a session, `probe()` returns `auth_status: missing` / capability `requires_auth` and makes no upstream calls. Expired sessions return `expired`. A successful compatible discovery reports availability with `proof: none`; a validated read records only the configured proof and time for that operation. `capabilityReport()` also includes attempt budget and selected-course count. `setSession()` validates a replacement and clears discovery/proofs; re-probe after a student-controlled sign-in. Late reads or metadata from a replaced/removed/expired session are discarded.

Allowed tools and enforced arguments:

| Tool | Arguments |
| --- | --- |
| `get_assignments`, `get_announcements`, `get_course_content`, `get_course_modules` | Required selected positive-integer `orgUnitId` |
| `get_assignment` | Selected `orgUnitId` plus positive-integer `assignmentId` |
| `get_course_topic` | Selected `orgUnitId` plus positive-integer `topicId` |
| `get_course_module` | Selected `orgUnitId` plus positive-integer `moduleId` |
| `get_upcoming_due_dates` | Selected `orgUnitId`; optional integer `daysBack`/`daysAhead`, each 0–90 |

Discovery validates the expected numeric input schemas; mismatches and duplicate advertised tool names are unavailable. Unknown keys, defaults that omit the course, other courses and unknown tools are rejected before `callTool`. Global enrollment discovery, grades/submissions, file read/download/delete, task/cloud/embedding writes and token/auth tools are disabled. Pagination is limited to three discovery pages; calls default to 32, timeout to 10 seconds, and returned JSON to 256 KB. The adapter passes cancellation to the client and discards results after timeout/cancel. A client that ignores `AbortSignal` may continue an upstream read; this is not a hard process-stop guarantee.

Results must be bounded text-only MCP JSON with the audited per-tool row shapes and safe institution links. They are untrusted source data, never instructions to the agent. `AcademicError` contains stable, redacted codes; upstream raw errors are not returned. `academicExportFromAvenueReads()` converts valid successful reads to the same review template, leaving coverage unknown. Calendar rows are not promoted into assignments because this upstream format loses event identity and uses heuristic date classifications.

## Live integration gate

The [pinned Avenue audit](../../../docs/design/implementation/AVENUE_ADAPTER_AUDIT.md) documents why the upstream server is not launched unchanged. A usable live route needs a separately reviewed/hardened local read-only adapter, official student SSO/MFA, dedicated private session ownership, independent account/institution verification, and selected-course read tests. Approved institutional OAuth is the preferred API route where available. Until then, selected manual exports are the working route; fixture MCP success does not prove real Avenue access.

Run both synthetic suites from the repository root after installing the web workspace dependencies:

```sh
node --test web/scripts/academic-adapter.test.mjs web/scripts/academic-mcp.test.mjs
```

The second suite uses the installed official MCP SDK client/server and a real stdio child process with invented data. It verifies discovery, selected-course reads, blocked tools, missing/expired sessions, output bounds, timeout/cancellation, late-response rejection, environment isolation and child shutdown. Its server has no network or filesystem operations. These are protocol and policy checks, not institution compatibility evidence.

## Course retrieval recipes

`src/library.mjs` adds a pure, JSON-serializable library recipe. The runtime must obtain the selected snapshots/text through its reviewed source controls and persist the resulting recipe in its own versioned transaction. These functions establish data integrity and selection boundaries; a supplied hash or course list is not proof of human consent.

```js
import { buildAcademicLibrary, searchAcademicLibrary, resolveAcademicCitation } from './src/library.mjs';

const library = buildAcademicLibrary({
  snapshots: [reviewedAcademicSnapshot],
  selectedCourseIds: ['781264'],
  texts: [],
  revokedSourceIds: [],
});
const result = searchAcademicLibrary(library, {
  query: 'recursion base case', courseIds: ['781264'], limit: 5,
});
const evidence = resolveAcademicCitation(library, {
  source_id: result.results[0].source_id,
  version_hash: result.results[0].version_hash,
  chunk_id: result.results[0].chunk_id,
  courseIds: ['781264'],
});
```

For selected files, `texts` records are `{source_id,version_hash,course_id,title,format,parser_version,retrieved_at,text}`. Text/Markdown format requires the SHA-256 of exact UTF-8 `text` as `version_hash`. `pdf_text` instead takes `pages:[{physical_page,printed_label?,text}]` and the reviewed original-file hash; the caller owns actual extraction and original-file integrity. This module neither opens nor parses PDFs. Unsupported OCR/office formats fail explicitly. Empty extracted text produces `text_unavailable`, with no searchable empty-success chunks.

All snapshots in one recipe must share an account and institution. Hashes and normalized row hashes are checked before indexing. Historical versions are retained, current search uses only the most recently retrieved version, and exact old citations remain marked `historical`. Passing a revoked source ID excludes all its versions and chunks from this new recipe. Rebuild and replace any previously stored recipe/caches in the host's same revocation transaction; this pure module cannot purge an old stored copy or backup. Source text is always labelled untrusted.

Chunk locators identify text line ranges, Markdown section/line ranges, or PDF physical pages and optional separately retained printed labels. Long lines use exact JavaScript UTF-16 character offsets within that line; chunks never split a Unicode scalar. Retrieval applies hard course selection before deterministic whole-token ranking. Queries may not widen the recipe's selection. Snapshot coverage is labelled `source_reported`; narrowed query counts are unknown when the recipe lacks a per-course coverage breakdown. A reported complete snapshot is not independent proof of complete institutional coverage.

Input/output recipes are bounded to 4 MB, 100 snapshots, 2,000 selected text records, 1,000 declared PDF pages per record and 6,000-byte text chunks. The host should use smaller operational budgets and durable chunk storage for large libraries. No embeddings, cloud processing, network requests or automatic model reads occur.

## Deterministic Today and catch-up previews

`src/planning.mjs` exports `rankToday`, `planStudyWork` and `nextPracticeReview`.

```js
import { rankToday, planStudyWork } from './src/planning.mjs';

const today = rankToday({ tasks: reviewedTasks, now: '2026-10-03T12:00:00Z', timezone: 'America/Toronto' });
const proposal = planStudyWork({
  tasks: reviewedTasks,
  now: '2026-10-03T12:00:00Z', timezone: 'America/Toronto',
  horizonEnd: '2026-10-04T00:00:00Z',
  availability: [{ start: '2026-10-03T13:00:00Z', end: '2026-10-03T17:00:00Z' }],
  busy: [], pinnedBlocks: [], maxDailyMinutes: 180, bufferMinutes: 10,
});
```

Tasks use core task fields, with optional `manual_priority` (0–5), `pinned` and `estimate_confidence` (`student|source|agent_estimate|unknown`). Today excludes completed/cancelled/deleted tasks and orders overdue, manually pinned, due-today, then other dated work; equal priorities/deadlines use stable IDs. Unknown source deadlines appear in review. Intentionally undated manual tasks have their own list.

Planning accepts explicit offset/Z instants for availability, busy blocks, `now` and `horizonEnd`; a timezone-less local time is rejected. Horizons are at most 90 days. It merges overlapping availability, subtracts commitments and buffers, splits available intervals at actual local-day boundaries, and schedules known effort greedily within daily capacity and prerequisite order. Spring/fall DST uses elapsed minutes, not wall-clock arithmetic. A date-only deadline remains a date; its local calendar day bounds the planning preview, without altering the original record into a fabricated due instant.

The output stays `state: proposal`, includes task revisions/source references and an input fingerprint, and reports unscheduled minutes, unknown effort, blocked prerequisites and conflicts. Busy calendars and original tasks are never modified. Pinned blocks remain fixed even when a changed deadline or prerequisite creates an explicit review conflict. A pinned block whose duration differs from declared effort is not silently treated as task completion. A partial plan may contain useful blocks; `all_known_work_fits` is false while any unresolved work/conflict remains. Accepting a plan and idempotently creating tasks belongs to the host's review/storage implementation; this module does not implement acceptance or external calendar writes.

`nextPracticeReview({attempted_at,correct,previous_correct_streak?,rule_version?})` returns the versioned `practice-cadence/1` schedule: correct streaks use 1, 3, 7, 14, then 30 elapsed 24-hour days; an incorrect attempt resets the streak and schedules one day. Store each attempt independently before using its returned streak. This deterministic reminder policy never creates a global mastery claim.

Domain verification: `node --test web/scripts/academic-library.test.mjs web/scripts/academic-planning.test.mjs` from the repository root. The library benchmark uses 30 synthetic exact markers and checks 30/30 retrieval/citation matches; it does not establish natural-language academic quality or actual PDF extraction. Live institution reads, original-file extraction, storage revocation/forget, idempotent plan acceptance, UI and student usefulness require their own end-to-end gates.
