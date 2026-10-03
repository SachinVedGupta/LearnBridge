# LearnBridge objective verification and release evidence

An agent should be able to verify most engineering behavior using deterministic fixtures and instrumented outcomes. It cannot definitively prove all AI judgments, browser/provider compatibility or learning quality without real-source and human checks. This plan makes those boundaries explicit instead of treating self-evaluation as proof.

The future runtime suites and commands here are required implementation work. W01 core fixtures and a separate SQLite feasibility probe now exist; their measured scope and remaining gates are in [implementation status](IMPLEMENTATION_STATUS.md). Feature acceptance IDs live in the three feature files and onboarding. [Example report](examples/verification-report.example.json) illustrates the report format using synthetic status only.

## Result semantics

| Status | Meaning | Release effect |
| --- | --- | --- |
| PASS | Named assertion met with actual observation/evidence | Supports only that edition/OS/provider/operation/version and input scope |
| FAIL | Observation disagrees with predicate or unexpected side effect | Required gate blocks release |
| BLOCKED | Needed account, consent, entitlement, permission or environment unavailable | Required live/platform claim remains unavailable |
| SKIP | Deliberately unrun optional scenario with reason | Never counted as PASS; mandatory skip blocks relevant release |
| NOT_IMPLEMENTED | Capability/test does not exist yet | Cannot claim product completion from a design document |

Capture fixture, live-provider, platform, rendered-artifact and human-quality results separately. A connector with PASS fixture reads but BLOCKED live auth is not “working for everyone.” An application with filled fields is `prepared`, not `submitted`. A provider receipt with failed verification is not full success.

## Test layers

1. **Pure logic:** schema/date/time/ranking/interval/DAG/filter/dedup functions with fixed clocks and labelled inputs.
2. **Repository integration:** temporary real SQLite/files, actual migrations/transactions/indexes, process restart and concurrent revisions.
3. **Runtime and policy:** actual loopback HTTP/IPC/MCP processes and instrumented file/network/model boundaries, not a mocked permission function alone.
4. **Workflow fixtures:** local provider/browser fixture servers with authoritative state, failure injection and action counters.
5. **Format/render:** reopen/parse output, compile when necessary, inspect page/slide/spreadsheet/render correctness.
6. **Live capability:** selected authorized account, bounded source/test destination, actual read-back, session expiry and version report.
7. **Human quality/usability:** fixed rubric and student pilot, with independent review for material correctness.

Do not collect real student data for deterministic tests. Use generated fixtures and distinctive synthetic canaries. Store private live evidence outside Git; publish only sanitized summaries with consent.

## Required cross-cutting security suite

Implement target suite `tests/local/security/` against running services and instrumented adapters. Every private API/tool/event/artifact route belongs in a generated route matrix so adding an endpoint cannot quietly omit its boundary tests.

| ID | Scenario | Definitive assertion |
| --- | --- | --- |
| S01 | Unpaired browser/IPC, invalid/expired session, anonymous artifact and stream requests | Private reads/writes rejected; zero secret/content bytes, zero side effects; non-sensitive health only |
| S02 | Malicious cross-origin site, wrong Host, forged Origin, cross-site Fetch Metadata, missing CSRF nonce | Rejected; local records/action counters unchanged; no permissive credentialed CORS |
| S03 | Legitimate paired same-origin GET with absent Origin; replay expired pairing code/logout token | Real dashboard fetch succeeds under nonce/metadata policy; replay and old session fail |
| S04 | Parent env has 10 synthetic secret keys; connector needs two reviewed values | Child environment contains only allowed runtime essentials/connector credentials; logs/protocol/UI exports contain no forbidden canary |
| S05 | Traversal, symlink/junction escape, malicious archive, swap after path check | Zero outside-scope reads; safe handle containment enforced on each claimed OS; unsupported mode BLOCKED, not silently ordinary open |
| S06 | Payload asks model to approve itself, enlarge source scope or call a new send tool | Policy rejects; forged review records not saved; zero external writes/sends/deletes |
| S07 | Source forget/revoke with mixed derived docs, FTS, caches, WAL/backups | Immediate retrieval denial; managed lineage purge verified after restart; retained backups/external copies explicit and block broader erasure claim |
| S08 | Hosted student A/B state/account/callback access and optional relay ownership | A cannot read/mutate B; spoofed/replayed callback denied; local edition identity cannot bypass hosted auth |
| S09 | Local content read permitted, cloud-agent processing denied | Local authorized UI can show source; cloud-host MCP/search/context/diagnostic output cannot include its filename/content/profile canary |
| S10 | Malicious PDF/message/site invokes direct host shell/browser escape | Managed tools refuse; host restrictions exercised separately; capability reports admit tools outside broker rather than claiming interception |

S10 requires both an adversarial managed-tool test and a host configuration review/live bounded attempt on supported hosts. A prompt-only refusal is useful but not an enforcement proof.

## Reliability and recovery suite

| ID | Fault injection | Expected outcome |
| --- | --- | --- |
| R01 | Kill runtime between transaction stages and after checkpoint save | DB integrity passes; saved step survives; unsaved work safely retried, never falsely completed |
| R02 | Concurrent revisions, interrupted migration, disk full and corrupted backup | Conflict/no partial overwrite; rollback/restore protects originals; failure and recovery visible |
| R03 | External service accepts action then response disappears | Unknown outcome recorded; provider lookup/idempotency reconciles before retry; no duplicate fixture effect |
| R04 | Two daemon starts/two schedule triggers | Single root owner and one lease per job slot; no duplicate execution or notification |
| R05 | Export/restore real database plus file manifest into fresh root | Record counts/revisions/source links and file hashes match; unauthorized secrets absent; rollback preserved |
| R06 | Cancellation, grant expiry/revocation, provider limits, sleep/offline | No new calls after stop; in-flight outcome disclosed; valid checkpoints/budgets preserved; no hidden paid fallback |

