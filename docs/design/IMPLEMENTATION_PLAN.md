# LearnBridge implementation plan for coding agents

Build a local edition beside the hosted website, in dependency order. Each package below must result in a small usable capability and its evidence, with failure paths included. This plan does not authorize deployment, new production dependencies, cloud configuration, university login, real discovery or external writes. Follow the student's task authorization and repository rules at the moment of action.

## Working method

1. Read repository instructions, this package and the current source. Inspect dirty files; preserve unrelated edits. Use a suitable existing checkout/worktree and a `codex/` branch when a branch is needed.
2. Select one work package whose dependencies pass. Record the acceptance IDs, supported edition/OS and tests to be implemented before coding.
3. Make a minimal vertical change; implement schemas and deterministic logic before AI orchestration. Use synthetic sources while building.
4. Run the relevant feature cases and cross-cutting security/recovery tests; inspect persisted outcomes, not only mocks. Repair failures before broadening scope.
5. Update feature/compatibility status with evidence and remaining blockers. Request approval only for the concrete dependency/service/release action that still needs it. Prepare reviewable patches first.
6. When commits are authorized, use separate commits for foundation, feature, verification and documentation stages as appropriate. Never bundle private data or generated student artifacts. Push/deploy is a separate explicit action.

The work packages below describe target implementation. The hosted, local lifecycle, source and project MCP commands listed in [setup](../../SETUP_LEARNBRIDGE.md) exist today; full durable run/execution, remote and measurement APIs remain targets to create. Consult [implementation status](IMPLEMENTATION_STATUS.md), and do not run invented commands and report success.

## Milestones and release slices

| Milestone | Scope | Exit gate |
| --- | --- | --- |
| M0 | Design and source feasibility | This documentation package is coherent, links/examples parse; implementation not claimed |
| M1 | Private local foundation and workspace agent bridge; optional public setup/adoption slice W23 | Clean demo setup, storage restart, pairing/private APIs, MCP discovery, lifecycle and hosted regression |
| M2 | Controlled profile and academic evidence | Approved source discovery, reviewed facts, course/material imports, coverage and exact citations |
| M3 | Agent execution and useful daily learning workflow; optional remote companion W24 after core | Verified agent mode, cited Today plan, learning attempt, reviewed tasks, local scheduling previews |
| M4 | Documents, browser and career | Verified artifact formats, official job shortlist and supervised application draft with no unapproved submit |
| M5 | Connected productivity and recurring reads | Provider-specific inbox/calendar/document/project workflows, read-back and revision/conflict recovery |
| M6 | Life features, platform-specific desktop, voice/mobile/sync | Individually verified useful recipes; privacy/device/platform gates for each optional extension |

M1–M3 form **Local Student Core**. Its release claim is setup + approved sources + course context + planning/tutoring + local reviewed tasks. It need not contain every M4–M6 idea to be a useful product. Browser write support, each app provider, each artifact format and each OS ship independently only after their gates pass. F29 web/setup measurement can ship early after W05; local activation measurement follows W07/W11. F28 remote execution follows full W07/W11/W12 as an optional M3 extension. Neither hosted extension blocks Local Student Core or requires M6 voice/full sync.

## M1 Local foundation

### W01 Establish shared contracts and protect the hosted edition

Dependencies: M0. Create `web/packages/core` schemas and repository/identity/agent interfaces; extract reusable types from `web/packages/shared` without changing hosted route auth behavior. Add explicit edition/capability models and root local development wrappers only after they work. Do not use a request parameter/environment toggle to bypass hosted auth.

Deliver: unit contracts for versions/revisions/time/source IDs, migration plan for current JSON state, local fixture identity. Verify malformed schemas/date inputs and hosted OAuth/account ownership regression. Acceptance: F01-A01 foundation prerequisites, F04-A06 migration design, security S01/S08 in verification.

### W02 Resolve distribution and dependency choices

Dependencies: W01. Prepare owner decisions for LearnBridge's license; integration notices/pins; minimal production additions for SQLite/MCP/local runtime and browser later. Spike supported SQLite driver on target OSes, and static local UI build served by Node. Identify native compiler requirements, packaging size, restart/backup behavior and supported Node version. Use temporary fixture data, never university tokens.

