# Reviewed local calendar exports

Implemented slice of W12/F05 and the saved planning output used by F09. It prepares a local `.ics` download from explicitly selected accepted local tasks, or one exact accepted `plan.today` / `plan.with_calendar` study-plan version. Separately accepted learning-plan tasks retain their source and human review through the export. It never writes to a calendar provider, creates tasks, invokes AI, reads a laptop directory or refreshes an institution connection.

## Student flow

1. Open **Calendar exports** in the paired local dashboard. Tasks and plans start unselected.
2. Choose either up to 25 actual local task deadlines or one eligible saved study plan. Pending academic/agent task proposals are not actual tasks and cannot be exported.
3. Prepare a preview. Review every event, omission, exact dates, original source metadata, capacity warnings and file hash. No download or external calendar action happens at preview creation.
4. Confirm **Review and download this calendar**. The runtime rechecks exact current pins and the browser verifies the returned bytes and SHA-256 before requesting a download.
5. Check browser downloads and, if desired, import that file into the calendar of your choice. Importing is a separate student action. LearnBridge cannot verify importer behavior or the resulting remote calendar state.

A task deadline is a **transparent deadline marker**, not an invented study commitment. A study event uses an existing accepted block exactly; this export never allocates additional hours.

## Date, interval and file semantics

| Input | Export and visible behavior |
|---|---|
| Date-only deadline | `DTSTART;VALUE=DATE:YYYYMMDD` and next-calendar-date, exclusive `DTEND;VALUE=DATE`. No midnight instant or guessed source timezone. The transparent all-day marker preserves the source calendar date. |
| Exact whole-second instant | UTC `DTSTART:YYYYMMDDTHHMMSSZ`, with no `DTEND`/`DURATION`. RFC 5545 gives this deadline marker zero duration. Original timestamp/offset/timezone remain in provenance. |
| Unknown deadline | Omitted with its original text/reason visible in the preview. No guessed date, event or study hours. |
| Subsecond deadline | Omitted explicitly. RFC 5545 DATE-TIME cannot represent nonzero fractional seconds exactly. It is never silently rounded. |
| Completed/cancelled task | Omitted explicitly; task unchanged. |
| Accepted study block | Exact saved UTC start/end, opaque event, saved source timezone and complete original block metadata. Source deadline precision remains distinct from the scheduled study interval. |
| Unresolved/conflicted study block | The entire plan is unavailable for this export. Accepting a planning record alone does not resolve its block-level `needs_review` flag. |
| Subsecond study interval | Plan export unavailable; no silently rounded study hours. |
| Capacity deficit | Saved unscheduled work/coverage remain visible in the preview; only the actual scheduled blocks appear in the file. |

All timed properties use UTC, so they preserve the actual instant across DST. No floating local time or `TZID` definition is fabricated; the receiving calendar chooses its own display timezone. Date-only events remain dates independently of that display choice. IANA source timezone is retained in `X-LEARNBRIDGE-SOURCE-TIMEZONE` and metadata.

The writer follows [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545): CRLF endings; UTF-8 content lines folded at 75 octets without splitting a code point; escaped TEXT backslashes, commas, semicolons and newlines; exclusive all-day ends; strict positive study intervals. Imported text is never a property name, parameter or active URI property. Files contain no invitation method, organizer, attendee, recurrence or alarm.

Each event retains task/source hashes and exact selected provenance in a folded ASCII `X-LEARNBRIDGE-PROVENANCE` property containing base64url UTF-8 JSON, plus its canonical SHA-256. This preserves literal source backslashes/CRLF losslessly even with released parsers that decode JSON-in-TEXT ambiguously. The readable description explains the event semantics and original reported date. The UI exposes decoded provenance for review. Generic calendar clients may ignore custom properties; the bytes remain in the exported file.

Task UIDs derive from the local student identity and task UUID. They remain stable when the task is revised; `SEQUENCE` follows the local task revision. Study UIDs derive from the student identity, selected saved plan ID, task ID and exact block endpoints. Repeated exports of unchanged content produce identical event UIDs and file bytes. New plans are distinct reviewed plans. **Stable UIDs do not guarantee that Google/Apple/other manual importers update or deduplicate imported events.** This feature provides no remote reconciliation/readback guarantee.

## Exact review and persistence

`createCalendarExportService({store, studentWorkspace?, clock?})` exports:

