# LearnBridge engineering guide

## Product direction

LearnBridge is a public student website. Every student must sign in and connect their own accounts. Never expose the developer's Composio CLI accounts, desktop OAuth tokens, or Brightspace MCP session through the web server.

## Current architecture

- `web/apps/web`: Next.js 16 / React 19 application, App Router APIs, TipTap workspace.
- Supabase Auth verifies users server-side; SSR cookies are HTTP-only. API handlers independently authenticate even when the page proxy has already checked login.
- `supabase/migrations`: private student-state tables and atomic per-user hourly usage quotas. App requests use the publishable key plus the user's session, never a service-role bypass.
- Composio Platform: a dedicated project, auth config per provider, private connected accounts owned by the verified Supabase user ID. Server-created sessions pin the account and allowlist read tools. No code execution or instant paid accounts.
- Composio OAuth callback identity verification is mandatory before connection links are enabled. The callback redeems a single-use session URI with the authenticated user ID.
- OpenAI stays server-side. Connected data is not automatically sent to it. Do not treat data-sharing incentives as a guarantee of free or suitable processing of private student data.
- Original Python/Streamlit and Express prototypes remain historical; the website does not start them.

## Run and validate

Use Node 22+, `npm run setup`, `npm test`, `npm run build`, `npm start`. Default preview is loopback port 3200. Copy the web `.env.example` contract into ignored `.env.local`; do not print or commit values. Missing service configuration must fail closed.

Apply the SQL migration to the intended Supabase project and run `supabase/tests/student_isolation.sql` before public rollout. Use two separate student accounts to verify signup, confirmation, login, cloud saves, cross-account denial, callback replay/mismatch rejection and logout. Mock provider tests do not establish live integration success.

## Boundaries

Preserve unrelated local edits. Do not commit, push or deploy without explicit approval. User approved Supabase + Composio service setup and official SDK dependencies in this chat. Credentials and provider consent still belong to the user. D2L requires institution-supported per-user authorization; an installed desktop MCP is not a multi-user backend.

## Original Python prototype

Use `.venv` only. Original entry points: `streamlit_app.py`, `oauth_web_config.py`, `system_root_agent`. Formerly committed credentials remain compromised. Do not restore them. Keep original auth gate/callback/missing-config checks when editing Python; do not change Classroom/Calendar data during smoke tests.
