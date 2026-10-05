# Reviewed local student administration deadlines

Implemented October 4, 2026 as a bounded F20 slice. This covers school, scholarship, financial aid and administration requirements. It is not the full budget, scholarship discovery or administrative form automation feature.

## Student flow

1. Open **Student administration**. Choose a category and title, paste a source URL and the exact requirement/deadline text you read, and enter when you checked it. This is explicitly **student-pasted, unverified evidence**. The app never requests that URL or decides whether it is official.
2. Add one or more requirement excerpts. Each must occur exactly in the pasted text. Review each as **met**, **not met** or **unknown**, with your explanation. All new reviews begin unknown. Add any preparation checklist steps; completed steps are your explicit statements.
3. Choose **unknown**, **date only** or **exact UTC instant** for the deadline. Enter an IANA time zone and, where useful, the original deadline words. A date stays a date. An unknown date stays unknown. Ambiguous local timestamps do not become an invented UTC instant.
4. Optionally select a current confirmed **general-purpose** profile fact as evidence for your own review. No facts are selected by default. Existing career-only eligibility, university/program and financial facts are not silently reused under a broader purpose. Profile facts never automatically set a requirement status.
5. Review and save the administration record. Saving creates no task. Prepare a local task preview, inspect the exact source/profile pins, deadline, checklist blockers and task payload, then separately choose **Review and add this local task**.
6. The accepted task appears in Today and can be selected normally for Focus, Reminders or Calendar export. Those are separate student choices. The administration record itself does not enable a schedule, start a timer or write an event.

Unknown requirements produce `unresolved`; an explicit not-met review produces `student_reviewed_requirements_not_met`; all met reviews produce `student_reviewed_requirements_met`. None of these establishes verified eligibility. If requirements remain unresolved or not met, the proposed task is **Review requirements: …**; otherwise it is **Prepare: …**. A review task may be useful even when the deadline is unknown. Its original unresolved blockers remain visible beside it.

## Records and exact review

`administration_item` records use `student_admin_deadline_v1`. Each stores the normalized definition, student-pasted provenance label, complete definition `source_hash`, selected profile pins, `item_hash`, stable creation operation, acceptance reservation and eventual linked task ID. The source hash covers the URL, pasted text, supplied deadline/time zone, checked-at time, requirement reviews and checklist. It is an integrity/version hash, not proof of truth or official ownership.

Task previews use existing `plan` storage with format `student_admin_task_preview_v1`. They are excluded from standard study plans. A preview captures the exact record revision/hash, definition, selected profile fact revisions/content hashes, deterministic task, unresolved preparation blockers, existing same-title task metadata, creation/expiry times and review hash. Preparing never creates a task and invokes no model or provider.

The normal paired local HTTP API is:

| Method | Route | Input / effect |
| --- | --- | --- |
| GET | `/student-admin/context` | Categories, limits and available confirmed general-purpose facts; no automatic selection |
| GET / POST | `/student-admin/items` | List / save one explicit source record; POST uses an exact idempotency key |
| GET / POST | `/student-admin/items/:id` | Read / correct using `expected_revision`, `item_hash`, full `definition`, `confirmed:true` |
| POST | `/student-admin/items/:id/prepare` | `expected_revision`, `item_hash`, exact idempotency key; save preview only |
| GET | `/student-admin/previews` and `/student-admin/previews/:id` | Read exact saved previews and current stale/expiry/task status |
| POST | `/student-admin/previews/:id/accept` | `expected_revision`, `review_hash`, `confirmed:true`; one reviewed local task |
| POST | `/student-admin/previews/:id/cancel` | Same exact review fields; cancel a preview/reservation with no task receipt |

Origin, pairing cookie, nonce, query rejection and per-body allowlists stay in the runtime. The route rechecks authorization after asynchronous body reading. There is no MCP/agent entry point, URL fetch, form submission, payment, account read, model processing or external mutation.

## Crash recovery and corrections

Acceptance first atomically records the exact human decision in the preview and reserves the administration item with the existing bounded workspace batch API. Only then does it create the task through `LocalStore.createTask`, using stable key `student-admin-accept-<item UUID>`. A second atomic batch publishes the accepted receipt and linked task ID. It does not duplicate storage logic or use a database migration.

If interrupted before task creation, the journal remains `accepting`. An explicit retry checks current source/profile pins and matching tasks before finishing. A different prepared preview cannot steal that reservation. The student may instead cancel it, which atomically releases the reservation. Corrections are blocked while an unfinished reservation exists: cancel it or recover its result first.