- `context()` — task metadata and saved-plan eligibility; no selected source bodies.
- `preview(input,{idempotencyKey})` — selected deterministic durable artifact.
- `listPreviews()` / `getPreview(id)` — saved previews, expiry and refresh status.
- `download(id,{expected_revision,review_hash,confirmed:true})` — exact reviewed file payload.

Task request: `{mode:'tasks',task_ids:[UUID,...]}`. Study request: `{mode:'study_plan',plan_id,expected_revision,plan_hash}`. Extra keys, duplicate/holey IDs, getters, unsupported modes and malformed revisions/hashes reject before effects.

A standard saved study plan must be accepted by this local student, have the correct canonical plan hash, and match the verified allocation step of its actual completed `plan.today` or `plan.with_calendar` workflow. A calendar-aware plan additionally resolves its exact reviewed busy-source ID/revision/hash and recomputes the complete saved plan. Every planned task revision and the complete task set must still match; adding another task can invalidate capacity assumptions. The selected plan revision itself is pinned. Direct `learning_catchup` plan export remains unavailable: those synthetic topic task IDs are not accepted persisted tasks. The separate [reviewed task handoff](LEARNING_PLAN_TASK_HANDOFF.md) can create real tasks that this exporter supports through their original source verifier.

Task previews pin complete current task hashes and revisions. Accepted academic task provenance includes the original proposal/source/snapshot hashes without assignment description bodies. The existing trusted `studentWorkspace.getCurrentSnapshot()` gate checks that the referenced import is current and retained. Its snapshot/head revision is pinned at preview creation. Refresh, omission, forget, proposal change, task edit/completion/deletion or plan-state change invalidates the download. An old source record never becomes a live-source claim. Existing tasks are preserved, never automatically restored or replaced. Manually edited academic tasks show `local_task_differs` while retaining the original accepted source record.

Learning handoff task storage uses the existing `origin: manual` and empty `source_refs` fields; these fields alone never establish that a task lacks source evidence. For each selected task, the exporter calls `verifyPlanTaskProvenance({store,getLibrary:studentWorkspace.library,taskId})` and binds the exact independent acceptance receipt, accepted catch-up plan, tutoring session and selected academic snapshots. The verifier rechecks the original immutable task-create result, paired human review, accepted-only plan recomputation and current selected source versions. The file's `accepted_learning_plan_sources` contains reviewed task/source metadata, citations, academic policy and explicit `mastery_claim:false`; lecture bodies and unselected course bodies are absent. Manual title/deadline/effort edits remain exportable in a new exact preview with `local_task_differs:true`, while the original reviewed payload stays unchanged.

Saved study plans validate learning provenance for **every capacity task**, including tasks without an emitted study block. Their source pins are retained in the private export preview, but only emitted tasks contribute event metadata to the file. Stale or forgotten evidence makes the plan ineligible and refuses preview/download/replay; it does not remove the local task. An interrupted committed handoff task cannot export until the student explicitly recovers its exact pending receipt. The exporter never finalizes receipts or reaccepts revoked plans. Forgetting only a handoff preview preserves its independent accepted receipt and does not discard task provenance. Unrelated manually selected tasks do not acquire or expand unselected learning sources.

The artifact format is `calendar_export_preview_v1`. The immutable review hash covers request, pins, events, omissions, capacity warnings, exact file content/hash and lifetime. Creation is idempotent for one exact selected request; a changed request or source with the same key conflicts. Preview TTL is 10 minutes; a backward clock before creation also invalidates download. Expired files require a fresh preview/key.

Exact download first commits a revision-guarded local receipt. State `reviewed_download_payload` means **payload preparation was reviewed**, not “file saved” or “calendar imported.” Concurrent retries and restart return that same receipt/content without another task or remote action. Unchanged retries remain subject to source-current and expiry checks. If the browser cancels downloading, the receipt still honestly describes its prepared payload.

Bounds: 25 selected tasks, 50 saved study blocks/events, 48,000 UTF-8 ICS bytes, 120,000 serialized artifact bytes and 100 retained calendar previews. Oversized source metadata rejects, never truncates provenance silently. Existing SQLite revision history/backups retain prior artifact versions; these caps do not promise physical deletion. Source forgetting blocks new downloads but does not erase already reviewed private artifact copies or files that the student downloaded.

## Runtime and UI integration

