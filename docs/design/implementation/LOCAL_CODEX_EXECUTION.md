# Embedded local Codex execution

LearnBridge's local dashboard can run an actual tutor request using the student's official ChatGPT-managed Codex account. This runs on that student's computer, separately from the hosted API tutor. It is not an API-key fallback, a copied desktop token, or a hosted subscription proxy. Claude remains supported through the external four-tool MCP bridge; embedded Claude execution is not implemented.

## Student flow

1. Install the official Codex CLI **0.154.0**. The adapter checks the exact version and generated stable protocol schemas. A different version is refused until its contract is reviewed.
2. Start and pair the local dashboard. Open **Local AI**, choose **Sign in with ChatGPT**, and follow the official link if sign-in is needed. Finish normal account login yourself. Choose **Check sign-in** afterward.
3. Save a synthetic note first. In **Agent & review**, select that note, choose Codex, and review the expiry and cumulative UTF-8 byte budget. No source is selected by default.
4. Enter a question in **Ask your local Codex host**, select the reviewed grant and confirm the exact request. Your question and approved context reach OpenAI under your account settings and limits.
5. Read the answer, citations and tool receipts. Requested task suggestions remain in the task review queue. Requested document alternatives appear in **Writing**, with the original unchanged. Review and accept/reject their exact content separately.
6. **Stop this request**, grant revocation, browser disconnect, sign-out or a changed selected source withholds further authorized work. Uncertain requests are never replayed automatically. Check review queues for an acknowledged proposal if a later step failed.

The host status distinguishes sign-in from an actual completed model turn. `model_entitlement_verified` becomes true only after a completed request in the current controller session. Normal account rate limits, entitlement failures and unsupported versions remain explicit errors.

## Isolation and authority

The native CLI owns login, refresh and logout inside a separate 0700 LearnBridge profile beside the workspace. LearnBridge validates its own student marker, but never reads `auth.json`, copies an existing Codex profile or writes credentials to its database, backups, Git or HTTP results. Official login URLs exist only in the paired browser/controller, not audit logs. An empty temporary project prevents inherited repository instructions or host skill discovery. Temporary native logs/state are removed when its process closes.

The child uses a sanitized environment, read-only native sandbox, normal approval handling, and fixed disabled shell, apps, plugins, hooks, browser, computer, code-mode, memories and agent features. Effective configuration and the exact four-tool catalogue are checked repeatedly. Unknown active configuration authority is refused. There is no general RPC, executable, model-provider, command or tool setting accepted from HTTP.

Each embedded MCP process is bound to **one grant ID**. An ephemeral runtime lease also binds it to the current browser/phone authorizer. The broker validates that lease before reading context or saving a proposal. Leases are neither persisted nor exposed through HTTP; logout invalidates the session before awaiting cleanup. External project MCP registration keeps its existing destination-specific, explicitly selected grant behavior.

## Executed tool and model contract

The runtime first calls `learnbridge_status` and `learnbridge_context` through stable `mcpServer/tool/call`. These are actual MCP calls with JSON result hashes, not receipts invented from the model's answer. Only the reviewed, pinned context is prepared for the model.

The native model returns a strict output schema: an answer, at most three task suggestions, and at most one source-pinned document alternative. This stable path is used because current native models may defer MCP schemas in a restricted session. It does not enable experimental dynamic tools or code execution. Tool progress clearly describes runtime MCP execution; it does not claim the native model independently issued each RPC.

Before the first proposal write, every item is validated for exact fields, text bounds, control characters, source membership/revision/hash and the strongest source/request academic policy. Graded sources permit only conceptual outlines and study guides. A model-selected weaker policy cannot override the source. After authoritative model completion, approved bounded suggestions are submitted through `learnbridge_propose_task` or `learnbridge_propose_document`. Those tools create only pending local proposals. No emails, applications, external files or calendar events are sent or edited.

Each call rechecks authority. A dropped acknowledgment has `unknown_outcome`; the controller never silently retries it. Acknowledged proposal receipts survive a later failure while authorized, so the student can inspect the review queue. Revoked context hides retained answer/receipt content from the turn view; it cannot recall material already processed by the host.

The native protocol stream is bounded at 1 MB, including repeated full configuration and tool-schema responses. This is distinct from selected-context budgets (at most 32 KB per prepared read), model answers (16 KB), document drafts (10 KB), tool results (48 KB), event/call counts and request/time bounds. Real combined task/document verification found that the former 256 KB envelope could expire during a configuration recheck before any write; no action was saved by that failed attempt.

## Objective verification

Run the adapter, profile, independent proposal-review, host-turn and embedded-MCP suites. They exercise strict real child-process protocol parsing, actual SQLite state, paired HTTP, wrong-grant and stale-lease refusal, late logout/check races, invalid later proposals, source edits, cancellation and cleanup. Synthetic native adapters are explicitly labelled; those tests do not prove account entitlement or model quality.

For a live student check, use one synthetic note and a new short grant. Complete official sign-in, ask a source-specific question and one pending task, then request a pending conceptual outline. Read back completed stable MCP receipts for all four tools, the actual cited answer, zero accepted tasks, the original note's unchanged revision/hash, and the unaccepted Writing draft. Restart/pair again and inspect those saved records. Test revocation separately. Never use private course content as an installation fixture.

On October 4, 2026, this Mac completed real official sign-in and tutor/task/document turns using synthetic recursion text. All four tools have live RPC proof. The later authority changes are additionally regression-tested and must be included in the final source-bound verification receipt. This is evidence for this pinned host/account, not every subscription or platform.

Official protocol and authentication references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth).
