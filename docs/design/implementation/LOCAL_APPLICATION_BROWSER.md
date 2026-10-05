# Reviewed application browser

## Feature and boundaries

This local workflow opens a separate temporary Chrome window at one current selected official Greenhouse or Lever posting/application URL. It reads the visible top-level form, prepares a review of exact checked text values, and writes only those reviewed values into a local browser draft. The filled draft remains visible in the owned Chrome window; the local dashboard retains a durable preparation receipt and optional link to a task-agent session.

It does not submit an application, upload attachments, click any page button, solve CAPTCHA, log into employer accounts, enter passwords, answer protected disclosures, or change a LearnBridge task's status. File inputs, hidden controls, selects, checkboxes, disabled/read-only fields, unsupported controls, and fields labeled as GPA/work authorization/sponsorship/demographics remain untouched. Required unsupported controls stay incomplete. Iframe contents are not inspected. Real employer compatibility is a separate live release gate.

The browser uses a fresh private profile and a private debugging pipe. It never attaches to the student's normal Chrome profile or reads its cookies/storage. Closing the session erases the temporary profile; local review receipts, historical revisions and backups remain. Runtime shutdown closes its owned browsers. A new runtime does not reopen an old browser or replay an uncertain fill. An idle browser closes after at most 30 minutes.

## Student workflow

1. Use **Find internships** to read a current official posting from the selected public Greenhouse/Lever API. A manual or stale role cannot authorize a preparation browser.
2. Open **Application browser**, choose that posting and optionally a current task-agent session. Review the exact derived URL and open a new owned Chrome window. Lever uses the selected official `/apply` URL; Greenhouse stays on its exact posting page. Arbitrary redirects and other document URLs are blocked.
3. After the page loads, review an explicit visible-form read. The dashboard shows the control label, type, existing value, required status and whether it can be filled. No control starts selected.
4. Check only the desired supported text fields. Use a current confirmed career profile fact verbatim, or enter a literal value yourself. Literal input remains labeled as student input; it is not magically fact checked. Profile values cannot be silently edited while still claiming their original fact evidence.
5. Preview the exact changes. The server compares the actual current form to the selected snapshot again before retaining a pending mapping/hash.
6. Review the full mapped values and approve the exact payload. The browser pauses page scripts and blocks page network requests **before** setting values. It uses fixed isolated-world code and native input/textarea setters, never arbitrary scripts from a request. A second snapshot verifies the complete before/after field projection, including unchanged controls.
7. Read the receipt: exact approved payload hash, review identity/time, literal field-write count, resulting form fingerprint, verified readback hash, proof type, and zero automated clicks/uploads/submissions/navigation. The page remains frozen as a local draft; employer-side validation, attachments and submission remain undone.
8. Close the owned browser to erase its temporary profile when finished. Prepare/review any actual final submission separately in the appropriate official employer workflow. A local filled draft cannot be called a submitted application.

The frozen draft may not update a framework's internal state or run employer validation. This is deliberate preparation-only behavior. The interface must keep that limitation visible, rather than claiming universal ATS support.

## Architecture

- `application-browser.mjs`: fixed macOS Chrome binary, isolated 0700 temporary profile outside repository/backups, private CDP pipe, bounded commands/results/timeouts, selected URL guard, visible top-level snapshot and exact native text fill/readback. Initial unsafe methods, other document navigations, WebSocket URLs, new page targets and downloads are blocked. Page scripts and page requests stay blocked after review/fill. No externally callable arbitrary evaluate/click/upload/selector/path/URL interface exists.
- `application-browser-service.mjs`: paired-human coordinator, current selected official role pin, optional current task-session pin, current confirmed career fact selection, exact snapshot/mapping review hash, single writer, expiry and durable receipts. `artifact` records use `learnbridge_application_preparation.v1`.
- `application-browser-routes.mjs`: same loopback authentication, same-origin, nonce and body allowlist as the existing runtime. Never part of agent MCP IPC.
- `application-browser.js`: unchecked field selections, exact-value preview/confirmation, live-versus-fixture proof, task session link and close/cleanup controls.

Integration contract:

```js
const applicationBrowserService = createApplicationBrowserService({
  store, publicJobService, taskSessions,
});
// Paired HTTP dispatcher supplies applicationBrowserService, privateBody,
// session, stillAuthorized and idempotencyKey to handleApplicationBrowserRoute.
// Runtime shutdown awaits applicationBrowserService.drain() before store.close().
// taskSessions.getCurrentPin(id) validates raw task/provenance pins without
// resolving application progress. This avoids recursive UI-view resolution.
```

