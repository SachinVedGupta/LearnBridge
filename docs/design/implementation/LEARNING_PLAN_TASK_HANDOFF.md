# Reviewed learning-plan task handoff

## Implemented student workflow

The local **Catch-up plan tasks** screen connects an already accepted Learning catch-up plan to the existing Today, Focus, Reminders and reviewed calendar-file workflow. It creates useful local study tasks while keeping plan acceptance and each task's acceptance separate. Creating a task does not establish learning, completion, catch-up success or mastery.

1. Select current course evidence in Learning, prepare a catch-up preview, and explicitly accept that exact plan there. This screen cannot accept a proposed plan on the student's behalf.
2. Inspect that accepted plan here. Its current session, academic policy, source versions, plan/catch-up hashes and original review receipt are revalidated through the existing Learning service. Stale or forgotten evidence is visibly unavailable.
3. Choose 1–20 intended topics and click **Preview only my selected study tasks**. This saves a private handoff preview and creates zero tasks, checkpoints or calendar events. Every topic selection starts unchecked.
4. Inspect each task's exact title, original exam/goal deadline, effort estimate, current local prerequisite IDs and source/task hashes. Unknown effort stays unknown. Date-only deadlines stay dates, and unknown dates are not replaced with the proposed study-block start or end.
5. Explicitly check the intended task's review checkbox, then click **Accept this one study task** and approve the normal final confirmation. One request creates at most one pending local task. Other topics remain unaccepted.
6. Accept prerequisites separately before a dependent task. The dependent preview refreshes with the exact created local task IDs/revisions/hashes; it does not invent prerequisites or accept them automatically. A prerequisite already marked completed in the accepted plan remains explicitly `student_reported_complete_not_mastery`.
7. The accepted task is available through the normal local task list and Today. Choosing it for a Focus session, reminder or calendar file still uses those features' own controls. No task is marked completed by handoff.
8. An interrupted acceptance is visibly **acceptance pending**. Explicit recovery uses its exact original review and durable task-create receipt. Forgetting a preview removes that current preview while preserving created tasks, independent acceptance/dedup receipts and historical-copy retention.

The original Learning acceptance remains unchanged, including its `task_writes: 0` and `calendar_writes: 0` receipt. The handoff records a new, separate human decision. No model runs, provider reads, file scanning, calendar writes or automatic acceptance are introduced.

## Source and deadline meaning

Only `plan` records with format `learning_catchup`, state `accepted` and an exact paired-local-student review are eligible. The guard runs **before** the existing `acceptCatchUp` method is called in its already-accepted idempotent validation path; calling this validator never converts a proposal into an accepted plan. It recomputes the selected topic recipes/schedule against the original current session/library and checks the plan and catch-up hashes.

Each source pin retains the accepted plan ID/revision/data hash, plan/catch-up hashes, session ID/revision/hash, original selected academic snapshot pins, academic policy, original acceptance receipt, `coverage_basis: selected_topics_only` and `mastery_claim: false`. New same-owner selected source versions, source conflicts, modified/forgotten snapshots, changed or forgotten sessions/plans and changed plan revisions deny new task effects. An already accepted plan is not a verified full syllabus or permission to complete graded work; a graded `scaffolding_only` session retains that policy.

The task's deadline is the exact normalized exam/goal deadline already reviewed in the accepted plan. Its original source label, date/instant precision, timezone and unknown reason remain intact. It is not independently established as an official school deadline. Proposed study blocks are separate scheduling suggestions and never become the task deadline. Task effort is a reviewed estimate, including `null` for unknown effort.

Tasks use the existing `createTask` boundary, which stores `origin: manual` and no fabricated UUID source references. This storage label does **not** erase the handoff origin: the independent receipt is authoritative provenance. Downstream source-aware context and calendar exports must use the read-only verifier below rather than treating a sourced handoff task as source-free manual context. Core task fields alone do not prove provenance or source freshness.

## Exact review and durable recovery

The private preview is a `plan` record with format `learning_plan_task_preview_v1`. It contains selected candidate recipes, bounded prerequisite metadata, exact original source pins, canonical preview hash, creation operation key/hash and receipt references. It does not have the general study-plan schema and is excluded from the ordinary typed `/plans` dashboard.

Acceptance binds the exact displayed preview revision/hash, selected topic ID, resolved task hash and `confirmed: true`. That task hash includes the candidate/source binding, normalized task payload, current prerequisite task IDs/revisions/hashes and explicit student-reported completed prerequisites. A changed prerequisite revision requires a fresh displayed review. A title/effort/deadline change or deleted prerequisite blocks the dependent handoff; normal status updates may be reviewed again against their new pins.

Each topic's independent `inbox_item` receipt has format `learning_plan_task_receipt_v1`, a deterministic identity based on local student + accepted plan record ID + topic ID, and a canonical reviewed payload hash. Two same-title topics with different IDs remain distinct. Multiple previews of that same plan/topic cannot create a second task. A separately prepared new plan has its own identity; the feature does not guess whether its similarly titled work duplicates a different plan or manually entered task.

