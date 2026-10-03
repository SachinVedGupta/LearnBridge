# Agent bridge and controlled academic sources

Planned October 2, 2026; implemented and verified October 3, 2026, after committing the W03–W05 foundation. This slice starts W06–W09 with an explicit initial capability boundary; it does not claim every run/profile/platform gate is complete. See [measured evidence](AGENT_SOURCE_VERIFICATION.json) and [student setup](../../LOCAL_AGENT_SETUP.md).

## Implementation order

1. Preserve the hosted edition. Use the existing daemon as the sole SQLite writer. Add transactional migrations for human-reviewed agent sharing, source inventories/selected immutable text, and task proposals with exact human acceptance.
2. Add a stdio MCP server using the official SDK. Status is non-content; private workspace/source reads require an active destination-specific grant issued by the paired dashboard. Tools may read bounded approved context and propose a local task. They cannot grant consent, accept their own proposals, run a shell, send messages, submit assignments or read arbitrary files.
3. Generate project-scoped Codex/Claude registration as a preview/expected-hash merge, preserving unrelated settings. No global config, credential copying, permission bypass or API fallback. Verify real SDK discovery and a synthetic read/propose/human-accept workflow. Probe the installed official host separately; missing Claude or host permission is a separate live limitation.
4. Add deterministic local text/Markdown inventory and extraction for explicitly selected roots. Inventory is metadata-only and bounded. Exclude secret/system/dependency directories and symlinks. Pin inventory object/directory identities; validate opened file identity before body reads and versions after reads. Selected content approval and remote-agent processing approval are separate. Unsupported formats remain explicit.
5. Add an independent academic adapter inspired by the pinned Avenue audit. Normalize reviewed exports first, then provide an allowlisted local MCP read boundary and institution capability report. No upstream code vendoring without notices, no university token in the hosted website, no reused developer browser session, no arbitrary MCP execution from model input. Live SSO/MFA and institution reads require an actual student session; fixture proof is separate.

## Concrete dependency proposal

The reviewed and installed direct dependencies are `@modelcontextprotocol/server` **2.3.0** and `@modelcontextprotocol/client` **2.3.0** (Apache-2.0), plus `zod` **4.6.5** (MIT). The user authorized proceeding after the dependency proposal. All are exact pins with locked transitive resolutions. Server/client are required only by the local bridge/adapter; the existing hosted Zod major stays unchanged. No browser automation or cloud/model SDK was added in this slice.

Sources: [official MCP server SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server), [official SDK package boundaries](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages), [Codex MCP project configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude project MCP configuration](https://code.claude.com/docs/en/mcp), [Avenue audit revision](https://github.com/alanxue1/avenue-mcp/tree/9f996323641aba91cc0bbf2b21efd429f9a465e1).

## Objective verification

- Actual SDK client spawns stdio server; discovery schemas match a fixed allowlist; stdout contains protocol only; EOF/shutdown terminates the child.
- Real daemon IPC refuses forged/expired/revoked sharing, wrong destination, approval/grant forgery and unselected content. A same-OS-user program is outside the sandbox claim, but an MCP call has no human-approval operation.
- A proposal produces zero tasks before paired-dashboard acceptance; exact acceptance saves one task, replay returns the same task, stale/changed proposals fail, and restart retains evidence.
- An instrumented synthetic tree proves no body reads during inventory, secret/symlink/unselected exclusion, hard budgets, file/root/parent swaps, changed versions and exact selected import hashes. Remote output contains only destination-approved records and obeys persisted budgets/revocation.
- Academic fixtures preserve stable IDs, raw deadlines/unknown precision, duplicate/change coverage, expired authorization and disabled write/unknown tool rejection. Live institution support is not claimed from fixtures.
- Existing foundation and hosted tests/build remain passing; schema upgrade/backup/restore and missing-config paths retain prior data.
- Save actual versions, source hashes, assertions, host-specific results and unresolved gates. Commit completed verified stages; pushing/deploying remains separate.

## Completed slice and next gates

The implemented dashboard can inventory a selected folder, import exact selected text, collect separate destination-specific agent-sharing consent, review pending proposals and accept each exactly once. Real official-SDK transport and a real installed Codex CLI completed synthetic workflows. The academic package supports reviewed exports and a bounded read adapter; an export becomes a reviewed note rather than an automatic task.

Live Claude host execution remains unverified because Claude is not installed on this machine. Live D2L needs an institution-specific local login/session and sanitized transport; the upstream Avenue server is not enabled unchanged. Full profile synthesis, PDF/Office extraction, cloud onboarding, durable orchestration and browser/computer action review follow this slice. Those capabilities need their own acceptance checks and actual authorization, rather than being inferred from these fixtures.