Deliver: concrete dependency diff, license manifest and tested spike report. Obtain required approval before adding production packages. Prefer a reviewed stable locked driver; do not switch global Python or install a broad automation stack speculatively. Avenue missing notice blocks vendoring, not an independent adapter design. Acceptance: F24-A01/A03/A05; dependency installation and static UI proof on initial supported OS.

### W03 Implement private storage and migration lifecycle

Dependencies: W02 approved dependencies. Create `web/packages/local-storage`: migrations, transactions, revisions, task/document/run/grant tables, managed file references, FTS foundation, consistent snapshots and restoration. One writer/daemon root lock; restrictive directory/IPC ACLs; opaque credential references. Keep records outside checkout. Current hosted state imports need a deliberate student export, not access to someone else's cloud rows.

Deliver: fixture save/restart/export/restore; interrupted migration rollback; disk-full and concurrent-update handling. Acceptance: F01-A01/A03/A05, F04-A06 and recovery R01/R02/R05. Do not build every future table yet.

### W04 Build runtime access and policy enforcement

Dependencies: W03. Implement loopback server, Host/Origin/CSRF/read nonce/Fetch Metadata rules, paired-session lifecycle, authenticated artifact/event APIs, private IPC principal and source/processing grants. Path-safe file adapter needs handle-based containment checks on claimed OSes. Child processes get an explicit env allowlist.

Deliver: paired private dashboard, policy service and instrumentation for file/network/model calls. Acceptance: S01–S07/S09, F01-A04, F27-A04. Must prove legitimate browser reads with missing Origin work while unpaired/cross-origin reads fail. No cloud processing grant means no personal content serialized to an agent.

### W05 Build thin local UI and diagnostics

Dependencies: W03/W04. Create static `web/apps/local` shell and runtime CLI; extract shared components gradually. Add Today placeholder, manual tasks/documents, source/profile/setup screens and doctor. Setup has preview/idempotent merge/backups, optional dependency checks and fixture demo. Current site remains running under its original commands.

Deliver: clean install/start/demo/stop/uninstall guide; no cloud key requirement. Acceptance: all F01 cases; fresh machine on the initial claimed platform and hosted build/auth regressions. Windows/Linux can remain explicitly experimental until their setup and safe-read gates pass.

### W06 Publish narrow MCP bridge and agent workspace packs

Dependencies: W04/W05. Use the official MCP SDK for stdio lifecycle, schema discovery and bounded calls into private runtime IPC. Implement status/task/context/run tools needed for fixtures; private read outputs carry execution destination and processing grants. Generate reviewed Codex/Claude project config examples and skills; no secrets, global overrides or permission-bypass flags.

Deliver: official host discovers tool names/schemas and reads permitted synthetic context. Acceptance: F24-A02/A04, S09/S10 and real host tool visibility; complete F25-A01's reviewed task mutation only after W07. A host app's own connectors are separate capabilities; explain that in setup.

### W07 Implement run journal and review core

Dependencies: W03/W04/W06. Create run states/events, budgets, checkpoints, cancel/resume, leases, exact action proposals and human review receipt APIs. Initially use a fake external provider to exercise execution/reconciliation; no real send/submit/write tool needed yet.

Deliver: UI shows prepared/awaiting/partial/interrupted/unknown outcomes; rejects forged approvals and stale payloads. Acceptance: all F27 cases, F25-A01 with the completed bridge, R01–R06. M1 exits only after W01–W07 and hosted regressions pass.

## M2 Profile and academic sources

### W08 Implement controlled inventory and profile review

Dependencies: W04/W07. Implement F03 metadata inventory, source-selection preview, exclusions, hard budgets, safe local extraction and coverage; F02 reviewed field store, conflicts/staleness and purpose-specific context. Follow onboarding verbatim. Start with selected local text/Markdown/PDF and student-entered facts; approved exported memories remain optional.

