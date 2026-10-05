# Local focus sessions

Implemented F19 slice: one deliberately started local timer, exact reviewed pause/resume/end/discard, bounded observed interval accounting, restart/sleep recovery and persistent private history. It measures a timer, **not attention, mastery, attendance, wellbeing or productivity**. It makes no provider call, OS activity capture, model request or automatic task completion.

## Student experience

1. In **Focus timer**, enter a focus intention, planned minutes and IANA timezone. An existing local task may be associated explicitly; no task is selected by default.
2. Review and start. The initial recorded duration is zero even when the planned duration is 25 minutes.
3. Pause or resume with review. Paused time does not count. End saves a completed timer record; discard retains private history labelled discarded.
4. A long unobserved gap, clock problem or runtime restart interrupts the timer. Review its excluded gap, then resume with a new anchor, end using only recorded time or discard. Recovery never silently adds downtime.

There is one open session per workspace: running, paused or interrupted. End/discard clears that open slot. A planned duration is an intention; reaching it does not automatically end the timer, declare success, complete a task or certify learning. Notifications remain in-app. There is no sound, native OS notification, activity monitor or health inference.

## Accounting contract

`createFocusService({store,clock=Date.now,monotonicClock=performance.now})` maintains a private in-memory monotonic anchor for each running timer and persists cumulative integer milliseconds, observation timestamps, recent bounded interval history and review receipts.

The actual local runtime calls `observe()` about every **30 seconds** on an unref interval. Read-only UI refreshes do not write observations. Reviewed pause/end/discard also sample a bounded current interval. Ordinary service sampling does not write intervals shorter than one second. No per-second database heartbeat is used.

For each ordinary interval, credit is the smaller of elapsed monotonic time and nonnegative wall-clock time, capped by the session's remaining 24-hour accounting budget. A wall/monotonic rollback, missing in-memory anchor, or gap greater than **90 seconds** credits zero and interrupts. Source clock values are validated; invalid clocks cannot supply arbitrary credited duration. After an interrupted transition, a separate fresh review is required before completion/resumption. The same exact retry returns its earlier decision instead of bypassing recovery.

This is conservative **timer accounting**, not a claim that the app was foreground or that the student concentrated throughout an interval. Short idle/sleep periods below the gap threshold cannot be distinguished without OS activity monitoring, which this feature does not perform. Long gaps and restart downtime are excluded. No machine activity establishes mastery.

| Situation | Required result |
|---|---|
| 25-minute plan, 10 running / 5 paused / 10 running | Exactly 20 recorded minutes, not 25; one end receipt |
| Eight-hour unobserved gap | Entire gap excluded; state interrupted; explicit recovery choices |
| Process dies after a saved interval | Running record becomes interrupted on startup; last saved cumulative duration retained; all downtime and unpersisted interval excluded |
| Graceful runtime stop | Save only a bounded current interval, interrupt, clear anchors/timers; no auto-resume |
| Clock rollback | No new credit; interruption records the clock problem |
| Task is edited/deleted | Show changed/unavailable association; preserve task edits and all previously recorded time |
| Planned duration is reached | Timer remains student-controlled; no task completion or earned productivity claim |

The record timezone labels the student intention. Actual elapsed accounting uses clocks and does not convert duration through DST. Changing timezone for a later session does not rewrite completed timestamps. This slice does not reschedule future habit windows or certify native notifications; those remain separate F19 gates.

## State, storage and exact review

Existing `routine` workspace records carry format `focus_session_v1`; the existing life-routine format is separate and its list remains unaffected. States are `running`, `paused`, `interrupted`, `completed`, `discarded`. The record stores a reviewed intention, optional immutable task association, cumulative observed milliseconds, start/end/last observation, most recent 50 observations, interruption metadata and latest human transition receipt.

Methods: `context`, `list`, `get`, `start`, `pause`, `resume`, `end`, `discard`, `observe`, `dispose`. `get/context/list` are reads only. A live unsaved interval is displayed separately from durable time and disappears on an interrupted/restarted runtime; it is not reported as persisted credit.

Start requires `{title,planned_minutes,timezone,task_id?:UUID|null,confirmed:true}` and a creation idempotency key. An exact duplicate start returns its one existing session; a changed payload/key collision rejects. Another open session blocks a new start.

