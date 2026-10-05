# AI lecture mode

Implemented local extension of **F08 Learning tutor** and **F11 Document and artifact production**, October 5, 2026. This guide describes the shipped contract, its verification and the next feasible increments. It does not change the 29-feature register or claim that the entire tutoring specification is complete. The public website remains a separate edition; this increment is not a hosted deployment.

## What the feature means

Turn a small, explicitly selected set of PDF slides into a saved lesson that explains the concepts in a natural voice, changes slides when each explanation actually finishes, pauses for ungraded comprehension checks and lets the student pause to ask a question. The original slide remains visible beside a short explanation, a worked illustration and a takeaway. The student can replay, seek, adjust playback speed and resume the saved position.

The lesson has two forms. **Interactive lecture** in LearnBridge includes questions, saved attempts and clarification conversations. **Downloadable MP4** is a linear narrated slideshow; a normal video file cannot run LearnBridge's interactive quizzes or make model requests. Neither listening time nor reaching the last slide establishes mastery.

The model currently reads **extracted text from the selected PDF pages**, with any course recipe explicitly selected in the parent Course studio. It does not receive the slide image. The student sees the original rendered PDF; the tutor must acknowledge missing visual evidence instead of inventing explanations of unseen diagrams. Scanned pages without usable text cannot create a lecture. A literal source quote and a valid page citation establish provenance, not factual correctness of every generated explanation.

## Student setup and flow

Use the [local setup guide](../../LOCAL_SETUP.md) and [official agent setup](../../LOCAL_AGENT_SETUP.md). No new speech API key, hosted service, production dependency or subscription credential copying is required. Embedded lecture generation uses the existing official Codex host. Before a turn, the host selects its compatible context path: audited eager-function models can request their own reads; current models that require a disabled code host receive the same approved context prepared through MCP. The latter runs a text/schema-only model turn with native execution disabled; no failed model turn is replayed. Delivery is recorded as `model_requested` or `runtime_prepared`; external Claude MCP support does not imply embedded Claude lecture execution.

1. Import a PDF from an explicitly selected source and open it in **Course studio**. Review the course's grading/AI policy and select a learning session only when its extra course context is useful.
2. In **AI lecture**, choose one to eight physical pages, a title and a quiz interval of one to four chapters. Review/save that exact selection. Larger decks use separately selected batches; the current version does not silently process the entire deck.
3. Enable lecture AI for the displayed context note. This creates a short-lived, destination-specific grant for that **one exact local note**. Review the generation request, then start it. Imported sources and saving a lecture do not grant model access themselves.
4. Read the proposed explanations, examples, takeaways, source quotes and practice questions/reference answers. Accept the exact reviewed script. A completed model turn alone does not make a lesson playable.
5. On a supported Mac, choose a narration pace and explicitly create the voiceover. Installed **Samantha** is the current narrator. Press **Play lecture** to start; pause, seek, replay or change playback speed as needed.
6. When a quiz appears, write a response before revealing the proposed reference answer and explanation. LearnBridge preserves the exact response and leaves it unassessed. Continue after reviewing the check.
7. Pause to ask for clarification. Review the exact question and current note grant before sending. The response belongs to that chapter; resuming the lecture is a separate action.
8. Optionally create and download the MP4. **Remove cached audio/video** clears generated media while keeping the reviewed script, questions, attempts and listening position. Regenerating media requires an explicit new action.

The voiceover/video path currently requires macOS with the installed voice, `/usr/bin/say`, Swift and AVFoundation. An unsupported device still has usable reviewed text and manual chapter navigation. The lecture player has no hidden paid or network speech fallback and does not clone a person's voice. Physical audio quality and real-course teaching quality require separate student review.

## Component architecture and ownership

