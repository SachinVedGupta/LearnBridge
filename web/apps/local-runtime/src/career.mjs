import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';

// Pure preparation only. The authenticated runtime supplies selected,
// human-confirmed facts and trusted observations. This module performs no
// network, file access, code execution, application submission or messaging.
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const careerHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function object(value, allowed, required = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, max = 1000, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!multiline && /[\r\n]/.test(value))) fail();
  return value.trim();
}
function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail();
  return value;
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; }
function strings(value, maxItems = 30, maxChars = 500) {
  if (!Array.isArray(value) || value.length > maxItems) fail();
  return [...new Set(value.map(item => text(item, maxChars)))];
}

/** Strip declared tracking parameters, reject credentials/free-form queries.
 * URL validation is not proof of official ownership; released adapters must
 * independently verify an official source before labeling an observation. */
export function canonicalCareerURL(value) {
  const raw = text(value, 2000);
  if (/[\u0000-\u0020\u007f]/.test(raw)) fail();
  let url; try { url = new URL(raw); } catch { fail(); }
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|invalid|test|example)$/.test(url.hostname)
    || /[\r\n\u0000]/.test(pathname)) fail();
  const retained = [];
  for (const [key, value] of url.searchParams) {
    if (/^(?:utm_(?:source|medium|campaign|term|content)|fbclid|gclid)$/i.test(key)) continue;
    if (!['gh_jid', 'job_id', 'posting_id'].includes(key) || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail();
    if (retained.some(([existing]) => existing === key)) fail();
    retained.push([key, value]);
  }
  url.search = ''; retained.sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of retained) url.searchParams.set(key, value);
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}

const REQUIREMENT_FIELDS = ['graduation_date', 'gpa', 'work_authorization', 'coop_status', 'skill'];
function requirement(input) {
  object(input, ['field', 'operator', 'value', 'raw_text'], ['field', 'operator', 'value', 'raw_text']);
  if (!REQUIREMENT_FIELDS.includes(input.field)) fail();
  const raw_text = text(input.raw_text, 2000, true);
  if (input.field === 'graduation_date' && input.operator === 'between') {
    object(input.value, ['from', 'to'], ['from', 'to']);
    const from = date(input.value.from), to = date(input.value.to); if (from > to) fail();
    return { field: input.field, operator: input.operator, value: { from, to }, raw_text };
  }
  if (input.field === 'gpa' && input.operator === 'at_least') {
    object(input.value, ['minimum', 'scale'], ['minimum', 'scale']);
    if (typeof input.value.minimum !== 'number' || typeof input.value.scale !== 'number' || !Number.isFinite(input.value.minimum)
      || !Number.isFinite(input.value.scale) || input.value.scale <= 0 || input.value.scale > 5
      || input.value.minimum < 0 || input.value.minimum > input.value.scale) fail();
    return { ...input, value: { minimum: input.value.minimum, scale: input.value.scale }, raw_text };
  }
  if (['work_authorization', 'coop_status', 'skill'].includes(input.field) && input.operator === 'equals') {
    return { ...input, value: text(input.value, 500), raw_text };
  }
  fail();
}

