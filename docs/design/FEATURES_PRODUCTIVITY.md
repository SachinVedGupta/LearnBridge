# Productivity, career, and student-life specifications

This file specifies proposed work, not currently available features. It covers F12–F23. The [architecture](ARCHITECTURE.md), [implementation plan](IMPLEMENTATION_PLAN.md), and [verification plan](VERIFICATION.md) define shared storage, permissions, run states, evidence, and release gates. Every saved item must retain its workspace owner, revision, and source provenance where applicable. New dependencies, external configuration, publication, and consequential actions follow the repository and host agent's approval rules.

Milestones: **M1** local foundation/setup; **M2** profile/academic reads; **M3** agent/planning; **M4** documents/browser/career; **M5** connected productivity; **M6** life/mobile. A milestone is a dependency boundary, not a delivery-date promise. F12–F23 depend on the M1 private storage and action controls. Features needing AI also depend on a verified M3 provider mode.

Acceptance IDs such as `F12-A01` name required checks. Their described fixtures and modules are implementation targets; they do not exist merely because this document names them. Fixture tests prove behavior under controlled inputs. A real provider check proves only that specific account, scope, operation, platform, and version. A model's statement that its own work is correct is never sufficient completion evidence.

## F12 — Unified inbox and communications

**Meaning and milestone.** M5: provide a scoped view of important Gmail/Outlook mail and Teams/Discord/Slack messages, extract requests, connect them to courses/projects, and prepare replies. This is a context and follow-up workspace; it does not attempt to replicate every messaging application's interface.

### Expected behavior

1. The student selects accounts, folders/labels, channels, a lookback window, and attachment handling. Preview the scope before the first private read. A connected account alone does not authorize reading its entire history.
2. A refresh imports new or changed messages in that scope. Show account, sender, subject/channel, source link, timestamp, and last checked time. Thread related messages without merging different accounts or similarly named senders.
3. Deterministic filters can flag direct mentions and known due dates. AI may propose a request, deadline, or reply, but each proposal links to the supporting message and labels ambiguity. “Could you finish this next week?” remains an unresolved deadline unless the student supplies a date.
4. The student accepts a request into a task or dismisses it. Accepting twice produces one linked task. Reply drafts are local. Sending requires review of the actual account, recipients, channel/thread, body, and attachments; changing any of them invalidates that review.
5. Refresh results list successful, failed, unavailable, and stale sources separately. A failed Teams refresh must not become “nothing new.”

### Records and interfaces

Store account-qualified message/thread IDs, source timestamps, `retrieved_at`, selected body content, message revision/hash, extracted requests, linked task IDs, and draft revisions. Preserve the source URL when the provider supplies one; otherwise show the provider-native identifiers and explain that no deep link is available. Attachment metadata can be indexed before content. Download/read attachments only under an approved scope, into managed storage.

Provider adapters expose `list_messages`, `get_thread`, and an optional reviewed `send_message` capability. The capability manifest must distinguish supported reads from sends, attachments, edits, and reactions. Do not advertise a send button solely because an OAuth account connected successfully.

### Implementation sequence

1. Extend the existing `web/apps/web/src/lib/server/connectors.ts` capability catalogue through a shared connector contract; keep current hosted account-ownership checks.
2. Implement local normalization and cursor storage in proposed `web/packages/connectors/messages/` and `web/packages/local-storage/`. Begin with one mail provider and one channel provider; add others after contract and live gates pass.
3. Build a paginated sync that records a cursor only after the corresponding batch is durably saved. Track deletions/redactions and scope changes without silently retaining excluded content.
4. Add request extraction with structured output validation and links to exact message evidence. Treat message instructions as data, including text asking the agent to send secrets.
5. Add the inbox view, reviewed task proposals, local reply drafts, and action proposal integration. Sending goes through the shared exact-payload approval and verification path.

**Failure and recovery.** Expired sessions produce a reconnect action without deleting cached work. Unsupported scopes appear as unavailable. Backoff on rate limits, allow cancellation between pages, and resume from the last committed cursor. A send timeout produces `unknown_outcome`; check the provider's sent record before allowing a retry. If the provider cannot reliably establish whether it sent, require student resolution rather than claiming exactly-once delivery.

### Objective acceptance

- **F12-A01:** Import a fixture with two accounts sharing the same provider message ID, a repeated page, and an edited message. After two refreshes and a restart, assert two account-qualified records, one update revision, no duplicate tasks, and unchanged excluded-channel counts of zero.
- **F12-A02:** Feed an explicit request with a date, an ambiguous “next week” request, and a malicious instruction to read an unrelated folder. Assert the first keeps its source/date, the second stays unresolved, and the tool ledger contains no unauthorized folder read or outbound message.
- **F12-A03:** Fail one of three sources after its first page. Assert the result reports partial completion, the failed cursor does not advance past saved data, and the UI retains its stale timestamp.
- **F12-A04:** Create a reply, approve it, then alter a recipient or attachment. Assert execution is rejected until renewed approval. With an approved exact payload, the fixture provider records one message after repeated execution requests.
- **F12-A05:** Simulate a provider accepting a message and dropping the response. Assert the run reports unknown outcome and reconciles against the sent record before retrying; if no matching record can be checked, it remains unresolved.