| Component | Responsibility | Boundary |
| --- | --- | --- |
| [Course studio](../../../web/apps/local-runtime/src/course-studio-service.mjs) | Parent course/source context, academic policy and original PDF provenance | Revalidate the current parent and source before every lecture read or mutation. |
| [Lecture service](../../../web/apps/local-runtime/src/lecture-service.mjs) | Selected-page context note, host request/review, accepted pack, attempts, clarification and durable cursor | Only fixed structured inputs; exact revision/hash checks; no source discovery, task creation or provider writes. |
| [Host turns](../../../web/apps/local-runtime/src/host-turns.mjs) | Official Codex execution, authority lease, persisted progress/output/tool receipts | One exact note grant and `read_only` policy. Successful model-requested or explicitly runtime-prepared MCP context receipts are required. The delivery mode is recorded, never inferred. |
| [Lecture routes](../../../web/apps/local-runtime/src/lecture-routes.mjs) | Paired local JSON and binary endpoints | Current paired browser session plus nonce, strict methods/fields and no query-string authority. |
| [Native media adapter](../../../web/apps/local-runtime/src/lecture-media.mjs) | Installed speech, PCM measurement, private media manifests and owned-cache removal | Fixed native commands; bounded inputs/processes; no student-controlled executable or filesystem path. |
| [Video worker](../../../web/apps/local-runtime/src/lecture-video.swift) | Letterboxed 1280 × 720 H.264 slides, measured narration composition and MP4 export | Source slide order and actual audio duration drive frame timing; inspect the saved file before exposing it. |
| [Lecture player](../../../web/apps/local/public/lecture-player.js) | Review, playback, quiz gate, clarification, download and recovery | Actual media events and serialized writes; generation/session guards reject late events; authenticated fetch creates temporary Blob URLs. |
| Local SQLite and backup | Versioned lecture text, context pins, review/attempt records and cursor | Media cache is separate and omitted from workspace backup. Missing media never triggers automatic regeneration. |

The sequence is **selected PDF evidence → one reviewed note → exact read-only Codex request → strict proposal validation → student acceptance → local narration → interactive playback or linear export**. Sources, student questions and earlier replies are data; they cannot authorize shell commands, browser activity, task proposals, external writes or graded-work completion.

### Durable records and source pins

`learnbridge_lecture.v1` stores the parent studio ID/hash, parent source pin, ordered page pins, exact context note revision/hash, quiz cadence, accepted chapter pack/hash, review receipt, media descriptors and playback cursor. Each page pin includes the source-entry ID, physical page and page-text SHA-256. The original PDF hash and source version remain part of parent provenance. The base `lecture_hash` and accepted `pack_hash` are checked on access, including after reopen/restore.

`learnbridge_lecture_attempt.v1` stores the exact question and student response, proposed reference answer/explanation, citation and attempt timestamp. It records `assessment: unassessed` and `mastery_claim: false`; playback cannot forge answered quiz IDs. `learnbridge_lecture_clarification.v1` links the exact student question, chapter, reviewed prompt/grant and actual host turn. Clarification text is withheld when its live grant ceases to authorize access. Once the original script has been accepted as a local artifact, reading that reviewed artifact does not require the old generation grant to remain live. Current source/context integrity is still required.

## Generation and review contract

The generation prompt asks for clear spoken teaching: connect each concept to the previous chapter, explain rather than read bullets, use a small explicitly hypothetical illustration, state a takeaway and acknowledge missing evidence. It requests one ungraded short-answer check at the selected interval and on the final chapter. It prohibits silent completion of graded work, invented visual descriptions, numerical skill scores and impersonation.

The only accepted model structure is one delimited JSON object:

```json
{
  "version": 1,
  "chapters": [
    {
      "physical_page": 1,
      "title": "Concept title",
      "narration": "Plain spoken explanation grounded in this page.",
      "example": "A hypothetical worked illustration.",
      "takeaway": "One concise takeaway.",
      "evidence_quote": "An exact nonempty substring of this page's text",
      "citation": {
        "source_entry_id": "the-selected-source-entry-uuid",
        "physical_page": 1,
        "page_sha256": "the-exact-selected-page-hash"
      },
      "quiz": {
        "question": "An ungraded comprehension question",
        "answer": "Proposed reference answer",
        "explanation": "Why the answer follows from the source",
        "evidence_quote": "An exact nonempty substring of this page's text"
      }
    }
  ]
}
```

