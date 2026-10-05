# Interactive course studio

The local **Course studio** pairs an actual selected PDF slide/handout page with a persistent tutor session, practice questions and an annotation layer. It is a learning tool: it records what a student really answered on a particular check, rather than treating a page view or an AI explanation as knowledge.

## Student flow

1. Import a selected PDF through **Sources**. The existing import saves extracted text, physical pages, exact text hashes, original PDF SHA-256 and partial coverage. Scans still need a separately reviewed text export; OCR is not provided.
2. Open **Course studio**, choose the slide deck and starting physical slide. The expandable **Course context and learning rules** section lets you declare grading status/course AI rule and optionally choose one current **Learning** session to include its explicitly selected course passages. Unknown policy defaults to conceptual support; an explicit prohibition blocks creation.
3. Review creation of one local context note. It contains only that physical page's extracted text plus the chosen course recipe, not every page, directory or class. This is a retained local copy; original PDF and notes are unchanged. Creating it grants no model access.
4. The actual PDF page renders locally as a slide with **Previous**, **Next**, a slide counter and direct physical slide jump. Left/right arrow keys work only while Course studio is active and focus is outside editing controls or an open review dialog. **Slide size** offers fit-to-width and 125/150/200% views inside a scrollable frame. Deck setup folds into **Choose another deck** after opening a slide; saved conversations show creation time and accessible open labels. Returning to a slide restores its saved conversation and unsent question/practice drafts for the current browser session. A saved page is reused only if its exact source version, course recipe and learning rules match. Opening a new page reviews creation of a separate local note, preserving the exact recipe revision; it does not grant access or call AI. Drag to circle an area; review and save the circle on this exact source version. The overlay is independent of the original PDF. Extracted text and source details are in an expandable accessibility alternative.
5. Sign in through **Local AI** using the official Codex managed profile. Review **Enable tutor for this slide** to create a destination-bound 30-minute, 256,000-byte grant for only this context note. That explicitly approved grant is selected automatically. Existing matching reviewed grants can also be selected in **Tutor access and privacy**. Moving to another slide does not transfer its permission.
6. Type a question, or use **Explain this slide**, **Walk me through it** or **Check my understanding** to fill a suggested question. Starters prepare a draft; they do not send it. The tutor identifies the current slide and any explicitly included course context. Review **Ask tutor** or a practice-quiz request. LearnBridge starts the existing actual host-turn executor in the background, attaches its durable turn to this studio and displays saved progress/results. Stop cancels that request; a restart never silently replays an interrupted turn. The session remains available when the student returns.
7. A tutor can propose exact quotes to point to. Saving a proposed pointer renders the current PDF and uses its native text selection rectangle for the quote. It never accepts invented model coordinates. Ambiguous, missing, multiline or unsupported rotated-page text geometry remains unavailable; the student can circle an area manually.
8. A quiz is parsed only from a completed host answer with exact source-entry/page/hash citations. Review the questions and proposed reference answers before accepting the practice set. Malformed or invented citations fail visibly; no fallback quiz is manufactured.
9. Type an actual answer before the UI reveals the model's proposed reference answer. Compare it with the source, then explicitly rate **Correct on this check**, **Partly correct** or **Needs practice**. These are student-reviewed judgments about this attempt, not an automatic mastery score.

Optional **Voice options → Read latest answer** uses browser speech synthesis. **Dictate question** is available only if the browser exposes speech recognition. It starts only after explicit review, asks for microphone permission and warns that the browser may send audio to its speech service. Changing slides or leaving Course studio stops dictation and read-aloud; late results from an old slide are discarded. LearnBridge retains recognized text only when the student later sends it; it does not record or save audio. Device permissions, browser voice availability and real microphone/speaker behavior require a live device check. There is no voice API credential, ongoing listening or real-time conversational audio service.

## Architecture

- `course-studio-service.mjs` stores studio, message link, reviewed quiz, actual attempt and annotation as private `artifact` records. No database migration or new production dependency is needed.
- A studio pins the imported entry version/text hash/original PDF hash/physical page hash, optional existing Learning session revision/hash, policy and exact context-note revision/SHA. Every content read or mutation revalidates these pins and source consent.
- Slideshow session listings contain only metadata and pins, not page bodies or quiz answers. Navigation reuses a matching current page studio or creates a separately reviewed page note. `expected_learning_pin` prevents a changed course recipe from silently replacing the reviewed recipe while another slide is being opened. The server revalidates a saved page before content delivery; failed source rendering clears the previous private image and transcript from the active view. Unsent drafts are kept only in memory and are cleared on logout/reset.
- The exact context note must fit **24,000 bytes after JSON string encoding**, leaving 8,000 bytes for the fixed 32,000-byte first-read broker envelope. This counts escaped quotes/backslashes and multibyte text, not character count. Creation rejects an oversized slide/course recipe before retaining any note or studio; previously saved notes are checked again before model start. Nothing is silently truncated. Select page-only context, review fewer course passages, or use a shorter reviewed text export in Learning. The imported source remains intact.
- Tutor access must contain exactly this one pinned context note, with no extra documents, tasks or imported sources. Wider existing grants are excluded from the picker and rejected before rendering, host work, replay or budget charge. Outputs and prior conversation from an old wider grant are withheld from this scoped tutor; accepting an already reviewed local quiz is a separate retained practice record.
- The paired-browser `course-studio-routes.mjs` is the only HTTP entry point. No course-studio mutation, sharing grant or renderer is exposed as an agent MCP tool.
- The existing `hostTurns.start` remains responsible for the actual official Codex execution, current grant checks, tool receipts, budget, cancellation and recovery. Requests are idempotent and bounded, with one studio message attached to one actual host turn. Course requests set the trusted `read_only` tool policy; no task/document proposals, shell, browser, arbitrary local path or other student's account becomes available. This policy is set by the service and cannot be widened through public request input.
- The renderer reads bytes with the existing fixed Python worker's anchored file descriptors, no-follow path components, exact root/directory/file identity and byte limits. `readSelectedPdfAsset` sends that immutable buffer to a fixed native Swift/PDFKit helper, then rechecks the original filesystem version before returning an image. No source path or external URL is accepted from the browser. The helper renders one selected page, at most 1,600 pixels per dimension, and returns bounded PNG plus real single-line text-selection rectangles.
- Model context is extracted text. The model does **not** receive the visual image. It must not claim it can interpret unseen figures. The student sees the actual page and can provide a description or an exact manual circle; visual multimodal reasoning is a separate future capability.
- Rectangles are normalized to the displayed page, top-left origin. Manual circles are checked for finite, in-bounds size. Proposed quote circles require the exact completed host text and current source asset. Both retain page hashes and origin provenance.
- Accepted quizzes retain actual output SHA and host-turn ID. Practice question reads omit reference answers; the student's actual answer is saved before the reference is returned. The paired student can still inspect their original model output in the general agent session, so answer hiding is a learning affordance, not a security boundary.
- Revoked source, changed imported source version, stale course recipe, changed context note or withdrawn grant prevents fresh sharing and hides model replies as appropriate. History and backups may retain earlier local context/results; selective physical erasure is not implemented.

