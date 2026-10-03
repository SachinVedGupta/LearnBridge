# W02 SQLite feasibility spike

Reviewed 2 October 2026. This is a **completed synthetic dependency probe**, not the local storage implementation or approval to install a driver. No student folders, connected apps, tokens, database defaults, cloud services or network requests are used by the probe. It creates its own marked temporary directory and removes that directory when finished. Production dependencies and the hosted app are unchanged.

## Recommendation

SQLite can satisfy the planned local data needs. Keep the repository interfaces independent of the driver, then trial a pinned supported driver before W03 ships. Prefer an approved `better-sqlite3` trial over adopting Node 22's experimental SQLite interface as a stable production contract. Native built-in SQLite remains useful for this dependency-free feasibility probe and development experiments.

This recommendation is an engineering judgment based on the successful fixture checks and the API maturity/installation tradeoff. It does not mean either candidate has completed LearnBridge's supported-platform release gate.

## Reproduce

From the repository root:

```sh
node docs/design/spikes/sqlite-probe.mjs
```

Exit status is `0` only when all 14 checks pass; failed checks appear in the JSON report and cause exit status `1`. No custom data-root argument is accepted. The expected experimental warning remains visible; the probe does not suppress it. A machine-readable result from the initial run is saved in [sqlite-probe-report.json](sqlite-probe-report.json). The executable assertions are in [sqlite-probe.mjs](sqlite-probe.mjs).

Initial environment: **Node v22.23.2, macOS arm64, bundled SQLite 3.51.3**. Outcome: **14 PASS, 0 FAIL**. No native compiler or new package was needed for this run. These observations apply to this environment only.

## Measured checks

| Check | Objective assertion | Initial result | Planning coverage |
| --- | --- | --- | --- |
| SQL01 | STRICT table rejects an invalid type; journal mode reads back `wal`; runtime SQLite version is recorded | PASS | Driver capabilities |
| SQL02 | Running the base migration twice leaves schema version 1 and exactly one migration row | PASS | W03 migration mechanism |
| SQL03 | A failed migration leaves no new table/row and restores the old schema version | PASS | R02, partial |
| SQL04 | A child is killed during an uncommitted WAL migration; a reopened database contains only the committed original state and passes integrity checking | PASS | R02, partial |
| SQL05 | A separate process reads the exact saved task and revision 3 after the writing connection closes | PASS | R01, partial |
| SQL06 | Three child processes attempt revision 0 updates; exactly one changes a row, two change none, and final revision is 1 | PASS | R02 revision primitive |
| SQL07 | A second writer encounters a held lock, leaves state unchanged, and succeeds after lock release | PASS | R02 contention primitive |
| SQL08 | Missing foreign-key target is rejected; a SQL-shaped title stays literal data | PASS | Storage constraints |
| SQL09 | FTS5 search returns only the selected source; deleting that source transactionally removes its chunks and search hits after reopen | PASS | S07, partial |
| SQL10 | A live WAL database is backed up; a later write affects only the live revision; the snapshot is intact and attachment hashes match | PASS | R05, partial |
| SQL11 | Snapshot and synthetic immutable file are restored into a fresh directory; integrity, schema version, row count, revision and file hashes match | PASS | R05, partial |
| SQL12 | A non-SQLite candidate is rejected; the original snapshot hash remains unchanged | PASS | R02/R05, partial |
| SQL13 | An imposed SQLite page limit causes a capacity error; committed data remains intact after reopen | PASS | R02, simulated capacity failure |
| SQL14 | The fixture directory explicitly has POSIX mode `0700` and the tested database explicitly has `0600` | PASS | Permission primitive only |

The planned acceptance checks require full implementations around these primitives. Passing SQL09 does not establish complete source forgetting across documents, caches, previous backups, provider context or a local UI. Passing SQL10/11 does not establish an atomic application export while other processes mutate attachment files.

## Driver choices

| Candidate | What is established | Main tradeoff | Next gate |
| --- | --- | --- | --- |
| Built-in `node:sqlite` in tested Node 22 | This probe ran without installation; transactions, FTS5, backup and revisions worked | Experimental runtime API; synchronous database operations can block the runtime | Decide whether accepting that maturity is appropriate; pin/test supported runtime versions, isolate long operations and implement repository tests |
| `better-sqlite3` 13.0.3 trial | Official tagged package requires Node >=22, includes a native addon and is MIT licensed; documented transaction and backup APIs | New production dependency; native package installation and OS/architecture availability need real testing | Required owner approval, locked dependency diff/notice, fresh installation tests, then rerun equivalent cases through the actual driver adapter |

Node's versioned documentation marks this API experimental, says query APIs execute synchronously, and places `backup` and constructor busy timeout at Node 22.16. The probe therefore needs a runtime with those APIs; the minimum proposed trial baseline is 22.16, while only 22.23.2 was tested. [Node 22.23.2 SQLite documentation](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html)

The reviewed driver candidate is pinned upstream to `v13.0.3`, commit `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`. Its current tagged manifest contains `node-addon-api` as a runtime dependency. Its documentation provides transaction rollback, busy timeout and online backup behavior. A native addon can require an appropriate prebuilt binary or build tooling; no installation-success claim is made here. [Tagged manifest](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/package.json), [driver API documentation](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/docs/api.md), [license](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/LICENSE)

## W03 requirements still outstanding

1. Implement domain repositories, deliberate hosted export conversion and real migration ordering/compatibility. Fixtures here are deliberately small, not the future schema.
2. Establish one daemon writer per student root, root ownership and locking, restricted database/WAL/export files, cancellation and bounded worker execution. POSIX fixture modes do not prove production path/ACL enforcement.
3. Build attachment immutability and coordinated snapshot manifests; restore into a fresh candidate root, validate everything before activation, preserve the prior root and recover from interruption.
4. Test actual disk-full/permission-denied filesystems, pending/corrupt migrations, incompatible future schema versions, WAL recovery, large fixture performance, and backup retention/deletion. SQL13 only simulates SQLite capacity limits.
5. Repeat fresh installation and storage verification on each claimed OS/runtime/architecture. Windows ACLs and Linux packaging have not been tested.
6. Connect storage to paired local access, grant enforcement, private IPC and the UI; rerun hosted build/auth regression. This probe does not test those layers.

W02 remains incomplete until its license/dependency decision and static local UI distribution proof are resolved. This evidence removes the basic SQLite feasibility uncertainty without pretending the student product is finished.
