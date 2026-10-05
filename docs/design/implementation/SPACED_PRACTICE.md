# Source-backed spaced practice

Implemented local slice of F08/F09. This is usable human-authored practice, not AI-generated questions or an inferred knowledge score.

## Student journey

1. Create or import a reviewed private study note in **Notes**. School or cloud materials can be explicitly exported/imported into such a note through their existing reviewed flows.
2. Open **Spaced practice**. Choose one private note, load it and select an existing passage of at most 100 lines and 6,000 characters. The preview shows the exact line numbers and literal selected text.
3. Name the deck; declare whether its source is graded, ungraded or unknown; write up to 25 questions and reference answers yourself. Confirm that the answers were checked and these are ungraded conceptual questions rather than missing graded-submission answers. Saving requires an exact in-app review.
4. In the due queue, write an actual response. **Save answer before reveal** persists the exact response before enabling **Reveal reference answer**.
5. Read the human-authored reference and its pinned source passages. Check the comparison acknowledgement, then choose Again, Hard, Good or Easy. The saved receipt records only your own observation on this check. It never records mastery.
6. Resume an unfinished attempt after navigation/restart, skip without rating, pause/resume a deck, or remove it from active practice. Pausing and removing never modify the original note.

Sources, questions and reference answers are treated as literal text. This feature makes no AI requests, grants no model-processing permission, launches no tools and writes no tasks, calendars or coursework submissions.

## Exact evidence and policy

A deck pins each selected private document by student-owned ID, document revision, full-document SHA-256, academic-policy label, explicit line range and retained selected text. Every deck read, queue read, answer save, reveal and rating resolves those pins against the current private store. Editing even a source title or its policy advances its revision and invalidates the deck. Deleted sources are unavailable. Unrelated note edits do not invalidate it.

The deck hash covers its immutable title, exact selected passages, human-authored card content and declared policy. Schedules and active-attempt state have independently increasing storage revisions. Cards are not silently regenerated or moved to new source versions. A changed source requires a new reviewed deck. Stale summaries omit retained excerpts and student responses; stale decks can still be removed, including those with an unfinished attempt.

Each card is explicitly `ungraded`. Source grading is separately `ungraded`, `graded` or `unknown`; unknown is visibly labelled, not inferred. A document marked `graded_restricted` cannot be relabelled as an ungraded source. All cards require `human_authored: true` and `conceptual_only: true`. These acknowledgements establish the selected workflow, not semantic proof that every user-written question is appropriate or correct.

## Transparent scheduling rule

Rule ID: `transparent-cadence-v1`. Due instants are UTC timestamps; the UI displays the browser's local time. Fixed durations avoid inventing an institution-specific timezone or ambiguous daylight-saving wall time.

| Self-rating | Next review | Stage behavior |
| --- | --- | --- |
| Again | 10 minutes after the reviewed attempt | Reset to stage 0 |
| Hard | 24 hours after the reviewed attempt | Move back one stage, floored at 0 |
| Good | 1, 3, 7, 14, then 30 days | Advance one stage, capped at 5 |
| Easy | Same interval ladder | Advance two stages, capped at 5 |

A new card starts at stage 0 and is due immediately. First Good schedules 1 day; first Easy schedules 3 days. The 30-day cap stays 30 days. Every accepted rating adds exactly one repetition. An attempted answer, reveal, skipped card, paused deck or opened note adds none. Clock rollback before the deck's last activity or attempt reveal is rejected; a card cannot be answered before its due instant. This scheduling heuristic is understandable and deterministic; it makes no guarantee about retention.

## Persistence and concurrency

New records use the existing `learning_checkpoint` workspace kind, separated by formats `spaced_practice_deck` and `spaced_practice_attempt`. No migration or dependency was added. Existing learning views filter their own formats.

- Saving an answer creates one immutable-history attempt and updates its deck's `active_attempt_id` in a single `commitWorkspaceBatch` transaction. One deck has at most one active attempt. A retry key is hashed and its exact request is compared before any repeat mutation.
- Reveal requires the exact attempt revision and deck hash. It records a reveal timestamp; GET can then resume the same state after a lost response. Before reveal, the attempt response contains no reference answer or source excerpt.
- Rating requires phase `revealed`, exact attempt/deck revisions, exact deck hash, a valid rating and `reviewed_by_student: true`. It atomically closes the attempt and advances that card's schedule. An exact duplicate rating returns its saved receipt; changing the rating or old revision fails.
- Skip atomically closes an answered/revealed attempt and frees its deck without changing a schedule or repetition count.
- Current source checks occur before replay returns retained content, so retrying an old request cannot bypass source revocation.
- Student identity comes from the existing private `LocalStore`; clients cannot choose a reviewer or student ID.