The actual object must appear between `BEGIN_LEARNBRIDGE_LECTURE_V1` and `END_LEARNBRIDGE_LECTURE_V1`. This illustrative placeholder object is not a valid fixture. Exactly one chapter is required for every selected page in selected ascending order. `quiz` is `null` except at the configured chapter interval and the final chapter. Extra keys, duplicate/missing/reordered pages, wrong source IDs/hashes, malformed JSON, absent required quizzes and nonliteral evidence quotes are rejected. No chapter or source text is silently truncated to make a request fit.

Before running, the student reviews `prompt_sha256` with the current lecture revision/hash. The grant permits only the exact context note, no tasks, original-source entries or unrelated notes. The persisted host turn must have the matching prompt/grant/output hash, completed state, `read_only` policy and a successful `learnbridge_context` receipt. Model-requested delivery requires a model-origin receipt; runtime-prepared delivery requires an explicit persisted `context_delivery: runtime_prepared` marker and a runtime-origin receipt. Both paths read only the selected grant; a plain answer without that provenance cannot become a lesson. Before accepting, the student reviews **both** the actual output hash and parsed chapter-pack hash. Changing the proposal or lecture revision invalidates that review.

### Explicit budgets

All text budgets below are UTF-8 bytes, except physical-page/count limits.

| Input or artifact | Bound and behavior |
| --- | --- |
| Selected pages | One to eight existing, unique, ascending physical pages with nonempty extracted text. |
| Context note | At most 24,000 bytes after JSON-string escaping, including selected course context and coverage. Reject before note/grant creation if oversized. First broker context envelope is bounded to 32,000 bytes. |
| Generation prompt | At most 16,000 bytes. It asks the model to keep the complete JSON under 14,000 bytes to fit the host answer budget; this request is a generation target, not a claim that the parser's envelope is 14 KB. |
| Output parser envelope | At most 64,000 bytes, with independent required-field and total-spoken checks. Host output limits can reject/truncate a response earlier; incomplete output is not accepted. |
| Chapter | Title 200; narration 1,400; example 600; takeaway 300; evidence quote 512. Spoken narration/example/takeaway plus separators is at most 2,304 bytes. |
| Whole spoken lesson | At most 16,000 bytes before accepting the model proposal. Native media independently checks its own bounds. |
| Quiz | Question 1,000; reference answer 1,500; explanation 1,500; literal quote 512. |
| Student content | Quiz response 6,000; clarification question 4,000. Only two recent completed same-chapter clarifications enter a new question prompt. |
| Workspace records | At most 60 lectures, 100 attempts per lecture, 30 clarifications per lecture and 96,000 serialized bytes per lecture-layer record. |
| Native cache | At most 12 lecture media sets and 200 MB. No automatic deletion of another ready lecture to make space. Identical narration settings reuse valid media; explicitly replacing narration discards its previous generated cache after a successful replacement. Remove selected cached media and retry. |
| Native jobs | At most eight segments; 2 MB PNG and 12 MB WAV per segment; 80 MB MP4; 300 seconds per segment and 1,200 seconds per lesson. Fixed timeouts, cancellation and current authorization checks apply. |

## Playback and native media

Speech synthesis runs locally through the installed Samantha voice. The fixed command reads a private temporary text file; script text and account/model credentials are absent from command arguments/environment. Private audio and slide files are hash-bound to their manifest. The adapter measures PCM frames/sample rate from each generated WAV; estimates from word counts are not used as the playback clock.

