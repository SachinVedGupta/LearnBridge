# Local foundation implementation plan

Requested and approved October 2, 2026. The student's instruction to implement the local foundation follows the concrete proposal for pinned `better-sqlite3` 13.0.3; that dependency is approved for this slice. No other production dependency, cloud configuration or release is included.

## Scope and completion predicate

Implement W03–W05 as a usable local application beside the existing hosted website. A student can initialize an isolated private data root, start a loopback dashboard without cloud keys, pair from a temporary launcher code, create/edit tasks and multiple text notes, stop/restart, pair again and see the exact saved data. Back up the database consistently and restore to a separate fresh root without overwriting originals. Provide diagnostics, documented lifecycle commands and a synthetic demo.

The initial verified platform is macOS arm64 with Node 22.23.2. Linux stays experimental until independently tested; Windows private ACL support is unavailable and must fail closed. The UI contains honest unavailable states for source onboarding, connected apps and agent execution. No private folder scan or connected-app data is needed for foundation tests.

This is not the complete M1 milestone: W06 official MCP workspace integration and W07 reviewed durable actions remain separate follow-up slices, as do source ingestion, grant-backed retrieval, tutoring and Avenue login. The foundation rejects unsupported sourced records rather than accepting fabricated consent receipts.

## Stage 1: private data and lifecycle

- Create `@learnbridge/local-storage` using exactly pinned `better-sqlite3` 13.0.3 and existing `@learnbridge/core`.
- Keep data outside the checkout. Create a persistent random installation identity, owner-restricted directories/files, a single-writer root lock, schema migrations and future-schema refusal.
- Save manual/explicitly imported tasks with atomic expected revisions and idempotent creation. Save notes and immutable text revisions/hashes in SQLite; no mutable attachment directory is required by this first slice.
- Add student-bound FTS for manual local notes, deliberate hosted-task import plan/commit journal, integrity checks, online snapshot plus hash manifest, and restore into an absent fresh root. Backups contain private data and are not automatically uploaded.
- Prove restart, conflicting edits, failed/interrupted migrations, lock recovery, unsafe paths, FTS deletion and corrupted-restore preservation against actual databases.

## Stage 2: local service and dashboard

- Create an independent Node service bound only to `127.0.0.1`; never disable the hosted website's authentication.
- Validate exact Host/Origin and Fetch Metadata; private requests need an in-memory paired HttpOnly/SameSite session and session-bound request nonce. Mutations require same Origin. A narrow same-origin browser session bootstrap permits reload without treating an absent Origin as authorization.
- Display short-lived, single-use pairing codes through the local launcher only. Rate-limit attempts; session/code expiry, logout and runtime restart invalidate access.
- Bound JSON/text payloads. Render user content as text. Serve only allowlisted static assets with CSP and no external resources. Unknown routes/errors disclose no student content, credentials or filesystem paths.
- Build a responsive static dashboard for Today/tasks, notes and diagnostics. Preserve unsaved notes after conflicts; never invent working AI/connector capabilities.
- Add setup/start/doctor/stop/backup/restore commands. Expose no arbitrary file/shell API. Control the running daemon over authenticated private IPC when needed; persisted lifecycle metadata contains no browser pairing/session credentials.

## Stage 3: independent verification

Use only marked temporary synthetic roots. Verification must observe persisted records, actual HTTP responses, cookies, request rejection and fresh-process read-back; mocking the writer is insufficient.

| Gate | Required observation |
| --- | --- |
| Clean local setup | No cloud keys or cloud requests; static dashboard and diagnostics work |
| Pairing/auth | Anonymous private routes, forged identity, wrong Host/Origin/site/nonce, replayed code, expired/logout sessions fail |
| Normal browser | Same-origin UI can pair, save/edit/read tasks and notes; legitimate GET without Origin works with valid nonce |
| Durability | Saved task/text/hash/revision survive stop/restart and fresh-process reads |
| Conflicts | Two updates with the same expected revision produce one successful write and one explicit conflict |
| Root ownership | A second writer/runtime cannot own the same root; stale lock recovery is safe |
| Recovery | Interrupted migration leaves committed originals intact; bad/future/corrupt restore cannot change original roots |
| Backup | Snapshot restores into a new root with matching IDs/counts/revisions/text/hash |
| Privacy | Fixture permissions and child environment allowlists verified; no canaries/content in diagnostics/errors |
| Port occupation | Alternate port is still loopback-only and actual origin is reported |
| UI | Browser interaction and refresh/restart verify persisted outcomes and conflict handling |
| Hosted regression | Existing OAuth/provider/account-bound fixtures and production build pass |

Save a sanitized report with exact environment, source hashes, test outcomes, supported scope and unresolved platform/MCP/source/live gates. Do not mark every planned F01/F27 acceptance case complete from these narrower foundation checks. Do not commit, push or deploy this slice without the student's explicit authorization.
