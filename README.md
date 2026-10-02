# LearnBridge

**[TRY IT NOW — LIVE](https://thelearnbridge.vercel.app/)**

LearnBridge is a web app for students that brings together AI tutoring, course planning, assignment drafting, and personal productivity tools. The goal is to give each student one private workspace for learning across the apps they already use.

## What works today

- Student sign-in and private, account-isolated task and draft storage.
- AI tutor and reviewed writing suggestions, subject to the deployed service configuration and usage limits.
- Student-owned connections for Gmail, Google Calendar/Tasks/Drive/Docs/Sheets/Slides, Microsoft Teams/OneDrive/Excel, Notion, Discord, GitHub, Linear, Slack, Reddit, LinkedIn, and Instagram. Each student grants access through the provider. Available reads vary; some accounts can link but still need source selection before the tutor can use their content. X awaits owner OAuth setup.
- The tutor can search and read student-selected Gmail, Calendar, Tasks, Drive, Docs, Sheets, Slides, Teams, OneDrive, Excel, Notion, GitHub, Linear, Slack, and Reddit connections. Students choose the accounts for each question; nothing is shared with the tutor by default. These integrations are read-only in the tutor.
- Discord, X, Instagram, and LinkedIn can connect where configured, but their content-reading tools are not enabled in the tutor yet. Linking an account does not imply that LearnBridge can search its content.

### Connected-source controls

The tutor creates a short-lived Composio session for the signed-in student and the accounts explicitly selected for a question. Its tool allowlist contains only content-search/read operations. The app does not expose message sending, document editing, calendar/task writes, or account-management tools to the model. Tutor chat history is held in the browser and sent only with the follow-up request; OpenAI Responses are sent with storage disabled.

LearnBridge is under active development. D2L/Brightspace still needs an institution-approved integration. Check the live Connections page and the [hosting and verification notes](docs/HOSTING.md) for current provider limitations and release status.

## Run locally

Requires Node.js 22 or newer.

```sh
npm run setup
npm test
npm run build
npm start
```

Open http://127.0.0.1:3200. Use `npm run dev` for development. Copy `web/apps/web/.env.example` to the ignored `web/apps/web/.env.local` and configure the services you want to run locally. Never commit API keys, OAuth secrets, or tokens.

## Project structure

- `web/apps/web`: student website and server APIs.
- `web/packages/shared`: shared tutor and editor contracts.
- `supabase`: database migration and student-isolation test.
- `web/scripts`: provider and OAuth boundary tests.
- `streamlit_app.py`, `system_root_agent`, `oauth_web_config.py`: original Python/Streamlit prototype.
- `LearnBridge2`: separate historical repository for the editor prototype.

## Deprecated README

The image below is from the original LearnBridge demo. The archived README retains its original project description, demo and setup notes.

<img width="392" height="573" alt="Original LearnBridge demo visual" src="https://github.com/user-attachments/assets/9149d8d3-61a8-4da5-988d-6b301369c69e" />

[Read the deprecated README](OLD_README.md)
