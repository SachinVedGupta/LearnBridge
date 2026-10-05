import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '@learnbridge/local-storage';
import { LearnBridgeError } from '@learnbridge/core';
import { assertLocalRequest, createSessionPolicy, HttpError, plainBody, readJson } from './policy.mjs';
import { startControl } from './ipc.mjs';
import { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, readSelectedPdfAsset, readSelectedOffice, probeSourceCapability, probePdfCapability, probeOfficeCapability } from '../../../packages/local-sources/src/index.mjs';
import { AcademicError } from '../../../packages/local-academic/src/index.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { createStudentWorkspace } from './student-workspace.mjs';
import { workflowHash } from './workflows.mjs';
import { handleCareerRoute } from './career-routes.mjs';
import { createPublicJobService } from './public-job-service.mjs';
import { handlePublicJobRoute } from './public-job-routes.mjs';
import { createCareerPacketService } from './career-packet-service.mjs';
import { handleCareerPacketRoute } from './career-packet-routes.mjs';
import { createCalendarExportService } from './calendar-export-service.mjs';
import { handleCalendarExportRoute } from './calendar-export-routes.mjs';
import { createFocusService, FOCUS_LIMITS } from './focus-service.mjs';
import { handleFocusRoute } from './focus-routes.mjs';
import { createExpenseImportService } from './expense-import-service.mjs';
import { handleExpenseImportRoute } from './expense-import-routes.mjs';
import { createCalendarImportService } from './calendar-import-service.mjs';
import { handleCalendarImportRoute } from './calendar-import-routes.mjs';
import { createAdminDeadlineService } from './admin-deadline-service.mjs';
import { handleAdminDeadlineRoute } from './admin-deadline-routes.mjs';
import { createPlanTaskService } from './plan-task-service.mjs';
import { handlePlanTaskRoute } from './plan-task-routes.mjs';
import { handleLearningRoute } from './learning-routes.mjs';
import { handlePracticeRoute } from './practice-routes.mjs';
import { createAcademicTaskService } from './academic-task-service.mjs';
import { handleAcademicTaskRoute } from './academic-task-routes.mjs';
import { createReminderService, REMINDER_LIMITS } from './reminder-service.mjs';
import { handleRemindersRoute } from './reminder-routes.mjs';
import { handleRichWritingRoute } from './rich-writing-routes.mjs';
import { handleLifeRoute } from './life-routes.mjs';
import { createWritingService } from './writing-service.mjs';
import { handleWritingRoute } from './writing-routes.mjs';
import { handleResearchRoute } from './research-routes.mjs';
import { handleProductivityRoute } from './productivity-routes.mjs';
import { createHostTurns } from './host-turns.mjs';
import { createTaskSessionService } from './task-session-service.mjs';
import { handleTaskSessionRoute } from './task-session-routes.mjs';
import { createDynamicTaskService, DYNAMIC_TASK_LIMITS } from './dynamic-task-service.mjs';
import { handleDynamicTaskRoute } from './dynamic-task-routes.mjs';
import { createDynamicTaskAIService } from './dynamic-task-ai-service.mjs';
import { handleDynamicTaskAIRoute } from './dynamic-task-ai-routes.mjs';
import { createCourseStudioService } from './course-studio-service.mjs';
import { handleCourseStudioRoute } from './course-studio-routes.mjs';
import { createLearningService } from './learning-service.mjs';
import { createInterviewStudioService } from './interview-studio-service.mjs';
import { handleInterviewStudioRoute } from './interview-studio-routes.mjs';
import { createApplicationBrowserService } from './application-browser-service.mjs';
import { handleApplicationBrowserRoute } from './application-browser-routes.mjs';
import { createOnboardingRoutes } from './onboarding-routes.mjs';
import { createCloudOnboardingRoutes } from './cloud-onboarding-routes.mjs';
import { createD2lRoutes } from './d2l-routes.mjs';
import { createCodexProfile } from './codex-profile.mjs';
import { createRemoteRoutes } from './remote-routes.mjs';
import { openRemoteInstance } from './remote-companion.mjs';
import { join, dirname, basename } from 'node:path';
import { TutoringError } from '../../../packages/local-academic/src/tutoring.mjs';

export const LOCAL_VERSION = '0.4.0';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const publicRoot = new URL('../../local/public/', import.meta.url);
const builtRoot = new URL('../../local/dist/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/overview.js', ['overview.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/task-agents.js', ['task-agents.js', 'text/javascript; charset=utf-8']],
  ['/dynamic-tasks.js', ['dynamic-tasks.js', 'text/javascript; charset=utf-8']],
  ['/course-studio.js', ['course-studio.js', 'text/javascript; charset=utf-8']],
  ['/course-studio.css', ['course-studio.css', 'text/css; charset=utf-8']],
  ['/interview-studio.js', ['interview-studio.js', 'text/javascript; charset=utf-8']],
  ['/application-browser.js', ['application-browser.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/career.js', ['career.js', 'text/javascript; charset=utf-8']],
  ['/learning.js', ['learning.js', 'text/javascript; charset=utf-8']],
  ['/life.js', ['life.js', 'text/javascript; charset=utf-8']],
  ['/writing.js', ['writing.js', 'text/javascript; charset=utf-8']],
  ['/research.js', ['research.js', 'text/javascript; charset=utf-8']],
  ['/productivity.js', ['productivity.js', 'text/javascript; charset=utf-8']],
  ['/onboarding.js', ['onboarding.js', 'text/javascript; charset=utf-8']],
  ['/ai.js', ['ai.js', 'text/javascript; charset=utf-8']],
  ['/d2l.js', ['d2l.js', 'text/javascript; charset=utf-8']],
  ['/cloud-onboarding.js', ['cloud-onboarding.js', 'text/javascript; charset=utf-8']],
  ['/remote.js', ['remote.js', 'text/javascript; charset=utf-8']],
  ['/practice.js', ['practice.js', 'text/javascript; charset=utf-8']],
  ['/reminders.js', ['reminders.js', 'text/javascript; charset=utf-8']],
  ['/rich-writing.js', ['rich-writing.js', 'text/javascript; charset=utf-8']],
  ['/academic-tasks.js', ['academic-tasks.js', 'text/javascript; charset=utf-8']],
  ['/public-jobs.js', ['public-jobs.js', 'text/javascript; charset=utf-8']],
  ['/career-packets.js', ['career-packets.js', 'text/javascript; charset=utf-8']],
  ['/calendar-export.js', ['calendar-export.js', 'text/javascript; charset=utf-8']],
  ['/focus.js', ['focus.js', 'text/javascript; charset=utf-8']],
  ['/expense-import.js', ['expense-import.js', 'text/javascript; charset=utf-8']],
  ['/calendar-import.js', ['calendar-import.js', 'text/javascript; charset=utf-8']],
  ['/student-admin.js', ['student-admin.js', 'text/javascript; charset=utf-8']],
  ['/plan-tasks.js', ['plan-tasks.js', 'text/javascript; charset=utf-8']],
]);
const base = '/api/local/v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const notFound = () => { throw new HttpError(404, 'INVALID_INPUT', 'The local record or route is unavailable.'); };
const methodError = () => { throw new HttpError(405, 'UNSUPPORTED', 'This operation is unavailable.'); };
function id(value) { if (!uuid.test(value)) notFound(); return value; }
function noQuery(url) { if (url.search) throw new HttpError(400, 'INVALID_INPUT', 'This route does not accept query parameters.'); }
function found(value) { if (!value) notFound(); return value; }
function idempotency(request) {
  const key = request.headers['idempotency-key'];
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))) {
    throw new HttpError(400, 'INVALID_INPUT', 'Invalid idempotency key.');
  }
  return key === undefined ? {} : { idempotencyKey: key };
}
function documentResult(value) {
  return { document: value.document, content: value.text, sha256: value.sha256, revision: value.document.current_revision };
}
function setHeaders(response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
}
function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
function failure(response, error) {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof HttpError) return json(response, error.status, { error: { code: error.code, message: error.message } });
  if (error instanceof LearnBridgeError) {
    const statuses = { AUTH_REQUIRED: 401, CONSENT_REQUIRED: 403, SCOPE_DENIED: 403, REVISION_CONFLICT: 409,
      VERSION_MISMATCH: 409, CANCELLED: 409, RATE_LIMITED: 429, INVALID_INPUT: 400, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413 };
    return json(response, statuses[error.code] || 500, { error: error.toJSON() });
  }
  if (error instanceof AcademicError) {
    const statuses = { INVALID_INPUT: 400, SCOPE_DENIED: 403, AUTH_REQUIRED: 401, AUTH_EXPIRED: 401, UNSUPPORTED: 501, BUDGET_EXCEEDED: 413, CANCELLED: 409, TIMEOUT: 504 };
    return json(response, statuses[error.code] || 502, { error: error.toJSON() });
  }
  if (error instanceof TutoringError) {
    const statuses = { INVALID_INPUT: 400, BUDGET_EXCEEDED: 413, STALE_EVIDENCE: 409, POLICY_BLOCKED: 403, CONSENT_REQUIRED: 403 };
    return json(response, statuses[error.code] || 400, { error: { code: error.code, message: error.message } });
  }
  json(response, 500, { error: { code: 'PROVIDER_FAILURE', message: 'The local operation could not be completed.' } });
}

