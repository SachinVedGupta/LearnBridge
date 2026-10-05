# Reviewed internship application packets

## Implemented student workflow

The local **Application packets** screen builds a durable private review packet from an actual current saved official posting, selected current career facts the student confirmed, and already reviewed local Writing drafts. It provides a useful manual handoff artifact without inventing answers, silently filling a form or claiming an application was submitted.

1. Read one chosen public role in **Public job discovery**. Its source must currently qualify as a verified published opening, with an authentic bounded successful response receipt.
2. Confirm relevant facts in **Profile**, including the new dedicated career email field when desired. Choose exactly which current career facts to include in this packet. Proposed, conflicting, stale, expired, rejected and other-purpose facts are excluded.
3. Optionally select current, already accepted or applied **unrestricted Writing drafts**, assigning the `resume` and `cover_letter` slots yourself. The system does not guess a document’s purpose from its title. No missing document is manufactured.
4. Review your required checklist. The practical default requires name, email, education, experience and resume, with graduation and cover letter optional. These are **student checklist defaults, not an extracted employer form**. The student may adjust the checklist; it does not create a claim that all official employer requirements are known.
5. Optionally enter exact application questions and manual draft answers. An answer backed by selected confirmed facts must equal those facts’ literal text. Freeform motivation/story drafts stay labeled `manual_draft_facts_unverified`; automated semantic fact verification is not performed. Missing facts remain unresolved.
6. Click **Prepare this private review packet**, inspect the exact source/facts/answers/drafts/missing manifest and payload hash, then explicitly review that exact saved packet. Review permits only private text exports; incomplete packets can be reviewed and downloaded with their missing entries still present.
7. Download a byte-verified **JSON** or **Markdown** packet. Recheck the official posting before using a downloaded copy later. Select **Forget this private packet** to remove its current local record; historical revisions, backups and previously downloaded copies retain the existing separate retention rules.

Typed email is explicitly student supplied, syntax validated, career-purpose scoped and human confirmed through the original profile review flow. It does not prove mailbox ownership or deliverability. GPA, work authorization, sponsorship and demographic disclosure fields are not typed supported profile facts in this slice: if requested or required, they remain explicit missing entries. A generic `eligibility` statement, name, degree or experience cannot fill them. The feature does not infer protected disclosures.

## Source and artifact meaning

Every packet is an additive `career_item` record with category `application_packet` and format `learnbridge_career_packet.v1`. Existing manual Career application/draft records remain separate. A packet retains the exact selected official job snapshot, source URL/identity/hash, successful raw response hash/byte count/status, original selected content and extracted text, source-observed and last-check times, and the 24-hour source-freshness boundary. Published presence does not establish eligibility, suitability or a recommendation.

The packet stores selected profile record IDs/revisions/fingerprints, exact values, human confirmation receipts and evidence excerpts/pins. It reads only already saved local document evidence through the existing profile contract; it does not search laptop folders, discover accounts or query new cloud sources.

Each selected Writing draft is obtained through the unchanged `createWritingService().exportArtifact()` gate. The packet pins the Writing record revision/payload hash, current accepted/applied saved document ID/revision/byte hash and selected original Writing source pins. It copies that exact reviewed saved Markdown text, including its provenance and content-quality label. Model-origin accepted drafts retain their unverified-fact labels. These are **reviewed Markdown drafts**, not verified resume attachments, PDF/DOCX output, uploaded files or a semantically verified resume. Layout and factual-quality review remain separate checks.

Manually entered questions retain exact prompt text, required flag, supplied draft text, selected fact references and status. Their source is explicitly `student_entered_not_official_form_discovery`; the employer form is `not_read_or_verified`. A required missing answer or checklist fact remains in the manifest. `checklist_complete` describes only the selected checklist, and `submission_supported` is always false. No “applied” state, employer confirmation, attachment verification or automated readiness claim is produced.

## Exact review, stale data and retention

Preparation is idempotent for an exact request key and body. A repeated request returns the current same saved packet/review. Reusing the key with different selected sources/questions/checklist fails; a stale source cannot be silently refreshed by retrying an old request.

The packet payload has a canonical SHA-256, independent of its later review record. Review binds exact record revision, payload hash and the paired local student. An exact review retry is idempotent. Exports require the current reviewed record revision/hash and revalidate every selected source before returning bytes:

- Changed, failed, source-unavailable, expired or deadline-passed selected official postings fail. A new source read, including an identical-body recheck or shortlist revision change, invalidates an old record-revision pin; preparing a new packet is deliberate.
- A profile edit, rejection, deletion, expiry, new conflict or changed/deleted evidence invalidates the selected fact. Facts cannot remain exportable merely because their old copied strings still exist in the packet.
- Pending/rejected/forgotten, changed-source, changed-copy or later applied Writing cannot reuse an old packet review. Only the exact current selected saved copy passes.

