# Local storage foundation

`@learnbridge/local-storage` stores tasks, text documents, immutable revisions, import backups/journals, selected local source snapshots, named agent grants and reviewable task proposals in one private SQLite database. Storage itself does not read laptop folders or connected accounts and makes no network/model requests. A separately verified, human-approved acquisition adapter supplies local directory descriptors/inventories and selected text snapshots.

The initial supported platform is macOS with Node 22.16 or newer. Linux uses the same POSIX checks but still needs a separate release verification run. Windows fails with `UNSUPPORTED` until native ACL handling is implemented. The pinned driver is `better-sqlite3` 13.0.3; its native build must be verified for each released platform/runtime combination.

## API

```js
import { LocalStore } from '@learnbridge/local-storage';

const store = LocalStore.open({
  root: '/absolute/path/outside/the/repository/learnbridge-data',
  timezone: 'America/Toronto',
});
const task = store.createTask({ title: 'Review synthetic lecture' });
store.updateTask(task.id, { status: 'in_progress' }, task.revision);
const note = store.createDocument({ title: 'Synthetic note', text: 'Local text.' });
store.updateDocument(note.document.id, { text: 'Revised local text.' }, note.document.revision);
await store.backup('/absolute/path/to/a/fresh/backup-folder');
store.close();

await LocalStore.restore({
  backupRoot: '/absolute/path/to/the/backup-folder',
  root: '/absolute/path/to/a/fresh/restored-data-folder',
});
```

Except for backup and restore, methods are synchronous. The local runtime owns browser authentication; a `LocalStore` handle is a trusted, same-OS-user capability and must never be returned to an untrusted caller. All records derive `student_id` from `store.identity`, a persistent random installation identity. Caller-supplied identity/schema/id fields are rejected. A local identity never substitutes for hosted Supabase authentication.

| Method | Result and condition |
| --- | --- |
| `createTask(input, {idempotencyKey?})` | Task; validates dependencies and parent graph atomically |
| `listTasks()`, `getTask(id)` | Active local tasks; missing/deleted reads return `null` |
| `updateTask(id, patch, expectedRevision)` | Updated task; stale revisions fail without overwriting |
| `deleteTask(id, expectedRevision)` | Tombstone; in-use dependencies/parents must be reconciled first |
| `createDocument({title,text,kind?,academic_policy?}, {idempotencyKey?})` | `{document,text,sha256}` |
| `listDocuments()`, `getDocument(id)` | Active metadata or complete current text/hash |
| `updateDocument(id, patch, expectedRevision)` | Complete updated document; appends a new immutable revision |
| `deleteDocument(id, expectedRevision)` | Tombstone; removes current search entries atomically |
| `listDocumentRevisions(id)` | Ordered immutable revision metadata/text/hashes for an active document |
| `searchDocuments(query)` | Literal phrase search of active local documents, at most 50 results |
| `planHostedTaskImport(input)` | Pure migration plan; no imported rows are saved |
| `commitHostedTaskImport(input, {snapshotHash})` | Atomic records + exact original backup + mapping/warnings + journal |
| `integrity()` | Schema checksum/DDL, SQLite integrity, identity, graphs, text hashes, lineage, search and import journal checks |
| `backup(freshFolder)` | Coherent online SQLite snapshot + manifest including hash/size/identity |
| `LocalStore.restore({backupRoot,root,repositoryRoot?})` | Validates a candidate in a staging root, then promotes into a fresh root |
| `close()` | Checkpoints, closes, and releases the writer claim |

## Agent processing and human review

The paired human surface calls `createAgentGrant({destination,task_ids,document_ids,source_entry_ids,max_bytes,expires_in_minutes})`. Destinations are exactly `codex` or `claude`, selected ID lists have at most 100 unique IDs per type, disclosure budget is 1–256,000 bytes, and lifetime is 1–480 minutes. The stored receipt derives its reviewer from the installation; caller-supplied reviewer/student/receipt claims are rejected. The grant pins every selected record's revision and complete version hash. `getAgentGrant(id)`/`listAgentGrants()` return those pins, budget, expiry, state and receipt without raw source paths. `revokeAgentGrant(id,expectedRevision)` uses the current revision; successful context reads increment the revision while charging the budget.