The player fetches private audio with the current nonce, then uses a temporary Blob URL. A plain public audio URL is not an alternate access path. **Play lecture** is a user action. `currentTime` drives seeking and cursor persistence, while the audio element's `ended` event drives chapter completion and the next slide. A generation/session token prevents a replaced audio element or a stale finished fetch from advancing the current lecture. Pause, switching sessions, logout, source failure and teardown stop playback and revoke owned Blob URLs.

At a chapter quiz, playback pauses. A nonempty actual response creates an immutable attempt before the reference answer is disclosed in the normal lecture view. Advancing past unanswered prior quiz chapters and marking the lesson finished with unanswered quizzes are refused by the service, not just hidden by the UI. The reference answers are visible earlier in the explicit script-review screen because the student must review the entire proposed lesson before accepting it.

The MP4 renderer uses the actual selected slide PNGs and saved WAV segments. H.264 video frames are letterboxed to 1280 × 720 and align to the cumulative measured audio boundaries. AVFoundation composes the narration into a supported MP4 export. The saved file must reopen with one audio track, one video track and duration agreement within 0.05 seconds. Codec inspection and listening are separate from merely finding an `.mp4` filename. MP4 playback is linear; it does not preserve interactive question answering, clarification or LearnBridge progress writes.

## Endpoints and authority

All routes run in the local loopback runtime, require current paired-browser authority and use fixed fields. Mutations carry `expected_revision` and `lecture_hash`; creation instead pins the parent `expected_revision` and `studio_hash`. Model actions additionally pin a reviewed prompt hash and exact-note grant; acceptance pins output and pack hashes. Query strings, arbitrary paths and executable names do not convey access.

| Route | Purpose |
| --- | --- |
| `GET/POST /course-studio/sessions/:studioId/lectures` | List metadata or save an exact selected lecture/context. |
| `GET /lectures/capability` and `GET /lectures/:id` | Platform capability and current sanitized lecture view. |
| `POST /lectures/:id/preview-run` and `/run` | Review exact generation request, then create a read-only host turn. |
| `GET /lectures/:id/review-preview`, `POST /accept` | Review full script/questions, then accept exact hashes. |
| `POST /lectures/:id/audio`, `/export-video`, `/remove-media`, `/cancel` | Explicit native generation, export, owned-cache removal or cancellation. |
| `POST /lectures/:id/progress` and `/answer` | Save current listening cursor or exact response; neither claims mastery. |
| `POST /lectures/:id/clarification-preview` and `/clarifications` | Review and run a chapter-specific exact question. |
| `GET /lectures/:id/chapters/:chapterId/asset` and `/audio` | Current pinned PDF render or authenticated WAV bytes. |
| `GET /lectures/:id/video` | Current validated MP4 bytes; fixed filename/MIME/length. |

Audio/video responses use private no-store caching and require the nonce even for GET. Returned bytes must match the exact descriptor hash/size/MIME before delivery. The runtime provides no filesystem directory listing, direct cache path or tokenized public media link. Exporting a file is a local download; sharing/uploading it elsewhere is a separate student action.

## Failure, recovery and retention

| Condition | Required behavior |
| --- | --- |
| Invalid or oversized model proposal | Store the actionable error, expose no accepted chapters/media, preserve source evidence and allow a newly reviewed request. |
| Model authentication/rate limit/provider failure | Preserve its terminal error code. No alternate account/provider or paid fallback runs automatically. |
| Runtime restarts during generation startup | Mark `UNKNOWN_OUTCOME`, produce no proposal and never replay the model request. Existing host-turn restart behavior handles attached unfinished turns. |
| Runtime restarts during native work | Mark the job failed with `RUNTIME_RESTARTED`; do not replay it. Previously playing cursor resumes paused. |
| Grant expires/revokes while generation or clarification is pending | Reject or withhold the late result. A previously accepted local script remains readable under current source checks. |
| Source, selected page, parent context or accepted script hash changes | Fail current view/media access. Do not silently substitute a newer source or trust altered accepted text. |
| Student cancels or logs out during native work | Abort owned work, await cleanup and discard any late success that no longer has authority. No downloadable ready artifact is attached. |
| Native cache is missing after restore or fails integrity | Show media unavailable with the accepted text/cursor/attempts preserved. Explicitly regenerate; reading a lecture never runs synthesis. |
| Remove-media cleanup fails because another native job owns the adapter | Leave the cache reference intact and show a retryable failure. Do not claim deletion before successful owned cleanup. |
| Narrator settings change | Generate from the same reviewed text with new explicit settings; discard obsolete owned media after a valid replacement. Unchanged ready settings reuse their cache. |
| Two playback writes race | Revision guard rejects stale writes; the player serializes mutations and refreshes current state before retrying. |

