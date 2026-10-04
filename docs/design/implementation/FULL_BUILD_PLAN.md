# Full build execution ledger

Started 2026-10-03. This ledger tracks implementation work, not a claim that the 29-feature design is already released. The existing hosted edition stays separate from private local storage.

## Execution loop

1. Read the feature's acceptance cases and identify the smallest useful complete flow.
2. Implement strict domain boundaries, persistence, runtime access, and usable dashboard controls in that order.
3. Exercise the actual storage/runtime path with synthetic student sources, including restart, stale revisions, cancellation, denial and recovery.
4. Verify the browser flow and saved result. Model text, a successful connection screen, or a preview alone is not completion.
5. Record measured evidence and exact live/platform gates. Continue independent work when a gate requires a student's login, consent, or unavailable platform.

## Ordered queue

| Stage | Features / work packages | Deliverable | Objective exit checks | State |
| --- | --- | --- | --- | --- |
| 1 | F27 / W07 | Durable run journal, checkpoints, budgets, leases and exact action review | Restart recovery; stale/forged approvals denied; no duplicate reconciled effects; cancellation stops new calls; read-back evidence required | Journal and action review verified; scoped Codex execution verified separately; general external-effect runner pending |
| 2 | F02/F03/F07 / W08/W10 | Reviewed profile, selected course library, source-version citations | Field review and conflicts survive restart; revoked/changed sources omitted; filtered retrieval and citation benchmark | Local text/PDF/Office/profile/library plus reviewed academic refresh/history verified; explicit metadata coverage onboarding verified; broad discovery pending |
| 3 | F04/F05/F09 / W12 | Explainable Today order and capacity-aware saved study-plan previews | Timezone/DST fixtures; dependency conflicts; explicit capacity deficits; revision-stale plans rejected | Local fixtures and browser flows verified |
| 4 | F25/F08/F10 / W11/W13/W14 | Official host execution, learning attempts and reviewed writing | Actual selected-host turn; interrupt/resume; no fallback; persisted attempt and exact accepted revision | Pinned embedded Codex tutor/task/document execution verified; attempts/writing/recipes verified; native resume and embedded Claude pending |
| 5 | F06 / W09 | Managed institution read integration | Student completes SSO; verified read against selected supported institution; expiry and no-write ledger | Fixed McMaster local browser/session transport implemented; 36 synthetic cases pass; real SSO and selected-course read pending |
| 6 | F11/F13/F24 | Verified artifacts, research and extension manifests | Provenance and hash read-back; source revocation; pinned tool classification; actual format checks | Local research, reviewed Markdown and literal Word text export verified; rich formats/extensions pending |
| 7 | F26/F14/F15/F16 / W15/W16 | Supervised browser and career workspace | Local fixture ATS; current-role evidence; drafts and attachments reviewed; no application submission | Manual career drafts/practice verified; actual browser/ATS/attachments pending |
| 8 | F12/F17/F22 / W17–W19 | Selected connected inbox/project reads and reviewed workflows | Per-account selected-source contract tests; real provider read gates; exact review and quiet schedule recovery | Manual Google Docs/Notion hosted-to-local transfer implemented with 52 targeted cases; deployment/live account transfer and background scheduling pending |
| 9 | F18–F21 / W20 | Meals, routines, budgeting and student administration | Deterministic recipes; reviewed preferences; no unsupported medical/financial conclusions or purchases | Local recipes/meal review/expense/routine slice verified; broader administration pending |
| 10 | F29 / W23 | Public setup funnel and optional adoption measurement | Clipboard success/fallback; anonymous event validation; enabled collection needs durable quotas/retention; local telemetry defaults off | Public setup published; optional collection remains disabled |
| 11 | F28 / W24 | Optional phone-to-local companion | Account/device binding, durable job redelivery, consent before transmission, fresh result-policy receipt and live phone round trip | Reviewed-result relay implemented and disabled; 28 targeted cases and 36 disposable SQL checks pass; live database/session/concurrency/purge/device gates pending |
| 12 | F23/F26 / W21/W22 | Optional native assistance, voice and selected sync | Supported OS/host proof, explicit capture consent, conflict and deletion tests | Queued; platform gates |

