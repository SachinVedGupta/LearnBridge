import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { profileCandidate, profileView } from './profile.mjs';
import { createWritingService } from './writing-service.mjs';
import { createPublicJobService, PUBLIC_JOB_LIMITS } from './public-job-service.mjs';

export const CAREER_PACKET_VERSION = 'learnbridge_career_packet.v1';
export const CAREER_PACKET_LIMITS = Object.freeze({ payloadBytes: 100000, recordBytes: 120000, downloadBytes: 220000, packets: 100, selectedFacts: 20, questions: 20 });
const FACT_FIELDS = ['name', 'email', 'university', 'program', 'graduation', 'experience', 'goals'];
const UNSUPPORTED_FIELDS = ['gpa', 'work_authorization', 'sponsorship', 'demographics'];
const CHECKLIST_KEYS = ['full_name', 'email', 'education', 'experience', 'graduation', 'resume', 'cover_letter', 'gpa', 'work_authorization', 'sponsorship', 'demographics'];
const DEFAULT_REQUIREMENTS = Object.freeze([
  { key: 'full_name', required: true }, { key: 'email', required: true }, { key: 'education', required: true },
  { key: 'experience', required: true }, { key: 'resume', required: true }, { key: 'graduation', required: false }, { key: 'cover_letter', required: false },
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => sha(canonical(value));
const fail = code => { throw new LearnBridgeError(code); };
const clone = value => JSON.parse(JSON.stringify(value));
function object(raw, fields, required = fields) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('INVALID_INPUT');
  const props = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(props[key], 'value') || !props[key].enumerable) || required.some(key => !Object.hasOwn(props, key))) fail('INVALID_INPUT');
}
function array(raw, max) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max) fail('INVALID_INPUT');
  const props = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(props).length !== raw.length + 1) fail('INVALID_INPUT');
  for (let index = 0; index < raw.length; index++) if (!props[index] || !Object.hasOwn(props[index], 'value') || !props[index].enumerable) fail('INVALID_INPUT');
  return raw;
}
function text(raw, bytes, empty = false) { if (typeof raw !== 'string' || (!empty && !raw.trim()) || !raw.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw) || Buffer.byteLength(raw) > bytes) fail('INVALID_INPUT'); return raw; }
function id(raw) { if (typeof raw !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw)) fail('INVALID_INPUT'); return raw; }
function revision(raw) { if (!Number.isSafeInteger(raw) || raw < 1) fail('INVALID_INPUT'); return raw; }
function digest(raw) { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) fail('INVALID_INPUT'); return raw; }
function unique(raw, key) { if (new Set(raw.map(key)).size !== raw.length) fail('INVALID_INPUT'); return raw; }
function checkedReview(raw) { object(raw, ['expected_revision', 'payload_hash']); revision(raw.expected_revision); digest(raw.payload_hash); return raw; }
function requirements(raw) {
  if (raw === undefined) return { origin: 'practical_default_student_checklist_not_employer_form', items: clone(DEFAULT_REQUIREMENTS) };
  const items = unique(array(raw, CHECKLIST_KEYS.length).map(item => { object(item, ['key', 'required']); if (!CHECKLIST_KEYS.includes(item.key) || typeof item.required !== 'boolean') fail('INVALID_INPUT'); return { ...item }; }), item => item.key);
  return { origin: 'student_selected_checklist_not_employer_form', items };
}
function input(raw) {
  object(raw, ['role_ref', 'profile_refs', 'writing_refs', 'questions', 'requirements'], ['role_ref', 'profile_refs', 'writing_refs', 'questions']);
  object(raw.role_ref, ['id', 'revision', 'source_sha256']); id(raw.role_ref.id); revision(raw.role_ref.revision); digest(raw.role_ref.source_sha256);
  const profile_refs = unique(array(raw.profile_refs, CAREER_PACKET_LIMITS.selectedFacts).map(ref => { object(ref, ['id', 'revision', 'fingerprint']); id(ref.id); revision(ref.revision); digest(ref.fingerprint); return { ...ref }; }), ref => ref.id);
  const writing_refs = unique(array(raw.writing_refs, 2).map(ref => { object(ref, ['slot', 'id', 'revision', 'payload_hash']); if (!['resume', 'cover_letter'].includes(ref.slot)) fail('INVALID_INPUT'); id(ref.id); revision(ref.revision); digest(ref.payload_hash); return { ...ref }; }), ref => ref.slot);
  const questions = unique(array(raw.questions, CAREER_PACKET_LIMITS.questions).map(question => {
    object(question, ['id', 'prompt', 'required', 'fact_field', 'fact_ids', 'draft_answer']);
    if (typeof question.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(question.id) || typeof question.required !== 'boolean' || (question.fact_field !== null && ![...FACT_FIELDS, ...UNSUPPORTED_FIELDS].includes(question.fact_field))) fail('INVALID_INPUT');
    text(question.prompt, 2000); const fact_ids = unique(array(question.fact_ids, 5).map(id), value => value);
    if (question.draft_answer !== null) text(question.draft_answer, 6000, true);
    if (UNSUPPORTED_FIELDS.includes(question.fact_field) && (question.draft_answer?.trim() || fact_ids.length)) fail('SCOPE_DENIED');
    return { ...question, fact_ids };
  }), question => question.id);
  return { role_ref: { ...raw.role_ref }, profile_refs, writing_refs, questions, checklist: requirements(raw.requirements) };
}
const fileName = (value, format) => `LearnBridge-application-packet-${value.id.slice(0, 8)}.${format === 'markdown' ? 'md' : 'json'}`;