export function normalizeCareerRole(input, { now = new Date().toISOString() } = {}) {
  stamp(now);
  object(input, ['provider', 'company', 'provider_job_id', 'title', 'url', 'locations', 'term', 'source_kind',
    'source_excerpt', 'requirements', 'availability', 'fetched_at', 'deadline_at', 'deadline_text'],
  ['provider', 'company', 'provider_job_id', 'title', 'url', 'source_kind', 'source_excerpt', 'fetched_at']);
  const provider = text(input.provider, 40).toLowerCase(); if (!/^[a-z][a-z0-9_-]*$/.test(provider)) fail();
  const company = text(input.company, 200), provider_job_id = text(input.provider_job_id, 200);
  const fetched_at = stamp(input.fetched_at); if (Date.parse(fetched_at) > Date.parse(now) + 300000) fail();
  if (!['official', 'lead'].includes(input.source_kind)) fail();
  const availability = input.availability ?? 'unknown'; if (!['open', 'closed', 'unknown'].includes(availability)) fail();
  if (input.source_kind === 'lead' && availability !== 'unknown') fail();
  const url = canonicalCareerURL(input.url);
  const deadline_at = input.deadline_at == null ? null : stamp(input.deadline_at);
  const requirements = input.requirements ?? []; if (!Array.isArray(requirements) || requirements.length > 30) fail();
  const source_excerpt = text(input.source_excerpt, 20000, true), parsedRequirements = requirements.map(requirement);
  if (parsedRequirements.some(item => !source_excerpt.includes(item.raw_text))) fail('SCOPE_DENIED');
  return { schema_version: 1, id: `role_${careerHash([provider, company.toLowerCase(), provider_job_id])}`,
    provider, company, provider_job_id, title: text(input.title, 500), url,
    official_url: input.source_kind === 'official' ? url : null, source_kind: input.source_kind,
    source_excerpt, locations: strings(input.locations ?? []),
    term: input.term == null ? null : text(input.term, 300), requirements: parsedRequirements,
    availability, fetched_at, deadline_at, deadline_text: input.deadline_text == null ? null : text(input.deadline_text, 1000, true),
    requirements_current: true, last_check: { status: 'observed', checked_at: fetched_at }, history: [] };
}

export function careerRoleView(role, { now = new Date().toISOString(), maxAgeDays = 7 } = {}) {
  stamp(now); if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 90) fail();
  const stale = Date.parse(now) - Date.parse(role.fetched_at) >= maxAgeDays * 86400000 || role.last_check.status !== 'observed';
  const expired = role.deadline_at !== null && role.deadline_at <= now;
  return { ...clone(role), stale, expired, verified_opening: role.source_kind === 'official' && role.availability === 'open' && !stale && !expired };
}

export function updateCareerAvailability(role, input, { now = new Date().toISOString() } = {}) {
  stamp(now); object(input, ['result', 'checked_at', 'source_excerpt'], ['result', 'checked_at']);
  if (!['timeout', 'open', 'explicit_close'].includes(input.result)) fail();
  const checked_at = stamp(input.checked_at); if (checked_at < role.last_check.checked_at || checked_at > now) fail('REVISION_CONFLICT');
  const next = clone(role);
  next.history = [...next.history, { availability: role.availability, fetched_at: role.fetched_at, last_check: role.last_check }].slice(-20);
  next.last_check = { status: input.result === 'timeout' ? 'failed' : 'observed', checked_at };
  if (input.result !== 'timeout') {
    if (role.source_kind !== 'official') fail('SCOPE_DENIED');
    next.source_excerpt = text(input.source_excerpt, 20000, true);
    next.requirements_current = next.requirements.every(item => next.source_excerpt.includes(item.raw_text));
    next.availability = input.result === 'explicit_close' ? 'closed' : 'open'; next.fetched_at = checked_at;
  } else if (Object.hasOwn(input, 'source_excerpt')) fail();
  return next;
}

export function deduplicateCareerRoles(roles) {
  if (!Array.isArray(roles) || roles.length > 500) fail();
  const records = new Map();
  for (const role of roles) {
    const existing = records.get(role.id);
    if (!existing || role.fetched_at > existing.fetched_at) records.set(role.id, clone(role));
  }
  const values = [...records.values()]; const possible_duplicates = [];
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    if (values[i].official_url && values[i].official_url === values[j].official_url) {
      possible_duplicates.push({ role_ids: [values[i].id, values[j].id], reason: 'same_official_url_different_provider_identity', decision: 'needs_review' });
    }
  }
  return { roles: values, possible_duplicates };
}

const FACT_KEYS = ['full_name', 'email', 'education', 'graduation_date', 'gpa', 'work_authorization', 'coop_status',
  'experience', 'project', 'skill', 'goal', 'veteran_status', 'disability', 'gender', 'race'];
