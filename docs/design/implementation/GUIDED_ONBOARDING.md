# Guided local onboarding and reviewed coverage

This increment adds **Get started** to the paired local dashboard. It checks metadata for records the student explicitly selects, explains gaps, links to the relevant workspace section and saves an exact reviewed coverage report. It is the narrow guided setup portion of F02/F03; the broader [discovery and profile design](../ONBOARDING.md) remains a staged specification.

The service performs no original-file read, folder discovery, connected-account query, profile synthesis, new sharing grant, host registration or model call. It inspects existing managed records to validate their revisions, hashes, review states and permission metadata. Responses and saved reports omit profile values, note/imported/course bodies, original folder paths and PDF/Office page or section text. IDs, titles, field names and hashes are still private metadata; this is a paired local feature, not anonymous telemetry.

The dated [execution receipt](GUIDED_ONBOARDING_VERIFICATION.json) records **571/571 full-suite passes**, including 39 onboarding cases, a nine-phase clean installation, a successful hosted build and actual browser-created report readback/reopen/fresh restore. The contract and test mapping below describe what must be checked; they do not certify a live host, university session or the entire feature catalogue.

## Student flow

1. Start the local runtime, open its actual loopback address and pair. Choose **Get started** from the menu or **Make it yours** on Today.
2. Choose a purpose: student workspace, learning, career, meals or budget. All category and record checkboxes begin unchecked; no Codex/Claude destination is selected.
3. Include the parts you want to check. Choose existing records individually, or leave a requested part empty to see its next setup step. **Open Profile**, **Open Sources**, **Open Courses** and **Open Agent review** navigate to the existing review/import controls. They grant nothing automatically.
4. Choose **Preview my setup coverage**. Review the selected record metadata, status, limitations, next action and exact fingerprint. A blank requested part remains awaiting the student; unrequested parts are labelled not selected.
5. Choose **Save this reviewed setup report** and confirm the exact purpose, category selection, record counts, host choice and fingerprint. The saved report contains metadata and limitations only. It does not import files, confirm profile statements, create consent, install a bridge or contact a host.
6. Use the next-step links to add useful records or separately review access. Return and refresh available records before preparing a new coverage report. A saved report whose selected records or permissions changed is labelled **Needs a fresh check**; its original evidence is retained.

The UI distinguishes **imported records**, **existing sharing** and **actual host connection**. A selected permission may be valid while actual host login, tools and model execution remain untested. Saving a report cannot turn those three checks into one “setup complete” claim.

## Exact selection contract

The HTTP preview sends all fields below. The service canonicalizes UUIDs to lowercase, sorts each ID array and keeps category order fixed. IDs must be unique both within and across arrays. Selection validation rejects extra fields, malformed IDs and incompatible category placement before building a report.

```js
{
  purpose: 'general',
  requested: [], // profile, local_files, academic_exports, agent_bridge
  profile_ids: [],
  source_entry_ids: [],
  snapshot_ids: [],
  document_ids: [],
  agent_grant_ids: [],
  destination: null // null, codex or claude
}
```

Allowed purposes are `general`, `learning`, `career`, `meals` and `budget`. The service may default omitted ID arrays for a trusted direct caller; the paired HTTP contract requires the complete field set. Empty selections are valid and return next steps without inventing completed setup.

| Requested category | Permitted selected records | Check and limitation |
| --- | --- | --- |
| `profile` | `profile_ids` | Saved review state, stale/conflict flags, evidence provenance and compatibility with the selected purpose. A candidate stays a candidate. Facts are student statements, not independently verified identity or mastery. |
| `local_files` | `source_entry_ids` | Existing imported text/Markdown/PDF/DOCX/PPTX snapshots, owning source state and retained extraction coverage. No original-file freshness or folder completeness check occurs. |
| `academic_exports` | `snapshot_ids` | Current saved academic snapshots, exact snapshot/stream versions and source-reported coverage. Historical or forgotten versions cannot be selected as current. Live D2L authorization and source freshness remain unchecked. |
| `agent_bridge` | `document_ids`, `agent_grant_ids`, optional `destination` | Prepared private note metadata and existing destination-specific permission metadata. Notes remain local unless separately granted. Host authentication, tool catalogue, subscription availability and a real turn remain unchecked. |

