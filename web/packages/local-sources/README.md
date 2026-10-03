# Local text sources

This package acquires **explicitly selected local `.txt` and `.md` files** for the local LearnBridge edition. It performs bounded metadata inventory first, then reads an individually selected file from that inventory. It does not scan the home directory, infer a profile, create consent, call a model, execute discovered instructions or connect to a provider.

The paired runtime must obtain human metadata/content permission, load its trusted stored descriptor/inventory and check permission again after the asynchronous operation. A descriptor or inventory hash is a version check, **not an authentication or consent token**. Do not expose these functions as arbitrary-path tools to a cloud agent. Paths, filenames and file contents are private data and need separate destination-specific permission before remote serialization.

## Native acquisition prerequisite

The fixed worker executable is the repository's existing `.venv/bin/python3`. No Python dependency is installed or changed by this package. It uses only the standard library and runs with `-I -S -B -X utf8`: isolated imports, no site packages and no bytecode writes. The child receives only `TZ=UTC`, bounded JSON and fixed reviewed worker code. It receives no inherited provider keys, agent credentials, Python path or shell command.

`probeSourceCapability()` returns `available` only when this runtime has directory-relative `os.open`/`os.stat`, descriptor-based `os.scandir`, `O_DIRECTORY` and `O_NOFOLLOW`. Missing runtime/flags/platform returns `unsupported`. **There is no weaker Node path-based fallback.** A clean checkout that lacks `.venv` can still use manual tasks/notes; the source adapter remains unavailable until its documented local runtime prerequisite is satisfied.

Initial live fixture environment: macOS arm64, Node v22.23.2, existing isolated Python 3.12.14. Linux has the same native capability probe but has not been verified here. Windows is unsupported by this adapter. These are acquisition guarantees for this worker; they do not confine other filesystem tools available to a host agent.

## API

All functions are asynchronous. Returned data is deeply frozen.

```js
const descriptor = await describeRoot(selectedAbsoluteFolder, { label: 'School notes' });
const inventory = await inventorySource(descriptor, {
  maxEntries: 500, maxFiles: 100, maxDepth: 8, signal,
});
const content = await readSelectedEntry(descriptor, inventory, selectedEntryId, {
  maxBytes: 256000, signal,
});
// content = {text, sha256, version, title}
```

`describeRoot` refuses traversal, linked roots, the whole home directory, broad/system roots and known private credential/agent/dependency directories. It canonicalizes the selected root, then opens every canonical component relative to a directory descriptor with no-follow rules. The root device/inode must match the selected identity.

`inventorySource` reads names/types/sizes/timestamps only. Every eligible file has an opaque UUID, relative path, a file snapshot and a complete root-to-parent directory identity chain. UUIDs remain stable for an unchanged path/device/inode under the same root identity; inventory IDs are new UUIDs and metadata versions are deterministic. Inventory does not read file bodies. It never descends into secret/agent/auth/dependency/cache folders or follows symbolic links; hard links and special files are excluded. Unknown types are counted without publishing their filenames.

Budgets are hard maxima, with default/hard ceilings of 500 visited entries, 100 eligible files, depth 8 and 256,000 bytes per selected read. Operations have a five-second worker deadline. File/entry/depth limits, permission failures, cancellation and changed sources remain explicit coverage outcomes. Hitting a limit conservatively reports `partial`, even when that limit happens to coincide with the last entry. Cancellation retains observed metadata accounting but returns no usable content. Inventory is not a grant to newly created files.

`readSelectedEntry` validates the complete stored inventory, selected entry and bounded byte request. It opens each parent relative to its pinned directory descriptor with `O_NOFOLLOW`; it then opens the final regular file without following links and with non-blocking protection against a substituted FIFO. Before any body read it compares the opened file's device/inode, size, nanosecond mtime/ctime and link count to the approved snapshot. It reopens/checks the current root/parent chain and current leaf entry before extraction. Extraction reads the **same opened file descriptor**, then checks the version/chain again before returning exact UTF-8 text and its SHA-256 hash.

Renaming a root/parent, substituting a symlink/leaf, adding a hard link or changing the file version causes refusal. Concurrent in-place writes are checked between chunks and after reading; an unstable buffer is quarantined rather than returned. This does not promise that an OS makes ordinary mutable-file content reads atomic: bytes from an authorized object may already have been read before an in-place change is detected. The proved path boundary is that substitution cannot make the worker read a different unapproved inode's body.

## Stored shape

- Descriptor: `schema_version`, `kind`, `root`, `label`, `identity` (`dev`, `ino` decimal strings), `version`.
- Inventory: `schema_version`, `id`, `source_version`, `version`, `entries`, `counts`, `coverage`, `exclusions`, `budget`, `retrieved_at`.
- Entry: `id`, `relativePath`, `kind` (`text`/`markdown`), `title`, `snapshot`, `directories`.
- Snapshot: decimal-string `dev`, `ino`, `mtimeNs`, `ctimeNs`; numeric `size`, `nlink=1`; metadata `version` hash.
- Directory: `relativePath` and `identity` with decimal-string `dev`, `ino`, `mtimeNs`, `ctimeNs`. The ordered chain begins at `relativePath=""` and includes every parent prefix.
- Counts: numeric `entriesVisited`, `directoriesVisited`, `eligibleFiles`, `excludedEntries`, `totalBytes`.
- Exclusions: counters `secret`, `symlink`, `special`, `unsupportedType`, `hardlink`, `depth`, `permission`, `changed`.
- Coverage: state `complete`/`partial`/`cancelled`/`blocked` and reasons `entry_limit`, `file_limit`, `depth_limit`, `permission_denied`, `source_changed`, `cancelled`, `time_limit`.

Known secret filenames are excluded before inspection. Arbitrary allowed text can still contain sensitive information; filename rules are not a guarantee that notes contain no credentials. This package grants no cloud processing or external write access.

## Verify

From the repository root:

```sh
node --test web/scripts/source-inventory.test.mjs
```

The verified run passed **26 real native acquisition cases**, with no skips. Tests use only marked disposable synthetic roots. Native checkpoint barriers deliberately replace the actual root, parent or leaf between check/open/read phases. The worker reports actual source-body read device/inode/byte observations to the test-only constructor, and adversarial cases assert zero outside-body reads. Tests also prove metadata-only inventory, deterministic versions, secret exclusions, strict input validation, hard-link/version refusal, budget coverage, cancellation, FIFO refusal, exact Unicode across pipe chunks and quarantine of an in-place write.

`createSourceAdapterForTests({onPhase,onBodyRead})` is an explicit test constructor. Production method options reject callbacks; a request cannot change the worker executable or replace native filesystem functions. The observer operates on synthetic native phase receipts and does not substitute a mocked reader.

Runtime consent/revocation, private storage lineage/purge, paired HTTP policy and cloud-host output filtering require their independent suites. This adapter pass does not establish full onboarding or a supported real MCP host workflow.
