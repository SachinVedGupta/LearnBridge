# Set up the private local workspace

LearnBridge's local edition stores tasks, notes, selected source snapshots and reviewed agent proposals in a private folder on this computer. It supports revision checks, backup/restore and project-scoped Codex/Claude MCP. Basic use needs no API keys. Sharing selected context with an official host requires separate review and may send that context to the host's model service. The public website remains separate.

See [agent and source setup](LOCAL_AGENT_SETUP.md) for selected text/Markdown imports, project-only host registration, sharing consent and task review. Reviewed Avenue/D2L exports and a read-policy adapter exist; **live institution login, cloud-source onboarding, reviewed profiles and durable orchestration remain unfinished**.

## Requirements and platform status

- Node.js **22.16.0 or newer** and npm. Do not change global Python for this edition.
- macOS arm64 is the verified foundation target. See [recorded evidence](design/implementation/LOCAL_FOUNDATION_VERIFICATION.json) for the exact runtime and cases checked.
- Linux is experimental: POSIX storage/control code exists, but a separate Linux release verification is still required.
- Windows fails closed until private native ACL and control handling is implemented.
- `npm run setup` installs the locked workspace dependencies, including the pinned native SQLite driver. It installs hosted dependencies too, but local commands do not require hosted service configuration. Native-driver installation can depend on the exact OS, architecture and Node release; a successful run on one machine is not proof for every platform.

## Install and open

For a fresh checkout:

```sh
git clone https://github.com/SachinVedGupta/LearnBridge.git
cd LearnBridge
npm run setup
npm run local:setup
npm run local:start
```

For an existing checkout, run the same npm commands from the repository root. Preserve any existing website `.env.local`; the local launcher does not need it.

`local:setup` builds the static dashboard and initializes the selected data root. Repeating setup checks the existing workspace without resetting its records. An unrelated nonempty directory is rejected. `local:start` builds the dashboard, opens the store and keeps the loopback runtime in the foreground.

The launcher prints the actual `origin`, a temporary `pairing_code`, and `data_root`. Open that origin in the browser, then enter the code in the pairing form. The normal address is `http://127.0.0.1:3210`; if the port is occupied, the launcher selects a free loopback port. Use the printed address. The code expires after five minutes and can be used once. If it expires, stop/restart the launcher to get a new one. Do not place it in a URL, chat, screenshots or saved verification logs.

After pairing, create a task or note. Note saves are read back before the dashboard shows success. A concurrent edit returns a revision conflict; unsaved input remains available until the student explicitly chooses to reload the saved version. Browser reload reuses a valid paired cookie, while runtime restart requires fresh pairing.

One browser profile can pair with only one active LearnBridge workspace at a time: loopback ports share the current cookie name. Pairing a second workspace replaces that browser's cookie for the first. Sessions and data remain independent; use separate browser profiles for concurrent workspaces, or restart/re-pair the selected workspace.

## Choose a data root and port

Defaults:

| Platform | Data root |
| --- | --- |
| macOS | `~/Library/Application Support/LearnBridge` |
| Linux, experimental | `$XDG_DATA_HOME/learnbridge`, or `~/.local/share/learnbridge` when unset |

The selected root must be outside the repository and owned by the current OS user. A new or empty directory may be initialized. Existing nonempty directories must already be recognized LearnBridge roots; do not point setup at a folder of student documents.

Custom paths with spaces work when quoted. Use the same root for later doctor, stop and backup commands:

```sh
npm run local:setup -- --data-root "/absolute/path/LearnBridge Data"
npm run local:start -- --data-root "/absolute/path/LearnBridge Data" --port 3211
```

`--port 0` asks the OS to choose a free loopback port. The launcher accepts `--json`; output is already JSON and the flag does not change access or suppress the pairing credential.

## Check and stop

In a second terminal at the repository root:

```sh
npm run local:doctor
npm run local:stop
```

For a custom root:

```sh
npm run local:doctor -- --data-root "/absolute/path/LearnBridge Data"
npm run local:stop -- --data-root "/absolute/path/LearnBridge Data"
```

Doctor checks the schema, SQLite integrity, local identity, task graphs, note hashes/revisions, search index and import journals. It reports optional capabilities honestly. Before setup, it returns `requires_setup` with a nonzero exit status. When the runtime is running, doctor uses the private local control socket; otherwise it opens/checks/closes the store. A second writer cannot take ownership of an active root.

Schema v2 also validates source lineage, disclosure receipts/budgets and immutable proposal payloads. Existing v1 workspaces upgrade transactionally without changing the original migration checksum. Doctor separately probes the fixed project `.venv` source worker; a missing worker leaves manual tasks/notes usable.

`Ctrl+C` in the launcher terminal also stops it. Disconnecting the browser invalidates that browser session; it does not stop the runtime or delete stored records. To pair again after disconnecting, restart the launcher for a new code.

## Try a disposable demo

```sh
npm run local:demo
```

This creates a temporary workspace containing synthetic study tasks and a sample note, then serves the same paired dashboard. It does not use or modify the default student data folder. Exit with `Ctrl+C`; normal shutdown removes the temporary demo root. `npm run local:demo -- --port 0` selects a free loopback port. Demo intentionally accepts no `--data-root` option.

A hard-killed demo process can leave its synthetic temporary folder. Do not treat process termination as proof that cleanup ran; only remove a leftover after confirming it is the fixture created by that demo.

