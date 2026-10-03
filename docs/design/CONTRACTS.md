# LearnBridge data and execution contracts

These are target version 1 contracts for implementers. They are not currently exposed endpoints or installed tools. Implement shared schemas first, then local repositories, policy checks and adapter contract tests. UI and agent outputs must use the same validated types. Example records use synthetic student data.

## Shared conventions

- Local IDs are random UUIDs. Provider identities use `(connector_id, account_ref, object_type, external_id)` with a unique index; URLs alone are not stable identity.
- Store instants as UTC ISO 8601. Preserve source timezone, original timestamp, date-only values and ambiguity. A date-only deadline has `precision: date` and no invented midnight instant. Use IANA timezones; reject invalid calendar dates and unresolved daylight-saving times.
- Mutable records have monotonic `revision`, `created_at`, `updated_at`, `deleted_at`. Update using expected revision; conflict returns 409 with current metadata, not a silent overwrite.
- Use `schema_version` and explicit migrations. Never infer a schema from arbitrary imported JSON. Validate sizes, enum values, paths and ownership before persistence.
- Human review and inference are distinct. `proposed` is not `confirmed`; a confidence score is not permission or proof.
- Cursor APIs return `items`, `next_cursor`, `coverage` and `retrieved_at`. A cursor is source/query-bound and opaque; paginated reads have budgets and cancellation.
- Private logs record references/hashes/status, not raw tokens, document content or personal payloads. Diagnostic exports are redacted before display and again before sharing.

## Entity register

Fields below are the contract vocabulary, with presence dependent on state/capability. Unknown values stay null/absent rather than fabricated. Proposed/conflicting/rejected ProfileFact has no confirmation receipt; conflicting facts store alternative values/evidence. Only confirmed facts require `confirmed_by`/`confirmed_at`. ReviewReceipt always has decision/reviewer/fingerprint/decision time; `approved_at` applies only to approval. SourceObject can be metadata-only with no `content_ref`; retrieval checks that content exists and is permitted. Provider IDs, deadlines, weights, hashes and verification values remain unavailable until observed. Implement these as discriminated schemas, not one object requiring invented placeholders.