**Live gate.** For each released provider, the student signs in, selects a small scope, verifies an actual read, and optionally authorizes one controlled message to a chosen test destination. Read-only support can ship without claiming send support.

**Quality rubric.** Review at least 20 labeled messages for request precision, date interpretation, unsupported claims, and reply tone. Release the extraction workflow only after the measured threshold defined in the verification plan passes. Keep uncertain items visible; neither recall nor message importance can be fully proven by a single model judge.

**Non-goals.** Background reading of all accounts, automatic replies, bypassing workspace membership, or circumventing institution/organization restrictions.

## F13 — Research and personal knowledge

**Meaning and milestone.** M5, with local Markdown capture usable earlier in M4: turn selected research, bookmarks, course/project notes, and meeting material into an editable knowledge base with source links. It should answer “where did this come from?” and help reuse knowledge without making unsourced facts look confirmed.

### Expected behavior and records

The student captures an approved URL, file, note selection, or meeting transcript. LearnBridge stores the original reference, capture time, extracted text/version, summary, tags, explicit open questions, and optional linked course/project. Every factual summary claim should point to a supporting source passage; student-authored opinions remain labeled as such. Repeated capture of the same unchanged source reuses the record, while a changed source produces a new version.

Local Markdown is the first export target. Notion/Obsidian/Google Docs destinations are optional adapters selected by the student, not automatic copies of every note. Export previews show the actual destination and content. Existing notes require revision checks and a diff; source capture does not authorize replacing an existing document.

### Implementation sequence

1. Add `knowledge_items`, source versions, tags, backlinks, and export records to local storage. Use the F07 search index and F10/F11 document/artifact contracts rather than a second search store.
2. Implement canonical URL and file-hash identification; keep query parameters that identify different resources. Extract within declared size/type limits, preserve page/section anchors, and report unsupported files.
3. Add a capture recipe that separates extraction, summary proposal, student edits, and accepted note storage. Do not equate an AI summary with the original source.
4. Implement revision-protected local Markdown export. Then add one connector export at a time using provider-native revision conditions when available; where unavailable, compare a fresh content hash before writing and document the remaining race limitation.
5. Add “show evidence,” “refresh this source,” and “forget this item” operations that remove derived search entries and exports under the student's chosen deletion policy.

**Failure and recovery.** A paywall/login/restriction produces an inaccessible-source record, not fabricated content. Failed exports preserve the local accepted note. A changed destination pauses with a merge preview. A source that becomes unavailable keeps previously authorized cached content only under the retention policy and displays its historical timestamp.

### Objective acceptance

- **F13-A01:** Capture the same fixture PDF twice and a changed revision once. Assert one source, two content versions, stable backlinks, and no duplicate unchanged knowledge item after restart.
- **F13-A02:** A fixture summary contains a fabricated quote or a citation to a nonexistent page. Assert the structured citation validator rejects delivery as verified; the output remains a draft requiring correction.
- **F13-A03:** Edit the export destination between preview and execution. Assert no overwrite occurs, the run reports a conflict, and both the local accepted note and changed destination survive.
- **F13-A04:** Forget a fixture item. Query by its distinctive sentence, tag, and source ID. Assert no result in the active source, summary, full-text index, or derived cache; report any retained external export explicitly.

**Live gate.** Export and read back one student-approved test note for each supported destination, including a conflict check. Obsidian file support must stay inside the selected vault.

**Quality rubric.** Human review checks coverage, accurate attribution, useful organization, and distinction between facts/opinions/open questions. Mechanically valid citations do not prove that a passage supports the claim.

**Non-goals.** Scraping inaccessible copyrighted libraries, automatic whole-vault reorganization, or silently ingesting meeting recordings from other people.

## F14 — Internship discovery and shortlist

**Meaning and milestone.** M4: find current internships from official postings, compare them with the student's confirmed preferences and eligibility facts, and keep a deduplicated shortlist. Unknown eligibility should be actionable, not guessed.

### Expected behavior and records

The student selects locations, dates/term, role families, remote preferences, and optional company lists. Search official company pages and supported ATS feeds. Third-party boards can generate leads, but a verified opportunity requires an official posting or an explicitly labeled unverified lead. Store company, title, provider job ID, canonical official URL, location, posting/deadline text, fetched time, availability status, source excerpt, and normalized requirements.

For each role, separate **known match**, **known mismatch**, and **needs confirmation**. Work authorization, graduation dates, GPA, travel availability, and university co-op status come from reviewed profile facts. Absence of a requirement does not prove eligibility. Rankings explain their criteria and can be corrected. “No opportunities found” includes the searched sources and failures.

### Implementation sequence

