# Codex app-server adapter: bounded protocol implementation

Checked October 3, 2026. This is an implementation spike and fixture proof. **A live embedded model turn has not been verified by this slice.** The existing official-host MCP verification remains separate evidence.

Root subsequently ran one authorized initialization attempt using the actual pinned official binary, an empty disposable project/storage selection and a synthetic grant. It returned **`SCOPE_DENIED`** under the effective-configuration gate. No raw configuration was logged and no thread/model turn was started. Embedded mode therefore remains unavailable on the current installation; 21 passing protocol fixtures establish behavior at the boundary, not compatibility or entitlement on that actual configuration. No permissive fallback is implemented.

## Scope and official source

The adapter uses the official local app-server stdio protocol. Its handshake precedes thread and turn requests; native turn status determines whether generation finished. Native thread identifiers support continuation, and native server requests remain scoped to the pending thread/turn. Authentication stays with the installed official host. See [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

This mode is distinct from a third-party Sign in with ChatGPT token-sharing integration. It does not provision an API key, accept an OAuth/access token, read credential files, launch a custom subscription login, or switch authentication providers after failure. The official host can use its normal managed authentication location; the application does not copy that location or its contents.

## Implemented code and API

Implementation: [`codex-adapter.mjs`](../../../web/apps/local-runtime/src/codex-adapter.mjs). Transport verification: [`local-codex-adapter.test.mjs`](../../../web/scripts/local-codex-adapter.test.mjs).

```js
const adapter = createCodexAdapter({
  projectRoot,                 // trusted local launch selection, not HTTP input
  dataRoot,                    // existing owned LearnBridge storage root
  grantId,                     // exact Codex processing grant
  model,                       // optional explicit identifier; no automatic fallback
  authorize,                   // synchronous current-policy check; must return true
  onEvent,                     // authenticated local event consumer
  onApproval,                  // optional human display; reject/cancel only
  persistSessions: false,      // default: ephemeral native thread
});
await adapter.initialize();
const thread = await adapter.startThread();
const turn = await adapter.startTurn({ prompt, context });
const outcome = await turn.completion;
await adapter.close();
```

The adapter exposes only initialization, sanitized capabilities, typed start/resume/turn/interrupt, event collection, exact pending native review rejection and close. It has no public raw JSON-RPC, shell, process, filesystem, configuration-write, account-login/logout, token-refresh, app-install or account-management methods. Binary/factory/protocol-probe overrides are trusted library-only testing/deployment seams; they must never be selected by HTTP/MCP request data. No dependency was added.

`authorize({phase,grant_id,thread_id,turn_id,scope_hash,host_history})` must check the actual current local student, selected source/processing grant, pinned versions, model destination, cancellation, input scope and session authority. It is checked before launch/turn and after asynchronous replies, before every emitted result, on final output, and before cached event/review retrieval. A source-grant-shaped object supplied by a model does not satisfy this boundary. The runtime must assemble and charge selected context itself; it must not accept arbitrary request-body `context` as selected source evidence.

`startTurn` returns `{thread_id,turn_id,completion,interrupt}`. Completion returns native and normalized status, authoritative or incomplete text, sanitized MCP result hashes/receipts, stable error envelope and native checkpoint. Native `completed` means generation finished; it is not proof that a proposed task was approved, a document was saved or a provider effect was verified. The durable workflow verifier owns those outcomes.

`resumeThread({thread_id,scope_hash,persisted:true})` requires the same grant/project binding and `persistSessions:true`. The caller must retrieve that checkpoint from its own installation/run journal and revalidate its source grants. It must never use an arbitrary caller-supplied native thread ID to browse or resume other host conversations. Default ephemeral sessions intentionally cannot be resumed across process loss. Persisted sessions store conversation history with the official host; that retention must be disclosed and approved as part of the selected mode.

## Version and schema proof

Installed CLI: **`codex-cli 0.154.0`**. Its local help confirms stdio app-server and public JSON-schema generation. `app-server --ignore-user-config` is **not supported** by this installed version; the separate `exec` command's flag cannot be assumed to work here.

`probeCodexProtocol()` runs only `--version` and public schema generation into a fresh temporary folder, validates the selected byte-level SHA-256 pins, and removes the folder. Exact versions or schema digests outside the reviewed pin fail with `VERSION_MISMATCH`. No account read, model request, source acquisition or MCP call occurs during this probe.

| Generated public schema | SHA-256 |
| --- | --- |
| `v1/InitializeParams.json` | `6f0094be9a65242ec779a40794cbd4fdfa32fca1e45084a16adfb50501d33ea2` |
| `v1/InitializeResponse.json` | `62ad689c2cb6379913c1d72749cfd8de5089d35760214123518eb92eef11acc9` |
| `v2/ThreadStartParams.json` | `792e2f32e37cece971bd616664ea2053741acbed4e9c92e9d1766427718f2ecd` |
| `v2/ThreadResumeParams.json` | `36b2854eb802559e17b0e5639385a1e39d5279326c50e2cdb836749b6dd7cb6f` |
| `v2/TurnStartParams.json` | `a3835e8c1e942e4b358e1a670939b89918b16c4d13105a579899892b7ade6dea` |
| `v2/TurnInterruptParams.json` | `6dff382dae73d1dbc58406ed045605f647e7a49660e2540fbd2c6c24d60c5f2b` |
| `v2/AgentMessageDeltaNotification.json` | `996e6c0ea65e57bed5a00f410b94381fe5ebf804333e5d00c2b6e6d47e5c55f6` |
| `v2/TurnCompletedNotification.json` | `78af2a37391e8e669a4020cb58593e4d3e378756ced79d5fec72374fa69fb94b` |
| `v2/ConfigReadParams.json` | `257c54a423b47c1d209ff1076765a1564d82322fd5161670fd489a2874de1bac` |
| `v2/ConfigReadResponse.json` | `bd72c94e2c7d49ead6a20bcf54afedc8db11044bf8cadb387e42135dd5d1e342` |
| `v2/GetAccountResponse.json` | `08a7dd8c570c905b0bb6998d43ed133e72e2445f08125f86dfc96887e288701a` |
| `v2/ListMcpServerStatusResponse.json` | `b70fe28f68e82f9716bfdf534c8339c00318e875e15bb30e7f153c5adbbcf962` |
| `ServerRequest.json` | `f339be472737a0003efa25fba2e6e6c9237e621cd065b6d6995c51256e9dc1fb` |

The actual installed binary passed every selected schema digest on October 3. Proof returned `protocol_verified:true`, `model_turn_executed:false`, `entitlement_verified:false`. A schema or model catalogue does not establish that the user's account can use any model. No model recommendations, entitlement claims or free-usage guarantees follow from this probe.

## Process and tool boundary

The launch uses stdio, an immutable configured command and a sanitized environment. It preserves normal `HOME`/`CODEX_HOME` authentication discovery and basic locale/temporary-directory values without reading them. It removes inherited API keys/tokens, Node injection, proxy variables and shell initialization. It disables shell, shell snapshots, memories, plugins, hooks, agents, apps, web search and analytics through fixed native overrides. It supplies the fixed LearnBridge MCP launcher with only `learnbridge_status`, `learnbridge_context`, `learnbridge_propose_task` and `learnbridge_propose_document`.

Before account read and any thread start/resume, and again before every turn, private `config/read({includeLayers:false,cwd:project})` verifies effective launch overrides. The response stays inside the closure and is never emitted, logged or persisted. It requires exact selected MCP command/arguments/tools, false feature switches, disabled apps/agents, no instructions/notify/hooks/provider overrides, disabled search, zero project-document discovery, read-only sandbox and user approval. Unknown nonempty configuration keys or missing session overrides leave the adapter unavailable. This conservative check may reject a normal host configuration; it must not be weakened without a new reviewed proof.

Thread/turn requests fix native `read-only` sandbox, network access false, `on-request` approval and user reviewer. Returned effective policy/provider/cwd are checked. The actual MCP catalogue must contain exactly that one server and those four tools, with no resources/resource templates, before every turn. Additional inherited host MCPs, changed catalogues, discovery errors or widened returned policy fail closed. Every observed MCP call checks server/tool identity and the selected grant ID; native command/file/unknown items fail closed. The model can propose a task or a bounded document alternative through existing MCP review paths. Document proposals require the exact selected source document/revision/hash, purpose and academic policy, with a 10 KB UTF-8 draft bound. It cannot accept its own proposal or save an accepted artifact.

**This is not yet proof that all installed host configuration is isolated.** The missing ignore-user-config flag makes actual override/catalog behavior a required live gate. The normal native read-only sandbox is not a full filesystem-read confinement guarantee. Native built-in tool exposure, plugin/config interactions, account-provider behavior and process restrictions must be checked on the pinned actual host before releasing this embedded mode. Observing and rejecting a forbidden item is a second guard, not evidence that an already dispatched third-party read could be recalled. If the fixed policy cannot be established, leave this mode unavailable and retain the already verified external official-host MCP workflow.

## Streaming, approval and recovery

The pinned delta schema has no native sequence number or byte offset. Two identical delta strings may be legitimate repeated text. The adapter therefore labels deltas provisional and reconciles them with authoritative completed-message/turn content. It deduplicates completed item IDs, rejects conflicting replays, assigns its own ordered receipt sequence and suppresses events for other native threads/turns. Notifications received before the turn-start reply are bounded and buffered until their exact native turn ID can be checked. This does not claim that arbitrary native duplicate deltas can be distinguished perfectly.

Native command/file/permission/MCP elicitation requests default to decline, empty permissions or cancel. Optional human handling sees the exact pending request fingerprint and its thread/turn; only `reject` and `cancel` are supported. Accepting commands/files, granting session policies and model-supplied self-approval are deliberately unsupported in this slice. A changed/replayed/expired pending request cannot use the old decision. Unknown requests, including external-auth token-refresh requests, receive a stable unsupported response and end the adapter rather than prompting for secrets.

Interrupt uses the native turn ID. Incomplete, interrupted, provider-failed and process-lost outcomes remain distinct. A start request without a response or a process loss during work is `unknown_outcome`; there is no blind retry, second process fallback or automatic new turn. Root orchestration must persist input hash/native checkpoint before issuing another request and reconcile uncertain starts before deciding whether continuation is safe. No claim of exactly one provider turn is made across an uncertain transport failure.

Limits default to 3 turns, 64 KB cumulative human/context input, 256 KB raw host output, 2,000 normalized events, 20 distinct observed MCP calls and 2 minutes from initialization. Individual prompt/context limits are 16 KB/48 KB. Request timeout is 10 seconds; human review defaults to decline after 15 seconds; an unacknowledged interruption ends as unknown after a 1-second grace. Stderr is bounded and discarded. Raw provider messages, account email, auth locations, unrelated host paths and native commands are not returned or logged. Closing terminates the owned process group and escalates only that group after a bounded grace; no unrelated processes are signalled.

## Verification and release gates

Run `node --test web/scripts/local-codex-adapter.test.mjs`.

**21/21 tests pass** against actual disposable Node child processes with stdin/stdout JSON-RPC. They prove handshake, authoritative final text, repeated item/delta behavior, filtered environment and narrow API, normal-auth mode rejection/no API fallback, extra MCP/widened sandbox/catalog changes, interrupt, default/human exact rejection, unknown token requests/forbidden tools/wrong grants, process loss/start timeout without retry, grant revocation and cached-output denial, foreign thread/turn exclusion, cumulative/concurrent limits, output flood, checkpoint binding/ephemeral restrictions, sanitized errors and version mismatch. Added cases reject inherited hook/notify/instruction-file/provider/extra-MCP configuration before any thread start, reject effective-policy changes before a turn, and prove an acknowledged cancellation clears its grace timer so later continuation is not killed. The fourth-tool fixture proves only a bounded source-bound unreviewed document proposal is normalized; wrong source identifiers and oversized drafts fail closed. The children contain no real account/model/browser/network calls.

Required before an available embedded-mode claim:

1. Root reviews this boundary and creates only a disposable synthetic project/source/grant.
2. Actual initialization establishes normal ChatGPT-managed authentication; print only sanitized mode/state, never account email, home or raw diagnostics.
3. Confirm `config/read` includes launch session overrides and establishes the effective MCP/tool/policy/provider boundary on the actual pinned host, with no inherited private app/tool invocation.
4. Run one authorized synthetic note/context/proposal turn and independently verify its exact outputs through LearnBridge's local storage. No task exists until human review.
5. Interrupt a real synthetic turn; prove no subsequent calls and explicit incomplete outcome.
6. If persisted native continuation is released, separately authorize native host history, restart, resume only the recorded bound checkpoint and prove exactly one intended continuation with current grants.
7. Wire human-session enforcement, durable budgets/checkpoints, result verification, UI provisional/final distinction and surfaced unavailable/auth/limit states through the runtime. Passing this library fixture does not substitute for that end-to-end gate.

Claude remains a separately supported external MCP-host path and needs its own native adapter/live proof. This spike does not implement Claude subscription authentication, arbitrary remote browser access, or the phone relay.

Official app-server documentation states that app-server authentication is for local/open-source applications and has never been permitted for commercial or hosted services. LearnBridge must keep this subscription-managed adapter on the student’s own local runtime; the public hosted app needs its separately configured API route or an authorized local relay. See the same [official app-server source](https://learn.chatgpt.com/docs/app-server).