## Exact model envelopes

The outer host response remains its existing answer string. The tutor optionally embeds a bounded pointer block:

```text
BEGIN_LEARNBRIDGE_POINTERS_V1
{"version":1,"quotes":[{"quote":"exact substring on selected page","label":"brief explanation"}]}
END_LEARNBRIDGE_POINTERS_V1
```

The quiz request requires one bounded practice block, with one to five questions:

```text
BEGIN_LEARNBRIDGE_QUIZ_V1
{"version":1,"questions":[{"question":"...","answer":"...","explanation":"...","citation":{"source_entry_id":"exact imported UUID","physical_page":2,"page_sha256":"exact page SHA-256"}}]}
END_LEARNBRIDGE_QUIZ_V1
```

A block is a model proposal. Parsing checks identity and structure; it cannot establish answer truth. Human source comparison remains necessary.

## Objective verification

`node --test web/scripts/local-course-studio.test.mjs` uses the real selected-source reader/native renderer and private SQLite, with a clearly labelled synthetic host-executor seam. It verifies:

- Native PNG magic, decoded dimensions, exact original SHA, physical page and PDFKit quote geometry.
- Exact page-only context, no other-page canary, explicit separate sharing, idempotent creation/restart and restrictive/prohibited policy.
- Oversized plain and JSON-escaped page/course context fails before note/studio/grant copy; a large fitting page preserves exact start/end text and succeeds through the real broker with `max_bytes: 32000`.
- Existing host-turn orchestration, actual saved progress and output receipts, one message on retry, exact grant selection, revoked-grant answer withholding and restart persistence.
- Wider existing grants fail before model work or context charge, including replay of an existing request key; prompts request plain student-facing prose with physical slide/page citations and IDs/hashes confined to structured evidence blocks.
- Strict actual-output quiz parsing, invented-citation rejection, reviewed practice set, response-before-reference, student-only rating and no task writes/mastery fabrication.
- Native quote bounds rather than model coordinates, separately saved manual annotation, out-of-bounds denial, deletion and restart durability.
- Revoked source and changed actual PDF bytes fail before image delivery/model start.
- Paired-route denial and accessor/unknown-field rejection.

`node --test web/scripts/course-studio-ui.test.mjs` runs the shipped interaction handlers with a small DOM stand-in. It verifies previous/next reuse, physical boundaries and jump validation, source/recipe mismatch refusal, no automatic grant/model writes on navigation, per-slide question and practice draft preservation, starter drafts, explicit grant auto-selection, exact current-slide request identity, CSS-only zoom, stale/render-failure content clearing, voice cancellation/late-result rejection and reset while review is pending. These tests do not claim browser layout or physical microphone quality.

Additional release checks are separate from those fixture tests:

1. In an authenticated **local disposable** browser workspace, open a synthetic two-page PDF, verify the selected slide image and text match, circle a known sentence, reload and independently read back exact SQLite annotation and source hashes.
2. Use an actual managed Codex subscription to ask a synthetic page question and request a quiz. Confirm the actual model calls `learnbridge_context`, links a completed turn, emits source-cited output, accepts one reviewed quiz, preserves an actual typed answer/rating and produces a quote whose native bounds circle the displayed text.
3. Cancel a running request; revoke its grant; refresh a changed PDF; confirm no old answer/image is delivered as current. Log out while asynchronous reads are pending; verify UI-generation guards clear the cached text and image.
4. Check desktop and phone-width layouts without horizontal overflow. Voice feature detection alone is not microphone/speaker proof: perform a live opt-in dictation/read-aloud check on the target device, or leave it explicitly unverified.
5. Run the complete repository tests/build and legacy prototype checks before reporting integration completion. Fixture execution does not prove live model, university authentication, hosted publication or all browser/device voice compatibility.

## Remaining additions

- Image-aware multimodal tutor with explicit selected image sharing and corresponding host/tool support.
- Streaming bidirectional voice with interruption, captions and verified retention controls.
- OCR for selected scans, selection overlays on rotated/multiline text, and PDF markup export.
- Richer generated quiz types, server-reviewed pedagogical evaluations and spaced-practice integration without inferring global mastery.
- Reusable tutors spanning multiple selected pages with a clearly reviewed context budget; the current studio deliberately pins one page plus an optional exact course recipe.
