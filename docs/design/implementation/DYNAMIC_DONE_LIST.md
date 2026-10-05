# Dynamic to-do and done list

This workflow gathers work from the student's selected saved sources, keeps source changes visible, attaches actual agent sessions to tasks, and separates useful preparation from proof that something is done.

## What a student can do

1. Open **Done list** to see every local task organized into overdue, today, upcoming, date review, blocked, done and cancelled groups. Each task explains why it appears there. Exact timestamps retain their ordering; date-only values stay dates. Task dependencies and manual priorities remain visible.
2. Select exact saved school/account/course, imported message, reviewed calendar-file or project-checklist sources. All selections and automatic actions start off. The student's saved policy determines what the local runtime may check every 30 seconds.
3. Leave **automatic task creation** off to accept each source suggestion separately, or explicitly enable it for the selected sources. This creates only deterministic structured tasks: assignment metadata, explicit message action markers, selected-event preparation and reviewed project checklist entries. It does not enable laptop scanning, cloud polling, provider writes or AI sharing.
4. Select one ordinary imported message, preview its full body/account/version, then confirm **Find actions with Codex**. The official local host receives exactly that private context copy. Up to three source-quoted AI suggestions become pending task reviews. They never bypass acceptance even if deterministic automatic creation is enabled.
5. Use **Get started** on a task to open its attached agent workspace. The separate task-session workflow reviews exactly what context may be shared, runs the official host in the background, and saves its actual progress, results and proposal receipts. The Done list displays the latest linked session and opens it directly.
6. Review changed source metadata before applying it to an accepted task. Existing student edits are preserved until that exact review. Missing, forgotten, failed or deselected sources do not delete, complete or recreate a task.
7. Optionally enable completion from a selected local project checkbox. Only an unchanged matching task can be completed by that exact student-reported checkbox. Other source marks, deadlines, browsing, focus time or model claims do not establish completion. Agent results require the separate task-session review.

## Source acquisition and honest coverage

| Source | Input that exists today | Task interpretation | Refresh coverage |
| --- | --- | --- | --- |
| D2L/Avenue | Student-reviewed current academic export or selected School connection read | Structured assignment title and exact source deadline; unknown dates remain unknown | Tracks the current saved academic stream after another reviewed import. Does not perform school login or live API polling here. |
| Gmail, Outlook, Teams, Discord, Slack and other updates | Account-qualified update imported in **Updates and projects** | Explicit `TODO:`, `Action:` or checkbox lines; optional literal `\| due=YYYY-MM-DD` | Only the selected already imported message body. An ordinary prose message needs separate exact AI preview and sharing consent. |
| Calendar | Accepted selected `.ics` busy-file events | “Prepare for” the selected event at its start | Immutable selected file observation; does not infer that classes, meetings or assignments were attended or completed. |
| Projects | Student-reviewed ordered local checklist | One task per selected checklist item, with prerequisites linked to separately created/accepted local tasks | Watches the selected local checklist revision; exact student-reported checkbox is the sole automatic completion source. |
| Manual/accepted tasks | Existing local task storage and accepted academic/productivity proposals | Already present in the unified task list | No import, automatic acceptance or source fuzzy-matching is required. Known reviewed source receipts can link without duplicating tasks. |

Linking a connected provider account does not constitute permission to read its whole inbox, and an imported message is not proof of complete live coverage. The current public cloud onboarding download can be inspected and imported separately. General continuous cloud ingestion and remote connector polling are additional work, not a claim of this local implementation.

## Implementation contracts

`createDynamicTaskService({store, studentWorkspace, clock})` owns source selection, deterministic reconciliation, sorting and task provenance. `createDynamicTaskAIService({store, dynamicTasks, hostTurns})` owns one-source prose extraction.

### Source policy

One `schedule` record stores `dynamic_task_config_v1`:

- `selections`: up to 20 exact `{kind, id, course_ids}` values. School selections use the stable current stream ID and at most five explicitly chosen courses. Other source kinds have no course list.
- `enabled`, `auto_create`, `auto_complete`: separately reviewed booleans, all false initially.
- `policy_hash`, `reviewer`, `reviewed_at`: exact reviewed policy receipt.
- Revision comparison prevents one tab overwriting another tab's scope.

Changing a policy does not create an agent sharing grant. Automatic creation is narrower than arbitrary model interpretation. A selected school stream can produce newly observed structured assignments under the accepted policy; it cannot silently add an unselected course or account.

### Observations and reconciliation

Each `inbox_item` with `dynamic_task_item_v1` contains its exact source identity, observation hash, source pin, proposed task payload hash, state, acceptance receipt and optional task/completion receipt. There are at most 300 retained observations, with at most 200 items inspected from each selected source.