Private notes belong under **agent_bridge**, not local file acquisition. Choosing a note here does not read its body into a host context. A selected grant requires an explicit destination and must belong to that destination. The UI disables grant checkboxes until a matching host is chosen, and clears mismatched choices when the destination changes. Other IDs require their corresponding requested category; a destination is invalid when agent_bridge is not requested.

The limit is **40 total IDs across the five arrays**, with each array also limited to 40. Selecting a category never expands selection to every record in that category. There is no select-all, inferred account identity, automatic host destination or broad personal-data search.

## Catalogue and coverage states

`GET /onboarding/catalog` returns `schema_version`, `profile`, `source_entries`, `snapshots`, `documents`, `grants`, `catalogue_coverage` and `limitations`. Each list is capped at 200 metadata records. An overflow yields `catalogue_coverage.state: partial` plus an explicit reason; it is not a complete account, laptop or source inventory.

Profile metadata includes field name, revision, review state, stale/conflict flags and allowed purposes, without values. File metadata includes title, source ID, revision, format and retained extraction coverage, with `origin_freshness: not_checked`. Academic metadata includes title, current snapshot hash, stream ID/revision, selected course IDs, reported retrieval time and coverage, with `coverage_claim: source_reported`. Notes include ID, revision and title. Grants include destination, state, expiry, byte budget/use and record counts; grant pins and record bodies are not catalogue content.

The four coverage rows are always present:

| State | Exact meaning in this increment |
| --- | --- |
| `not_requested` | The student did not include this category. It has not passed a setup check. |
| `awaiting_student` | A requested part has no selected records, profile statements need review or purpose correction, or a host destination/existing permission has not been selected. |
| `ready` | The selected metadata checks for profile, local files or academic exports passed under their stated limitations. It does not establish complete source coverage or whole-app readiness. |
| `partial` | Selected file/export coverage is incomplete, or existing agent permission checks passed while actual host checks remain unperformed. Agent-bridge coverage never becomes ready from permission metadata alone. |
| `stale` | Selected profile evidence or existing agent permission is no longer current, or a sharing budget is exhausted. A missing/unavailable selected record instead refuses the new selection. |

For profile readiness, every selected fact must be confirmed, current, nonconflicting and compatible with the requested purpose. A stale fact yields stale; candidates, conflicts and purpose mismatches remain awaiting student review. Saved source coverage must be complete for local-files readiness; Office text remains partial. All four academic category states must be complete for academic readiness, and even those labels are source-reported. Unknown dates or complete-export labels are not independently verified here.

The overall state is `awaiting_student` if no category was requested or any selected category awaits the student; otherwise `partial` if any requested category is not ready; otherwise `review_ready`. The UI labels `review_ready` **Ready to review this coverage report**. It never means the laptop, cloud accounts, university access or actual host connection are fully configured.

## Exact preview, pins and saved report

A preview has the following shape:

```js
{
  format: 'learnbridge-onboarding-preview', schema_version: 1,
  selection, observed_at, pins,
  coverage: [{ category, state, checked_count, items, limitations, next_step }],
  overall, review_hash
}
```

`items` contain metadata only. `next_step` has a supported local page and a plain-language action. The fingerprint binds the canonical selection, observation time, exact pins, coverage items, limits, next steps and overall status. A supplied hash alone never authorizes a changed selection.

