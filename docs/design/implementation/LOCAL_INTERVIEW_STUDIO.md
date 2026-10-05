# Interview studio

## Feature and student flow

The local interview studio runs an ungraded mock interview using the student's official isolated Codex subscription. It asks one question, preserves the student's exact answer, and produces response-specific coaching before moving to the next question. Behavioral, technical discussion, and coding-reasoning modes share the same saved checkpoint model. Coding mode does not run code or report passed tests. Completing a mock records completed questions, not mastery, hiring readiness, or a predicted job outcome.

1. Save or select a posting in Career or Find internships. A manual posting is clearly student-entered and unverified; an official discovered role must still pass its current source check.
2. Choose the posting and checked current confirmed career profile facts. Conflicting, rejected, expired, stale, and unrelated-purpose facts are unavailable. No fact is preselected. Create a private session with one to ten questions.
3. Review the exact local context, then separately create its private coaching note. This note includes the selected posting and checked facts. It may remain in local history/backups.
4. Separately allow only this exact note for Codex. A 30-minute, 256,000-byte UI grant contains zero tasks, other notes, or source entries. The service independently rejects broad grants. Sign in through Local AI first if needed; there is no API-key fallback.
5. Review the exact generated prompt and confirm its send. The server pins the prompt SHA, note revision/hash, role revision/data hash, profile fingerprints and live grant fingerprint. The model reads the context through the existing broker and returns one bounded structured question.
6. Type an answer or explicitly start optional dictation. Review/edit dictation and save the exact answer locally. Saving does not send it to the model. Separately review the full feedback prompt, which includes that answer, before sending.
7. Read coaching against relevance, reasoning, evidence and communication. Every claimed observed dimension requires a literal nonempty quotation from the saved answer. Missing/not-assessed dimensions use no invented quote. Feedback has no numeric grade or global mastery claim.
8. Continue to the next question, open the linked AI session/receipts, pause, resume or finish early. Pause interrupts a running turn. No interrupted/unknown request is replayed after restart. Review a fresh request to retry.

Optional read-aloud uses browser speech synthesis. Optional dictation is feature detected, starts only after microphone approval, warns that the browser's speech provider may process audio, and never submits a response. Audio is not uploaded to a LearnBridge API. Browser/device microphone and speech services still require physical-device verification; text practice works when unavailable.

## Architecture and interfaces

- `interview-studio-service.mjs`: singleton domain coordinator, exact source/version/grant validation, persistent records and one-round state machine.
- `interview-studio-routes.mjs`: paired loopback HTTP endpoints. Not exposed to MCP/agent IPC.
- `interview-studio.js`: local interface, exact sharing/request confirmations, transcript and linked host conversation, generation/race guards, bounded retry keys and optional voice.
- Existing `hostTurns`: durable official Codex execution, context tool receipts, cancellation and fail-closed output visibility. The studio does not launch arbitrary commands or another agent provider.
- Existing `LocalStore`: `career_item` format `learnbridge_interview_studio.v1`, immutable document revisions, read grants and backup/restore.

HTTP paths:

| Path | Method and effect |
| --- | --- |
| `/interview-studio/state` | GET: current allowed posting/fact choices and saved sessions. |
| `/interview-studio/sessions` | POST: exact `role_ref`, `profile_refs`, mode and round limit; private save only. |
| `/interview-studio/sessions/:id` | GET: settle a completed linked turn and view the saved checkpoint. |
| `.../export-context` | POST: exact session revision/hash to create the private note. |
| `.../preview-run` | POST: exact session revision/hash; return the full reviewed prompt and its SHA without contacting a model. |
| `.../run` | POST: exact revision/context/prompt SHA, grant ID and `confirmed:true`; start one linked host request. |
| `.../answer` | POST: exact revision/context/round ID and literal student answer; no model call. |
| `.../transition` | POST: exact revision/context and pause/resume/finish action. |

