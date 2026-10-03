# LearnBridge architecture and engineering decisions

Build one student experience with two explicit editions: a public account-based website and a private local runtime. Share UI components and domain contracts; keep their identity, storage and execution boundaries separate. The local edition owns its data and managed integrations and uses an official student-authorized agent. It must boot without a developer's Supabase, Composio or OpenAI credentials.

This is the target architecture. Proposed modules, endpoints and commands in this package do not exist yet unless marked current. The [implementation plan](IMPLEMENTATION_PLAN.md) turns them into ordered work packages.

## Current implementation and reuse

| Current area | Verified source behavior | Reuse and required change |
| --- | --- | --- |
| Website | Next.js and React application in `web/apps/web` | Keep hosted entry point; extract reusable components gradually rather than rewrite |
| Student state | `src/lib/cloud-state.ts` calls authenticated state routes with revisions; tasks and one draft are JSON state | Add domain repositories and an explicit migration/export bridge; retain hosted compatibility |
| Authentication | `src/lib/server/auth.ts` verifies Supabase users for API requests | Hosted adapter only; never add a localhost bypass to it |
| AI | `src/lib/server/ai-handler.ts` uses server-side API inference and selected connected sources | Reuse editing/tutor output contracts; create separate local agent adapters |
| Connections | `src/lib/server/connectors.ts` exposes a pinned read-tool set for selected student accounts | Reuse normalization where appropriate; add explicit per-tool capability registry and inputs |
| Brightspace | Public course route is unavailable; helper can spawn an external entry point and call one course tool | Replace handcrafted MCP client in local edition; never mount a developer session in hosted APIs |
| Tests | OAuth/provider mocks and `supabase/tests/student_isolation.sql` | Keep regression tests; add real local fixture and live capability suites |

The table reflects the original October 2 hosted-source audit. The subsequent private local slice now has a daemon, SQLite tasks/notes, selected text imports, MCP context/proposals and human task review; see [current implementation status](IMPLEMENTATION_STATUS.md). Full run orchestration, profile synthesis, live institution login and the new remote/analytics capabilities remain planned. Existing connection buttons do not prove each provider's content tools or writes work.

## Process and deployment layout

Use the existing `web` npm workspace for new executable TypeScript packages. This avoids introducing a second dependency tree for core code. The earlier vision's `local/` grouping is conceptual; this is the recommended physical layout after the M1 dependency review:

```text
web/apps/web/                 existing hosted Next.js entry point
web/apps/local/               local dashboard static build
web/apps/local-runtime/       loopback server, supervisor and CLI
web/packages/ui/              shared presentation components
web/packages/core/            schemas, repositories, planning and pure logic
web/packages/local-storage/   SQLite, attachments, migrations, retention
web/packages/local-mcp/       stdio bridge to private runtime IPC
web/packages/agent-runtime/   official Codex and Claude execution adapters
web/packages/connectors/      institution, provider, browser, document adapters
agent-packs/codex/             versioned project instructions and workflow skills
agent-packs/claude/            equivalent Claude workspace instructions
integrations/                 pinned manifests and third-party notices
tests/local/                  synthetic fixtures and cross-package scenarios
```

The local dashboard should be a static app served by the runtime under one loopback origin. It can use a separate Next.js static-export app, reusing existing React components; it has no server actions or hosted middleware. The Node runtime owns `/api/local/v1`, pairing, repositories, long-lived jobs and streaming events. Do not start the hosted Next.js server with a flag that disables its authentication. Validate the static-export approach with a small build spike before extracting the entire UI.

One runtime per OS user/data root owns writes to SQLite and the scheduler. Multiple host-agent MCP clients connect to its private IPC socket through thin stdio bridges. Use user-only Unix socket permissions or a Windows named pipe with the user's ACL, plus an explicit installation credential. Do not expose unauthenticated internal IPC. Lock the data root so a second daemon attaches or reports the existing instance rather than spawning competing schedulers. Connectors are managed child processes with per-integration working directories and minimal environment allowlists. stdout used for protocols must contain protocol data only.

The hosted site remains deployed separately. It does not connect back to the student's laptop automatically. F28 adds an optional phone-to-local companion after the M3 durable agent workflow; full voice/selected sync remain F23/M6. Remote access is not a dependency of Local Student Core. Default setup keeps the local app on loopback with no tunnel or public MCP listener.