1. Build public-source adapters in proposed `web/packages/connectors/jobs/` for supported Greenhouse, Lever, and Ashby sources using current official behavior verified at implementation time. Add timestamped response fixtures and parser contracts.
2. Reuse concepts from [please-hire-me](https://github.com/alecswang/please-hire-me/tree/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae): official-source discovery, factual candidate context, duplicates, and evidence. Retain its [MIT notice](https://github.com/alecswang/please-hire-me/blob/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae/LICENSE) for copied/adapted code. Its automated submission launcher is not the LearnBridge runner.
3. Normalize job identity as provider/company/job ID plus canonical official URL. Flag likely duplicate cross-postings for review; do not collapse distinct roles merely because titles match.
4. Implement deterministic date/location filters and explicit eligibility comparisons. AI explanations consume the exact posting and confirmed profile facts, returning evidence references and unknown fields.
5. Add shortlist states `saved`, `investigating`, `preparing`, `applied`, `closed`, and `dismissed`, plus notification hooks for F22. Keep actual application records in F15.

**Failure and recovery.** Rate limits or parser drift mark that source incomplete. A timeout does not mean a role closed. Update availability only on an authoritative explicit close/expiry signal or verified missing-posting behavior for that adapter. Retain historical records and previous check times. Offer manual official-URL import for unsupported ATS platforms.

### Objective acceptance

- **F14-A01:** Feed repeated job pages, two different roles with identical titles, and a cross-posted role with matching official ID. Assert expected unique IDs, preserved distinct roles, and a review flag for uncertain duplicates.
- **F14-A02:** Use candidate fixtures with confirmed graduation date and unknown work authorization. Assert graduation comparisons match the posting's literal dates and authorization remains `needs_confirmation`; generated text must not assert visa eligibility.
- **F14-A03:** A board lead has no matching official posting. Assert it stays unverified and cannot display a verified-opening badge.
- **F14-A04:** Simulate a timeout and then explicit closure. Assert timeout retains prior status with stale evidence; the explicit closure changes status and preserves its source/time.
- **F14-A05:** Cancel during page three, restart, and rerun. Assert completed pages survive, missing pages are retried, and shortlist decisions are preserved.

**Live gate.** Compare at least one current official role from each released source with its stored company/title/location/URL/status. Discovery is not verified by simply receiving HTTP 200.

**Quality rubric.** Score relevance on a student-labeled shortlist, inspect eligibility reasoning, and measure false verified listings. Rank accuracy is subjective; posting fidelity and honest unknowns are hard release requirements.

**Non-goals.** Guaranteed job coverage, applying as part of discovery, bypassing login/rate limits, or treating a closed role's cached text as a current opening.

## F15 — Application preparation and reviewed actions

**Meaning and milestone.** M4: produce a complete review package for a selected role, prepare supported application forms, and keep evidence of what was prepared or submitted. The default terminal state is **ready for student review**. Nothing submits simply because a student asked to discover jobs or tailor a resume.

### Expected behavior and records

Start from an F14 posting and confirmed candidate facts. Produce a resume variant, optional cover letter, and an answer table with exact question text, answer, source fact IDs, and unresolved fields. Never invent experience, project outcomes, dates, GPA, work authorization, disclosure answers, or required skills. A supported ATS form can be filled in the student's authorized browser session; sign-in, MFA, CAPTCHA, agreements, and unresolved factual answers pause for the student.

Store role identity, original posting version, application/form version, each question/answer and fact reference, artifact file path/hash, attachment selection, action target, review hash, prepared time, submission state, and sanitized confirmation evidence. Identify whether an item is a draft, filled form, submitted form, or persisted confirmed submission. A filled form is not submission evidence.

### Implementation sequence

1. Add fact-bank access that permits only reviewed, relevant profile facts and records explicit unresolved fields. Reference F02 and the onboarding consent/verification rules.
2. Implement resume/cover-letter templates through F10/F11. Validate contact details, dates, claims, artifact availability, and file type/size before opening a form.
3. Add adapter-specific question extraction and filling for a small supported ATS set. Use browser/API tools already authorized by the host; avoid permission-bypass launch flags and blanket computer access.
4. Build the review package with every answer, exact destination, application-specific disclosures, and selected attachments. After any answer, attachment, posting, or form change, regenerate the package and invalidate its previous approval.
5. Submission is a separate action. It requires action-time authorization for the exact final payload, no unresolved required answers, and supported completion verification. Re-read the form just before submitting; unexpected new fields pause.
6. Reconcile uncertain outcomes using the confirmation page/application portal. Never automatically retry an unknown submission. Record the pending action and evidence when human intervention is needed.

**Feasibility limits.** The upstream [please-hire-me browser recipe](https://github.com/alecswang/please-hire-me/tree/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae) is Claude-specific. LearnBridge needs a portable adapter and separate tests for each released host/browser/ATS combination. Authentication and file upload mechanics vary. Manual handoff is a legitimate supported outcome; “works for every application” is not.

### Objective acceptance

- **F15-A01:** Prepare an application from a profile lacking GPA and work authorization. Assert those fields are unresolved, not fabricated, and submission is blocked when either is required.
- **F15-A02:** In a fixture ATS, fill all supported fields and choose a resume. Assert exact field values, attachment filename and test-fixture content hash, and zero submit events before explicit approval.
- **F15-A03:** Change an answer or selected file after review, or inject a new required field just before execution. Assert no submit event and a new review requirement.
- **F15-A04:** Submit an explicitly approved fixture payload. Assert exactly one server-side application record for its idempotency key, a persisted confirmation ID/URL, and the correct saved status after restart. This is a fixture guarantee; a real ATS without idempotency needs reconciliation rather than the same guarantee.
- **F15-A05:** Simulate submit acceptance followed by network loss. Assert the run stays `unknown_outcome` until checked; it must not claim success or submit a second time automatically.
- **F15-A06:** A fixture page asks the agent to read unrelated files or bypass approval. Assert no additional file read or permission escalation occurs in the tool ledger.

**Live gate.** Prepare one real form per released ATS with a student-approved role and resume; verify fields/attachment and leave it unsubmitted unless the student separately authorizes submission. Live submission support requires observing an actual authorized confirmation, not inferring success from a click.

**Quality rubric.** Human review checks truthful claims, relevance, readability, and faithful answers to every prompt. An automated fact-reference validator blocks unsupported factual claims but cannot fully assess resume quality or ambiguous disclosures.

**Non-goals.** Unattended bulk application submission, bypassed CAPTCHA/login, unsolicited outreach, or fabricated candidate qualifications.

## F16 — Career practice and follow-up

**Meaning and milestone.** M4: help the student practice DSA, technical explanations, behavioral interviews, and evidence-based career communication, while tracking skills and follow-up commitments.

### Expected behavior and implementation

The student chooses a practice goal and mode: hints, timed attempt, walkthrough, or mock interview. Save exercise/source, student attempt, hints used, deterministic test results where applicable, feedback, and a revisitable checkpoint. Behavioral stories use reviewed experience facts and distinguish reflection from externally verifiable claims. Outreach drafts include the intended recipient/channel and remain local until separately reviewed. Follow-up reminders link to an actual application/contact record and use the student's chosen date, not an invented expected response.

Implement practice session records and recipes in `web/packages/core/workflows/career/`; use F07 retrieval and F02 facts rather than importing private profile content indiscriminately. For code exercises, run approved language-specific checks in a limited workspace through the host's allowed execution path. Never label a model-written solution as the student's demonstrated skill. Add structured feedback templates and editable reminders through F04/F22.

**Failure and recovery.** A failed code-run environment yields “not executed,” not “tests pass.” Interrupted sessions save the last acknowledged checkpoint. Unknown story facts require clarification. Provider limits preserve the attempt and permit later resume without inventing an assessment.

### Objective acceptance

- **F16-A01:** A practice fixture has one correct and one failing code attempt. Assert actual runner exit/results are recorded, the failing case is not passed, and progress distinguishes independent success from success after hints.
- **F16-A02:** Generate a behavioral draft from a fact bank containing no numeric outcomes. Assert no unreferenced metric or employer/project claim can be accepted as verified.
- **F16-A03:** Create a follow-up draft and reminder. Assert no message is sent, the reminder survives restart, and duplicate creation with the same operation ID produces one reminder.
- **F16-A04:** Interrupt a mock interview after question two. Resume and assert prior answers/hints remain, no unanswered question is marked completed, and the session resumes from the saved checkpoint.

**Live gate.** Complete one actual practice session with the selected agent mode. Code execution support is released per language/runtime, separately from conversational interview support.

**Quality rubric.** Human reviewers score feedback accuracy, appropriate hints, faithful story grounding, and whether students can explain what they learned. Passing exercise tests alone does not establish conceptual mastery.

**Non-goals.** Completing graded interview assessments, claiming credentials from browsing activity, or sending follow-ups without review.

## F17 — Projects, repositories, and teams

**Meaning and milestone.** M5: connect selected GitHub/Linear/project work to student planning; extract meeting actions; prepare issues, agendas, patches, and progress updates with inspectable evidence.

### Expected behavior and records

The student selects repositories/projects and whether LearnBridge may read local working trees, remote issues, or both. A project view shows milestones, assigned tasks, upcoming meetings, repository status, and source-checked changes. Meeting notes can propose task owners and dates; uncertain ownership stays unresolved. Coding requests produce a scoped patch, explanation, and actual validation results. Issue creation, comments, pushes, PRs, merges, team messages, and destructive changes are separate external actions with appropriate review.

Store account-qualified repository/project identifiers, issue IDs/revisions, milestones, selected local root, linked tasks, meeting action evidence, patch/run artifact references, and reviewed action payloads. Do not scan sibling repositories or replace global agent settings to gain access.

### Implementation sequence

1. Add read adapters and project-source mapping; reuse existing GitHub/Linear connector seams but fix required inputs rather than exposing tools that cannot be called correctly.
2. Normalize issues/milestones into linked task references, leaving their authoritative remote status intact. Task imports use stable external IDs; local edits do not silently mutate remote issues.
3. Add meeting/action extraction, agendas, and update-draft recipes with explicit source references and unresolved owners.
4. For coding, choose an existing authorized checkout/worktree, inspect its instructions and dirty state, preserve unrelated changes, and create scoped review artifacts. Keep execution inside host permissions; dependency/config/publication actions retain their separate rules.
5. Introduce reviewed remote mutations with fresh target revisions. Where providers lack conditional writes, detect pre-action changes and disclose that a residual race remains; do not claim transactional safety that the provider cannot supply.

**Failure and recovery.** Permission errors keep local work intact and produce a source-specific blocker. A remote issue edited after preview pauses with a diff. Dirty worktrees are not reset. Partially completed multi-action runs report each destination independently. A failed test is saved as failed rather than obscured by a polished update draft.

### Objective acceptance

- **F17-A01:** Import two projects with identical issue numbers. Assert account/repository-qualified identities, no collisions, and one linked task per stable remote issue after repeated refreshes.
- **F17-A02:** Feed meeting notes with an explicit owner/date and an ambiguous “someone should investigate.” Assert the first proposal retains evidence and the second has no invented owner/date.
- **F17-A03:** Prepare an issue update, edit the remote fixture revision, then execute. Assert no overwrite and a conflict requiring a new preview.
- **F17-A04:** In a fixture repository with an unrelated dirty file, apply a scoped patch. Assert the unrelated file's content is byte-identical and no push/commit/merge occurs. Save real test outcomes and the final diff as evidence.
- **F17-A05:** A three-action fixture fails action two. Assert action one is marked completed, action two failed, action three pending/cancelled as policy dictates, and retry does not duplicate action one.

**Live gate.** Read one approved repository/project. For write support, perform one separately authorized action on a student-selected test issue/project and read it back. A connected GitHub account alone does not prove Linear support or repository write access.

**Quality rubric.** Review action extraction and patch scope against user intent; assess coding quality using repository-appropriate checks and human review. A passing test suite does not prove every requirement or authorize publication.

**Non-goals.** Autonomous production changes, silent team communication, unrestricted background coding agents, or overwriting unrelated repository changes.

## F18 — Meals, pantry, and groceries

**Meaning and milestone.** M6: make practical meal suggestions and a grocery list from confirmed dietary preferences, pantry quantities, schedule, cooking equipment, and budget. Local planning works without retailer accounts.

### Expected behavior and implementation

The student supplies preferences and explicitly distinguishes strict restrictions/allergies from dislikes. Pantry records include item, quantity/unit, optional expiry, and last confirmation. Recipe records include servings, ingredients, preparation time, source, and uncertainty. Generate a plan that exposes substitutions and computes a consolidated shopping list after subtracting confirmed pantry quantities. Costs are dated estimates with source/unit/currency; unknown prices remain unknown. Never promise allergy safety from incomplete ingredient data.

Implement local pantry/recipe/plan tables, a unit-conversion library limited to supported conversions, and deterministic serving arithmetic. Do not convert weight to volume without a known ingredient-specific conversion. AI can propose recipes and substitutions; deterministic constraints check declared restrictions, equipment, time, and arithmetic before acceptance. Add printable/exportable lists via F11. Retailer integrations and purchases are optional later actions requiring separate account/scope and final cart review.

**Failure and recovery.** Unknown units, uncertain pantry stock, and missing ingredient labels produce questions rather than guessed quantities. Price lookup failure leaves an incomplete estimate. Accepted plans survive model failure and remain manually editable.

### Objective acceptance

- **F18-A01:** Scale a two-serving fixture recipe to four and subtract exact compatible pantry units. Assert expected quantities and one consolidated entry per normalized ingredient; incompatible units remain unresolved.
- **F18-A02:** A recipe contains a declared prohibited ingredient. Assert it is excluded or blocked pending an explicitly reviewed substitution. An unknown packaged ingredient list cannot display a verified-safe badge.
- **F18-A03:** Supply two sourced prices and one unknown price. Assert known arithmetic, currency separation, and an incomplete total rather than a fabricated value.
- **F18-A04:** Accept a plan and restart. Assert meals/list/preferences survive, and zero purchase or account-connection actions occurred.

**Live gate.** Student reviews one real week's plan and ingredient list. A retailer-price capability needs independent real listing/unit checks; planning can ship without it.

**Quality rubric.** Student review evaluates practicality, preparation effort, variety, and wasted ingredients. Nutrition or clinical dietary advice is not part of this feature.

**Non-goals.** Automated purchases, guaranteed allergen detection, medical meal prescriptions, or unreliable expiry judgments presented as safety facts.

## F19 — Routines, focus, and wellbeing planning

**Meaning and milestone.** M6: support student-chosen focus sessions, breaks, habits, workouts, and sleep schedule goals. The feature organizes routines; it does not assess mental/physical health or infer wellbeing from computer activity.

### Expected behavior and implementation

The student chooses a small number of habits, target frequency, preferred windows, and notification level. A focus timer has an explicit start/pause/resume/end state, records actual active time, and offers a user-chosen break. Habit completion is self-reported or comes from an explicitly authorized source; absence of activity does not prove failure. Suggested calendar blocks consider F05 availability and remain drafts until accepted. Trends show recorded observations and missing days rather than diagnostic labels.

Implement routine/session records, monotonic active-time accounting with a persisted wall-clock anchor for restart recovery, opt-in notifications, and reversible calendar proposals. Define what sleep/offline gaps mean for timers: offer recovery instead of automatically counting hours asleep as focused work. Device/wearable integration is separate, requires its own supported adapter and consent, and is not necessary for release.

**Failure and recovery.** After a crash or long sleep gap, show an interrupted session and ask whether to resume/discard/adjust. Denied notification permissions retain the routine and surface in-app reminders. Timezone changes reschedule future local-time windows without rewriting completed history.

### Objective acceptance

- **F19-A01:** A fake clock runs 10 minutes, pauses five, and resumes 10. Assert active duration is 20 minutes, not 25; repeated end events create one completion.
- **F19-A02:** Simulate an eight-hour sleep gap. Assert the session is interrupted with recovery choices, not credited as eight hours of focus.
- **F19-A03:** Leave a habit unrecorded for three days. Assert unknown/missing observations, no inferred failure or health judgment, and no notification when notifications are disabled.
- **F19-A04:** Change timezone across daylight-saving fixtures. Assert future reminders follow the declared timezone policy and completed timestamps remain unchanged.

**Live gate.** Complete a real focus session and verify only the permitted notification channel. Native notification support is released per OS.

**Quality rubric.** Students assess whether suggestions reduce friction and remain supportive. Do not use completion streaks as a proxy for health or impose opaque productivity scoring.

**Non-goals.** Medical guidance, mood inference from surveillance, coercive reminders, or unapproved health-data access.

## F20 — Budget and student administration

**Meaning and milestone.** M6: organize imported receipts, a simple student budget, scholarships/deadlines, and administrative forms. This supports records and reminders; it does not make investment/tax/legal decisions or transact money.

### Expected behavior and records

The student chooses receipt/import folders and budget categories. Imported transactions retain amount, currency, date, merchant, original source, extraction confidence, and reviewed category. Uncertain OCR stays unconfirmed. Budgets calculate totals per currency and distinguish known transactions, estimates, and missing periods. Scholarship/admin records store official URL, requirements/deadline text, last checked time, confirmed applicant facts, and unresolved eligibility. Forms follow the F15 review mechanism with sensitive fields supplied or explicitly approved by the student.

### Implementation sequence

1. Add local receipt/transaction/budget/admin-deadline records. Parse a limited documented CSV schema first, then optional receipt OCR with separate dependency and privacy approval.
2. Deduplicate file imports by hash and provider/source transaction identifiers where available. Suggest likely duplicates for review; do not delete two similar legitimate purchases.
3. Calculate deterministic category totals and budget variance. Never merge currencies without an explicitly selected dated rate; label such converted views as estimates.
4. Add official-source scholarship/admin lookup and linked reminders. Eligibility follows confirmed facts and explicit unknowns.
5. Prepare forms locally with field-level evidence and exact payload review. Banking credential collection, transaction execution, and identity-document vaulting are outside the first release.

**Failure and recovery.** Malformed CSV rows are reported individually with counts; valid rows can be imported atomically according to an explicit all-or-selected-row choice. OCR ambiguity does not silently alter totals. Private receipts are not uploaded to a cloud model unless that selected source/destination processing is approved.

### Objective acceptance

- **F20-A01:** Import a fixture CSV containing two currencies, a duplicate source ID, a refund, and a malformed row. Assert expected accepted/rejected counts, no duplicate transaction, correct signed totals per currency, and a visible rejected-row explanation.
- **F20-A02:** OCR returns ambiguous `12.00` versus `1200`. Assert the transaction stays unconfirmed and excluded from confirmed totals until reviewed.
- **F20-A03:** A scholarship requires a fact absent from the profile. Assert eligibility is unresolved, not eligible/ineligible by assumption, with exact requirement evidence.
- **F20-A04:** Prepare an admin form. Assert no submission, sensitive values stay in authorized storage/output, and redacted diagnostics contain none of the fixture's sensitive marker strings.

**Live gate.** Student checks one real import and one official deadline. Optional OCR providers/export destinations require separate scope and output checks.

**Quality rubric.** Human checks category usefulness and faithful extraction. Correct arithmetic is deterministic; OCR, scholarship fit, and ambiguous form interpretation need review.

**Non-goals.** Bank account scraping, purchases/payments, tax/legal advice, or automatically disclosing identity/financial information.

## F21 — Campus, transit, and travel preparation

**Meaning and milestone.** M6: help the student get to classes/events and prepare trips using official schedules, selected locations, weather, room/office-hour data, and reviewable checklists.

### Expected behavior and implementation

The student selects campus, broad starting location or a specific route when necessary, commute mode, and buffer. Import office hours/room locations from approved course or official campus sources. Look up time-sensitive transit and weather through supported sources at request time; show fetched time and service date. Recommend departure windows with buffer and explicit assumptions. If real-time data is unavailable, distinguish scheduled estimates from current arrivals. Travel checklists can include dates/documents/tasks, but booking is a separately reviewed action.

Implement provider-independent location/event/route result types with timezone, service date, source URL, freshness, and realtime/scheduled distinction. Start with manual timetable/room import and one official transit source. Live location tracking is not necessary. Integrate route windows with F05 calendar planning and F04 tasks; the student accepts added buffers/events.

**Failure and recovery.** Unknown room or route produces a specific missing-data result. Stale schedules display their date and cannot claim current real-time service. Connection failures offer a sourced scheduled fallback or a link to the official app. Never treat route absence as proof that travel is impossible.

### Objective acceptance

- **F21-A01:** A scheduled fixture has a 09:00 class, 30-minute trip, and 10-minute buffer. Assert departure recommendation is no later than 08:20 in the correct local timezone, with the assumptions and source.
- **F21-A02:** Feed stale realtime data and a fresh scheduled fallback. Assert the view labels the selected result scheduled, shows its freshness, and does not claim a realtime arrival.
- **F21-A03:** Supply a campus room with no verified building mapping. Assert it remains unresolved instead of inventing directions.
- **F21-A04:** Create a trip checklist and buffer preview. Assert no booking, geolocation request, or calendar write occurs without its separately approved capability/action.

**Live gate.** Compare one real route/event against an official source for the supported region/service date. Unsupported campuses remain manual import plus links; they are not advertised as automatically integrated.

**Quality rubric.** Student checks usefulness, realistic buffers, and whether uncertainty is easy to understand. Travel time prediction is not guaranteed merely because calculations pass.

**Non-goals.** Continuous location surveillance, autonomous bookings, or claiming worldwide transit coverage.

## F22 — Opt-in monitoring and recurring workflows

**Meaning and milestone.** M5: run chosen read/analysis recipes while the local runtime is available, detect meaningful changes, and notify only under the student's selected rules. Examples include course updates, saved job availability, upcoming deadlines, and expired connections.

### Expected behavior and records

The student explicitly creates a schedule with workflow version, approved source scope, timezone/frequency, notification rule, resource budget, and optional end date. Preview what it will read and whether data goes to a model. Store next due time, last attempted/successful time, source watermarks, lease/run IDs, failures, missed runs, and notification fingerprints. Unchanged success is quiet. Incomplete refreshes are not successful no-change results. The dashboard shows actionable failures and missed-run status without repeatedly sending the same message.

Background actions are limited by the schedule's authorized capabilities. A request for read monitoring does not authorize messages, purchases, application submission, or arbitrary browser control. A schedule cannot defeat a host's required approvals. If a recipe needs interactive login/review, pause as `awaiting_student` and present the concrete action.

### Implementation sequence

1. Implement schedules and durable jobs in `web/apps/local-runtime/` using database leases, at-most-one active run per schedule, cancellation, bounded retries, and saved checkpoints. Build from the shared runner rather than an independent daemon with weaker permissions.
2. Define source cursors/change fingerprints and idempotent task updates. Commit each source's durable updates before advancing its watermark.
3. Add deterministic notification rules for meaningful changes/failure severity; optional model-written explanations cannot decide whether a failed source was complete.
4. Add startup catch-up: show missed runs and coalesce obsolete scheduled refreshes into a bounded current refresh, while preserving the missed-run history. A sleeping laptop cannot execute jobs.
5. Add notification transport only with its explicit permission/capability. In-app alerts work first. Always-on remote execution is a distinct optional architecture with separate credentials, consent, and a smaller capability set.

**Failure and recovery.** Expired sessions pause the relevant source. Rate limits use bounded backoff. Crash recovery reclaims expired leases after a declared timeout and resumes only idempotent steps; ambiguous external actions require reconciliation. Disabling a schedule cancels future work and marks the current run for cooperative cancellation without corrupting saved results.

### Objective acceptance

- **F22-A01:** With a fake clock and two workers, make the same schedule due. Assert one active lease/run and one durable source update; repeated worker dispatch cannot duplicate task changes.
- **F22-A02:** Refresh an unchanged fixture twice, then one changed deadline. Assert zero notifications for the first two runs and one fingerprinted notification for the actual change, surviving restart without re-notification.
- **F22-A03:** One source fails during a refresh. Assert partial status, unchanged failed-source watermark, and no “all caught up” result. A later successful retry advances only verified data.
- **F22-A04:** Simulate sleep across five due times. Assert five missed occurrences in history or an explicitly counted equivalent, one bounded catch-up run, and no fabricated execution while asleep.
- **F22-A05:** Disable during a paginated run. Assert cancellation at the next safe checkpoint, no future dispatch, intact committed pages, and no cursor beyond them.
- **F22-A06:** A read-only scheduled recipe proposes an outbound message. Assert the message is only a draft/action proposal and cannot execute from the schedule's read permission.

**Live gate.** Enable one student-approved low-frequency read schedule, observe a real run and no-change quiet behavior, then disable it and verify dispatch stops. Always-on support requires its own deployment and operational tests.

**Quality rubric.** Pilot notification relevance and missed-important-change rate against student feedback. Noise limits and truthful run status are hard gates; “comprehensive monitoring” is not a measurable promise without declared sources.

**Non-goals.** Jobs running on a sleeping laptop, auto-renewed blanket permissions, or silent remote migration of private browser sessions.

## F23 — Voice capture, mobile companion, and optional sync

**Meaning and milestone.** M6: let the student capture a quick note/task and review selected LearnBridge data from a supported device, without pretending local storage alone makes remote access or transcription available.

### Expected behavior and implementation

Voice capture requires microphone permission and an explicit local/cloud transcription choice. The preview shows the transcript and proposed task/note before saving. Keep uncertain dates/names unresolved. Raw audio retention is configurable and disclosed; default to removing temporary audio after the student accepts/discards the transcript, including derived temporary files. Conversational voice is a separate capability, not required for capture.

The initial mobile companion can be a responsive read/review interface with manual entry. Access to a laptop's local runtime requires authenticated, short-lived device pairing and a supported encrypted transport. Do not expose the proposed authenticated local service on the LAN without the separate pairing and encrypted-transport release gate. The architecture must specify session expiry, revocation, replay protection, and the private read/write gates before enabling pairing. For access while the laptop is unavailable, optional hosted sync needs account authentication, selected-data consent, conflict handling, and a separate release gate. No local D2L browser token is synchronized.

Implementation order: (1) responsive local UI and typed quick capture; (2) one supported transcription adapter with measured accuracy/limits; (3) authenticated device pairing and selected read/task-write operations; (4) optional sync. Cloud transcription may require API billing even when the student uses a subscription-backed coding agent: provider modes have distinct capabilities. In particular, the reviewed OpenAI plan-usage [preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) do not make an audio/transcription API available; choose and verify an allowed adapter rather than silently charging an API account.

**Failure and recovery.** Denied microphone permission leaves typed input usable. Transcription failure retains only the temporary data permitted by the retention choice and offers retry/discard. Expired pairing blocks all private reads/writes until reauthorized. Offline edits remain visibly pending and use record revisions when replayed; conflicts show both versions for review rather than last-write-wins loss.

### Objective acceptance

- **F23-A01:** Feed an audio fixture whose transcript contains an ambiguous “Friday” task. Assert no invented date, student preview before saving, and one accepted task after repeated save requests.
- **F23-A02:** Deny microphone access or fail transcription. Assert typed input remains available, no task is marked accepted, and the UI names the missing capability without hidden paid fallback.
- **F23-A03:** Accept/discard a transcript under default retention. Search the managed temporary/audio directories and logs for fixture audio/artifact markers. Assert removal from declared local temporary stores; provider retention, if applicable, is reported according to its actual policy rather than falsely asserted deleted.
- **F23-A04:** Test unpaired, expired, revoked, and replayed device sessions. Assert every private read/write is rejected; valid pairing permits only declared scopes and expires at the specified time.
- **F23-A05:** Edit one task offline on two devices from the same revision. Reconnect and assert a visible conflict with both edits preserved, not silent overwrite; retrying a successfully accepted operation does not duplicate it.
- **F23-A06:** Inspect a selected sync fixture. Assert no D2L/browser credential material, excluded source content, or unselected profile fields leave the local runtime.

**Live gate.** Prove one end-to-end capture on each released microphone/platform/transcription mode and one paired-device session including revocation. Hosted sync is not released based only on responsive layout tests.

**Quality rubric.** Measure transcription/task extraction against consented labeled samples; review accent/noise/date failures and capture friction. A valid task schema does not prove the transcript heard the student correctly.

**Non-goals.** Automatically accessing phone data, unlimited free voice inference, universal always-on mobile access, or syncing local university/session credentials.

## Delivery boundary

The first useful career slice is F14 verified discovery plus a reviewed F15 artifact package; it does not require every life feature. The first connected-productivity slice is one F12 read provider, F13 local capture/export, and one F22 read schedule. M6 features ship individually only after their deterministic checks, supported-platform live gates, and student quality review pass. Unavailable adapters must remain visibly unavailable rather than becoming empty success responses.