The implementation deliberately handles **one task effect per request**, using existing trusted storage helpers:

1. Atomically save the exact `accepting` human receipt plus its preview receipt reference with `commitWorkspaceBatch`.
2. Look up an immutable task-create result with `getTaskCreateResult` under the stable topic operation key. If none exists, revalidate the original source and resolved prerequisite pins, then call the existing idempotent `createTask` once.
3. Finalize the independent receipt with the created task ID, original task-create hash and completion time.

This is a durable reviewed sequence, not a claim that the task and receipt are in one cross-table transaction. A lost response after the task committed leaves a recoverable pending receipt; retry returns the same task ID and creates nothing else. Restart and backup restore preserve the exact review and task-create proof. A deleted task is never recreated just because its old receipt exists.

If the source or prerequisites changed **before** any task committed, recovery refuses to create a task using the old permission. The interrupted receipt remains visible; prepare and accept a new catch-up plan to make a new source-bound decision. If the exact task already committed before that change, recovery may finalize only its original receipt with zero new task effects; the preview remains visibly stale. This exception does not grant new task creation or automatic approval to changed content.

## API and verifier contract

`createPlanTaskService({ store, getLibrary, learningService?, clock? })` exposes `state`, `inspect`, `get`, `preview`, `accept`, `forget` and `taskProvenance`. Root supplies `getLibrary: studentWorkspace.library` and owns one singleton. The optional Learning service supports the existing accepted-plan/session validators. The optional clock returns integer epoch milliseconds.

The normal paired cookie/nonce, same-origin, strict JSON/no-query and current authorization checks protect these routes:

| Route | Contract |
| --- | --- |
| `GET /api/local/v1/plan-tasks/state` | Accepted-plan metadata/current-stale status, saved preview summaries and explicit limits/nonclaims |
| `GET /api/local/v1/plan-tasks/plans/:id` | Exact eligible plan reference/source pins and current task candidates; no source bodies |
| `POST /api/local/v1/plan-tasks/previews` | `{ plan_ref: { id, revision, plan_hash, catch_up_hash }, topic_ids: [...] }`, `Idempotency-Key`; returns `{ preview }`; zero task effects |
| `GET /api/local/v1/plan-tasks/previews/:id` | Exact saved preview, current rows/prerequisite pins, source staleness and receipt references |
| `POST /api/local/v1/plan-tasks/previews/:id/accept` | `{ expected_revision, preview_hash, topic_id, task_hash, confirmed: true }`; returns `{ preview, receipt, task, replayed, task_effects }` |
| `DELETE /api/local/v1/plan-tasks/previews/:id` | `{ expected_revision, preview_hash }`; exact current preview deletion with retention explanation |

Preparation retries bind the exact sorted selected topic set and source pins. Reusing a key with another body or a stale accepted plan fails. Acceptance replay uses its independent exact human receipt; it cannot select another topic, change the task hash or duplicate the effect. Unknown fields, unsafe accessors, sparse/decorated/duplicate arrays, unselected topics, cross-workspace IDs, forged hashes, stale revisions and missing confirmation are rejected.

Limits: 20 selected topics per preview, 100 retained current previews, 100,000 preview bytes, 120,000 persisted record bytes, 12,000-byte preparation JSON body and 4,096-byte accept/delete body. The original catch-up-plan bounds remain in force. Source/candidate evidence is not silently truncated to fit a preview; over-budget requests fail before persistence. There is no multi-task acceptance endpoint.

Downstream trusted code may call:

```js
verifyPlanTaskProvenance({ store, getLibrary: studentWorkspace.library, taskId })
// or the singleton: planTaskService.taskProvenance(taskId)
```

The method is read-only and returns `{ receipts, pins }`. Unrelated manual tasks return empty arrays. Each pin is `{ kind, id, revision, hash }`, where the hash is canonical SHA-256 of the workspace record's **data**, and kinds are `learning_plan_task_receipt`, `learning_catchup_plan`, `tutoring_session` and `learning_academic_snapshot`.

Each receipt annotation contains its ID/revision/payload hash, task ID, selected plan/session/snapshot source metadata, topic ID/citation references, exact reviewed task payload, human review, prerequisite pins, student-reported completed prerequisites, original task-create hash and `local_task_differs`. It contains no course text bodies or excerpts. Its academic policy is the current revalidated session policy; the catch-up plan has no independent policy override.

Accepted receipt IDs and original task-create hashes are independently bound against the immutable `getTaskCreateResult` record. A changed final task ID cannot attach another task to these sources or make the original task appear source-free. Manual edits to the current task are separate and produce `local_task_differs`; they do not replace source evidence. Stale or malformed matching receipts fail, and a matching interrupted task denies downstream use until explicit recovery finalizes its receipt. Source annotation/pins/policy must be included in a downstream context's byte accounting and version binding. Calendar/context integration has its own agent-owned acceptance tests; this helper is not a claim those gates were passed automatically.

