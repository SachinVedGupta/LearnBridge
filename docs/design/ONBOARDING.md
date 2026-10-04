# Student discovery and profile onboarding

Status: **broader discovery and profile design specification**. The local dashboard now ships a narrow **Get started** guide: explicitly selected saved-record metadata, purpose/coverage checks, useful next steps and an exact reviewed local report. Read [the implemented guided onboarding contract](implementation/GUIDED_ONBOARDING.md) for its routes, limits and verification mapping. It does not discover new files/accounts, synthesize a profile, grant sharing or test a host connection. The [dated slice verification](implementation/GUIDED_ONBOARDING_VERIFICATION.json) records its measured tests, browser proof and limits.

This document defines the wider proposed behavior for **F02 Student profile** and **F03 Controlled discovery**. Some foundations already exist: local student identity/storage, reviewed profile facts, selected-folder inventory/text/PDF/Office acquisition and reviewed academic exports. The expanded account discovery, extraction, profile synthesis and executable playbook below are not all shipped. The accompanying [synthetic consent example](examples/onboarding-consent.example.json) is still a design fixture, not permission to access a real person's files or accounts.

The hosted website uses Supabase identity/storage and student-selected Composio reads. It remains separate from the paired local runtime and does not provide the broader local discovery engine, machine-wide indexing, an agent-memory importer or the complete deletion procedure specified below. Starting that website locally still uses its configured cloud services. The [local vision](../LOCAL_FIRST_VISION.md) describes the separate local edition; local pairing cannot bypass hosted authentication.

## Outcome

Onboarding should produce a student-reviewed profile, a source map, and an honest coverage report. It should help a student select useful context across school, career, projects, communication, and daily life without asking them to manually describe everything. The student controls the breadth, can preview it, and can stop or narrow it at any time.

Discovery proceeds through **inventory → selection → local extraction → candidate profile → review**. Model processing is a separate opt-in at each relevant stage. A local read approval never implies cloud AI approval, external writes, message sending, application submission, or recurring monitoring.

## Delivery milestones

| Milestone | Onboarding deliverable | Release evidence |
| --- | --- | --- |
| M0 Design | Consent contract, source boundaries, fixture matrix and agent playbook | Documentation/example validation only; no real scans |
| M1 Local foundation/setup | Local identity, isolated data directory, consent UI, deterministic inventory, run journal, doctor | Clean setup; all access denied before consent; cancellation and restart tests |
| M2 Profile/academic read | F02 reviewed profile; F03 selected extraction; course/file/Avenue adapters | Fixture matrix passes; supervised source selection and interactive university auth |
| M3 Agent/planning | Remote-processing consent, profile/context tools, daily planning | Authorized agent sees only approved context; receipts, budgets and provenance retained |
| M4 Documents/browser/career | Resume/job-preference import, project/document sources, selected browser workflows | Complete answer/document review; no unintended external action |
| M5 Connected productivity | Collection/channel selectors, provider pagination, refresh and review | Provider-specific live checks; changed scopes and partial coverage handled |
| M6 Life/mobile | Optional personal-life fields, device pairing, explicit sync scope | Independent sensitive-data and device approvals; export/forget checks |

## Consent contract

Store versioned consent records locally, outside Git. Use separate IDs for the local reader, remote processor, recurring refresh, and any later write authorization. Every request references a consent ID/revision and a purpose. Missing, expired, revoked, or mismatched consent fails closed. A fixture consent can be consumed only in fixture mode and never grants production access.

| Grant | Permits | Does not permit |
| --- | --- | --- |
| Metadata inventory | Names/types, counts, sizes, timestamps and opaque references within selected roots or collections | File bodies, full messages, hidden stores, attachments, remote AI processing |
| Local content read | Extraction of selected content into the local database for the stated purpose | Sending it to Codex/Claude/OpenAI or another remote model |
| Remote model processing | Specified metadata/excerpts/documents/profile fields to a named provider and execution mode | Other sources, future providers, arbitrary history, paid fallback or retention promises |
| Recurring refresh | Bounded repeat reads of an unchanged approved source scope | New folders/accounts/channels, persistent broad monitoring or writes |

