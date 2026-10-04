# Set up LearnBridge with a coding agent

This repository also includes a [LearnBridge student skill](.agents/skills/learnbridge-student/SKILL.md). Codex can discover it in the project; Claude or another coding agent can read that same file explicitly. It routes setup, source selection, learning and reviewed proposals to the current implementation without installing global settings.

This is the entry point for a student who gives this repository to Codex, Claude Code or another coding agent. The local edition includes a paired dashboard, private SQLite storage, diagnostics/backup, a four-tool project-scoped stdio MCP bridge, exact task/writing proposal review, selected text/Markdown, macOS PDF and bounded DOCX/PPTX acquisition, reviewed academic exports and deterministic student workflows. Read [agent/source setup](docs/LOCAL_AGENT_SETUP.md). The public website is separate. Live institution login, cloud-source onboarding, automatic profile synthesis and general autonomous orchestration remain unfinished. [Phone-to-local access and adoption measurement](docs/design/FEATURES_REMOTE_AND_ADOPTION.md) have separate release gates. The repository's public `/setup` page supplies a versioned Copy setup prompt, with measurement disabled; copy success is not an installation. Setup/doctor do not report local usage by default. Account linking, relay access and telemetry require separate explicit choices. Use actual capabilities rather than report the whole vision installed.

## Prompt a student can give their agent

> Read SETUP_LEARNBRIDGE.md, docs/LOCAL_SETUP.md, agents/WORKSPACE.md and the repository instructions. Set up the private local edition for my computer. Preserve my existing settings, data and files. Use synthetic data to verify pairing, saved tasks/notes, one available student workflow, restart persistence and backup/restore. Show what works and what is missing, with evidence. Do not configure global agent settings, search my laptop, read connected apps or send private content to a model during setup. Before selected source imports or host-model processing, let me approve a bounded source/destination/record/time/byte plan. Keep task and writing proposals pending for my exact review. Confirm profile facts individually and use only selected current facts for the chosen purpose. Build missing capabilities only if I ask you to implement them.

This prompt requests setup, not application submission, messages, purchases, calendar changes, hidden memory reads or publication. The student's later explicit authorization can grant appropriate bounded actions; the agent must still respect host rules.

## Agent instructions for this checkout today

