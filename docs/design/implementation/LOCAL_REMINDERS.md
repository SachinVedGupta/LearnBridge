# Opt-in local task reminders

Implemented 2026-10-04. This feature checks **only existing tasks explicitly
selected by the student**, and delivers deadline updates to LearnBridge's local
in-app inbox while the local runtime is running. It is a working local scheduler,
not a claim of operating-system notifications, background AI, provider refresh,
cloud delivery or execution on a sleeping laptop.

## Student workflow

1. Launch and pair the local LearnBridge dashboard. Create or accept the tasks
   you want in **Today**. Keep unresolved dates unknown rather than inventing one.
2. Open **Reminders**, select exact task checkboxes, name the schedule, choose a
   fallback time zone and look-ahead window. Nothing is selected automatically.
3. Choose **Save paused reminder**. Saving performs no due check and no delivery.
4. Review the displayed selected tasks and choose **Activate local reminders**.
   Confirm the exact schedule revision and local-only behavior in the in-app
   review. This persistent opt-in permits checks of future edits to these same
   task IDs; it does not expand the selection or authorize another account.
5. Keep the local LearnBridge runtime running. Its owned 30-second interval
   checks active schedules. Open or refresh the local inbox to see new updates.
   **Check selected reminders now** uses the same bounded service immediately.
6. Acknowledge inbox entries when you have reviewed them. This records local
   acknowledgement; it neither completes the task nor sends a notification.
7. Pause a schedule to stop new publication. Cancellation is permanent for that
   schedule. The saved inbox and revision history remain. Resuming a paused
   schedule preserves its prior deadline watermark, so an unchanged deadline
   stays quiet.

Active opt-ins survive an actual runtime restart. Checks resume only when that
student's owned runtime starts again. If the laptop or runtime was stopped,
the next check coalesces the gap into **one currently relevant stage** for each
selected deadline rather than inventing executions or sending every missed
occurrence. Browser logout blocks inbox access, while a previously confirmed
active schedule can still check its selected local tasks while the runtime runs.

## Deadline rules

| Task state or deadline | Local rule |
| --- | --- |
| Completed, cancelled, deleted or unknown deadline | No reminder; a deleted selection is not replaced |
| Exact instant strictly after now, within selected look-ahead | `due_soon`; inclusive at the look-ahead boundary |
| Exact instant at or before now | `overdue`; original instant retained |
| Date before today's local calendar date | `overdue` |
| Date equals today's local calendar date | `due_today`, with no invented due hour |
| Future date within the local calendar date reached by the selected look-ahead | `due_soon` |
| Later deadline | No reminder |

For a date-only deadline, the task's recorded IANA time zone takes precedence;
only a missing zone uses the selected schedule fallback. Actual calendar dates
and daylight-saving boundaries are obtained with `Intl.DateTimeFormat`. A
Toronto fall-back date remains `due_today` for its full 25-hour local day.
Date-only values never become UTC midnight. Exact-instant comparison uses the
recorded instant rather than a display-time-zone conversion.

The look-ahead is 15–10080 minutes. A date-only look-ahead describes covered
calendar dates, not a claim that a deadline occurs at midnight or that the
student has a known number of hours remaining. The UI labels its precision.

## Components and persistence

- `web/apps/local-runtime/src/reminder-service.mjs` exports
  `createReminderService({store, clock})`, `REMINDER_LIMITS`, and the pure deadline
  classifier. `clock` defaults to `Date.now`; tests use a controllable clock.
- `web/apps/local-runtime/src/reminder-routes.mjs` exports
  `handleRemindersRoute`. There is no agent IPC/MCP entry point for activation.
- `web/apps/local/public/reminders.js` exports `mountRemindersUI`; it uses exact
  choices, narrow request payloads, in-app confirmations and literal text nodes.
- The root server owns one 30-second interval, marks it `unref`, catches errors
  without printing private input, and clears it and calls `dispose()` before
  closing SQLite. The service creates no timer of its own.

Each schedule is a student-owned `routine` workspace record with the exact
category `selected_task_reminders_v1` and strict format 1. It stores selected
UUIDs, paused/active/cancelled state, a monotonically increasing consent epoch,
time zone, look-ahead window, per-task deadline watermarks, a bounded inbox,
creation request hash and last publication timestamp. New schedules default to
paused and carry a retry key plus request hash; a changed payload under the same
key fails rather than silently becoming another schedule.

A tick reads at most 20 schedules with at most 50 selected tasks each. It reads
current selected task snapshots only, and independently rechecks selected task
revisions before publishing. The schedule revision and consent epoch are
rechecked; a stale pause/cancellation or changed task discards that result.
Watermark and inbox publication use **one actual `commitWorkspaceBatch` SQLite
transaction with compare-and-swap and persisted readback**. They cannot be
published separately. If publication is interrupted, the next tick/restart
retries from durable state. An unchanged tick writes no new workspace revision.

