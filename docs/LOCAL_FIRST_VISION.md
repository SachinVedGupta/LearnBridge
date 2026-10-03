# LearnBridge local student assistant blueprint

LearnBridge should become a local student workspace that connects academic, career, project, communication, and everyday planning tools to the student's existing AI agent. Keep the public website available while building a local edition in the same repository. The recommended first release combines a local dashboard, private storage, an Avenue connector, and Codex or Claude tools and workflows.

This is a proposed implementation plan based on a source audit and official documentation reviewed on October 2, 2026. The feature catalogue below is a backlog, not a list of completed capabilities. Authentication, subscription eligibility, university access, and browser integration must be verified on each supported platform before release.

The [detailed design package](design/README.md) expands this vision into feature specifications, contracts, controlled onboarding, dependency-ordered work packages and objective verification. Its physical package layout and milestone labels supersede the earlier proposed groupings below. [SETUP_LEARNBRIDGE.md](../SETUP_LEARNBRIDGE.md) is the student-agent setup entry point.

## Product experience

A student installs LearnBridge, chooses Codex or Claude Code, connects their own accounts, and selects their course folders. Onboarding asks for their timetable, goals, constraints, and preferred level of automation. They can correct or delete that information later.

The dashboard answers four questions: What changed? What matters today? What should I do next? What is waiting for my review? Each recommendation links to its source and shows when the source was checked. A missing source produces an incomplete refresh result rather than a misleading all-clear.

The AI should understand a student's selected context, propose a useful next step, carry out authorized actions, and verify the result. Examples:

- “Check Avenue, my class channels, and my calendar. Tell me what changed and plan the next two days around tomorrow's lab.”
- “I missed two lectures. Use these slides, teach me the prerequisites, quiz me, and save a catch-up plan.”
- “Find internships that fit my verified profile. Prepare three applications and show me every answer before submission.”
- “Turn these meeting notes into project tasks and draft a team update.”
- “Plan groceries and meals around my budget, available ingredients, and class schedule.”

## What already exists

| Area | Current source behavior | Work needed for this vision |
| --- | --- | --- |
| Website | Next.js dashboard, tutor, connections page, TipTap editor, Google sign-in | Local mode and richer student navigation |
| Tasks and drafts | Account-owned Supabase state, revision checks, manual tasks, one saved draft | Local storage, multiple documents, imported deadlines and workflows |
| Tutor | Server-side OpenAI, short browser conversation, selected Composio read tools, reviewed task proposals | Subscription-backed execution, durable learning context and action tools |
| Connected apps | Student-owned Composio accounts and selected search/read tools | Selected source mapping, writes with review, provider-specific live checks |
| Personal context | Display name, supplied course text and selected account content | Confirmed profile, timetable, goals, preferences and editable memory |
| Avenue | Disabled public endpoint; unused local helper calling only `get_my_courses` | Complete local connector, normalization, caching and authentication recovery |
| Automation | Editor suggestion acceptance and tutor task acceptance | Durable job runner, review queue, action evidence and scheduling |
| Local use | Running the website locally still depends on cloud services | Independent local identity/storage and official agent integration |

Source entry points: `web/apps/web/src/lib/cloud-state.ts`, `src/lib/server/auth.ts`, `src/lib/server/ai-handler.ts`, `src/lib/server/connectors.ts`, `src/lib/server/brightspace.ts`, and `src/app/api/brightspace/courses/route.ts`. Paths after the first entry are relative to `web/apps/web`.

## Feature catalogue

Priority means dependency order: **First** establishes the useful local product; **Next** extends reliable workflows; **Later** is optional expansion.

