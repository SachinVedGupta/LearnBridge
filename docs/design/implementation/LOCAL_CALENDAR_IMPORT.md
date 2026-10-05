# Reviewed local calendar busy times

This F05 increment makes one explicitly chosen calendar file useful to the local deterministic study planner. The student reviews the whole file, sees every supported event and omission, checks exact events, accepts a bounded busy-time snapshot, then independently reviews a study-plan proposal. It uses no new dependency, migration, provider configuration, OAuth scope, network fetch or model call. The original `plan.today` recipe keeps its existing behavior.

This is a deliberately limited calendar reader. **Weekly recurrence, TZID event times, floating times and live calendar synchronization remain unavailable.** Exported files with explicit UTC events or date-only start/end events can work. The UI never advertises full calendar compatibility or complete free-time knowledge.

## Student workflow

1. Open **Calendar import** in the paired local dashboard. Choose one `.ics` file and explicitly enter the zone used for date-only events, such as `America/Toronto` or `UTC`. No file, source, event, zone or date range starts selected. The app does not search the computer or acquire an account.
2. Choose **Preview selected calendar file**. The browser validates UTF-8, checks the byte limit and hashes its exact content. The server returns a private file preview; the browser compares its content, hash and byte count. Review the complete original file, supported UTC intervals and date-only intervals, all excluded events/components and limitations.
3. Check only the events that should block study time. Enter the exact reviewed UTC start and exclusive end, at most 90 days. Every checked event must overlap that interval. Choose **Accept only checked busy times**, then approve the separate exact confirmation. The app atomically creates a selected busy source and records the review receipt. It clips busy windows at the displayed interval boundaries. Zero supported/overlapping windows cannot produce a source or calendar-aware plan.
4. Explicitly choose that accepted source. Enter study availability in UTC, the plan's local-day zone, maximum daily study minutes, buffer and minimum block size. Availability and horizon must fit the accepted source interval. Choose **Prepare calendar-aware study proposal**. The planner reads current local tasks, subtracts only the selected busy windows plus the chosen buffers, and shows blocks, unresolved work and conflicts. It creates a proposal, not an accepted plan or external event.
5. Review the exact plan, its source pin, conflicts and remaining workload. Choose **Review and accept this study plan** and approve the separate confirmation. Acceptance recomputes the plan and verifies the exact calendar source, workflow result and current tasks. The saved plan appears in Today.
6. Optionally use **Calendar export** to prepare the accepted saved blocks as a separate reviewed file. Export also rechecks the accepted busy source. Importing that file into another app remains a separate student action and is not claimed successful here.

**Stop using this busy source** requires separate review. It removes the active source and makes its pinned plans/exports stale. Original file previews, plan records, historical revisions, downloads and backups may retain private information. Fresh reimport requires another explicit file preview and review; it does not silently reactivate a forgotten source.

## Supported file semantics

The parser accepts one UTF-8 `VCALENDAR`, `VERSION:2.0`, one `PRODID`, balanced components, CRLF or LF lines and standard folded continuation lines. A leading UTF-8 BOM is retained in the exact file hash but ignored when parsing. Filename is a basename ending in `.ics`; URL/path/cookie inputs are refused. Component/property names are parsed, never executed. Text escapes for comma, semicolon, backslash and newline are decoded as literal text. Titles and complete source contents use DOM `textContent`, never HTML.

| Form | Result |
| --- | --- |
| `DTSTART:20261006T170000Z` plus `DTEND:20261006T180000Z` | Exact UTC busy interval; supported `VALUE=DATE-TIME` is also accepted. |
| `DTSTART;VALUE=DATE:20260308` plus `DTEND;VALUE=DATE:20260309` | Date-only interval, with original dates preserved and both midnights resolved in the student's chosen zone. |
| Missing or nonpositive start/end; invalid calendar date/time | Visibly omitted; no duration is invented. |
| `RRULE`, `RDATE`, `EXDATE`, `EXRULE`, `RECURRENCE-ID` | Whole event omitted with `recurrence_not_supported`; no first-instance/weekly expansion claim. |
| `TZID`, floating time, mixed DATE/DATE-TIME, unsupported time parameters or `DURATION` | Whole event visibly omitted. |
| Nested components such as `VALARM` | Containing event omitted; alarm data is never executed. |
| Transparent events, cancelled or unknown status/transparency | Omitted as unavailable busy evidence. Tentative supported events are still student-selected assertions. |
| Other top-level components such as VTODO/VTIMEZONE | Listed as unsupported components and omitted; never used as time-zone authority. |
| Duplicate UID | Every occurrence is omitted as ambiguous; file order does not select an authoritative event. |
| Malformed structure/property parameters, missing UID, duplicate interpreted singleton properties | File refuses with no source acceptance. |