const sensitive = new Set(['veteran_status', 'disability', 'gender', 'race']);
function confirmedFact(input, now) {
  object(input, ['id', 'revision', 'key', 'value', 'confirmed', 'evidence', 'expires_at'], ['id', 'revision', 'key', 'value', 'confirmed', 'evidence']);
  if (!FACT_KEYS.includes(input.key) || input.confirmed !== true) fail('CONSENT_REQUIRED');
  object(input.evidence, ['kind', 'ref', 'sha256', 'excerpt'], ['kind']);
  if (!['student_statement', 'document'].includes(input.evidence.kind)) fail();
  if (sensitive.has(input.key) && input.evidence.kind !== 'student_statement') fail('CONSENT_REQUIRED');
  const expires_at = input.expires_at == null ? null : stamp(input.expires_at); if (expires_at !== null && expires_at <= now) fail('CONSENT_REQUIRED');
  if (input.evidence.kind === 'document') {
    text(input.evidence.ref, 500); if (!/^[a-f0-9]{64}$/.test(input.evidence.sha256)) fail();
    text(input.evidence.excerpt, 4000, true);
    if (!input.evidence.excerpt.includes(text(input.value, 4000, true))) fail('SCOPE_DENIED');
  }
  return { id: text(input.id, 200), revision: revision(input.revision), key: input.key, value: text(input.value, 4000, true),
    confirmed: true, evidence: clone(input.evidence), expires_at };
}
function factBank(facts, now) {
  if (!Array.isArray(facts) || facts.length > 100) fail();
  const parsed = facts.map(f => confirmedFact(f, now)); if (new Set(parsed.map(f => f.id)).size !== parsed.length) fail();
  return parsed;
}

export function compareCareerEligibility(role, { facts = [], now = new Date().toISOString() } = {}) {
  stamp(now); const bank = factBank(facts, now);
  return role.requirements.map(req => {
    const matches = bank.filter(f => f.key === req.field);
    let result = 'needs_confirmation';
    if (role.requirements_current !== false && matches.length && new Set(matches.map(f => f.value)).size === 1) {
      const actual = matches[0].value;
      if (req.field === 'graduation_date') {
        try { date(actual); result = actual >= req.value.from && actual <= req.value.to ? 'known_match' : 'known_mismatch'; } catch { /* literal unparsed date stays unknown */ }
      } else if (req.field === 'gpa') {
        const match = /^(\d(?:\.\d{1,3})?)\/(\d(?:\.\d{1,3})?)$/.exec(actual);
        if (match && Number(match[2]) === req.value.scale && Number(match[1]) <= req.value.scale) {
          result = Number(match[1]) >= req.value.minimum ? 'known_match' : 'known_mismatch';
        }
      } else result = actual.toLowerCase() === req.value.toLowerCase() ? 'known_match' : 'known_mismatch';
    }
    return { requirement: clone(req), result, fact_refs: matches.map(f => ({ id: f.id, revision: f.revision })),
      next_action: result === 'needs_confirmation' ? `Confirm ${req.field} against this exact requirement.` : null };
  });
}

export function shortlistCareerRole(role, input, { now = new Date().toISOString(), prior = null } = {}) {
  stamp(now); object(input, ['state', 'note', 'expected_revision'], ['state']);
  if (!['saved', 'investigating', 'preparing', 'applied', 'closed', 'dismissed'].includes(input.state)) fail();
  if (input.state === 'applied') fail('UNSUPPORTED'); // needs separate confirmed application evidence, never a discovery inference
  if (prior && (prior.role_id !== role.id || prior.revision !== input.expected_revision)) fail('REVISION_CONFLICT');
  if (!prior && Object.hasOwn(input, 'expected_revision')) fail();
  return { schema_version: 1, role_id: role.id, role_hash: careerHash(role), revision: (prior?.revision ?? 0) + 1,
    state: input.state, note: input.note == null ? null : text(input.note, 2000, true), updated_at: now };
}