## Evidence rules

- Historical JSON verification reports remain historical. New reports identify the actual source hashes, commands, counts and limitations of this build.
- Synthetic fixtures prove deterministic boundaries; they do not prove Google/Claude/D2L entitlement, institution support or a public multi-user deployment.
- New production dependencies, provider configuration, publication and consequential external actions retain the repository's explicit approval requirements. Prepare reviewable work first; continue other stages while approval-dependent work waits.
- Private laptop discovery, personal source transmission and student account login are not installation side effects.

## Committed implementation stages

The entries below preserve the behavior, counts and remaining gates at each historical snapshot. The current ordered queue above and connected-workspace increment below supersede those earlier status descriptions.

- `c7fc221`: schema 3, durable runs/leases/actions and persistent workspace records.
- `75ba987`: cited course library, reviewed profile, Today/study planning and learning workflows.
- `e6f90ac`: reviewed writing, research, career, daily-life and productivity services with runtime-route fixtures.

Dashboard integration, the four-tool bridge, public setup and disabled host/remote/adoption foundations are being verified as subsequent stages. New source-snapshot evidence is recorded separately from the historical foundation reports.

October 3 follow-up: `73038d4` commits the integrated dashboard and four-tool bridge. Selected PDF text ingestion is implemented with additive schema v4 and independent native/storage/HTTP/MCP proofs; bounded DOCX/PPTX text ingestion now has an additive schema v5, exact section evidence and separate acquisition/storage/HTTP/MCP/browser checks; full rendering and rich output conversion remain later slices. Optional adoption/relay SQL has actual disposable PostgreSQL execution evidence, with production and mobile gates still disabled.

Latest verified stages: `59b2871` selected PDF/page evidence; `4492a48` public agent setup and disabled opt-in adoption. That prior snapshot passed 456/456; clean locked offline-cache install passes all nine phases; optional PostgreSQL verification passes 85 assertions plus five canonical hash probes. Native host isolation, actual university authorization and live phone release gates remain outstanding.

`086bd3d` commits the disabled owner-bound remote foundation and disposable SQL verification harness. Its native execution and result delivery remain unavailable.

`c194375` adds the verified selected Word/PowerPoint slice: schema v5, 18 acquisition tests, 12 storage tests and five HTTP/MCP tests, all included in the 491/491 full suite. The clean-copy install passed nine phases with 65 files and four MCP tools; desktop/mobile imports and exact browser-created backup restore passed. See [Office evidence](SELECTED_OFFICE_VERIFICATION.json). Rich rendering and genuine Office-authored corpus compatibility remain unverified.

The exact `cd2c78b` hosted snapshot is published, with anonymous setup/login checks and private-page sign-in redirects. [Deployment receipt](PUBLIC_SETUP_DEPLOYMENT.json) records that release. The later `1b9bb4f` Office setup wording is also published with a [separate receipt](PUBLIC_SETUP_OFFICE_DEPLOYMENT.json), committed in `73137b7`. Adoption and remote endpoints remain disabled.

The next local academic refresh slice passes 532/532 automated tests, including 17 domain, 16 persistence and eight actual paired-HTTP cases. Review binds the exact scope, source observation, base revision and before/after changes; one atomic SQLite transaction publishes snapshot/head/receipt. Missing/conflicting material is excluded from current search, earlier versions need an explicit history read, and semantic matches do not duplicate content. Real SQL errors and SIGKILL roll back cleanly. Browser deadline/missing/dedup/history flows, desktop/mobile layout and exact browser-created restart/fresh restore passed; the final clean install passed nine phases with 66 files and four MCP tools. See [academic refresh evidence](ACADEMIC_REFRESH_VERIFICATION.json). No live D2L authentication, automatic task update or provider/model invocation is implied.