| Entity | Required fields beyond shared metadata | Relationships and invariants |
| --- | --- | --- |
| Installation | `student_id`, `platform`, `data_root_ref`, `edition`, `timezone`, `setup_version` | Local student ID cannot be supplied to hosted APIs as authentication |
| SourceGrant | `principal_ref`, `source_ref`, `scope`, `operations`, `processing`, `retention`, `expires_at`, `review_receipt` | Independent read and model-processing permission; deny when inactive/revoked |
| Source | `connector_id`, `account_ref`, `kind`, `display_label`, `canonical_ref`, `coverage`, `last_success_at`, `health` | Account identity must be verified; label is not authoritative identity |
| SourceObject | `source_id`, `external_id`, `object_type`, `version_hash`, `retrieved_at`, `locator`, `grant_id`, `content_ref` | Unique provider key; cannot survive grant purge as searchable content |
| SourceVersion | `object_id`, `version_hash`, `content_ref`, `source_revision`, `retrieved_at`, `parser_version` | Immutable retained version; citations reference version ID, not mutable current object |
| Chunk | `object_id`, `version_hash`, `range`, `text_ref`, `parser_version`, `mime_type` | Page/slide/line provenance; index only approved active objects |
| ProfileFact | `field`, `value`, `state`, `sensitivity`, `evidence_refs`, `confirmed_by`, `confirmed_at`, `stale_after` | Identity/eligibility assertions require confirmation; conflict retained |
| WorkflowPreference | `name`, `constraints`, `source_refs`, `state`, `effective_at` | Inferred habits are proposed; never used as evidence of skill/mastery |
| Course | `source_id`, `external_id`, `title`, `term`, `institution_ref`, `active` | Course membership from enrollment or student confirmation |
| AcademicItem | `course_id`, `kind`, `external_id`, `title`, `deadline`, `source_ref`, `source_status` | Assignment/exam/announcement/feedback links retained; unavailable deadline explicit |
| Task | `title`, `status`, `source_refs`, `course_id?`, `deadline?`, `effort_minutes?`, `parent_id?`, `dependency_ids`, `recurrence?`, `origin`, `student_overrides` | No cycles, effort nonnegative, source updates preserve student edits |
| StudyPlan | `course_ids`, `availability_snapshot`, `task_allocations`, `unscheduled_work`, `pinned_blocks`, `source_refs`, `state` | Source deadline, student target date and scheduled work time remain separate |
| Topic | `course_id`, `title`, `prerequisite_ids`, `source_refs`, `weight?` | Prerequisite graph validated; weight unknown unless sourced/confirmed |
| LearningSession | `topic_id`, `mode`, `policy`, `attempt_refs`, `provider_session_ref`, `state` | Tutor conversation is not evidence of demonstrated mastery by itself |
| LearningCheckpoint | `session_id`, `question`, `student_attempt`, `feedback`, `assessment`, `source_refs`, `review_state` | Preserve actual attempt and observed result, not inferred competence |
| CalendarEvent | `provider_key?`, `calendar_ref`, `title`, `start`, `end`, `timezone`, `all_day`, `revision_ref`, `origin` | Start before end; all-day date semantics; unknown external state distinct |
| Document | `title`, `kind`, `course_id?`, `current_revision`, `source_refs`, `content_ref`, `academic_policy` | Multiple docs; revisions append-only; edit proposals bind base hash |
| DocumentRevision | `document_id`, `revision`, `content_ref`, `sha256`, `author`, `change_reason` | Immutable text/editor state; original and reviewed diff retained |
| EditProposal | `document_id`, `base_revision`, `base_hash`, `patch`, `reasons`, `state` | UTF-16 text offsets mapped to editor document positions before applying |
| RubricEvidence | `document_id`, `revision`, `criterion`, `source_ref`, `matched_ranges`, `state` | Coverage proposal not an authoritative grade; missing evidence explicit |
| Artifact | `format`, `file_ref`, `sha256`, `size`, `generator_version`, `source_refs`, `verification` | Exists inside allowed output root; rendered/exported verification separate |
| JobPosting | `company`, `role`, `official_url`, `external_id?`, `location`, `eligibility`, `discovered_at`, `last_verified_at`, `status`, `evidence_refs` | Exact role identity/dedup; date/eligibility unknown remains unknown |
| Application | `posting_id`, `profile_revision`, `answers`, `attachments`, `unresolved_fields`, `action_id?`, `status`, `evidence_refs` | `submitted` requires external confirmation; draft is not submitted |
| Run | `recipe_id`, `recipe_version`, `student_id`, `state`, `grants`, `capabilities`, `budget`, `checkpoint`, `error`, `evidence_refs` | Required gates validated before run; finished outcome explicit |
| ActionProposal | `run_id`, `operation`, `account_ref`, `target`, `payload_ref`, `payload_hash`, `preconditions`, `idempotency_key`, `expires_at` | Any relevant change invalidates review; exact payload retrievable for human |
| ReviewReceipt | `action_id`, `fingerprint`, `reviewer`, `decision`, `decided_at`, `approved_at?`, `expires_at`, `authorization_source` | Runtime verifies human session/host approval, never trusts model-supplied reviewer |
| VerificationResult | `test_id`, `feature_id`, `status`, `edition`, `platform`, `input_fixture_hash`, `observed`, `assertions`, `evidence`, `limitations` | Observation and assertion separated; mock/live/human type mandatory |
| Schedule | `recipe_id`, `source_scope`, `timezone`, `next_run`, `missed_policy`, `notification_policy`, `lease`, `last_outcome` | No duplicate run per schedule/time slot; read permission bounded |

M1 implements only Installation, SourceGrant, Source, Task, Document, Run, ActionProposal, ReviewReceipt and VerificationResult plus schema migration support. Add other tables when their feature reaches implementation. Avoid an initial giant migration filled with unused speculative fields; this register defines interoperability, not an obligation to build all tables at once.

## Provenance and profile states

Evidence references contain `object_id`, source URL/path reference, source version, range and retrieval time. Local path labels shown to a cloud model must themselves be covered by processing permission. Profile fact states are `proposed`, `confirmed`, `conflicting`, `stale`, `rejected`. Proposed values can appear in a review screen; confirmed values can enter reusable context according to sensitivity/source grants. Conflicting and stale facts cannot silently enter career/application payloads as current facts.

Deleting a source traverses derived-object references: chunks, FTS, caches, context packs, proposed/confirmed facts whose only evidence is that source, drafts/evidence and artifacts containing copied content. Student-authored facts can be retained only as an explicitly reviewed independent assertion. A deletion report enumerates retained student-authored derivatives and external copies; it does not promise deletion from an already used provider or already sent message.

## Connector interface

```ts
interface ConnectorV1 {
  manifest: IntegrationManifest;
  probe(ctx: ProbeContext): Promise<CapabilityReport>;
  authenticate(ctx: InteractiveAuthContext): Promise<AuthOutcome>;
  listSources(ctx: ScopedContext, cursor?: string): Promise<SourcePage>;
  read(ctx: ScopedContext, query: ValidatedReadQuery): Promise<ReadPage>;
  prepare?(ctx: ScopedContext, input: ValidatedAction): Promise<ActionProposal>;
  execute?(ctx: AuthorizedActionContext): Promise<ActionOutcome>;
  verify?(ctx: ScopedContext, outcome: ActionOutcome): Promise<VerificationResult>;
  disconnect(ctx: ScopedContext): Promise<DisconnectOutcome>;
}
```

