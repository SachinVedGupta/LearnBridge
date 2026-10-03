# LearnBridge design and delivery guide

This package defines how to build LearnBridge into a local student assistant while preserving the public website. It is an implementation specification, not a claim that the proposed local product already exists. Source and provider assumptions were reviewed on October 2, 2026. Future implementation must recheck provider contracts before relying on them.

The first useful release is deliberately complete in one narrow workflow: install without cloud keys, connect an existing official agent, approve selected sources, import a course, produce a cited day plan, tutor one topic, and save reviewed next steps. Career, browser, document and connected-app workflows build on the same foundation.

## Read this package in order

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Components, local and hosted boundaries, data flow, storage, agent modes, privacy and engineering decisions |
| [Contracts](CONTRACTS.md) | Entity fields, connector and tool contracts, state transitions, consent and evidence formats |
| [Foundation features](FEATURES_FOUNDATION.md) | Setup, profile, discovery, Today and tasks, calendar, extensibility, agent execution, browser and durable actions |
| [Academic features](FEATURES_ACADEMIC.md) | Courses, library, tutoring, exams, writing and exported artifacts |
| [Productivity features](FEATURES_PRODUCTIVITY.md) | Communications, knowledge, internships, careers, projects and daily life |
| [Controlled onboarding](ONBOARDING.md) | Broad but scoped discovery, profile review, source coverage, consent and deletion |
| [Implementation plan](IMPLEMENTATION_PLAN.md) | Dependency-ordered work packages and release gates for a coding agent |
| [Implementation status](IMPLEMENTATION_STATUS.md) | Code delivered, measured foundation evidence and remaining gates |
| [Verification](VERIFICATION.md) | Deterministic fixtures, live checks, quality evaluation and evidence required for completion |
| [Agent setup entry point](../../SETUP_LEARNBRIDGE.md) | Instructions for an agent setting up this repository for a student |
| [Editable architecture diagram](learnbridge-architecture.drawio) | Component and trust boundary overview |

The earlier [vision](../LOCAL_FIRST_VISION.md) explains product intent. This package is the more detailed implementation authority where proposed layouts or milestone labels differ. Existing repository instructions still govern real changes and approvals.

## Feature register

All 27 entries below are target specifications. Some have a smaller hosted predecessor; none should be reported as a completed local feature until its acceptance and live gates pass.

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
| F23 | Voice and mobile companion | M6 | [Productivity](FEATURES_PRODUCTIVITY.md) |
| F24 | Integration and workflow extension system | M1 then incremental | [Foundation](FEATURES_FOUNDATION.md#f24-integration-and-workflow-extension-system) |
| F25 | Existing agent execution | M1 workspace then M3 embedded | [Foundation](FEATURES_FOUNDATION.md#f25-existing-agent-execution) |
| F26 | Browser and computer assistance | M4 browser then M6 desktop | [Foundation](FEATURES_FOUNDATION.md#f26-browser-and-computer-assistance) |
| F27 | Durable workflows and reviewed actions | M1 core then M3 actions | [Foundation](FEATURES_FOUNDATION.md#f27-durable-workflows-and-reviewed-actions) |

## Completion rule

Run `node docs/design/validate-design.mjs` from the repository root to check documentation links/anchors, 27 feature specifications, 160 planned feature acceptance cases, 22 work packages, dependency cycles and synthetic examples. This validator checks the design package only; it does not run product tests or prove an unimplemented feature works. [FEATURE_INDEX.json](FEATURE_INDEX.json) provides machine-readable traceability for a coding agent.

For each claimed capability, an agent must link its feature acceptance IDs to test results, observable stored or external outcomes, supported-platform results and unresolved live gates. A successful tool invocation, plausible model answer, mock-only provider test or screenshot of a filled form is insufficient evidence of the full workflow.

Setup success is separate from account access, connector success and AI quality. A student may finish setup with unavailable optional sources; the UI must show the exact missing capability and usable alternatives. See [Verification](VERIFICATION.md) for PASS, FAIL, BLOCKED, SKIP and NOT_IMPLEMENTED meanings.
