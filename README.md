# LearnBridge

**[TRY IT NOW — LIVE](https://thelearnbridge.vercel.app/)**

LearnBridge is a web app for students that brings together AI tutoring, course planning, assignment drafting, and personal productivity tools. The goal is to give each student one private workspace for learning across the apps they already use.

## Local student workspace

The local edition provides a private student dashboard with tasks, notes, reviewed profile facts, a cited course library, study plans, learning attempts, writing alternatives, research reports, career preparation, project checklists, meals and routines. Selected text/Markdown, macOS PDF, Word and PowerPoint imports preserve exact source versions and page, paragraph or slide evidence. Office text is partial and requires review of the original for visual content. Records use revision checks, restart persistence, backups and fresh-workspace restore. It runs without Supabase, Composio or AI API keys. The public website remains available as a separate edition.

Requires Node.js **22.16 or newer**. macOS arm64 is the verified foundation target; Linux is experimental and Windows local storage is not supported yet.

```sh
npm run setup
npm run local:setup
npm run local:start
```

Open the loopback address shown by the launcher, normally `http://127.0.0.1:3210`, and enter its single-use pairing code. For a disposable sample workspace, use `npm run local:demo`. Read [local setup, backup and recovery](docs/LOCAL_SETUP.md) for commands and boundaries.

Start with **Get started** in the local dashboard. Choose your purpose and the saved records you want to check, review gaps and next steps, then save a local coverage report. It links to Profile, Sources, Courses and Agent review. All selections begin unchecked; it does not scan your laptop or accounts, grant sharing or test an AI connection. See [guided onboarding](docs/design/implementation/GUIDED_ONBOARDING.md) for the exact behavior.

The **Codex/Claude stdio MCP bridge** exposes status, selected context, pending task proposals and pending writing proposals. It uses your official agent host and subscription, with separate destination-specific sharing consent and human review. LearnBridge does not copy agent credentials or provide an API fallback. Follow [agent and source setup](docs/LOCAL_AGENT_SETUP.md), or have your coding agent read the [LearnBridge student skill](.agents/skills/learnbridge-student/SKILL.md). Pairing alone does not connect an AI or scan your files. An embedded Codex chat is still disabled pending its actual host compatibility check.

Avenue/D2L supports reviewed academic exports and an independently implemented read-only MCP adapter. Re-imports compare deadlines, additions, missing items and conflicts before saving; unchanged content avoids duplicates, current search excludes stale material, and earlier versions remain in explicit history. [Academic refresh](docs/design/implementation/ACADEMIC_REFRESH.md) preserves manual tasks and notes. Live institution login, broad cloud onboarding and general computer automation remain separate implementation gates. Profile facts require explicit review; tutoring recipes contain cited context and instructions until your host generates an answer. Career tools prepare drafts and practice without submitting applications. No university token is accepted by the public website or local dashboard.

Read the [local student assistant blueprint](docs/LOCAL_FIRST_VISION.md) for the feature catalogue, architecture, audited integration choices, and implementation acceptance checks.

The [detailed design and implementation guide](docs/design/README.md) specifies 29 features, controlled onboarding, shared contracts, a staged build plan and objective verification. The new `/setup` route in this checkout offers a copyable agent setup prompt. Optional [phone access and adoption measurement](docs/design/FEATURES_REMOTE_AND_ADOPTION.md) have disabled protocol foundations. Disposable database isolation and recovery checks passed; live Supabase/session, provider and device release gates remain pending. Give your coding agent [SETUP_LEARNBRIDGE.md](SETUP_LEARNBRIDGE.md) as its setup entry point.

See [implementation status](docs/design/IMPLEMENTATION_STATUS.md), the [foundation verification](docs/design/implementation/LOCAL_FOUNDATION_VERIFICATION.json) and [agent/source verification](docs/design/implementation/AGENT_SOURCE_VERIFICATION.json) for measured evidence and remaining gates. Deleting a local note removes it from active views and search; historical text may remain in the local database and backups. Selective physical erasure is not implemented.

## Public website

- Student sign-in and private, account-isolated task and draft storage.
- AI tutor and reviewed writing suggestions, subject to the deployed service configuration and usage limits.
- Student-owned connections for Gmail, Google Calendar/Tasks/Drive/Docs/Sheets/Slides, Microsoft Teams/OneDrive/Excel, Notion, Discord, GitHub, Linear, Slack, Reddit, LinkedIn, and Instagram. Each student grants access through the provider. Available reads vary; some accounts can link but still need source selection before the tutor can use their content. X awaits owner OAuth setup.
- The tutor can search and read student-selected Gmail, Calendar, Tasks, Drive, Docs, Sheets, Slides, Teams, OneDrive, Excel, Notion, GitHub, Linear, Slack, and Reddit connections. Students choose the accounts for each question; nothing is shared with the tutor by default. These integrations are read-only in the tutor.
- The tutor keeps a short follow-up conversation in the browser and can propose up to three study tasks. A student must choose “Add to next steps” before a proposal is saved to LearnBridge.
- Discord, X, Instagram, and LinkedIn can connect where configured, but their content-reading tools are not enabled in the tutor yet. Linking an account does not imply that LearnBridge can search its content.

### Connected-source controls

The tutor creates a short-lived Composio session for the signed-in student and the accounts explicitly selected for a question. Its tool allowlist contains only content-search/read operations. The app does not expose message sending, document editing, calendar/task writes, or account-management tools to the model. Tutor chat history is held in the browser and sent only with the follow-up request; OpenAI Responses are sent with storage disabled.

LearnBridge is under active development. D2L/Brightspace still needs an institution-approved integration. Check the live Connections page and the [hosting and verification notes](docs/HOSTING.md) for current provider limitations and release status.

## Develop the hosted website locally

This starts the cloud-backed website development edition on port 3200. It is separate from the private local dashboard above. Requires Node.js 22.16 or newer for this workspace.

```sh
npm run setup
npm test
npm run build
npm start
```

Open http://127.0.0.1:3200. Use `npm run dev` for development. The full test suite also requires the project Python environment described in [agent/source setup](docs/LOCAL_AGENT_SETUP.md#student-setup). Copy `web/apps/web/.env.example` to the ignored `web/apps/web/.env.local` only when that file is absent; preserve existing configuration. Configure the services you want to run locally. Never commit API keys, OAuth secrets, or tokens.

## Project structure

- `web/apps/web`: student website and server APIs.
- `web/apps/local`: static private-workspace dashboard.
- `web/apps/local-runtime`: loopback service and setup/control commands.
- `web/packages/core`: edition-independent data contracts and hosted-task migration planner.
- `web/packages/local-storage`: private SQLite tasks, notes, revisions and backups.
- `web/packages/local-sources`: selected text/Markdown/PDF/Office inventory, anchored acquisition, native macOS PDF text extraction and bounded standard-library DOCX/PPTX imports.
- `web/packages/local-academic`: reviewed academic exports and an allowlisted Avenue/D2L read adapter.
- `web/packages/shared`: shared tutor and editor contracts.
- `supabase`: database migration and student-isolation test.
- `web/scripts`: provider and OAuth boundary tests.
- `streamlit_app.py`, `system_root_agent`, `oauth_web_config.py`: original Python/Streamlit prototype.
- `LearnBridge2`: separate historical repository for the editor prototype.

## Deprecated README

The image below is from the original LearnBridge demo. The archived README retains its original project description, demo and setup notes.

<img width="392" height="573" alt="Original LearnBridge demo visual" src="https://github.com/user-attachments/assets/9149d8d3-61a8-4da5-988d-6b301369c69e" />

[Read the deprecated README](OLD_README.md)
