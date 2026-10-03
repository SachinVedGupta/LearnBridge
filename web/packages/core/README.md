# LearnBridge shared core

This dependency-free package is the first implementation slice of [W01](../../../docs/design/IMPLEMENTATION_PLAN.md#w01-establish-shared-contracts-and-protect-the-hosted-edition). It defines domain data and adapter interfaces for the future local edition. The hosted website still uses its existing Supabase authentication and state routes; importing this package does not authenticate a student or grant access to files.

## Implemented

- Versioned Installation, SourceGrant, Task, Document, immutable DocumentRevision and Run validators/builders.
- Explicit date-only, UTC-instant and unknown deadlines; invalid calendar dates fail instead of rolling into another month.
- Source provenance, selected scopes, separate local/cloud processing permissions and destination payload ceilings.
- Task dependency/parent graph validation, expected revisions, run transitions, checkpoint freshness and carried-forward budgets.
- Local/hosted identity shapes, execution destinations and typed repository/storage/identity/agent ports.
- Pure hosted-task migration planning: deterministic student-bound IDs, duplicate/completion preservation, exact backup, reimport journal support and explicit review of incompatible legacy values.
- Synthetic task/document JSON round-trip example. This is a contract demonstration, not a production storage adapter.

## Run the proof

From the repository root, with Node.js 22+ and the existing workspace dependencies:

```sh
npm run test:core
npm run demo:core
```

The demo creates only a fresh temporary synthetic fixture, writes a task/document/revision, reopens and validates them in a different Node process, checks the content hash, then removes the fixture. It accepts no student data-root argument, reads no connected accounts and needs no cloud keys. A nonzero exit means the proof failed. Full repository tests remain `npm test`.

## Boundary to preserve when building adapters

Shape validation is not authorization. A claimed `student_id`, grant receipt, capability report or resumable checkpoint must be backed by the runtime's actual verified session, stored policy and current observations. The grant precondition checks operation, time, destination and payload limits; it does not resolve filesystem paths or establish object ownership. Repositories must enforce scopes, ownership, atomic expected revisions and immutable revision rows.

`migrateHostedTasks` returns a plan and a **private** backup; it writes nothing. The storage adapter must transactionally persist records, backup and mapping, then finalize the student-scoped journal only after deferred rows are resolved. A changed snapshot is a reconciliation decision, not permission to overwrite or merge. Never print or commit returned student content.

No database repository, pairing server, MCP server, official-agent session, onboarding scan or local dashboard is implemented by this package. See [implementation status](../../../docs/design/IMPLEMENTATION_STATUS.md) and the [SQLite spike](../../../docs/design/spikes/SQLITE_FEASIBILITY.md) for the next gates.