Consent previews show source/account identity, scope, exclusions, estimated count/size, purpose, provider if applicable, expiry, budget, and storage/export consequences. Explain that using a cloud-backed Codex or Claude session transmits tool results supplied to that session. Even filenames and profile summaries may be personal data. Deterministic local inventory/extraction must therefore run outside the remote agent; before remote consent, that agent gets only permitted status/counts and opaque IDs, never personal filenames, snippets, paths or inferred traits.

Declining remote processing still permits deterministic local inventory and student-authored profile entry when their local grants allow it. A later remote request must identify exactly which profile fields and source subsets it will send. Do not silently switch providers or use a paid API key when subscription execution is unavailable.

## Source selection and identity

Start with an empty source list. Offer likely categories and an explicit folder/account/collection chooser; do not walk the home directory to find candidates. A student can intentionally select several broad roots, but receives a count/size preview and can remove subfolders before content reads. Selecting a root requires metadata consent for that root, not a claim that its content is already understood.

| Source | Initial approved inventory | Subsequent content scope |
| --- | --- | --- |
| Local files | Selected canonical directory roots; allowed types; depth/count limits | Explicit files/subtrees from that inventory; bounded text extraction and attachment sizes |
| Cloud Drive/Notion/Office | Verified account, selected drive/workspace/collection IDs | Selected document IDs/subcollections; provider permissions may exceed LearnBridge's selected scope |
| Mail/chat | Verified mailbox/tenant and selected folders/channels; subject metadata only if approved | Bounded date range, selected threads/channels, separate attachment choice |
| GitHub | Verified account, selected repository IDs and branches | Chosen source/docs/issues; commits and public profile only when selected |
| Website | Explicit URL/domain and a chosen page/depth limit | Public or student-authorized pages; no expansion to linked domains |
| Agent memories | Files the student intentionally exports and selects | Previewed records from that export only; no automatic reads of agent-private state directories |
| Avenue/D2L | Institution profile and user-completed SSO; chosen courses | Course records/materials available to that student; read-only academic adapter |

Show the provider-returned account email/name/tenant or local profile label and ask the student to confirm it is the intended identity. Display mismatches clearly. Do not assume that a browser's signed-in account, a shared computer's owner, or a Git commit author's name identifies the current student. Never combine accounts on a matching name alone. Shared/course/team documents supply context, not facts about the student unless reviewed.

When both collection IDs and document IDs are selected, treat them as an **intersection**: a document must be explicitly selected and verified to belong to an approved collection under the intended account. Neither selector expands the other. Verify membership/version during inventory and again before reading; moves, shortcuts to unselected targets, changed ownership or unavailable membership evidence pause the read for review. Do not traverse unapproved collections merely to establish membership.

Auth setup is independent of discovery. The student enters credentials/MFA through the provider or official agent client. Discovery tools never read passwords, API keys, OAuth credentials, tokens, cookie databases, browser auth profiles, session exports, SSH material, `.env` files, OS vaults, password managers, clipboard contents, or other students' profiles. A connector's dedicated credential mechanism must not expose secret values in discovery, model context, logs or exports.

## Local boundaries

Resolve each selected root to its canonical path before approving it. Reject paths outside selected roots, traversal, symlink escapes, junction/reparse-point escapes, redirected mount targets, and files changed to a different target after inventory. Default to not following symlinks. A new linked target needs its own explicit root selection; approving the containing folder does not approve the target.

A realpath check followed by a path-based read leaves a time-of-check/time-of-use race. The platform adapter must anchor traversal to the approved directory descriptor/handle, apply no-follow rules to path components, open the candidate without following links, and verify the opened object's identity/type and containment against that approved root before reading its content. Compare the opened file's stable OS identity and snapshot version, then extract from that same descriptor/handle; never reopen the pathname after verification. Reject devices/special files and changed directory/root identities. Protect concurrent rename/reparse-point swaps, including a swap immediately after the initial check. If a platform cannot provide the required race-resistant path/handle guarantees, report the feature blocked/unsupported and use an explicitly imported managed copy under a supported acquisition boundary; never silently substitute check-then-open as equivalent protection.

Exclude secret/auth/system directories and file classes before enumerating their contents. Do not reveal excluded filenames or inspect their bodies merely to explain exclusion. Report an exclusion category and count when available without crossing the boundary. Default exclusions include `.git` object databases, dependency/build/cache directories, OS/browser credential stores, agent-private authentication/state folders, hidden credential files, and known token/cookie/session exports. Treat user-exported memory as a separate reviewed import, not an exception to these exclusions.