| Pin | Bound evidence |
| --- | --- |
| Profile fact | Record revision/fingerprint, review state, stale/conflict flags and purpose compatibility. |
| Imported snapshot | Revision, text hash, acquisition version, inventory/source IDs, current source revision/state, extraction-provenance hash and coverage. |
| Academic snapshot | Snapshot revision/hash, current stream ID/revision and coverage hash. An unchanged later academic observation still advances its stream revision and invalidates an old pending coverage preview. |
| Prepared private note | Document revision and content hash, without body text. |
| Existing agent grant | Revision, destination, effective expiry/state, cumulative byte budget/use, underlying selection hash and current permission verification. |

Before a new save, the service validates the preview shape and fingerprint, rebuilds the selected checks from current managed records using the preview's observation time, and compares the complete fingerprint. Corrections, edits, academic head changes, source/grant revocation, expiry and stale underlying grant pins refuse the old save with no report write. This revalidation does not spend an agent context budget or invoke the model.

The saved record is a private workspace `artifact` with `data.format: onboarding_report`. It retains the preview fields, a human-review receipt (`reviewer`, `reviewed_at`, `decision: saved_coverage_report`) and the creation operation. Its title is `Reviewed <purpose> setup coverage`. Persisted readback checks the actual record against the intended data. This uses the existing versioned artifact store and adds no database migration or production dependency.

Read/list responses augment the immutable record with computed `needs_refresh` and `refresh_reasons`. Rebuilding current checks may produce `selected_record_or_permission_changed`, `selected_record_unavailable_or_no_longer_current` or `selected_metadata_now_exceeds_review_budget`. The last state preserves an originally valid report when current selected metadata has grown too large for a new preview; choose fewer records in a fresh check. Invalid stored historical evidence still fails validation. The old report is not rewritten into a new current report. It remains an explicitly stale historical coverage snapshot and has no content-sharing authority.

An exact save retry for a retained preview/key returns the same report. Reusing a key for a different review is rejected. A forgotten idempotent report cannot be resurrected by a retry. Removal requires its exact report revision and does not remove underlying notes, imports, profile facts, courses, grants or tasks. Database revisions and backups may retain the report; this is active-view forgetting, not selective physical erasure.

## Paired HTTP and dashboard boundaries

These paths are relative to `/api/local/v1`. All reads and writes require the paired local cookie and current request nonce; writes also require the local origin and existing strict body checks. The server stores the preview and assigns its retry key. Clients cannot submit an arbitrary report, consent receipt, reviewer, hash replacement or source pins as save authority.

| Route | Request / response |
| --- | --- |
| `GET /onboarding/catalog` | Saved metadata catalogue, coverage and limitations. |
| `POST /onboarding/preview` | Complete selection object → `{preview_id, preview}`. No record or permission is saved. |
| `POST /onboarding/reports` | `{preview_id, review_hash}` → `{item}` with status 201. Saves one exact reviewed artifact. |
| `GET /onboarding/reports` | `{items}` containing saved reports and current refresh flags. |
| `GET /onboarding/reports/:id` | `{item}` for one owned saved report; wrong-kind/foreign/unavailable IDs reject. |
| `DELETE /onboarding/reports/:id` | `{expected_revision}` → deletion/retention metadata. Stale revisions reject. |

Previews last five minutes, are bound to the reviewing session nonce and are cleared when the runtime closes. The cache holds at most ten previews. Successful saves mark previews consumed; when capacity is needed, the oldest consumed previews are reclaimed before refusing a new preview. Pending reviews are not evicted for capacity. Exact retries work while retained; expired, evicted or different-session previews return `403 CONSENT_REQUIRED` without a new effect. Ten pending previews cause the next preview to return `429 RATE_LIMITED`; saving one or waiting for expiry restores capacity.

Typical refusals are `400 INVALID_INPUT`, `401 AUTH_REQUIRED`, `403 CONSENT_REQUIRED/SCOPE_DENIED`, `409 REVISION_CONFLICT/VERSION_MISMATCH`, `413 BUDGET_EXCEEDED` and `429 RATE_LIMITED`. Changed metadata needs a fresh preview; authentication expiry needs normal re-pairing. No raw source/provider exception or credentials belong in these responses.