Deliver: synthetic profile review with supporting source excerpts, corrected fields and usable narrower onboarding. Acceptance: F02-A01–A05 and F03-A01–A18. Run actual student discovery only after the student approves the shown scopes/processors, not as an installation side effect.

### W09 Integrate Avenue academic reads

Dependencies: W02 notices decision, W04/W07/W08. Build lean stdio entry point or independent academic adapter against the pinned audit; remove eager optional Supabase dependencies, broad HTTP mode, arbitrary path/delete tools and inherited secrets. Institution profiles configure login/API hosts and version support; own managed browser profile and serialized access. User completes SSO/MFA.

Deliver: enrollment/announcements/assignments/materials with stable IDs, raw/normalized deadlines and partial coverage; grades/feedback separately selected. Acceptance: F06-A01–A08 plus a supervised real McMaster read if claiming McMaster support. Test expired session and unchanged reimport. Unsupported institution remains manual import; local auth does not establish hosted support.

### W10 Build course library and retrieval evidence

Dependencies: W08; W09 is required only for live institution reads, with reviewed manual imports available independently. Create SourceVersion/chunk/FTS extraction/index pipeline, source viewers and scoped search. Text/Markdown and text PDFs first; OCR/Office as separately tested additions. Reuse the downloader and safe path workers.

Deliver: source version/page citations, content change detection, import coverage and forget. Acceptance: F07-A01–A06 plus the 30-query recall/locator benchmark and S05/S07. M2 release also needs clean onboarding with one approved real source; synthetic tests alone do not prove institutional access.

## M3 Agent and daily learning

### W11 Add official local execution adapter

Dependencies: W06/W07/W10. Workspace mode can already orchestrate; add official Codex app-server for embedded experience only after protocol/auth spike. Pin/generate supported schemas; normalize streams, approvals, interrupt/resume and limits. Optional own ChatGPT plan flow is a separate adapter with documented request restrictions. Keep Claude official workspace/CLI path first; embedded API mode is separately selected/permitted.

Deliver: one real inference+tool turn per released mode, failure handling with no hidden paid fallback. Acceptance: F25-A01–A06 and A01–A04 agent tests in verification. An unavailable embedded mode cannot block the valid workspace release.

### W12 Add Today, tasks and local calendar planning

Dependencies: W07/W10; W09 is required only for live institution-backed plans. Reviewed academic exports/manual course inputs satisfy source gates for non-institution workflows. W11 or workspace mode supplies prose. Implement normalized task graph/recurrence, source override rules, deterministic ranking and workload allocator. ICS/manual calendar first, provider read after capability probe. Plans remain previews and local tasks; external event execution waits for M5.

Deliver: accepted cited task plan surviving restart, conflict/unscheduled work display. Acceptance: all F04 cases, F05-A01/A02/A03/A06 and deadline/time fixtures. Avoid an AI optimizer when deterministic intervals suffice.

### W13 Add tutoring and catch-up workflows

Dependencies: W10/W11/W12. Course/topic selection, restrictions, hint/teach-back flows, actual attempt/checkpoint records, exam weighting/evidence, revision plan and task acceptance. Show selected source/context use. Never silently fill graded assignment answers or infer mastery from activity.

Deliver: one end-to-end course refresh → day plan → source-cited topic session → student attempt → accepted next step. Acceptance: F08-A01–A06, F09-A01–A05, cited-source/learning quality rubrics and live student pilot. M3 exits with Local Student Core release evidence and onboarding/setup docs reflecting actual supported commands.

## Optional hosted extensions at the appropriate checkpoints

### W23 Add public setup and adoption measurement

**Placement:** web/setup slice after W05, parallel with remaining M1/M2 work. Opt-in local activation/weekly-active reporting after full W07/W11 and a verified student workflow. Stable package numbers do not imply that W23 waits for W22.