Old private previews remain visibly stale for the student’s history; they are not exportable or newly reviewable. Forgetting uses the exact packet revision/hash and remains possible after source revocation or expiry. It removes neither the original posting, profile facts nor Writing sources. Historical local revisions/backups and downloaded copies are explicitly not claimed to be erased by a current-record deletion.

Public observations made before the separate successful `source_request` field was introduced have a narrow compatibility path: only `last_check.status === observed` permits the existing `request` receipt to act as that successful source receipt. Its status must be 200, API URL must match the fixed provider/board/ID endpoint, SHA must be a valid response digest and byte count must be positive and bounded. Failed latest requests are never inferred to describe an older successful body. State and preparation apply the same gate.

## API and implementation contract

`createCareerPacketService({ store, publicJobService, clock })` exposes `state`, `get`, `prepare`, `review`, `forget` and `exportArtifact`. Its clock returns integer epoch milliseconds. The runtime owns one service instance; public job selection uses the existing service’s saved local evidence and performs no additional public fetch.

The normal paired cookie/nonce/same-origin/strict JSON/no-query boundaries protect these routes:

| Route | Contract |
| --- | --- |
| `GET /api/local/v1/career-packets/state` | Saved packet metadata, selectable current verified role pins, confirmed career facts, eligible Writing metadata and practical checklist defaults |
| `POST /api/local/v1/career-packets` | Exact selected sources/manual questions/checklist; requires `Idempotency-Key`; returns `{ packet }` |
| `GET /api/local/v1/career-packets/items/:id` | Exact saved private preview, stale/exportable flags and explicit missing manifest |
| `POST /api/local/v1/career-packets/items/:id/review` | `{ expected_revision, payload_hash }`; exact current source recheck; returns `{ packet }` |
| `POST /api/local/v1/career-packets/items/:id/export-json` | Same exact review pins; returns text, MIME, safe filename, byte count, SHA-256 and source/review manifest |
| `POST /api/local/v1/career-packets/items/:id/export-markdown` | Same review pins and receipt; text-only Markdown packet |
| `DELETE /api/local/v1/career-packets/items/:id` | Same record revision/hash, even for stale sources; removes current packet and reports remaining historical-copy retention |

Preparation body:

```json
{
  "role_ref": { "id": "selected-role-record-UUID", "revision": 1, "source_sha256": "64-character-selected-source-hash" },
  "profile_refs": [{ "id": "selected-profile-UUID", "revision": 2, "fingerprint": "64-character-profile-fingerprint" }],
  "writing_refs": [{ "slot": "resume", "id": "accepted-Writing-UUID", "revision": 2, "payload_hash": "64-character-Writing-payload-hash" }],
  "questions": [{ "id": "experience", "prompt": "Describe relevant experience", "required": true, "fact_field": "experience", "fact_ids": ["selected-profile-UUID"], "draft_answer": "Exact selected confirmed fact value" }],
  "requirements": [{ "key": "email", "required": true }, { "key": "resume", "required": true }]
}
```

The sample shows the schema, not literal valid IDs/hashes. `requirements` is optional; omission selects practical defaults. Profile fields supported here are name, typed email, university, program, graduation, experience and goals. A question may set `fact_field: null` for an explicitly unverified manual draft, `draft_answer: null` for an unresolved answer, or reference exact already selected matching facts. Questions are not automatically fetched or answered. Duplicate IDs/slots/checklist keys, unsafe input accessors, unknown fields, paths/URLs, replacement provenance or unsupported file formats are rejected.

Limits: 20 selected profile facts, two Writing slots, 20 manually entered questions, 100 saved current packets, 100,000 UTF-8 payload bytes, 120,000 persisted record bytes and 220,000 download bytes. Oversize packets fail before persistence; no source text is silently truncated. Students can choose fewer/shorter drafts or facts to make a bounded useful packet. Original document limits remain in force.

Both formats contain the same exact payload and manifest. JSON is the reusable structured packet. Markdown provides fixed explanatory text and the complete JSON packet inside an inert fenced block; backticks and angle brackets inside JSON strings are Unicode-escaped and recover exactly when parsed. This is not a rich rendered application document. The browser checks actual byte count/SHA, exact current reviewed payload/hash, source identity/freshness, selected facts and Writing saved-copy hashes before creating a Blob. A duplicate export click cannot duplicate one in-flight request. Logout/reset, changed-source refresh, another selected packet or a newer preview suppress late results. Created Blob URLs expire after 30 seconds or on reset/switch/forget; actual downloaded copies have separate retention.