The dashboard lazily mounts `onboarding.js`. Record/category choices start unchecked; a host starts unselected. Editing any choice or refreshing the catalogue clears the preview. In-flight requests are guarded against logout/reset, newer refreshes and changed selections; late results cannot restore an invalidated preview. A local five-minute timer also clears the preview. Save confirmation shows the exact selection summary and fingerprint and states that imports, sharing, bridge installation and host use remain separate. A post-save display must use freshly revalidated report metadata rather than stale pre-refresh response data.

## Limits and recovery

| Boundary | Effective limit |
| --- | --- |
| Requested categories / purpose | Four known categories; one of five known purposes. |
| Selection | 40 IDs total, each array at most 40; globally unique canonical UUIDs. |
| Catalogue | 200 metadata entries per list; overflow explicitly partial. |
| Preview HTTP body | 16,384 UTF-8 bytes; complete allowlisted fields. |
| Save/delete HTTP body | 4,096 UTF-8 bytes; exact allowlisted fields. |
| Service selection clone | 12,000 serialized UTF-8 bytes. |
| Preview clone | 64,000 serialized UTF-8 bytes, depth 12, 10,000 nodes, arrays at most 1,000; no cycles/accessors/sparse arrays/unsafe prototypes/NULs. |
| Saved report data | 128,000 serialized UTF-8 bytes, including review/creation receipt overhead. The same structural bounds apply. |
| Active reports | 128; capacity checked before creating another report. Exact retained retries still work. |
| Preview cache | Ten retained previews; five-minute lifetime; session-bound. |

Size and capacity failures occur before new report writes. Choose fewer records for oversized previews. Remove an unwanted active report explicitly before creating another at the report cap; historical revisions/backups remain. Preview expiry is independent of report persistence. Restart invalidates browser sessions and temporary previews but preserves saved reports. A verified backup restored into a fresh workspace must retain exact report bytes, review receipts and computed refresh behavior. A restored grant may still be expired; restoration is not new consent or host authentication.

## Implementation and objective verification

| Layer | Responsibility |
| --- | --- |
| [`onboarding.mjs`](../../../web/apps/local-runtime/src/onboarding.mjs) | Strict selection, metadata catalogue, exact coverage/pins, current revalidation, report readback/freshness and revision-bound forgetting. |
| [`onboarding-routes.mjs`](../../../web/apps/local-runtime/src/onboarding-routes.mjs) | Paired-human preview lifecycle and exact save authority. No IPC/MCP approval entry point. |
| [`server.mjs`](../../../web/apps/local-runtime/src/server.mjs) | Existing local session/origin/nonce boundary, route integration and shutdown cleanup. |
| [`onboarding.js`](../../../web/apps/local/public/onboarding.js) | Explicit record selection, matched-host controls, readable coverage/next steps, exact save review and stale-response clearing. |
| [`local-onboarding.test.mjs`](../../../web/scripts/local-onboarding.test.mjs) | Actual managed-record service, private-metadata canaries, permissions/version invalidation, caps, forged input and real restart/restore. |
| [`local-onboarding-http.test.mjs`](../../../web/scripts/local-onboarding-http.test.mjs) | Actual paired loopback routes, session isolation, zero implicit discovery/host work, exact save/retry, drift, forgetting and restore. |
| [`local-onboarding-ui.test.mjs`](../../../web/scripts/local-onboarding-ui.test.mjs) | Shipped UI event-handler regression checks for post-save drift/deletion, superseded refresh, pending selection/session reset and racing lazy imports. This DOM stand-in is separate from real browser proof. |

Run from the repository root after installing locked dependencies:

```sh
node --test web/scripts/local-onboarding.test.mjs web/scripts/local-onboarding-http.test.mjs web/scripts/local-onboarding-ui.test.mjs
npm run test:local
npm run local:build
node web/scripts/verify-local-install.mjs
```

