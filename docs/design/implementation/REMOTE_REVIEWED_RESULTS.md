# Phone companion: reviewed text results

This implements the next bounded part of [F28](../FEATURES_REMOTE_AND_ADOPTION.md#f28--phone-to-local-agent-companion): a signed-in phone can queue a study question for its paired computer, and receive an exact response **after the student accepts the writing locally and separately approves its relay permission**. The HTTPS relay is trusted plaintext storage. This is not an unattended desktop agent, a public laptop listener, end-to-end encryption, or a way to proxy subscription credentials.

The [older status-only foundation](REMOTE_COMPANION_FOUNDATION.md) remains supported unchanged. This extension adds an optional local dashboard, injected native study executor, reviewed writing outbox, signed-in `/remote` page and narrow result APIs. All public release switches remain off. No migration, live device enrollment or retention scheduler was configured by this implementation. Passing the fixtures does not make phone access publicly available.

## Exact student flow

1. Sign into the hosted LearnBridge website on the phone and open `/remote`. Explicitly create a five-minute pairing challenge. Copy its JSON containing only `pending_id` and `challenge`.
2. Pair the private local LearnBridge dashboard normally. Save the desired source notes and create a current Codex sharing grant with those notes selected. No source is selected automatically.
3. Open **Phone companion**, paste the challenge, select that exact grant, and review the separate relay consent. The dashboard requests up to 30 minutes, three questions and 16 KiB per question. Source bodies stay local. The relay sees submitted phone prompts.
4. Optionally check native execution. This choice is refused unless the separate local Codex profile is currently available. The root runtime injects its restricted study executor; the result module never accepts arbitrary host commands, credentials or RPC method names.
5. Press **Start foreground polling**, or **Check phone messages** once. The phone submits an explicitly confirmed study prompt. The laptop prepares a source-cited context note. If native execution was separately authorized, it records one durable host turn and creates a pending writing proposal from a completed result.
6. Review the proposal in **Writing** and accept or reject its exact content. Model completion does not accept a document or send it to the phone. Existing academic-policy and source-version gates apply.
7. In **Phone companion**, select the phone request and accepted writing item. Preview the literal exact response, source/version pins, expiry and SHA-256. Approve this exact relay permission, then explicitly press **Send reviewed response**. Approval and transmission are distinct actions.
8. On the phone, choose **Read reviewed response**. A one-use delivery request waits for a fresh laptop check of the phone session, selected grant, job state and current accepted source/document versions. The laptop authorizes a ticket for at most 30 seconds. The phone consumes it once, verifies the text/policy hashes and renders literal text.
9. Pause, unpair or revoke when finished. Leaving the local page or hiding its browser document pauses future polling and clears its private preview; resuming requires an explicit Start. Already authorized native work may finish. Use Stop or Unpair to request cancellation. The phone clears its visible answer on hiding/navigation or consent expiry.

Native execution uses the same restricted local host controller as [Local AI](LOCAL_CODEX_EXECUTION.md). Embedded Claude execution, remote browser/computer control, phone task approval, background daemon execution and arbitrary app writes remain outside this result slice. A local context-preparation receipt alone is not an AI answer.

## Authority and data boundaries

| Boundary | Enforced contract |
| --- | --- |
| Hosted phone identity | Confirmed signed-in account and verified JWT account/session claims; new result SQL also checks the actual `auth.sessions` row, owner and `not_after`. A different fresh owner session can erase/recover its old bindings but cannot read their old results. |
| Local browser identity | Enrollment, private lists, polling, approval and upload belong to one paired-browser nonce and expiry. Fresh authorization is checked after asynchronous operations. An old pairing failure cannot stop a newer paired browser. |
| Installation | Separate private installation identity outside repository/workspace. Device bearer credential remains in process memory only. Setup, restart and backup restore never enroll or start polling. |
| Selected context | Existing exact Codex grant and note-version pins. Source receipts in accepted writing must be members of that selection. Source edits, grant revocation/expiry and changed accepted output withhold new uploads and deliveries. |
| Native host | Current verified profile plus explicit native consent; root supplies start/inspect/cancel functions. Durable dispatch has one idempotency key. Ambiguous native outcomes are never replayed automatically. |
| Result permission | Exact accepted/applied writing record revision/payload hash, document revision/SHA, source revisions/SHAs, grant/selection hash, binding/account/session/installation, job input hash, academic policy, review status, UTF-8 byte count and expiry. Canonical policy SHA is independently recomputed in JavaScript, PostgreSQL and browser verification. |
| Relay APIs | Fixed HTTPS LearnBridge origin, no redirects/cookie forwarding, bounded body/deadline. Narrow operation names; no supplied account authority, path, executable or generic host command. Device result preflight verifies the live bound phone session before private body acquisition and SQL rechecks afterward. |
| Storage access | Result/delivery tables use RLS with no anonymous/authenticated direct-table access. Only narrow credential- or verified-owner-bound RPCs can read or change them. Metadata lists contain no result body or policy. |
| Result delivery | New one-use ticket; laptop checks current local authorization before approving. Ready lifetime is at most 30 seconds and retries cannot extend it. Revocation prevents future reads; a response already delivered over the network cannot be recalled. |

The outbox retains exact reviewed text in the student's private SQLite workspace. Device tokens are excluded from that database and backups. Accepted writing, history, backups and official host/provider records remain separate copies. Revoking a relay result erases its active relay text/policy and denies pending tickets; it does not erase these independent copies. This is not a promise of instantaneous recall after an HTTP response has been authorized or delivered.

## Bounds and recovery

The protocol permits at most 48,000 UTF-8 bytes of result text, 128,000 bytes per upload envelope, 8,192 bytes of canonical policy, ten unique ordered source receipts, and 64 retained local outboxes. Result consent lasts at most one hour and cannot exceed its relay grant; the dashboard normally requests 15 minutes. Delivery challenges last at most 60 seconds; ready tickets last at most 30 seconds. SQL permits at most 1,000 retained result rows, 20 lifetime new delivery tickets per result, 200 retained tickets per account and 2,000 globally. Expired/consumed ticket purging does not reset the per-result lifetime budget. Exact pending-ticket retries do not consume a new slot.

| Situation | Recovery and objective meaning |
| --- | --- |
| Upload acknowledgement lost | Outbox becomes `unknown_upload`. A retry checks exact relay metadata first. Matching ID/hash/review/state reconciles the receipt without a second body upload; changed metadata conflicts. |
| Native dispatch acknowledgement lost | Durable checkpoint becomes `unknown_outcome`; no automatic redispatch. Inspect the actual host and Writing records locally. |
| Restart | No credentials, pairing or polling are restored. Re-pair explicitly; recover/revoke an old active relay binding first if required. |
| Backup restored to a new workspace | Accepted writing and reviewed outbox survive, but a distinct installation/workspace identity starts unpaired. An old outbox cannot be sent under a new binding. Review a new result under its current binding instead. |
| Phone cancels a running job | Foreground polling forwards cancellation to the root host controller. Late completion is withheld and cannot silently create accepted writing or upload it. A cancellation request is not a guaranteed rollback of completed work. |
| Sources/output change after sharing | The next local delivery check denies the request even if a relay body remains. Revoke the old result explicitly; accepted historical copies may remain locally. |
| Relay offline during revoke/unpair | Local authority stops. The UI distinguishes local stop from acknowledged relay erasure. Use signed-in **Recover all my pairings** when the website is reachable. |
| Old phone session expires/signs out | Result RPCs deny a missing/expired live session row. Fresh verified owner recovery can revoke its own bindings/challenges and erase active reviewed bodies without supplying the old token or reading them. Actual deployed Supabase logout semantics still need the live gate below. |
| Retention | SQL purge deletes expired delivery rows and result rows at `purge_at` (24 hours). No deployed scheduler is proven. Do not advertise a production 24-hour deletion promise before the scheduler canary passes. |

## Implementation files and verification

- [Shared exact result protocol](../../../web/packages/core/src/remote-results.mjs), [local controller](../../../web/apps/local-runtime/src/remote-results.mjs), [paired local routes](../../../web/apps/local-runtime/src/remote-routes.mjs) and [local UI](../../../web/apps/local/public/remote.js).
- [Signed-in phone page](../../../web/apps/web/src/app/remote/page.tsx), [phone UI](../../../web/apps/web/src/app/remote/RemoteCompanion.tsx), [browser hash/transport client](../../../web/apps/web/src/app/remote/remote-phone-client.mjs), [phone result API](../../../web/apps/web/src/app/api/remote/v1/results/route.ts) and [device result API](../../../web/apps/web/src/app/api/remote/v1/results/device/route.ts).
- [Additive unapplied migration](../../../supabase/migrations/202610040005_remote_reviewed_results.sql), [SQL execution harness](../../../web/scripts/verify-remote-results-sql.mjs) and [source-bound SQL evidence](../../../artifacts/remote-results-sql-verification.json).

Run from the repository root:

```sh
node --test web/scripts/remote-results.test.mjs web/scripts/remote-results-api.test.mjs web/scripts/local-remote-ui.test.mjs
node web/scripts/verify-remote-results-sql.mjs --install-runtime
```

The 28 targeted tests execute real loopback HTTP, private context IPC, SQLite persistence/reopen/backup restore, the shipped Next handlers, fixed outbound transport and shipped local DOM handlers. The full flow goes from an HTTP phone request through a durable local host completion, pending Writing review, exact acceptance, separate outbox consent, upload, fresh local delivery and browser hash verification. Its executor and relay/auth are synthetic fixtures: this does **not** prove live Codex entitlement, real Supabase JWTs or mobile browser layout.

The independent disposable PostgreSQL runner executes both migrations and 36 assertions using PGlite 0.5.8/PostgreSQL 18.3 with synthetic auth roles/sessions. It proves canonical hash parity, SQL owner/credential/private-table isolation, null/type rejection, one-use 30-second delivery, actual deleted-session-row denial, delivery/storage budgets, active-body erasure, privileged purge and extension rollback. It installs its test-only runtime in a temporary directory and removes it; it adds no production dependency or project configuration. It does **not** establish actual Supabase session revocation, multi-worker transaction concurrency or a deployed scheduler. The evidence explicitly leaves those fields false.

Local UI regressions include late reset/preview, changed pairing JSON during confirmation, stale pairing cleanup across two browser owners, grant/native availability changes, hidden/document/navigation/pagehide polling pause and no stale control revival. They are DOM stand-ins, not a visual or physical-phone compatibility claim. The older foundation tests and whole-app build remain separate coordinated checks.

## Operator release checklist: keep flags off until complete

Current hosted gates are all required:

```text
REMOTE_COMPANION_ENABLED=true
REMOTE_COMPANION_RELEASE_GATE=status_only_verified_policy
REMOTE_COMPANION_RESULT_RELEASE_GATE=reviewed_text_verified_policy
```

The local opt-in is `LEARNBRIDGE_PHONE_ACCESS=true`, followed by explicit paired-browser enrollment and exact source/native consent. The constructor lazily creates no installation marker/controller while disabled. Flags are release acknowledgements, not proofs; setting them cannot repair missing database/session/retention controls.

1. **Inspect the actual Supabase schema and current migration ledger.** Confirm `auth.sessions.id`, `user_id` and `not_after` have the expected semantics and that `extensions.pgcrypto` is available. Confirm verified JWT `session_id` matches its current session row. Apply `202610030003_remote_companion_foundation.sql` before additive `202610040005_remote_reviewed_results.sql` through the normal reviewed migration process. Neither file is a local-setup side effect. Do not blindly reapply a migration whose objects already exist.
2. **Use two controlled test accounts and fresh real sessions.** Prove anonymous/direct table access denial, A cannot enumerate/read/recover/delete B's records, device token/installation mismatch denial, original bound session ownership, and fresh A session recovery without old result reading. Test real logout/revocation and session expiry: stale valid JWT claims must fail new result preflight/read before private body acquisition. The older foundation's prompt/status RPCs have separate session semantics; do not claim those are fixed by the result extension.
3. **Exercise actual concurrent transactions.** Race pairing confirmations for the same installation/workspace, exact upload retries, same one-use ticket reads, and inserts near result/account/global delivery limits with distinct workers. Prove one winning binding/result/read and no quota overshoot. The result insertion paths share a transactional advisory lock and per-result row lock; disposable single-session tests do not establish multi-worker behavior.
4. **Configure and verify both purge jobs.** Run `public.remote_purge_expired()` and `public.remote_result_purge_expired()` under trusted scheduled service authority at a recorded cadence (for example once per minute). Never expose service credentials to the phone or laptop. Insert synthetic expired canaries through operator fixtures, observe their physical row/body removal after the actual scheduler runs, and record maximum deletion lag. Verify revoked active bodies are cleared immediately and operational scheduler failure is observable.
5. **Run a real device flow with synthetic content.** Sign in from a phone, pair a new private installation, approve a short synthetic-note grant, optionally execute a verified local Codex study request, accept its writing, approve/send exact text and verify the phone's exact SHA/body. Prove cancel, source edit, output edit, consent expiry, laptop offline, old-ticket replay, reload/sign-out, restart and fresh owner recovery. Native host completion on another route is not a replacement for this full phone proof.
6. **Record source-bound evidence before enabling.** Record commit/source hashes, migration versions, account/device identities as non-secret test labels, actual phone/browser results, concurrency outcomes and scheduler canary/lag. Then deliberately configure all release gates for the reviewed environment. No enablement or production migration was performed by this implementation.

## Disable and roll back

Disable all hosted phone gates first and stop/unpair participating local controllers. Verify endpoint refusal before body acquisition. Through trusted operator authority revoke owned active bindings, erase result bodies/policies and deny tickets, then verify deletion; preserve only explicitly approved minimal operational evidence. Do not claim delivered copies, backups or provider history were deleted.

If the additive schema itself must be removed, the following **destructive operator-only rollback** was executed solely in the disposable test database. It drops the reviewed-result extension while retaining the existing status-only foundation. Export only data explicitly approved for retention before using it in a real environment.

```sql
begin;
drop function public.remote_result_device(uuid,text,uuid,text,jsonb);
drop function public.remote_result_phone(uuid,uuid,text,jsonb);
drop function public.remote_result_validate_policy(jsonb,public.remote_device_bindings,public.remote_jobs,public.remote_relay_grants);
drop function public.remote_result_purge_expired();
drop function public.remote_result_confirmed_phone(uuid);
drop function public.remote_result_uuid(jsonb);
drop function public.remote_result_canonical(jsonb);
drop table public.remote_result_deliveries;
drop table public.remote_reviewed_results;
commit;
```

Remove the corresponding scheduler entry only after the disable/erasure checks, and retain the independent foundation purge job if that schema remains. Restarting/re-enabling requires the same migration and live release gates; a restored workspace or old local outbox supplies no relay authority.