| Area | Features to add | How to implement | Priority |
| --- | --- | --- | --- |
| Setup | Guided setup, dependency checks, agent selection, sample data, connection health and recovery | A local setup command and `doctor`; generated project MCP configuration; separate fixture/demo mode | First |
| Student profile | Degree, semester, courses, timezone, timetable, goals, internship preferences and constraints | Validated local records with confirmed facts, source references and editable preferences | First |
| Avenue and D2L | Courses, announcements, assignments, due dates, feedback, grades, modules and downloads | Reviewed local stdio MCP adapter; interactive university sign-in; institution-specific profiles | First |
| Course library | PDFs, slides, rubrics, notes and links organized by course/week | Selected-folder import, text extraction, SQLite full-text search and source-page references | First |
| Today | Daily briefing, changed deadlines, priorities, unresolved requests and review queue | Source refresh differences plus deterministic deadline/conflict checks; AI explanation over evidence | First |
| Tasks | Assignment breakdowns, subtasks, dependencies, recurring tasks, effort estimates and reminders | Normalized task database; student-editable estimates; stable external identifiers | First |
| Study tutor | Explanations, hints, worked ungraded examples, prerequisite checks, teach-back and progress checkpoints | Course-scoped retrieval plus learning workflows that record demonstrated understanding | First |
| Catch-up and exams | Missed-lecture plans, revision schedules, practice questions, mock exams and weak-topic review | Topic map, exam/rubric weights, study calendar and spaced repetition records | Next |
| Calendar | Timetable import, focus blocks, commute buffers, workload balancing and conflict resolution | Calendar reads first; previewed writes with timezone handling and duplicate prevention | First then Next |
| Writing workspace | Multiple drafts, rubric checklist, reviewed edits, citations, revision history and templates | Extend TipTap and document storage; preserve originals; compare revisions before accepting edits | Next |
| Documents | Markdown, PDF, DOCX, LaTeX, slide and spreadsheet outputs | Format-specific processors and templates; compile/render and inspect artifacts before delivery | Next |
| Inbox and messages | Gmail/Outlook, Teams/Discord/Slack updates, request extraction and reply drafts | Official APIs or MCP where available; selected channels/folders; provider-specific adapters | Next |
| Knowledge capture | Meeting notes, research, bookmarks, Notion/Obsidian organization and source links | Local Markdown knowledge base plus optional connector exports with revision protection | Next |
| Internship discovery | Verified openings, fit/eligibility checks, duplicate detection, saved shortlist and deadline watches | Official ATS feeds and company pages; timestamped records; confirmed candidate facts | First |
| Application preparation | Resume variants, cover letters, answer bank, browser form preparation and evidence | Adapt audited sourcing helpers; portable browser tools; full answer and attachment review before submission | Next |
| Career preparation | Interview prep, DSA practice, behavioral stories, outreach drafts and follow-up reminders | Personal fact sheet, practice history, reviewable drafts and application tracker | Next |
| Projects and teams | GitHub/Linear tasks, milestones, agendas, meeting action items and code-review preparation | Repository/project adapters; isolated patches; explicit publication and team-sharing controls | Next |
| Meals and groceries | Meal planning, pantry list, shopping list, dietary preferences and cost estimates | Confirmed preferences and local lists; sourced estimates; purchases remain separately reviewed | Later |
| Routine and wellbeing | Focus sessions, breaks, habits, gym plans and sleep schedule reminders | Simple local records and calendar suggestions; supportive planning rather than medical assessment | Later |
| Money and administration | Receipt organization, student budget, scholarship deadlines, forms and renewal reminders | Local imports and categorized records; private document workspace and reviewable forms | Later |
| Campus and travel | Transit timing, weather, office hours, room locations, club events and travel preparation | Official feeds when available; date-stamped lookup; manual import fallback | Later |
| Monitoring | Course changes, job openings, stale connections and actionable reminders | Opt-in local schedules, saved watermarks, quiet unchanged runs and resumable jobs | Next |
| Voice and mobile | Voice capture, quick task entry, selected synced data and notifications | Optional transcription/backend; authenticated device pairing; separate cloud consent | Later |
| Extensibility | New MCPs, institution profiles, workflow recipes and browser helpers | Versioned integration manifests, capability declarations, pinned installs and compatibility tests | First foundation |

