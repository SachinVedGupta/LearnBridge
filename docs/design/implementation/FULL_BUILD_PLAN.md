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
| 1 | F27 / W07 | Durable run journal, checkpoints, budgets, leases and exact action review | Restart recovery; stale/forged approvals denied; no duplicate reconciled effects; cancellation stops new calls; read-back evidence required | Journal and action review verified; executing host gate remains |
| 2 | F02/F03/F07 / W08/W10 | Reviewed profile, selected course library, source-version citations | Field review and conflicts survive restart; revoked/changed sources omitted; filtered retrieval and citation benchmark | Local selected-text/library/profile slice verified; broad onboarding pending |
| 3 | F04/F05/F09 / W12 | Explainable Today order and capacity-aware saved study-plan previews | Timezone/DST fixtures; dependency conflicts; explicit capacity deficits; revision-stale plans rejected | Local fixtures and browser flows verified |
| 4 | F25/F08/F10 / W11/W13/W14 | Official host execution, learning attempts and reviewed writing | Actual selected-host turn; interrupt/resume; no fallback; persisted attempt and exact accepted revision | Attempts/writing/recipes verified; embedded host disabled and native resume pending |
| 5 | F06 / W09 | Managed institution read integration | Student completes SSO; verified read against selected supported institution; expiry and no-write ledger | Queued; live login gate |
| 6 | F11/F13/F24 | Verified artifacts, research and extension manifests | Provenance and hash read-back; source revocation; pinned tool classification; actual format checks | Local research and reviewed Markdown verified; rich formats/extensions pending |
| 7 | F26/F14/F15/F16 / W15/W16 | Supervised browser and career workspace | Local fixture ATS; current-role evidence; drafts and attachments reviewed; no application submission | Manual career drafts/practice verified; actual browser/ATS/attachments pending |
| 8 | F12/F17/F22 / W17–W19 | Selected connected inbox/project reads and reviewed workflows | Per-account selected-source contract tests; real provider read gates; exact review and quiet schedule recovery | Manual updates/briefing/checklists verified; local cloud reads/background scheduler pending |
| 9 | F18–F21 / W20 | Meals, routines, budgeting and student administration | Deterministic recipes; reviewed preferences; no unsupported medical/financial conclusions or purchases | Local recipes/meal review/expense/routine slice verified; broader administration pending |
| 10 | F29 / W23 | Public setup funnel and optional adoption measurement | Clipboard success/fallback; anonymous event validation; enabled collection needs durable quotas/retention; local telemetry defaults off | Public setup published; optional collection remains disabled |
| 11 | F28 / W24 | Optional phone-to-local companion | Account/device binding, durable job redelivery, consent before transmission, fresh result-policy receipt and live phone round trip | Disabled protocol foundation verified in fixtures and disposable SQL; live Supabase/mobile/host gates pending |
| 12 | F23/F26 / W21/W22 | Optional native assistance, voice and selected sync | Supported OS/host proof, explicit capture consent, conflict and deletion tests | Queued; platform gates |

## Evidence rules

- Historical JSON verification reports remain historical. New reports identify the actual source hashes, commands, counts and limitations of this build.
- Synthetic fixtures prove deterministic boundaries; they do not prove Google/Claude/D2L entitlement, institution support or a public multi-user deployment.
- New production dependencies, provider configuration, publication and consequential external actions retain the repository's explicit approval requirements. Prepare reviewable work first; continue other stages while approval-dependent work waits.
- Private laptop discovery, personal source transmission and student account login are not installation side effects.

## Committed implementation stages

- `c7fc221`: schema 3, durable runs/leases/actions and persistent workspace records.
- `75ba987`: cited course library, reviewed profile, Today/study planning and learning workflows.
- `e6f90ac`: reviewed writing, research, career, daily-life and productivity services with runtime-route fixtures.

Dashboard integration, the four-tool bridge, public setup and disabled host/remote/adoption foundations are being verified as subsequent stages. New source-snapshot evidence is recorded separately from the historical foundation reports.

October 3 follow-up: `73038d4` commits the integrated dashboard and four-tool bridge. Selected PDF text ingestion is implemented with additive schema v4 and independent native/storage/HTTP/MCP proofs; bounded DOCX/PPTX text ingestion now has an additive schema v5, exact section evidence and separate acquisition/storage/HTTP/MCP/browser checks; full rendering and rich output conversion remain later slices. Optional adoption/relay SQL has actual disposable PostgreSQL execution evidence, with production and mobile gates still disabled.

Latest verified stages: `59b2871` selected PDF/page evidence; `4492a48` public agent setup and disabled opt-in adoption. That prior snapshot passed 456/456; clean locked offline-cache install passes all nine phases; optional PostgreSQL verification passes 85 assertions plus five canonical hash probes. Native host isolation, actual university authorization and live phone release gates remain outstanding.

`086bd3d` commits the disabled owner-bound remote foundation and disposable SQL verification harness. Its native execution and result delivery remain unavailable.

`c194375` adds the verified selected Word/PowerPoint slice: schema v5, 18 acquisition tests, 12 storage tests and five HTTP/MCP tests, all included in the 491/491 full suite. The clean-copy install passed nine phases with 65 files and four MCP tools; desktop/mobile imports and exact browser-created backup restore passed. See [Office evidence](SELECTED_OFFICE_VERIFICATION.json). Rich rendering and genuine Office-authored corpus compatibility remain unverified.

The exact `cd2c78b` hosted snapshot is now published, with anonymous setup/login checks and private-page sign-in redirects. [Deployment receipt](PUBLIC_SETUP_DEPLOYMENT.json) records that release; adoption and remote endpoints remain disabled. The later Office setup wording is prepared separately.