Allow only selected content types. Use bounded extractors with explicit file/response/time limits; do not run scripts, macros, notebook cells, package hooks or instructions inside discovered content. Keep archive extraction off initially; later support requires traversal-safe extraction and expansion limits. Do not hydrate cloud placeholders, download remote attachments or inspect nested archives without the relevant scope. Files that cannot be accessed or extracted stay visible as blocked/unsupported coverage entries.

Before remote transmission, run a local secret screen and payload preview. Quarantine possible credentials instead of printing them or shipping them to the model. A heuristic screen cannot guarantee that arbitrary documents contain no sensitive information; student scope selection and explicit payload approval remain necessary.

LearnBridge enforces these boundaries only for its managed runtime, connectors and tools. It cannot intercept arbitrary shell, filesystem, browser or cloud tools already available to a host agent. Agent packs must forbid substituting direct reads after a managed tool denies a scope, consent or identity check; use a narrower approved scope or ask for a new student selection. Host sandbox/permission controls remain necessary for tools outside the broker. A host with unrestricted tools must not be presented as fully confined by LearnBridge's grants.

## Budgets, pagination and coverage

Each run has hard limits for files, total bytes, bytes per file, directory depth, pages/API requests, elapsed time, extracted characters, remote payload size and model usage. Stop before exceeding a limit. Record counts against limits and show the remaining backlog. Broad sources may require multiple reviewed batches; the agent must not reset a budget repeatedly to evade a cap.

Use documented provider pagination and persist opaque cursor/watermark state separately from logs. A cursor may contain sensitive provider state; never include it in model context or general exports. Enumerate until completion, a budget boundary, cancellation, permission failure or unsupported pagination. Date windows, channel filters, provider eventual consistency and page ordering belong in coverage. A first page is not a completed collection.

Coverage records use `complete`, `partial`, `blocked`, `unsupported`, `cancelled`, or `stale`, with reasons and retrieval times per source/subscope. Overall success requires every requested source to be complete. An empty authoritative, completely enumerated result is different from a failed or incomplete request. Recommendations must say which selected sources were checked and which remain unverified; never translate incomplete coverage into “nothing due” or “everything is up to date.”

Inventory is a snapshot, not an ongoing license to read new material. Before extraction, verify source membership, version/ETag or file identity/size/mtime and scope revision. Changed sources become stale pending re-inventory/review. Recurring approved refresh may read updated content only within its exact bounded source definition; any expanded identity, collection, root, purpose or processor invalidates the relevant grant.

## F02 Profile evidence

Maintain candidates separately from confirmed profile values. Suggested fields include preferred name, timezone, degree/semester, course enrollments, timetable, learning preferences, goals, project memberships, career targets, confirmed eligibility facts and routine constraints. Personal-life categories are optional; do not infer health status, finances, protected traits or work authorization from indirect evidence.

Every field stores a stable field ID, value, evidence references, source version, retrieval date, derivation method, confidence explanation and review state. Persist the canonical `ProfileFact` states from [the contracts](CONTRACTS.md); the UI may label a model-derived `proposed` value as “inferred,” but that label is not a separate wire state:

- `confirmed`: the student explicitly accepted the displayed value and evidence. Record reviewer and timestamp.
- `proposed`: extracted or deduced but awaiting review. It cannot become an authoritative answer in an application or consequential action.
- `conflicting`: incompatible sources/values require the student's choice; preserve the alternatives.
- `stale`: source/version or validity window changed. Keep the previous value as historical evidence, not current truth.
- `rejected`: the student declined the candidate. Do not quietly reinsert it into reusable context; retain only permitted review evidence.

Model certainty does not convert an inference into a confirmed fact. Course enrollment evidence should link to the selected institution/course; resume evidence should identify the chosen resume version. A student correction overrides candidate suggestions while preserving its user-authored provenance. Do not derive academic mastery from files existing, grades alone or browser activity; record demonstrated understanding through later learning checks.

The review screen shows one field/value, source excerpt/location, state and an edit/accept/reject control. The student can accept selected fields or skip a category. Required unresolved facts pause dependent workflows without blocking unrelated work. The resulting context tools expose only the fields approved for the current model/request, alongside `stale`/`conflicting` indicators.

