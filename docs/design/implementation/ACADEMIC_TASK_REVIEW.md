# Reviewed academic deadline tasks

Implemented 2026-10-04. This local workflow converts **explicitly selected,
current imported assignment deadlines** into pending task proposals. A separate
human confirmation accepts each task. It is deterministic local planning, not
automatic D2L refresh, assignment completion, calendar mutation or AI processing.

## Student workflow

1. Import and review a course export in **Courses**, or complete your own school
   SSO/MFA and review selected course reads in **School connection**. A configured
   transport or fixture is not proof of a real university connection.
2. Open **Academic tasks**, choose one current imported snapshot and check the
   courses you want. Every course checkbox starts unchecked.
3. Choose **Inspect selected course deadlines**. The page displays selected
   assignment titles, source-reported deadline precision, course labels, coverage
   and existing-task/proposal matches. Assignment descriptions are not returned.
4. Choose up to three known assignment deadlines, then **Prepare exact task
   preview**. Unknown dates remain visible, including their original wording,
   and cannot become a guessed date. Conflicting/deduplicated rows are visible
   rather than overwritten.
5. Review the displayed task payloads, original source deadlines, snapshot/head
   pins and existing-match information. Choose **Save pending academic task
   proposals** and confirm. This atomically saves pending reviews only; **zero
   tasks are accepted or created** in this step.
6. Separately review each proposal and choose **Accept this academic task** or
   **Reject this academic task**. Acceptance creates one local pending task in
   Today. Its title is `Prepare: <source assignment title>`; LearnBridge does not
   complete the assignment, infer effort, infer mastery or submit schoolwork.
7. If acceptance was interrupted, use **Finish reviewed academic task**. This
   checks the saved review and durable task-creation receipt. A task already
   saved is not duplicated; a changed source blocks one that was never created.

The service supports an explicit scope of up to five current snapshots and five
courses. The first UI presents one current snapshot at a time to keep selection
and review clear. No provider account, model, source path or university token is
accepted by this task workflow.

## Source and deadline contract

Only normalized **assignments** in a current imported academic snapshot are
eligible. Announcement publication timestamps, module titles, quizzes, inferred
exam dates and unselected course items are not treated as deadlines.

| Source deadline | Proposed local task |
| --- | --- |
| Calendar date with recorded time zone | Same date, original wording and zone; no invented due hour |
| Calendar date with missing time zone | Same date; missing zone remains visible in source provenance and is omitted from the task rather than invented |
| Exact instant with offset | Normalized exact UTC instant plus the original offset-bearing text and normalized source time zone |
| Missing or ambiguous value, such as “next week” | Visible `unknown` deadline; no new task proposal from that item |

The existing academic library/current-snapshot gate rejects historical,
forgotten, invalid or unselected sources. The trusted
`studentWorkspace.getCurrentSnapshot(id)` reads the exact selected current
snapshot/head metadata. The selected path does not validate unrelated retained
snapshot bodies or read another local source folder.

Each proposal retains the selected item's normalized stable identity, original
source ID, source hash, course ID, title, URL, deadline, institution/account,
source-reported retrieval time, coverage and exact snapshot/head pins. Raw
assignment descriptions are neither copied into this workflow nor sent to a
model. Hashing and library validation use the existing approved local import;
returned task metadata does not imply that the source is live or complete.

Formal task `source_refs` currently require an agent grant under the storage
contract. This human local workflow does **not** create a fake Codex/Claude grant.
The accepted task's source provenance remains in its retained proposal, linked
by the actual task ID. Sharing with an agent remains a separate selected consent
flow. Standalone task records do not claim grant-backed provenance they lack.

## Matching, conflicts and omissions

Identity is qualified by institution, source account, course and assignment;
identical titles/course codes from another connected source account remain
separate. Matching known tasks from a different retained academic source is not
silently treated as the same assignment.

The deterministic preview identifies:

- **New proposal:** known deadline with no matching retained proposal/task.
- **Existing matching task:** exact normalized original or `Prepare:` title and
  course label with the same deadline precision/date/instant/time zone. It is
  skipped, including completed matching tasks.
- **Existing task conflict:** a matching title with a different deadline or
  missing course qualification. The task is displayed for review and preserved.
- **Already pending / acceptance pending / already accepted:** a retained
  proposal has this qualified source identity. Another task is not created.
