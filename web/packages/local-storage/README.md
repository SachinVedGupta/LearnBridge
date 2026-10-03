# Local storage foundation

`@learnbridge/local-storage` is the first implemented local storage slice. It stores manually created tasks, text documents, immutable document revisions, import backups/journals, and retry records in one SQLite database. It does not read laptop folders or connected accounts and makes no network/model requests.

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

The hosted importer accepts an explicit exported `{value,revision}` response or task array. It preserves duplicate titles/legacy IDs as distinct local rows, completion states, invalid deadline text, and the exact original input. A snapshot with deferred rows is rejected as a whole. A changed snapshot is not automatically merged; the initial importer requires a future reconciliation UI for that case. Repeat committed snapshots return `already_imported`. The journal and backup are private SQLite content, not terminal output.

## Files and boundaries

- New/empty directories can become a LearnBridge root. Existing nonempty directories require the exact `.learnbridge-local-root` marker; an unrelated user folder is rejected before changing its permissions or contents.
- The resolved data root is outside the repository. Roots and data files must belong to the current OS user. Symlink roots and SQLite/WAL/SHM files are rejected. Existing ancestors are canonicalized so macOS system aliases do not break temporary-directory use.
- The root has mode `0700`; the SQLite database, WAL, SHM, marker and writer claim use `0600`. These are same-OS-user protections, not encryption or protection from other programs running as that user.
- A live writer claim prevents another runtime from owning the same root. A claim from a dead process can be recovered. A reused live PID is not stolen. Concurrent stale claim recovery is serialized by a temporary `lock-recovery` directory.
- A process interrupted during the small stale-claim recovery section can leave that directory. Startup then fails closed for inspection. Automated cleanup of this rare interrupted recovery guard is not implemented; it must not be removed while a writer might be live.
- Caller strings are SQL parameters. Document content stays inside SQLite, avoiding separate mutable attachment consistency. Text content is limited to 1 MB per document; hosted import limits come from the shared migration contract. Backup candidates are limited to 512 MB.
- Document revisions have database-level update/delete rejection triggers. Deletes are tombstones: normal reads/search hide the document, but historical text remains in private storage/backups. Physical erasure and retention controls are future work.
- Nonempty task `source_refs` fail with `CONSENT_REQUIRED`. Source ingestion, permission grant storage, external credential vaults, attachments, workflows, and cloud processing are not implemented by this slice. A receipt-shaped object cannot unlock a source.
- Backups enforce the same configured repository boundary as live data and atomically claim their fresh destination folder. Fresh restore checks the destination before validation and before staging-directory promotion. These checks protect normal concurrent operations; the same OS user is trusted and can directly modify files, so protection from an actively malicious program racing filesystem operations is outside this initial slice. Hashes detect transfer/corruption; they are not a cryptographic signature proving a backup came from a trusted person.

## Verification

From the repository root:

```sh
node --test web/scripts/local-storage.test.mjs
```

The 21 deterministic tests create only disposable synthetic roots and exercise the actual pinned SQLite driver. They verify real fresh-process restart, stale-revision rejection, persisted idempotency, immutable revision triggers/hashes, FTS edit/delete/restart, ownership/accessor/source claim denial, dependency/parent graph rejection, exact hosted import backups and all-or-nothing review, injected import SQL failure, SIGKILL owner recovery, interrupted SQL transaction rollback, POSIX modes/symlinks, unchanged future-version rejection, coherent online backup/fresh restore, corrupted and rehashed-but-invalid candidates, unrelated-folder preservation, synthetic SQLite capacity rollback, the explicit repository export boundary, and connection closure despite an injected checkpoint failure.

The capacity test uses SQLite `max_page_count`, not a genuinely full filesystem. The interrupted-upgrade test kills a real process inside a SQL transaction against the actual schema; it does not claim a future version-two migration exists. Cross-platform ACLs, real filesystem-full recovery, large databases, and physical erasure still need separate verification before claiming those capabilities.