/** Private exact review packets. No provider reads, model calls, external forms or attachments are performed here. */
export function createCareerPacketService({ store, publicJobService = createPublicJobService({ store }), clock = () => Date.now() }) {
  const writing = createWritingService({ store });
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value)) fail('INVALID_INPUT'); return new Date(value).toISOString(); };
  const records = () => store.listWorkspaceRecords({ kind: 'career_item' }).filter(record => record.data.format === CAREER_PACKET_VERSION && record.data.category === 'application_packet');
  function facts() {
    return profileView(store.listWorkspaceRecords({ kind: 'profile_fact' }), { now: now(), resolveEvidence: ref => store.getDocument(ref) })
      .filter(record => record.data.state === 'confirmed' && record.data.review?.reviewer === store.identity.student_id && !record.stale && !record.conflict && record.data.purposes.includes('career') && FACT_FIELDS.includes(record.data.field))
      .filter(record => { if (record.data.field !== 'email') return true; try { return profileCandidate({ field: 'email', value: record.data.value, purposes: ['career'] }, { now: now() }).value === record.data.value; } catch (error) { if (!(error instanceof LearnBridgeError)) throw error; return false; } });
  }
  function selectedFacts(refs) {
    const bank = facts(); return refs.map(ref => {
      const found = bank.find(record => record.id === ref.id); if (!found) fail('CONSENT_REQUIRED');
      if (found.revision !== ref.revision || found.fingerprint !== ref.fingerprint) fail('REVISION_CONFLICT');
      return { id: found.id, revision: found.revision, fingerprint: found.fingerprint, field: found.data.field, value: found.data.value,
        evidence: clone(found.data.evidence), confirmed_review: clone(found.data.review), expires_at: found.data.expires_at };
    });
  }
  function selectedRole(ref) {
    const role = publicJobService.get(ref.id).role, source_request = observedReceipt(role);
    if (role.revision !== ref.revision || role.data.snapshot?.source_sha256 !== ref.source_sha256 || !role.verified_opening || role.availability !== 'open' || !source_request) fail('REVISION_CONFLICT');
    return { ...role, data: { ...role.data, source_request } };
  }
  function observedReceipt(role) {
    const receipt = role.data.source_request || (role.data.last_check.status === 'observed' ? role.data.request : null), selection = role.data.selection;
    const url = selection.provider === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${selection.board_slug}/jobs/${selection.job_id}` : selection.provider === 'lever' ? `https://api.lever.co/v0/postings/${selection.board_slug}/${selection.job_id}` : null;
    return receipt && receipt.status === 200 && receipt.source_api_url === url && /^[a-f0-9]{64}$/.test(receipt.response_sha256 || '') && Number.isSafeInteger(receipt.response_bytes) && receipt.response_bytes > 0 && receipt.response_bytes <= PUBLIC_JOB_LIMITS.responseBytes ? receipt : null;
  }
  function selectedWriting(refs) {
    return refs.map(ref => {
      const record = writing.get(ref.id);
      if (!['accepted', 'applied_revision'].includes(record.data.state) || record.data.academic_policy !== 'unrestricted') fail('CONSENT_REQUIRED');
      const artifact = writing.exportArtifact(ref.id, { expected_revision: ref.revision, payload_hash: ref.payload_hash });
      return { slot: ref.slot, writing_record: { id: record.id, revision: record.revision, payload_hash: record.data.payload_hash, state: record.data.state },
        document: { id: artifact.document.id, revision: artifact.document.revision, sha256: artifact.sha256 }, text: artifact.text,
        byte_length: artifact.byte_length, sha256: artifact.sha256, source_documents: clone(artifact.source_documents), content_status: artifact.content_status,
        status: 'reviewed_saved_markdown_draft_not_verified_attachment', factual_accuracy: 'student_review_required', render_verification: 'not_performed' };
    });
  }
  function getRecord(recordId) {
    id(recordId); const record = store.getWorkspaceRecord(recordId);
    if (!record || record.kind !== 'career_item' || record.data.format !== CAREER_PACKET_VERSION || record.data.category !== 'application_packet') fail('SCOPE_DENIED'); return record;
  }
  function revalidate(record) {
    const payload = record.data.payload; if (hash(payload) !== record.data.payload_hash) fail('VERSION_MISMATCH');
    selectedRole(payload.selection.role_ref); const currentFacts = selectedFacts(payload.selection.profile_refs), currentWriting = selectedWriting(payload.selection.writing_refs);
    if (hash(currentFacts) !== hash(payload.profile_facts) || hash(currentWriting) !== hash(payload.writing_drafts)) fail('REVISION_CONFLICT'); return true;
  }
  function view(record, full = true) {
    let stale = false, stale_code = null; try { revalidate(record); } catch (error) { if (!(error instanceof LearnBridgeError)) throw error; stale = true; stale_code = error.code; }
    const result = { ...record, stale, stale_code, exportable: !stale && record.data.state === 'reviewed' && record.data.review?.payload_hash === record.data.payload_hash,
      submission_supported: false, checklist_complete: record.data.payload.missing.required.length === 0 };
    return full ? result : { id: result.id, revision: result.revision, title: result.title, created_at: result.created_at, state: result.data.state,
      payload_hash: result.data.payload_hash, stale, stale_code, exportable: result.exportable, checklist_complete: result.checklist_complete,
      missing_required_count: result.data.payload.missing.required.length, source_fresh_until: result.data.payload.job.source_fresh_until };
  }
  function evaluatedQuestions(questions, bank) {
    return questions.map(question => {
      const selected = question.fact_ids.map(ref => { const fact = bank.find(item => item.id === ref); if (!fact) fail('CONSENT_REQUIRED'); return fact; });
      if (question.fact_field && selected.some(fact => fact.field !== question.fact_field)) fail('INVALID_INPUT');
      const answered = Boolean(question.draft_answer?.trim());
      if (selected.length && question.draft_answer !== selected.map(fact => fact.value).join('\n\n')) fail('SCOPE_DENIED');
      const status = UNSUPPORTED_FIELDS.includes(question.fact_field) ? 'unresolved_unsupported_profile_field' : !answered ? 'unresolved_no_draft_answer' : question.fact_field && !selected.length ? 'unresolved_missing_confirmed_fact' : selected.length ? 'literal_confirmed_fact_draft' : 'manual_draft_facts_unverified';
      return { ...question, status, answer: status.startsWith('unresolved') ? null : question.draft_answer,
        fact_refs: selected.map(fact => ({ id: fact.id, revision: fact.revision, fingerprint: fact.fingerprint })), origin: 'student_entered_manual_draft', submitted: false };
    });
  }
  function missing(checklist, bank, drafts, questions) {
    const matched = key => key === 'full_name' ? bank.some(fact => fact.field === 'name') : key === 'education' ? bank.some(fact => ['university', 'program'].includes(fact.field))
      : ['email', 'experience', 'graduation'].includes(key) ? bank.some(fact => fact.field === key) : ['resume', 'cover_letter'].includes(key) ? drafts.some(draft => draft.slot === key) : false;
    const unresolved = checklist.items.filter(item => !matched(item.key)).map(item => ({ ...item, reason: UNSUPPORTED_FIELDS.includes(item.key) ? 'No dedicated confirmed typed profile field is supported; not inferred from other facts.' : ['resume', 'cover_letter'].includes(item.key) ? 'No already reviewed unrestricted Writing draft was selected for this slot.' : 'No relevant selected current confirmed career fact.' }));
    const unanswered = questions.filter(question => question.status.startsWith('unresolved')).map(question => ({ key: `question:${question.id}`, required: question.required, reason: question.status }));
    return { required: [...unresolved, ...unanswered].filter(item => item.required), optional: [...unresolved, ...unanswered].filter(item => !item.required),
      employer_form_schema: 'not_read_or_verified', question_coverage: questions.length ? 'student_provided_questions_only' : 'no_questions_provided',
      typed_eligibility: 'not_evaluated', submission: 'unsupported', attachment_verification: 'not_performed' };
  }
  return {
    state() {
      const bank = facts(); return { packets: records().map(record => view(record, false)),
        roles: publicJobService.state().roles.filter(role => role.verified_opening && observedReceipt(role)).map(role => ({ id: role.id, revision: role.revision, title: role.title, selection: role.data.selection,
          source_sha256: role.data.snapshot.source_sha256, source_observed_at: role.data.source_observed_at, source_fresh_until: new Date(Date.parse(role.data.source_observed_at) + PUBLIC_JOB_LIMITS.freshnessMs).toISOString(), posting_url: role.data.snapshot.posting_url })),
        facts: bank.map(record => ({ id: record.id, revision: record.revision, fingerprint: record.fingerprint, field: record.data.field, value: record.data.value, evidence_kind: record.data.evidence.kind })),
        writing: writing.list().filter(record => ['accepted', 'applied_revision'].includes(record.state) && !record.stale && record.academic_policy === 'unrestricted'),
        defaults: clone(DEFAULT_REQUIREMENTS), capabilities: { submission: false, uploads: false, provider_reads: false, model_calls: false, formats: ['markdown', 'json'], unsupported_typed_fields: [...UNSUPPORTED_FIELDS] } };
    },
    get(recordId) { return { packet: view(getRecord(recordId)) }; },
    prepare(raw, { idempotencyKey } = {}) {
      const selected = input(raw); if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) fail('INVALID_INPUT');
      const request_hash = hash(selected), existing = records().find(record => record.data.creation_operation.key === idempotencyKey);
      if (existing) { if (existing.data.creation_operation.request_hash !== request_hash) fail('REVISION_CONFLICT'); revalidate(existing); return { packet: view(existing) }; }
      if (records().length >= CAREER_PACKET_LIMITS.packets) fail('BUDGET_EXCEEDED');
      const role = selectedRole(selected.role_ref), profile_facts = selectedFacts(selected.profile_refs), writing_drafts = selectedWriting(selected.writing_refs);
      const questions = evaluatedQuestions(selected.questions, profile_facts), prepared_at = now();
      const job = { record_id: role.id, record_revision: role.revision, source_identity: role.data.source_identity, provider: role.data.selection.provider, board_slug: role.data.selection.board_slug,
        job_id: role.data.selection.job_id, title: role.title, snapshot: clone(role.data.snapshot), availability: role.availability, verified_opening: role.verified_opening,
        verification_notice: role.verification_notice, source_request: clone(role.data.source_request), source_observed_at: role.data.source_observed_at, last_checked_at: role.data.last_check.checked_at,
        source_fresh_until: new Date(Date.parse(role.data.source_observed_at) + PUBLIC_JOB_LIMITS.freshnessMs).toISOString() };
      const payload = { format: CAREER_PACKET_VERSION, prepared_at, selection: { role_ref: selected.role_ref, profile_refs: selected.profile_refs, writing_refs: selected.writing_refs },
        job, profile_facts, writing_drafts, questions, checklist: selected.checklist, missing: missing(selected.checklist, profile_facts, writing_drafts, questions),
        disclosure: { purpose: 'private_student_application_review', question_source: 'student_entered_not_official_form_discovery', factual_quality: 'manual_quality_review_required', attachments: 'reviewed_markdown_drafts_not_uploaded_or_render_verified', provider_reads: false, model_processing: false, submission_supported: false } };
      if (Buffer.byteLength(JSON.stringify(payload)) > CAREER_PACKET_LIMITS.payloadBytes) fail('BUDGET_EXCEEDED');
      const data = { format: CAREER_PACKET_VERSION, category: 'application_packet', state: 'awaiting_review', payload, payload_hash: hash(payload), review: null,
        creation_operation: { key: idempotencyKey, request_hash } };
      if (Buffer.byteLength(JSON.stringify(data)) > CAREER_PACKET_LIMITS.recordBytes) fail('BUDGET_EXCEEDED');
      const record = store.createWorkspaceRecord({ kind: 'career_item', title: `Application review: ${role.title}`.slice(0, 480), data }, { idempotencyKey: `career-packet-${sha(idempotencyKey)}` });
      return { packet: view(record) };
    },
    review(recordId, raw) {
      const request = checkedReview(raw), record = getRecord(recordId); revalidate(record);
      if (record.data.payload_hash !== request.payload_hash) fail('REVISION_CONFLICT');
      if (record.data.state === 'reviewed' && record.data.review?.payload_hash === request.payload_hash && record.data.review.reviewer === store.identity.student_id && [record.revision, record.revision - 1].includes(request.expected_revision)) return { packet: view(record) };
      if (record.revision !== request.expected_revision || record.data.state !== 'awaiting_review') fail('REVISION_CONFLICT');
      const data = { ...record.data, state: 'reviewed', review: { reviewer: store.identity.student_id, source: 'paired_local_ui', payload_hash: request.payload_hash, reviewed_at: now(), acknowledgement: 'Exact private packet reviewed; missing facts and unverified drafts retained. No submission or upload authorized.' } };
      return { packet: view(store.updateWorkspaceRecord(record.id, { expected_revision: record.revision, data })) };
    },
    forget(recordId, raw) {
      const request = checkedReview(raw), record = getRecord(recordId);
      if (record.revision !== request.expected_revision || record.data.payload_hash !== request.payload_hash) fail('REVISION_CONFLICT');
      store.deleteWorkspaceRecord(record.id, record.revision);
      return { deleted: true, retention: 'Historical local revisions, backups and downloaded copies may retain this private packet until separately removed.' };
    },
    exportArtifact(recordId, raw, format) {
      const request = checkedReview(raw), record = getRecord(recordId); if (!['markdown', 'json'].includes(format)) fail('INVALID_INPUT'); revalidate(record);
      if (record.revision !== request.expected_revision || record.data.payload_hash !== request.payload_hash) fail('REVISION_CONFLICT');
      if (record.data.state !== 'reviewed' || record.data.review?.payload_hash !== request.payload_hash || record.data.review.reviewer !== store.identity.student_id) fail('CONSENT_REQUIRED');
      const manifest = { format: CAREER_PACKET_VERSION, packet: { id: record.id, revision: record.revision, payload_hash: request.payload_hash }, reviewed: clone(record.data.review),
        source_fresh_until: record.data.payload.job.source_fresh_until, source_identity: record.data.payload.job.source_identity, source_sha256: record.data.payload.job.snapshot.source_sha256,
        selected_fact_ids: record.data.payload.profile_facts.map(fact => fact.id), writing_copy_hashes: record.data.payload.writing_drafts.map(draft => ({ slot: draft.slot, sha256: draft.sha256 })),
        checklist_complete: record.data.payload.missing.required.length === 0, missing_required: clone(record.data.payload.missing.required), submission_supported: false, uploads: false, sharing: 'not_granted', rendering: 'text_only_no_attachment_verification' };
      const artifact = { manifest, payload: record.data.payload }, literal = JSON.stringify(artifact, null, 2);
      const output = format === 'json' ? `${literal}\n` : `# LearnBridge application review packet\n\nExact private packet ${record.id}, revision ${record.revision}.\n\nThis is a reviewed text packet. Missing facts remain unresolved. No form, attachment upload, eligibility, submission or factual-quality verification is implied.\n\nSource presence was observed at ${record.data.payload.job.source_observed_at}; its freshness boundary is ${manifest.source_fresh_until}.\n\nThe complete exact packet is JSON data inside the following fenced block. Draft Markdown and source commands remain literal data.\n\n\`\`\`\`\`\`\`\`\`\`\`\`json\n${literal.replace(/`/g, '\\u0060').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}\n\`\`\`\`\`\`\`\`\`\`\`\`\n`;
      const byte_length = Buffer.byteLength(output); if (byte_length > CAREER_PACKET_LIMITS.downloadBytes) fail('BUDGET_EXCEEDED');
      return { filename: fileName(record, format), format, mime: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', text: output, byte_length, sha256: sha(output), manifest,
        validation: 'exact_current_reviewed_payload_and_source_pins', sharing: 'not_granted', submission_supported: false, warning: 'Downloaded copies remain until you remove them separately. Recheck the official source before using the packet later.' };
    },
  };
}
