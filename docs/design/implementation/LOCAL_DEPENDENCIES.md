# Local foundation dependency and review record

Verified against the installed manifests, dependency lock, source notices and a real in-memory driver query on October 2, 2026. This records the new local foundation dependency slice; it is not a license inventory of the existing hosted website or an assertion that LearnBridge itself has an open-source license.

## Dependency inventory

| Component | Version | Role | License/source |
| --- | --- | --- | --- |
| `@learnbridge/core` | `0.1.0` | Internal contracts, error envelopes and pure hosted task migration | Internal workspace; no production dependencies |
| `@learnbridge/local-storage` | `0.1.0` | Private SQLite storage | Internal workspace; directly depends on core and the pinned driver below |
| `@learnbridge/local-runtime` | `0.1.0` | Local launcher, HTTP API, pairing and IPC | Internal workspace; core/storage only |
| `@learnbridge/local-dashboard` | `0.1.0` | Static browser dashboard | Internal workspace; no external runtime dependencies |
| `better-sqlite3` | **`13.0.3`**, pinned exactly | Native SQLite driver, transactions, FTS and online backup | MIT; Joshua Wise; [upstream repository](https://github.com/WiseLibs/better-sqlite3) |
| `node-addon-api` | **`8.9.2`** in the lock/install | Driver's Node native-addon support dependency | MIT; Node.js API collaborators; [upstream repository](https://github.com/nodejs/node-addon-api) |
| Bundled SQLite | **`3.53.4`** | Driver's database engine, also confirmed by `sqlite_version()` | Bundled amalgamation contains its author's copyright disclaimer/blessing below |

`better-sqlite3` declares Node `>=22` and a transitive `node-addon-api` range of `^8.0.0`. The checked-in npm lock fixes that transitive resolution to `8.9.2`. The local runtime/storage manifests require Node `>=22.16.0`; the current verified combination is Node **22.23.2**, macOS **arm64**, SQLite **3.53.4**. A native dependency being present for another platform does not establish that LearnBridge's permissions, launcher and backup flows are verified there.

The foundation imports no OpenAI, Claude, connector, browser-control or MCP SDK. It requires no cloud credentials and makes no model calls. Existing hosted dependencies remain separate. A future packaged release should include this notice and the applicable upstream notices with its distributed dependencies. LearnBridge's own repository license still needs an owner decision before an open-source release.

Evidence locations in the checked-out dependency installation: `web/node_modules/better-sqlite3/package.json`, `web/node_modules/better-sqlite3/LICENSE`, `web/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c`, `web/node_modules/better-sqlite3/deps/sqlite3/sqlite3.h`, `web/node_modules/node-addon-api/package.json`, `web/node_modules/node-addon-api/LICENSE.md`, and `web/package-lock.json`. The notices are reproduced here so they remain available without committing installed dependency folders.

## better-sqlite3 notice

Verbatim from installed `better-sqlite3` 13.0.3 `LICENSE`:

```text
The MIT License (MIT)

Copyright (c) 2017 Joshua Wise

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## node-addon-api notice

Verbatim from installed `node-addon-api` 8.9.2 `LICENSE.md`:

```text
The MIT License (MIT)

Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Bundled SQLite notice

Verbatim from the bundled SQLite 3.53.4 amalgamation's first embedded source-file notice:

```text
2001 September 15

The author disclaims copyright to this source code.  In place of
a legal notice, here is a blessing:

   May you do good and not evil.
   May you find forgiveness for yourself and forgive others.
   May you share freely, never taking more than you give.
```

## Runtime review and remaining limits

The storage/runtime boundary derives ownership from the stored installation, binds only to exact loopback origins, and requires an in-memory paired browser session plus a separate nonce for private operations. Native control operations use a private Unix socket and ephemeral credential metadata under the private root. A live or ambiguously reused owner PID never permits offline fallback.

Final review found and fixed these concrete cases:

- Diagnostic inspection of an existing empty/unmarked folder now reports `requires_setup` without initializing it or changing contents/modes.
- Doctor, backup, stop and uninstall can handle stale control metadata after a definitively dead process. Only `ESRCH` permits offline fallback; live/reused PIDs and ambiguous errors fail closed.
- IPC requests/replies collect bounded byte buffers before decoding, preserving Unicode characters split across socket chunks.
- Backup uses the same repository boundary as storage. Failed checkpoints still close the database before its writer claim is released.

The focused diagnostic tests use real child processes, a killed runtime, preserved fixture database hashes, and deliberately split Unicode socket frames. Existing lifecycle tests independently exercise occupied ports, writer rejection, backup/restore, SIGKILL restart, graceful stop, held request bodies, and backup during shutdown.

Remaining limits are explicit:

- The browser cookie has one name/path for all loopback ports. Two different local workspace servers in one browser overwrite each other's cookie, so use **one paired workspace per browser** for now. Their independent session maps prevent one workspace cookie from authenticating to another; simultaneous multi-workspace browser support is not implemented.
- Local API document request bodies are bounded more tightly than the storage-only 1 MB text limit. The browser/API limit and storage limit serve different boundaries.
- IPC and private files trust programs running as the same OS user. This is not a sandbox against malicious software already running as that user.
- A crash during the very short stale writer-claim recovery critical section leaves its recovery guard and fails closed for inspection.
- Manual documents and hosted task imports are supported. The official MCP agent bridge, source grants/ingestion, connectors, Avenue/D2L, credential vault, physical erasure, workflows and reviewed student profiles remain future slices.
- macOS arm64 is verified. Linux is experimental and Windows fails closed pending ACL implementation. Actual disk-full, cross-platform release, large-database performance and package redistribution checks remain separate release gates.