The October 4 guided onboarding slice adds Get started, explicit purpose/category/record selection, metadata coverage with next steps, exact reviewed reports and stale-report readback. All 571 automated cases pass, including 39 onboarding cases. Nine clean-install phases pass with 69 files, ten assets and four MCP tools. Browser default/candidate/confirmation/partial course/report/profile-change flows and exact saved metadata readback/reopen/fresh restore passed. See [guided onboarding evidence](GUIDED_ONBOARDING_VERIFICATION.json). No original-file discovery, new sharing permission, host authentication/model call, provider configuration, dependency or migration was added.

The October 4 literal Word export slice preserves the exact accepted or applied saved copy, source pins and academic/fact-review labels in a deterministic six-part package. All 618 automated cases pass, including 47 new export checks. Nine clean-install phases pass with 70 files, ten assets and four MCP tools. The browser saved two identical Word files and exact Markdown; independent package parsing, native readers, single-fixture rendering and fresh backup restore passed. The IAB download watcher timed out despite filesystem-confirmed files; that limitation is recorded. [Word export evidence](WORD_TEXT_EXPORT_VERIFICATION.json) retains exact source hashes and remaining rich-format/live gates.

## October 4 connected-workspace increment

These additions implement four controlled workflows. Their targeted checks and actual native-host proof are distinct from the still-pending provider and public-release gates; they do not complete the whole feature catalogue.

| Increment | Implemented behavior and observed evidence | Remaining gate |
| --- | --- | --- |
| Embedded Codex | Separate official ChatGPT sign-in, pinned Codex 0.154.0 app-server, ephemeral project and live-authority lease, selected MCP context, structured answer and bounded pending task/document proposals. An actual native turn with synthetic sources completed all four stable MCP RPCs; pending proposals were read back, accepted task count stayed zero and the original source stayed unchanged. The runtime executes the verified RPCs around the model turn; it does not claim that the model independently issued them. [Execution contract](LOCAL_CODEX_EXECUTION.md). | Each installation still needs its own compatible official host, normal login, account entitlement and exact source grant. Native resume and embedded Claude are not implemented. |
| D2L/Avenue | Fixed McMaster institution, visible official Chrome with a temporary private profile and pipe transport, browser-session identity checks, read-only selected courses/categories and exact reviewed academic refresh. All 36 transport/service/paired-HTTP/UI cases pass. The real Chrome launch was observed. [Institution/session contract](LOCAL_D2L_BROWSER.md). | The student must complete real school SSO/MFA; an actual authorized selected-course read, expiry and disconnect remain unverified. Fixture data and a launched browser do not establish university authorization. Other institutions require their own audited profiles. |
| Selected cloud onboarding | Student-owned Google Docs/Notion account metadata search, one to three explicit selected text reads, complete review and manual transfer file, followed by separate paired local owner confirmation, exact import/readback and recovery. All 52 targeted hosted/local/SDK/UI cases pass. Official pinned tool-schema probes succeeded without reading personal content. [Selected transfer contract](SELECTED_CLOUD_ONBOARDING.md). | Deploy the new hosted page/routes and verify a real signed-in student's selected read/export, actual file save and local import/readback. Tool-schema probes and fixtures do not prove account access. No broad discovery, automatic profile confirmation or model-sharing grant is added. |
| Phone companion | Outbound-only pairing, bounded selected study dispatch, pending Writing review, separate exact result consent, durable outbox, upload acknowledgment recovery and fresh one-use delivery. All 28 targeted HTTP/SQLite/handler/UI cases and 36 disposable PostgreSQL checks pass, including fresh-backup restore and old-result/new-binding denial. [Reviewed result contract](REMOTE_REVIEWED_RESULTS.md). | Keep release flags off until the production migrations, real Supabase session/owner behavior, multi-worker concurrency, scheduled purge canaries and physical phone round trip are verified. Synthetic relay/native fixtures do not establish live phone delivery. |

The final source-bound receipt for this coordinated increment is `CONNECTED_WORKSPACE_VERIFICATION.json` in this directory; its creation is pending final whole-project verification. It will record current source hashes, aggregate checks, clean installation/build results, actual native receipts and each remaining live gate. The earlier 618/571/532-pass reports above retain their historical snapshots and are not the count for this increment.