Deduplication uses actual deadline precision/date/instant/time zone and the
latest delivered stage. A task-title edit or wording-only provenance edit does
not repeat a reminder. A moved deadline is followed because the student opted
in to that selected task ID. Stage changes are meaningful new updates. Backward
clock movement cannot replay an earlier stage of an unchanged deadline.
Acknowledgement is revision checked; retrying an already acknowledged event is
idempotent.

### Bounds and honest retention

- At most 20 retained schedules, including cancelled schedules; creating further
  schedules fails with a bounded error. Reviewed archive/removal is a later
  feature rather than silent history deletion.
- At most 50 selected existing tasks per schedule; no automatic replacement,
  account discovery or broad task discovery occurs in a background tick.
- At most 50 **current** inbox entries per schedule. New events evict the oldest
  current-view entries and increment an explicit discarded-entry count.
- Per-task watermarks survive inbox eviction, so capped history does not cause
  repeated unchanged updates.
- Workspace immutable revisions, exports and backups may retain earlier inbox
  entries. This cap is not physical erasure or a promise that old content has
  disappeared from disk.

A blocked event loop, stopped process or sleeping laptop may delay checks. The
30-second interval is a running-runtime cadence, not a hard real-time guarantee.
Runtime ticks do not create tasks, profile facts, documents, grants, model calls,
source scans, provider reads, messages or account writes. They cannot execute
instructions embedded in a task title or imported source text.

## HTTP contract

Every route is under `/api/local/v1`; root origin, paired cookie, nonce, private
body and no-query guards apply. The handler independently requires the paired
session and rechecks authority after an awaited body before a mutation. Unknown
fields and unsupported methods/routes fail before an operation can expand scope.
All responses use private/no-store caching.

| Route | Method | Operation |
| --- | --- | --- |
| `/reminders/status` | GET | Runtime processing, delivery limits and last observed check |
| `/reminders/context` | GET | Paired foreground picker metadata for existing local tasks |
| `/reminders/schedules` | GET | Exact schedules and current selected task metadata |
| `/reminders/schedules` | POST | Create paused `{title,task_ids,timezone,due_within_minutes}` with idempotency key |
| `/reminders/inbox` | GET | Bounded snapshots, schedule revision and acknowledgement |
| `/reminders/check` | POST | `{confirmed:true}`; invoke the same bounded local drain |
| `/reminders/schedules/:id/state` | POST | `{expected_revision,state,confirmed:true}`; activate, pause or cancel |
| `/reminders/schedules/:id/ack` | POST | `{expected_revision,event_id}`; acknowledge one retained local event |

There are no token, provider-refresh, native-notification, send, cloud-delivery,
model-execution or arbitrary-background-job routes.

## Objective verification

Run from repository root:

```sh
node --test web/scripts/local-reminder-service.test.mjs web/scripts/local-reminder-routes.test.mjs web/scripts/local-reminder-ui.test.mjs web/scripts/local-reminder-http.test.mjs
```

The focused suite contains **37 cases**:

- **18 actual SQLite service cases:** exact task selection, paused default,
  confirmed activation, quiet unchanged/no-write ticks, durable acknowledgement,
  actual restart, due/overdue boundaries and missed-runtime recovery, Toronto
  DST/date precision, unknown/completed/cancelled silence, changed-task following,
  consent epoch/pause/cancellation CAS, interrupted atomic publication recovery,
  current-inbox retention cap, idempotent creation, schedule/task/input bounds,
  deleted selection, disposal, no unrelated reads or effects, corrupted-state
  rejection, provenance-only edit quietness and concurrent task-change rejection.
- **7 route cases:** paired authority, narrow schemas, actual SQLite round trip,
  authority loss while body acquisition waits, unsupported/query/provider routes,
  exact methods and refused confirmation.
- **9 shipped UI handler cases:** unselected default, literal source text,
  retained retry identity, refused/fresh/stale activation, pause/cancel, reset
  during consent or busy work, late response suppression, duplicate handler
  prevention, narrow manual check/ack payloads and older-refresh suppression.
  These are dependency-free handler fixtures, not a claim of browser rendering.
- **3 actual HTTP/runtime cases:** full origin/cookie/nonce/query/schema guards;
  paired create/activate/check/ack/restart; and a **real 30-second timer** that
  publishes an overdue update without calling the manual check route, confirms
  `unref`, observes explicit `clearInterval` at shutdown, reopens the owned
  workspace and verifies durable unchanged deduplication.

The timer case uses a disposable selected synthetic task. It checks a real
interval and actual server/SQLite publication; it does not wait for a provider,
read private student records, send anything or claim an OS notification. Whole
release validation and browser evidence belong to the current release receipt;
this component's fixture results do not establish physical-phone behavior,
university compatibility or external-account refresh.

## Remaining work

Provider-specific refresh, source-change watches, official linked study
briefings, OS/remote notifications, reviewed schedule archive, quiet hours and
calendar/event scheduling need separate source selection, capabilities,
approvals and verification. They must not be enabled by reusing this local
selected-task reminder consent.