function artifact(input) {
  object(input, ['id', 'filename', 'sha256', 'mime', 'size'], ['id', 'filename', 'sha256', 'mime', 'size']);
  const filename = text(input.filename, 200);
  const extensions = { 'application/pdf': '.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'text/plain': '.txt' };
  if (/[\\/]/.test(filename) || !extensions[input.mime] || !filename.toLowerCase().endsWith(extensions[input.mime])
    || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 10 * 1024 * 1024) fail();
  return { ...input, id: text(input.id, 200), filename };
}
export function applicationReviewHash(draft) {
  const { review, state, revision, ...payload } = draft;
  return careerHash(payload);
}

export function prepareCareerApplication(role, input, { now = new Date().toISOString(), prior = null, verifyArtifact } = {}) {
  stamp(now); object(input, ['questions', 'facts', 'selected_fact_ids', 'artifacts', 'expected_revision'], ['questions', 'facts', 'selected_fact_ids']);
  if (prior && (prior.role_id !== role.id || prior.revision !== input.expected_revision)) fail('REVISION_CONFLICT');
  if (!prior && Object.hasOwn(input, 'expected_revision')) fail();
  const bank = factBank(input.facts, now), selected = strings(input.selected_fact_ids, 100, 200);
  if (selected.some(id => !bank.some(f => f.id === id))) fail('SCOPE_DENIED');
  if (!Array.isArray(input.questions) || input.questions.length > 50 || !input.questions.length) fail();
  const unresolved = []; const used = new Map();
  const answers = input.questions.map(question => {
    object(question, ['id', 'prompt', 'fact_key', 'required', 'max_length'], ['id', 'prompt', 'fact_key', 'required']);
    const id = text(question.id, 200), prompt = text(question.prompt, 4000, true);
    if (!FACT_KEYS.includes(question.fact_key) || typeof question.required !== 'boolean') fail();
    const limit = question.max_length ?? 12000; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12000) fail();
    const facts = bank.filter(f => selected.includes(f.id) && f.key === question.fact_key);
    const conflicting = !['education', 'experience', 'project', 'skill', 'goal'].includes(question.fact_key) && new Set(facts.map(f => f.value)).size > 1;
    const answer = facts.map(f => f.value).join('\n');
    const reason = conflicting ? 'conflicting_confirmed_facts' : !facts.length ? 'missing_confirmed_fact' : answer.length > limit ? 'answer_exceeds_field_limit' : null;
    if (reason) unresolved.push({ question_id: id, fact_key: question.fact_key, required: question.required, reason });
    else for (const fact of facts) used.set(fact.id, { id: fact.id, revision: fact.revision, value_hash: careerHash(fact.value), evidence_hash: careerHash(fact.evidence) });
    return { id, prompt, required: question.required, fact_key: question.fact_key, max_length: limit,
      answer: reason ? null : answer, fact_refs: reason ? [] : facts.map(f => ({ id: f.id, revision: f.revision })), unresolved: reason };
  });
  if (new Set(answers.map(a => a.id)).size !== answers.length) fail();
  const artifacts = (input.artifacts ?? []).map(artifact); if (artifacts.length > 10 || new Set(artifacts.map(a => a.id)).size !== artifacts.length) fail();
  for (const item of artifacts) {
    const observed = verifyArtifact?.(item.id);
    if (!observed) unresolved.push({ artifact_id: item.id, required: true, reason: 'artifact_not_verified' });
    else if (observed.sha256 !== item.sha256 || observed.size !== item.size || observed.mime !== item.mime) fail('REVISION_CONFLICT');
  }
  const current = careerRoleView(role, { now });
  if (!current.verified_opening) unresolved.push({ role_id: role.id, required: true, reason: current.source_kind !== 'official' ? 'unverified_role' : current.expired ? 'expired_role' : current.stale ? 'stale_role' : 'role_not_open' });
  return { schema_version: 1, id: prior?.id ?? randomUUID(), role_id: role.id, role_hash: careerHash(role), target: role.official_url,
    template_version: 'verbatim-confirmed-facts-1', prepared_at: now, revision: (prior?.revision ?? 0) + 1,
    answers, fact_pins: [...used.values()], artifacts, unresolved,
    state: unresolved.some(item => item.required) ? 'blocked' : 'ready_for_review', review: null, submission: 'unsupported' };
}

