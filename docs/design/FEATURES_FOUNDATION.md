# Foundation and execution feature specifications

All features here describe target local behavior. Current hosted functionality is a starting point, not acceptance evidence for the local product. Implementation paths are proposed. Use the [contracts](CONTRACTS.md), [architecture](ARCHITECTURE.md), [onboarding](ONBOARDING.md) and [verification rules](VERIFICATION.md) for shared behavior. Each acceptance ID is a required executable scenario to implement, not a test that already passes.

## F01 Setup and diagnostics

**Meaning.** M1: a student can clone the repository, ask their existing coding agent to set it up, and reach a usable local dashboard with fixture data before connecting any private service. Setup reports exactly which agent, connector and artifact capabilities are ready. It must not require an owner-created cloud project for basic local use.

**Expected flow.** Select local or hosted development mode; detect OS/runtime; show needed dependency/config changes; install reviewed locked packages; choose private data root; initialize migrations; generate project-scoped agent configuration; start loopback runtime; pair the dashboard; run a demo workflow; show health and optional connection steps. Official agent/provider login and OS grants remain student actions. Do not alter the student's global agent settings or silently replace files.

**Inputs and outputs.** OS/runtime versions, edition, existing config hashes, chosen data root, selected agent and approved optional dependencies. Output setup version, compatibility report, reversible config diff/backups, diagnostic results, active runtime address and fixture verification evidence. Diagnostic output excludes credential values and personal source paths.

**Implementation.**

1. Implement dependency/version discovery and explicit capability probes in `web/apps/local-runtime`; probes do not search credential files or issue real inference by default.
2. Build a setup CLI with dry-run, local demo, doctor, start, stop, export and uninstall-data choices. Existing root `npm run setup` still installs the hosted workspace; add local commands only once they work and update the guide then.
3. Create private storage and migration transactions, root lock, IPC credential and pairing. On setup interruption, resume or roll back incomplete changes.
4. Generate Codex/Claude project config as a reviewed merge. Preserve unrelated sections and ask before any global config change. Backups contain config, not raw secrets.
5. Make doctor probe tool discovery, storage integrity, loopback binding, optional browser/format dependencies and live-mode readiness independently.
6. Prove clean installation in disposable macOS, Windows and Linux environments before listing support. Record exact tested runtime ranges and pin locked releases.

**Recovery.** Unsupported runtime shows actionable install guidance; unavailable optional integrations stay disabled. Port conflicts select a free loopback port and report it. Disk/permission/migration errors preserve the prior root. Uninstall stops managed processes and removes only selected LearnBridge data/config additions, preserving original files and external host accounts.

| Acceptance | Input and action | Required persisted or observed result |
| --- | --- | --- |
| F01-A01 | Clean temporary user root, no cloud keys or provider login; install/start demo | Dashboard loads; fixture task saved and present after restart; no Supabase/Composio/OpenAI requests |
| F01-A02 | Existing project config with custom MCP/model settings; setup twice | Unrelated config bytes/semantic values unchanged; one LearnBridge entry; second run makes no duplicate changes |
| F01-A03 | Port occupied and migration interrupted mid-transaction | New port remains loopback-only; migration rolls back or resumes to one correct version; previous records unchanged |
| F01-A04 | Synthetic secrets in parent process environment and optional connectors absent | Child env ledger has only reviewed allowlisted keys; report contains no secret canary; missing capabilities explicitly disabled |
| F01-A05 | Uninstall fixture installation after adding an unrelated file | Managed processes stop; selected generated files removed; unrelated file and original config survive; data deletion separately chosen |

Live/platform gate: fresh-machine walkthrough by a student on every claimed OS, including spaces/non-ASCII in paths and no privileged account. Performance target after dependencies are available: start and health response within 10 seconds on the named reference machine; report measured times rather than promise all hardware.

## F02 Reviewed student profile and memory

**Meaning.** M2: LearnBridge knows the student's confirmed identity, courses, goals, preferences, constraints and relevant experience without requiring them to retype it every session. It knows where each fact came from and can distinguish inferred, conflicting and stale evidence. It does not automatically inherit an agent's hidden memories.

**Expected behavior.** Start with optional student-entered basics and approved discovery. Show proposed fields with supporting excerpts; let the student accept, correct or reject selected fields. Use purpose-specific context packs: tutoring needs course/learning preferences, applications need confirmed career facts, meals need selected dietary preferences. A general profile is not permission to send every field to every model. Show what each run used and let the student forget it.