SQLite backup/restore preserves reviewed text, exact source provenance, attempts and listening cursor. Native media is an optional private cache outside that backup. Cache directories/files use restrictive permissions, owned markers and no-follow checks; symlinked/unmarked/replaced roots are refused. Removing media does not delete the lecture or its historical local records. The existing selective physical-erasure limitation also applies to lecture text and backups.

## Objective verification

Run from the repository root:

```sh
node --test web/scripts/local-lecture-service.test.mjs web/scripts/local-lecture-http.test.mjs
node --test web/scripts/local-lecture-media.test.mjs
node --test web/scripts/lecture-player-ui.test.mjs
node docs/design/validate-design.mjs
npm run local:build
node web/scripts/verify-local-install.mjs
npm test
npm run build
```

The targeted service/HTTP fixtures use **real SQLite, source pins, Course studio, host-turn orchestration and actual paired HTTP** with explicitly synthetic model/media seams. They do not prove live Codex behavior or audible video. Native tests separately use real installed speech/AVFoundation on macOS; unsupported-platform skips must be reported, not counted as a verified platform. UI fixtures verify the shipped controller while labeling synthetic data. The final source-bound release receipt must distinguish each layer and retain the exact snapshot, environment, command result and artifacts.

| Verification layer | Objective success condition |
| --- | --- |
| Selection and isolation | Exactly one note contains only selected page evidence/course context; an unrelated private canary is absent; no grant/model/media operation occurs on save; retries create no duplicate lecture. |
| Parser and budgets | Reject forged literal quotes/citations, page reordering, missing quizzes, unknown keys, invalid UTF-8/JSON and oversized field/aggregate text before acceptance. Verify exact source bytes remain untrimmed. |
| Actual official host | In a disposable synthetic PDF workspace, the actual official Codex host completes a read-only turn using the exact note. Persist and verify either model-requested context or the explicitly runtime-prepared MCP path; receipt origin, prompt/grant/output hashes must match that path. Parse, separately review and accept the real response. A synthetic model receipt is insufficient. |
| Authority and races | Wrong nonce/origin/query/method is denied; source/grant revocation during pending work prevents attachment; cancelled/logout late native success is cleaned; restored/tampered packs fail closed. |
| Quiz and progress | Reference is hidden before an actual answer in the player; exact answer persists; stale progress fails; listening creates no mastery/checkpoint/task; replay/resume cannot skip required prior quizzes. |
| Native audio | Reopen real WAVs; require nonzero PCM and actual per-segment durations; verify private hash/size/permissions and no narration retained in temporary script files. |
| Native video | Reopen real MP4 independently; inspect dimensions/track counts/codecs/durations; sample frames before/after a synthetic contrasting-slide boundary; require the expected order and timing instead of accepting a fake header. |
| Shipped browser experience | Play/pause/seek/speed, audio-ended advance, quiz interruption/answer/continue, clarification pause/resume, refreshed cursor, stale-event denial, download and removal work at desktop and 390 px widths without overflow. |
| Persistence and restore | Reopen and fresh-restore accepted transcript, literal attempt, chapter/cursor and provenance with model execution disabled. Missing native cache reports unavailable; no provider/native call occurs automatically. |
| Teaching quality | A reviewed sample checks conceptual accuracy, explicitly hypothetical examples, source support, transitions, natural explanation and useful checks. An actual student/course pilot evaluates understanding and physical audio quality separately. |