Removing a deck hides it from active practice and closes access to its saved attempts. Retained attempt records, source copies, private immutable database revisions and backups may still contain text. This is explicitly disclosed; physical selective erasure is not implemented. The original note needs its own removal decision.

## HTTP and interface contract

The host invokes `handlePracticeRoute` only after its real paired-browser cookie/origin/nonce gate. The handler independently requires the paired session nonce and accepts exact bounded schemas. These routes are not published through agent IPC or public hosting:

| Route | Operation |
| --- | --- |
| `GET /practice/decks` | Private metadata/status summaries |
| `POST /practice/decks` | Reviewed human-authored deck creation; optional exact retry key |
| `GET /practice/due` | At most 200 due questions, with total count and stale-source coverage |
| `GET /practice/decks/:id` | Exact current deck/pins/schedules, without reference answers |
| `POST /practice/decks/:id/answer` | Persist own answer and open one active attempt |
| `POST /practice/decks/:id/state` | Exact CAS pause/resume |
| `DELETE /practice/decks/:id` | Exact CAS remove from active practice |
| `GET /practice/attempts/:id` | Resume current private attempt |
| `POST /practice/attempts/:id/reveal` | Explicit reference reveal |
| `POST /practice/attempts/:id/rate` | Reviewed self-rating and atomic schedule update |
| `POST /practice/attempts/:id/skip` | Close without a rating |

Limits: 100 active decks, 25 cards/deck, 5 selected passages/deck in the service (the initial UI selects one note/range), 1,500 characters/question, 3,000/reference answer, 6,000/student response, 64 KB input and 120 KB stored deck, 5,000 retained attempts and at most 9,999 repetitions/card. The due queue reports truncation rather than claiming all cards were shown. Unknown fields, accessors, sparse arrays, cyclic/prototype-bearing inputs, invalid IDs/hashes, out-of-range source indices and extra private query parameters are rejected.

The UI uses explicit labels and literal text nodes. Selection/read epochs suppress late source data, refresh epochs suppress superseded queue responses, and reset/navigation generations suppress late private answers. Changing source, card text or checkboxes while confirmation waits prevents the changed deck from being written. A fresh source-stale refresh clears a previously revealed reference from active UI.

## Objective verification

Run from `web`:

```sh
node --test scripts/local-practice-service.test.mjs scripts/local-practice-http.test.mjs scripts/local-practice-ui.test.mjs
```

Current result: **19/19 automated tests passed**, zero failures/skips. They exercise the shipped service, real SQLite storage, actual `startRuntime` HTTP handlers and shipped UI event handlers. The UI stand-in proves state behavior, not native browser layout.

| Cases | Definitive assertions |
| --- | --- |
| P01–P02 | Only selected source lines retained; reference concealed before actual answer/reveal; exact create/answer retries; no task/grant; own response survives restart; rating requires explicit review |
| P03 | Exact successive Good/Easy/Again/Hard intervals; due boundary; exactly one repetition per accepted rating; no mastery claim |
| P04–P07 | Source edit/deletion and stale retry rejection; unrelated-note isolation; pause/skip/clock rollback; graded-policy validation; accessors never invoked; source instructions remain data |
| P08 | Inject real SQLite failures between attempt/deck writes and between schedule/attempt writes; all writes roll back, prior schedule/state remain intact, integrity reports `ok` |
| P09 | Lost-response rating replay after restart and fresh backup restore returns the saved receipt; exactly one attempt and unchanged source/reference/schedule |
| P10/PH02 | Unpaired, forged nonce, cross-origin, query/unknown-field rejection; unsupported AI/tool/submit routes perform no writes |
| PH01/PH03 | Actual HTTP save→reveal→rate; concurrent exact double grade advances once; runtime restart, fresh restore, real source edit and stale-content suppression |
| PUI01–PUI06 | Complete real-service UI flow, unchecked acknowledgements, exact review race, late selected-source/reset suppression, stale reference clearing, labelled controls and literal HTML text |

Native browser verification remains a separate release check: on a disposable workspace, make a synthetic study note, create one card, answer/reveal/self-rate, restart and resume, edit that note and confirm a stale notice. Never use private course/grade contents in a shared screenshot. These automated checks establish bounded state/data correctness; they do not establish the correctness of every human-authored card or pedagogical effectiveness.

## Remaining expansion

AI-generated practice, exam-length question sets, bad-question adjudication, card editing/rebase, scheduling optimization based on human-reviewed learning outcomes and direct source-library extraction remain separate features. Any generated reference must carry resolved exact citations and academic restrictions and remain a proposal until reviewed. Model judges cannot establish universal pedagogical correctness. The initial human-authored flow is independently useful without an AI subscription or connected provider.