**Data.** Versioned `ProfileFact`/`WorkflowPreference`, evidence/version references, review receipt, sensitivity, validity window and processing grants. Candidate and confirmed stores are separate logical states. Eligibility, GPA, graduation and legal/disclosure facts require explicit confirmation. A student's own statement is valid provenance; it must be labelled as such rather than invent a source document.

**Implementation.** Implement field schema and field-level review; deterministic extraction for simple metadata first; bounded structured model proposals only when approved; conflict resolver; context assembler filtered by purpose and grants; change/expiry invalidation; profile manager and export/purge. Use F03 source lineage and F27 runs, not a free-form system prompt as the database. The hosted display-name lookup is only a small predecessor.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F02-A01 | Synthetic resume says graduation 2028; selected site says 2027 | Conflicting alternatives and evidence preserved; application context omits an authoritative graduation date until review |
| F02-A02 | Student accepts three fields, rejects one and edits timezone | Only accepted/corrected fields become confirmed; rejection persists after restart; correction has student provenance |
| F02-A03 | Request tutor context; profile contains private finance and career eligibility fields | Returned fields match tutoring-purpose grant; excluded fields and their source text absent from model ledger |
| F02-A04 | Source version changes and one confirmed field expires | Affected facts become stale; current application payload generation pauses for reconfirmation; historical revision remains labelled |
| F02-A05 | Forget selected source/profile field then search/export/restart | Active profile, FTS, context/cache and selected managed derivatives no longer return distinctive fixture canary; backup/external-copy exceptions listed |

Quality gate: label a 30-fact fixture set with direct evidence, inference, identity mismatch and ambiguity. Require no unsupported confirmed identity/eligibility fields and human-reviewed evidence correctness before claiming automatic profile understanding. See onboarding for detailed coverage and discovery tests.

## F03 Controlled source discovery

**Meaning.** M2: support a broad laptop/cloud/profile review in deliberate, auditable batches so the agent understands the student's workflows. Broad means many chosen sources with coverage, not unrestricted access to the entire machine or all connected history.

**Flow and output.** Choose categories and roots/accounts/collections → local metadata inventory → preview size and exclusions → select content → bounded local extraction → separately approve remote agent processing → propose a profile and workflow map → student reviews. Output a source map, known workflows, evidence, unresolved questions, source coverage and useful first task. Import optional student-provided ChatGPT/Claude/workspace exports through the same pipeline. Provider sign-in alone grants no access to account conversations or memories.

**Implementation.** F03 uses the exact [onboarding playbook](ONBOARDING.md), reviewed scope manifest, local deterministic inventory workers, canonical path enforcement, supported content parsers, source-selector UI and resumable cursors. Implement local/file and manual-profile paths first; each cloud selector follows its own capability/live gate. The agent sees only consented output; even filenames reaching a cloud-backed host are remote processing.

**Verification.** F03-A01 onward are defined in the onboarding fixture matrix and cover empty consent, metadata-only inventory, secret exclusions, symlink/path changes, pagination, budgets, identity mismatches, remote processing, injection, cancellation/resume and purge. Release F03 only when the corresponding instrumented file/API/model access ledger proves every requested boundary. Coverage may remain partial; the student can finish a useful narrower onboarding while omitted sources remain clearly unavailable.

Non-goals: password/cookie/vault scraping, hidden account-memory APIs, monitoring all activity, assigning inferred protected/health traits, or performing a real mass scan simply because this design document exists.

## F04 Today view and actionable tasks

**Meaning.** M3: answer what changed, what matters today, what to do next and what needs review. Combine deadlines, confirmed tasks, calendar constraints, accepted inbox requests and active runs. Priorities must be explainable and editable.

**Behavior.** Show source refresh status and exact deadlines alongside suggested work blocks. The v1 rank order is unfinished overdue work, manually pinned work, work due on the selected local day, then other dated work. Within a bucket, use manual priority descending, known deadline ascending, and stable task ID as the final tie-breaker. Overdue date-only work compares local calendar dates; timestamp deadlines compare actual instants. Unknown/conflicting source deadlines remain review items instead of an invented ranked deadline; intentionally undated manual tasks remain a separate editable list. Completed tasks never rank as pending. An agent may explain this deterministic evidence. Tasks support subtasks, dependencies, effort ranges, notes, status and recurrence. Accepting an AI proposal creates a local task; external calendar/task writes are separate F05/F27 actions. No unreviewed task creation from every message.

