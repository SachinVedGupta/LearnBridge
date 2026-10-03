# Codex project instructions

## Scope

- Repository: `https://github.com/SachinVedGupta/LearnBridge`
- Local root: `/Users/sachingupta/Documents/Coding Projects/LearnBridge`
- Read `CODEX_PROJECT.md` and the README before modifying authentication or agents.

## Working agreement

- This is the original Streamlit learning assistant using Google ADK, Classroom, Calendar, and OAuth.
- Prefer current Google API behavior over stale examples; check async/sync boundaries carefully.
- Support learning without silently completing graded assignments.
- Use least-privilege OAuth scopes and never alter Classroom or Calendar data during smoke tests.
- Keep API keys, OAuth clients, tokens, and service-account JSON outside Git and logs.
- Treat the previously committed Google API/service-account credentials as compromised until revoked and rotated.
- Preserve unrelated changes and do not commit, push, deploy, or rewrite history without explicit approval.
- Use `.venv`; avoid modifying global Python or relying on the removed tracked credentials.
- Before completion, validate Python syntax, Streamlit startup, the authentication gate, callback handling, and missing-config errors.
- Ask before changing Google Cloud configuration, scopes, redirect URIs, or production dependencies.