`agentContext({destination,grant_id,task_ids?,document_ids?,source_entry_ids?,max_bytes?})` reads all selected pins or a requested subset. It checks destination, expiry, state and every pinned version again. Changed/deleted records or a revoked source invalidate the grant. The response includes only selected task fields, complete selected note text and imported immutable source text; source text is labelled `untrusted_source_content` and carries a data-not-instructions notice. It contains no source root paths, inventories, unselected record titles or unselected text. UTF-8 byte accounting charges the complete serialized context response transactionally and cumulatively; failed reads do not charge. Charges survive restart and backup/restore. Whole records are delivered without silent truncation, so a selection larger than the remaining budget fails and requires a smaller selection/new reviewed grant. This is a disclosure budget, not a model-token or general workflow execution budget.

`proposeTask({destination,grant_id,title,deadline?,course_label?,reason?,idempotency_key})` requires a current matching grant but creates **only an `awaiting_review` proposal**. Its payload and hash are immutable; repeated exact keys return the same proposal and changed payloads conflict. `listTaskProposals()` provides the human review queue. Only the trusted human route may call `acceptTaskProposal(id,{expected_revision,payload_hash})` or `rejectTaskProposal(id,{expected_revision,payload_hash})`. Acceptance atomically creates one task with origin `agent_reviewed`; exact retries, including after restart, return the same accepted task. Rejection creates no task. Accepting a proposal is a fresh human decision, so it does not re-enable the agent grant or require the old processing grant still to be active. Runtime role/paired-session enforcement is essential: possession of a `LocalStore` handle is trusted same-OS-user access, and the receipt alone is not authentication. Agents must never receive grant creation or proposal acceptance methods.

## Selected source snapshots

The trusted acquisition adapter supplies a version-one `local-directory` descriptor with canonical root, label, captured directory identity and version hash. `createSource({label,descriptor})` assigns local ownership and source ID; `getSource(id)` returns its private descriptor to trusted human/runtime callers. `listSources()` omits that descriptor. Storage validates structured, bounded input without invoking accessors. It does not independently open or certify an external filesystem path; the acquisition adapter owns anchored path/OS-owner checks and actual read permission.

`saveSourceInventory(sourceId,inventory)` validates the adapter's exact entry/snapshot/directory shapes, ordered directory ancestry including the descriptor's root identity, source-version binding, UUIDs, relative paths, hardlink rejection, coverage, consistent counters and discovery budget. It seals the complete immutable inventory with an independent SHA-256 hash. `getSourceInventory(id)` returns `{id,source_id,student_id,sha256,created_at,inventory}` to the trusted runtime. Inventories are private metadata and never included in agent context.

`importSourceEntry({source_id,inventory_id,entry_id,title,text,sha256,version})` accepts only an entry in that source's stored inventory, with its exact title/snapshot version and a matching text content hash. It assigns a separate local entry ID and deduplicates exact source/entry/version imports, including unchanged re-inventory. A changed retry conflicts. `getSourceEntry(id)` returns the imported immutable text snapshot with provenance IDs and an untrusted-content label; `listSourceEntries(sourceId?)` omits text. Agents receive imported snapshots through granted `agentContext`, never live filesystem access or arbitrary paths. `revokeSource(id,expectedRevision)` prevents subsequent inventories/imports/entry reads and invalidates agent grants that reference the source. Revocation retains private snapshots and does not claim physical erasure.

## Schema upgrades