- **Pending source changed / accepted source changed:** the same assignment's
  source version changed. The old task is preserved. Reject a stale unaccepted
  proposal and prepare a fresh review; an accepted task needs a separate reviewed
  edit workflow rather than automatic replacement.
- **Conflicting current sources:** overlapping still-current imported streams
  disagree about an assignment. Neither UUID ordering nor the newer title alone
  chooses authority; no task proposal is created from that conflict.
- **Unknown deadline:** the source wording is retained; a date is not guessed.

A new matching task or changed matched-task revision between preview and save
invalidates that exact review. A matching task introduced before acceptance
also blocks creation. Unrelated tasks are preserved and do not invalidate the
selection. Source omission, reduced coverage or errors never delete an existing
task. Edited or deleted accepted tasks are reported as changed/unavailable and
are never overwritten or silently recreated.

## Persistence and review boundaries

`academic-task-service.mjs` exports
`createAcademicTaskService({store, studentWorkspace, clock})` and
`ACADEMIC_TASK_LIMITS`. `academic-task-routes.mjs` exports
`handleAcademicTaskRoute`; `academic-tasks.js` exports `mountAcademicTasksUI`.
These capabilities have no agent IPC/MCP entry point and no production
schema/dependency change.

### Preview and pending publication

1. Explicit scope and up to three assignment UUIDs produce a durable `plan`
   record with format `academic_task_preview_v1`.
2. Its review hash binds the exact selection, source/head pins, task payloads,
   matching task/proposal metadata, creation time and ten-minute expiry.
3. Saving rechecks current source/head revisions, exact selected source metadata,
   match fingerprints, expiry and preview revision. Accessor and holey selection
   arrays are rejected without invoking their getters.
4. **One actual `commitWorkspaceBatch` SQLite transaction** creates at most three
   `inbox_item` records with format `academic_task_proposal_v1` and changes the
   preview to saved. That is at most four records, within the existing storage
   bound. CAS, immutable revisions and persisted readback prevent partial
   publication. A SQL error midway through row creation rolls the whole batch
   back, including the preview state.
5. Exact preview retries return the original retained result; a changed request
   under the same idempotency key fails. Competing/stale saves cannot create a
   second pending proposal under a review whose match fingerprint changed.

Pending proposals contain the immutable task/source payload hash, exact pins,
preview reference, review state and eventual task ID. Expiry bounds the preview
publication step. A later individual acceptance is a fresh human action with
current source and conflict checks; it does not infer live freshness from age.

### Separate acceptance and interruption recovery

The agent proposal table requires a real destination-specific sharing grant,
so this local human workflow uses marked workspace review records instead.
Acceptance is deliberately **two durable steps**, not falsely described as one
cross-table transaction:

1. The exact payload hash/revision/confirmation and current source/task matches
   are checked. A CAS writes an `accepting` review checkpoint with reviewer,
   original reviewed revision, decision, payload hash and decision time.
2. The existing atomic `store.createTask` transaction creates a local task using
   the stable key `academic-accept-<proposal UUID>`.
3. A CAS finalizes the proposal to accepted with the actual task ID.

The trusted read-only `LocalStore.getTaskCreateResult(input,{idempotencyKey})`
looks up only an exact existing `task.create` receipt. It validates operation,
payload hash and student-owned result, returns null when absent, and creates or
restores nothing. It has no HTTP/MCP route.

If interruption happened **before** the task transaction, recovery must recheck
current source and task conflicts before creation. A changed/omitted/forgotten
source blocks it. If interruption happened **after** the task transaction,
recovery can finalize the already-created task receipt even after source refresh;
it creates nothing new. If the student edited or deleted that task meanwhile,
the result explicitly displays changed/unavailable state. Receipt lookup never
restores a deleted task. Changed payloads or another operation under that key
fail closed. Exact accepted/rejected retries are idempotent.

### Bounds and retention

- Five explicitly selected snapshots; five selected courses; three selected
  assignment items per exact preview.
- Inspection returns at most 200 assignment metadata items and reports
  truncation/total count. Choose fewer courses to narrow a large view.
- At most 100 retained previews and 300 retained proposals; exceeding these
  bounds fails rather than silently dropping reviews. Reviewed archive and
  physical erasure are later work.
- A preview expires exactly at ten minutes. Saved pending proposals and review
  checkpoints persist across actual runtime restart and backup/restore under
  normal storage policy.