The task-agent view may use `progressForTaskSession(id)` for small preparation metadata only: state, current-source status, browser-open status, proof, reviewed field count and review requirement. The field count comes from the successful receipt's `effects.field_writes`. This link never reveals mapped values or establishes submission/task completion. It validates through `getCurrentPin`, rather than calling the task view that itself resolves preparation progress.

| Route | Operation |
| --- | --- |
| `GET /application-browser/state` | Current selected official role/fact choices, capability and saved preparation records. |
| `POST /application-browser/open` | Exact `role_ref:{id,revision,source_sha256}`, optional `task_session_id` (null if none) and explicit confirmation. URL comes only from the selected official record. |
| `GET /application-browser/sessions/:id` | Read the saved proof/status and review receipt. |
| `POST .../inspect` | Exact revision and confirmation for the selected visible form read. |
| `POST .../preview-fill` | Exact revision/form fingerprint and checked mappings `{field_id,value,profile_ref:null\|{id,revision,fingerprint}}`. No write yet. |
| `POST .../fill` | Exact revision/payload hash, explicit confirmation and retry key. One local draft write/readback. |
| `POST .../close` | Exact revision; close only this owned browser and erase the temporary profile. |

A changed page/form/role/task/profile blocks a stale review. A process interruption after a fill starts is an unknown result with no automatic replay. The receipt does not assert which fields changed if definitive readback is unavailable. Repeating the exact successful retry returns its saved receipt without writing again. Starting a new independent browser requires a new reviewed action.

## Implementation plan for broader automation

1. Keep the initial supported flow narrow and reviewable. Attach the task-agent's factual local draft to this exact field-mapping review; the ordinary embedded model still lacks arbitrary browser actions.
2. Add model-suggested mappings only through a separate selected context note and short-lived grant. Its envelope should list existing eligible field IDs and exact chosen source-fact IDs; validate every value against the chosen fact or explicitly label proposed freeform text. A suggested mapping is a pending review, never authorization to fill.
3. Extend supported providers and field types one at a time with owned-browser fixture tests plus separately approved live accounts. Cross-origin iframes must have explicit per-frame origin/URL ownership, snapshot and scope review before reads/writes; do not drop the current top-level guard.
4. A future unfrozen employer-side preparation path must be separately designed for autosave/transmission and employer validation. Any final upload/submission remains a separate exact user-authorized action. Do not add arbitrary click, shell or JavaScript endpoints as a shortcut.
5. Add remotely observable status through the already planned phone relay only after its device/session/retention release gates. Do not expose Chrome's pipe or temporary cookies to the public website.

## Objective checks and actual evidence

Run `node --test scripts/application-browser.test.mjs` on the verified Mac. AB01–AB13 use actual SQLite/public-role contracts and a synthetic browser transport, so they prove orchestration, review gates, current-source checks, retry semantics, receipts and restart preservation. They do not prove an employer site's UI.

AB15 composes the actual task-session, host and preparation services. One task-view request must resolve preparation progress once, preserve the exact reviewed field count, retain the pending task and mark the preparation stale after a task revision changes. `node --test scripts/application-browser-http.test.mjs` additionally exercises the actual server/router/storage: unpaired/nonce/Origin/cross-workspace/query requests, arbitrary URLs/scripts/executables/profile paths and constructor-only fixture seams are rejected; submit/upload/click/evaluate/navigation endpoints do not exist. Those rejection tests create no browser session and perform no external request.

AB14 launches **actual owned macOS Chrome** at a private loopback HTML fixture through a trusted constructor-only test seam. The production URL allowlist still rejects loopback URLs. The fixture includes supported name/email/textarea fields, file/password/protected/submit controls, and input handlers that try autosave POST and GET `/submit` requests. It verifies:

- fixed Chrome binary, fresh private profile and pipe; no debugging port, sandbox bypass or inherited API key;
- exact isolated-world visible control projection with password masked and protected/file/submit controls ineligible;
- current snapshot hash before fill;
- native name/email values read back after script/network freeze;
- unchanged URL and zero automated click/upload/submit/navigation effects;
- server-observed **zero** attempted autosave or submission requests reaching the fixture server;
- owned browser closure and actual temporary-profile removal.

These actual Chrome actions still have `proof:'fixture'`, because the page is synthetic. They establish the shipped transport works on this Mac, not real Greenhouse/Lever form compatibility, ATS framework validation, employer acceptance, CAPTCHA/login, attachments or application submission. AB14 explicitly skips only if actual macOS Chrome is unavailable; such a run does not pass the live browser gate. The verified local run had no skips.

Current primary protocol contracts: [Chrome DevTools Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [Fetch request interception](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/), and [Page isolated worlds](https://chromedevtools.github.io/devtools-protocol/tot/Page/). Protocol documentation is not a substitute for the actual Chrome fixture above.