1. Read `AGENTS.md` if present, `CODEX_PROJECT.md`, `README.md` and [the design index](docs/design/README.md). Check the working tree and root/workspace package manifests without reading credential values. Preserve unrelated changes.
2. Explain the available choices: use [the public website](https://thelearnbridge.vercel.app/), install the private local edition, or run the hosted website for development with its cloud configuration. The local MCP bridge can connect the student's official Codex/Claude host; normal account access, project trust and explicitly reviewed sharing are still required.
3. Verify Node.js **22.16+**, npm and platform support. macOS arm64 is the verified foundation target; Linux is experimental and Windows private local storage is rejected. Before the full local/test suite, check the project `.venv/bin/python3` prerequisite in [agent/source setup](docs/LOCAL_AGENT_SETUP.md#student-setup). Preserve an existing environment. If absent, create it with a suitable installed Python using `python3 -m venv --without-pip .venv`; no acquisition packages or global Python changes are needed. If native directory-FD/no-follow support is unavailable, report source acquisition and its full verification as blocked; basic tasks/notes can still run. Follow [local setup](docs/LOCAL_SETUP.md):

   ```sh
   npm run setup
   npm run test:local
   npm run local:setup
   npm run local:doctor
   npm run local:start
   ```

   Choose the private data root outside the repository. Use the default or an explicitly selected new/recognized LearnBridge folder; never point setup at a student document directory. The launcher stays in the foreground and displays its actual loopback origin and a single-use pairing code. Have the student pair through the form; never place that code in a URL, report or chat. Basic local use needs no cloud keys. Preserve existing website configuration.
4. For a first look, `npm run local:demo` starts a disposable synthetic workspace, which normal shutdown removes. For persistence verification, use a separate synthetic installation, save task/note fixtures and one selected-source workflow, stop/restart, pair again and independently read the same IDs, dates/status, text and hashes. Run the backup/fresh-restore checks in [the setup guide](docs/LOCAL_SETUP.md#agent-verification-checklist). Report outcomes and remaining gates individually. See [implementation status](docs/design/IMPLEMENTATION_STATUS.md) and [local foundation evidence](docs/design/implementation/LOCAL_FOUNDATION_VERIFICATION.json). No personal scan or live model call is needed.
5. For hosted website development, use:

   ```sh
   npm run setup
   npm test
   npm run build
   npm start
   ```

   The hosted development site serves at `http://127.0.0.1:3200` by default. Use `npm run dev` during development. `npm test` includes source-worker checks and requires the same project Python prerequisite as step 3. Respect existing `.env.local`; do not overwrite it. If configuration is missing, copy the example only into an absent ignored file and let the student fill secret values through the appropriate secure flow. Never print them. Student sign-in and provider account consent remain necessary. Do not connect a developer's desktop or university sessions to the public backend.
6. For agent setup, follow [LOCAL_AGENT_SETUP.md](docs/LOCAL_AGENT_SETUP.md): preview/apply project-only configuration with an expected input hash; preserve unrelated settings and refuse unmanaged collisions. Never modify global Codex/Claude settings. If an older managed entry exposes three tools, regenerate through this reviewed merge instead of replacing the whole file. Verify actual discovery of `learnbridge_status`, `learnbridge_context`, `learnbridge_propose_task` and `learnbridge_propose_document`, then a synthetic read/propose/review workflow separately. `npm test` includes local/core/academic fixtures and hosted boundary tests; live host/provider behavior remains a separate gate. Embedded invocation/protocol work is not enabled solely because its files or fixtures exist; check the runtime capability and measured real-host evidence.
7. If asked to build the next local capabilities, follow [W06 onward](docs/design/IMPLEMENTATION_PLAN.md#m1-local-foundation) and the [status page](docs/design/IMPLEMENTATION_STATUS.md). Production dependencies, external configuration and releases follow repository approval rules. Preserve unrelated code/data and do not infer authorization for a personal scan from an implementation request.
8. Do not change global Python. Controlled file acquisition uses a fixed isolated stdlib worker in the repository's `.venv`, with no Python packages required. Preserve an existing environment; if absent, create a project-only venv as described in agent setup. Historical Streamlit work retains its own validation. Do not restore compromised tracked credentials.

## Available student workflows and remaining onboarding

Foundation commands, project configuration, bounded MCP context/task/writing proposals, selected local text imports, purpose-limited reviewed profiles and reviewed academic exports are implemented. The dashboard also provides local study planning, selected-evidence learning recipes and student checkpoints, reviewed writing/Markdown artifacts, selected-source research, manual career drafts/practice, exact pantry/grocery/routine/expense flows, and selected-update/project/reminder recipes. See the [capability and limits table](docs/LOCAL_AGENT_SETUP.md#use-the-local-student-workflows). These workflows persist and have deterministic/HTTP recovery checks; they do not embed every provider or complete the feature vision.

For example, Productivity can quote only your explicitly selected saved records into a briefing. Unselected mail/news and live freshness remain unknown. A task proposal needs a literal source quote; “next week” keeps an unresolved date unless you choose one. Acceptance is exact and idempotent, and a changed source invalidates old review. Recurring reminders start paused and run only when you invoke a paired manual due check. Career does not submit/send, Daily life does not purchase/book or claim medical/financial guarantees, and Writing does not establish factual correctness or a successful browser download merely from prepared bytes.

The broader personal/cloud onboarding, live institution login, automatic profile synthesis and autonomous execution below remain staged contracts; use the setup guide to distinguish current operations from future ones.

Start with **Get started** in the paired local dashboard. Its purpose/category/record selectors inspect existing saved metadata and show the next steps to Profile, Sources, Courses and Agent review. Save a coverage report only after reviewing the exact selection and limitations. That report grants no sharing, confirms no profile fact and tests no host login or model turn. Student imports, reviewed profile statements and sharing remain separate steps. See the [implemented onboarding contract](docs/design/implementation/GUIDED_ONBOARDING.md); the broader playbook below still contains future cloud/discovery work.

### Diagnose and plan

Detect platform, supported runtime, installation root, existing agent/client versions, browser availability and optional artifact processors. Inspect explicit configuration files only as necessary for reviewed merges; never discover authentication by searching secret stores. Present install/config changes and supported modes. Choose local data storage outside the repository. Basic setup must not require the owner to create Supabase/Composio projects for every student.

Offer a short fixture demo first. Student sources and inference are optional. If a dependency needs elevated OS permission, a login needs MFA, or a provider needs consent, identify the exact manual action; do not guess passwords or bypass it. One manual sign-in/permission handoff is a capability prerequisite, not an installation failure.

### Connect the official agent

Prefer project-scoped LearnBridge MCP/skill registration for the student's installed official Codex or Claude Code. Preview a merge and keep unrelated servers/model/permissions unchanged. Never overwrite global instructions or use flags that skip permission checks. Keep a reversible config backup without secrets.

Verify discovery and an actual synthetic workflow, not merely that a config file was written. State where work runs: official host session or embedded local adapter. The student's plan/limits apply. A paid API mode is separately selected; it is not a fallback when a subscription fails. Host-connected apps can be used by the host recipe when authorized, but are not automatically embedded dashboard connectors.

### Verify the implemented foundation for each setup

Start the runtime, pair the dashboard, save synthetic records, stop/restart, and read them back. Verify unpaired/cross-origin refusal and optional capabilities. Then register a synthetic source, inventory metadata, import only a chosen file, grant separate destination processing and verify the SDK/host read plus pending proposal and exact human acceptance. Run security/recovery fixtures and write a sanitized report. Source workers and MCP children have bounded environments and lifecycle checks. Protect the hosted edition with regression checks.

### Onboard with student-selected sources

Use [the controlled onboarding playbook](docs/design/ONBOARDING.md). Begin with no private source grants. Ask the student to select relevant categories and specific roots/accounts/collections. They can approve broad selected roots in bounded batches; they do not have to choose every file individually. Show inventory counts/size/exclusions locally before content extraction.

Potential sources include school/project folders, selected Drive/Notion/Office documents, selected mail/chat windows, chosen GitHub repositories and website pages, selected Avenue courses, and deliberately exported agent profile/memory files. University/provider login happens through official user flows. Access to ChatGPT/Claude usage does not imply access to their account conversations or memories; manual exports or explicitly available authorized host sources are optional.

Get separate local-content and cloud-model processing grants. Tool results sent to a cloud-backed host already count as remote processing. Before that grant, give the host only permitted status/counts and opaque references, not personal filenames/content. The local runtime performs deterministic inventory/extraction and scope checks. The agent must not replace a denied LearnBridge read with a direct shell or host connector call.

Review proposed identity, courses, goals, routine/workflow constraints and career facts with evidence. The current Profile page supports student statements or exact saved-document evidence, individual confirmation/correction, expiry and conflict checks. Keep conflicts/staleness/unknown eligibility unresolved until the student confirms. Accept selected fields, not everything automatically. Produce source coverage and unresolved questions. Preview/export only selected current facts for a purpose, then separately grant that exact exported note to a host if requested. Confirmation and export are not cloud-sharing consent. Existing exported notes, revision history and backups can retain earlier copies after a fact is forgotten.

### Complete one useful workflow

Choose one available workflow with the student: plan today's academic work, tutor a selected topic, prepare an internship shortlist, or organize a reviewed draft. Use actual selected sources and record evidence. Confirm accepted local state after restart. Keep external effects proposed until properly authorized and verified.

## Setup receipt

Return a concise receipt with:

- Edition, supported OS/client/runtime versions and private data root category.
- Capabilities ready, unavailable or needing a specific student action; distinguish connection from successful read/write.
- Tests passed/failed/blocked and sanitized evidence report path.
- Onboarding scopes/processing choices, confirmed profile fields and coverage gaps; never raw secrets or unselected content.
- How to start/stop and back up/restore this installation. Uninstall retains data; deletion hides active records while history/backups can retain text. Source/sharing revoke blocks future reads but retains saved snapshots and cannot erase already shared host context. Generated project registration can be removed by editing only the managed entry. Selective physical purge remains unavailable.
- One useful verified workflow and the next concrete step.

If an expected command or capability is absent in another checkout, say so and use only its actual implementation. Do not fabricate a successful install, integration or complete profile from this document alone.