Stable identities are institution/account-qualified assignment IDs, selected calendar source plus event UID, selected project plus checklist item ID, or imported provider/account/source identity plus canonical marker title/occurrence. AI candidates are pinned to the imported source identity and exact supporting quote. Deadline changes do not create a second task. Exact known academic/productivity acceptance receipts join the same task. Ambiguous equal manual tasks require an explicit link rather than another creation. Tasks already linked to another qualified source are not fuzzy-merged across accounts.

Refresh first checks all selected observations for overlapping contradictory current sources. Conflicts block automatic creation and reviewed acceptance. Refresh never edits an accepted task's metadata. Active observations display differences; **Apply displayed source details** compares both task and observation revisions before changing only the reviewed title/deadline/course fields. Other task fields are retained.

An acceptance records intent before task creation. `getTaskCreateResult` and the task-create idempotency key recover only an exact previously committed creation after interruption. A deleted task is displayed as unavailable and is never silently resurrected. A reviewed source checkbox completion similarly saves intent before its one status write; recovery checks the exact next task revision.

### Ordinary-message AI extraction

1. The context endpoint returns selected source metadata, not message bodies.
2. A separate preview reads one exact selected update. Its source hash and revision, provider/account, subject, complete body, copied context and review hash are displayed. A body over 16,000 bytes fails before note, grant or model creation; no silent truncation occurs.
3. Exact confirmation creates one private `graded_restricted` context note and one 60-minute destination-bound Codex grant. No unrelated note/task/account is granted. A repeated operation key reuses the same extraction rather than replaying a model call.
4. The normal official host receives a trusted `read_only` tool policy, persisted with the turn and bound into its retry hash. Only status/context function schemas are advertised. The profile and native adapter reject hidden proposal-tool requests before issuing a broker permit or brokered RPC; the runtime also denies unbrokered direct native MCP calls before any store write. The wrapper requests a bounded `BEGIN_LEARNBRIDGE_TASKS_V1` block inside its one-answer envelope; it never asks for generic task/document proposals. This policy is an internal library option, never a public HTTP or model field. Course and interview studios use the same read-only boundary; task agents retain their separate reviewed-proposal flow. The deprecated CLI-exec fallback refuses a read-only request rather than using weaker enforcement.
5. A deterministic parser requires one block, at most three tasks, an exact verbatim nonempty quote per task, and a null deadline unless a literal valid `YYYY-MM-DD` date occurs in the same quote. Unknown keys, invented quotes/dates, duplicate quotes/blocks or malformed output fail closed. Relative weekdays and “next week” remain unknown. Model-inferred ownership remains a review question.
6. Only a successfully completed, current granted host result can be parsed. Source or private-copy mutation/deselection before collection withholds the result. **Stop finding actions** cancels the exact running turn; a late cancelled answer cannot create candidates. Invalid output is recorded once and never retried automatically. Restart does not replay a model turn.
7. The extraction receipt pins source, context note, grant, host output hash and parsed candidate hashes. Up to three pending observations are published in a single SQLite batch. A publication failure can recover that exact receipt without duplicate candidates. Automatic polling can collect supported candidates, but never accept them or complete a task.

### Progress and agent sessions

The Done list reads `/task-sessions`, selects the latest session with the task's exact `task_pin.id`, and displays its real state, latest audited tool event and reviewable result. It polls every two seconds while a linked model turn runs and every 30 seconds when source watching is enabled. Reset/logout clears private content and cancels UI polling. The runtime's selected-source worker remains independently bounded.

`taskProvenance(taskId)` returns metadata-only receipt/source pins and conservative academic policy. It does not automatically share the assignment body, email body or local profile with the task agent. `Get started` and `Open agent session` remain separate integration callbacks; task-session execution owns exact context consent, host availability, cancellation, result review and the final “done” decision. A model's successful turn is a reviewable result, not proof of submission or learning.

## Routes

All routes retain the runtime's loopback origin, pairing cookie, nonce, no-query and body-size gates. Mutation handlers check authority again after waiting for the body. These routes are not model IPC tools.

