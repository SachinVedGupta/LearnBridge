# LearnBridge design and delivery guide

This package defines how to build LearnBridge into a local student assistant while preserving the public website. It is an implementation specification, not a claim that the proposed local product already exists. The original source review was October 2, 2026; remote access and adoption-measurement additions were reviewed October 3, 2026. Future implementation must recheck provider contracts before relying on them.

The first useful release is deliberately complete in one narrow workflow: install without cloud keys, connect an existing official agent, approve selected sources, import a course, produce a cited day plan, tutor one topic, and save reviewed next steps. Career, browser, document and connected-app workflows build on the same foundation.

## Read this package in order

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Components, local and hosted boundaries, data flow, storage, agent modes, privacy and engineering decisions |
| [Contracts](CONTRACTS.md) | Entity fields, connector and tool contracts, state transitions, consent and evidence formats |
| [Foundation features](FEATURES_FOUNDATION.md) | Setup, profile, discovery, Today and tasks, calendar, extensibility, agent execution, browser and durable actions |
| [Academic features](FEATURES_ACADEMIC.md) | Courses, library, tutoring, exams, writing and exported artifacts |
| [Productivity features](FEATURES_PRODUCTIVITY.md) | Communications, knowledge, internships, careers, projects and daily life |
| [Remote access and adoption](FEATURES_REMOTE_AND_ADOPTION.md) | Phone requests executed on a paired local agent, public setup funnel and privacy-conscious usage metrics |
| [Controlled onboarding](ONBOARDING.md) | Broad but scoped discovery, profile review, source coverage, consent and deletion |
| [Implementation plan](IMPLEMENTATION_PLAN.md) | Dependency-ordered work packages and release gates for a coding agent |
| [Done list and interactive studios](implementation/DONE_LIST_AND_INTERACTIVE_STUDIOS.md) | Task-linked agent sessions, selected-source reconciliation, slideshow tutoring, mock interviews and reviewed application preparation |
| [AI lecture mode](implementation/AI_LECTURE_MODE.md) | Delivered F08/F11 extension: reviewed selected-slide narration, actual-audio playback, quizzes, clarification, local MP4 and objective release checks |
| [AI lecture verification](implementation/AI_LECTURE_VERIFICATION.json) | Source-bound full suite, actual Codex/narration/video, synthetic browser checks and fresh restore; each proof layer is labeled |
| [Implementation status](IMPLEMENTATION_STATUS.md) | Code delivered, measured foundation evidence and remaining gates |
| [Verification](VERIFICATION.md) | Deterministic fixtures, live checks, quality evaluation and evidence required for completion |
| [Agent setup entry point](../../SETUP_LEARNBRIDGE.md) | Instructions for an agent setting up this repository for a student |
| [Editable architecture diagram](learnbridge-architecture.drawio) | Component and trust boundary overview |

The earlier [vision](../LOCAL_FIRST_VISION.md) explains product intent. This package is the more detailed implementation authority where proposed layouts or milestone labels differ. Existing repository instructions still govern real changes and approvals.

## Feature register

All 29 entries below are target specifications. Some have a smaller hosted predecessor; none should be reported as a completed local feature until its acceptance and live gates pass.