## Local and hosted architecture

Reuse the existing interface and shared contracts. Introduce adapters for storage, identity, agent execution, and connectors. The hosted edition continues using Supabase and server-side APIs. The local edition uses its own local runtime; it must not add a public authentication bypass to hosted endpoints.

Proposed repository additions:

```text
local/
  runtime/           local service, setup, diagnostics and job lifecycle
  storage/           SQLite migrations, repositories and export/import
  mcp/               LearnBridge tools consumed by Codex and Claude
  agents/            provider-specific official execution adapters
  connectors/        Avenue, browser, documents and app adapters
  workflows/         versioned recipes and completion checks
  policy/            permissions, review records and action authorization
  tests/             fixtures, contract checks and integration scenarios
agent-packs/
  codex/             project instructions, skills and MCP examples
  claude/            skills, project instructions and MCP examples
integrations/
  manifest.json      pinned upstream versions, provenance and notices
```

The student's data belongs in an OS-appropriate user-data directory outside the checkout. Store tasks, course records, documents, runs and approvals in SQLite, with attachments in managed folders. Use full-text search initially; add embeddings only when measured retrieval quality justifies their cost and complexity. Preserve source URLs, external IDs, retrieval timestamps, content versions and deletion state.

Expose a small local MCP tool surface for context search, course refresh, task management, artifact creation, action proposals and run status. Names such as `get_today`, `search_context` and `propose_action` are proposed contracts, not current callable tools. Use the official MCP SDK for lifecycle and discovery rather than extending the existing handcrafted client.

Bind the local dashboard/service to loopback. Validate Host and Origin and require a local paired session for every private read and write. Localhost alone does not prevent a malicious website from attempting to reach a local service. Give each managed connector/browser process a minimal allowlisted environment rather than inheriting all hosting or developer secrets. Keep credentials in OS credential storage or the connector's managed secure store, with redacted logs and user-owned browser profiles. Browser localStorage is suitable for non-secret UI preferences, not raw university session tokens.

Local storage does not make cloud AI processing offline: selected context still goes to the chosen model provider when the student requests AI assistance. Make that visible. Optional local models can be added separately, with hardware-dependent capability and speed.

## Using existing AI subscriptions

### Codex and ChatGPT

Start with a LearnBridge MCP server and skill pack usable inside the student's signed-in official Codex client. Codex supports local stdio MCP servers and project configuration. The app-server also provides structured sessions, tool events and approval requests for a richer local interface. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex app-server](https://learn.chatgpt.com/docs/app-server).