export function reviewCareerApplication(draft, input, { reviewer, now = new Date().toISOString(), resolveRole, resolveFact, verifyArtifact } = {}) {
  stamp(now); object(input, ['expected_revision', 'review_hash', 'decision'], ['expected_revision', 'review_hash', 'decision']);
  if (draft.revision !== input.expected_revision || input.review_hash !== applicationReviewHash(draft)) fail('REVISION_CONFLICT');
  if (!['accept', 'reject'].includes(input.decision) || draft.review || typeof reviewer !== 'string') fail();
  if (input.decision === 'accept') {
    if (draft.unresolved.some(item => item.required)) fail('CONSENT_REQUIRED');
    const role = resolveRole?.(draft.role_id); if (!role || careerHash(role) !== draft.role_hash || draft.target !== role.official_url || !careerRoleView(role, { now }).verified_opening) fail('REVISION_CONFLICT');
    const currentFacts = new Map();
    for (const pin of draft.fact_pins) {
      const fact = resolveFact?.(pin.id); if (!fact) fail('CONSENT_REQUIRED');
      const validated = confirmedFact(fact, now);
      if (validated.revision !== pin.revision || careerHash(validated.value) !== pin.value_hash || careerHash(validated.evidence) !== pin.evidence_hash) fail('REVISION_CONFLICT');
      currentFacts.set(pin.id, validated);
    }
    for (const answer of draft.answers) if (answer.answer !== null) {
      const facts = answer.fact_refs.map(ref => currentFacts.get(ref.id));
      if (facts.some((fact, index) => !fact || fact.key !== answer.fact_key || fact.revision !== answer.fact_refs[index].revision)
        || facts.map(fact => fact.value).join('\n') !== answer.answer) fail('SCOPE_DENIED');
    }
    for (const item of draft.artifacts) {
      const observed = verifyArtifact?.(item.id);
      if (!observed || observed.sha256 !== item.sha256 || observed.size !== item.size || observed.mime !== item.mime) fail('REVISION_CONFLICT');
    }
  }
  return { ...clone(draft), revision: draft.revision + 1, state: input.decision === 'accept' ? 'reviewed_draft' : 'rejected',
    review: { reviewer: text(reviewer, 200), reviewed_at: now, payload_hash: input.review_hash, decision: input.decision } };
}

export function startCareerPractice(input, { now = new Date().toISOString() } = {}) {
  stamp(now); object(input, ['exercise_id', 'title', 'source_url', 'mode', 'questions'], ['exercise_id', 'title', 'mode', 'questions']);
  if (!['hints', 'timed', 'walkthrough', 'mock_interview'].includes(input.mode) || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 50) fail();
  const questions = input.questions.map(q => { object(q, ['id', 'prompt'], ['id', 'prompt']); return { id: text(q.id, 200), prompt: text(q.prompt, 4000, true) }; });
  if (new Set(questions.map(q => q.id)).size !== questions.length) fail();
  return { schema_version: 1, id: randomUUID(), exercise_id: text(input.exercise_id, 200), title: text(input.title, 500),
    source_url: input.source_url == null ? null : canonicalCareerURL(input.source_url), mode: input.mode, questions,
    revision: 1, state: 'active', attempts: [], checkpoint: { answered_question_ids: [], next_question_id: questions[0].id }, updated_at: now };
}

function executionReceipt(input) {
  if (!input) return { state: 'not_executed', exit_code: null, tests: [], evidence_ref: null };
  object(input, ['state', 'exit_code', 'tests', 'evidence_ref', 'student_answer_hash'], ['state', 'exit_code', 'tests', 'evidence_ref', 'student_answer_hash']);
  if (input.state !== 'executed' || !Number.isInteger(input.exit_code) || input.exit_code < 0 || input.exit_code > 255
    || !Array.isArray(input.tests) || !input.tests.length || input.tests.length > 100 || !/^[a-f0-9]{64}$/.test(input.student_answer_hash)) fail();
  const tests = input.tests.map(item => { object(item, ['name', 'passed'], ['name', 'passed']); if (typeof item.passed !== 'boolean') fail(); return { name: text(item.name, 300), passed: item.passed }; });
  return { ...input, evidence_ref: text(input.evidence_ref, 500), tests };
}