The final host answer may include normal prose and exactly one `BEGIN_LEARNBRIDGE_INTERVIEW` / `END_LEARNBRIDGE_INTERVIEW` JSON envelope. A question has `kind`, `question`, `focus`, `source_refs`. Feedback has `kind`, `summary`, `strengths`, `improvements`, four unique rubric rows (`dimension`, `assessment`, `evidence_quote`, `reason`) and `source_refs`. Only selected role/profile IDs are allowed; the role ID is required. Extra fields, fabricated answer quotes, duplicate markers, missing dimensions, invalid states and malformed envelopes fail. A parse failure retains the linked host receipt, but creates no question or assessed answer.

Changed/removed posting or profile evidence, changed coaching note, expired or revoked grants withhold derived model text. The student's literal answers remain private local records. Because old model text belongs to its old grant, allowing a new grant does not revive a revoked/expired question; start a fresh interview. Questions and transcripts are never silently substituted.

Every question and feedback request supplies trusted host option `toolPolicy:'read_only'`. The student/model/HTTP body cannot select a wider policy. Only status/context reads are enabled for coaching; task/document proposal functions remain disabled at the host/broker boundary even if the model asks for them. A coaching request must never create review-queue writes as a side effect.

The exact coaching note must fit the fixed 32,000-byte embedded context read. Before creating the private session, exporting its note, or starting a previously saved context, the service serializes the entire selected context with `JSON.stringify(context, null, 2)` and requires `Buffer.byteLength(JSON.stringify(serialized)) <= 24000`. This accounts for JSON escaping of the exact note string and leaves 8,000 bytes for bounded document/MCP metadata. An oversized selection returns `BUDGET_EXCEEDED` before saving a session/note, sharing or calling a model. The student can choose fewer relevant facts or a shorter reviewed excerpt; evidence is never silently truncated.

## Implementation plan for further extensions

1. Keep the same saved checkpoints for additional provider adapters. An embedded Claude adapter must prove real owned-device auth and tools before it is offered; do not substitute borrowed tokens or an API key.
2. Add executable coding practice only behind a bounded disposable sandbox with CPU/time/memory limits, selected language/test evidence and isolated dependency handling. Passing locally supplied tests must remain a narrow test result, not correctness/mastery or employer compatibility.
3. Add longer interviews through explicitly reviewed fresh grants, not automatic sharing renewal. Design grant renewal so prior reviewed local transcripts have deliberate retention/visibility semantics.
4. Add audio-turn APIs only with a clear independent audio destination/retention review. Preserve editable transcripts and an accessible text path.

## Objective verification

`node --test scripts/interview-studio.test.mjs` uses fixture model outputs through the actual host controller, broker context reads, SQLite, revisions and backup/restore. It establishes orchestration and boundaries; it does **not** establish a live Codex model turn, employer compatibility, real microphone capture, browser voice quality or improved interview outcomes.

| Checks | Definitive pass condition |
| --- | --- |
| IS01–IS02 | Private selected session/note without calls or broad sharing; exact narrow grant enforced. |
| IS03–IS04 | One generated question → byte-exact actual answer → source/quote-validated host coaching → next question/completion; no task writes or code/hiring claims. |
| IS05–IS08 | Prompt/revision/round/hash and retry guards; fabricated quotations/references/malformed model output fail without creating assessment. |
| IS09–IS10 | Source changes and revoked grants withhold derived model text and block invisible-question answering. |
| IS11–IS12 | Pause/session revocation interrupts or withholds late output; checkpoint retained with no automatic replay. |
| IS13–IS15 | Restart and fresh restore retain exact transcript; unavailable host stays failed; paired route gate rejects untrusted/configuration input. |
| IS16 | Oversized JSON-escaped context creates no session/note/grant/model call; a permitted large exact note succeeds through an actual 32,000-byte store context read. |

Release verification must additionally use the running dashboard to create a synthetic interview, approve only its synthetic context, obtain an actual model-generated question and feedback, check the exact answer/receipt in SQLite after reopen, open the linked host conversation, and compare desktop/mobile layouts. Test optional microphone behavior on a physical device separately. Do not call a fixture or visible login prompt a completed live interview.