The table maps requirements to executable evidence. The [dated receipt](GUIDED_ONBOARDING_VERIFICATION.json) binds the measured source hashes: 20 service/storage, 12 actual paired HTTP and seven DOM timing regressions, all included in 571 full-suite passes. It separately records the desktop/mobile browser flow, exact saved report persistence/restore, nine clean-install phases, ten built assets and four discovered MCP tools. Keep the earlier [academic refresh receipt](ACADEMIC_REFRESH_VERIFICATION.json) unchanged as historical evidence.

| Requirement | Objective verification |
| --- | --- |
| Empty setup and no implicit discovery | Service empty-catalogue case and HTTP ONH01; injected source/parser/host counters do not advance. Requested empty categories remain awaiting student action. |
| Private metadata only, original records preserved | Service metadata canary and text/PDF/DOCX/PPTX coverage cases; HTTP ONH02 compares exact original records before/after and proves bodies/values/paths absent from catalogue/report serialization. |
| Paired human controls | HTTP ONH03 and ONH12 deny unpaired/no-nonce/cross-session/logout/expired-session saves. No new student grant or confirmed fact appears. |
| Strict category/ID/hash authority | Service incompatible-category/global-duplicate/hostile-object/wrong-kind/foreign-ID/forged-pin cases; HTTP ONH04. Assert no new report and unchanged original state after each refusal. |
| Candidates never silently become facts | Service candidate/conflict/expiry/purpose case and HTTP ONH05. Compare profile review state and revision before/after report save. |
| Changed evidence invalidates a pending save | Service corrected profile/note, academic-head, source-revoke, expired grant and stale grant-pin cases; HTTP ONH06–08. Prior saved reports return `needs_refresh`; stale new saves produce no artifact. |
| Exact retry and report forgetting | Service canonical retry/key/tombstone/cap cases; HTTP ONH09 and ONH11. Exactly one report per retained operation, exact revision required for removal, zero unrelated record/permission changes. |
| Durable exact reports | Service and HTTP ONH10 stop/restart and real backup/fresh-restore independently read exact reports and recomputed freshness. Temporary previews do not survive a new runtime. |
| Honest limits | Service 200-entry catalogue, 128 active report and preview/receipt byte-bound cases; HTTP strict-size and consumed-cache cases. Refusal leaves the last saved evidence intact. |
| Usable student dashboard | Disposable paired browser: unchecked defaults, candidate awaiting review, separate exact profile confirmation, purpose edits clear preview, selected partial academic import, Codex choice without a grant remains pending, exact report save, changed-profile stale flag and next-step navigation. Desktop/mobile width, browser console and independent stored restart/restore readback are measured separately. Harness checks cover logout/reset and delayed responses; service/HTTP fixtures cover source limits and matched grants. |

A DOM logic harness is distinct from an actual browser check. Fixtures prove deterministic metadata handling and local persistence; they do not certify student understanding, source truth, a useful generated tutor answer or live provider interoperability. Use synthetic data and no university mutations during verification.

## Remaining onboarding and host gates

The broader onboarding design still needs explicit cloud account/collection selectors, provider-specific pagination and freshness, reviewed exported agent memories, proposed profile extraction with exact evidence, retention/forget behavior and any separately authorized model processing. New connectors or broader discovery must have independent scope/revocation/recovery tests before release. A student may select narrow local roots in Sources today; this report never turns that into permission for a home-directory scan.

Avenue/D2L still needs a reviewed institution transport, normal student SSO/MFA, verified session/account binding and a selected-course live read. Academic export coverage is not that authorization. Embedded Codex execution and actual Claude host execution need their own measured compatibility/authentication/tool/model checks. The report adds no MCP tool, model API fallback or grant-creation operation; the established external project bridge remains the separately reviewed host path.

See [agent/source setup](../../LOCAL_AGENT_SETUP.md), [the academic refresh contract](ACADEMIC_REFRESH.md) and [implementation status](../IMPLEMENTATION_STATUS.md) for the existing next steps and their remaining gates.