Official OpenAI documentation now describes Sign in with ChatGPT for open-source/local apps: eligible Plus/Pro users can authorize eligible AI requests against their own plan. This gives us a supported candidate for chat within the local dashboard without requiring an API key. Build a separate adapter, use its own consent flow, protect issued credentials, and prove one inference turn before enabling it. Availability and usage limits remain account-dependent. The paid or remotely hosted product path requires separate consideration. [Quickstart](https://developers.openai.com/siwc/quickstart), [Plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source).

That preview supports local function/custom-tool execution but excludes several hosted tools, including hosted MCP and native computer use. Browser/document operations therefore run through LearnBridge's local tools. The current OpenAI API implementation cannot be reused unchanged: this route requires streaming requests and different parameter handling. Do not silently fall back to paid API usage. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

### Claude

The initial Claude experience should run inside, or launch, the official unmodified Claude Code client. Each student signs in through Anthropic's own flow and supplies their own subscription or API access. Package LearnBridge's MCP and skills for that client. Anthropic's current terms distinguish this arrangement from offering a custom Claude subscription login or proxying collected session tokens. Embedded Agent SDK/API modes need their own permitted authentication. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [MCP setup](https://code.claude.com/docs/en/mcp), [Skills](https://code.claude.com/docs/en/skills).

The repository should make the agent choice clear and show whether work runs in the official agent session or directly in LearnBridge. Subscription usage is limited usage included in a plan, not unlimited free inference. No subscription authentication was newly configured or tested during this planning pass.

## Avenue integration

The audited [avenue-mcp](https://github.com/alanxue1/avenue-mcp) revision is `9f996323641aba91cc0bbf2b21efd429f9a465e1`. Its academic tools are a useful starting point. Use a managed per-student local process, interactive SSO/MFA, a private browser profile, session expiry handling and a configured McMaster login/API host pair. Other institutions need separate profiles and testing. [Authentication implementation](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/auth.ts).

Before integration, replace eager optional-study imports, omit Supabase-dependent study modules in the local core, use stdio instead of its broad HTTP mode, and redact sensitive diagnostics. Restrict downloads/reads to selected folders and serialize browser-profile operations. Use LearnBridge's own notes/tasks storage. [Server entrypoint](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/index.ts), [Supabase dependency](https://github.com/alanxue1/avenue-mcp/blob/9f996323641aba91cc0bbf2b21efd429f9a465e1/a2l-mcp/src/utils/supabase.ts).

The README/package declare MIT, but the reviewed tree has no standalone LICENSE notice. Initially support a pinned external installation; verify attribution and redistribution notices before vendoring substantial code. An independent adapter remains an alternative. A working local university session does not establish permission or technical support for a shared hosted integration.

First acceptance workflow: sign in locally, select a course, retrieve announcements/assignments/materials, import records without duplicates, show exact source links and due times, and recover gracefully from an expired session. Downloads must stay inside the selected data root. The connector should not submit coursework.

## Browser and document integration

Use official app APIs/MCP tools first for structured reads and edits. Use browser tools for missing UI-only operations, then optional native computer control for desktop-only work. These are different capabilities and need separate setup checks.

For portability, pilot [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) using a dedicated student browser profile. Existing-tab integration can be an explicit opt-in. For Claude users, the [official Chrome integration](https://code.claude.com/docs/en/chrome) is another supported route.

[Browser Harness](https://github.com/browser-use/browser-harness), from Browser Use, exposes local browser helpers through skills and stdio MCP to an existing agent. It is a promising optional adapter for subscription-based workflows. Evaluate its manual Chrome setup and permission requirements before making it a default. The full Browser Use agent loop can remain an optional separate backend; it is not necessary to introduce a second model loop for every browser action.

Native desktop automation should be a later platform-specific adapter. macOS and Windows permissions and UI automation differ; Linux desktop availability varies. Do not advertise unrestricted computer control until each supported OS has been tested. Agent tools available in a developer's Codex session are not automatically bundled into LearnBridge.

Document workflows should use local file processors or official document APIs, preserve revisions, and verify rendered/exported results. Initial targets are Markdown/PDF/DOCX/LaTeX; spreadsheet and slide operations follow. Google Docs/Office web editing needs the student's own connector or browser authorization.

## Internship integration

The audited [please-hire-me](https://github.com/alecswang/please-hire-me) revision is `dbb089dad3f9ffc59543bfb1b6952600aa74c9ae`. Reuse its discovery, fact-sheet, duplicate-check and evidence approach, retaining the [MIT copyright notice](https://github.com/alecswang/please-hire-me/blob/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae/LICENSE) for adapted code.

Its ready-made browser workflow is Claude-specific. Its unattended [launcher](https://github.com/alecswang/please-hire-me/blob/dbb089dad3f9ffc59543bfb1b6952600aa74c9ae/run.sh) disables permission prompts and submits applications. Build LearnBridge's own runner and portable browser adapter with a default of researching, preparing and reviewing. Keep discovery separate from form filling. Do not invent work authorization, graduation dates, GPA or other candidate facts.

Each prepared application should contain the official posting, eligibility reasoning, every question/answer, the selected resume version, attachment confirmation, and any unresolved fields. The student reviews the actual recipient and final payload before submission. Record persisted confirmation after submission; filling a form is not completion. Authentication, MFA, CAPTCHA and disputed facts pause for the student.

## Workflows and action controls

Skills teach the agent when and how to use tools. Tool schemas, permissions and durable state enforce behavior. A large system prompt alone cannot make actions reliable.

Every workflow declares its required sources, allowed capabilities, output format, review points, budget, timeout and completion evidence. The runtime records progress, supports cancel/resume, and distinguishes prepared, awaiting student, completed, failed and partially completed outcomes.

For state-changing actions, record the exact target and payload being approved. If the payload or underlying document changes, invalidate the approval. Use stable identifiers and idempotency to prevent duplicate calendar events, messages or applications after retries. Record sanitized tool outcomes and links/artifact paths.

Students can authorize bounded automation for routine reads and reversible local organization. Sending messages, submitting applications/coursework, external document changes, sharing, purchases and destructive operations need appropriate review and must honor the host agent's own rules. Academic workflows should scaffold learning, explain edits, and respect course restrictions.

For browser or shell operations outside LearnBridge's MCP wrapper, the host's controls remain essential; the local review queue cannot claim to intercept arbitrary tools. Avoid permission-bypass launch flags. Treat course files, messages and webpages as source data rather than instructions that grant authority.

Recurring jobs run while the local machine is available. Show missed runs and catch up on restart. Always-on automation needs an optional separately authorized runtime with a deliberately smaller capability set; a laptop-only browser workflow cannot run when the laptop is asleep.

## Delivery sequence and proof

| Stage | Build | Required evidence before claiming completion |
| --- | --- | --- |
| 1 Local foundation | Storage/identity adapters, student profile, multi-document records, MCP server, setup and doctor | Clean clone boots without cloud keys; local saves survive restart; unauthenticated private reads/writes fail; child processes receive only approved environment values; hosted auth stays gated; agent discovers tools |
| 2 Avenue and daily planning | Reviewed connector, course index, deadline normalization, Today refresh and study-plan recipe | Real student SSO; source-cited imports; timezone tests; no duplicates after refresh; expired session recovery; catch-up tutoring from imported material |
| 3 Subscription execution | Codex workspace integration and local app-server/plan adapter; Claude workspace pack | Real authorized turn for each supported mode; streaming/interrupt/resume; tool calls; approval behavior; limit errors; no hidden paid fallback |
| 4 Browser and career | Portable browser setup, official posting sourcing, factual profiles, application review queue | Supported ATS fixture tests; one supervised real prepared form; correct attachment; no unsolicited submit; post-action evidence when authorized |
| 5 Connected productivity | Calendar writes, selected inbox/channels, document export, project workflows and opt-in schedules | Representative provider reads/writes; revision conflicts; duplicate prevention; safe retries; partial failures; fresh-machine installation |
| 6 Broader student life | Meals, budgets, campus/travel, voice, mobile and optional sync | Each feature has a concrete useful workflow, measurable benefit and supported-platform checks |

Use small commits for these stages when authorized. Maintain a compatibility matrix for macOS, Windows and Linux rather than assuming one working laptop proves portability. Public-site deployments stay a separate release action.

## Initial implementation decisions

Recommended starting scope: local dashboard plus MCP/skills, SQLite and managed folders, Avenue reads, daily planning, course tutoring, and internship discovery. Add reviewed external actions after that data flow is reliable. Prefer one agent orchestrator and specialist workflow recipes over many always-running agents.

Resolve the repository's distribution license before an open-source release; no root license was found in this audit. Add complete third-party notices and pinned versions as integrations are introduced. New production dependencies and external configuration remain subject to the repository working agreement.

The remaining uncertainty is in live provider compatibility, institution/session behavior, browser reliability and subscription entitlement. These are test gates in the roadmap, not reasons to promise universal automation. The practical next build is Stage 1 with one complete Stage 2 workflow: refresh Avenue, produce a source-cited day plan, and save reviewed study tasks.
