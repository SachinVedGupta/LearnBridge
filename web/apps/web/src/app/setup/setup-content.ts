export const SETUP_PROMPT_VERSION = 'local-setup-1-2026-10-03';
export const LEARNBRIDGE_REPOSITORY = 'https://github.com/SachinVedGupta/LearnBridge';
export const SETUP_GUIDE = `${LEARNBRIDGE_REPOSITORY}/blob/main/SETUP_LEARNBRIDGE.md`;
export const LOCAL_GUIDE = `${LEARNBRIDGE_REPOSITORY}/blob/main/docs/LOCAL_SETUP.md`;
export const AGENT_GUIDE = `${LEARNBRIDGE_REPOSITORY}/blob/main/docs/LOCAL_AGENT_SETUP.md`;

// Public, versioned instructions only. Do not interpolate account identity,
// browser URL/query, local paths, configuration or telemetry enrollment here.
export const SETUP_PROMPT = `Set up LearnBridge's private local edition for me.
Repository: ${LEARNBRIDGE_REPOSITORY}
Setup entry point: ${SETUP_GUIDE}
Prompt version: ${SETUP_PROMPT_VERSION}

1. If I have a checkout, inspect and preserve its unrelated changes. Otherwise clone the repository into a new folder I choose. Read AGENTS.md, CODEX_PROJECT.md, README.md, SETUP_LEARNBRIDGE.md, docs/LOCAL_SETUP.md and docs/LOCAL_AGENT_SETUP.md before setup. Use the capabilities present in this checkout; do not claim the entire roadmap is installed.
2. Check Node.js 22.16+, npm and platform support. macOS arm64 is the verified target; Linux is experimental and Windows local storage is unsupported. Preserve existing configuration. Local tasks and notes do not need Supabase, Composio or a model API key. If selected-file acquisition needs Python, inspect the project's .venv first. Create a project-only stdlib environment only if absent and a suitable Python is installed; do not alter global Python.
3. Follow the repository's locked setup instructions. Run npm run setup, npm run test:local, npm run local:setup and npm run local:doctor. Use a private LearnBridge data root outside the repository, not a folder containing my documents. Start with npm run local:start and show the actual loopback address. Let me enter the single-use pairing code in the browser; keep it out of URLs, chat and reports.
4. With disposable synthetic data, verify a saved task and note, restart persistence, authentication refusal before pairing, and backup plus restore into a fresh private workspace. Independently read back record IDs, revisions and text hashes. Never overwrite my real workspace. Return a sanitized receipt listing passed, failed and blocked checks and start/stop/backup instructions.
5. If I choose agent integration, check my installed official Codex or Claude Code host and normal account access. Preview a project-only MCP configuration merge and apply only the reviewed managed entry using its expected input hash. Preserve unrelated settings. Do not modify global agent configuration, copy host credentials, bypass host approvals or substitute a paid API when a subscription fails. Verify actual tool discovery separately from writing configuration.
6. Begin with no personal source or model-sharing grants. Do not search my laptop, read connected apps, university sessions or agent memories during setup. For onboarding, let me choose bounded folders/accounts/courses, review a metadata inventory, select imports, and approve exactly which saved versions may be processed by which agent destination. Local imports are separate from cloud-model processing consent. A denied LearnBridge read is not permission to bypass it with a shell or another connector.
7. Verify an optional agent workflow using only synthetic approved context: status, exact selected read, a pending task proposal, and my exact accept/reject decision. A proposal must create no task before review. Support my learning; do not silently complete restricted graded work or submit applications, send messages, publish, buy anything or change important external data.
8. Explain what is ready and each exact remaining prerequisite. A real D2L/SSO connection requires my institution-compatible login and proof of an actual authorized read. Claude/model access and live integrations are separate gates from fixture tests. Do not enroll analytics or remote access by default. Deletion/revocation may retain historical local snapshots/backups and cannot erase context already shared with a host; explain current documented limits.

Ask only for the choices or consent you actually need. Preserve my files and workflow. Set up and verify existing features; do not build missing roadmap features unless I separately request that work.`;