Types above are interfaces to implement, not imports. `ScopedContext` is created by policy code and carries installation identity, account binding, active grants, execution surface, processing destination, cancellation and budget. Callers cannot construct a broader scope by setting an argument. MCP results consumed by a cloud-backed host must satisfy both source-read and destination-specific processing grants before serialization; locally permitted content is not automatically permitted model input. Private metadata and diagnostics follow the same rule. Runtime validates input and declared tool metadata again before dispatch. A read-only connector omits prepare/execute rather than faking support; capability checks narrow optional methods before calling them. Capability states: `available`, `requires_auth`, `requires_scope`, `unsupported`, `degraded`, `unknown`. Report version, account, tested operations and last live proof separately.

Error codes: `AUTH_REQUIRED`, `CONSENT_REQUIRED`, `SCOPE_DENIED`, `UNSUPPORTED`, `RATE_LIMITED`, `OFFLINE`, `VERSION_MISMATCH`, `REVISION_CONFLICT`, `BUDGET_EXCEEDED`, `CANCELLED`, `INVALID_INPUT`, `UNKNOWN_OUTCOME`, `PROVIDER_FAILURE`. Errors include redacted message, retryability, retry-after if known and next student action. Expired login never triggers password collection. Partial pages keep successful evidence and incomplete coverage.

## Integration manifest

Required fields: stable ID, version, upstream URL/pin/hash, distribution method, license/notices status, OS/runtime range, transport, allowed executable and fixed arguments, child environment allowlist, private directories, capability declarations, input/output schema versions, auth method, requested provider scopes, domains, setup instructions, fixture suite and live gates. Updating a pinned integration requires compatibility and permission diff review. A tool's name or description cannot declare itself harmless; reviewed operation metadata assigns read/write/send/submit/delete classes.

Executable paths resolve from the installed reviewed package and are checked against its manifest. No manifest accepts a free-form shell string. Plugins do not inherit the developer's full environment. Network domain declarations help routing and audit; enforcement needs an actual network sandbox/proxy where supported. A manifest alone does not confine network access or arbitrary executable code. Untrusted third-party code must remain disabled until installed under a supported host/process policy.

## Local tool catalogue

These are proposed narrow LearnBridge MCP tools. Implementation must publish JSON schemas, annotations and bounded outputs through the official MCP SDK. There is deliberately no arbitrary `run_shell`, full-disk `read_file` or model-accessible `approve_action`.

| Tool | Input | Output and checks |
| --- | --- | --- |
| `learnbridge.status` | optional capability names | Non-secret setup/health and active principal; private details authenticated |
| `learnbridge.sources.list` | grant-bound filters/cursor | Accessible sources and coverage; no hidden account/token dump |
| `learnbridge.context.search` | query, scope IDs, limit ≤ 20 | Cited chunks, versions and freshness; reject unauthorized scope |
| `learnbridge.context.read` | reference and bounded range | Exact excerpt permitted by grant; no raw arbitrary path |
| `learnbridge.profile.read` | field set, purpose | Allowed confirmed profile fields; private inferred facts kept in review |
| `learnbridge.profile.propose` | bounded facts plus evidence | Reviewable proposals only; cannot confirm identity automatically |
| `learnbridge.courses.refresh` | approved course/source IDs | Run ID, changed item references, coverage and failures |
| `learnbridge.today.get` | local date/timezone | Deterministic priorities/conflicts plus source references |
| `learnbridge.tasks.propose` | task candidates, evidence | Validated proposals with provenance; no unreviewed external writes |
| `learnbridge.tasks.apply` | accepted proposal IDs, expected revision | Allowed local mutation under active student policy; reject cycles/conflicts |
| `learnbridge.documents.read` | document/revision/range | Approved content with base revision/hash |
| `learnbridge.documents.propose_edit` | doc ID, base hash, patch | Previewable edit proposal; no blind full replacement |
| `learnbridge.artifacts.create` | recipe, approved inputs, format | Artifact job; verifier checks output before completion |
| `learnbridge.actions.propose` | operation, exact target/payload references | Proposal fingerprint and review link; returns no approval token |
| `learnbridge.actions.execute` | proposal ID | Runtime looks up valid receipt; tool cannot manufacture consent |
| `learnbridge.runs.get` | run ID | Sanitized step/state/evidence/next action |
| `learnbridge.runs.cancel` | run ID | Cooperative cancel plus eventual stopped/partial state |

