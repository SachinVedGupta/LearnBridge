# LeetCode history and coding interview practice

## Student experience

Open **LeetCode & coding** in the local dashboard. Choose **Open LeetCode sign-in**, complete normal LeetCode sign-in yourself in the dedicated browser, then choose **Check signed-in account**. A username is optional: the authenticated MCP identity supplies it. An entered username must match. Google or another social login offered by LeetCode signs the student into LeetCode; it does not grant LearnBridge an OAuth token.

The dedicated Chrome profile stays privately on the student's own computer. LearnBridge observes only this owned profile's LeetCode session, uses it in its local read-only MCP child and picks up a changed session before the next selected read. No manual cookie copying is needed for this main flow. The student still completes passwords, MFA and any provider-required sign-in. An expired session cannot be turned into an indefinite refresh token. No documented third-party LeetCode OAuth provider flow was found in the audit; the audited MCP uses `LEETCODE_SESSION` plus CSRF. See the [pinned audit and MIT notices](LEETCODE_MCP_ATTRIBUTION.md).

**Disconnect** stops active authority and closes the browser while retaining its private profile for later sign-in. Locking the dashboard or exiting the runtime also stops access. **Forget saved sign-in** explicitly removes that owned profile. Existing saved history, code, notes and backups remain separate historical copies. Advanced setup offers a public username or a transient cookie; the hosted website never accepts a student's LeetCode cookie.

## Implemented workflows

| Feature | Meaning and behavior | Verification |
| --- | --- | --- |
| Local sign-in | Fixed official login page in owned visible Chrome using a private debugging pipe; normal human sign-in; optional username must match actual account; retained private profile outside repo and workspace backups | Browser fixture checks ownership, cookie selection, navigation/security barriers, cleanup and invalid profile handling; runtime HTTP checks sign-in, rotation, browser nonce isolation, lock and forget |
| Attempt history | Explicit import of at most 20, 50 or 100 attempts; private pages retain failed/repeated submissions and next-page evidence; public history is a limited recent window with no private code or authoritative submission IDs | Pagination offsets and counts, repeated/failure preservation, public/private separation, expired/switched account, cancellation, idempotency and exact snapshot readback |
| Profile and contest evidence | Platform-reported solved/submission counts, ranking and optionally contest rating/history; displayed as source observations | MCP query normalization preserves distinct count meanings and timestamp units; fixtures plus an actual anonymous profile read |
| Selected answers and judge details | One selected private attempt at a time, including literal submitted code, runtime/memory, percentiles, testcase counts and available error/output fields | Only an ID from the selected account snapshot may be read; independently checked report owner/problem; no auto-read on refresh; exact saved report and offline reopen |
| Recommendations | Counts observed outcomes, languages and repeated problems; suggests comparing attempts, debugging one recorded failure and explaining edge cases | Every recommendation references actual attempt IDs; pending results are distinct; no skill, mastery or hiring score |
| AI history context | Student explicitly exports one bounded snapshot into a private coaching note, reviews it, then grants only that note to Codex/Claude through existing Agent & review | Revision/hash mismatch fails; no private code/cookie included; export creates no grant or turn; 24,000-byte encoded context limit |
| Coding interview | Selected saved problem/language, own code editor and explanation, practice or mock interview; actual saved checkpoints and elapsed practice time | Exact source pins and language, distinct checkpoint preservation, pause/resume/finish, restart and fresh backup restore |
| Review a previous answer | Explicitly import an exact saved submission into a matching problem/account/language practice; add own explanation; preserve source pins and historical judge details | Wrong account/problem/language or changed report denied; original code retained if source becomes stale; fresh context note and sharing required |
| AI interviewer | Reviewed official local Codex turn asks a question, gives a small requested hint or reviews the latest exact checkpoint; read-only tools and source-grounded feedback | One selected context note only; prompt/hash/grant/authority checks; verbatim evidence quotes; malformed output, expired grants, late output and lost acknowledgments fail visibly without replay |
| Optional speech | Browser dictation of the student's explanation and read-aloud of coaching after explicit microphone consent | Handler checks recording remains draft, pause stops speech/capture and no auto-save/AI transmission; actual physical microphone/speaker behavior still needs device verification |

Code is never executed by the runtime or submitted to LeetCode. Students can open the original problem to run or submit on LeetCode themselves. Judge results describe that previous platform attempt, not a locally tested editor draft. This is ungraded interview practice; it does not silently complete a graded assignment or live employer assessment.

## Architecture and boundaries

