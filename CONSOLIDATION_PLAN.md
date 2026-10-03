## Live student acceptance — October 2, 2026 UTC

Google sign-in, cloud task/draft persistence across reload, tutor generation, and Google Tasks OAuth plus data read now pass on the deployed website. Fixed and deployed the Composio account-selection incompatibility while retaining account-pinned sessions. Current deployment: dpl_4RJ15wBfuucrCAJRME3Z67bdphuU. Other connectors and Google public-branding publication remain pending. No commit or push.

## Approved public deployment and Google login — October 2, 2026 UTC

- User approved Vercel deployment and requested Google login instead of separate email/password onboarding.
- Created and deployed `thelearnbridge` in the approved account; https://thelearnbridge.vercel.app is live. Production server keys transferred without printing values. Supabase and Composio production callbacks configured and verified.
- Added server-initiated Google OAuth and PKCE callback with fixed redirects, secure cookies, and sanitized errors. Build passed; live auth boundary smoke checks passed.
- Prepared Google OAuth client in dedicated project `axial-keep-510403-a8`; user accepted the data policy. Credential creation and Supabase provider entry await user handoff. Google login, actual connector consent/reads, and per-user saved state are not yet tested end-to-end.
- No commit or push. See docs/HOSTING.md for deployment identity and remaining tasks.

## Connector activation and hosting preparation — October 2, 2026 UTC

- The supplied Composio project key authenticates successfully. All eight expected auth config IDs match the dedicated LearnBridge project.
- Restarted the website with the new key. Callback verifier remains disabled because no approved public HTTPS origin exists yet.
- Supabase Authentication dashboard showed no student signups when checked; asked user to create/confirm a LearnBridge student account separately from the Supabase owner account.
- Prepared `docs/HOSTING.md`, web app `vercel.json`, root upload exclusions, and a website-only build command. Verified that build and all eight mocked tests pass.
- Requested explicit deployment approval for a new `thelearnbridge` Vercel project in Sachin Gupta's projects. No Vercel project, upload, environment transfer, or deployment has occurred.

## Supabase activation — October 2, 2026 UTC

- Connected the user-created project `gjtjlmgketfcglukefch` (Sachin Company); no second project was created.
- Applied `supabase/migrations/202610020001_student_workspace.sql` transactionally through the project SQL editor.
- Ran `supabase/tests/student_isolation.sql`: all five pgTAP checks passed. Test users and state were rolled back. Corrected the test SQL to use top-level modifying CTEs and collect every result for review.
- Saved the project URL and existing publishable key to ignored `.env.local`. No service-role key was accessed.
- Configured preview Site URL `http://127.0.0.1:3200` and exact email redirect `/login`; public HTTPS URLs remain a deployment step.
- Live checks: Auth settings HTTP 200, email enabled, automatic confirmation disabled; anonymous REST table access 401; signed-out app state access 401; invalid login 401. Production build passed.
- Still pending: real signup/email confirmation/login and cloud-save flow; Composio API key and public callback verifier; public SMTP and deployment. These checks do not prove end-to-end OAuth or student signup yet.

# Current direction — public student website

The user explicitly clarified that LearnBridge must work for anyone through a website. Earlier local CLI/MCP integration notes below describe investigation history, not the current product architecture.

Supabase + Composio Platform were approved. Current code includes authenticated per-user storage, connector sessions, callback identity verification and request quotas. The personal CLI adapter has been removed. The local D2L endpoint is disabled for the website.

Created externally: free Supabase LearnBridge organization and dedicated Composio LearnBridge project. Supabase database creation awaits the user's database-password step. Composio project API key creation awaits the user. Saved managed OAuth configs cover Notion, Gmail, Calendar, Drive, Tasks, Teams, OneDrive and Discord. User approved Google read/write scopes; no student accounts are linked in this project yet. Live account connection and database isolation tests remain pending. No public deployment is authorized or completed.

Build and eight mocked tests pass. Next.js/React/TipTap and vulnerable dependencies updated; npm audit reports zero vulnerabilities at this checkpoint. These checks are not equivalent to live multi-student verification.

---

# LearnBridge consolidation assessment

