# LearnBridge implementation status

Updated October 3, 2026. The private local edition now has tasks, notes, paired browser access, controlled text imports, a Codex/Claude MCP bridge and human-reviewed agent task proposals. The first W06–W09 slice is implemented; live institution login, complete profile onboarding and general automation remain future work. The hosted application's authentication/provider code remains separate.

## Implemented capabilities and boundaries

| Work | Current implementation | Verification boundary |
| --- | --- | --- |
| W01 shared core | Versioned contracts, identity/destination shapes, adapter ports, immutable document revisions and run/checkpoint rules | Pure fixtures; run contracts are not an executing orchestration engine |
| W01 hosted-task migration | Exact backup, owner-bound IDs, duplicate/completion preservation and review mappings; reviewed eligible snapshots persist transactionally | Synthetic exports; no live student data migration |
| W02 storage driver and distribution | Pinned better-sqlite3 13.0.3; dependency-free static dashboard served by the loopback runtime | Actual installed driver, static hashes and clean-copy installation; macOS arm64 verified |
| W03 private storage | Persistent installation identity; tasks, notes, immutable text/revisions/hashes, conflict checks, idempotency, import journal, backup/fresh restore | Actual SQLite/process/recovery checks; schema 2 also persists sources, grants, budgets and proposals. Credential vaults, attachments, durable runs and selective physical purge remain pending |
| W04 local boundary | Loopback-only service, single-use pairing, browser sessions and nonce/origin/host checks; private Unix control IPC | Actual HTTP/process adversarial fixtures; programs with full same-OS-user access remain outside the sandbox claim |
| W05 dashboard | Tasks/notes; selected-folder review/import; destination-specific context sharing; exact task proposal accept/reject; capability diagnostics | Browser cancellation, acceptance, revocation, snapshot read-back, fresh-process backup/restore, desktop and 390px layout checks |
| W06 initial agent bridge | Official SDK stdio server with status, bounded approved context and pending task proposal tools; separate destination-bound IPC credentials | Actual SDK transport plus real Codex CLI calls; no grant/approval/shell/external-write tools |
| W07 initial host setup | Project-only Codex/Claude preview and expected-hash merge; unrelated settings preserved, sensitive merge content not printed; isolated child environment | Config collision/stale input/privacy fixtures; real Codex CLI 0.154.0 verified. Live Claude remains unverified because it is not installed here |
| W08 initial source onboarding | Explicit selected roots; metadata-only inventory; selected text/Markdown acquisition; immutable content/version/hash; separate agent-sharing grant | Actual fixed Python worker, directory-FD/no-follow checks, file/root swaps, budgets and late logout/expiry/revocation/cancellation discard. Full laptop/cloud onboarding and profile synthesis remain pending |
| W09 initial academic import | Reviewed selected-course exports, raw uncertain deadlines, saved snapshot notes; independent allowlisted MCP read adapter | Normalizer fixtures and real SDK synthetic transport. Live institution profiles, SSO/MFA, sanitized transport and session vault are not implemented |
| Hosted regression | Existing hosted tests and build still pass | Fixtures/build only; this slice did not deploy or re-test live two-student/provider accounts |

Read [local setup/recovery](../LOCAL_SETUP.md), [agent/source setup](../LOCAL_AGENT_SETUP.md), [core](../../web/packages/core/README.md), [storage](../../web/packages/local-storage/README.md), [source acquisition](../../web/packages/local-sources/README.md) and [academic adapter](../../web/packages/local-academic/README.md) for commands and implementation boundaries.

The [agent/source verification record](implementation/AGENT_SOURCE_VERIFICATION.json) records the current measured checks, source hashes, browser proof and limitations. [Real Codex host evidence](implementation/CODEX_HOST_VERIFICATION.json) records three completed MCP calls and exactly-once human task acceptance. The [phase plan](implementation/AGENT_SOURCE_PHASE_PLAN.md) and [Avenue audit](implementation/AVENUE_ADAPTER_AUDIT.md) explain implementation choices. Earlier evidence remains in the [foundation report](implementation/LOCAL_FOUNDATION_VERIFICATION.json), [W01 report](implementation/W01_VERIFICATION.json), [historical SQLite probe](spikes/sqlite-probe-report.json) and [driver feasibility notes](spikes/SQLITE_FEASIBILITY.md).

## Measured verification

The current full suite passed **194/194 tests**, with no skips or failures; **138** cover the local storage/runtime/agent/source/academic paths. The existing hosted production build passes. A clean disposable source copy passed **9/9 phases**, installing locked dependencies from the offline cache without old node_modules, environment files or personal data, then verifying persistence, backup/restore and actual SDK stdio discovery. This is not a fresh-computer, online-download or fresh-Python installation proof.