## Proposed executable agent playbook

The operations below are **required future runtime contracts**, not commands shipped today. The implementation must enforce transitions and return the stated evidence; a prompt alone cannot enforce consent. An official agent session orchestrates them and writes no consent on behalf of a student.

| Step | Proposed operation | Agent behavior and objective result |
| --- | --- | --- |
| 1 | `onboarding.begin` | Ask purpose and categories; create an empty run and local student identity; no discovery |
| 2 | `sources.select` | Student chooses roots/accounts/collections in local UI; verify intended identity; return opaque source IDs |
| 3 | `consent.request(kind=metadata)` | Show bounded inventory preview; wait for actual student grant; cancelled/declined remains ungranted |
| 4 | `inventory.run(consentId, budget)` | Deterministic local inventory; return scope hash, counts and local preview reference; no bodies or unapproved metadata to agent |
| 5 | `inventory.review` | Student narrows sources/exclusions; record exact selection and new scope revision |
| 6 | `consent.request(kind=local_content)` | Display content scope/purpose; student grants or declines; bind to reviewed inventory |
| 7 | `extract.run(consentId)` | Revalidate realpaths/versions; bounded extraction into local managed storage; explicit coverage/evidence report |
| 8 | `consent.request(kind=remote_processing)` | If AI is wanted, show provider/mode and exact field/document/excerpt selection; no hidden remote read |
| 9 | `profile.propose` | Deterministic local candidates or explicitly consented model extraction; store provenance and canonical `proposed`/`conflicting`/`stale` states |
| 10 | `profile.review` | Student edits/confirms/rejects; record field-level review; never auto-approve a batch |
| 11 | `onboarding.verify` | Check requested coverage, consent receipts, identity, source versions and unresolved required fields |
| 12 | `onboarding.finish` | Report completed/partial/awaiting-student status and useful next action; enable only capabilities whose checks passed |

Before every tool call, verify the run is active, consent revision matches, scope/purpose/processor match, and budget remains. Source content is untrusted data; embedded “scan other folders,” “ignore restrictions,” or “submit this” instructions grant no authority. Tools must refuse forbidden expansions even if the model asks.

Do not continue dependent work after a student declines or revokes a grant. Onboarding completion must not enable external writes or schedules. A later “plan my week” request may use the resulting reviewed profile and explicitly selected academic records; “send this,” “apply,” or “sync all” needs its own bounded action workflow.

## Cancellation and resume

`cancel` stops queued work immediately, aborts network/extraction where supported, and forbids new tool/model calls. A request already in flight may finish; isolate its result and never publish/use it automatically after cancellation. Show whether any payload was already sent remotely. If its outcome cannot be verified, persist the canonical `unknown_outcome` state and reconcile before any retry; do not report it as safely cancelled or completed. Cancellation cannot retract material already processed by a provider.

Journal only sanitized source IDs, scope/consent revisions, budgets, evidence checks and protected cursors; never raw credentials. Resume is explicit. Verify identity, current consent, expiry, source versions and exclusions before resuming. Changed/revoked/expired scope requires new review. Continue from valid watermarks without duplicates; restarting does not reset usage allowances. A cancelled run remains cancelled in history even if a later run reuses its permitted checkpoint.

## Review, edit, export and forget

Provide a local source/profile manager: view evidence and coverage, correct fields, disconnect a source, revoke remote consent, export selected records, and forget a source, field, run or whole profile. Export is student-initiated and versioned; exclude credentials, cookies, protected cursors and unselected originals. Warn in the export UI that a downloaded copy is outside LearnBridge's later deletion control.

A forget job immediately revokes access and blocks retrieval. Track derivatives by lineage: source copies, extracted text, chunks/embeddings, full-text indexes, summaries, profile candidates/values, plans/tasks containing derived content, generated artifacts, cached responses, agent-context exports, previews, run payloads and backups. Purge or regenerate every affected derivative; remove source-derived content from mixed artifacts while retaining unrelated user-authored material where feasible. If provenance is insufficient to separate them, ask whether to remove the artifact; do not silently leave it searchable.