`handleCalendarExportRoute({route,method,service,session,stillAuthorized,privateBody,idempotencyKey})`:

| Route suffix under `/api/local/v1` | Method | Effect |
|---|---|---|
| `/calendar-export/context` | GET | Bounded available local selection metadata |
| `/calendar-export/previews` | GET | Private retained previews |
| `/calendar-export/previews` | POST | Exact selected preview only |
| `/calendar-export/previews/:id` | GET | Private current review view |
| `/calendar-export/previews/:id/download` | POST | Confirmed exact reviewed JSON file payload |

The root server retains loopback host/origin, cookie, nonce and no-query checks. The route additionally requires the exact browser session and rechecks authorization after asynchronous body reading. No agent IPC export route or arbitrary provider operation is added.

`mountCalendarExportUI({root,request,element,busy,confirmAction,message})` implements selection, literal text rendering, omissions/provenance review, separate confirmation and SHA-256/byte validation before a Blob download. An optional `downloadFile` callback is solely a handler-test sink. Generation/selection/revision guards discard stale confirmations and responses after refresh/logout; double clicks do not duplicate actions. The browser reports **download requested**, never remote import success.

## Objective verification

Focused, no external credentials:

```sh
node --test web/scripts/local-calendar-export-*.test.mjs
```

- Real SQLite: selected known/unknown/date/instant semantics; DST/leap-date boundaries; exact review/CAS/idempotency/restart; stable UID/file bytes; edit/completion/deletion; expiry/backward clock; schema/getter/holey-array/key collisions; UTF-8/CRLF injection; actual verified accepted plan; capacity warnings; accepted-state/source-refresh/forget denial; zero task writes; bounds. A real SQLite trigger aborts receipt writes and proves no false reviewed result is returned.
- Route controller: exact dispatch, body bounds/keys, absent/revoked sessions and unsupported aliases/methods.
- Shipped UI handlers: unchecked setup, literal text, exact task/plan selection, separate review, omissions, declined/stale confirmation, logout while waiting, byte/hash tampering and duplicate clicks. These stand-ins prove controller ordering, not visual rendering or native browser download completion.
- Actual paired HTTP: preview→concurrent exact download→restart; actual accepted `plan.today` with source/task invalidation; imported academic task refresh refusal; real session/origin/nonce/query/schema/hash/consent guards. Native visual/download verification is a separate integration check.
- Learning handoff integration: 15 source-aware cases use the real library, Learning, handoff and calendar services with private SQLite. They prove source edit/new same-owner version/forget/revocation/receipt-tamper refusal, exact original review without source bodies, manual overrides, preview forget, interrupted receipt denial without writes, restart/backup restore, unscheduled capacity bindings and actual accepted `plan.with_calendar`. Actual paired HTTP also prepares/downloads/restarts the source-bound payload, revokes its tutoring session and reads back a conflict with exactly one task preserved. Counts and limits are recorded in `LOCAL_CALENDAR_LEARNING_HANDOFF_VERIFICATION.json`.

Independent released parser, isolated verification environment only:

```sh
python3 -m venv /tmp/learnbridge-calendar-parser-venv
/tmp/learnbridge-calendar-parser-venv/bin/python -m pip install --only-binary=:all: 'icalendar==6.3.2'
LEARNBRIDGE_ICS_PARSER_PYTHON=/tmp/learnbridge-calendar-parser-venv/bin/python node web/scripts/local-calendar-export-parser-check.mjs
```

The verifier uses [the published icalendar parser](https://pypi.org/project/icalendar/) on actual service outputs. It checks date-only DST boundaries, exact UTC/zero-duration semantics, Unicode TEXT roundtrip/folding, lossless CRLF provenance and an actual accepted study-plan interval. It asserts parsed event counts and positive timed ends; no alarm or extra component can be introduced. No Python/global/production dependency is added to LearnBridge. The optional independent verifier fails explicitly if its environment is absent; it is not a silently skipped test.

## Remaining calendar work

This slice implements local **export**. [Reviewed calendar import](LOCAL_CALENDAR_IMPORT.md) separately supports a bounded UTC/date-only file subset and calendar-aware planning. Recurring-event expansion, live provider availability, direct catch-up-plan calendar export, provider updates/deletes and external-write idempotency/reconciliation retain their own F05/F09/F27 source/review/live-account gates. No real student calendar must be modified merely to smoke-test this feature.