Dates are restricted to 2000–2100. The strict `Intl` helper collects modern zone offsets around a target day and round-trips candidate instants to exactly `00:00:00`. It requires one unique midnight; nonexistent or ambiguous midnight is omitted instead of choosing an offset. A Toronto date spanning spring transition is 23 actual hours; a fall transition date is 25 hours. A date-only event remains identified as a date interpretation, rather than being relabelled as a source-provided UTC time.

RFC 5545 defines DTSTART as inclusive and DTEND as non-inclusive, and distinguishes transparent events from busy time. This reader implements a bounded subset of those rules, not a complete RFC validator. See [RFC 5545, VEVENT](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1).

Unknown descriptions, URL/ATTACH/attendee/organizer fields and unsupported component text remain visible only in the full student-selected raw preview. They are not fetched, expanded, added to tasks/profile facts or automatically shared with an agent. An accepted busy source contains only selected event titles/UIDs, exact original/normalized dates, event-property hashes, file hash, selection, zone, interval and busy windows. It does not contain any unchecked event or raw file body. This is a file snapshot, not authenticated cloud ownership, source freshness or complete availability.

## Bounded storage and API

| Boundary | Limit |
| --- | --- |
| Exact file | 48,000 UTF-8 bytes; one local `.ics` file. |
| Physical lines / components / nesting | 4,000 / 200 / 8. |
| VEVENTs / checked supported events | 100 / 1–100. |
| Review interval / planning horizon | Positive, at most 90 days. |
| Study availability | 1–100 explicit intervals inside the accepted scope and plan horizon. |
| Retained previews | 100; each can accept one immutable source. |
| Workspace record | Existing 128,000 serialized private-data bound; a heavily escaped/metadata-rich file may hit this before the file limit. |
| POST preview / other bodies | 100,000 / 12,000 actual streamed bytes. |
| Workflow | Existing 10 tool calls, zero model calls, 256,000 result bytes, five-minute duration cap. |

The routes are only in the paired UI API. Normal loopback/origin/session nonce/no-query/body bounds apply. Private responses are uncached. Route authorization is checked after request-body waits and around asynchronous planning. They are not agent IPC tools.

| Route under `/api/local/v1/calendar-import` | Contract |
| --- | --- |
| `GET /context` | Limits and interpretation guidance; no source acquisition. |
| `GET /previews`, `GET /sources` | Previously selected local preview/source records. |
| `POST /previews` | `{filename,content,timezone}` + exact idempotency key. Returns full private preview. |
| `POST /previews/:id/accept` | `{expected_revision,review_hash,selected_indexes,scope:{start,end},confirmed:true}` + exact key. Atomic source creation/preview receipt. |
| `POST /sources/:id/forget` | `{expected_revision,version_hash,confirmed:true}`. Active-source revocation with explicit retention. |
| `POST /plans` | `{calendar_source:{id,revision,version_hash},availability,timezone,horizonEnd,maxDailyMinutes,bufferMinutes,minBlockMinutes}` + exact key. Server supplies `now` and runs only `plan.with_calendar`. |

File previews are `artifact` records with format `calendar_import_preview_v1`: initial revision 1, accepted receipt revision 2. Raw file, parsed support/omission list and exact review hash are immutable across acceptance. A separate `calendar_busy_source_v1` artifact is accepted at revision 1 and validated by its full source hash. Updates/deletion or any exact pin mismatch invalidate use. Creation and preview acceptance receipt use the existing atomic private SQLite batch.

