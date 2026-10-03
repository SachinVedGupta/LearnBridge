# Set up LearnBridge with a coding agent

This is the entry point for a student who gives this repository to Codex, Claude Code or another coding agent. The private local foundation now exists: a paired dashboard for manual tasks and notes, SQLite persistence, diagnostics and backup/restore. The public website remains a separate edition. The local agent MCP bridge, Avenue/app sources, student profile and workflow orchestration are not built yet. An agent must use the actual capabilities and commands in this checkout rather than report the whole vision installed.

## Prompt a student can give their agent

> Read SETUP_LEARNBRIDGE.md, docs/LOCAL_SETUP.md and the repository instructions. Set up the private local foundation for my computer. Preserve my settings and files. Use synthetic data to verify pairing, saved tasks/notes, restart persistence and backup/restore. Show what works and what is missing, with evidence. Do not configure global agent settings, search my laptop, read connected apps or send private content to a model during foundation setup. When source onboarding and the MCP bridge become available, let me approve a bounded discovery and processing plan before using them. Let me review profile facts and consequential actions. Build missing capabilities only if I ask you to implement them.

This prompt requests setup, not application submission, messages, purchases, calendar changes, hidden memory reads or publication. The student's later explicit authorization can grant appropriate bounded actions; the agent must still respect host rules.

## Agent instructions for this checkout today