| Route | Method | Effect |
| --- | --- | --- |
| `/dynamic-tasks/context`, `/dynamic-tasks/list` | GET | Source metadata or unified saved task/observation view |
| `/dynamic-tasks/config` | GET / POST | Read or explicitly review exact selected source policy |
| `/dynamic-tasks/refresh` | POST `{}` | Bounded selected local reconciliation; no provider/model call |
| `/dynamic-tasks/items/:id` | GET | Exact saved item and current review hash |
| `/dynamic-tasks/items/:id/accept` | POST | One exact local task or separately reviewed existing-task link |
| `/dynamic-tasks/items/:id/reject` | POST | Dismiss one pending source item |
| `/dynamic-tasks/items/:id/apply-source` | POST | Explicit current source metadata update to one exact task revision |
| `/dynamic-task-ai/context`, `/dynamic-task-ai/extractions` | GET | Selected source metadata or extraction progress |
| `/dynamic-task-ai/preview` | POST | Preview exactly one selected imported body; no grant/model call |
| `/dynamic-task-ai/extractions` | POST | Exact confirmed source-copy/grant/official-host start |
| `/dynamic-task-ai/extractions/:id` | GET | Current extraction status and permitted result |
| `/dynamic-task-ai/extractions/:id/collect` | POST `{}` | Validate completed output and atomically save only pending candidates |
| `/dynamic-task-ai/extractions/:id/cancel` | POST | Interrupt the exact selected extraction and reject late output |

## Objective verification

The targeted suite is `web/scripts/dynamic-task*.test.mjs` plus `web/scripts/local-codex-tool-policy.test.mjs`. It runs actual SQLite stores, the shipped route handlers and UI handlers, and actual host orchestration with a clearly identified fixture executor. The tool-policy tests also exercise actual SDK MCP stdio and paired runtime IPC using a synthetic native host; they prove policy enforcement and transport behavior, without a real model/account call. Fixture model text does not establish a live Codex or provider connection.

| Acceptance check | Required observable evidence |
| --- | --- |
| Off by default | Import sources, load the list, and assert zero new observation/task/grant/model records before explicit policy/action. |
| Scope isolation | Include an unselected course/account/message canary. It must be absent from returned observations, shared model context and final task provenance. |
| Exact deadlines and sorting | Verify date-only and unknown source values, timestamp order, the student's local day, prerequisites and no completion after advancing the clock. |
| Stable reconciliation | Refresh twice, restart the store, then refresh a changed source. Count actual task rows, stable IDs and preserved edited title/effort; no duplicate task. |
| Exact changes | An old source/task revision must reject. A fresh reviewed metadata application changes only title/deadline/course; preserve other task fields. |
| Completion evidence | Tick an opted-in selected project checkbox. Independently read the completed task revision and stored source/intent receipt. A changed manual status or checked email marker must not auto-complete. |
| Recovery | Interrupt after durable task/status write and reopen. Recover only the exact committed receipt; deletion must remain deletion. |
| AI source sharing | Before confirmation, no source-copy note or grant. After confirmation, the real host context includes exactly the displayed body, account and note hash, and excludes all canaries. |
| AI rejection | Invented quote/date, duplicate quote/block, over-limit tasks, malformed JSON and completion fields produce zero pending/task writes. |
| Trusted tool policy | Verify the actual host row stores `read_only`; its eager schema list contains only status/context. Ask for hidden task/document tools, omit the started event or forge a completion: independently verify zero brokered proposal RPCs/writes. Attempt an unbrokered native MCP proposal and verify its denial plus zero store writes. Retry the same key with a different policy before and after reopening; both must conflict. |
| AI pending publication | Verify an actual atomic SQLite trigger failure rolls back all candidate rows; recovery produces exactly one row per supported quote. |
| UI review and sessions | Execute shipped handlers; change selection/reset during awaited consent and assert no mutation. Display actual linked session state, tool event, result preview and open control; completed tasks retain the session link. |
| Full browser flow | In a disposable workspace, pair, select sources, review the exact policy, accept or auto-create a task, start the official host, see background progress/result, review “done”, then independently read task/provenance records and reopen. |

For a live release claim, also run a real selected school/import refresh and real current-account message read, one official-host ordinary-prose extraction, and the physical-device workflow on the intended setup. Local fixtures do not establish account authorization, complete cloud coverage or employer compatibility.

## Next extensions and implementation order

1. Add live selected-provider ingestion only through each student's owned connector/account and exact bounded selection. Preserve the same imported-update/academic contracts, dedup identities, freshness and missing-data semantics. Verify two-account isolation, callback ownership and rate-limit/offline behavior before enabling background reads.
2. Add more evidence-backed completion sources: an independently read verified local artifact or explicitly selected provider status. Each source needs its own matching and receipt contract. AI can suggest a progress update; a generated answer or inferred activity cannot be its own verification.
3. Add broader cloud-note task extraction using existing source-origin receipts. Preserve exact note/source hashes and separate model sharing; do not parse every imported document automatically.
4. Add controlled browser application preparation through a distinct selected-profile/browser capability. Open/fill local fixture forms and verify protected submission remains untouched, then prove the target employer's live compatibility with human review. Task agents must not claim application submission from a prepared packet or filled draft.

These extensions are feasible within the existing local source/storage/host architecture. They require their own objective evidence and cannot be represented as already working merely because this task list or a connector account exists.
