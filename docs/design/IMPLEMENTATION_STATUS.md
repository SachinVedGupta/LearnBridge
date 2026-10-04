# LearnBridge implementation status

Updated October 4, 2026. The local edition now contains a usable student workspace, selected-source MCP tools, persistent review and planning records, and several complete local workflows. The hosted edition remains separate. This page distinguishes working deterministic features from live model, provider and platform gates; it does not mark the entire 29-feature design complete.

## What works in the local dashboard

| Area | Current behavior | Evidence and limits |
| --- | --- | --- |
| Private workspace | Tasks, notes, immutable revisions, search, import journals, paired browser access, backups and fresh-root restore | Actual SQLite, HTTP, process, recovery and browser checks. Schema 5 stores workflow runs, leases, action receipts, versioned workspace records and immutable PDF/Office evidence. Physical selective erasure and attachments remain pending. |
| Selected sources | Metadata-only review of explicitly selected folders, then selected text/Markdown, macOS PDF and bounded DOCX/PPTX imports | Fixed project Python worker, no-follow directory/file checks, byte/time budgets, cancellation and late-result rejection. PDF physical-page and Office paragraph/presentation-order-slide citations, separate original/text hashes, partial/unavailable states and atomic storage. Office extraction is always partial; visual layout and recorded omissions require original review. No automatic laptop, cloud or agent-memory scan. |
| Guided onboarding | Get started with explicit purpose/category/record choices, metadata coverage checks, next steps and exact reviewed local reports | Existing local records only, unchecked defaults, current-pin/hash revalidation, stale-report flags, retry/forget/cap/restart/restore checks. No automatic discovery, new sharing permission or actual host authentication/model test. [Implemented contract](implementation/GUIDED_ONBOARDING.md) and [dated verification](implementation/GUIDED_ONBOARDING_VERIFICATION.json): 39 onboarding cases, browser/restart/restore proof. |
| Agent bridge | Four stdio MCP tools: status, approved context, pending task proposals and pending writing proposals | Actual SDK transport and adversarial fixtures. A historical real Codex turn verified the original three tools. The fourth tool has fixture proof; a live writing-proposal turn remains pending. Claude is not installed here. |
| Agent setup | Project-only Codex/Claude configuration preview and guarded merge, plus a reusable student workflow skill | Stale configuration/collision/privacy checks. Official host account and trust approvals remain with the student. No subscription credential copying or paid API fallback. |
| Profile | Candidate, confirmed, corrected, conflicting and stale facts, with purpose-specific context and source evidence | Persistent revision and selected-evidence fixtures. Confirmation belongs to the human; source activity does not establish mastery or a complete profile. |
| Course library | Reviewed export comparisons, immutable current/history versions, semantic deduplication, exact citations and uncertain deadline handling | 41 new domain/storage/paired-HTTP tests; actual rollback after SQL errors and SIGKILL, competing-review CAS, metadata-first history, current-only retrieval, forgetting/reactivation and exact restart/restore. Browser deadline/missing/dedup/history flow verified. Dates and coverage remain source-reported; no live Brightspace entitlement is implied. |
| Today and study plans | Explainable task ordering, capacity and dependencies, timezones/DST, saved plan previews and review | Deterministic scheduling and stale-plan checks; actual browser plan acceptance. Planning does not silently create calendar events. |
| Learning | Source-cited tutor recipes, actual student attempts, catch-up plans, reviewed feedback and checkpoints | Actual browser save and review. Recipes prepare context/instructions; they are not generated tutor answers. Attempts and self-reports are not inferred mastery. |
| Writing | Source-pinned outline/feedback drafts, exact human review, saved private alternatives and Markdown export preparation | Originals/history preserved, stale-source and graded-work guards, actual browser acceptance/readback. Markdown bytes/hash verified; a browser file-download event was not verified in the current run. Rich Office/PDF conversion remains pending. |
| Research | Selected-note or manually supplied official excerpt capture, exact citations, questions/conflicts, reviewed report-to-note export | Actual browser capture/report/export and persistent readback. No implicit web fetch or factual-truth certification. |
| Career | Selected job excerpts, confirmed experience, reviewed drafts, practice attempts and local follow-up tasks | Fixtures and browser draft/practice checks. No live employer compatibility, resume upload, application submission or automatic role-freshness claim. |
| Daily life | Unit-compatible pantry/recipe quantities, reviewed meal plans, separate-currency integer-cent expenses and manual routine tasks | Browser grocery calculation, expense total and routine task. No medical advice, currency conversion, purchases or background automation. |
| Updates and projects | Selected manual updates, honest briefing coverage, literal task suggestions, ordered checklists, selected resources and goals | Actual browser briefing, task acceptance and prerequisite behavior. Missing owners/dates stay unknown. Schedules are paused/manual; no unattended connected-app writes. |
| Durable workflows | Persistent run/checkpoint journal, lease epochs, budgets, exact action review, effect receipts and uncertain-outcome recovery | SQLite restart/adversarial fixtures. A durable journal is not a general-purpose executing agent or proof of external effects. |