## Back up and restore

Backups contain private content and historical revisions. Choose a **new** destination outside the repository and outside the live data root. The folder must not already exist:

```sh
npm run local:backup -- --output "/absolute/path/LearnBridge Backups/backup-2026-10-02"
```

Add `--data-root "/absolute/path/LearnBridge Data"` when using a custom workspace. Backup works while the runtime is running through its private control channel, or offline by opening the store. It writes a coherent SQLite snapshot and `manifest.json`, then validates schema/integrity and records the database hash. Do not commit or upload this folder accidentally.

Restore into a **new**, selected workspace, preserving the original:

```sh
npm run local:restore -- --backup-root "/absolute/path/LearnBridge Backups/backup-2026-10-02" --data-root "/absolute/path/LearnBridge Restored"
npm run local:doctor -- --data-root "/absolute/path/LearnBridge Restored"
npm run local:start -- --data-root "/absolute/path/LearnBridge Restored" --port 0
```

Restore checks manifest size/hash, schema, identity, text and relation integrity in a staging folder before promotion. A failed candidate is not installed over the current workspace. A hash detects changed bytes; it is not a signature that proves an unknown backup is trustworthy.

## Storage, credentials and deletion

The data root contains the LearnBridge marker, `learnbridge.sqlite`, its possible WAL/SHM files and a writer claim. The root uses POSIX mode `0700`; database and credential/claim files use `0600`. This isolates normal access by other OS users. It is not encryption and does not exclude other programs running as the same OS user.

Browser pairing creates an in-memory runtime session with an HTTP-only, same-site cookie and a request nonce held only in page memory. Private requests require the paired session/nonce and the intended local origin/host. Pairing codes, cookies and sessions become invalid after restart; the default browser session also expires after eight hours. Personal content and authentication tokens are not stored in browser local storage.

The launcher has a separate same-user control channel for doctor, stop and backup. Its Unix socket is under the private `learnbridge-ipc-<uid>` directory beneath the canonical system temporary directory. While running, `.control.json` in the private data root holds a temporary control credential. It is separate from the browser cookie, is not served by HTTP and is removed on normal shutdown. Do not read or print its values when producing diagnostics. A crash can leave private control metadata; it is not a source connector token or an AI credential.

The stdio bridge uses separate temporary `.agent-codex.json` and `.agent-claude.json` credentials, bound to their destination and limited to status/context/proposal operations. They cannot use admin stop/backup or human consent/acceptance. These files are private, are never returned by HTTP/MCP, and are removed on normal shutdown.

Deleting a task or note creates a tombstone. Active reads hide it, and a deleted note is removed from active search, but note history, deleted metadata and prior backups may retain text. Selective physical purge, retention policies and credential vaults are future work.

## Uninstall behavior

```sh
npm run local:uninstall
```

Add `--data-root` for a custom workspace. This command **stops the local runtime and retains data**. It does not remove the repository, npm packages, agent configuration, backups or unrelated files. It has no automatic data-deletion flag. A student's decision to remove a data folder is a separate action and must identify the exact folder and backup consequences.

No LearnBridge global agent configuration is generated by this foundation, so there is no global Codex/Claude entry to undo.

## Agent verification checklist

Use disposable synthetic data, not real student sources:

1. Check the project `.venv/bin/python3` and native source-worker prerequisites in [agent/source setup](LOCAL_AGENT_SETUP.md#student-setup) before running the full suite. Preserve an existing `.venv`; if absent, a suitable installed Python can create it with `python3 -m venv --without-pip .venv`. Then run `npm run setup`, `npm run test:local` and `npm run local:build`; report exact failures. Basic tasks/notes remain usable without acquisition, but the source verification suite requires the worker.
2. Run `npm run local:demo`; open its printed origin and pair through the form. Save/edit a task and note. Check stored note revision/hash and a second read of the exact text.
3. Create a separate fixture installation; stop/restart and pair again. Read back the same task IDs, completion/date values and exact note text. A demo deletes itself on shutdown and is not the persistence fixture.
4. Prove unpaired, expired, forged-origin/host and stale-revision requests fail without changing saved records. The executable local suites cover these boundaries; a visible sign-in form alone is not proof.
5. Back up the fixture, restore into a fresh root, and independently check exact records/hashes. Corrupt a copied candidate and prove rejection while the source is unchanged.
6. Run `npm test` and `npm run build` for hosted regression checks. These fixtures/builds do not establish live provider or two-student account behavior.
7. Return a sanitized receipt: edition, OS/Node/driver versions, capabilities, results, remaining gates and evidence path. Exclude pairing codes, session/control credentials, private source paths and content.

`node web/scripts/verify-local-install.mjs` repeats the clean-copy install proof using an explicit source allowlist, the existing offline npm cache and disabled package hooks. It copies no `.env`, previous dependencies or personal data, checks saved/restored records in separate processes, and removes its marked fixture. An unavailable cache is reported as a failure; it does not silently fall back to network access. This is separate from fresh-computer and other-platform release verification.

See [implementation status](design/IMPLEMENTATION_STATUS.md), [foundation evidence](design/implementation/LOCAL_FOUNDATION_VERIFICATION.json), [agent/source setup](LOCAL_AGENT_SETUP.md), [storage notes](../web/packages/local-storage/README.md) and [the full verification plan](design/VERIFICATION.md). Current fixture success does not complete all 27 product features or prove every student's host/institution access.
