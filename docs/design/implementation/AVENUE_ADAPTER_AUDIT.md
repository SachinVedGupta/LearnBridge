# Avenue adapter audit and implementation boundary

Reviewed October 2, 2026. Source: [alanxue1/avenue-mcp](https://github.com/alanxue1/avenue-mcp), pinned commit `9f996323641aba91cc0bbf2b21efd429f9a465e1`. This audit reads public source only. No real university session, student records, credentials or upstream process was accessed.

## What the pinned project does

The [README](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/README.md) describes a McMaster adaptation of a D2L MCP server. Its authentication uses a separate persistent Playwright profile and student SSO/MFA; optional environment username/password automation is also present. Its base defaults still include another institution unless configured. This is an institution-specific session integration, not universal D2L authorization.

The pinned tree contains a README statement of MIT licensing but no standalone `LICENSE` file. No upstream code is vendored into LearnBridge. Any future redistribution of copied code needs its license/notice provenance resolved. LearnBridge's academic adapter is an independent implementation of a small reviewed interface.

## Audited read interface

The [server registrations](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/index.ts) expose these selected-course reads:

| Tool | Upstream input | LearnBridge decision |
| --- | --- | --- |
| `get_assignments` | Optional numeric `orgUnitId` | Require an explicit selected course |
| `get_assignment` | Optional `orgUnitId`, required numeric `assignmentId` | Selected course plus positive assignment ID |
| `get_announcements` | Optional numeric `orgUnitId` | Require an explicit selected course |
| `get_course_content`, `get_course_modules` | Optional numeric `orgUnitId` | Require an explicit selected course |
| `get_course_topic`, `get_course_module` | Optional `orgUnitId`, required `topicId` or `moduleId` | Selected course plus positive item ID |
| `get_upcoming_due_dates` | Optional `orgUnitId`, `daysBack`, `daysAhead` | Selected course, bounded 0–90-day arguments |
| `get_my_courses` | Empty object | Disabled in the selected-course adapter: it discovers all enrollments |
| `get_my_grades`, `get_assignment_submissions` | Course and possible assignment ID | Disabled in this initial academic scope |
| Files, study/cloud writes, sync and embedding tools | URLs, paths, task/content parameters | Disabled |

Read responses are a text MCP block containing JSON arrays or a detail object. The [assignment tools](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/tools/dropbox.ts) return fields including `id`, `name`, `dueDate` and `instructions`. The [marshaller](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/utils/marshal.ts) turns dates into locale-formatted text even though the tool description suggests ISO dates. It also omits empty fields. That loses machine-readable time/zone precision; LearnBridge preserves formatted source dates as unknown/review-required. Course modules/topics and announcements are independently validated against their actual marshalled shapes.

## Why LearnBridge does not launch it unchanged

These are source findings, not claims that an attack was performed:

- The [HTTP server](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/index.ts) uses wildcard CORS, optional bearer authentication and a general listen call, logs request headers/tool arguments, persists MCP session IDs, and restores sessions by touching transport internals. Those behaviors do not match LearnBridge's paired local boundary.
- The [auth CLI](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/auth-cli.ts) prints part of the authentication token. The [auth implementation](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/auth.ts) has a persistent browser profile and environment-driven login. LearnBridge does not copy an existing developer profile, search session stores, enter passwords or capture token values through this adapter.
- The registered tool catalogue includes arbitrary filesystem reading/deletion and downloads with custom paths, alongside remote study writes and embeddings. Passing the whole catalogue to a student agent would exceed the selected-course read scope.
- The [study schema](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/study/db/schema.sql) disables row-level security on its study tables. Its optional service-role/OpenAI setup is separate from LearnBridge's private local storage and must not become a shared multi-student backend.

## Implemented independent path

`@learnbridge/local-academic` provides two paths:

1. **Selected manual exports.** A strict version-one course/assignment/announcement/material template normalizes into an immutable-review snapshot. IDs are stable per institution/account/category/course/source; dates retain known precision or unknown originals. Duplicate conflicts, changed/missing rows, unsafe URLs and incomplete coverage remain explicit. The normalizer has no file/network/model side effects and does not create tasks automatically.
2. **Bounded injected MCP client.** A reviewed host client can discover only compatible audited tools, read selected course IDs with bounded parameters, timeout/cancellation/call/output limits, validate text-only JSON and convert successful reads into the manual review format. Unknown/global/file/write/token tools are rejected before calling. Missing/expired auth is distinct from unsupported schema. Fixture proof is distinct from a successful live read.

Session metadata supplied to this client is trusted host configuration. A browser/model-shaped object is not authentication. The host still has to verify the client's actual account/institution, enforce student source/processing grants and persist only an approved snapshot. The module cannot establish those facts just because a caller supplies matching strings.

The exact export template, normalized record shape and adapter signatures are in [the package README](../../../web/packages/local-academic/README.md). `web/scripts/academic-adapter.test.mjs` exercises synthetic normalization and injected-client policy. `web/scripts/academic-mcp.test.mjs` uses the installed official MCP SDK client/server over a real stdio child with invented academic data, and verifies selected reads, missing/expired sessions, prohibited tools, output bounds, timeout/cancellation, session replacement races, environment isolation and child shutdown. No real Avenue operation is claimed.

## Feasible live route and required gates

D2L's [OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html) and [getting-started guide](https://docs.valence.desire2learn.com/basic/firstlist.html) require an application identity and user authorization. This is the preferred API route when the institution approves the application; an ordinary student account is not automatically an app registration.

Where an institution permits a local student session integration, a separate hardened adapter could use a dedicated student-owned browser profile and official visible SSO/MFA, keep its session outside Git/logs, verify account identity, expose only the audited reads over stdio, and stop on expiry. That requires explicit review of institution rules, auth mechanics, dependencies and actual live behavior before availability is advertised. It is not implemented by launching the audited repository unchanged or borrowing a developer's desktop MCP.

Before claiming live McMaster or another D2L institution:

- Verify the intended account and institution independently, selected-course access, expiry/reauth, no secret logging and no cross-origin credential forwarding.
- Validate actual course/assignment/announcement/material outputs, API-version changes, empty/locked courses and partial failures. Preserve dates until precise source values are available.
- Test the SDK client protocol, cancellation behavior and restart/session ownership with synthetic fixtures, then separately test each permitted read using the student's reviewed scope.
- Prove no file/write/submission/token tools can be discovered or executed by LearnBridge. Grade/submission reads and external material origins need separate future scopes.
- Resolve upstream redistribution/license notices if code is ever copied; this implementation currently copies none.

Manual reviewed exports can be useful before those live gates pass. They do not create a universal login workaround, bypass MFA or grant LearnBridge access to every student's LMS.
