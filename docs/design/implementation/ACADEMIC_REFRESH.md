# Reviewed academic refresh and retained versions

This increment implements the **selected-export comparison and private cache** portion of [F06](../FEATURES_ACADEMIC.md#f06-course-and-d2l-synchronization), with current-version retrieval for F07/F08. It does not fetch university data, authenticate a student, launch Avenue MCP, or establish live D2L compatibility. The source is a student-selected export; its reported retrieval time and coverage are not independently verified.

## Student flow

1. In the paired local dashboard, open **Sources**, paste the supported [academic export](../../../web/packages/local-academic/examples/academic-export.json), and choose explicit course IDs.
2. Preview the exact normalized content, selected courses, coverage and uncertain dates. If this selection has a saved baseline, review added, changed, unchanged, not-returned and conflicting items. Assignment comparisons retain the before/after deadline; source hashes bind the shown references to exact observations.
3. Choose **Save reviewed course changes** and approve that displayed selection. Editing the export or course field invalidates the dashboard preview. A changed stream requires a new preview before saving.
4. **Courses** lists the current saved version for each scope. Search and tutoring operate on explicitly selected current snapshots. **Review retained history** reads metadata first; **Read retained version** explicitly reads the chosen content and labels it current or historical.
5. **Remove from active library** hides that managed stream, including its retained history routes. A fresh reviewed import can reactivate it. This is an access change, not physical erasure; database revisions, retained snapshots, separately exported notes and backups can remain.

Saving a refresh neither creates nor edits tasks, completion states, student deadline overrides or unrelated notes. Saving a snapshot **as a note** remains a separate choice. Notes do not update when the library changes; sharing one with Codex/Claude requires its own exact selection and destination-specific grant. No model or provider call occurs during preview, save, comparison or history retrieval.

The dashboard shows at most 40 rows per nonempty change group, with the full group count and a notice when more remain. The exact normalized snapshot remains inspectable. Choose fewer courses when a review is too large; a truncated row display does not imply that only those rows are committed.

## Identity and observation semantics

The refresh stream key hashes this exact normalized scope:

```js
{
  institution_origin,
  account_ref,
  selected_course_ids, // sorted exact set
  category_scope: ['courses', 'assignments', 'announcements', 'materials']
}
```

The local student identity separately owns storage. `account_ref` is an opaque source-account discriminator supplied in the export, **not proof of identity or university consent**. Origin, account, or selected-course-set changes create a different stream; they never produce cross-scope missing-item changes. Selecting A and B is distinct from selecting only A. Source row IDs additionally bind category and course, so equal external assignment IDs in different courses do not collide.

Three hashes have different jobs:

| Hash | Meaning |
| --- | --- |
| `snapshot_hash` | Exact normalized immutable source observation, including reported retrieval time and safety metadata. It never silently retargets a prior citation. |
| `semantic_hash` | Selected row identities/hashes plus institution metadata, coverage states, normalized errors, meaningful warnings and conflicting variants. Later retrieval time, traversal order and counted exact duplicates alone do not create a new content version. |
| `review_hash` | Exact preview: scope, baseline head/revision/snapshot, candidate snapshot, semantic hash and structured changes. The service recomputes it against persisted evidence. A browser-supplied hash is not authority. |

A reviewed semantic match returns `unchanged`, retaining the existing immutable content snapshot and adding an observation receipt. Its snapshot's original reported retrieval time stays intact. The head separately stores `last_observation.reported_retrieved_at` and local `accepted_at`; a newer accepted report does not rewrite the old snapshot's time. Even an unchanged observation advances the head revision. An exact retry with the same preview/key returns `replayed` and adds no receipt or version.

The latest accepted reported time is monotone. A later deduplicated observation prevents an older report from moving the head. Different semantic content at the same reported instant is rejected as ambiguous. These ordering checks cannot prove that an export's clock or date is truthful.

## Missing items, conflicts and citations

Changes are deterministic groups: `added`, `changed`, `unchanged`, `not_returned` and `conflicted`. Before/after references include the exact snapshot hash, reported retrieval time, source-row hash, title, course and safe source URL. Assignment references retain normalized deadlines; announcement references retain normalized publication dates. Conflicts retain variant references without promoting one variant into authoritative content.

`not_returned` means **not seen in this export**. It records the category's reported coverage and preserves prior evidence in history. It never means D2L deletion, successful enumeration or permission to delete a task. Unknown, partial and unavailable collections remain uncertain. Even an export's `complete` label is only source-reported coverage.

The current managed snapshot contains the newly reviewed observation. Old snapshot IDs cannot be inserted into current runtime search, citation or tutoring scope to resurrect absent/conflicting items. Explicit history reads return the retained version with a historical label. The pure library recipe can retain several observations: items absent or conflicted in the newest selected-course observation become `last_known`, remain exactly citable, and are excluded from current search/tutoring. Repeated identical source versions keep their snapshot hash and timestamp together from one real input observation.

Unknown or ambiguous deadline text remains unknown with its original text and a review warning. Date-only deadlines remain dates; no midnight, end-of-day instant, timezone or student target is invented.

## Implementation map and atomic publication

| Layer | Responsibility |
| --- | --- |
| [`local-academic/src/index.mjs`](../../../web/packages/local-academic/src/index.mjs) | Validate/normalize the explicit export, institution links, dates, selected rows, duplicate conflicts and reported coverage. |
| [`local-academic/src/refresh.mjs`](../../../web/packages/local-academic/src/refresh.mjs) | Pure stream/semantic hashes, exact before/after recipe, baseline validation and review recomputation. No reads or writes. |
| [`local-academic/src/library.mjs`](../../../web/packages/local-academic/src/library.mjs) | Validate complete normalized snapshots; retain coherent exact evidence; enforce current versus historical/last-known retrieval. |
| [`student-workspace.mjs`](../../../web/apps/local-runtime/src/student-workspace.mjs) | Trusted baseline selection, chronology, immutable snapshot/receipt references, CAS, current reads, metadata history and forgetting/reactivation. |
| [`local-storage/src/index.mjs`](../../../web/packages/local-storage/src/index.mjs) | Bounded private `commitWorkspaceBatch`, SQLite transaction, owner/revision assignment and independent persisted readback. |
| [`server.mjs`](../../../web/apps/local-runtime/src/server.mjs) / [`app.js`](../../../web/apps/local/public/app.js) | Paired HTTP boundary, expiring session-bound previews, reviewed save, comparison and explicitly selected history reads. |

A managed head is an `academic_item` with `data.format: academic_stream`. Immutable snapshot records use `data.format: academic_snapshot` and remain revision 1. The head ID derives from the local student ID and stream key, preventing concurrent first saves from creating independent heads. Head revisions carry current references, bounded history, receipts and the latest reported observation.

For a changed import, a **single SQLite transaction** creates the candidate snapshot and creates/updates the head, including its receipt. The head is the publication point. `commitWorkspaceBatch` checks every create collision and expected revision before any write, limits the batch to four records, assigns the local owner, writes immutable revision rows, and reads them back before commit. It accepts data only, never callbacks, SQL, paths or executable operations; it is not an HTTP or MCP tool.

A stale competing preview fails `REVISION_CONFLICT`; there must be zero candidate/head/revision leftovers. A SQL error or process death between candidate and head writes rolls back the entire transaction. A replay after a newer refresh may return the original immutable artifact, but that old artifact still cannot pass current-retrieval checks. Reusing a key with a different review fails.

Managed removal requires **both** snapshot and stream revisions. Forgetting increments the head revision and changes its state to `forgotten`; current reads reject it and metadata/content history require renewed consent. Old save retries cannot reactivate it. A newly reviewed import uses the forgotten head as its CAS baseline and can reactivate the same content without duplication. It does not purge separately saved/sharing copies.

Legacy snapshots are adopted only within their exact scope. Before a managed head exists, the uniquely newest reported observation is the baseline. Equal-time snapshots with different semantic content fail closed; UUID ordering cannot choose source authority. Equivalent equal-time observations can choose a stable retained record. Adoption retains all legacy evidence in history and removes older versions from the current list without rewriting or deleting them.

## Local HTTP contract

All routes below require the local paired session; writes also use the existing origin/nonce/body checks. No route accepts institution credentials or an arbitrary source-session assertion.

| Route | Request / response |
| --- | --- |
| `POST /academic/preview` | `{export, selected_course_ids}` → `{preview_id, snapshot, refresh, notice}`. The exact review hash is `refresh.review_hash`. Nothing is saved. |
| `POST /academic/library-import` | `{preview_id, review_hash}` → `{snapshot, stream, receipt, status}`. The server chooses expected head revision and idempotency key from its retained preview. Status is `imported`, `updated`, `unchanged` or `replayed`. |
| `POST /academic/import` | `{preview_id}` → a separately reviewed snapshot note; does not publish a course stream. |
| `GET /courses` | Current active managed snapshots plus compatible newest legacy snapshots. |
| `GET /academic/streams` | Active stream metadata, with `live_access: requires_auth`. |
| `GET /academic/streams/:id/history` | Head metadata, version metadata and observation receipts; no assignment descriptions, announcement bodies or material bodies. This is private metadata, not anonymous telemetry. |
| `GET /academic/streams/:id/history/:snapshotId` | Explicit exact retained snapshot plus current/historical status and notice. IDs must belong to the selected active stream. |
| `DELETE /courses/:snapshotId` | Managed `{expected_revision, expected_stream_revision}`; legacy `{expected_revision}`. Stale or missing managed pins reject. |

Previews last five minutes, are tied to the paired session nonce, and are cleared when the runtime closes. There are at most ten retained previews. A successful library or note save marks its preview consumed: when space is needed, the server evicts the oldest consumed entries before refusing a new preview. Pending reviews are not evicted for capacity. Exact retries work while their preview is retained; expired, evicted or different-session previews return `403 CONSENT_REQUIRED` without a new effect. Stale revisions require re-preview; invalid inputs fail before publication. Typical errors are `400 INVALID_INPUT`, `403 CONSENT_REQUIRED/SCOPE_DENIED`, `409 REVISION_CONFLICT/VERSION_MISMATCH`, `413 BUDGET_EXCEEDED`, or `429 RATE_LIMITED`; source failure remains redacted.

## Limits and recovery

The effective route limits are stricter than the pure library's general limits:

| Boundary | Limit |
| --- | --- |
| Preview request body | 256,000 UTF-8 bytes |
| Normalizer | 1,000,000-byte input; 256,000-byte output; 100 courses; 2,000 rows per category; depth 16 |
| Persisted normalized snapshot | 100,000 UTF-8 bytes |
| Pure refresh clone | 4,000,000 bytes; depth 18; 100,000 nodes; no accessors, cycles, sparse arrays or unsafe prototypes |
| Head/history | At most 128 snapshot references, 128 observation receipts, **or 128,000 serialized head-data bytes, whichever is reached first** |
| Workspace batch | One to four records; each data payload at most 128,000 bytes; 520,000-byte input ceiling |
| Snapshot note export | 48,000 serialized UTF-8 bytes |

Capacity refusal happens before writes and retains the current version. There is no automatic history pruning or retention reset. Choose fewer courses/smaller exports for size failures; history-capacity exhaustion needs a future explicit archive/pruning workflow rather than deleting evidence silently. Stop/restart and fresh-workspace backup/restore must preserve exact heads, snapshots, receipts and revision checks. Generic backup validation proves stored bytes, record hashes and storage invariants; the academic service separately validates the snapshot/current-head relationships it reads. Restoration is not a claim that every historical receipt was independently recomputed. This increment adds no database migration or production dependency.

## Objective verification map

Run from the repository root with installed locked web dependencies:

```sh
node --test web/scripts/academic-refresh.test.mjs web/scripts/local-academic-refresh.test.mjs web/scripts/local-academic-refresh-http.test.mjs
npm run test:local
node web/scripts/verify-local-install.mjs
```

The table maps assertions to executable cases; it is **not a test-run receipt**. Use [ACADEMIC_REFRESH_VERIFICATION.json](ACADEMIC_REFRESH_VERIFICATION.json) and [implementation status](../IMPLEMENTATION_STATUS.md) for dated results and platform limits.

| Requirement | Executable evidence / required check |
| --- | --- |
| Exact account/origin/course scope and semantic dedup | `academic-refresh.test.mjs` REFRESH01–03; storage cases for independent streams, no duplicate content and no task/note effects. |
| Before/after deadlines, non-deletion absence and conflict variants | REFRESH04–06; storage changed-deadline/missing-source case; HTTP preview/save/history assertions. |
| Tampered hash/baseline/schema/accessor refusal | REFRESH07, 09–12; storage review/base/diff/key and hostile-object case; HTTP forged/missing review hash. |
| Monotone observation time and coherent old citations | REFRESH08 and REFRESH-L01–03; storage latest accepted report after dedup. |
| Missing/conflicting content cannot re-enter current search/tutoring | REFRESH-L04–05; storage old-ID/current-query denial; HTTP current selection versus exact historical read. |
| Stale first-save and changed-save CAS leave no candidates | Storage simultaneous-head/competing-preview case, plus HTTP competing previews. Inspect actual record/revision counts before and after failure. |
| Publication rollback is real | Storage actual SQLite abort after candidate insert, actual child `SIGKILL` between candidate/head writes, and head-update SQL failure. Reopen SQLite and assert zero partial rows or unchanged previous head; retry once. |
| Metadata history does not disclose bodies | Storage private-body canary absent from metadata serialization, present only in explicit exact historical read; HTTP paired/unpaired and stream-membership checks. |
| Forget/reimport, legacy adoption and bounded refusal | Storage dual-revision removal/reactivation, unique-newest legacy/equal-time ambiguity, and capacity-with-zero-write cases; HTTP routes enforce the same controls. |
| Durable exact restart/restore | Storage real backup and fresh restore; HTTP restart/restore independently reads retained metadata/content and current search. |
| Usable reviewed dashboard | Synthetic paired browser: first save, changed deadline, not-returned label, dedup, current search, metadata history, explicit historical read and removal. Check desktop/mobile layout and console; retain sanitized evidence. |

Keep the full test suite and clean-install/build checks separate from browser evidence. Fixtures establish policy, persistence and deterministic comparison; they do not prove generated tutor quality, truthful source timestamps, university access, or broad provider compatibility. No private student records or university mutations belong in these tests.

## Remaining F06 / host release gates

The broader F06 contract still needs a reviewed local institution profile/transport, one owned browser/session lifecycle, real student SSO/MFA, independent account/session binding, bounded pagination/watermarks, cancellation/reconnect and authorized attachment downloads. The existing read-only adapter accepts a trusted injected client; a fixture client is not a university session. Follow the [Avenue audit](AVENUE_ADAPTER_AUDIT.md) before launching or bundling upstream code.

For each advertised institution, the student must select one course after normal sign-in and compare actual UI counts, a deadline and one material link to the retained result. Report unavailable categories and sanitized source times. Grades, submission, university writes and release-gate bypass are outside this increment.

Codex/Claude model execution and destination sharing remain separate host gates. This change adds no MCP tools and grants no automatic academic reads. The established bridge has four tools; use an explicitly reviewed snapshot-note export when the host needs academic context. Embedded Codex execution, actual Claude execution and live D2L success need their own measured evidence; none follows from a passing refresh fixture.
