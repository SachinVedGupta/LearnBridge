# LearnBridge hosting setup

The integration-testing site is live at https://thelearnbridge.vercel.app. The most recent verified deployment in this project is `dpl_DNrY8bSmJUJWUbhLiT5LbC2XomCT` (October 2, 2026 UTC). Google sign-in, persistence, tutor generation, and Google Tasks reading have passed supervised checks. Other provider consents, cross-student acceptance testing, and public-launch requirements remain open.

## Deployment configuration

- New project name: `thelearnbridge`.
- Framework: Next.js. Repository root directory setting: `web/apps/web`.
- Include workspace files outside that root so `web/packages/shared` and the npm lockfile are available.
- Install and build commands are defined in `web/apps/web/vercel.json`.
- Upload only the web workspace via the root `.vercelignore`. Do not upload local environment files, credentials, Python prototypes, or desktop MCP configuration.
- CLI deployments can run independently of GitHub commits. Keep the repository source and deployed version aligned when preparing a release.

## Environment and activation runbook

1. After deployment approval, create/link the project and establish its stable HTTPS origin.
2. Configure the variables in `web/apps/web/.env.example` in the hosting environment. Transfer existing server keys securely without printing them or embedding them in source. Never use a Supabase service-role key for app requests. Set `APP_URL` to the stable HTTPS origin.
3. Keep `COMPOSIO_CALLBACK_VERIFIER_ENABLED=false` until the matching Composio project verifier points to `<origin>/api/connectors/callback`.
4. Configure Supabase Site URL and the exact `<origin>/login` email redirect; retain the preview redirect only while needed. Keep email confirmation enabled. Configure public SMTP before general student signup.
5. Deploy the app with login required. Test a confirmed student login and cloud save, then configure the verifier, enable the flag, and redeploy.
6. Test actual provider consent and reads using the signed-in student's identity, callback mismatch/replay rejection, and a second student's isolation. SQL policy tests and mock provider tests do not replace these checks.

This is an integration-testing release, not a claim of public launch readiness. Password recovery, account deletion, provider revoke controls, public email delivery, spending limits, and real multi-user acceptance checks remain release requirements. D2L still needs institution-approved OAuth credentials; Discord message access needs bot permissions.

Composio requires a public HTTPS verifier; localhost is rejected. A temporary public tunnel is another option for a supervised test, but requires explicit approval to expose the local server and is not the public hosting solution.

References: [Vercel monorepos](https://vercel.com/docs/monorepos), [Composio callback identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts).

## Current verified state

- Production keys uploaded securely as Vercel environment secrets; no local environment files uploaded.
- Supabase Site URL is the live origin; `/login` and `/auth/callback` are allowed.
- Composio callback verifier is the live `/api/connectors/callback`; production flag enabled. Local preview deliberately keeps linking disabled because its session cannot complete at the public callback.
- Live login and health endpoints return 200; anonymous data/connections return 401; foreign-origin Google initiation returns 403. Google initiation sets a Secure, HttpOnly PKCE cookie. Invalid callbacks return to the fixed login page, ignoring arbitrary redirect inputs.
- Google OAuth is configured through Supabase. Keep the provider client secret in Supabase/hosting secret storage; never put OAuth credentials in the repository. Google sign-in was subsequently verified in the live acceptance checks below.
- Google OAuth audience initially starts in Testing; verify and configure publication before general availability.

## Live acceptance checks — October 2, 2026 UTC

- Google login completed in the public website with the user's account. A real Supabase user and signed-in workspace were verified.
- Saved a temporary setup task and sample draft; both reappeared after page reload. The sample draft is titled LearnBridge setup check.
- Tutor returned an actual OpenAI answer to a synthetic stacks/queues question.
- Google Tasks completed Composio authorization and returned to the verified user's session; the website listed that account and successfully read its task lists. No external tasks were modified.
- Fixed a live-only Composio incompatibility: the execution-level `account` option is not enabled on this project. The session remains pinned to the selected, ownership-checked account via `connectedAccounts`; execution now omits that redundant option. Regression check added; all 11 tests and production build pass.
- Google OAuth audience was still in Testing at this checkpoint. Confirm its current publication and verification requirements before opening signup broadly. General public launch is not complete; additional providers and callback replay/mismatch still need live checks.