- Rejected proposals, immutable revisions and backups may retain source metadata
  and review history. Rejection is not physical erasure.

## HTTP contract

All paths are under `/api/local/v1`. Root origin, paired session cookie, nonce,
private JSON body, request limits and no-query guards remain mandatory. The
handler also requires the session and rechecks authority after body acquisition.
No caller can supply task text, a date override, source replacement, account,
model, path, token, provider operation or autoaccept flag.

| Route | Method | Input / result |
| --- | --- | --- |
| `/academic-tasks/context` | GET | Current imported snapshot/course picker metadata |
| `/academic-tasks/inspect` | POST | `{snapshot_ids,course_ids}`; selected deadline metadata and matches |
| `/academic-tasks/previews` | GET | Retained local previews, expiry and source-change state |
| `/academic-tasks/previews` | POST | `{snapshot_ids,course_ids,assignment_ids}` plus idempotency key |
| `/academic-tasks/previews/:id` | GET | One exact saved preview |
| `/academic-tasks/previews/:id/save` | POST | `{expected_revision,review_hash}`; pending proposals only |
| `/academic-tasks/proposals` | GET | Saved local proposal/review states |
| `/academic-tasks/proposals/:id` | GET | One exact proposal with accepted-task changes if any |
| `/academic-tasks/proposals/:id/accept` | POST | `{expected_revision,payload_hash,confirmed:true}`; one explicit local acceptance |
| `/academic-tasks/proposals/:id/reject` | POST | Same narrow review input; no task creation |

Source text is rendered through literal text nodes. No provider-refresh, send,
calendar-write, task-autofill, arbitrary tool execution or token routes exist.
Responses retain the runtime's private/no-store caching.

## Objective verification

Run from repository root:

```sh
node --test web/scripts/academic-task-service.test.mjs web/scripts/academic-task-routes.test.mjs web/scripts/academic-task-ui.test.mjs web/scripts/academic-task-http.test.mjs
```

**37 focused cases pass** (zero failures, skips or cancellations):

- **19 actual SQLite service cases:** selected metadata/no raw-body leakage;
  date/instant/offset/unknown provenance; pending-only batch and separate explicit
  acceptance; restart/dedup; source refresh/head-only/omission/historical/forget
  denial; manual task preservation/conflicts; new matching task rejection;
  accepted-task edit/deletion visibility; real mid-batch SQLite rollback;
  interruption before and after the real task commit; exact receipt recovery,
  payload/operation mismatch rejection; expiry/hash/revision/input bounds;
  confirmation/rejection; qualified account identities; overlapping-source
  conflicts; missing-zone dates; deleted interrupted task recovery; and hostile
  accessor/holey arrays without getter execution.
- **6 controller cases:** paired authority, narrow complete flow, revocation
  while body acquisition waits, unsupported/query/cross-action routes, exact
  methods, false confirmation, safe list/reject behavior and no automatic task.
- **9 shipped UI-handler cases:** unchecked scope, explicit selected inspection,
  literal source titles, disabled unknown dates, preview→pending→separate
  confirmation, refused consent, late scope/consent/revision/logout suppression,
  duplicate handlers, interrupted acceptance, exact rejection, older-response
  suppression and changed/unavailable-task display. These handler fixtures do
  not claim a rendered browser inspection.
- **3 actual HTTP/runtime cases:** school-export import→selected task preview→
  pending→separate acceptance→actual restart gives exactly one task; refreshed
  omission blocks stale acceptance and preserves manual data; real origin,
  cookie, nonce, query, schema, hash, false-confirmation and logout guards deny
  unintended effects. Source descriptions do not appear in task endpoints.

The fixtures are disposable synthetic school data and local HTTP/SQLite. They
perform no university request, account connection, model call, submission,
communication or calendar write. Browser rendering and release-wide checks are
recorded separately by the current release evidence; this task flow cannot
establish live D2L authorization or all-institution compatibility.

## Follow-on work

Add an exact reviewed **edit** proposal for source deadline changes on an
already-accepted task, with preservation of student overrides and current task
revision checks. Add student-supplied resolution for unknown dates as an
explicit separate fact, source-specific exams/events where actually supported,
reviewed archive/removal, and a chosen-task handoff into existing study planning
and local reminders. None should silently extend this consent to provider reads,
agent sharing, calendar writes or assignment completion.