**Data.** Source deadline, student target date and scheduled study time are distinct. Store stable task IDs, source links, parent/dependencies, estimate confidence, student overrides, recurrence rule, completed occurrence and suggestion fingerprint. Source refresh updates source-owned fields while preserving student choices. The current `{title, course, date, done}` hosted JSON tasks need an explicit migration preserving date-only semantics and completion.

**Implementation.** Build task repository with revision checks; dependency DAG/cycle validation; time normalization; deterministic ranker; Today query across normalized entities; proposal review and idempotent acceptance; recurrence expansion over a bounded window; source-change diff and task-source linkage; responsive source-cited view. Keep search in F07. Use synthetic clocks so ranking and recurrence tests are repeatable.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F04-A01 | Clock `2026-10-02T13:00:00Z`, Toronto; task `overdue` due Oct 1, `today` due Oct 2, `pinned` due Oct 10, `unknown` with unresolved source deadline; equal manual priority | Pending order exactly `overdue,pinned,today`; review list contains `unknown`; each has exact source/reason; completed items excluded. Two identical-deadline tasks sort by stable ID on repeated/restarted query |
| F04-A02 | Accept same proposal twice then restart | One stored task with proposal/source identity; task remains and completed state survives |
| F04-A03 | Change source due time after student sets estimate and note | Source deadline updates once; estimate/note/completion unchanged; affected schedule proposal invalidated |
| F04-A04 | Add A→B→C→A dependencies; complete weekly recurring occurrence | Cycle rejected with unchanged DB; one next occurrence with correct local-date policy and no duplicate after restart |
| F04-A05 | Course refresh fails but previous cache exists | Today labels that source stale/partial; never asserts nothing due based on failed fetch; local edits remain usable offline |
| F04-A06 | Migrate hosted tasks with duplicate titles, completion and date-only deadlines | Every input entry retained or explicitly reconciled in migration report; titles do not serve as identity; original backup and rollback available |

Quality target: a student can identify their next action and its source in one screen. Human pilot records whether top priorities were useful; deterministic rank correctness is separately enforced. Do not mark a student's day successful from task activity alone.

## F05 Calendar and workload planning

**Meaning.** M3 local preview, M5 provider writes: combine timetable, personal calendars, due dates, effort and buffers into a feasible study schedule. The student sees conflicts and chooses changes before external events are created.

**Behavior.** Select calendars/date range; import ICS or permitted provider reads; preserve all-day/recurrence/timezone semantics; pin commitments and unavailable hours; propose study blocks within free time with breaks/commute buffers; show unscheduled work when capacity is insufficient. Replanning preserves completed/pinned blocks and previews a diff. Ask about ambiguous deadlines rather than silently choosing a timezone. Calendar writes need actual supported provider capability and exact event review.

**Implementation.** Parse normalized events with deterministic interval/recurrence logic; validate availability; allocate bounded effort greedily by deadline/priority for v1 rather than a complex optimizer; show infeasible constraints; create action proposals for added/changed/deleted events; use provider event IDs, revision/ETag and idempotency markers; verify event reads after writes. Selecting calendar access must not silently increase OAuth scopes. Local planning is usable without provider write scope.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F05-A01 | Toronto fixture planning window 09:00–12:00; fixed 09:00–10:00 lecture, post-lecture 30-minute buffer, one 90-minute task due noon, no other blocks/break constraints | Exactly one study allocation 10:30–12:00, duration 90 minutes, unscheduled deficit 0; empty/arbitrary plan fails. In a variant ending at 11:30, allocate 10:30–11:30 and report deficit 30 minutes |
| F05-A02 | All-day dates and DST ambiguous/nonexistent times in Toronto fixtures | All-day events keep date boundaries; unresolved wall times flagged; no silent UTC shift or invalid duration |
| F05-A03 | Read-only provider and student accepts local plan | Local plan saves; zero external writes; write capability shown unavailable |
| F05-A04 | Approve three fixture events, execute/retry after simulated crash | Three externally verified IDs, no duplicates where reconciliation is supported; unknown outcomes pause otherwise |
| F05-A05 | External event changes after preview | Revision conflict rejects write; fresh diff preserves remote edit; renewed approval required |
| F05-A06 | Effort exceeds all free slots; replan with completed/pinned work | Deficit in minutes is explicit; no impossible or past work blocks; completion/pins unchanged |