Current storage schema is **version 3**. The original version-one and version-two SQL/checksums are preserved unchanged. Opening a supported older workspace validates its exact schema/checksum and data before each additive migration; each migration runs in one immediate transaction. Failed or killed upgrades preserve the previous valid version and its records/checksums, and can be retried after ordinary stale writer recovery. Future or corrupt schema versions fail closed. Version-one and version-two backups are validated/restored into a fresh root without mutating the original backup; their first supported open upgrades only the restored root. Version-two integrity checks include source lineage/content hashes, immutable inventory hashes, grant receipt ownership/scope, budget bounds and proposal payload/accepted-task relations. Version-three adds workflow journals, exact reviewed action receipts and versioned domain records. These tables do not independently connect a model or execute a provider request.

## Durable workflows and reviewed actions

`createRun({recipe_id,recipe_version,input,budget,grant_refs?,source_pins?,idempotency_key?})` persists a `created` run with an immutable initial request hash. Input is at most 32 KB. Grant references pin ID/revision and optional processing destination; source pins contain `{kind,id,revision,version_hash}` for tasks, documents, imported source entries or workspace records. Storage validates their shape; the runtime must revalidate the actual current source permission, processing destination and observed revision before reads/execution, after asynchronous work, and on resume. A structural reference does not authorize access.

The trusted recipe runner moves `created → validating → ready`, then `claimRun(id,{expected_revision,owner,lease_ms?})` atomically changes `ready → running`. Claims increment a monotonic epoch and only one owner can claim a revision. Leases last 1 second to 5 minutes; `renewRunLease` checks the current unexpired owner/epoch and expected revision. All active-run mutations require that lease. `transitionRun` persists states, bounded checkpoints, stable errors and evidence references. Active-to-active checkpoint updates retain the lease and all consumed budget. Resume from failed/partial/interrupted/unknown outcome requires a checkpoint and an explicit transition to ready; the runtime owns fresh grant/source validation and skips only revalidated saved steps. The first execution time is retained: `max_duration_ms` is an elapsed wall-clock bound from that first start, including pauses, rather than a new allowance on resume.

`chargeRunBudget(id,{expected_revision,owner,epoch,tool_calls?,model_calls?,bytes?})` reserves cumulative amounts before work. Limits are at most 1,000 tool calls, 100 model calls, 10 MB of bytes and one hour from first execution. Failed attempts still consume an already reserved charge. An attempted charge beyond any limit saves a partial/budget-exhausted outcome, clears its lease and throws `BUDGET_EXCEEDED`; usage never resets on restart or resume. `requestRunCancel(id,expectedRevision)` persists cancellation intent. After that intent, new reservations, new running steps and new action execution are denied; an already dispatched result may still be saved under the current lease to disclose its real outcome. Cancellation is not rollback.

`putRunStep(id,{expected_revision,owner,epoch,key,expected_step_revision,kind,state,input_hash,source_pins?,result?,verification?})` persists a step and an immutable hashed revision snapshot atomically. New steps use expected step revision zero. Each run allows up to 100 steps; each result is at most 64 KB. Changed inputs may invalidate/recompute a step while its old results and evidence remain in history. A verified step needs a `passed` verification with matching nonnull SHA-256 `expected_hash`/`observed_hash`; its expected hash must also equal the canonical JSON hash of the saved result. Canonical JSON sorts object keys recursively. The trusted verifier, not storage or model prose, acquires the independent observed state. `completed` requires all stored steps verified, at least one matching saved evidence reference, and no unresolved actions. `listRunSteps`, `listRunStepRevisions`, `getRun`, `listRuns` and cursor-based `listRunEvents` provide readback. Events are immutable, sequence-ordered and bounded to 10,000 per run; public event appends fail on a full journal, while terminal cancellation remains possible and visible in the run record.

`recoverInterruptedRuns()` is a startup-only operation after gaining the single writer lock. It clears abandoned active leases, preserves cumulative budgets and checkpoints, labels active steps interrupted with historical revisions, and marks dispatched external actions unknown. Do not call it from a normal request handler while a legitimate worker owns a live lease. `recoverExpiredRunLeases()` only recovers expired leases and does not steal live ones. Clearing a lease on any stop also marks executing external actions `unknown_outcome`. A late former owner cannot overwrite the new epoch.

The action APIs are trusted runtime operations, and **review is not exposed to agents**:

- `proposeRunAction(runId,{expected_revision,owner,epoch,operation,account_ref,target,payload,preconditions?,expires_in_minutes?,idempotency_key})` returns `{run,action}` with immutable proposal/fingerprint. Expiry is 1–120 minutes. Changed retry payloads conflict.
- `reviewRunAction(actionId,{expected_revision,fingerprint,decision})` accepts `approved`, `rejected` or `needs_changes` only from an authenticated human handler. The store supplies its local student identity and immutable receipt; it does not accept a caller-supplied reviewer/receipt. The runtime verifies actual paired-human authority.
- `beginRunAction(actionId,{expected_revision,run_expected_revision,owner,epoch,fingerprint})` reserves an executing action only with exact current approval, unexpired review, current run lease and no cancellation/unresolved earlier effect. The runtime still checks current grants/provider base revisions and reserves call budgets before dispatch.
- `finishRunAction(actionId,{expected_revision,run_expected_revision,owner,epoch,state,provider_receipt?,verification?,error?})` saves verified/failed/unknown outcome. Verified needs a provider receipt and matching readback evidence. Provider success text alone cannot verify an action.
- `reconcileRunAction(actionId,{expected_revision,state,provider_receipt?,verification?})` resolves an unknown outcome to verified/failed/cancelled only when there is no active run lease; the trusted reconciler must first read the provider's actual state. `invalidateRunAction` invalidates a pending/authorized review. `getRunAction` and `listRunActions` expose saved proposals/receipts.

Local leases/idempotency prevent concurrent LearnBridge attempts; they cannot guarantee exactly one network effect across a provider timeout/crash. The fixture proves an effect followed by SIGKILL remains unknown until independent readback, with no blind retry. External providers and human approvals need their own separate live verification.

## Versioned domain records

`createWorkspaceRecord({kind,title,data},{idempotencyKey?})`, `getWorkspaceRecord(id)`, `listWorkspaceRecords({kind?})`, `updateWorkspaceRecord(id,{expected_revision,title?,data?})` and `deleteWorkspaceRecord(id,expectedRevision)` support bounded private domain JSON. Updates/deletes preserve immutable hashed history; deletes are tombstones. Data is at most 128 KB, without accessors, prototypes, cycles, unsupported values or unsafe object keys. Kinds are allowlisted for courses, academic items, proposed/confirmed profile facts, plans, artifacts, career/calendar items, tutoring sessions, learning checkpoints, research/inbox items, projects, pantry/meal plans, routines, expenses, administration items and schedules. Strict domain schemas, purpose-scoped profile consent, citations and consequential action policy belong to the relevant domain module. Generic JSON storage is not a generic agent-access route. Creation retries return the original creation revision and changed payloads conflict.

The hosted importer accepts an explicit exported `{value,revision}` response or task array. It preserves duplicate titles/legacy IDs as distinct local rows, completion states, invalid deadline text, and the exact original input. A snapshot with deferred rows is rejected as a whole. A changed snapshot is not automatically merged; the initial importer requires a future reconciliation UI for that case. Repeat committed snapshots return `already_imported`. The journal and backup are private SQLite content, not terminal output.

## Files and boundaries