No production dependencies, provider configuration, application API POST, browser actions, attachment upload, external messages, automated discovery, model processing or submission were introduced.

## Objective verification completed

```sh
cd web
node --test scripts/career-packet-*.test.mjs
node --test scripts/career-packet-*.test.mjs scripts/public-job-*.test.mjs scripts/local-career*.test.mjs scripts/local-profile*.test.mjs scripts/local-writing*.test.mjs scripts/local-rich-writing*.test.mjs
```

All **25 new cases** and **116 combined packet/discovery/career/profile/writing/export cases** pass. Checks exercise actual SQLite, the unchanged profile/Writing gates, real paired HTTP and the actual shipped packet controller:

- Exact public response/source pins and current selected document-backed experience, accepted/applied text readback and preservation of unrelated private sources/tasks/grants.
- Dedicated confirmed email resolves only its selected exact value; missing/conflicting/invalid email is denied. GPA/work authorization/protected disclosures remain missing instead of being inferred.
- Explicit manual drafts, literal confirmed answers, unsupported/unselected references, forged source authority, strict methods/query/IDs, cross-workspace IDs, malformed/accessor/duplicate inputs and actual payload byte limits.
- Profile evidence edits/expiry/rejection/new conflict; selected role change/failure/404/age; Writing source/copy/forget changes. Old reviews/exports fail and retained preview stays visibly stale.
- Idempotent prepare/review retries, exact revision/hash denial, guarded legacy source receipts, and deterministic JSON/Markdown payload recovery and actual byte hashes.
- Restart and a fresh verified backup restore preserve the exact packet review/export bytes without another provider read. Old browser credentials fail after restart.
- The real UI controller explicitly prepares/reviews both formats against actual HTTP and creates independently read-back matching Blobs. Duplicate/late results, older slow selection and source refresh cannot expose stale downloads; Blob URLs are revoked on reset.
- Exact local forgetting works when sources are stale and preserves selected sources/profile/Writing while reporting historical-copy retention.

The controller tests use a synthetic DOM; real Blob bytes are checked, but they do not claim a native browser saved files, a rendered resume was reviewed or a real employer form was prepared. No live employer application was opened or mutated by these tests.

Separately, the integrated root agent completed an **actual browser JSON download** in a disposable workspace. The saved file `LearnBridge-application-packet-aa30c2c7.json` contained **24,687 bytes**, SHA-256 `b58d5d891f29f1eb21764990ad22bf2fe082ac5e397a3fb68ca14ce744926bf3`, payload hash `a89c03d6ae6144aa4d5fb3206628074d428c468976e99e668aa0531ceb352ede` and selected official source hash `dfafd43e02658e40e3f25a204fbe5d9472f38ed76637c7a054a930ef4172ffdb`. It included one synthetic confirmed email fact and four unresolved required checklist entries; `submission_supported` and `uploads` were false and sharing was `not_granted`. The sanitized receipt is `/tmp/learnbridge-career-packet-live.json`; its screenshot is `/tmp/learnbridge-career-packet-browser.png`. These temporary evidence files are local artifacts, not repository fixtures. This proves that particular JSON save/readback, independently of the synthetic controller tests. It does not prove a Markdown file save, a recommended internship, employer-form compatibility or rendered attachments.

## Separate remaining gates and next implementation

1. Extend the observed JSON save to an actual Markdown save in a disposable student workspace, compare its bytes to the exact HTTP receipt and independently recover the selected source/facts/draft pins. Check desktop/mobile usability and stale-source refusal separately.
2. Add official selected application-question discovery with a bounded provider adapter and explicit coverage/schema pins. This packet currently uses student-entered questions only.
3. Add a real reviewed attachment registry, independently opened/rendered resume formats and explicit attachment selection. A saved Markdown draft/hash is not sufficient evidence of an employer-compatible PDF/DOCX attachment.
4. Add one supervised ATS form adapter with exact before/after readback and zero submission events. Each browser/host/provider needs its own authorized compatibility proof; a manually reviewed packet cannot prove form filling.
5. If typed GPA/work authorization/disclosures are introduced later, design their explicit student-statement schemas/review and purpose gates first. Never derive them from unrelated facts. Semantic resume quality, truthful relevance and ambiguous answers require student quality review.

This is the first review-packet part of [F15](../FEATURES_PRODUCTIVITY.md#f15--application-preparation-and-reviewed-actions). Submission/attachment/form gates remain outside its released contract.