export function recordCareerAnswer(session, input, { now = new Date().toISOString(), execution } = {}) {
  stamp(now); object(input, ['expected_revision', 'question_id', 'student_answer', 'hints_used'], ['expected_revision', 'question_id', 'student_answer']);
  if (input.expected_revision !== session.revision || session.state !== 'active' || input.question_id !== session.checkpoint.next_question_id) fail('REVISION_CONFLICT');
  text(input.student_answer, 20000, true);
  const student_answer = input.student_answer, hints_used = input.hints_used ?? 0;
  if (!Number.isSafeInteger(hints_used) || hints_used < 0 || hints_used > 100) fail();
  const result = executionReceipt(execution);
  if (result.state === 'executed' && result.student_answer_hash !== careerHash(student_answer)) fail('REVISION_CONFLICT');
  const passed = result.state === 'executed' && result.exit_code === 0 && result.tests.every(test => test.passed);
  const outcome = result.state === 'not_executed' ? 'not_assessed' : !passed ? 'failed' : hints_used ? 'passed_after_hints' : 'independent_pass';
  const attempts = [...session.attempts, { question_id: input.question_id, student_answer, hints_used,
    result, outcome, answered_at: now }];
  const answered = attempts.map(attempt => attempt.question_id);
  const next = session.questions.find(question => !answered.includes(question.id))?.id ?? null;
  return { ...clone(session), revision: session.revision + 1, attempts, state: next ? 'active' : 'completed',
    checkpoint: { answered_question_ids: answered, next_question_id: next }, updated_at: now };
}

export function transitionCareerPractice(session, input, { now = new Date().toISOString() } = {}) {
  stamp(now); object(input, ['expected_revision', 'action'], ['expected_revision', 'action']);
  const { expected_revision, action } = input; if (expected_revision !== session.revision) fail('REVISION_CONFLICT');
  if (action === 'interrupt' && session.state === 'active') return { ...clone(session), revision: session.revision + 1, state: 'interrupted', updated_at: now };
  if (action === 'resume' && session.state === 'interrupted') return { ...clone(session), revision: session.revision + 1, state: 'active', updated_at: now };
  fail('REVISION_CONFLICT');
}

export function prepareCareerFollowup(input, { facts = [], now = new Date().toISOString(), prior = null } = {}) {
  stamp(now); object(input, ['operation_id', 'application_id', 'contact_id', 'recipient', 'channel', 'fact_ids', 'remind_at'],
    ['operation_id', 'contact_id', 'recipient', 'channel', 'fact_ids', 'remind_at']);
  const operation_id = text(input.operation_id, 100); if (!/^[A-Za-z0-9_-]{8,100}$/.test(operation_id) || !['email', 'linkedin', 'other'].includes(input.channel)) fail();
  const bank = factBank(facts, now), ids = strings(input.fact_ids, 20, 200), remind_at = stamp(input.remind_at);
  if (!ids.length || ids.some(id => !bank.some(fact => fact.id === id)) || remind_at <= now) fail();
  const selected = ids.map(id => bank.find(fact => fact.id === id)); if (selected.some(fact => sensitive.has(fact.key))) fail('SCOPE_DENIED');
  const result = { schema_version: 1, id: `followup_${careerHash(operation_id)}`, operation_id,
    application_id: input.application_id == null ? null : text(input.application_id, 200), contact_id: text(input.contact_id, 200),
    recipient: text(input.recipient, 500), channel: input.channel, message: selected.map(fact => fact.value).join('\n'),
    fact_refs: selected.map(fact => ({ id: fact.id, revision: fact.revision, value_hash: careerHash(fact.value) })),
    reminder: { at: remind_at, origin: 'student_selected' }, state: 'draft', sending: 'unsupported', prepared_at: now };
  if (prior) {
    const { prepared_at: firstPrepared, ...original } = prior;
    const { prepared_at: retriedAt, ...retry } = result;
    if (careerHash(original) !== careerHash(retry)) fail('REVISION_CONFLICT');
    return clone(prior);
  }
  return result;
}