`plan.with_calendar` carries that exact source ID, revision and full-record workflow hash in immutable run input and source pins. Each step resolves the same accepted source and recomputes using the current task set. Plan records use `calendar_study_plan_v1` with the original planner's `learnbridge-study-plan` payload. Acceptance and export revalidate the completed workflow, exact allocation result, current source pin and a complete deterministic recomputation. Plan acceptance retries do not bypass source revocation. Original `plan.today` inputs and recipe stay unchanged. Direct learning catch-up export remains unavailable; separately human-accepted handoff tasks can enter an ordinary plan and retain current learning-source validation in [calendar export](LOCAL_CALENDAR_EXPORT.md), including unscheduled capacity tasks.

An exact retry of a failed/uncertain plan request reuses its original server-issued `now` under the same request key/input, rather than changing the planning start. Successful new button actions receive a fresh key. The existing workflow leases, interruption and verification apply; cancellation/revocation does not promise that an already committed local proposal was undone. The UI aborts outstanding requests and checks session/selection generation before confirmation, hashing, response rendering or follow-up actions. Reset clears selected file controls and all private in-memory records. No object URL is created by this import UI.

## Objective verification

From `web`, run:

```sh
node --test scripts/local-calendar-import-*.test.mjs
node --test scripts/local-calendar-export-*.test.mjs scripts/local-student-workspace.test.mjs scripts/local-workflow-storage.test.mjs scripts/local-academic-refresh*.test.mjs scripts/academic-refresh.test.mjs
```

New coverage includes strict parser/negative bounds, DATE/DST/leap/midnight gaps/folds, duplicate IDs, explicit supported/omitted results, literal malicious content, zero-window gates, atomic CAS rollback, exact selected-only source readback, replay/restart/fresh-backup restore, source/task drift, revoked pairing/cancellation before plan save, actual paired HTTP and shipped browser event handlers linked to the real service/private SQLite.

The F05 golden fixture imports a Toronto 09:00–10:00 lecture, applies a 30-minute buffer and plans a 90-minute task due at noon inside 09:00–12:00. It must produce exactly 10:30–12:00 and no deficit. A shortened 11:30 horizon must allocate 60 minutes and report 30 remaining. The export test uses actual `plan.with_calendar`, accepts it, exports only its saved blocks, then forgets its source and proves acceptance/export retries fail without restoring that source or changing tasks.

The optional independent oracle uses an already isolated Python environment, without installing packages or changing application dependencies:

```sh
CALENDAR_IMPORT_ORACLE_PYTHON=/path/to/isolated/python node scripts/local-calendar-import-parser-check.mjs
```

It requires exactly `icalendar==6.3.2`, compares its parsed UID/TEXT/UTC/DATE values with the shipped reader, and uses Python ZoneInfo exact fold/gap round-trips for six synthetic files. The oracle verifies UTC, exclusive dates, escaped text, Toronto spring/fall day lengths, leap dates and skipped/ambiguous midnight denial. Browser event fixtures establish handling and stored-result verification, not compatibility with every external calendar export. No private account/calendar file was used as a fixture. Evidence/counts are in `LOCAL_CALENDAR_IMPORT_VERIFICATION.json`.

An additional actual browser proof selected one synthetic UTC commitment on October 5, 2026, 13:30–14:30Z, chose a 10-minute buffer and produced a 45-minute study block at 14:40–15:25Z. The student-side flow separately accepted the study plan and downloaded the real ICS file. Independent `icalendar==6.3.2` parsing found exactly that one saved study event. The downloaded file was 4,084 bytes, SHA-256 `d9457be46cf502d7ad4d1f1a3fd37ff0b19cef60e2130eeb6d2d12f42b925677`; no attendee, alarm or provider write occurred. This proves the supported synthetic browser journey and saved download, not private provider access or every external export. The observed receipt is `/tmp/learnbridge-calendar-import-live.json` on the verifying machine.

Remaining F05 work includes explicit recurrence/TZID adapters, reviewed schedule diffs with pinned work, selected live calendar reads and provider-specific write/readback gates. They must retain unknown coverage and exact review boundaries; this increment does not mark all F05 acceptance cases complete.