Live gate: read a selected calendar and, when authorized, create/update/delete a labelled test event with read-back and cleanup. Original Google/Calendar smoke-test restrictions prohibit changing real student calendar data just to test. Use a student-approved test calendar or read-only gate.

## F24 Integration and workflow extension system

**Meaning.** M1 foundation and later additions: install and understand integrations through reviewed versioned manifests, not arbitrary scripts suggested by an agent. An integration declares what it can do, required permissions, platforms, versions and verification.

**Implementation.** Manifest schemas and parser → pinned dependency/install plan → license/notices register → transport/schema discovery → reviewed operation classification → capability probes → common connector contract suite → live compatibility matrix → upgrade diff and rollback. Store secrets through connector auth outside manifests. Recipes declare grants/tool subset/budget/review/success predicates. Third-party executable code still needs supported host confinement; metadata declarations alone are not a sandbox.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F24-A01 | Manifest includes free-form shell string, missing pin or unreviewed write tool | Install/enable rejected; no process launched |
| F24-A02 | Upstream introduces new send/delete tool during discovery | Tool remains disabled pending classification/scope review; old reads still work |
| F24-A03 | Update adapter version with incompatible schema then roll back | Contract tests fail upgrade; prior working version/config remain; no destructive migration |
| F24-A04 | Child parent env includes secret canaries; manifest needs two keys | Child receives only reviewed essentials and connector-specific references; no unrelated token exposure |
| F24-A05 | Missing redistribution notice or unsupported OS | Distribution/support claim blocked; optional external install clearly separate from bundled release |

Non-goals: auto-install every MCP found online, inherited all-account access, or guaranteeing security from a tool's read-only annotation. Resolve LearnBridge's own distribution license before an open-source release; choose, do not assume, a license.

## F25 Existing agent execution

**Meaning.** M1 workspace packs, M3 embedded local mode: use the student's existing Codex or Claude setup as the orchestrator with their own official authentication. Subscription limits and provider permissions still apply; it is not unlimited free inference.

**Flow.** Student selects mode → diagnostics confirm official client and configured tool visibility → student signs in if needed → fixture workflow proves tool use → UI states whether requests run in the official host session or LearnBridge's embedded adapter. Show unavailable mode/limits clearly. No copying hidden auth files or silent API fallback. An agent's connected app can be used in the host recipe when authorized; that does not magically give the dashboard the same connector.

**Implementation.** Build one host-neutral instruction/recipe set with Codex/Claude packaging; MCP stdio registration merge; narrow capability context; official Codex app-server adapter behind pinned protocol conformance; normalized stream/approval/cancel/resume events; own supported ChatGPT plan authorization adapter only if needed; optional permitted API modes. Recheck official docs at implementation; do not publish custom Claude subscription login. Sources and constraints are in architecture.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F25-A01 | Real official host connected to fixture LearnBridge MCP | Agent discovers tools, reads fixture course and proposes a task; student acceptance saves exactly one local task |
| F25-A02 | Mock provider emits duplicate/out-of-order stream events and fails mid-turn | UI deduplicates by sequence; incomplete text labelled; no automatic task/action commit; checkpoint retained |
| F25-A03 | Interrupt then resume official supported session | Recorded interrupted state and native thread ID; no post-cancel calls; resumed run uses valid scopes and one continuation |
| F25-A04 | Entitlement/rate-limit/auth failure with optional API key present | Failure shown without fallback request or additional charge path; paid mode requires explicit selection |
| F25-A05 | Model asks to approve its own external proposal or expand source scope | Policy rejects; real human approval/consent required; no execution recorded |
| F25-A06 | Doctor returns available model catalogue but inference is denied | Model mode remains unverified/degraded; no entitlement claim from catalog/login alone |

Live gate: a completed authorized turn and fixture tool workflow for each released mode/version. Protocol mocks prove error handling, not plan access. Host mode remains a valid release path even if embedded chat is unavailable.

## F26 Browser and computer assistance

**Meaning.** M4 browser, M6 native desktop: use a supported browser or desktop adapter to inspect approved pages, prepare forms, upload reviewed files and perform controlled actions when structured connectors cannot do the job.