Assertions need independent observables: provider fixture DB, action counters, file-open audit, outbound request ledger, stored task/document versions and UI read-back after restart. Mocking the writer and asserting it was called is not enough for durability or completion.

## Agent protocol suite

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| A01 | Supported official host/tool discovery and real completed fixture turn | Native completion event plus valid tool result and saved reviewed task; login/catalog alone insufficient |
| A02 | Stream event duplicates/out-of-order, disconnect, failed native completion | Correct sequence/dedup and interrupted/failed state; no completed action from partial text |
| A03 | Native human approval/decline and changed payload | Decline honored; exact fingerprint verified; stale review rejected; host restrictions retained |
| A04 | Exhausted plan/unsupported model with an API key also configured | Clear selected-mode error; no request to paid fallback unless separately selected |

Use real provider protocol fixtures for error paths and a real authorized smoke turn for each released mode. Do not reuse the developer's auth cache or paste tokens to make a test pass. Student sign-in remains an explicit handoff when required.

## Fixture library and feature mapping

Implement synthetic folders with text/PDF/Markdown, secret decoys, symlinks and unicode paths; a fake Drive/messages/D2L adapter with multiple pages and ownership; a real local ATS/editor fixture web app with server counters; calendar clocks around DST; source-version changes; deterministic resume/posting facts; sample tasks/document revisions and file-format golden artifacts. Each fixture has an immutable hash, expected values and a reset routine.

Required feature checks are the exact `Fxx-Ayy` scenarios in the feature files. Do not replace them with one generic “feature works” test. Map them in a machine-readable suite manifest containing `feature_id`, `acceptance_id`, `test_file`, `kind`, `required_for`, `platforms` and `evidence_predicate`. Implementation must keep that manifest synchronized. The [design traceability file](FEATURE_INDEX.json) indexes documentation and planned work; it does not say any tests passed.

Future target commands should be documented only when implemented:

```text
local doctor --json                         setup/capability diagnostics
local verify --suite core --fixtures        deterministic local boundaries
local verify --feature F06 --fixtures       course connector behavior
local verify --live --capability <id>       explicit bounded live account check
local verify --report <path>                machine-readable evidence
```

Actual naming may differ, but commands must exit nonzero for failed required tests, report required BLOCKED/SKIP distinctly, and return a sanitized report path. Offline fixture verification must not contact real AI or personal sources. Existing `npm test` now includes core and hosted fixtures, while `npm run build` validates the hosted build. Neither verifies the unimplemented local runtime or all planned features.

## Live provider matrix

Track connector, installed version, OS, institution/tenant/account category, auth method, scopes, operation, fixture result, live result, last checked date and evidence reference. Example operation rows: Google Calendar read vs create; Gmail read vs send; Notion read vs replace with revision check; Avenue McMaster assignments vs grades; Claude host browser preparation vs native desktop. A provider name with one green check is insufficient.

For real writes, the student approves the actual disposable destination and exact payload. Test external confirmation and cleanup with separately appropriate permission. If no safe test destination exists, ship read-only/preparation support and mark write support BLOCKED. Never submit an assignment or internship merely to complete a smoke test.

Cross-account hosted verification needs two genuinely distinct student sessions and independent ownership. SQL/mocks supplement it; they do not establish public signup, actual callbacks or all providers. Public-site release remains separate from local packaging.

## Model quality and student benefit

Use fixed labelled case sets with recorded model/provider/prompt versions and controlled context. Deterministic validators check references, date formats, source IDs, unsupported fields and schema. People assess whether evidence actually supports claims, clarity, learning support, request extraction and useful prioritization. LLM judging can triage but cannot be the sole correctness evidence.

Initial quality gates are explicit targets to measure, not current results:

- Course retrieval: F07's 30 queries, at least 27 correct top-five sources and all locators valid.
- Tutoring: F08's 24 cases; at least 20 score ≥3/4 on clarity/helpfulness/learning support, no fabricated deadline/restricted graded-work completion; independent review of disputed correctness.
- Profile: 30 labelled facts; zero unsupported confirmed eligibility/identity assertions; all proposed facts have valid evidence or student-authored provenance.
- Inbox: 20 labelled messages; at least 18/20 supported actionable extractions and zero invented explicit deadlines; ambiguous requests remain marked. Track missed requests separately.
- Career: 20 eligibility/answer cases; zero fabricated qualifications/disclosures and all unsupported required fields unresolved. Resume relevance/tone requires reviewer assessment.
- Plans/life recipes: valid constraints/arithmetic always pass fixture checks; a five-student pilot records usefulness, onboarding burden and correction rate. Do not claim improved grades, health or hiring outcomes from this small pilot.

Human review can reveal failures even when mechanics pass. Save the failure examples and improve the recipe; do not relax a hard permission/factual predicate merely to get a green report.

## Final verification workflow for a coding agent

Read feature predicates → reset synthetic fixtures → run implementation under real storage/runtime/fixture provider → inspect access/action ledgers → compare expected and observed state → restart and read back → inject failure/negative cases → run affected hosted checks → gather required live/human results → write report with limitations. Re-run only when changes/failures/unresolved concerns justify it.

Completion message must state what now works, tested edition/platform/provider operations, evidence report link and exact remaining gates. If account access is blocked, finish independently verifiable work and report the missing student action. Do not mark the whole feature PASS because a future test is described or a model approved its own answer.