1. The paired local dashboard uses loopback-only HTTP with the existing origin, HTTP-only cookie and request nonce checks. LeetCode live authority belongs to the initiating paired browser. No remote companion or coding-agent command controls the sign-in browser.
2. `leetcode-browser.mjs` launches only the installed supported Chrome binary and fixed LeetCode login. Its marked, owned 0700 profile is a sibling of the private workspace, outside Git and SQLite backups. It never attaches to a user's existing browser. Cookies, CSRF and credential values do not enter status or HTTP response data. Profile retention is explicitly disclosed.
3. `leetcode-client.mjs` starts the bundled `leetcode-mcp.mjs` through real MCP stdio using existing dependencies. The child receives only the transient session in its environment. It has eight read tools, no shell, configurable endpoint, editorials, note writes, runs or submissions. Requests use fixed `https://leetcode.com/graphql/`, bounded time/bytes and no redirects. Provider denials and challenges stop the operation.
4. `leetcode-service.mjs` validates account identity before private reads and immediately before save. An owned-browser session rotation must retain the same identity. Saved profile/history/problem/report observations are immutable local `career_item` records with hashes and coverage. Different attempts remain separate; a repeated problem is not deduplicated into one success.
5. `coding-practice-service.mjs` pins one saved problem plus the latest literal student checkpoint. Imported reports retain their exact origin pins. A bounded private note is exported without sharing. The student separately approves one destination-specific note grant and each exact AI request. The official subscription bridge's `read_only` policy excludes proposal writes and general shell/browser execution.
6. Structured coaching verifies selected source references and literal evidence before attachment to a saved session. Each answer retains its own grant provenance; revoked output is withheld. Interruptions, restart recovery and missing acknowledgments never auto-replay work. Original student checkpoints remain available independently of model output.

## Agent implementation and extension plan

The source is split into `leetcode-browser`, `leetcode-mcp/client`, `leetcode-service/routes`, `coding-practice-service/routes` and the `leetcode` UI. Runtime registration, asset build and clean-install manifest explicitly include every shipped file. No new production dependency or hosted authentication configuration was added.

For subsequent work, proceed in this order:

1. Complete an actual student sign-in in the dedicated browser, then read a selected private page and selected report. Verify account matching, refreshed session handling, expiry, logout and forget. Record only shaped receipts, never cookies or full private answers in public evidence. Current fixtures do not certify private live authentication.
2. Add broader historical paging only with a reviewed limit/date range, stable cursor support when available, cancellation and provider rate-limit handling. Keep `complete_history_claim:false` until the provider actually supports a complete consistent traversal; page-end evidence alone is insufficient.
3. Add topic recommendations using exact observed problem tags and selected attempts. Distinguish unobserved topics from demonstrated difficulties. Add AI-generated suggestions only from reviewed exact history/code notes and require literal attempt IDs and excerpts; test against fabricated evidence and false mastery claims.
4. Add a separately reviewed sandbox or provider-side test run only if its actual isolation, time/memory/network limits and cleanup are verified. Never run arbitrary student code directly on the laptop. Platform submission remains a human action unless explicitly designed and separately authorized later.
5. For continuous live voice, implement authenticated streaming audio, explicit provider/cost permission, stop/mute, device selection, transcript revision and consent controls. Current dictation/read-aloud are useful speech controls, not a certified continuous two-way voice interview.
6. If LeetCode documents a supported third-party OAuth API, replace the credential acquisition adapter with PKCE/scoped tokens. Do not label an OAuth-protected MCP gateway as LeetCode OAuth: gateway sign-in cannot grant access to LeetCode data by itself. A public website would need a separately designed multi-user authorization path; this local browser is never a cloud credential gateway.

## Running verification

From the repository, use the bundled Node runtime and installed workspace dependencies:

```sh
cd web
node --test scripts/local-leetcode-*.test.mjs scripts/local-coding-practice.test.mjs scripts/leetcode-ui.test.mjs
npm test
npm -w @learnbridge/local-dashboard run build
npm run build:website
node scripts/verify-local-install.mjs
```

The [current receipt](LEETCODE_VERIFICATION.json) binds code commit `8293fe1`: **1,541 automated passes**, zero skips, **133 targeted cases**, both builds and nine clean-install phases with 153 files and 35 hash-matched dashboard assets. Actual anonymous LeetCode profile/problem reads, installed Chrome's normal-login/unsigned-in gate, and official Codex question/review turns passed. Codex requested status/context itself and its four review dimensions cited exact synthetic student code/explanation; no API fallback, execution or submission occurred. An initially unsupported model feedback label was rejected, then clearer closed-enum instructions produced a valid newly reviewed turn. The parser was not weakened.

The actual component passed desktop 1280px/mobile 390px layout and unsaved-draft refresh checks with a clearly labeled synthetic account/API/coaching harness. [Desktop](evidence/leetcode-synthetic-desktop.jpg) and [mobile](evidence/leetcode-synthetic-mobile.jpg) screenshots demonstrate layout, not a live account or model response. Runtime HTTP tests separately cover identity, history, selected code, checkpoint, exact-note grant and coaching response persistence. A mocked host reply is not evidence that the real model generated valid coaching. Preserve offline student work and keep public LeetCode reads, private live account checks, physical voice and host model checks separate.

A supported runtime backup and fresh disposable restore preserved the exact actual problem, session, checkpoint, two host turns, context note and grant. The restored studio displayed both real Codex replies and the original student code/explanation with the host unavailable and LeetCode disconnected. All five record hashes, note bytes/revision, grant and host output hashes matched; SQLite integrity passed, and zero model/provider calls or credential-file copies occurred during restore.