Transitions require `{expected_revision,session_hash,confirmed:true}`. The hash covers the exact durable timer record and revision. A successful transition commits one CAS receipt before moving/clearing the in-memory anchor. Exact duplicate starts/ends/transitions do not duplicate records or credited intervals. A failed SQLite write leaves its anchor intact and returns no false success. Startup validates retained records, refuses multiple corrupted open sessions and interrupts only previously running timers. It never replays a model or starts a timer.

Bounds: planned duration 1–240 minutes, maximum 24 hours recorded active timer time, most recent 50 observations and 200 retained active-view session records. Older SQLite revisions/backups may retain history; these bounds are not physical erasure guarantees. Discarded sessions are not completed sessions, and their preserved duration is not counted as a completed outcome. A large retained history currently requires workspace review before further sessions; archive/purge UI remains separate work.

## Routes and runtime lifecycle

All routes require root loopback host/origin, paired cookie, nonce and no-query checks. The focus route additionally checks the actual session and rechecks authorization after asynchronous body reading. No agent IPC or arbitrary OS/provider operation is added.

| `/api/local/v1` suffix | Method | Operation |
|---|---|---|
| `/focus/context` | GET | Current open timer, limits and available task metadata |
| `/focus/sessions` | GET | Private persistent history |
| `/focus/sessions` | POST | Explicit reviewed start |
| `/focus/sessions/:id` | GET | Current exact record/hash and provisional interval |
| `/focus/sessions/:id/pause` | POST | Reviewed pause or gap interruption |
| `/focus/sessions/:id/resume` | POST | Reviewed fresh-anchor recovery/resume |
| `/focus/sessions/:id/end` | POST | Reviewed completion using observed time only |
| `/focus/sessions/:id/discard` | POST | Reviewed discard, history preserved |

Root clears the 30-second interval and calls `dispose()` before closing storage. Dispose is idempotent, clears in-memory anchors and reports whether its final bounded persistence succeeded. If it fails, next startup still treats the earlier running record as interrupted and excludes downtime. A stale captured timer callback after runtime close cannot write.

## Shipped UI and heartbeat consent

`mountFocusUI({root,request,element,busy,confirmAction,message})` exposes `refresh/reset`. Refresh reads metadata every 30 seconds; reset clears polling, selections and private history. Titles/history render as text. No timer, selected task or model starts merely by opening the page.

Heartbeat observations can update revision/hash while a human is reviewing pause/end. After confirmation, the UI freshly reads the same exact session and verifies its immutable identity (ID/title/planned time/timezone/task association/start), state and last human-operation receipt. Only unchanged timer identity/state can reuse that consent to submit the latest revision/hash. A heartbeat advancing duration is permitted; another human action, changed timer, interruption, logout or source-bound session switch cancels the old action. The server still performs exact CAS. A final concurrent observation can require a refresh/review; no broad unconditional retry bypasses CAS.

## Objective verification

```sh
node --test web/scripts/local-focus-service.test.mjs web/scripts/local-focus-routes.test.mjs web/scripts/local-focus-ui.test.mjs web/scripts/local-focus-http.test.mjs
```

- Actual SQLite + manual clocks: exact 20 versus 25 minutes; eight-hour gap exclusion; first transition becomes interrupted and fresh recovery needed; ungraceful/graceful restart; rollback and asymmetric clocks; one open session; idempotent start/end; current hash/revision/consent; unchanged task; discarded outcome; no per-second read writes or automatic planned-time completion; timezone preservation; retention; actual trigger-aborted observation/transition and preserved anchor.
- Controller: exact routes, bounded keys, absent/revoked session during body wait and unsupported activity/task/provider aliases.
- Shipped UI handlers: empty initialization, separately reviewed start, literal text, declined actions, heartbeat revision refresh, other human action/state/identity refusal, fresh-GET race, reset/logout and double-click control. Stand-ins verify ordering, not native visual rendering.
- Actual paired HTTP: real two-second elapsed timer saved on pause/end and retained after restart with unchanged task; actual 30-second unref runtime heartbeat records an observation without a manual tick; close clears its timer and a captured stale callback writes nothing; restart remains interrupted; real origin/nonce/query/hash/schema/consent gates. Native browser elapsed-time proof is a separate check.

No fixture or model judge proves that a student focused or learned. The intended human pilot is whether starting/pausing/recovering a deliberately chosen timer is clear and useful.