/** Independent local edition. Never trusts a request student ID or hosted cookie. */
export async function startRuntime({ dataRoot, port = 3210, sessionTtlMs, pairingTtlMs,
  // Trusted programmatic dependency injection for native acquisition barriers.
  // The launcher/HTTP/MCP surfaces never accept an adapter or executable.
  publicJobFetch, sourceAdapter = { describeRoot, inventorySource, readSelectedEntry, readSelectedPdf, readSelectedPdfAsset, readSelectedOffice, probeSourceCapability, probePdfCapability, probeOfficeCapability },
  // Trusted fixture seam only; the CLI/HTTP/MCP never accepts execution configuration.
  hostAdapter, codexProfileOptions = {}, d2lBrowserFactory,
  remoteOptions = { enabled: process.env.LEARNBRIDGE_PHONE_ACCESS === 'true' } } = {}) {
  if (typeof dataRoot !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid local runtime options.');
  const store = LocalStore.open({ root: dataRoot, repositoryRoot, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  let studentWorkspace;
  let hostTurns;
  let taskSessions;
  let dynamicTasks, dynamicTaskAI, courseStudio, interviewStudio, applicationBrowser;
  let onboardingRoutes;
  let cloudOnboardingRoutes, d2lRoutes, codexProfile, remoteRoutes, reminders, academicTasks, publicJobService, calendarExports, careerPackets, focus, expenseImports, calendarImports, studentAdmin, planTasks;
  const embeddedLeases = new Map();
  try { store.recoverInterruptedRuns(); studentWorkspace = createStudentWorkspace(store); reminders = createReminderService({ store }); academicTasks = createAcademicTaskService({ store, studentWorkspace }); publicJobService = createPublicJobService({ store, ...(publicJobFetch ? { fetchImpl: publicJobFetch } : {}) });
    focus = createFocusService({ store });
    expenseImports = createExpenseImportService({ store });
    calendarImports = createCalendarImportService({ store, studentWorkspace });
    studentAdmin = createAdminDeadlineService({ store, studentWorkspace });
    planTasks = createPlanTaskService({ store, getLibrary: studentWorkspace.library });
    store.bindAgentTaskProvenance(taskId => planTasks.taskProvenance(taskId));
    calendarExports = createCalendarExportService({ store, studentWorkspace });
    careerPackets = createCareerPacketService({ store, publicJobService });
    codexProfile = createCodexProfile({ store, ...codexProfileOptions, leaseFactory: (grantId, authorize) => {
      const id = randomUUID(), lease = { grantId, authorize, permit: null }; embeddedLeases.set(id, lease);
      return { id, release: () => embeddedLeases.delete(id), permitTool: (tool, args) => {
        const command = { learnbridge_status: 'status', learnbridge_context: 'context', learnbridge_propose_task: 'propose_task', learnbridge_propose_document: 'propose_document' }[tool];
        if (!command || embeddedLeases.get(id) !== lease || authorize() !== true || lease.permit) throw new LearnBridgeError('SCOPE_DENIED');
        const permit = { command, fingerprint: workflowHash(args ?? {}), used: false }; lease.permit = permit;
        return () => { if (lease.permit === permit) lease.permit = null; };
      } };
    } });
    hostTurns = createHostTurns({ store, ...(hostAdapter || { enabled: true, execute: codexProfile.execute, capability: codexProfile.status }) });
    dynamicTasks = createDynamicTaskService({ store, studentWorkspace });
    dynamicTaskAI = createDynamicTaskAIService({ store, dynamicTasks, hostTurns });
    taskSessions = createTaskSessionService({ store, hostTurns, provenance: taskId => ({ plan: planTasks.taskProvenance(taskId), dynamic: dynamicTasks.taskProvenance(taskId) }), applicationProgress: sessionId => applicationBrowser?.progressForTaskSession(sessionId) ?? [] });
    courseStudio = createCourseStudioService({ store, learningService: createLearningService({ store, getLibrary: studentWorkspace.library }), hostTurns,
      ...(typeof sourceAdapter.readSelectedPdfAsset === 'function' ? { readPdfAsset: async (entry, physicalPage, { signal } = {}) => sourceAdapter.readSelectedPdfAsset(store.getSource(entry.source_id).descriptor, store.getSourceInventory(entry.inventory_id).inventory, entry.entry_id, { physicalPage, signal }) } : {}) });
    interviewStudio = createInterviewStudioService({ store, hostTurns, publicJobService });
    applicationBrowser = createApplicationBrowserService({ store, publicJobService, taskSessions });
    onboardingRoutes = createOnboardingRoutes({ store, studentWorkspace });
    cloudOnboardingRoutes = createCloudOnboardingRoutes({ store });
    d2lRoutes = createD2lRoutes({ studentWorkspace, browserFactory: d2lBrowserFactory });
    remoteRoutes = createRemoteRoutes({ store,
      nativeEnabled: () => codexProfile.status().state === 'available',
      instanceFactory: () => openRemoteInstance({ root: join(dirname(store.root), `${basename(store.root)}-remote-device`), workspaceRoot: store.root, repositoryRoot }),
      executeStudy: ({ grant_id, prompt, authorize, idempotency_key }) => hostTurns.start({ grant_id, prompt, confirmed: true }, { authorize, idempotencyKey: idempotency_key }),
      inspectStudy: id => hostTurns.get(id),
      cancelStudy: id => { const item = hostTurns.get(id); return hostTurns.cancel(id, { expected_revision: item.revision }); },
      ...remoteOptions }); }
  catch (error) { store.close(); throw error; }
  let policy;
  let control;
  let closing = false;
  let closePromise;
  const activeBackups = new Set();
  const sourceOperations = new Set();
  const academicPreviews = new Map();
  let sourceCapability, pdfCapability, officeCapability;
  try {
    sourceCapability = await sourceAdapter.probeSourceCapability();
    pdfCapability = sourceAdapter.probePdfCapability ? await sourceAdapter.probePdfCapability()
      : { state: 'unsupported', reason: 'native_pdf_runtime_unavailable' };
    officeCapability = sourceAdapter.probeOfficeCapability ? await sourceAdapter.probeOfficeCapability()
      : { state: 'unsupported', reason: 'office_runtime_unavailable' };
  }
  catch (error) { store.close(); throw error; }
  let resolveClosed;
  const closed = new Promise(resolveDone => { resolveClosed = resolveDone; });
  let origin;
  const status = () => {
    const integrity = store.integrity();
    return {
      edition: 'local', version: LOCAL_VERSION, student_id: store.identity.student_id,
      student: { id: store.identity.student_id }, integrity: integrity.integrity === 'ok',
      storage: { healthy: integrity.integrity === 'ok', schema_version: integrity.schema_version },
      privacy: { local_only: true, source_discovery_enabled: false, cloud_processing_enabled: store.listAgentGrants().some(item => item.state === 'active' && Date.parse(item.expires_at) > Date.now()) },
      capabilities: [
        hostTurns.capability(),
        { id: 'tasks', label: 'Tasks', state: 'available', detail: 'Manual tasks with revision checks and private local saves.' },
        { id: 'dynamic_tasks', label: 'Done list', state: 'available', detail: 'Selected saved course, calendar, update and project sources reconcile into deduplicated local tasks. Explicit source policy controls automatic creation and verified project completion. No live cloud polling or activity-based completion inference.' },
        { id: 'task_sessions', label: 'Task agent sessions', state: 'available', detail: 'Start a selected-task Codex conversation, inspect background tool progress, continue or stop it, and review the actual result before marking done. Local proposals only; external form actions require separate review.' },
        { id: 'course_studio', label: 'Course studio', state: 'available', detail: 'Exact selected PDF page rendering, pinned course/page questions, reviewed model quizzes, student attempts and bounded annotations. Optional browser speech; visual model access and mastery inference are unavailable.' },
        { id: 'interview_studio', label: 'Interview studio', state: 'available', detail: 'Selected role and confirmed profile coaching, one model question at a time, actual saved answers and grounded feedback through the local Codex subscription. Optional browser speech support varies.' },
        { id: 'notes', label: 'Notes', state: 'available', detail: 'Multiple text notes with immutable revisions and verified hashes.' },
        { id: 'planning', label: 'Study planning', state: 'available', detail: 'Deterministic local study-plan previews with capacity deficits, task revision checks and saved review. No external calendar writes.' },
        { id: 'profile', label: 'Reviewed profile', state: 'available', detail: 'Student-entered facts with exact review, conflicts, purpose filters and stale source checks. No automatic identity or mastery inference.' },
        { id: 'onboarding', label: 'Guided setup review', state: 'available', detail: 'Select saved local records and review an honest coverage report. No automatic discovery, profile confirmation, sharing grant or host connection is created.' },
        { id: 'library', label: 'Course library', state: 'available', detail: 'Reviewed export comparisons, immutable history, unchanged-content deduplication and current-course search with exact citations. Dates and coverage are source-reported; live university authentication remains a separate gate.' },
        { id: 'workflows', label: 'Durable local workflows', state: 'available', detail: 'Saved step journal, cumulative budgets, cancellation and restart recovery for registered local recipes. Unverified model turns remain disabled.' },
        { id: 'learning', label: 'Learning and catch-up', state: 'available', detail: 'Selected-course cited host recipes, your actual attempts and reviewed feedback, capacity-aware catch-up plans. A recorded check does not establish mastery.' },
        { id: 'practice', label: 'Spaced practice', state: 'available', detail: 'Source-pinned cards, explicit answer/reveal/self-rating and persistent due scheduling. Ratings are self-reported; mastery is not inferred.' },
        { id: 'reminders', label: 'Local reminders', state: 'available', detail: 'Opt-in selected-task checks with a durable in-app inbox while this runtime runs. Paused by default; no provider reads or sleeping-laptop notifications.' },
        { id: 'academic_tasks', label: 'Reviewed course tasks', state: 'available', detail: 'Choose current course versions and inspect exact deadlines. Save pending suggestions, then separately accept them into Today; unknown or conflicting dates stay unresolved.' },
        { id: 'plan-tasks', label: 'Reviewed learning next steps', state: 'available', detail: 'Choose topics from an accepted current catch-up plan, then review and accept one local task at a time. Source and dependency pins stay exact. No mastery or calendar-action inference.' },
        { id: 'student-admin', label: 'Student administration', state: 'available', detail: 'Review student-pasted requirements and deadlines, keep eligibility facts explicit, and separately accept one local next-step task. No scholarship verification or application submission.' },
        { id: 'calendar-import', label: 'Reviewed busy calendar import', state: 'available', detail: 'Choose and review supported local ICS events, then plan around those exact busy windows. Unsupported recurrence and time zones remain visible omissions. No provider access or calendar changes.' },
        { id: 'expense-import', label: 'Reviewed expense CSV import', state: 'available', detail: 'Choose a local UTF-8 CSV, review invalid and duplicate rows, and confirm selected expenses. Exact currency totals and refunds; no bank access or exchange-rate assumptions.' },
        { id: 'focus', label: 'Focus timer', state: 'available', detail: 'Start, pause, resume and end a local timer. Observed runtime duration stays separate from planned time; sleep gaps and downtime are excluded. This does not measure attention or mastery.' },
        { id: 'calendar_export', label: 'Reviewed calendar files', state: 'available', detail: 'Download selected task deadlines or exact accepted study blocks as reviewed ICS with source pins. No calendar account is changed; external import remains your choice.' },
        { id: 'public_jobs', label: 'Official job discovery', state: 'available', detail: 'Choose a supported Greenhouse or Lever employer board, search bounded public metadata, and read selected current postings. Source presence does not establish suitability or eligibility.' },
        { id: 'career_packets', label: 'Application preparation packets', state: 'available', detail: 'Review one current official posting, selected confirmed career facts and accepted Writing drafts. Missing fields stay visible. Private text downloads do not fill, upload or submit an application.' },
        { id: 'application_browser', label: 'Application preparation browser', ...applicationBrowser.capability(), detail: 'Owned temporary Chrome for a selected current Greenhouse or Lever application. Exact supported text fields require review; network freezes before filling. No uploads, protected disclosures or submission. Real employer compatibility requires its own check.' },
        { id: 'writing', label: 'Writing review', state: 'available', detail: 'Source-pinned drafts, private alternatives and exact revisions with preserved originals. Reviewed Markdown and Word text downloads preserve source hashes. Formatted Word and escaped LaTeX source support a bounded Markdown subset. PDF rendering and general Office conversion remain separate.' },
        { id: 'research', label: 'Evidence research', state: 'available', detail: 'Selected local passages or student-pasted excerpts, exact quotes, conflicts and reviewed cited reports. No website freshness or factual accuracy is inferred.' },
        { id: 'career', label: 'Career preparation', state: 'available', detail: 'Selected postings, factual application drafts, interview attempts and local follow-up tasks. Live role availability and application submission are separate.' },
        { id: 'life', label: 'Daily life', state: 'available', detail: 'Pantry and grocery quantities, self-reported routines, confirmed currency-specific expenses and manual travel checklists.' },
        { id: 'productivity', label: 'Updates and projects', state: 'available', detail: 'Account-qualified pasted updates, coverage-aware briefings, reviewed tasks, ordered project checklists and paused manual reminders. Live refresh is not enabled here.' },
        { id: 'backup', label: 'Backup and restore', state: 'available', detail: 'Use the local launcher commands to make a snapshot or restore into a fresh workspace.' },
        { id: 'mcp', label: 'Agent MCP bridge', state: 'available', detail: 'Four project-scoped tools: status, selected context, pending tasks and pending writing. Sharing requires a destination-specific selection; task and writing acceptance belongs to the student.' },
        { id: 'sources', label: 'Selected local sources', state: sourceCapability.state === 'available' ? 'available' : 'unsupported', detail: 'Explicit folder inventory and selected text/Markdown, PDF and Office imports where the format capability is available. Requires the verified private Python runtime; no automatic laptop scan.' },
        { id: 'pdf', label: 'Selected PDF handouts', state: sourceCapability.state === 'available' && pdfCapability.state === 'available' ? 'available' : 'unsupported', detail: 'macOS PDF text imports preserve physical page citations and partial coverage. Native prerequisites are checked; each selected import verifies extraction. Scans require a separate text export; no OCR or password collection.' },
        { id: 'office', label: 'Selected Word and PowerPoint handouts', state: sourceCapability.state === 'available' && officeCapability.state === 'available' ? 'available' : 'unsupported', detail: 'Selected DOCX paragraphs and PPTX presentation-order slides with exact original/text hashes. Always partial text coverage: layout, visuals and recorded omissions require review of the original. No external links, macros or passwords are used.' },
        { id: 'academic', label: 'Avenue / D2L', state: d2lRoutes.capability?.().state || 'requires_auth', detail: 'Connect a separate visible school browser, personally complete SSO, then verify your school account and select exact courses and categories before previewing read-only results.' },
        { id: 'cloud_onboarding', label: 'Selected cloud sources', state: 'available', detail: 'Export selected Google Docs, Notion pages or Gmail messages from your signed-in LearnBridge account, then review the exact text and reported owner before importing locally. Cloud freshness and profile facts remain subject to review.' },
        { id: 'remote', label: 'Phone companion', state: remoteOptions.enabled ? 'requires_auth' : 'unavailable', detail: 'Optional outward HTTPS pairing, bounded local Codex requests and separately reviewed text results. Requires live relay, account, device and cleanup verification before public release. The laptop is never exposed as a public listener.' },
        { id: 'telemetry', label: 'Local usage reporting', state: 'unavailable', detail: 'Off by default. Setup, doctor, tasks and agent sharing do not report local activity or enroll measurement.' },
      ],
    };
  };
  const reminderTimer = setInterval(() => { if (!closing) { try { reminders.drain(); } catch { /* Retry on the next bounded tick; no private diagnostics. */ } } }, REMINDER_LIMITS.tick_interval_ms);
  const dynamicTaskTimer = setInterval(() => { if (!closing) { try { dynamicTasks.refresh(); dynamicTaskAI.refresh(); } catch { /* Selected scopes stay explicit; unavailable sources need review. */ } } }, DYNAMIC_TASK_LIMITS.tick_interval_ms);
  dynamicTaskTimer.unref();
  reminderTimer.unref?.();
  const focusTimer = setInterval(() => { if (!closing) { try { focus.observe(); } catch { /* Retry later without exposing private diagnostics. */ } } }, FOCUS_LIMITS.tick_interval_ms);
  focusTimer.unref?.();
  const server = createServer(async (request, response) => {
    setHeaders(response);
    try {
      if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
      assertLocalRequest(request, origin);
      const url = new URL(request.url, origin);
      if (url.pathname === '/health') {
        noQuery(url);
        if (request.method !== 'GET' && request.method !== 'HEAD') methodError();
        return json(response, 200, { alive: true, edition: 'local', version: LOCAL_VERSION });
      }
      if (!url.pathname.startsWith(base + '/')) {
        noQuery(url);
        const asset = assets.get(url.pathname);
        if (!asset) notFound();
        if (request.method !== 'GET' && request.method !== 'HEAD') methodError();
        const root = existsSync(new URL('index.html', builtRoot)) ? builtRoot : publicRoot;
        const bytes = readFileSync(new URL(asset[0], root));
        response.statusCode = 200;
        response.setHeader('Content-Type', asset[1]);
        return response.end(request.method === 'HEAD' ? undefined : bytes);
      }
      const route = url.pathname.slice(base.length);
      const mutation = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method);
      if (route === '/pair') {
        noQuery(url);
        if (request.method !== 'POST') methodError();
        assertLocalRequest(request, origin, { mutation: true });
        const body = plainBody(await readJson(request, 4096), ['code'], ['code']);
        const session = policy.pair(request, body.code);
        response.setHeader('Set-Cookie', session.cookie);
        return json(response, 200, { nonce: session.nonce, expires_at: session.expires_at });
      }
      const session = policy.authenticate(request, { mutation, bootstrap: route === '/session' && request.method === 'GET' });
      const privateBody = async (allowed, required = [], maxBytes = 300_000) => {
        const value = await readJson(request, maxBytes);
        // A slow body must not preserve access after expiry/logout/shutdown.
        if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
        policy.authenticate(request, { mutation: true });
        return plainBody(value, allowed, required);
      };
      const stillAuthorized = () => {
        if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
        // Same-origin GETs do not necessarily carry an Origin header. Preserve
        // the original request's policy when rechecking asynchronous reads.
        policy.authenticate(request, { mutation });
      };
      const sourceOperation = async callback => {
        const controller = new AbortController();
        sourceOperations.add(controller);
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await callback(controller.signal);
          if (controller.signal.aborted || response.destroyed) throw new HttpError(409, 'CANCELLED', 'The source acquisition was cancelled.');
          stillAuthorized(); return result;
        }
        finally { sourceOperations.delete(controller); response.off('close', cancel); }
      };
      if (route.startsWith('/remote/')) {
        noQuery(url); const result = await remoteRoutes.handle({ route, method: request.method, privateBody, session, stillAuthorized });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/dynamic-tasks/')) {
        noQuery(url); const result = await handleDynamicTaskRoute({ route, method: request.method, privateBody, service: dynamicTasks, session, stillAuthorized });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/dynamic-task-ai/')) {
        noQuery(url); const result = await handleDynamicTaskAIRoute({ route, method: request.method, privateBody, service: dynamicTaskAI, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/course-studio/')) {
        noQuery(url); const result = await handleCourseStudioRoute({ route, method: request.method, privateBody, service: courseStudio, session, stillAuthorized, sourceOperation, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/interview-studio/')) {
        noQuery(url); const result = await handleInterviewStudioRoute({ route, method: request.method, privateBody, interviewStudioService: interviewStudio, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/application-browser/')) {
        noQuery(url); const result = await handleApplicationBrowserRoute({ route, method: request.method, privateBody, applicationBrowserService: applicationBrowser, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/ai/')) {
        noQuery(url);
        if (route === '/ai/status' && request.method === 'GET') return json(response, 200, codexProfile.status());
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['confirmed'], ['confirmed'], 4096);
        if (body.confirmed !== true) throw new HttpError(403, 'CONSENT_REQUIRED', 'Confirm this local host action.');
        const arguments_ = { sessionId: session.nonce, authorize: () => { stillAuthorized(); return true; } };
        try {
          const result = route === '/ai/connect' ? await codexProfile.connect(arguments_) : route === '/ai/check' ? await codexProfile.check(arguments_) : route === '/ai/disconnect' ? await codexProfile.disconnect(arguments_) : notFound();
          stillAuthorized(); return json(response, 200, result);
        } catch (error) { if (error.code === 'AUTH_REQUIRED') throw new HttpError(409, 'CODEX_AUTH_REQUIRED', 'Sign in to ChatGPT in Local AI, then check its status.'); throw error; }
      }
      if (route.startsWith('/d2l/') || route.startsWith('/cloud-onboarding/')) {
        noQuery(url); const handler = route.startsWith('/d2l/') ? d2lRoutes : cloudOnboardingRoutes;
        const result = await handler.handle({ route, method: request.method, privateBody, session });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/public-jobs/')) {
        noQuery(url);
        const result = await handlePublicJobRoute({ route, method: request.method, privateBody, store, session, publicJobService, stillAuthorized });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route === '/career-packets' || route.startsWith('/career-packets/')) {
        noQuery(url);
        const result = await handleCareerPacketRoute({ route, method: request.method, privateBody, store, session, publicJobService, careerPacketService: careerPackets, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/plan-tasks/')) {
        noQuery(url);
        const result = await handlePlanTaskRoute({ route, method: request.method, privateBody, store, getLibrary: studentWorkspace.library, planTaskService: planTasks, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/student-admin/')) {
        noQuery(url);
        const result = await handleAdminDeadlineRoute({ route, method: request.method, privateBody, service: studentAdmin, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/calendar-import/')) {
        noQuery(url);
        const result = await handleCalendarImportRoute({ route, method: request.method, privateBody, service: calendarImports, session, stillAuthorized, sourceOperation, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/expense-import/')) {
        noQuery(url);
        const result = await handleExpenseImportRoute({ route, method: request.method, privateBody, store, session, expenseImportService: expenseImports, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/focus/')) {
        noQuery(url);
        const result = await handleFocusRoute({ route, method: request.method, privateBody, service: focus, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/calendar-export/')) {
        noQuery(url);
        const result = await handleCalendarExportRoute({ route, method: request.method, privateBody, service: calendarExports, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        stillAuthorized(); if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/career/')) {
        noQuery(url);
        const result = await handleCareerRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/onboarding/')) {
        noQuery(url);
        const result = await onboardingRoutes.handle({ route, method: request.method, privateBody, session });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/learning/')) {
        noQuery(url);
        const result = await handleLearningRoute({ route, method: request.method, privateBody, store, session,
          getLibrary: studentWorkspace.library, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/academic-tasks/')) {
        noQuery(url);
        const result = await handleAcademicTaskRoute({ route, method: request.method, privateBody, service: academicTasks, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/practice/') || route.startsWith('/reminders/')) {
        noQuery(url);
        const result = route.startsWith('/practice/')
          ? await handlePracticeRoute({ route, method: request.method, privateBody, store, session, idempotencyKey: idempotency(request).idempotencyKey })
          : await handleRemindersRoute({ route, method: request.method, privateBody, service: reminders, session, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/life/')) {
        noQuery(url);
        const result = await handleLifeRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/writing/')) {
        noQuery(url);
        const rich = await handleRichWritingRoute({ route, method: request.method, privateBody, store, session });
        if (rich) return json(response, rich.status, rich.data);
        const result = await handleWritingRoute({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route.startsWith('/research/') || route.startsWith('/productivity/')) {
        noQuery(url);
        const handler = route.startsWith('/research/') ? handleResearchRoute : handleProductivityRoute;
        const result = await handler({ route, method: request.method, privateBody, store, session,
          idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      if (route === '/host-turns') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: hostTurns.list(), capability: hostTurns.capability() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['grant_id', 'prompt', 'confirmed'], ['grant_id', 'prompt', 'confirmed'], 18000);
        const item = await hostTurns.start(body, { idempotencyKey: idempotency(request).idempotencyKey,
          authorize: () => { stillAuthorized(); return true; } });
        return json(response, 202, { item });
      }
      if (route === '/task-sessions' || route.startsWith('/task-sessions/')) {
        noQuery(url);
        const result = await handleTaskSessionRoute({ route, method: request.method, privateBody, service: taskSessions, stillAuthorized, idempotencyKey: idempotency(request).idempotencyKey });
        if (result) return json(response, result.status, result.data);
      }
      const hostTurnRoute = /^\/host-turns\/([^/]+)(?:\/(cancel))?$/.exec(route);
      if (hostTurnRoute) {
        noQuery(url); const recordId = id(hostTurnRoute[1]);
        if (!hostTurnRoute[2] && request.method === 'GET') return json(response, 200, { item: hostTurns.get(recordId) });
        if (hostTurnRoute[2] !== 'cancel' || request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
        return json(response, 200, { item: hostTurns.cancel(recordId, body) });
      }
      if (route === '/session') {
        noQuery(url);
        if (request.method !== 'GET') methodError();
        return json(response, 200, session);
      }
      if (route === '/logout') {
        noQuery(url);
        if (request.method !== 'POST') methodError();
        await privateBody([], [], 4096);
        response.setHeader('Set-Cookie', policy.logout(request));
        cloudOnboardingRoutes.clear();
        await Promise.allSettled([d2lRoutes.clear(), codexProfile.clear(), remoteRoutes.clear({ nonce: session.nonce })]);
        return json(response, 200, { logged_out: true });
      }
      if (route === '/status') {
        noQuery(url);
        if (request.method !== 'GET') methodError();
        return json(response, 200, status());
      }
      if (route === '/today') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, studentWorkspace.today());
      }
      if (route === '/profile') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: studentWorkspace.listProfiles() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['field', 'value', 'purposes', 'expires_at', 'evidence'], ['field', 'value'], 8192);
        return json(response, 201, { fact: studentWorkspace.createProfile(body, idempotency(request)) });
      }
      if (route === '/profile/context') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['purpose', 'allowed_ids'], ['purpose', 'allowed_ids'], 8192);
        const context = { purpose: body.purpose, items: studentWorkspace.profileContext(body) };
        return json(response, 200, { ...context, context_hash: workflowHash(context), processing: 'local_preview_only' });
      }
      if (route === '/profile/export') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['purpose', 'allowed_ids', 'context_hash'], ['purpose', 'allowed_ids', 'context_hash'], 8192);
        return json(response, 201, studentWorkspace.exportProfile(body));
      }
      const profileRoute = /^\/profile\/([^/]+)(\/review)?$/.exec(route);
      if (profileRoute) {
        noQuery(url); const recordId = id(profileRoute[1]);
        if (profileRoute[2] && request.method === 'POST') {
          const body = await privateBody(['expected_revision', 'decision', 'fingerprint', 'value'], ['expected_revision', 'decision', 'fingerprint'], 8192);
          return json(response, 200, { fact: studentWorkspace.reviewProfile(recordId, body) });
        }
        if (!profileRoute[2] && request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          studentWorkspace.forgetProfile(recordId, body.expected_revision); return json(response, 200, { deleted: true, retention: 'Historical local revisions and backups may retain this fact.' });
        }
        methodError();
      }
      if (route === '/courses') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: studentWorkspace.listSnapshots() });
      }
      if (route === '/academic/streams') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: studentWorkspace.listAcademicStreams(), live_access: 'requires_auth' });
      }
      const academicHistoryRoute = /^\/academic\/streams\/([^/]+)\/history(?:\/([^/]+))?$/.exec(route);
      if (academicHistoryRoute) {
        noQuery(url); if (request.method !== 'GET') methodError();
        const streamId = id(academicHistoryRoute[1]);
        return json(response, 200, academicHistoryRoute[2]
          ? studentWorkspace.academicHistorySnapshot(streamId, id(academicHistoryRoute[2]))
          : studentWorkspace.academicStreamHistory(streamId));
      }
      if (route === '/courses/search' || route === '/courses/citation') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(route.endsWith('search') ? ['snapshot_ids', 'course_ids', 'query', 'limit'] : ['snapshot_ids', 'course_ids', 'source_id', 'version_hash', 'chunk_id'], ['snapshot_ids', 'course_ids'], 16384);
        return json(response, 200, route.endsWith('search') ? studentWorkspace.search(body) : studentWorkspace.citation(body));
      }
      const courseRoute = /^\/courses\/([^/]+)$/.exec(route);
      if (courseRoute) {
        noQuery(url); if (request.method !== 'DELETE') methodError();
        const body = await privateBody(['expected_revision', 'expected_stream_revision'], ['expected_revision'], 4096);
        studentWorkspace.forgetSnapshot(id(courseRoute[1]), body.expected_revision, { expected_stream_revision: body.expected_stream_revision }); return json(response, 200, { deleted: true, retention: 'Active course retrieval stops. Historical local revisions and backups may retain this snapshot.' });
      }
      if (route === '/plans') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: studentWorkspace.listPlans() });
      }
      const planRoute = /^\/plans\/([^/]+)\/accept$/.exec(route);
      if (planRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision', 'plan_hash'], ['expected_revision', 'plan_hash'], 4096);
        return json(response, 200, { plan: studentWorkspace.acceptPlan(id(planRoute[1]), body) });
      }
      if (route === '/workflows') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listRuns() });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(['recipe_id', 'input'], ['recipe_id', 'input'], 32768);
        if (body.recipe_id !== 'plan.today') throw new HttpError(501, 'UNSUPPORTED', 'Choose an available local workflow.');
        const input = plainBody(body.input, ['availability', 'busy', 'pinnedBlocks', 'timezone', 'horizonEnd', 'maxDailyMinutes', 'bufferMinutes', 'minBlockMinutes'], ['availability', 'timezone', 'horizonEnd']);
        return json(response, 201, { run: studentWorkspace.runner.prepare(body.recipe_id, { ...input, now: new Date().toISOString() }, idempotency(request)) });
      }
      const workflowRoute = /^\/workflows\/([^/]+)(\/(execute|cancel))?$/.exec(route);
      if (workflowRoute) {
        noQuery(url); const runId = id(workflowRoute[1]);
        if (!workflowRoute[3] && request.method === 'GET') return json(response, 200, { run: found(store.getRun(runId)), steps: store.listRunSteps(runId), events: store.listRunEvents(runId) });
        if (request.method !== 'POST') methodError();
        const body = await privateBody(workflowRoute[3] === 'cancel' ? ['expected_revision'] : [], workflowRoute[3] === 'cancel' ? ['expected_revision'] : [], 4096);
        if (workflowRoute[3] === 'cancel') return json(response, 200, { run: studentWorkspace.runner.cancel(runId, body.expected_revision) });
        if (workflowRoute[3] !== 'execute') methodError();
        return json(response, 200, { run: await sourceOperation(signal => studentWorkspace.runner.execute(runId, { signal, authorize: stillAuthorized })) });
      }
      if (route === '/agent-grants') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listAgentGrants() });
        if (request.method === 'POST') {
          const body = await privateBody(['destination', 'task_ids', 'document_ids', 'source_entry_ids', 'max_bytes', 'expires_in_minutes', 'expected_records'], ['destination', 'max_bytes', 'expires_in_minutes', 'expected_records'], 16384);
          const { expected_records, ...input } = body;
          plainBody(expected_records, ['tasks', 'documents', 'source_entries'], ['tasks', 'documents', 'source_entries']);
          for (const [kind, field] of [['tasks', 'task_ids'], ['documents', 'document_ids'], ['source_entries', 'source_entry_ids']]) {
            if (!Array.isArray(expected_records[kind]) || expected_records[kind].length > 32 || !Array.isArray(input[field]) || input[field].length !== expected_records[kind].length) throw new HttpError(400, 'INVALID_INPUT', 'Review the exact selected records.');
            const seen = new Set();
            for (const pin of expected_records[kind]) {
              plainBody(pin, ['id', 'revision'], ['id', 'revision']);
              if (!input[field].includes(pin.id) || seen.has(pin.id)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid reviewed selection.');
              seen.add(pin.id);
              const value = kind === 'tasks' ? store.getTask(id(pin.id)) : kind === 'documents' ? store.getDocument(id(pin.id))?.document : store.getSourceEntry(id(pin.id));
              if (!value || value.revision !== pin.revision) throw new HttpError(409, 'REVISION_CONFLICT', 'Selection changed. Review it again.');
            }
          }
          return json(response, 201, { grant: store.createAgentGrant(input) });
        }
        methodError();
      }
      const grantRoute = /^\/agent-grants\/([^/]+)\/revoke$/.exec(route);
      if (grantRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
        return json(response, 200, { grant: store.revokeAgentGrant(id(grantRoute[1]), body.expected_revision) });
      }
      if (route === '/task-proposals') {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { items: store.listTaskProposals() });
      }
      const proposalRoute = /^\/task-proposals\/([^/]+)\/(accept|reject)$/.exec(route);
      if (proposalRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096);
        return json(response, 200, proposalRoute[2] === 'accept' ? store.acceptTaskProposal(id(proposalRoute[1]), body)
          : { proposal: store.rejectTaskProposal(id(proposalRoute[1]), body) });
      }
      if (route === '/sources') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listSources(), entries: store.listSourceEntries(), capability: sourceCapability, pdf_capability: pdfCapability, office_capability: officeCapability });
        if (request.method === 'POST') {
          const body = await privateBody(['path', 'label'], ['path', 'label'], 4096);
          const descriptor = await sourceOperation(() => sourceAdapter.describeRoot(body.path, { label: body.label }));
          return json(response, 201, { source: store.createSource({ label: body.label, descriptor }) });
        }
        methodError();
      }
      const entryRoute = /^\/source-entries\/([^/]+)$/.exec(route);
      if (entryRoute) {
        noQuery(url); if (request.method !== 'GET') methodError();
        return json(response, 200, { entry: found(store.getSourceEntry(id(entryRoute[1]))) });
      }
      const sourceRoute = /^\/sources\/([^/]+)\/(inventory|import|revoke)$/.exec(route);
      if (sourceRoute) {
        noQuery(url); if (request.method !== 'POST') methodError();
        const sourceId = id(sourceRoute[1]);
        if (sourceRoute[2] === 'revoke') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          return json(response, 200, { source: store.revokeSource(sourceId, body.expected_revision) });
        }
        const body = await privateBody(sourceRoute[2] === 'inventory' ? [] : ['inventory_id', 'entry_id'], sourceRoute[2] === 'inventory' ? [] : ['inventory_id', 'entry_id'], 4096);
        const source = found(store.getSource(sourceId));
        if (source.state !== 'active') throw new HttpError(403, 'CONSENT_REQUIRED', 'This source was revoked.');
        if (sourceRoute[2] === 'inventory') {
          const inventory = await sourceOperation(signal => sourceAdapter.inventorySource(source.descriptor, { signal }));
          return json(response, 200, { inventory: store.saveSourceInventory(sourceId, inventory) });
        }
        const saved = found(store.getSourceInventory(id(body.inventory_id)));
        if (saved.source_id !== sourceId) notFound();
        const entryId = id(body.entry_id);
        const selected = found(saved.inventory.entries.find(item => item.id === entryId));
        const isOffice = ['docx', 'pptx'].includes(selected.kind);
        if (selected.kind === 'pdf' && (pdfCapability.state !== 'available' || typeof sourceAdapter.readSelectedPdf !== 'function')) throw new LearnBridgeError('UNSUPPORTED');
        if (isOffice && (officeCapability.state !== 'available' || typeof sourceAdapter.readSelectedOffice !== 'function')) throw new LearnBridgeError('UNSUPPORTED');
        const reader = selected.kind === 'pdf' ? sourceAdapter.readSelectedPdf : isOffice ? sourceAdapter.readSelectedOffice : sourceAdapter.readSelectedEntry;
        const value = await sourceOperation(signal => reader(source.descriptor, saved.inventory, entryId, { signal, maxBytes: 48000 }));
        // Recheck source revocation after the acquisition worker yields.
        if (store.getSource(sourceId)?.state !== 'active') throw new HttpError(403, 'CONSENT_REQUIRED', 'This source was revoked.');
        const extraction = selected.kind === 'pdf' ? value.pdf : isOffice ? value.office : null;
        if ((selected.kind === 'pdf' || isOffice) && extraction?.extraction_status !== 'available') {
          return json(response, 200, { imported: false, extraction_status: extraction?.extraction_status || 'text_unavailable', coverage: extraction?.coverage || { state: 'unavailable', reasons: ['no_extractable_text'] } });
        }
        return json(response, 201, { entry: store.importSourceEntry({ source_id: sourceId, inventory_id: saved.id, entry_id: body.entry_id, ...value }) });
      }
      if (route === '/academic/preview') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const body = await privateBody(['export', 'selected_course_ids'], ['export', 'selected_course_ids'], 256000);
        const refresh = studentWorkspace.previewAcademicExport(body);
        const snapshot = refresh.snapshot;
        for (const [key, value] of academicPreviews) if (value.expires < Date.now()) academicPreviews.delete(key);
        // Keep exact retries while space permits without making successful
        // imports consume every slot for the full five-minute preview lifetime.
        for (const [key, value] of academicPreviews) {
          if (academicPreviews.size < 10) break;
          if (value.consumed) academicPreviews.delete(key);
        }
        if (academicPreviews.size >= 10) throw new HttpError(429, 'RATE_LIMITED', 'Review or discard an academic preview first.');
        const previewId = randomUUID();
        academicPreviews.set(previewId, { snapshot, refresh, nonce: session.nonce, expires: Date.now() + 300000 });
        return json(response, 200, { preview_id: previewId, snapshot, refresh, notice: 'Review these imported facts, changes and unknown deadlines. Not-returned items are retained in history and do not delete tasks. No live university access was used.' });
      }
      if (route === '/academic/import' || route === '/academic/library-import') {
        noQuery(url); if (request.method !== 'POST') methodError();
        const libraryImport = route === '/academic/library-import';
        const body = await privateBody(libraryImport ? ['preview_id', 'review_hash'] : ['preview_id'], libraryImport ? ['preview_id', 'review_hash'] : ['preview_id'], 4096);
        const preview = academicPreviews.get(id(body.preview_id));
        if (!preview || preview.nonce !== session.nonce || preview.expires < Date.now()) throw new HttpError(403, 'CONSENT_REQUIRED', 'Preview expired. Review the export again.');
        if (libraryImport) {
          const saved = studentWorkspace.commitAcademicRefresh(preview.refresh, {
            review_hash: body.review_hash, expected_head_revision: preview.refresh.base.revision, idempotency_key: `academic-preview-${body.preview_id}`,
          });
          preview.consumed = true;
          return json(response, 201, saved);
        }
        const content = JSON.stringify(preview.snapshot, null, 2);
        if (Buffer.byteLength(content) > 48000) throw new HttpError(413, 'BUDGET_EXCEEDED', 'Select fewer courses for this import.');
        const value = store.createDocument({ title: 'Reviewed academic snapshot', text: content, kind: 'study', academic_policy: 'learning_support' }, { idempotencyKey: body.preview_id });
        preview.consumed = true;
        return json(response, 201, documentResult(value));
      }
      if (route === '/tasks') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listTasks() });
        if (request.method === 'POST') {
          const body = await privateBody(['title', 'deadline', 'course_label', 'effort_minutes', 'dependency_ids', 'parent_id'], ['title'], 16_384);
          return json(response, 201, { task: store.createTask(body, idempotency(request)) });
        }
        methodError();
      }
      const taskRoute = /^\/tasks\/([^/]+)$/.exec(route);
      if (taskRoute) {
        noQuery(url);
        const taskId = id(taskRoute[1]);
        if (request.method === 'GET') return json(response, 200, { task: found(store.getTask(taskId)) });
        if (request.method === 'PATCH') {
          const body = await privateBody(['expected_revision', 'title', 'status', 'deadline', 'course_label', 'effort_minutes', 'dependency_ids', 'parent_id'], ['expected_revision'], 16_384);
          const { expected_revision, ...patch } = body;
          if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide at least one changed task field.');
          return json(response, 200, { task: store.updateTask(taskId, patch, expected_revision) });
        }
        if (request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          store.deleteTask(taskId, body.expected_revision);
          return json(response, 200, { deleted: true });
        }
        methodError();
      }
      if (route === '/documents') {
        noQuery(url);
        if (request.method === 'GET') return json(response, 200, { items: store.listDocuments() });
        if (request.method === 'POST') {
          const body = await privateBody(['title', 'content', 'kind', 'academic_policy'], ['title', 'content']);
          const { content, ...input } = body;
          return json(response, 201, documentResult(store.createDocument({ ...input, text: content }, idempotency(request))));
        }
        methodError();
      }
      if (route === '/documents/search') {
        if (request.method !== 'GET') methodError();
        if ([...url.searchParams.keys()].some(key => key !== 'q') || url.searchParams.getAll('q').length !== 1) {
          throw new HttpError(400, 'INVALID_INPUT', 'Provide one note search query.');
        }
        return json(response, 200, { items: store.searchDocuments(url.searchParams.get('q')) });
      }
      const docRoute = /^\/documents\/([^/]+)(\/revisions)?$/.exec(route);
      if (docRoute) {
        noQuery(url);
        const docId = id(docRoute[1]);
        if (docRoute[2]) {
          if (request.method !== 'GET') methodError();
          return json(response, 200, { items: store.listDocumentRevisions(docId).map(item => item.revision) });
        }
        if (request.method === 'GET') return json(response, 200, documentResult(found(store.getDocument(docId))));
        if (request.method === 'PATCH') {
          const body = await privateBody(['expected_revision', 'title', 'content', 'kind', 'academic_policy'], ['expected_revision']);
          const { expected_revision, content, ...patch } = body;
          if (content !== undefined) patch.text = content;
          if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_INPUT', 'Provide at least one changed note field.');
          return json(response, 200, documentResult(store.updateDocument(docId, patch, expected_revision)));
        }
        if (request.method === 'DELETE') {
          const body = await privateBody(['expected_revision'], ['expected_revision'], 4096);
          store.deleteDocument(docId, body.expected_revision);
          return json(response, 200, { deleted: true });
        }
        methodError();
      }
      notFound();
    } catch (error) { failure(response, error); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(reminderTimer); clearInterval(focusTimer); clearInterval(dynamicTaskTimer); reminders.dispose(); focus.dispose(); publicJobService.close();
    policy?.clear();
    academicPreviews.clear();
    onboardingRoutes.clear();
    cloudOnboardingRoutes.clear();
    for (const operation of sourceOperations) operation.abort();
    closePromise = (async () => {
      try {
        await studentWorkspace.runner.drain();
        await hostTurns.drain();
        await applicationBrowser.drain();
        await codexProfile.stop(); await d2lRoutes.clear();
        await remoteRoutes.clear();
        if (server.listening) {
          const stopped = new Promise(done => server.close(done));
          const drainTimeout = setTimeout(() => server.closeAllConnections(), 1500);
          server.closeIdleConnections();
          try { await stopped; } finally { clearTimeout(drainTimeout); }
        }
        await Promise.allSettled([...activeBackups]);
        await control?.close();
      } finally { try { store.close(); } finally { resolveClosed(); } }
    })();
    return closePromise;
  };
  try {
    async function listen(candidate) {
      return new Promise((ready, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); ready(); });
      });
    }
    try { await listen(port); }
    catch (error) { if (error.code !== 'EADDRINUSE' || port === 0) throw error; await listen(0); }
    origin = 'http://127.0.0.1:' + server.address().port;
    policy = createSessionPolicy({ origin, sessionTtlMs, pairingTtlMs });
    control = await startControl({ root: store.root, origin, onAgentCommand: async (destination, command, data, embeddedLease) => {
      if (closing) throw new HttpError(503, 'OFFLINE', 'The local runtime is stopping.');
      const lease = embeddedLease ? embeddedLeases.get(embeddedLease) : null;
      if (embeddedLease && (!lease || destination !== 'codex' || lease.authorize() !== true || (command !== 'status' && data?.grant_id !== lease.grantId))) throw new HttpError(403, 'CONSENT_REQUIRED', 'This embedded request no longer has its exact reviewed authority.');
      if (lease) {
        if (!lease.permit || lease.permit.used || lease.permit.command !== command || lease.permit.fingerprint !== workflowHash(data ?? {})) throw new HttpError(403, 'SCOPE_DENIED', 'This embedded tool call was not issued by the scoped broker.');
        lease.permit.used = true;
      }
      if (command === 'status') {
        if (data !== undefined) plainBody(data, []);
        return { edition: 'local', version: LOCAL_VERSION, destination, healthy: store.integrity().integrity === 'ok',
          grants: store.listAgentGrants().filter(grant => (!lease || grant.id === lease.grantId) && grant.destination === destination && grant.state === 'active' && Date.parse(grant.expires_at) > Date.now())
            .map(grant => ({ id: grant.id, expires_at: grant.expires_at, max_bytes: grant.max_bytes, remaining_bytes: grant.max_bytes - grant.used_bytes })),
          next_step: 'Review selected context and task proposals in the paired LearnBridge dashboard. Granting or accepting is not an MCP tool.' };
      }
      if (command === 'context') {
        plainBody(data, ['grant_id', 'task_ids', 'document_ids', 'source_entry_ids', 'max_bytes'], ['grant_id']);
        if (data.max_bytes !== undefined && (!Number.isInteger(data.max_bytes) || data.max_bytes < 1 || data.max_bytes > 48000)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid context budget.');
        return store.agentContext({ ...data, max_bytes: data.max_bytes ?? 48000, destination });
      }
      if (command === 'propose_task') {
        plainBody(data, ['grant_id', 'title', 'deadline', 'course_label', 'reason', 'idempotency_key'], ['grant_id', 'title', 'idempotency_key']);
        return store.proposeTask({ ...data, destination });
      }
      if (command === 'propose_document') {
        plainBody(data, ['grant_id', 'source_document_id', 'source_revision', 'source_sha256', 'title', 'draft', 'purpose', 'academic_policy', 'idempotency_key'],
          ['grant_id', 'source_document_id', 'source_revision', 'source_sha256', 'title', 'draft', 'purpose', 'academic_policy', 'idempotency_key']);
        if (typeof data.draft !== 'string' || Buffer.byteLength(data.draft) > 10000 || typeof data.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(data.idempotency_key)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid writing proposal.');
        const source = store.assertAgentDocumentSelection({ destination, grant_id: data.grant_id,
          document_id: data.source_document_id, revision: data.source_revision, sha256: data.source_sha256 });
        const kinds = { study_note: 'study_guide', outline: 'outline', revision: 'revision', general: 'markdown_artifact' };
        const policies = { learning_support: 'learning_support', graded_scaffolding: 'graded_restricted', not_applicable: 'unrestricted' };
        if (!Object.hasOwn(kinds, data.purpose) || !Object.hasOwn(policies, data.academic_policy)) throw new HttpError(400, 'INVALID_INPUT', 'Invalid writing policy.');
        const scopePolicy = store.assertAgentAcademicPolicy({ destination, grant_id: data.grant_id }).academic_policy;
        if (scopePolicy === 'graded_restricted' && !['study_note', 'outline'].includes(data.purpose)) throw new HttpError(403, 'SCOPE_DENIED', 'The selected context permits conceptual study support only.');
        const effectivePolicy = scopePolicy === 'graded_restricted' ? 'graded_restricted'
          : scopePolicy === 'learning_support' && policies[data.academic_policy] === 'unrestricted' ? 'learning_support' : policies[data.academic_policy];
        const proposal = createWritingService({ store }).createProposal({ title: data.title, kind: kinds[data.purpose], draft_text: data.draft,
          source_documents: [{ id: source.document_id, revision: source.revision, sha256: source.sha256 }],
          academic_policy: effectivePolicy, origin: 'agent_paste' },
          { idempotencyKey: `${destination}-${createHash('sha256').update(data.idempotency_key).digest('hex')}`, agentOrigin: destination, grantId: data.grant_id });
        return { id: proposal.id, revision: proposal.revision, state: proposal.data.state, payload_hash: proposal.data.payload_hash,
          source_document_id: source.document_id, accepted_document: null, next_step: 'Review the exact alternative in Writing. The original is unchanged.' };
      }
      throw new HttpError(403, 'SCOPE_DENIED', 'This operation is unavailable to an agent.');
    }, onCommand: async (command, data) => {
      if (command === 'status') { if (data !== undefined) throw new Error('Invalid control request'); return status(); }
      if (command === 'stop') {
        if (data !== undefined) throw new Error('Invalid control request');
        closing = true;
        setTimeout(() => { void close().catch(() => {}); }, 100);
        return { stopping: true };
      }
      if (command === 'backup') {
        if (closing) throw new Error('The local runtime is stopping.');
        plainBody(data, ['output'], ['output']);
        if (typeof data.output !== 'string' || data.output.length > 2000) throw new Error('Invalid control request');
        const operation = store.backup(data.output);
        activeBackups.add(operation);
        try { return await operation; } finally { activeBackups.delete(operation); }
      }
      throw new Error('Unsupported control request');
    } });
    return { origin, address: server.address(), dataRoot: store.root, createPairingCode: () => policy.createPairingCode(), close, closed };
  } catch (error) { await close(); throw error; }
}