Assessed October 1, 2026 against both local working trees. The recommendation is to keep LearnBridge as the canonical repository, use LearnBridge2's assignment editor as the main interface, and progressively connect the original Classroom functionality behind a shared API. An initial consolidation now lives under `web/`: the imported editor, a Today page, tutor, connection status and local read-only D2L bridge. The original Python code and LearnBridge2 remain intact. External integrations and a hosted multi-user release are still incomplete.

## Product intent

The confirmed product is an AI assistant for students across D2L, Google Workspace, Teams, Notion, Discord and their other apps. The editor is one part of the product. LearnBridge helps a student move from scattered course information to a clear next action: find an assignment, understand its requirements, start a draft, receive guidance against the rubric, and track the deadline. The original project supplies course awareness; the extension supplies a writing workspace and an external automation gateway.

The proposed first complete workflow is: connect one course source, open an assignment with its source link and due date, load its rubric into the editor, get a hint or reviewed edit, save the draft, and optionally approve a calendar event. Learning assistance should explain and scaffold the student's work.

## Existing implementation

| Component | Implemented in source | Verification and limits |
| --- | --- | --- |
| Original Streamlit UI | Google sign-in gate, chat, quick actions, session state | Starts and shows the gate; no live login or model call performed |
| Python Google ADK pipeline | Parallel coursework and announcement agents, followed by a synthesis agent | Imports and syntax pass; authenticated execution remains unverified |
| Classroom readers | Paginated courses, announcements and coursework; submission and grade lookup | Real API code exists; live access not tested |
| Calendar writer | Event insertion from deadline requests | Unsafe automatic trigger; separate file-based credentials and incorrect all-day end date |
| Assignment editor | Next.js, TipTap formatting, templates, writing statistics, Ask and Agent modes, manual course context, suggestion review | Shared package, Express API and Next.js production builds pass; editor renders |
| Assignment API | Validated ask/edit requests, Gemini calls, structured suggestions and deduplication | Health and proxy pass; missing key produces a descriptive 502 |
| Sim chat | Next.js chat UI and server-side workflow request | Build passes; chat displays missing-key error; route returns 503 |
| Canvas, Teams, Word, Notion and n8n | Mentioned as product integrations | No reproducible connector implementations or workflow exports found in the inspected application sources; may exist externally |

The two LearnBridge2 applications do not share authentication, course records, chat history or editor context with the original. The editor stores its document/title/context in client state; durable saving and retrieval are absent. Semantic retrieval is described as future work. Sim receives only the current message; conversation continuity would need verification in the external workflow.

## Observed checks

- Parsed all 16 project Python source files successfully using the existing `.venv`.
- Streamlit health returned 200. AppTest reached the authentication gate without exceptions.
- Clicking Connect with OAuth configuration absent raises an uncaught `ValueError`.
- Mocked failed callback displays an authentication error. Mocked successful callback clears URL parameters. These checks do not prove a real OAuth round trip or session continuity.
- Assignment shared/API/web production build passed. API `/healthz` and web `/api/healthz` both returned 200.
- Synthetic ask/edit requests with credentials deliberately disabled returned 502 with a missing-key message. No model requests were sent.
- Sim production build passed, with a Tailwind content-configuration warning. Missing-key chat returned 503 and missing-message chat returned 400; the UI displayed the configuration error.
- Editor rendered in the browser. Context/Templates clicks did not expose a changed accessibility tree at the narrow panel size; investigate the responsive layout before claiming complete interaction coverage.
- GitHub default-branch heads matched local HEAD: LearnBridge `fd3729d`, LearnBridge2 `5b5638b`. Both working trees already contained uncommitted fixes and credential removals; these were preserved.

## Problems to resolve before live use