## Component responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| UI | Today, library, tasks, workspace, profile, connections, runs and review screens | Raw credentials, direct connector tokens, external action execution |
| Core domain | Typed records, change detection, deterministic ranking/scheduling, idempotency and validation | Browser clicks, provider login, model authorization |
| Runtime | Lifecycle, pairing, source grants, policy evaluation, durable run journal, process locks | Unbounded shell access or hidden credential discovery |
| Storage | Transactions, revisions, source lineage, FTS, file hashes, deletion and backups | OAuth consent or guessing student facts |
| Agent adapter | Official session/turn lifecycle, normalized events, budgets, tool dispatch, cancellation | Secret harvesting, altered subscription login or silent paid fallback |
| Connector broker | Tool discovery, schema validation, account/source scope checks, reads and reviewed writes | Treating tool descriptions as permission or trusting webpage instructions |
| Workflow engine | Versioned recipes, checkpoint/resume, review queue, verification | Declaring success from a model's own statement |
| Evidence verifier | Assertions, hashes, read-back, source coverage and external confirmation | Expanding permissions to prove a result |
| Optional remote relay | Account/device binding, durable job envelopes, leases and bounded result delivery | Agent login credentials, university sessions, arbitrary shell commands or blanket local source grants |
| Adoption measurement | Public traffic aggregates, minimal setup funnel events and separately consented local receipts | Private source content, agent prompts, hidden offline telemetry or identities in anonymous analytics |

The agent chooses relevant capabilities from an explicit manifest and skill recipe. The runtime supplies only capabilities authorized for that run. A large system prompt cannot replace these checks. Simple deadline calculations, duplicate detection and revision checks run as deterministic code, not repeated model judgments.

## Data paths

**Course plan:** source grant → authenticated Avenue read → normalized course/source records → content extraction with provenance → indexed chunks → deterministic deadlines and workload → selected context sent to chosen agent → cited explanation and task proposals → student accepts → transaction saves tasks → UI reads them after restart.

**Internship draft:** verified posting → confirmed profile facts → eligibility checks → prepared answers and resume revision → application preview → student reviews unresolved fields and exact target → authorized browser/API action → external read-back/confirmation → evidence saved. Without confirmed submission evidence, retain `prepared`, `awaiting_student` or `unknown_outcome` status.

**Onboarding:** reviewed source scope → bounded metadata inventory → student chooses content groups → local extraction → optional approved cloud-agent processing → proposed profile facts/workflows → review → confirmed reusable profile. Broader discovery is supported through explicit folder and collection grants; it is not an unrestricted full-disk crawl. [Onboarding](ONBOARDING.md) specifies this flow.

**Phone request (planned F28):** authenticated phone website → selected paired computer/workspace → expiring job in the hosted relay → outbound laptop poll and atomic lease → local authorization and source-grant validation → official local agent adapter → review/evidence → bounded result events and selected artifacts → phone read-back. The local runtime remains the sole workspace writer. The relay does not turn a Supabase login or a phone prompt into local content permission.

**Adoption (planned F29):** public setup page → successful Copy setup prompt or manual-copy outcome → anonymous first-party event → optional verified sign-in → optional explicit local-installation link and activation receipt. Report website traffic, successful copies, registered/active accounts and opt-in installations separately; none proves the exact number of humans using all offline installations.

## Planned remote companion and measurement boundaries

Detailed behavior, staged implementation and objective cases are in [F28/F29](FEATURES_REMOTE_AND_ADOPTION.md). These are added plans, with no remote daemon or analytics deployment in this update.

For remote execution, reuse the existing Next.js/Supabase hosted infrastructure as a control plane. Keep jobs, device ownership, short-lived claims and result/event cursors in authenticated tables with row-level isolation and atomic lease operations. The laptop makes outbound HTTPS requests with bounded polling/backoff; serverless request handlers never wait for an agent turn or maintain a permanent laptop WebSocket. A later dedicated transport service can reduce latency if measurements justify it. Cancellation, leases and reconciliation map into F27 run states rather than creating a second execution engine.

Register a device only after account authentication and human confirmation in the paired local UI. Device credentials are a separate scoped principal, stored through a verified local secure store; they never substitute for browser pairing cookies, admin IPC secrets or Codex/Claude auth. Revocation blocks future authorized dispatch/delivery, invalidates leases and asks running work to stop at safe checkpoints. Locally governed result delivery requires a fresh exact-result policy receipt; without an online authorizer the relay withholds that content. This is not an instant cross-network recall of transmitted text; offline selected sync has a separate F23 gate. A lost response or laptop sleep yields waiting/interrupted/unknown state, not completed work or automatic re-execution. Remote task acceptance needs its own authenticated human receipt and exact payload binding; a model cannot create that receipt.