A model response, Blob URL, successful export call or screenshot of controls alone is not completion. Use a downloaded/reopened actual file, independent stored readback and real media events. The [lecture verification receipt](AI_LECTURE_VERIFICATION.json) records the source snapshot and separates actual Codex/native-media proof, synthetic browser checks and recovery proof. Historical receipt counts in [implementation status](../IMPLEMENTATION_STATUS.md) describe their original snapshots.

At code commit `6d5fa98`, the full suite passes **1,645/1,645**, with no skips. A fresh real official Codex turn produced a reviewed two-page synthetic lesson and a chapter clarification using the recorded `runtime_prepared` MCP path. Actual installed narration and native export produced an 81.49-second MP4, independently reopened with matching audio/video duration and one track each. [Download the synthetic export sample](../../../artifacts/local-ai-lecture-sample.mp4). Its deliberately minimal source text tests acknowledgement of limited evidence; it is not a real course lecture or a teaching-quality certification. Quizzes and clarification remain in the interactive player. A separate native contrasting-slide fixture proves boundary timing, and fresh restore preserves the reviewed script, exact attempt and cursor without regenerating absent media.

## Feasible next increments

| Order | Work an agent can implement | Definitive verification and release boundary |
| --- | --- | --- |
| 1. Real-course teaching evaluation | Add consented real course samples and a fixed rubric: supported claims, uncertainty about visuals, prerequisite explanation, illustrative example, quiz usefulness and natural delivery. Keep graded completion excluded. | Human reviewers resolve disputed facts; compare student teach-back before/after; listen on actual devices. Existing parser/source tests prove provenance, not this quality gate. |
| 2. Larger decks | Add a reviewed whole-deck plan made of independent one-to-eight-page batches. Queue only accepted grants/requests, persist per-batch state and assemble reviewed media through a bounded manifest. Never concatenate beyond host/context/native budgets. | A 25-page synthetic deck preserves all pages/order with no duplicate model runs after restart; cancellation stops queued batches; total/cache limits and final boundary frames pass. This is not currently automatic. |
| 3. More platforms and voices | Add an explicit capability/provider adapter with installed-voice allowlists and independent per-platform WAV/video proof. Request approval before any new production package or network voice provider. | Fresh supported-platform installation, real audible PCM, actual media timing and codec inspection pass. Missing voice/config stays unsupported and never triggers silent network fallback. |
| 4. Reviewed visual evidence | Add selected image/OCR or vision support as a separate sharing mode with image provenance, cost/entitlement review and exact source region citations. Keep existing text-only prompts truthful. | Diagram-only synthetic fixtures test actual image receipt and region/page hash, visual claim grounding and denial without image consent; human factual review remains required. |
| 5. Continuous spoken questions | Add explicit microphone start/stop, visible capture state, bounded transcription and separate question review/execution using the existing clarification contract. Retain a text fallback. | Real device capture/transcription, denied permission and teardown tests; no ambient recording; no old lecture auto-resume or question sent without configured consent. Current mode uses explicit typed questions. |
| 6. Portable interactive lesson | Export a reviewed offline lesson package with source images, local audio, transcript and local quiz state, or implement a separately authorized hosted reader. Describe its storage/sharing boundary before implementation. | Offline open/reopen, exact files and quiz persistence pass with no network access. A plain MP4 remains linear; remote/phone access requires its own identity/device gates. |

These increments reuse the accepted-pack and media interfaces rather than replacing Course studio or adding unrestricted agent tools. Their order puts learning quality and source completeness ahead of broader automation.

For the timing and export APIs, see [HTMLMediaElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement), [currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime) and [AVAssetExportSession](https://developer.apple.com/documentation/AVFoundation/AVAssetExportSession). Those APIs describe implementation mechanisms; the repository's actual file/event tests establish the exercised behavior.