**Dependencies:** W01/W05; W07/W11 are required for the later local measurement slice, optional for the public setup page. Reuse current website account verification and database isolation. See [F29](FEATURES_REMOTE_AND_ADOPTION.md#f29--website-and-local-setup-adoption-measurement).

1. Create an anonymous-accessible hosted `/setup` page with supported platforms, the canonical setup prompt/version, prerequisites and a Copy setup prompt control. Clipboard failure keeps manual selection available. Emit a successful-copy event only after the clipboard promise resolves. The prompt itself authorizes no telemetry, account-linking or personal search. Keep signup optional.
2. Define metrics before instrumentation: traffic/page views and estimated visitors; successful prompt-copy events; verified registered accounts; meaningful active accounts; separately opt-in activated/weekly-active local installations. Label each denominator and method. Clicks do not establish installation; an account or installation is not necessarily one unique human.
3. Prepare reviewed Vercel pageview integration for allowlisted public routes and a first-party Supabase event collector for setup clicks. Vercel custom events are plan-gated; do not require a paid analytics upgrade for first-party click counting. Validate SDK/current quotas and obtain any required service/dependency approval before adding or enabling them. The collector uses a strict event schema, body/rate limits, retry IDs, short retention and bounded abuse handling; anonymous clients cannot write account events.
4. Derive signup and meaningful hosted activity from authenticated server outcomes. Keep provider-permitted name/email in a private auth-backed account directory; use opaque IDs/counts in analytic tables. Implement server-checked admin roles plus RLS for aggregate/admin views, retention/purge jobs and a clear tracking notice. Do not expose a student roster or assume marketing consent.
5. Later add a local usage toggle, telemetry-only rotating installation identity and optional separately confirmed account link. Send minimal setup/first-workflow/weekly-active receipts; offline mode queues bounded events only after consent. Opt-out deletes the unsent queue and stops requests. Source data, prompt/task titles, credentials, host session IDs and remote-job payloads never become metrics. Basic local setup and use remain fully functional without reporting.

**Deliver:** public setup page, reliable clipboard feedback, documented metric queries/denominators, private owner dashboard and optional local reporting once its later gates pass. **Acceptance:** F29-A01–A10 and [measurement/security proof](VERIFICATION.md#remote-and-adoption-verification). Early web release must pass applicable public-copy/event/account/admin/privacy cases; local cases remain NOT_IMPLEMENTED until their own gate passes. Test actual hosted database/RLS and browser flow, not a button-click mock or API request count. Deployment remains a separate authorized release.

### W24 Add an optional phone-to-local agent companion

**Placement:** optional M3 extension after the first reliable local agent/day-plan workflow, before broad desktop automation; separate from M6 voice and full-data sync.

**Dependencies:** full W03/W04/W07/W11/W12, supported actual host authentication/approval mode and reviewed relay service. W09/W17 are optional only for institution/connected-app workflows that have separately passed their read/consent gates. The current three-tool MCP bridge and task review queue alone do not satisfy full W07/W11. See [F28](FEATURES_REMOTE_AND_ADOPTION.md#f28--phone-to-local-agent-companion).

1. Pin and verify a permitted local Codex stdio app-server/SDK adapter with actual turn events, cancellation, native approvals and recovery. Keep Claude custom-site mode unavailable until its supported adapter/auth path is proven. Native provider phone remote can be documented as an alternative, but is not the LearnBridge website backend. Optional ChatGPT plan/API inference is a separate F25 mode, not a desktop-control API or silent billing fallback.
2. Extend schemas with distinct website account, installation instance, device principal, grant and job/run identity. Implement short-lived registration challenge plus human confirmation in the paired local UI; save only device credentials through a verified secure local store. Restoration/reinstall/account change invalidates prior bindings. Preserve loopback/IPC security; never upload agent/university auth or forward raw privileged protocol calls.
3. Build owner-isolated Supabase device/job/event/result tables, atomic job claims, monotonic lease epochs, retry IDs, quotas and expiring results. Use existing Next.js APIs for short authenticated requests. A local outbound HTTPS poller claims work with backoff; no inbound laptop port or long-lived Vercel function is required. Persist the local job-to-run mapping before execution so redelivery reconciles rather than starts a duplicate.
4. Add responsive hosted device selection/status/request screens. Start with bounded study requests, citations, proposed local tasks, status, cancel and exact human task acceptance. Show selected workspace/source/relay/model processing and approval scope. Any new source selection still needs local human consent. Phone controls cannot change executables, shell flags, data roots or provider capabilities.
5. Normalize agent/native approvals into exact pending review requests. Authenticate phone decisions, bind account/device/session/job/native request/payload/source revisions/expiry, and preserve native host restrictions. Recheck grants around asynchronous results. Consequential external actions and broad computer control remain disabled until their own action/host release gates.
6. Handle asleep/offline/stale device, limits, stream gaps, cancellation, revoke and unknown outcomes. Resume delivery by event cursor, authenticate every artifact read, expire unsent jobs and retained relay content. Require relay-processing consent before the phone transmits a prompt for enqueue/storage, then revalidate it before local work, result upload and phone delivery. Disclose the trusted relay's content access; TLS is not E2E. Encryption beyond transport requires a separately reviewed implementation, key lifecycle and tests.

**Deliver:** one phone-sized website request completed by its paired local computer with citations and a reviewed task, saved after restart; reconnect/cancel/revoke evidence and a clear offline state. **Acceptance:** F28-A01–A12, existing S01/S08/S09/S10, A01–A04 and R01/R03/R04/R06, plus real two-account/multi-device and authorized-host checks. A durable fake relay proves recovery mechanics; only actual phone → hosted relay → supported host → saved result proof permits the remote release claim. Keep remote and analytics consent independent. F23 can reuse this transport if installed, but typed/voice capture and selected sync remain independently releasable.

## M4 Documents, browser and career

### W14 Expand writing and verified artifacts

Dependencies: W03/W07/W10/W11. Multi-document repository/revisions, TipTap offset mapping, selection edits, rubric evidence and protected base hashes. Format processor registry and output verification; Markdown/text PDF/DOCX first, LaTeX only where supported compiler verified, slides/spreadsheets later. Never modify source originals or claim export merely from created bytes.

Deliver: preserved drafts, reviewed edit diff, rendered/reopened export with hashes/citations. Acceptance: F10-A01–A06 and F11 cases applicable to each released format, plus per-format live/render gates. F11-A06 is mandatory only when spreadsheet support ships; initial Markdown/PDF/DOCX does not claim unsupported format gates passed. Keep format availability explicit in doctor.

### W15 Add portable supervised browser adapter

Dependencies: W02 dependency review, W04/W07. Pilot dedicated-profile Playwright MCP, optionally official Claude Chrome/Browser Harness. Host browser tools are registered capabilities, not a universal bundled engine. Build fixture ATS/editor apps with server-side instrumentation; site scope/fresh-state/file-upload boundaries; manual auth handoff.

Deliver: prepared form with exact attachments and zero unapproved submits. Live prefill/upload needs approved site/account and actual bounded data because forms may autosave before submission. Acceptance: F26-A01–A05/A07, S10 and supervised live preparation. Native desktop support is not implied by this browser milestone.

### W16 Add internships and application/career workspace

Dependencies: W08/W11/W14/W15 (sourcing may start before browser). Official ATS adapters with dated snapshots, factual eligibility/duplicate filters, shortlist; reviewed resume/answer package; per-application records and form preparation. Adapt selected `please-hire-me` patterns with notice, never its bypass launcher. Add career practice from confirmed experiences/attempts.

Deliver: verified official shortlist and one supervised prepared application whose answers/attachments student can review. Acceptance: F14-A01–A05, F15-A01–A06, F16-A01–A04 and source/quality gates. Actual submission is optional, separately authorized and requires persisted confirmation. M4 may release discovery/preparation without automated submission.

## M5 Connected productivity

### W17 Add source selectors and normalized app reads

Dependencies: W08/W11 and each connector's permitted auth. Start with one mail and one channel provider; then Drive/Notion/Office/GitHub/Linear selected collections. Support host recipe/import, configured direct MCP/API, and optional deliberately scoped hosted relay independently. Do not embed developer keys or presume host connectors are accessible in dashboard mode.

Deliver: account/collection ownership, cursor/save coverage, changes and source-cited tasks. Acceptance: F12-A01–A03, F13-A01/A02/A04, provider read matrices and S08 if relay implemented. Ship each provider only for proved operations.

### W18 Add reviewed external writes and project workflows

Dependencies: W07/W12/W14/W15/W17 and actual write capability. Calendar events, notes/Docs exports, messages and issue updates each have exact target/payload/revision/attachment review, idempotency/reconciliation and read-back. Git work preserves dirty files; commits/pushes/team messages require authorization. Add project/agenda/action-item workflows.

Deliver: per-operation test destinations and verified outcomes; partial multi-destination report. Acceptance: F05-A04/A05, F12-A04/A05, F13-A03, F17-A01–A05 and F27 failure suite. Provider lack of revision/idempotency support must be visible, never replaced with a false guarantee.

### W19 Add opt-in schedules and quiet monitoring

Dependencies: W07/W12/W16/W17. Schedule leases, timezone/missed-run policies, resume/checkpoints, source refresh grants, notification fingerprints and quiet unchanged runs. No recurring external actions merely because read monitoring was approved.

Deliver: actionable changed/failed/missed-run notifications; no duplicates from two processes or restart. Acceptance: F22-A01–A06 plus R04/R06. Machine asleep/offline and local-runtime limitations stated in UI. Optional hosted workers cannot reuse university/browser credentials.

## M6 Broader life and optional platform capabilities

### W20 Add practical student-life recipes

Dependencies: W08/W12/W14. Meals/pantry/shopping arithmetic, habits/focus tracking, receipts/budgets/admin deadlines, campus/transit/weather preparation. Start with manual inputs and sourced public data. Avoid adding banking/purchasing/payment permissions for a budget or grocery list.

Deliver: one useful complete workflow per feature with editable accepted output. Acceptance: F18-A01–A04, F19-A01–A04, F20-A01–A04 and F21-A01–A04 plus feature quality gates. Unknown/sensitive facts stay unresolved; this is productivity support, not medical/legal/financial advice.

### W21 Add native desktop assistance

Dependencies: W15 and per-OS supported adapter/permissions. Pilot a narrow app/file workflow in a disposable test workspace; declare apps and operation versions; manual Accessibility/screen grants. Implement verify/reopen outcomes and stop when state changes.

Deliver: explicit compatibility matrix; F26-A06 and platform negative tests. Do not promise full computer control on every student's laptop or remove host approvals.

### W22 Add voice, mobile and selected sync

Dependencies: W03/W04/W07/W12; W24 is optional for reusing its remote transport, never a prerequisite for local typed capture or separately supported selected sync. Extra services/permissions explicitly approved. Typed responsive view first; optional microphone/transcription selection; transcript review; separate local/cloud processing and audio retention. Reuse F28 device pairing/transport when remote access is offered, with its exact ownership/replay/processing gates; otherwise explicitly limit this slice to its supported capture/sync mode. Selected hosted sync uses per-user auth/revisions and excludes local university tokens.

Deliver: supported device capture/review and conflict/revocation results. Acceptance: F23-A01–A06 plus S01/S08/device replay gates. Do not simply bind the local service to the LAN. M6 is several independent optional releases, not one all-or-nothing platform rewrite.

## Definition of done for each work package

- Feature cases have real executable tests with assertions against stored/provider outcomes and negative cases, not implementation-mirroring mocks alone.
- Relevant security, recovery, hosted regression and supported-platform checks pass. Required blocked/skipped live gates remain visible and limit the release claim.
- Model quality is scored on fixed cases and reviewed by people for material correctness; deterministic checks do not certify all AI answers.
- Setup, capability matrix, migration/rollback and student-facing limitations match the code that actually ships.
- Evidence report includes tree/version, feature/test IDs, actual/expected outcomes, redacted artifacts and remaining work. No secret/personal-data artifacts enter Git.

The initial foundation/MCP/source slice is delivered as recorded in [implementation status](IMPLEMENTATION_STATUS.md). Complete the remaining W07/W09/W10/W11/W12 gates for reliable academic execution. W23 public setup/adoption can proceed independently after W05; optional W24 remote control waits for full durable execution and review. Adding these plans does not itself authorize implementing, configuring or deploying the hosted extensions.