## Objective verification completed

```sh
cd web
node --test scripts/plan-task-*.test.mjs
node --test scripts/plan-task-*.test.mjs scripts/local-learning*.test.mjs scripts/academic-task-*.test.mjs scripts/academic-tutoring.test.mjs scripts/academic-planning.test.mjs
```

All **25 new service/route/HTTP/controller/MCP cases** and **94 combined handoff/Learning/academic-task/tutoring/planning cases** pass. Checks include:

- A proposal cannot become accepted through handoff; original accepted plan remains unchanged and preview makes zero tasks/checkpoints/calendar writes.
- Exact separately accepted topic creates one pending local task, literal source citations, preserved effort/unknown/date-only/instant goal deadline and paired human receipt; retry creates none.
- Prerequisite acceptance is separate, graph IDs bind real local tasks, current revision edits require fresh review and missing/changed/deleted prerequisites block dependent effects.
- Same-title distinct topics, repeated previews, forgotten previews and deleted tasks retain independent stable identities without duplicate or restored transactions.
- Modified/new/forgotten selected sources, session/plan removal, changed plan pins and invalid human receipts deny new effects; retained previews stay visibly stale.
- Lost completion response after actual task commit, interruption before any task effect, source revocation during recovery, dependency changes during recovery, restart and verified fresh backup restore.
- Maximum 20-topic preview produces independent proposals; accepting one creates only that one task.
- Strict IDs/methods/fields/hash/revision/confirmation/accessor/array checks and current authorization recheck before mutations.
- Actual reviewed course import → Learning session → explicit plan acceptance → handoff preview → one task visible in Today; unrelated notes/grants/checkpoints/sources are preserved and own previews stay outside typed `/plans`.
- Actual shipped controller against real paired HTTP starts selections/confirmations unchecked, previews without tasks, requires checkbox and final modal, accepts only the chosen task and exposes current prerequisites. A saved preview clears the superseded earlier plan inspection so old readiness labels/controls cannot mislead after acceptance. Cancellation, detached former controls and late responses after reset cause no mutation or stale plan exposure.
- Read-only provenance validates original receipt/task-create IDs/hashes, current source pins and retained `graded/scaffolding_only` policy, reports manual edits, denies stale/incomplete sourced tasks and preserves unrelated manual task context.
- Actual paired HTTP setup through the real fixed-grant stdio MCP SDK client verifies a selected graded handoff task plus an unrestricted note. Context carries metadata-only source pins and the strongest `graded_restricted` policy, with exact byte accounting and no original course body, unselected note, citation text or account identity. A scope-wide revision/general proposal is denied even when its target note is unrestricted; an outline remains unreviewed and retains `graded_restricted`. Forgetting the selected course stream denies later context, document-only subsets and task/writing proposals through that old grant.

Controller tests use a synthetic DOM with actual HTTP/SQLite. The MCP test uses a real SDK subprocess and local IPC handler; it verifies that boundary, not that a model independently chose to call a tool. These tests do not establish live D2L login or a student's demonstrated mastery. Downstream source-aware calendar tests remain separate evidence.

### Native browser and durable restore proof

The root agent separately accepted two synthetic plan topics through the actual paired local browser. Independent SQLite readback at `2026-10-05T03:12:04.113Z` verified two accepted handoff receipts with `graded/scaffolding_only` policy, pending task efforts of 30 and 45 minutes, and the exact date-only goal `2026-10-10` in `America/Toronto`. The second task depends on the first task's real ID. The workspace contained five tasks in total; no agent task proposal was accepted. The readback receipt is `/tmp/learnbridge-review-handoffs-live.json`.

A separate fresh backup/restore at `2026-10-05T03:16:21.328Z` preserved those actual browser-created records exactly across the five stored tables (`records`, `document_revisions`, `workspace_records`, `task_proposals`, `agent_grants`) and reopened with integrity `ok`. The original note remained revision 1 with SHA-256 `488d61c4f4c6f890cbac055c17832f2d2f27e6599d425ded84ec9558b8414818`. The schema-5 backup was 991232 bytes with SHA-256 `cd8f9bcb2cd7c2815259f4a0ba63272a9409d394857e59d6563a767962e25ad6`; the credential profile was excluded. The independent receipt is `/tmp/learnbridge-productivity-browser-restore.json`. These are synthetic browser/SQLite/restore checks, not evidence of course completion, mastery or live D2L access.

## Remaining F09 work

This closes the accepted-plan → separately reviewed local-task handoff gap in [F09](../FEATURES_ACADEMIC.md#f09-catch-up-plans-and-exam-preparation), with the separate review requirement from F08. It does not complete automatic syllabus/topic-map discovery, adaptive learning evaluation, source-aware task corrections between different plans, preservation of pinned study blocks during replanning, or external calendar submission. Each needs its own source/review/verification contract; none is inferred from task creation.