Add feature-specific tools only after their schema, scope and verification contracts are reviewed. When using host tools outside these wrappers, the skill records their actual source and follows the host's permissions. Do not pretend host calls were executed by LearnBridge's broker.

## Local HTTP and event contract

Proposed runtime routes use `/api/local/v1`. `/health` reveals version/liveness only. Pairing exchange is single-use and rate-limited. Profile/source/task/document/run/action/private-artifact endpoints require a paired session and policy checks. POST/PUT/DELETE check Origin/CSRF and expected revisions. Browser reads can legitimately omit Origin and must follow architecture's Host, Fetch Metadata and session-bound nonce policy; absence of Origin is never authorization. Reads and event streams enforce authentication, source grants and execution-destination processing grants. Artifacts are served through authenticated references, not a public directory mount.

Events have `event_id`, `run_id`, `sequence`, `type`, `created_at`, `payload_ref`. UI resumes streams after sequence and deduplicates by ID. Payload is sanitized; raw personal inputs stay in authorized storage. Agent events normalize `started`, `text_delta`, `tool_proposed`, `tool_started`, `tool_completed`, `review_required`, `artifact_created`, `verification_completed`, `budget_warning`, `failed`, `interrupted`, `completed`. A text delta saying "done" does not change run state.

## Workflow state machine

```text
created -> validating -> ready -> running
created/validating/ready -> cancelled | failed
running -> awaiting_student | verifying | failed | cancelling | interrupted
awaiting_student -> running | cancelled | expired
verifying -> completed | partial | unknown_outcome | failed
cancelling -> cancelled | partial | unknown_outcome
unknown_outcome -> verifying | awaiting_student
failed/partial/interrupted -> ready (explicit resumable checkpoint)
```

Review decisions: `approved`, `rejected`, `needs_changes`, `expired`, `invalidated`. Action execution: `prepared`, `awaiting_review`, `authorized`, `executing`, `verified`, `failed`, `unknown_outcome`, `cancelled`. Provider disconnect/runtime crash checkpoints become `interrupted`; authentication expiry becomes `awaiting_student` with `AUTH_REQUIRED`. Connector read envelopes may use `needs_auth`, but that is not a Run state. Cancelling an already submitted provider request cannot guarantee rollback; record the external outcome and offer compensation only when supported/authorized.

Every recipe defines purpose, inputs, dependencies, grants, allowed tools, read/write classification, model-processing scope, step sequence, budgets, timeout, checkpoint structure, review points, success predicates, failure handling and evidence. See [synthetic workflow example](examples/workflow.example.json). The scheduler cannot broaden a recipe's source/action grants. Resume revalidates grant revisions, source versions and freshness before reusing saved steps; invalid inputs invalidate dependent checkpoints and require bounded refresh/review. Reconciliation from unknown outcome checks the external state before verification or student resolution, never blind execution.

## Action fingerprint and idempotency

Canonicalize the operation, provider/account, target ID, full payload hash, attachment hashes, base revisions and policy version into a deterministic SHA-256 fingerprint. Store exact reviewed values separately in private storage. Approval binds to the fingerprint and expires; revalidate relevant source revisions just before execution. A review UI renders the recipient, operation, all answers/changes and attachments, including unresolved fields. Live form prefill/upload is a data-transmission operation even before Submit because a site can autosave; authorize that bounded transmission separately from local drafting and final submission.

Use a transaction to reserve an idempotency key and lease the action. On a confirmed external receipt, save provider ID and verified state. If process crash/timeout occurs between provider success and local persistence, reconcile by provider idempotency/key/record search; do not retry blindly. In a provider without reliable dedup/read-back, mark unknown and pause. Local mutexes prevent concurrent duplicate attempts but cannot provide exactly-once behavior across an external service by themselves.

## Verification report

[Example](examples/verification-report.example.json) shows a synthetic format, not a real product pass. Required fields include suite version, source commit/tree digest, adapter/tool versions, environment/edition/OS, feature and test IDs, fixture hashes, assertion expected/actual values, status, evidence paths/hashes, observed external IDs where appropriate and unresolved blockers. Evidence must be restricted and sanitized; do not upload private screenshots automatically.

Statuses are PASS, FAIL, BLOCKED, SKIP and NOT_IMPLEMENTED. Required BLOCKED/SKIP/NOT_IMPLEMENTED gates prevent the corresponding release claim. A unit fixture can pass while the live provider gate remains BLOCKED. Human-reviewed quality evaluations have a named rubric/reviewer and cannot be replaced by the agent claiming its own output is correct.