A real installed Codex CLI used its normal ChatGPT-managed authentication and made status/context/proposal MCP calls against a disposable synthetic workspace. It read the exact approved note, excluded unrelated content, left zero tasks before human review and saved one task after acceptance/replay. The task survived restart. This is separate from SDK fixture transport and does not establish Claude or live university support.

Browser checks imported one selected synthetic lecture, cancelled sharing and acceptance, then granted context, accepted a proposal, saved a selected-course academic export and revoked future agent reads. Backup/restore read-back in a fresh process confirmed exact text hashes, three tasks, two notes, one source snapshot, a revoked grant and one accepted proposal. Sources and review screens fit a 390px viewport without horizontal document overflow. The historical foundation run separately recorded 111 tests, an eight-phase installation proof and its task/note browser checks.

Legacy Python syntax, Streamlit startup/health, the authentication gate, invalid callback and missing-config behavior were also checked without provider calls. See the current verification record for scope.

Node **22.16+** is required; Node **22.23.2**, Python **3.12.14** and macOS arm64 were exercised. Selected-file acquisition needs a suitable project `.venv` with the required native filesystem primitives; doctor reports unsupported environments explicitly. Linux remains experimental. Windows requires native private ACL/control work and is rejected. Passing this slice does not complete all 160 feature acceptance cases or establish compatibility with every student machine.

## What a student can do now

Install the locked workspace, initialize a private data root, start the runtime and pair their browser. Create/edit tasks and notes, restart, back up and restore into a fresh selected root. Select a narrow course/project folder, review names/sizes without reading bodies, then import specific text files. Select saved record versions for a time- and byte-bounded Codex or Claude grant, register the bridge in their project and review resulting task proposals. These local features require no Supabase, Composio or model API key; real model access belongs to the official agent host and account.

Academic exports can become reviewed notes with selected courses and honest deadline precision. A university login and a ready-made Brightspace connection are not supplied by this release. Pairing does not scan personal sources or automatically connect an AI. The fixture demo uses a disposable synthetic root.

Deleting a note removes it from active views and search, while history, deleted metadata and backups can retain content. Revocation prevents future agent reads but cannot retract context already sent to a host. Uninstall retains workspace data and repository files. One browser profile pairs with one active loopback workspace at a time; separate profiles are needed for simultaneous workspaces.

## Next work, in order

1. **One real local university connection.** Implement a reviewed institution profile, sanitized transport, supervised student SSO/MFA and session binding. Verify selected-course reads and expired/replaced-session denial against a real authorized session. Keep university credentials out of the website and agent outputs.
2. **Complete actual host/platform setup gates.** Verify an installed Claude host and each claimed OS/runtime with normal trust/approval, installation, restart and recovery. Add unsupported-platform support only after its native privacy/control proof.
3. **Broaden controlled sources and reviewed profile onboarding.** Add PDF/Office extraction, explicit cloud source selection, provenance, profile review, retention and revoke behavior before any wider discovery. Do not infer a complete student profile from a few notes.
4. **Cited academic planning with durable runs.** Build planning/tutoring against approved evidence, resumable checkpoints and verifiable results. Preserve learning and unknown deadlines; evaluate real student usefulness separately from deterministic fixtures.
5. **Reviewed browser/document and career actions.** Implement bounded adapters and exact human approvals for consequential writes/submission following their feature acceptance tests. General computer automation remains outside the current bridge.

The owner still needs to choose a project license before a distributable open-source release. No Avenue, browser-use or internship project's source has been vendored. The initial academic adapter is independently implemented.

## Reproduce checks

```sh
npm run setup
npm run test:core
npm run demo:core
npm run test:local
npm run local:build
node web/scripts/verify-local-install.mjs
npm test
npm run build
node docs/design/validate-design.mjs
```

For an installed, signed-in Codex CLI, the separate opt-in `node web/scripts/verify-codex-host.mjs` checks the actual host using synthetic content and normal permissions. It can be blocked by account access/limits; it is not part of the deterministic test suite. The interactive `npm run local:demo` stays in the foreground until stopped. Use [the agent/source checklist](../LOCAL_AGENT_SETUP.md#agent-verifiable-checks) and [foundation checklist](../LOCAL_SETUP.md#agent-verification-checklist) for independent browser and persistent-record checks. The design validator checks specification consistency only. Remaining feature/provider/platform/human-quality gates are in [Verification](VERIFICATION.md).