1. **Credentials:** project instructions identify previously exposed Google and Sim credentials. Verify revocation/rotation before using real course data. Do not restore deleted secrets or import `.history`. History cleanup is a separate approved operation.
2. **OAuth:** callback code does not explicitly compare received state with a stored expected state before token exchange. Credentials depend on Streamlit session state, so redirect/session continuity needs a real test. Handle missing configuration as a normal UI state; the sample environment is not itself loaded by the Streamlit entrypoint.
3. **Calendar:** the wired tool reads `drive_config.json`, while a duplicate implementation reads `token.json`; neither uses the signed-in user's web OAuth credential path. Require explicit confirmation, reuse the correct user credentials, make the end date exclusive, preserve due time/time zone, and deduplicate repeated requests.
4. **Tutoring behavior:** the editor prompt explicitly requests filling all placeholders and writing an entire lab. Replace this with feedback, scaffolding and explained edits consistent with the project agreement. Malformed model JSON currently becomes a whole-selection replacement suggestion; fail clearly instead.
5. **Model compatibility:** original agents hardcode `gemini-2.0-flash`; Google lists its shutdown date as June 1, 2026. The editor hardcodes `gemini-2.5-flash`, whose access Google currently limits to prior active users. Make model choice configurable and verify access before accepting an end-to-end result. Google recommends migrating the legacy generative AI SDK to the GenAI SDK. Production dependency changes need approval under AGENTS.md. Sources: [model lifecycle](https://ai.google.dev/gemini-api/docs/deprecations), [SDK migration](https://ai.google.dev/gemini-api/docs/migrate).
6. **Reliable data flow:** decouple Classroom tools from Streamlit state; normalize course/assignment/material/rubric identifiers and source links. Fetch and cache course data independently of model prompting, then provide only relevant context. Report partial fetch failures rather than presenting an incomplete result as complete.
7. **Persistence and ownership:** add saved documents, revisions, course context and user ownership. Existing local API routes have no application authentication; they are not ready for public deployment.
8. **Operational errors:** add bounded timeouts, controlled retries, validated Sim payloads, and sanitized errors. Remove full model-output and assignment-text logs. Add a configurable Sim workflow reference and a reproducible workflow export before calling those integrations supported.
9. **Repository setup:** the original `.gitignore` ignores every `*.json`, which would silently exclude Node manifests, lockfiles and TypeScript configuration during consolidation. Replace the broad rule with targeted secret exclusions before importing frontend source. Both READMEs contain stale setup or feature claims, including model names, the root dev command and automatic calendar testing.

## Proposed architecture

The initial implementation uses one Next.js frontend with server route handlers for OpenAI and a local read-only Brightspace MCP bridge. The imported Express/Gemini API remains available as reference but is not needed for the unified web app. Preserve the original Streamlit code during migration. Use Composio or direct adapters behind a common connector interface for other apps; Sim is optional rather than a required second frontend.

This preserves the useful implementation and avoids a simultaneous rewrite of the UI, Google authentication and agent tools. The trade-off is temporarily running Node and Python services. Consolidating all backend behavior into TypeScript later would simplify deployment but requires rebuilding and revalidating the Python integrations; do that only if maintaining ADK no longer provides value.

Proposed repository layout:

```text
LearnBridge/
  apps/web/                 main Next.js interface
  apps/api/                 existing Express API, expanded incrementally
  packages/shared/          schemas and shared types
  services/classroom/       extracted Python integration and ADK service
  legacy/streamlit/         original prototype during migration
  docs/                     setup, contracts, verification and workflow exports
```

This is a target layout, not a completed move. Preserve source provenance and inventory local changes before relocating files. Start by importing the existing assignment-ai workspace intact if flattening its paths would unnecessarily combine migration risks.

## Implementation sequence and acceptance criteria

1. **Reproducible baseline:** inventory existing local edits, import only selected source and lockfiles into LearnBridge, fix targeted ignore rules, document ports and environment variables, and add a repeatable smoke runner. Keep LearnBridge2 intact. Success: one documented local command sequence launches the components with actionable configuration errors.
2. **One useful local workspace:** unify branding/navigation and bring chat into the editor interface. Add saved drafts and a course/assignment/rubric contract with synthetic fixtures and manual input. Success: open an assignment, edit a draft, refresh, and recover it with its context; no credentials needed for the fixture flow.
3. **One real course integration:** repair OAuth state/session behavior and extract Classroom reads into the service boundary. Prioritize D2L for the confirmed student use case; retain Classroom as a later adapter. Success: deliberately authorized, read-only course and assignment retrieval populates the same workspace with source links.
4. **Grounded tutoring:** pass the selected assignment, rubric and relevant materials into Ask and reviewed edits. Test cross-paragraph ranges, stale suggestions, overlapping edits, undo and accept/reject behavior. Success: responses identify their sources and cannot silently replace the student's work.
5. **Approved actions:** connect Calendar through preview/confirm and idempotent creation. Export and document the Sim workflow before enabling additional integrations. Success: viewing deadlines makes zero writes, and an explicitly approved event is created once.
6. **Release readiness:** establish account isolation, persistent storage/backups, sanitized logs, request limits, supported dependencies and automated integration checks. Review the final diff and live acceptance results before any approved commit, push or deployment.

The first milestone should be one complete assignment workflow, not simultaneous support for every LMS and productivity app.

## Local preview commands

Existing dependencies were sufficient; no packages or production dependencies were changed. These commands reproduce the credential-disabled previews used in the assessment, each in a separate terminal:

```bash
# From LearnBridge
.venv/bin/streamlit run streamlit_app.py --server.address 127.0.0.1 --server.port 8510 --server.headless true --browser.gatherUsageStats false

# From LearnBridge2/assignment-ai, after npm run build
GEMINI_API_KEY='' npm -w @assignment-ai/api run start
npm -w @assignment-ai/web run start -- --hostname 127.0.0.1 --port 3100

# From LearnBridge2/sim-ai-chat, after npm run build
SIM_AI_API_KEY='' npm run start -- --hostname 127.0.0.1 --port 3101
```

The existing Express server binds without an explicit host; restrict its listener before treating this as a reusable local-only launcher. Preview availability lasts only while the processes run. Real provider tests require fresh configured credentials and separate verification; passing builds and health checks are not evidence of working external integrations.

## Connector and model decisions after clarification

The app must own user accounts, course/task/document records, source provenance and permissions. Connector providers supply access; they do not replace this shared student context. Keep adapters replaceable so Composio, MCP and direct APIs can coexist.

- **D2L:** installed Brightspace MCP 3.8.2 exposes the relevant read tools. A live course check during assessment failed to reach Brightspace for sign-in; no successful live sync is claimed. The shipped bridge is local and single-user. Standard hosted OAuth needs application registration through Brightspace Manage Extensibility; investigate institutional support before promising universal web login. [D2L OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html)
- **Composio:** recommended candidate for an initial connector service. Tool discovery verified Teams chat reads, Discord bot channel/message reads and Notion search. This is catalog verification, not working app integration. Its pricing page lists 100K free monthly calls with own app/API/MCP credentials, with only 20K of that allowance for managed OAuth apps. Premium tools and hosting/model costs are separate. [Pricing](https://composio.dev/pricing)
- **Access boundaries:** Teams access depends on requested Microsoft permissions and tenant consent; Discord needs the appropriate bot/channel access and message-content permissions. Do not promise that signing in imports every conversation. [Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [Discord gateway](https://docs.discord.com/developers/events/gateway)
- **Alternative:** Nango offers a free self-hosted subset, with infrastructure and integration maintenance owned by us. It is a later cost/control alternative rather than another simultaneous dependency. [Nango repository](https://github.com/NangoHQ/nango)
- **OpenAI:** selected as the web app provider. No real request has been made and no supplied chat key was saved. Requests are disabled by default. `gpt-4.1-mini-2025-04-14` is configurable and listed among incentive-eligible models. Eligibility requires account confirmation and a positive balance; exceeding the allowance can incur normal charges. Never assume that creating a key enables the offer. [Data-sharing incentive](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)

Updated implementation priority: prove a D2L course read and build per-student authentication/storage; then normalized assignments and sourced tutoring; then Composio account onboarding for Google Workspace/Notion, Teams and Discord. Replace the local MCP session boundary before hosting for multiple students.

## Verification of the initial web consolidation

The shared package, retained Express API and unified Next.js production build pass. Five automated tests cover disabled-provider behavior, bounded OpenAI requests, sanitized errors, missing D2L configuration and a synthetic MCP initialize/course-read exchange. HTTP checks confirmed health/status, disabled-AI 503, empty-edit 400 and cross-origin 403 responses. Browser checks confirmed task persistence and draft/title persistence after refresh, tutor error display and connection status. These checks made no live OpenAI calls. The prior live D2L course probe failed; the app bridge has been verified against a synthetic MCP server, not a successful authenticated course read.

## OpenAI activation verification

After the user saved their chosen key locally, AI requests were enabled and the server restarted. A synthetic tutoring request through `/api/ask` returned HTTP 200 and a relevant explanation from `gpt-4.1-mini-2025-04-14`. The secret was not printed or committed. Free-token eligibility and the cost classification of this request remain unverified; no account data-sharing settings were changed. Earlier notes about disabled requests describe the initial baseline.