If interrupted after task creation, `LocalStore.getTaskCreateResult` reads the exact validated durable task receipt. Retrying records the historical result without a second creation. An edited task is shown as changed; a deleted task is shown as unavailable and is never recreated. Cancellation cannot undo an already durably created task. Edit/delete the local task separately after recovery.

Source/requirement/checklist corrections invalidate old prepared previews. Corrected, forgotten, expired, conflicting or purpose-ineligible selected profile facts also block new acceptance. Corrections after acceptance preserve the linked task, show that the source changed and do not offer a second task for that record. Same-title existing tasks are visible conflicts, not silently merged, changed or deleted. Source omission does not delete a task.

Initial preparation reviews expire after ten minutes. A durably recorded acceptance can be recovered later through an explicit retry; it is never completed by an unattended background job. If no task receipt exists, changed source/profile facts still deny creation. Exact request replay cannot authorize a different payload.

## Bounds and current limits

- 200 administration records, 300 retained previews, 20 requirements, 20 checklist steps and 10 selected general-purpose profile facts per definition.
- Pasted source text: 12,000 characters; each excerpt/review note: 1,000 characters; definition/preview storage payload: at most 120,000 UTF-8 bytes; HTTP bodies: at most 64,000 bytes. Large Unicode payloads are measured in bytes as well as characters.
- At most 50 same-title matching tasks are captured. More matches fail with a bounded review error. Matching titles include completed/cancelled tasks; possible duplicates require separate review rather than silent merging.
- URLs use the existing conservative HTTPS citation validator. Embedded credentials, secret-bearing/free-form queries, ports, fragments and local hosts are rejected. Some legitimate parameterized/anchor URLs need their plain canonical page URL. Syntax validation does not prove official ownership.
- Exact instants currently require an explicit canonical UTC timestamp. This feature does not resolve a locally ambiguous daylight-saving timestamp or interpret deadline prose.
- Saved selected profile/evidence copies are local historical records. Forgetting an original fact blocks new acceptance but does not physically erase earlier previews, revisions or backups. Correcting a record can remove its active selected pins; selective physical erasure is a separate feature.
- Automatic scholarship lookup, live source verification, eligibility inference, monthly budgets, receipt OCR and administrative form filling/submission remain separate implementation work. This slice needs no external services or production dependencies.

## Objective verification

Run from the repository root:

```sh
node --test web/scripts/local-student-admin-service.test.mjs web/scripts/local-student-admin-routes.test.mjs web/scripts/local-student-admin-ui.test.mjs web/scripts/local-student-admin-http.test.mjs
```

October 4 result: **35 tests passed, zero failed/skipped**.

- **17 actual SQLite/domain tests** establish all four categories, unknown eligibility and exact excerpt evidence (F20-A03), date/instant/timezone preservation, separately accepted task/restart deduplication, source/profile corrections/forget/conflict/expiry, stale task matching, exact hashes/revisions/consent/expiry, malformed and secret-bearing URLs, malicious accessors, atomic SQL-trigger rollback, before/after-create crash recovery, edited/deleted task preservation, reservation cancellation, tampered captured task rejection, bounded retention/Unicode/matching tasks and zero network calls from the service.
- **5 route tests** establish exact namespaces/methods/body budgets, idempotency forwarding and authorization revocation during body reads. Unsupported external actions remain unavailable.
- **8 shipped controller tests** establish unknown/no-profile defaults, separate save/prepare/accept actions, exact correction payloads, literal hostile text, declined review, input/preview changes during confirmation, duplicate-click suppression, exact retry keys and clearing private state on reset/late reads.
- **5 actual paired-runtime HTTP tests** establish the complete record→preview→task→Today/restart flow, no contamination of study plans/travel, real profile/source staleness, cookie/origin/nonce/query/schema guards, a real SQLite finalization-trigger failure plus restart recovery, and the shipped controller making actual paired HTTP calls with zero automatic acceptance.

The independent browser smoke check should save a disposable synthetic record, confirm its unknown requirement remains unresolved, prepare with zero tasks, accept exactly once, verify the task in Today, and try a declined correction. Synthetic proof does not establish a real scholarship deadline, official eligibility or successful form submission. A student should separately check any real official page and its requirements before relying on the record.

Implementation files: `admin-deadline-service.mjs`, `admin-deadline-routes.mjs`, `local/public/student-admin.js` and the four `local-student-admin-*.test.mjs` files. The parent runtime wires the service, routes, static asset, navigation and clean installer.