| ID | Feature | Main milestone | Specification |
| --- | --- | --- | --- |
| F01 | Setup and diagnostics | M1 | [Foundation](FEATURES_FOUNDATION.md#f01-setup-and-diagnostics) |
| F02 | Reviewed student profile and memory | M2 | [Foundation](FEATURES_FOUNDATION.md#f02-reviewed-student-profile-and-memory) |
| F03 | Controlled source discovery | M2 | [Foundation](FEATURES_FOUNDATION.md#f03-controlled-source-discovery) |
| F04 | Today view and actionable tasks | M3 | [Foundation](FEATURES_FOUNDATION.md#f04-today-view-and-actionable-tasks) |
| F05 | Calendar and workload planning | M3 then M5 | [Foundation](FEATURES_FOUNDATION.md#f05-calendar-and-workload-planning) |
| F06 | Course and Avenue integration | M2 | [Academic](FEATURES_ACADEMIC.md) |
| F07 | Course library and retrieval | M2 | [Academic](FEATURES_ACADEMIC.md) |
| F08 | Learning tutor | M3 | [Academic](FEATURES_ACADEMIC.md) |
| F09 | Catch up and exam preparation | M3 | [Academic](FEATURES_ACADEMIC.md) |
| F10 | Writing workspace | M4 | [Academic](FEATURES_ACADEMIC.md) |
| F11 | Document and artifact production | M4 | [Academic](FEATURES_ACADEMIC.md) |
| F12 | Inbox and communications | M5 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F13 | Research and knowledge capture | M5 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F14 | Internship discovery | M4 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F15 | Application preparation | M4 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F16 | Career practice | M4 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F17 | Projects and technical teams | M5 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F18 | Meals and groceries | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F19 | Routines and wellbeing | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F20 | Money and administration | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F21 | Campus and travel | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F22 | Monitoring and reminders | M5 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F23 | Voice, capture and optional sync; remote execution covered by F28 | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F24 | Integration and workflow extension system | M1 then incremental | [Foundation](FEATURES_FOUNDATION.md#f24-integration-and-workflow-extension-system) |
| F25 | Existing agent execution | M1 workspace then M3 embedded | [Foundation](FEATURES_FOUNDATION.md#f25-existing-agent-execution) |
| F26 | Browser and computer assistance | M4 browser then M6 desktop | [Foundation](FEATURES_FOUNDATION.md#f26-browser-and-computer-assistance) |
| F27 | Durable workflows and reviewed actions | M1 core then M3 actions | [Foundation](FEATURES_FOUNDATION.md#f27-durable-workflows-and-reviewed-actions) |
| F28 | Phone-to-local agent companion | Optional M3 extension after durable runs and agent execution | [Remote access](FEATURES_REMOTE_AND_ADOPTION.md#f28--phone-to-local-agent-companion) |
| F29 | Website and local setup adoption measurement | M1 web/setup funnel, then M3 opt-in local activation | [Adoption](FEATURES_REMOTE_AND_ADOPTION.md#f29--website-and-local-setup-adoption-measurement) |

The [AI lecture implementation](implementation/AI_LECTURE_MODE.md) extends F08 tutoring and F11 artifacts with bounded selected-PDF lessons and local linear MP4 export. It does not add a feature ID or imply that every target in those specifications is complete. See [implementation status](IMPLEMENTATION_STATUS.md) for shipped boundaries and source-bound evidence.

## Placement of the October 3 additions

F29 starts early with a public setup page and truthful visitor/copy/sign-in metrics; optional local activation reporting follows the first verified agent workflow. F28 follows the full durable review/execution work in W07/W11/W12 as an optional M3 extension. It does not delay Local Student Core and does not require waiting for M6 voice or full sync. Neither addition is implemented by this documentation update.

## Completion rule

Run `node docs/design/validate-design.mjs` from the repository root to check documentation links/anchors, 29 feature specifications, 182 planned feature acceptance cases, 24 work packages, dependency cycles and synthetic examples. This validator checks the design package only; it does not run product tests or prove an unimplemented feature works. [FEATURE_INDEX.json](FEATURE_INDEX.json) provides machine-readable traceability for a coding agent.

For each claimed capability, an agent must link its feature acceptance IDs to test results, observable stored or external outcomes, supported-platform results and unresolved live gates. A successful tool invocation, plausible model answer, mock-only provider test or screenshot of a filled form is insufficient evidence of the full workflow.

Setup success is separate from account access, connector success and AI quality. A student may finish setup with unavailable optional sources; the UI must show the exact missing capability and usable alternatives. See [Verification](VERIFICATION.md) for PASS, FAIL, BLOCKED, SKIP and NOT_IMPLEMENTED meanings.