**Behavior.** Prefer API/MCP operations. Choose dedicated browser profile by default; existing signed-in browser access is separate opt-in. Student handles sign-in, MFA/CAPTCHA and OS permissions. Bound workflows to selected sites and tasks, re-read page state after navigation, verify actual DOM/accessibility outcomes, and preserve existing unrelated tabs/files. Documents and web instructions are untrusted data. Filling a live form or uploading an attachment can transmit/autosave data before Submit; approve the actual site/account and bounded answers/files before live preparation. Local draft preparation does not authorize that transmission. Submitting/sending/purchasing/deleting require F27 and host controls.

**Implementation.** Browser driver interface for navigate/read/locate/fill/attach/prepare/execute/verify; Playwright MCP pilot; optional Claude Chrome/Browser Harness adapters; reviewed URL/operation filters; freshness checks; file upload hash/path checks; fixture ATS and editor apps; native adapter capability probe per OS/app. Never run permission-bypass launch flags. Native computer control is optional and platform-specific; LearnBridge cannot bundle the developer's Codex desktop tools automatically.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F26-A01 | Fixture page re-renders IDs after navigation | Driver uses fresh state and fills intended fields; hidden/stale locator produces a clear error rather than another field edit |
| F26-A02 | Form attachment with known hash; malicious page asks for another file | Only selected attachment uploaded; file hash/name confirmed; no outside-root read or extra upload |
| F26-A03 | Form ready with no submit authorization | Fields prepared and review saved; submit request count stays zero; run awaiting student |
| F26-A04 | Login/CAPTCHA and unsupported native OS permissions | Pauses with student handoff; no credential read/guess; other usable capabilities remain available |
| F26-A05 | External click times out after fixture acceptance | Reconcile persisted page/server outcome before retry; no inferred success from button disappearance alone |
| F26-A06 | Desktop adapter edits labelled test document under approved scope | Reopen exact document, verify content/version; unrelated app/file state unchanged; OS/app marked supported only for tested operations |
| F26-A07 | Fixture form autosaves on field input and upload; only local-draft permission exists, then student grants bounded live-prefill permission | Before live-prefill grant, zero autosave/upload/body requests. After grant, only approved fields/attachment hash sent to selected site; unselected facts absent; Submit counter remains zero without separate submission authorization |

Live gate: one supervised read and prepared action per browser adapter; a separately authorized disposable write with external confirmation for write support. Browsers and native apps need versioned compatibility reports. Screenshots corroborate outcome but cannot replace stored/provider state when it is available.

## F27 Durable workflows and reviewed actions

**Meaning.** M1 lifecycle, M3 reviewed execution: turn requests into recoverable work with real completion evidence. Support cancellation, budgets, partial outcomes and exact-payload review rather than trusting the agent to remember what it did.

**Implementation.** Validated recipes and capability plans → persistent run/step journal → deterministic checkpoints/leases → action proposals/fingerprint → human review receipt → pre-execution grant/revision recheck → idempotent execution/reconciliation → verification → final status/evidence. Local reversible mutations can use a bounded student policy, preserving host rules. Student controls consequential external actions; no application/coursework submission capability in academic recipes.

| Acceptance | Input and action | Required result |
| --- | --- | --- |
| F27-A01 | Crash after two saved read steps then resume; repeat with a changed source version and revoked grant | Revalidated unchanged steps not duplicated; changed source invalidates dependent steps for bounded refresh; revoked input cannot be reused; unsaved work retries safely; budgets not reset; historical evidence remains labelled |
| F27-A02 | Approved payload changes target/body/attachment/base revision | Fingerprint mismatch; execution rejected and approval invalidated; fresh review required |
| F27-A03 | Two concurrent execute requests and timeout after provider success | One active lease; reconcile provider record before retry; at most one verified fixture effect |
| F27-A04 | Student revokes source grant while job is queued/running | Queued reads and future tool calls denied; cached context invalidated; in-flight outcome disclosed without new follow-ups |
| F27-A05 | Cancellation/model/tool budget exhausted during run | No new calls after stop; partial artifacts/tasks not falsely completed; checkpoint and next action visible |
| F27-A06 | Provider succeeds but read-back disagrees or is unavailable | Final state failed/partial/unknown_outcome as appropriate; never completed solely from tool/model text |
| F27-A07 | Two of three destinations succeed | Per-destination result and receipts preserved; retry targets unresolved actions only; no duplicate first success |

Security and reliability acceptance is deterministic for the managed fixture path. Real external APIs, browser tools outside the broker and human authorization require separate live/host checks. The workflow runner cannot guarantee exactly-once network side effects without provider reconciliation support.