The dashboard lazily loads its workflow screens, clears session state on disconnect, and refreshes task/note selections when returning to Today or agent review. Desktop and 390px browser checks used only disposable synthetic records.

## Optional components prepared, with release gates

| Component | Implemented foundation | Not enabled or not proved |
| --- | --- | --- |
| Embedded Codex host | Fixed one-shot invocation, strict event parser, durable browser-owned turn records, cancel/logout/source-change barriers and no automatic replay | Disabled by default. Actual pinned-host attempts did not complete a safe selected-context turn. The app-server configuration check found seven inherited MCP servers and inherited hooks/plugins despite a selected-server override; an empty diagnostic profile inherited none. A separate official student login and verified isolated profile are still required. Do not claim embedded chat or native resume works. External project MCP remains available. |
| D2L/Avenue | Reviewed export import and independent allowlisted MCP read adapter | Managed institution profiles, sanitized authenticated transport, session vault and an actual authorized student SSO/MFA/read remain pending. University credentials are not accepted by the website. |
| Public setup | Public `/setup` route, full versioned setup prompt, copy success after the browser Clipboard promise and manual selection fallback | Deployed publicly at [thelearnbridge.vercel.app/setup](https://thelearnbridge.vercel.app/setup), with a [commit-bound deployment receipt](implementation/PUBLIC_SETUP_DEPLOYMENT.json). Public setup/login and private-page sign-in redirects were checked; no live student/provider workflow is implied. Rendered prompt and success/fallback states were browser-checked; exact OS clipboard bytes were not verified. Copying is not installation. |
| Adoption measurement | Strict anonymous observations, separate authenticated reporting/directory choices, guarded APIs, bounded database RPC design and successful-save hooks | Flag defaults off. Disposable PostgreSQL SQL/RLS/retention fixtures passed. Production migration, live Supabase/session/concurrency, scheduled retention, admin provisioning and actual collection remain unverified. No historical user counts or local telemetry enrollment are produced. Anonymous observations are not unique people. |
| Phone companion | Owner/session-bound request envelopes, unapplied relay migration, disabled APIs and outbound-only local preparation library | Off by default. No public listener or hosted native agent. No source/result text delivery, model invocation or phone round trip. Disposable SQL/RPC isolation and hash checks passed; live Supabase/session/concurrency, mobile and host gates remain pending. |

See [host adapter boundaries](implementation/CODEX_APP_SERVER_SPIKE.md), [adoption implementation and release checks](implementation/ADOPTION_METRICS.md), [remote/adoption feature design](FEATURES_REMOTE_AND_ADOPTION.md), and the [execution ledger](implementation/FULL_BUILD_PLAN.md).

## Current verification and reproduction

The latest [guided onboarding receipt](implementation/GUIDED_ONBOARDING_VERIFICATION.json) records **571/571 automated passes**, including 20 service/storage, 12 paired HTTP and seven UI timing regressions. A clean locked offline-cache installation passed nine phases with 69 allowlisted files, ten dashboard assets and four MCP tools. Actual browser setup/report/stale-profile flows, desktop/mobile layout and independent readback/reopen/fresh restore of browser-created records passed. The hosted build also passes; no provider configuration or deployment changed. Earlier reports below retain their original snapshots/counts.

The earlier [academic refresh verification](implementation/ACADEMIC_REFRESH_VERIFICATION.json) records **532/532 automated passes**, a clean locked offline-cache installation with 66 allowlisted files and four MCP tools, and exact restore of browser-created course versions/receipts/manual work. Read its [implementation contract](implementation/ACADEMIC_REFRESH.md) for effective limits and live gates. The prior full-build snapshot is [Full workspace verification](implementation/FULL_WORKSPACE_VERIFICATION.json); [selected Office verification](implementation/SELECTED_OFFICE_VERIFICATION.json) records the earlier additive schema/import slice. Historical reports retain their original source snapshots and counts: [foundation](implementation/LOCAL_FOUNDATION_VERIFICATION.json), [agent/source slice](implementation/AGENT_SOURCE_VERIFICATION.json), [real external Codex host](implementation/CODEX_HOST_VERIFICATION.json), and [shared core](implementation/W01_VERIFICATION.json). Design validation separately covers 29 specifications, 182 planned acceptance cases and 24 work packages; those counts are not implementation passes.

The full automated suite exercises deterministic core, local storage/runtime/source/workflow and hosted boundaries. A clean disposable source copy installs locked dependencies from the offline cache, verifies process persistence and backup/restore, and discovers four tools through the actual MCP SDK transport. This proves the exercised installation on this Mac, not fresh-computer online installation or every platform. Legacy Python syntax, Streamlit health, its authentication gate, invalid callback and missing-config behavior were checked without provider calls.

```sh
npm run setup
npm run test:core
npm run test:local
npm run local:build
node web/scripts/verify-local-install.mjs
npm test
npm run build
node docs/design/validate-design.mjs
```

Node 22.16+ is required. Node 22.23.2, Python 3.12.14 and macOS arm64 were exercised. Selected-file imports require the project `.venv` and native filesystem primitives checked by doctor. Linux remains experimental; Windows is rejected until native privacy/control support exists. The normal project-host integration can be independently checked with `node web/scripts/verify-codex-host.mjs` using synthetic sources and the student's official signed-in Codex host. It is an opt-in live check, outside the deterministic suite.

## Student setup and privacy

Give a coding agent [SETUP_LEARNBRIDGE.md](../../SETUP_LEARNBRIDGE.md) and the [student skill](../../.agents/skills/learnbridge-student/SKILL.md). Follow [local setup/recovery](../LOCAL_SETUP.md), [agent/source setup](../LOCAL_AGENT_SETUP.md) and [workspace instructions](../../agents/WORKSPACE.md). Start with sample records, verify persistence, then open **Get started** for explicit metadata checks and next steps to narrow sources and reviewed profile facts. A saved coverage report does not connect a host or grant sharing. Sharing imported content with a model is a separate, expiring, destination-bound choice.

Deleting a record removes it from active views; history and backups can retain copies. Revocation stops future reads but cannot recall content already sent to a host or text deliberately exported to a new note. Uninstall retains the workspace and repository. Pairing does not sign in to providers or expose the laptop to the public website. No personal discovery, telemetry, remote pairing or university login runs as a setup side effect.

## Next implementation gates

1. Finish a genuinely isolated, actual selected-context Codex turn before enabling embedded chat; independently test an installed Claude host.
2. Add managed institution/session transport and verify one student-authorized, selected-course Brightspace read with expiry and no writes.
3. Extend the implemented metadata-only Get started guide with explicit cloud account/collection selectors only after provider-specific scope, provenance, pagination, retention and revoke tests. Broader profile synthesis and automatic discovery remain unavailable; new extraction/model processing need their own student review and evidence.
4. Add real browser/document adapters and rich artifact generation behind exact reviews and meaningful fixture/readback checks.
5. Build on passed disposable adoption/relay SQL and RLS checks; verify live Supabase sessions/concurrency, scheduled deletion and real opted-in browser/mobile gates before any release flag is enabled.
6. Evaluate tutoring usefulness with students; complete native voice/capture/sync and each additional platform only after its specific permission and recovery proof.

A project license remains an owner decision before a distributable open-source release. No Avenue, browser-use or internship project's source has been vendored. Existing hosted authentication/provider behavior is not re-certified by local fixtures, and this work has not deployed new provider configuration.