1. Read `AGENTS.md` if present, `CODEX_PROJECT.md`, `README.md` and [the design index](docs/design/README.md). Check the working tree and root/workspace package manifests without reading credential values. Preserve unrelated changes.
2. Explain the available choices: use [the public website](https://thelearnbridge.vercel.app/), install the private local foundation, or run the hosted website for development with its cloud configuration. Recommend the local foundation for the local-workspace request. It does not yet connect the student's Codex/Claude subscription.
3. Verify Node.js **22.16+**, npm and platform support. macOS arm64 is the verified foundation target; Linux is experimental and Windows private local storage is rejected. Follow [local setup](docs/LOCAL_SETUP.md):

   ```sh
   npm run setup
   npm run test:local
   npm run local:setup
   npm run local:doctor
   npm run local:start
   ```

   Choose the private data root outside the repository. Use the default or an explicitly selected new/recognized LearnBridge folder; never point setup at a student document directory. The launcher stays in the foreground and displays its actual loopback origin and a single-use pairing code. Have the student pair through the form; never place that code in a URL, report or chat. Basic local use needs no cloud keys. Preserve existing website configuration.
4. For a first look, `npm run local:demo` starts a disposable synthetic workspace, which normal shutdown removes. For persistence verification, use a separate synthetic installation, save task/note fixtures, stop/restart, pair again and independently read the same IDs, dates/status, text and hashes. Run the backup/fresh-restore checks in [the setup guide](docs/LOCAL_SETUP.md#agent-verification-checklist). Report outcomes and remaining gates individually. See [implementation status](docs/design/IMPLEMENTATION_STATUS.md) and [local foundation evidence](docs/design/implementation/LOCAL_FOUNDATION_VERIFICATION.json). No personal scan or live model call is needed.
5. For hosted website development, use:

   ```sh
   npm run setup
   npm test
   npm run build
   npm start
   ```

   The hosted development site serves at `http://127.0.0.1:3200` by default. Use `npm run dev` during development. Respect existing `.env.local`; do not overwrite it. If configuration is missing, copy the example only into an absent ignored file and let the student fill secret values through the appropriate secure flow. Never print them. Student sign-in and provider account consent remain necessary. Do not connect a developer's desktop or university sessions to the public backend.
6. Do not modify global Codex/Claude settings or claim MCP discovery during this foundation setup; no local MCP server/config generator exists yet. The shared core still has `npm run test:core` and `npm run demo:core`. Those demonstrate contracts independently and do not prove a live integration. `npm test` includes local/core fixtures and hosted boundary tests; live account behavior remains a separate gate.
7. If asked to build the next local capabilities, follow [W06 onward](docs/design/IMPLEMENTATION_PLAN.md#m1-local-foundation) and the [status page](docs/design/IMPLEMENTATION_STATUS.md). Production dependencies, external configuration and releases follow repository approval rules. Preserve unrelated code/data and do not infer authorization for a personal scan from an implementation request.
8. Do not change global Python; historical Streamlit work uses `.venv` and its own validation. Do not restore compromised tracked credentials.

## Remaining setup and onboarding capabilities

The foundation commands above are implemented. The agent-registration and personal-source onboarding behavior below remains an implementation contract for later slices, not a list of currently available integrations.

### Diagnose and plan

Detect platform, supported runtime, installation root, existing agent/client versions, browser availability and optional artifact processors. Inspect explicit configuration files only as necessary for reviewed merges; never discover authentication by searching secret stores. Present install/config changes and supported modes. Choose local data storage outside the repository. Basic setup must not require the owner to create Supabase/Composio projects for every student.

Offer a short fixture demo first. Student sources and inference are optional. If a dependency needs elevated OS permission, a login needs MFA, or a provider needs consent, identify the exact manual action; do not guess passwords or bypass it. One manual sign-in/permission handoff is a capability prerequisite, not an installation failure.

### Connect the official agent

Prefer project-scoped LearnBridge MCP/skill registration for the student's installed official Codex or Claude Code. Preview a merge and keep unrelated servers/model/permissions unchanged. Never overwrite global instructions or use flags that skip permission checks. Keep a reversible config backup without secrets.

Verify discovery and an actual synthetic workflow, not merely that a config file was written. State where work runs: official host session or embedded local adapter. The student's plan/limits apply. A paid API mode is separately selected; it is not a fallback when a subscription fails. Host-connected apps can be used by the host recipe when authorized, but are not automatically embedded dashboard connectors.

### Verify the implemented foundation for each setup

Start the loopback runtime, pair the dashboard, save a synthetic task and note, stop/restart, and read them back. Verify private requests fail without pairing, cross-origin attempts fail and missing optional integrations appear honestly. Run the local security/recovery fixtures and write a sanitized report. Protect the hosted edition through existing regression checks. No agent/provider child is launched by this slice; child-environment enforcement must be verified when an agent adapter is added.

### Onboard with student-selected sources

Use [the controlled onboarding playbook](docs/design/ONBOARDING.md). Begin with no private source grants. Ask the student to select relevant categories and specific roots/accounts/collections. They can approve broad selected roots in bounded batches; they do not have to choose every file individually. Show inventory counts/size/exclusions locally before content extraction.

Potential sources include school/project folders, selected Drive/Notion/Office documents, selected mail/chat windows, chosen GitHub repositories and website pages, selected Avenue courses, and deliberately exported agent profile/memory files. University/provider login happens through official user flows. Access to ChatGPT/Claude usage does not imply access to their account conversations or memories; manual exports or explicitly available authorized host sources are optional.

Get separate local-content and cloud-model processing grants. Tool results sent to a cloud-backed host already count as remote processing. Before that grant, give the host only permitted status/counts and opaque references, not personal filenames/content. The local runtime performs deterministic inventory/extraction and scope checks. The agent must not replace a denied LearnBridge read with a direct shell or host connector call.

Review proposed identity, courses, goals, routine/workflow constraints and career facts with evidence. Keep conflicts/staleness/unknown eligibility unresolved until the student confirms. Accept selected fields, not everything automatically. Produce source coverage and unresolved questions. Save confirmed facts locally and expose only purpose-appropriate fields to future requests.

### Complete one useful workflow

Choose one available workflow with the student: plan today's academic work, tutor a selected topic, prepare an internship shortlist, or organize a reviewed draft. Use actual selected sources and record evidence. Confirm accepted local state after restart. Keep external effects proposed until properly authorized and verified.

## Setup receipt

Return a concise receipt with:

- Edition, supported OS/client/runtime versions and private data root category.
- Capabilities ready, unavailable or needing a specific student action; distinguish connection from successful read/write.
- Tests passed/failed/blocked and sanitized evidence report path.
- Onboarding scopes/processing choices, confirmed profile fields and coverage gaps; never raw secrets or unselected content.
- How to start/stop and back up/restore this installation. Explain that uninstall retains data and that deletion hides active records while note history/backups can retain text. Source revoke, selective physical purge and generated agent configuration are not available in this foundation.
- One useful verified workflow and the next concrete step.

If an expected command or capability is absent in another checkout, say so and use only its actual implementation. Do not fabricate a successful install, integration or complete profile from this document alone.
