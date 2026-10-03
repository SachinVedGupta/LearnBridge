# LearnBridge implementation status

Updated October 2, 2026. This page records actual implementation separately from the feature catalogue. The private local foundation now has tasks, notes, SQLite storage, a paired loopback dashboard and control commands. The hosted application's authentication/provider code remains separate. This work does not deploy a release, change cloud settings, discover personal sources or connect an agent/provider account.

## Implemented foundation and boundaries

| Work | Current implementation | Verification boundary |
| --- | --- | --- |
| W01 shared core | Versioned data contracts, identity/destination shapes, adapter ports, immutable document revisions and run/checkpoint rules | Pure contract fixtures; a run schema is not an executing agent |
| W01 hosted-task migration | Pure import planner with exact backup, owner-bound IDs, duplicate/completion preservation and review mappings | Synthetic exports; W03 now persists eligible reviewed snapshots transactionally |
| W01 temporary demo | Synthetic task/document JSON persistence with fresh-process read-back and content hashing | Contract demonstration, separate from the real SQLite/dashboard foundation |
| W02 SQLite feasibility and driver | Historical 14-case built-in-driver probe, then pinned better-sqlite3 13.0.3 used by local storage | Exact installed-driver evidence is in the foundation report; the original experimental probe alone is not production proof |
| W02 static distribution | Dependency-free dashboard builds to exactly HTML, CSS and JavaScript; served by its own loopback runtime | Static build/served-asset checks; no hosted bundle, cloud key or external asset needed |
| W03 initial private storage | Persistent installation identity; manual tasks, notes, immutable revisions/hashes, note search, expected-revision writes, create idempotency, schema/integrity checks, writer ownership, hosted-import journal, online backup/fresh restore | Actual SQLite synthetic fixtures and process/recovery checks; macOS arm64 target only. Grants, runs, external credential vaults, attachments and selective physical purge are not implemented |
| W04 initial local boundary | Loopback-only binding; single-use pairing; in-memory browser sessions, nonce/origin/host checks; private same-user Unix control channel for status/stop/backup | Executable adversarial fixtures. Same-OS-user programs remain trusted; this is not encryption, sandboxing or a workflow approval system |
| W05 dashboard and local commands | Today/manual task CRUD; multiple plain-text notes with conflict-preserved edits and saved-content read-back; actual capability display; setup/start/doctor/stop/demo/backup/restore/uninstall | Static/runtime fixtures and explicitly recorded browser checks. Profile, sources and agents are shown as unavailable |
| Hosted regression | Existing hosted auth/provider tests remain; local-identity claims do not substitute for verified Supabase users | Handler/provider fixtures and website build; no new live two-student/provider test or production deployment |
| W06–W07 official-agent bridge and complete setup | Not implemented | MCP discovery, project-scoped agent configuration, subscription-backed synthetic workflow, environment isolation and fresh-platform installation gates remain |

Read [local setup and recovery](../LOCAL_SETUP.md), the [core package](../../web/packages/core/README.md), [storage package](../../web/packages/local-storage/README.md) and [dashboard package](../../web/apps/local/README.md) for actual commands and APIs. The [foundation verification report](implementation/LOCAL_FOUNDATION_VERIFICATION.json) records the measured checks, exact runtime/driver and remaining gates. [W01 evidence](implementation/W01_VERIFICATION.json), [historical SQLite probe](spikes/sqlite-probe-report.json) and [driver feasibility notes](spikes/SQLITE_FEASIBILITY.md) cover earlier work.

The local edition requires Node 22.16 or newer. macOS arm64 is the verified foundation target. Linux is experimental and still requires its own release run; Windows is rejected until native private ACL/control support exists. The report must be checked for the actual scope of browser and fresh-install evidence. Passing fixtures does not complete all 160 planned feature acceptance cases or establish compatibility with every student machine.

The final foundation run passed **111 tests**, including **55 local storage/HTTP/process/IPC tests**, and the existing hosted production build. The isolated clean-copy verifier passed all **8 phases**, installing locked packages from the existing offline cache without environment files/cloud keys. Actual browser checks covered task/note edits, two-tab conflicts, cancellation/reload, session refresh, restart, logout and a 390px layout. Exact browser-created records and four note revisions were independently read in a new process after stopping the runtime. Source hashes, outcomes and limitations are in the report above.

## What a student can do now

Install the locked workspace, initialize a private data root, start the local runtime and pair their browser. They can create/edit/complete tasks and create/edit notes, restart and read the same saved records, back up a workspace and restore into a fresh selected root. No Supabase, Composio or model API key is required. The fixture demo uses a disposable synthetic root instead of student content.

Deletion hides active records and removes deleted notes from search, while immutable text history, deleted metadata and backups can retain content. Uninstall stops the runtime and retains data, repository files and packages. One browser profile can pair with only one active loopback workspace at a time; use separate profiles for concurrent workspaces.

## Next work, in order

1. **Build the official-agent MCP bridge.** Review/pin the current official SDK dependencies under the repository dependency rules. Expose bounded LearnBridge tools to the student's selected official Codex/Claude host, preserve project settings and verify discovery plus a completed synthetic task/note workflow. Do not fall back to a paid API or bypass host permissions when a subscription is unavailable.
2. **Complete setup and platform gates.** Verify clean installation, launch/pair/restart, backups and cleanup on each claimed OS/runtime. Add reviewed project-scoped agent configuration with a reversible merge, doctor diagnostics for actual agent capabilities and an allowlisted child environment. Windows needs a separate native privacy/control design before support is claimed.
3. **Add grants, reviewed profile and source onboarding.** Start with selected local fixture roots and deterministic inventory/extraction. Add purpose/destination-specific processing grants, review receipts, revoke/retention behavior and lineage before any real laptop/cloud discovery. Agent-host tool results are remote processing when sent to a cloud-backed host.
4. **Add one useful academic workflow.** Build cited planning/tutoring against reviewed sources and persisted run evidence. Validate Avenue or institution-specific imports as separate capabilities; a desktop login is not proof of universal D2L access.
5. **Expand with explicit recovery and action review.** Implement durable runs, approval-bound external actions, browser/document adapters and career workflows following their feature acceptance tests. A manual task dashboard is not yet the full student-life automation system.

LearnBridge's owner still needs to choose a project license before a distributable open-source release. This does not prevent internal foundation implementation. No Avenue, browser-use or internship project's source code has been vendored by this slice.

## Reproduce checks

```sh
npm run setup
npm run test:core
npm run demo:core
npm run test:local
npm run local:build
node web/scripts/verify-local-install.mjs
npm run local:demo
npm test
npm run build
node docs/design/validate-design.mjs
```

The interactive demo stays in the foreground until stopped; it is not a self-completing test. Use [the setup guide's checklist](../LOCAL_SETUP.md#agent-verification-checklist) to independently verify browser and persistent-fixture behavior. The design validator checks specification consistency only. Full feature, live provider, supported-platform and human-quality gates remain in [Verification](VERIFICATION.md).