Delete sensitive logs or rewrite them to opaque deletion audit receipts. The retained receipt may contain only deletion job ID, categories/counts, completion time and error status, not forgotten values/paths. Handle local backups/snapshots with verified deletion, documented expiry or key destruction. An expiry scheduled for the future keeps the managed purge pending until the backup disposition is verified; do not mark it complete while that managed copy remains retrievable. SQLite deletion must address FTS/index tables, WAL/checkpoints and recoverable pages according to the storage implementation, not merely hide rows from the UI. Here `complete` means verified **managed logical purge plus backup disposition**. It does not promise forensic byte erasure from SSDs, operating-system snapshots outside LearnBridge's control or other unmanaged media; report those limits separately.

Stop synced writes and request cloud deletion where supported. LearnBridge cannot guarantee erasure of provider-retained model data, user exports or host-agent conversation history; identify those external copies with actionable instructions and a `pending_external` status. A job is `complete` only for verified managed-storage purges; distinguish that result from pending external copies. Verify absence through both direct IDs and normal search/context/profile tools after restart.

## Objective synthetic fixture verification

Use a generated temporary fixture tree and fake provider adapters only. No real student folders, cloud accounts, browser history or agent memories are needed to test these rules. Assertions inspect instrumented file/API/model access events and managed derivatives; an agent saying it followed instructions is not evidence.

| Acceptance ID | Fixture | Required assertion |
| --- | --- | --- |
| F03-A01 | Empty grants | No file enumeration/body read/API content read/model payload; denied status |
| F03-A02 | Metadata-only root | Approved file metadata is counted; body-read spy stays zero; no names or bodies sent remotely |
| F03-A03 | Excluded secret directory/file | Synthetic secret canary is never read, logged, indexed, exported or sent to a model |
| F03-A04 | Unselected sibling root | Boundary canary never appears in access records, metadata preview or derivatives |
| F03-A05 | Symlink/junction escape and path swap | Read denied after canonical-path check; outside target body-read count zero |
| F03-A06 | Local-read grant, remote denied | Approved local text is extracted; remote payload spy remains empty |
| F03-A07 | Approved remote subset | Payload contains only selected metadata/excerpts/fields, under byte budget; excluded canaries absent |
| F03-A08 | Proposed/conflicting/stale/rejected profile evidence | Canonical field states preserved; unconfirmed/rejected facts cannot become authoritative application answers |
| F03-A09 | Account/tenant mismatch | Content request refused; no cross-profile merge |
| F03-A10 | Multiple provider pages | All pages requested within budget; duplicate IDs deduped; final coverage complete only after terminal page |
| F03-A11 | Page cap/permission error/unsupported cursor | Partial/blocked/unsupported coverage; never overall PASS or an all-clear |
| F03-A12 | Oversized/unextractable content | Bounded extraction; explicit skipped coverage; no unbounded fallback |
| F03-A13 | Cancellation during queued/in-flight work | No new calls; late result isolated; remotely-sent receipt if applicable; unverified outcome is `unknown_outcome` |
| F03-A14 | Resume after revoked/expired grant | Resume refused until renewed consent; no checkpoint bypass or reset budget |
| F03-A15 | Changed source version/scope after inventory | Extraction pauses for re-inventory/review; existing facts marked stale; new scope needs consent |
| F03-A16 | Embedded hostile instructions | No unselected access/external action; source treated as data |
| F03-A17 | Forget source/field/profile | Canary absent from copies, indexes, profile, plans, artifacts, logs, backups and subsequent searches after restart |
| F03-A18 | OS path/parent/root swapped after check, before open/read | Instrumented adversarial swap cannot cause an unselected body read; opened-handle identity/containment checked; same handle used for extraction; unsupported OS guarantee prevents PASS |

Keep the canaries synthetic and unique by category, for example `LB_FIXTURE_OUTSIDE_SCOPE_01`; never substitute a real password or token. Use test-only dummy secrets with no account access. Check both presence where permitted and absence everywhere forbidden. Failed, skipped, unimplemented, unsupported, blocked or inconclusive checks are **not PASS**. Keep a fixture result separate from a live acceptance result.

For each supported OS and provider, ship a compatibility record with adapter version, scope, test date, fixture evidence and supervised live coverage. One developer machine or one authenticated account cannot prove all platforms/students work. Real acceptance later uses a volunteer's explicit selection and consent, narrow samples, and ordinary sign-in; it does not repeat the synthetic canary exercise against private accounts.