- New/empty directories can become a LearnBridge root. Existing nonempty directories require the exact `.learnbridge-local-root` marker; an unrelated user folder is rejected before changing its permissions or contents.
- The resolved data root is outside the repository. Roots and data files must belong to the current OS user. Symlink roots and SQLite/WAL/SHM files are rejected. Existing ancestors are canonicalized so macOS system aliases do not break temporary-directory use.
- The root has mode `0700`; the SQLite database, WAL, SHM, marker and writer claim use `0600`. These are same-OS-user protections, not encryption or protection from other programs running as that user.
- A live writer claim prevents another runtime from owning the same root. A claim from a dead process can be recovered. A reused live PID is not stolen. Concurrent stale claim recovery is serialized by a temporary `lock-recovery` directory.
- A process interrupted during the small stale-claim recovery section can leave that directory. Startup then fails closed for inspection. Automated cleanup of this rare interrupted recovery guard is not implemented; it must not be removed while a writer might be live.
- Caller strings are SQL parameters. Document content stays inside SQLite, avoiding separate mutable attachment consistency. Text content is limited to 1 MB per document; hosted import limits come from the shared migration contract. Backup candidates are limited to 512 MB.
- Document revisions have database-level update/delete rejection triggers. Deletes are tombstones: normal reads/search hide the document, but historical text remains in private storage/backups. Physical erasure and retention controls are future work.
- Nonempty core task `source_refs` still fail with `CONSENT_REQUIRED`. Imported local source snapshots use the dedicated source tables and selected agent grants above. Remote connectors, external credential vaults, attachments, general source grants and embedded model calls are not implemented by storage. A receipt-shaped object cannot unlock a source. Workflow storage is a journal and policy precondition, not an executable connector or host sandbox.
- Backups enforce the same configured repository boundary as live data and atomically claim their fresh destination folder. Fresh restore checks the destination before validation and before staging-directory promotion. These checks protect normal concurrent operations; the same OS user is trusted and can directly modify files, so protection from an actively malicious program racing filesystem operations is outside this initial slice. Hashes detect transfer/corruption; they are not a cryptographic signature proving a backup came from a trusted person.

## Verification

From the repository root:

```sh
node --test web/scripts/local-storage.test.mjs
node --test web/scripts/agent-storage.test.mjs
node --test web/scripts/local-workflow-storage.test.mjs
```

The 21 deterministic tests create only disposable synthetic roots and exercise the actual pinned SQLite driver. They verify real fresh-process restart, stale-revision rejection, persisted idempotency, immutable revision triggers/hashes, FTS edit/delete/restart, ownership/accessor/source claim denial, dependency/parent graph rejection, exact hosted import backups and all-or-nothing review, injected import SQL failure, SIGKILL owner recovery, interrupted SQL transaction rollback, POSIX modes/symlinks, unchanged future-version rejection, coherent online backup/fresh restore, corrupted and rehashed-but-invalid candidates, unrelated-folder preservation, synthetic SQLite capacity rollback, the explicit repository export boundary, and connection closure despite an injected checkpoint failure.

The capacity test uses SQLite `max_page_count`, not a genuinely full filesystem. The original interrupted-transaction test kills a real process inside injected SQL schema changes; the additional v2 tests below interrupt the actual additive migration. Cross-platform ACLs, real filesystem-full recovery, large databases, and physical erasure still need separate verification before claiming those capabilities.

The additional 17 agent-storage tests cover exact selection/privacy, forged claims, named destinations, expiry/revocation/changed/deleted pins, cumulative serialized-byte charges across restart, immutable proposals and exactly-once human acceptance/rejection, imported snapshot hash/version/deduplication, untrusted-content labelling, source revocation/traversal/hardlink/accessor rejection, directory ancestry/accounting/timestamp consistency, actual v1-to-v2 upgrade checksum preservation, injected upgrade failure and SIGKILL rollback/recovery, legacy backup migration, complete v2 backup/restore, rehashed corrupt source lineage, and unchanged rejection of bad/future versions. Tests use disposable synthetic sources; they do not access actual laptop content, a subscription, a model or a connected account.

The 19 workflow-storage tests add actual fresh-process run persistence, competing claims, stale revision/owner/epoch denial, immutable changed-input history, cancellation with late effect disclosure, cumulative budget stop/restart, exact approval/payload/base-revision binding, a synthetic provider effect followed by SIGKILL and explicit reconciliation, saved-result hash binding, domain record restart/idempotency/tombstones, actual v2→v3 migration and SIGKILL/exception rollback, unchanged v2 backup restore, complete v3 backup/readback, rehashed corrupt workflow denial, expired lease recovery, unknown outcomes on budget stop, partial multi-destination receipts and failed/unavailable provider-readback denial. These are storage/fixture proofs, not live model or provider completion.