The initial relay uses TLS and a disclosed trusted-backend processing model. Prompts and returned excerpts can be visible to the hosted service, so a separate relay-processing grant is required before the phone sends a prompt for enqueue/storage, in addition to local source selection and model destination consent. Recheck that grant before local work, result upload and delivery; an expired grant prompts for renewal before new content is transmitted. Keep content retention short, route artifacts through authenticated access and keep staff analytics separate from task content. TLS is not end-to-end encryption. End-to-end protection is a later reviewed cryptographic design with key recovery/revocation tests; do not invent an encryption protocol or claim server-blind content now.

The Codex adapter should use local stdio app-server or a permitted SDK entry point and normal account/host approvals. Current [official app-server documentation](https://learn.chatgpt.com/docs/app-server) supports custom-client events and approvals but marks its WebSocket transport experimental/unsupported; never expose that listener publicly. [Official Remote](https://learn.chatgpt.com/docs/remote-connections) and [Claude Remote Control](https://code.claude.com/docs/en/remote-control) are useful native alternatives but do not establish a public transport API for LearnBridge's website. A third-party Claude embedded path remains gated on supported SDK/auth usage. The optional [ChatGPT plan-usage flow](https://developers.openai.com/siwc/token-sharing-open-source) authorizes inference under current preview limits; it does not itself control a student's existing computer. Recheck these contracts and complete an actual supported-host turn before release. This relay design is a LearnBridge engineering proposal, not a provider capability already integrated.

For measurement, start with an optional Vercel traffic aggregate integration for public pages and a bounded first-party setup-event collector backed by existing Supabase. [Vercel custom events](https://vercel.com/docs/analytics/custom-events) currently require Pro/Enterprise; the first-party collector keeps Copy setup prompt measurements independent of that paid feature. Recheck account limits and approve concrete dependencies/service changes before enabling either. Normalize paths to an allowlist, strip query/fragment/referrer identifiers and exclude private routes. Vercel's [privacy documentation](https://vercel.com/docs/analytics/privacy-policy) describes aggregate visitor measurement; visitor estimates are not a verified people register.

Known-user identity comes only from verified Supabase account records and provider-permitted profile fields. Names/emails stay in an access-controlled account/support view, never anonymous event properties, public counters or CSV downloads available to students. Sign-in is optional for reading/copying setup instructions; linking an installation and local usage reporting are separate explicit choices. Local telemetry is off by default; declining it preserves all local functionality. Setup prompts contain no hidden reporting instruction. Admin access is an audited server-side role check, not a client flag or email query parameter.

## Storage and source provenance

Use SQLite with transactions and full-text search, and managed attachment directories. Select the SQLite driver in an M1 spike against supported Node and OS versions; native installation, backup APIs, transaction semantics and maintenance must pass before adding a production dependency. Do not assume an experimental runtime API is stable merely because it exists. Prefer a small supported driver over a server database for the local core.

Default private data roots:

| Platform | Root |
| --- | --- |
| macOS | `~/Library/Application Support/LearnBridge` |
| Windows | `%LOCALAPPDATA%\LearnBridge` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/learnbridge` |

Choose roots through OS APIs/configuration, not shell interpolation. Check restrictive ownership/ACLs. Store the database, managed original imports, parsed chunks, documents, export artifacts, job checkpoints and sanitized evidence outside Git. Browser profiles and connector state live in separate private subdirectories; credential references live in SQLite, actual secrets in the OS credential store or a documented connector-managed store. If secure storage is unavailable, show a capability failure or explicit ephemeral mode, not a silent plaintext fallback.

Every imported object has account/source identity, canonical external ID, URL/path reference, retrieval time, source version/hash, permissions, parser version and coverage status. A source deletion, exclusion or grant revocation invalidates its indexed context and derived facts before the next read. Raw imports and outputs have independent retention controls. SQLite files are not automatically encrypted; disk encryption and private filesystem permissions are the initial protection, with application encryption an optional measured follow-up.

FTS is the first retrieval layer. Require query scope, result count, source citations and freshness. Add embeddings only after fixture benchmarks show a gap; any external embedding provider requires the same processing grant as inference. Preserve page/slide/line ranges so students can inspect the actual evidence. Do not claim semantic understanding from an index hit.

Back up with a transactionally consistent database snapshot and attachment manifest; never copy a live WAL database piecemeal. Restore into a fresh root, verify hashes and migrations, and keep the previous root until success. Grant revocation and profile deletion must also remove derivatives from FTS, caches and future context packs. Old backups cannot be silently described as erased: list retained backups and require deletion or documented expiry. Physical byte erasure on SSDs is not guaranteed; make logical removal and backup handling explicit.

## Identity and local access

The local installation has a random student/installation ID; it is not a Supabase user impersonation. Multiple human users sharing one OS account are not isolated by filesystem permissions. Either use separate OS accounts/data roots or explicitly supported profiles with separate credentials; do not advertise multi-user isolation until tested.

All private browser reads and writes require a paired session. Bind only to loopback, validate Host, enforce exact allowed Origin when present, reject cross-origin state changes and private reads, set HttpOnly/SameSite cookie attributes appropriate to loopback, limit request sizes and use a CSP. Same-origin browser GET/HEAD requests can omit Origin: accept them only with a valid paired session and the documented Fetch Metadata/session-bound request-nonce checks, not simply because Origin is absent. Mutations require the same session plus CSRF/Origin checks. Legacy clients without Fetch Metadata must use the session-bound nonce; authenticated CLI/IPC uses its distinct principal. Event-stream transport must also support these checks. Health endpoints expose only non-sensitive status.

A first-run student pairs using a short-lived, single-use code displayed by the local launcher, not a permanent bearer token in a URL, log or localStorage. Rate-limit attempts, expire codes and rotate sessions on logout. Local HTTP has different cookie transport constraints from hosted HTTPS; test the actual supported browser behavior rather than assuming a Secure cookie works on every loopback configuration. Private endpoints must not permit permissive CORS. No missing-header path grants access by itself.

The source policy layer canonicalizes paths, rejects symlink escapes and traversal, validates MIME/content limits, blocks credential stores/dotfiles by default and checks every derived read against active grants. Use descriptor/handle-based no-follow opens and verify object identity to resist path-swap races; a realpath check followed by an ordinary open is insufficient. Block unsupported safe-read paths rather than claiming they are confined. Approved source content remains untrusted data. A prompt in an email or PDF cannot grant permissions or override runtime rules.

LearnBridge can enforce these rules for its own runtime, tools and connectors. It cannot intercept arbitrary shell, browser or host-plugin tools an agent already has. Agent packs must state that limitation and use host permission/sandbox controls. Run sensitive workflows through the bounded tools where possible; never claim that a review queue secures an unrestricted external agent.

## Agent and subscription modes

| Mode | Student experience | Target support and gate |
| --- | --- | --- |
| Codex workspace | Student uses official signed-in Codex; LearnBridge supplies stdio MCP and project skills | First path; tools must be discovered and one fixture workflow completed |
| Codex local dashboard | Official app-server driven through its supported protocol | M3; stream, approvals, interrupt, resume and a real authorized turn |
| ChatGPT plan authorization | Eligible student grants plan usage through the official supported app flow | Optional M3 adapter; entitlement verified by inference, never token scavenging |
| Claude workspace or official CLI | Official unmodified Claude Code plus LearnBridge MCP/instructions | First path; student's own login and permissions |
| Claude embedded API | Separate permitted API/SDK configuration | Optional; do not assume Claude subscription tokens can power a custom proxy |
| Bring your API key | Student explicitly selects usage-based mode | Optional costs visible; no automatic fallback from exhausted subscription |
| Local model | Optional tested tool-capable runtime | Later; hardware/quality matrix and no universal performance promise |

Codex documents project MCP configuration and app-server session/event integration. Use supported schemas from the pinned installed client, not old `codex mcp-server` patterns. [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [App-server](https://learn.chatgpt.com/docs/app-server), [SDK](https://learn.chatgpt.com/docs/codex-sdk).

Official ChatGPT plan usage has account and feature limits. It does not provide conversation or memory access. Its preview has different request/tool constraints, so it needs a dedicated adapter rather than reusing the current API handler unchanged. [Plan permissions](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

For Claude, ship MCP and skills for the official client first. Recheck permitted embedding/authentication before implementing other modes; do not collect Claude session cookies. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [MCP](https://code.claude.com/docs/en/mcp).

Normalize events into run, turn, tool, approval and artifact events; store provider-native session IDs privately for resume. A provider's model catalog or successful login is not proof of model entitlement. Discovery and diagnostics must not perform a billable inference without the student's selected mode and permission.

## Connector strategy

Prefer an existing authorized host connector for a workspace recipe, an official API/MCP for normalized local integration, then a browser adapter for UI-only gaps. A host plugin visible to Codex is not automatically available to LearnBridge's dashboard. In host mode, the agent imports bounded results through LearnBridge tools and records the host source; in embedded mode, explicitly configured connectors are necessary.

Students must not need the developer's accounts. Local basic setup needs no Supabase project. Third-party app access can use the student's authorized MCP/provider configuration, optional student-owned Composio configuration, or a separately supported LearnBridge hosted relay. A relay requires website login, per-student ownership checks, explicit data-processing consent and published limits. Never distribute a server-wide Composio key in the local app. Automatic discovery reports known host capabilities; it does not extract hidden OAuth tokens from host stores.

| Integration | Feasible starting point | Constraint and fallback |
| --- | --- | --- |
| Avenue/D2L | Pinned local stdio academic adapter; own browser session | McMaster first; user SSO/MFA, expiry, API/institution differences; manual imports if unsupported |
| Google/Microsoft/Notion/GitHub/Linear | Host connector or explicitly configured provider MCP/API | OAuth/admin permissions, app verification, missing write scopes; selected document/folder import fallback |
| Discord/Slack and other communities | Official authorized channel APIs/MCP | Membership and retention constraints; selected exports if content tools unavailable |
| Browser | Dedicated profile Playwright MCP; optional host Chrome tools | Site login, DOM changes, CAPTCHA and provider limits; student handoff |
| Documents | Local format processors plus official editing APIs | Optional compiler/renderer diagnostics, revision conflicts; editable local export fallback |
| Native computer | Per-OS supported host/adapter | Accessibility/screen permissions and supported apps; browser/file workflow first |

For Avenue, adapt the academic read surface rather than run the upstream server unchanged. Its eager optional imports, broad HTTP mode and arbitrary path tools need correction, and redistribution notices need verification. Keep reviewed external pinned code separate until licensing is resolved. [Audit source](https://github.com/alanxue1/avenue-mcp/tree/9f996323641aba91cc0bbf2b21efd429f9a465e1).

Reuse the official-board discovery and evidence patterns from `please-hire-me`, retaining its MIT notice. Replace its permission-bypass/unattended submission launcher. [Audited revision](https://github.com/alecswang/please-hire-me/tree/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae), [License](https://github.com/alecswang/please-hire-me/blob/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae/LICENSE).

## Actions and recovery

Separate a proposal from execution. Exact target, provider account, payload, attachments, source revisions and idempotency key form an action fingerprint. Review records bind to that fingerprint. Changing an answer, document, recipient or attachment invalidates approval. The model cannot approve its own action through a tool.

Local reversible operations can use a bounded student policy; consequential external actions use the review screen or explicit current-session authorization under host rules. Before execution, validate grants and current source state again. External success requires read-back or an authoritative receipt. If a network timeout leaves outcome unknown, inspect the provider before retrying. Exactly-once external behavior is not guaranteed by a local transaction; use provider idempotency where available, otherwise reconcile and ask the student when ambiguity remains.

Run one foreground orchestrator initially, with specialized recipes rather than a swarm of persistent agents. Workflows have a budget, timeout, required capabilities, checkpoint, cancellation token and verification step. Offline/rate-limit failures persist progress and show a useful next action. Local schedules run only when the machine and runtime are awake; missed-run handling is explicit. Always-on hosting is optional and cannot inherit the laptop's browser session.

## Engineering decisions and alternatives

| Decision | Recommendation and reason | Alternative and deciding factor |
| --- | --- | --- |
| Distribution | Repository and local browser dashboard first | Desktop installer after clean setup succeeds on supported OSes |
| State | SQLite and managed files | Supabase optional sync when multi-device collaboration is needed |
| Retrieval | FTS with provenance | Embeddings after measured recall failures |
| Agent | Existing official host plus narrow MCP | Embedded provider after auth/events/approval gates |
| Browser | Structured APIs then dedicated-profile adapter | Existing-tab host integration only with explicit site/session grants |
| Workflow | Persistent single orchestrator | Parallel read-only workers after lock/budget tests; never concurrent writers to one browser profile |
| Connector reuse | Pinned adapter with a license manifest | Vendoring after notices/security review; independent implementation when source rights are unclear |

Do not start by building every life feature. M1–M3 establish setup, a trustworthy profile, source evidence and one useful course workflow. These foundations make the later features reusable and objectively testable.
