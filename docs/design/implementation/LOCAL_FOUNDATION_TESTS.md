# Local foundation verification

This suite verifies the local task/document foundation against real loopback HTTP requests, separate Node processes and private SQLite files in disposable synthetic workspaces. It does not use student folders, OAuth accounts, cloud API keys or an existing LearnBridge workspace. A pass proves only the behavior described below on the machine that ran it.

The executable tests are [runtime requests](../../../web/scripts/local-runtime.test.mjs) and [process lifecycle](../../../web/scripts/local-lifecycle.test.mjs). Run them from the repository root with:

```sh
node --test web/scripts/local-runtime.test.mjs web/scripts/local-lifecycle.test.mjs
```

## Required observable outcomes

| Gate | Independent observation | Required outcome |
| --- | --- | --- |
| LF01 Pairing | Exchange a fresh pairing code, then repeat the same request | A session is issued once; replay is refused |
| LF02 Pairing expiry | Wait beyond a short fixture pairing lifetime before exchange | No session is issued |
| LF03 Private route gate | Request each implemented private endpoint without a paired session | No private task, document, installation or diagnostic data is returned |
| LF04 Request identity | Send forged Host, cross-site Origin, Fetch Metadata and missing/wrong session nonce | Each forged request is refused without mutation |
| LF05 Browser read | Read with a valid paired session and nonce while omitting Origin | A legitimate browser read succeeds |
| LF06 Session lifecycle | Expire a short-lived session; separately log out and replay its cookie | Neither session can access private data afterward |
| LF07 Persistence | Create a task/document, stop the runtime, open a fresh runtime and pair again | Exact content, stable identity and revisions survive restart |
| LF08 Competing edits | Send two updates with the same base revision | One update commits; the other reports a conflict and does not overwrite it |
| LF09 Local ownership | Attempt to supply a different student identity in a mutation | Caller-controlled ownership is refused |
| LF10 Single writer | Start another runtime using the same data root | The second runtime cannot become a concurrent writer |
| LF11 Occupied port | Hold the requested port with an unrelated loopback listener | The runtime safely chooses another loopback port or returns a clear bounded error according to its documented contract |
| LF12 Cloud-free doctor | Run the CLI with an environment containing no cloud configuration | Doctor reports the local installation without asking for a provider key |
| LF13 Backup and restore | Back up a seeded workspace, restore into a fresh root, reopen it in another process | Task/document content and hashes match; corrupted backups are refused |
| LF14 Crash recovery | Kill a fixture runtime and restart against its data root | A stale lock is recovered without losing committed data or allowing a live duplicate writer |
| LF15 Redacted failures | Use unique synthetic environment/content canaries and exercise invalid requests | Canaries, cookies and pairing/session secrets do not appear in error/diagnostic output |
| LF16 Private control | Send a forged token to the fixture runtime's actual Unix control socket | The command is refused; the runtime remains live; the private token is not echoed |
| LF17 Bounded shutdown | Hold an authenticated document request open with only a partial JSON body, then stop the CLI | Shutdown completes within four seconds; no partial document is stored |
| LF18 Backup during stop | Observe a partial real snapshot file, then signal the foreground runtime to stop | Backup returns successfully; a fresh-root restore contains all 32 bounded synthetic notes with exact hashes |
| LF19 Authorization changes during requests | Start a valid task/document POST with only half its JSON body, then log out or let the session expire before finishing | Authorization is checked again; the response is 401 and a new session sees no created record |

Each test checks response status and the independently read result, rather than accepting an agent message saying that an action succeeded. Pairing and session tokens remain inside the test process and its child stdout capture; they are never written to the verification document. The explicit foreground CLI launch prints one fresh pairing code to its owner, which is necessary for browser pairing; ordinary errors, doctor output and private resource responses must not expose it. Tests may intentionally shorten expiry lifetimes and use random ports, but do not disable the request policy.

## Release boundaries

These checks do not establish working MCP tool discovery, Codex/Claude subscription integration, source-grant retrieval, D2L access, connector authorization, onboarding discovery, browser/computer control, or live external writes. Those features have separate acceptance gates in [Verification](../VERIFICATION.md). A dashboard browser walk-through is also distinct from the HTTP/process suite.

Cross-platform installation and file protection must be verified on each supported operating system. POSIX mode assertions on macOS/Linux do not prove Windows ACL behavior. Crash fixtures exercise one process-level interruption; they do not simulate all power failures, hardware faults or disk-full conditions.

The execution report must record the actual runtime/SQLite/OS versions, fixture-only scope, test counts and any failed or unimplemented gate. Documentation or fixture success must not be relabeled as full M1 completion.

## Observed run

On October 2, 2026, the command above completed with **29 PASS, 0 FAIL, 0 SKIP**: 17 HTTP tests and 12 separate-process/lifecycle tests. Environment: Node **v22.23.2**, **macOS arm64**, the installed pinned `better-sqlite3` **13.0.3** driver reporting SQLite **3.53.4**. The HTTP tests exercise the actual runtime with real requests; the lifecycle tests spawn the actual CLI and independently reopen persisted SQLite state. The request-policy tests do not replace the server or database with mocks.

The shutdown probe held a valid authenticated request open with an unfinished JSON body; graceful stop completed in approximately 1.8 seconds and the original records survived. The concurrent-backup probe observed a partial SQLite snapshot file before sending SIGTERM, then verified a completed backup and a fresh-root restore containing all 32 synthetic notes, each exactly 512,000 bytes, with their exact content and SHA-256 hashes. The slow-request authorization probes separately demonstrated that logout or session expiry before the body finishes results in 401 with no saved record.

No personal-data discovery, provider OAuth, model call, production deployment or live agent-host session was part of this run. Installation on a fresh computer and behavior on other platforms remain separate gates.
