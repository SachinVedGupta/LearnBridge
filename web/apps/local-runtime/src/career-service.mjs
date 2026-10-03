import { LearnBridgeError } from '@learnbridge/core';
import { profileView } from './profile.mjs';
import {
  careerHash, normalizeCareerRole, careerRoleView, shortlistCareerRole, prepareCareerApplication,
  applicationReviewHash, reviewCareerApplication, startCareerPractice, recordCareerAnswer,
  transitionCareerPractice, prepareCareerFollowup,
} from './career.mjs';

const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const object = (input, allowed, required = []) => {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(input, key))) fail();
};
const selected = input => {
  if (!Array.isArray(input) || input.length > 100 || new Set(input).size !== input.length || input.some(id => typeof id !== 'string')) fail();
  return input;
};
const profileKeys = { name: 'full_name', graduation: 'graduation_date', experience: 'experience', university: 'education', program: 'education', goals: 'goal' };

/** The runtime already authenticates a human session before these synchronous
 * methods. Workspace records retain revisions, and the one-writer LocalStore
 * serializes create/replay and CAS updates. No app connection is read here. */
export function createCareerWorkspace(store, { clock = () => new Date().toISOString() } = {}) {
  const list = category => store.listWorkspaceRecords({ kind: 'career_item' }).filter(record => record.data.category === category);
  function get(id, category) {
    const record = store.getWorkspaceRecord(id);
    if (!record || record.kind !== 'career_item' || record.data.category !== category) fail('SCOPE_DENIED');
    return record;
  }
  function facts(ids = null) {
    const allowed = ids === null ? null : new Set(selected(ids));
    const current = profileView(store.listWorkspaceRecords({ kind: 'profile_fact' }), { now: clock(), resolveEvidence: id => store.getDocument(id) });
    const available = current.filter(record => (!allowed || allowed.has(record.id)) && record.data.state === 'confirmed'
      && !record.stale && !record.conflict && record.data.purposes.includes('career') && Object.hasOwn(profileKeys, record.data.field));
    if (allowed && available.length !== allowed.size) fail('CONSENT_REQUIRED');
    return available.map(record => {
      const evidence = record.data.evidence.kind === 'student_statement' ? { kind: 'student_statement' }
        : { kind: 'document', ref: record.data.evidence.id, sha256: record.data.evidence.sha256, excerpt: record.data.evidence.excerpt };
      return { id: record.id, revision: record.revision, key: profileKeys[record.data.field], value: record.data.value,
        confirmed: true, evidence, expires_at: record.data.expires_at };
    });
  }
  function retry(category, body, key, create) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail();
    const request_hash = careerHash({ category, body });
    const existing = store.listWorkspaceRecords({ kind: 'career_item' }).find(record => record.data.creation_operation?.key === key);
    if (existing) {
      if (existing.data.creation_operation.request_hash !== request_hash || existing.data.category !== category) fail('REVISION_CONFLICT');
      return existing;
    }
    const result = create();
    const data = { category, ...result.data, creation_operation: { key, request_hash } };
    return store.createWorkspaceRecord({ kind: 'career_item', title: result.title.slice(0, 480), data }, { idempotencyKey: `career-${key}` });
  }
  function update(record, data, expected_revision) {
    return store.updateWorkspaceRecord(record.id, { expected_revision, data: { ...record.data, ...data } });
  }
  function roleByDomainId(id) { return list('role').find(record => record.data.role.id === id)?.data.role ?? null; }
  function artifactById(id) {
    const record = store.getWorkspaceRecord(id);
    if (!record || record.kind !== 'artifact' || record.data.state !== 'verified' || !record.data.sha256
      || !record.data.mime || !Number.isSafeInteger(record.data.size)) return null;
    return { id: record.id, sha256: record.data.sha256, mime: record.data.mime, size: record.data.size };
  }
  const draftStatus = record => {
    const draft = record.data.draft, currentRole = roleByDomainId(draft.role_id), currentFacts = facts();
    const stale = !currentRole || careerHash(currentRole) !== draft.role_hash || !careerRoleView(currentRole, { now: clock() }).verified_opening
      || draft.fact_pins.some(pin => { const fact = currentFacts.find(f => f.id === pin.id); return !fact || fact.revision !== pin.revision
        || careerHash(fact.value) !== pin.value_hash || careerHash(fact.evidence) !== pin.evidence_hash; });
    return { ...record, review_hash: applicationReviewHash(draft), needs_refresh: stale };
  };
  return {
    listFacts: () => facts(),
    listRoles: () => list('role').map(record => ({ ...record, view: { ...careerRoleView(record.data.role, { now: clock() }),
      verified_opening: false, verification_notice: 'Student-entered posting excerpt; not fetched or verified by LearnBridge.' } })),
    createRole(input, options = {}) {
      object(input, ['company', 'provider_job_id', 'title', 'url', 'locations', 'term', 'source_kind', 'source_excerpt', 'availability', 'deadline_text'],
        ['company', 'provider_job_id', 'title', 'url', 'source_kind', 'source_excerpt']);
      return retry('role', input, options.idempotencyKey, () => {
        const role = normalizeCareerRole({ ...input, provider: 'manual', fetched_at: clock() }, { now: clock() });
        if (list('role').some(record => record.data.role.id === role.id)) fail('REVISION_CONFLICT');
        return { title: `${role.company}: ${role.title}`, data: { role, shortlist: null, source_verification: 'student_entered_not_live_verified' } };
      });
    },
    changeShortlist(id, input) {
      object(input, ['expected_revision', 'state', 'note'], ['expected_revision', 'state']);
      const record = get(id, 'role');
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const shortlist = shortlistCareerRole(record.data.role, { state: input.state, ...(input.note ? { note: input.note } : {}),
        ...(record.data.shortlist ? { expected_revision: record.data.shortlist.revision } : {}) }, { now: clock(), prior: record.data.shortlist });
      return update(record, { shortlist }, input.expected_revision);
    },
    listApplications: () => list('application').map(draftStatus),
    prepareApplication(input, options = {}) {
      object(input, ['role_id', 'questions', 'selected_profile_ids', 'artifact_ids'], ['role_id', 'questions', 'selected_profile_ids']);
      return retry('application', input, options.idempotencyKey, () => {
        const role = get(input.role_id, 'role').data.role, currentFacts = facts(input.selected_profile_ids);
        const artifacts = selected(input.artifact_ids ?? []).map(id => {
          const record = store.getWorkspaceRecord(id);
          if (!record || record.kind !== 'artifact' || !artifactById(id) || typeof record.data.filename !== 'string') fail('SCOPE_DENIED');
          return { ...artifactById(id), filename: record.data.filename };
        });
        const draft = prepareCareerApplication(role, { questions: input.questions, facts: currentFacts,
          selected_fact_ids: currentFacts.map(f => f.id), artifacts }, { now: clock(), verifyArtifact: artifactById });
        return { title: `Application draft: ${role.company}`, data: { role_record_id: input.role_id, draft,
          posting_evidence: 'student_entered_not_live_verified' } };
      });
    },
    reviewApplication(id, input) {
      object(input, ['expected_revision', 'review_hash', 'decision'], ['expected_revision', 'review_hash', 'decision']);
      const record = get(id, 'application'), previous = record.data.draft.review;
      if (previous && input.expected_revision === record.revision - 1 && previous.payload_hash === input.review_hash
        && previous.decision === input.decision && previous.reviewer === store.identity.student_id) return draftStatus(record);
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const bank = facts();
      const draft = reviewCareerApplication(record.data.draft, input, { now: clock(), reviewer: store.identity.student_id,
        resolveRole: roleByDomainId, resolveFact: id => bank.find(f => f.id === id), verifyArtifact: artifactById });
      return draftStatus(update(record, { draft }, input.expected_revision));
    },
    listPractice: () => list('practice'),
    startPractice(input, options = {}) {
      object(input, ['exercise_id', 'title', 'source_url', 'mode', 'questions'], ['exercise_id', 'title', 'mode', 'questions']);
      return retry('practice', input, options.idempotencyKey, () => {
        const practice = startCareerPractice(input, { now: clock() });
        return { title: practice.title, data: { practice } };
      });
    },
    answerPractice(id, input) {
      object(input, ['expected_revision', 'question_id', 'student_answer', 'hints_used'], ['expected_revision', 'question_id', 'student_answer']);
      const record = get(id, 'practice');
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const practice = recordCareerAnswer(record.data.practice, input, { now: clock() });
      return update(record, { practice }, input.expected_revision);
    },
    transitionPractice(id, input) {
      object(input, ['expected_revision', 'action'], ['expected_revision', 'action']);
      const record = get(id, 'practice');
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const practice = transitionCareerPractice(record.data.practice, input, { now: clock() });
      return update(record, { practice }, input.expected_revision);
    },
    listFollowups: () => list('followup').map(record => ({ ...record, followup_hash: careerHash(record.data.followup) })),
    prepareFollowup(input, options = {}) {
      object(input, ['application_id', 'contact_id', 'recipient', 'channel', 'selected_profile_ids', 'remind_at'],
        ['application_id', 'contact_id', 'recipient', 'channel', 'selected_profile_ids', 'remind_at']);
      return retry('followup', input, options.idempotencyKey, () => {
        get(input.application_id, 'application');
        const currentFacts = facts(input.selected_profile_ids);
        const followup = prepareCareerFollowup({ operation_id: options.idempotencyKey, application_id: input.application_id,
          contact_id: input.contact_id, recipient: input.recipient, channel: input.channel, fact_ids: currentFacts.map(f => f.id), remind_at: input.remind_at },
        { facts: currentFacts, now: clock() });
        return { title: `Follow-up draft: ${followup.recipient}`, data: { followup, reminder_task: null } };
      });
    },
    acceptReminder(id, input) {
      object(input, ['expected_revision', 'followup_hash'], ['expected_revision', 'followup_hash']);
      const record = get(id, 'followup'), followup = record.data.followup;
      if (input.followup_hash !== careerHash(followup)) fail('REVISION_CONFLICT');
      if (record.data.reminder_task && [record.revision, record.revision - 1].includes(input.expected_revision)) return record;
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const bank = facts();
      for (const ref of followup.fact_refs) {
        const fact = bank.find(f => f.id === ref.id); if (!fact || fact.revision !== ref.revision || careerHash(fact.value) !== ref.value_hash) fail('CONSENT_REQUIRED');
      }
      const task = store.createTask({ title: `Follow up with ${followup.recipient}`.slice(0, 480),
        deadline: { precision: 'instant', instant: followup.reminder.at, timezone: store.identity.timezone } },
      { idempotencyKey: `career-reminder-${record.id}` });
      return update(record, { reminder_task: { id: task.id, revision: task.revision } }, input.expected_revision);
    },
  };
}
