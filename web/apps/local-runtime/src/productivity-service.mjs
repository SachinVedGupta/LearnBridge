import { LearnBridgeError } from '@learnbridge/core';
import { lifeObject, lifeHash, lifeText, lifeStamp, lifeDate, lifeTimezone } from './life.mjs';
import { canonicalCareerURL } from './career.mjs';

const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const productivitySections = ['academic', 'communications', 'projects', 'career', 'life', 'news'];
const providers = ['manual', 'gmail', 'outlook', 'teams', 'discord', 'slack', 'github', 'linear', 'notion', 'other'];
const kinds = ['inbox_item', 'project', 'schedule'];
const checkedId = value => { if (typeof value !== 'string' || !uuid.test(value)) fail(); return value.toLowerCase(); };
const listBound = (value, max, min = 0) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; };
const rawText = (value, max = 20000) => { lifeText(value, max); return value; };
const rev = value => { if (!Number.isSafeInteger(value) || value < 1) fail(); return value; };
const section = value => { if (!productivitySections.includes(value)) fail(); return value; };

/** Deterministic local recipes. No network, account discovery, model calls, sends or background worker. */
export function createProductivityWorkspace(store, { clock = () => new Date().toISOString() } = {}) {
  const list = (kind, category) => store.listWorkspaceRecords({ kind }).filter(record => record.data.category === category);
  function get(id, kind, category) {
    const record = store.getWorkspaceRecord(checkedId(id)); if (!record || record.kind !== kind || record.data.category !== category) fail('SCOPE_DENIED'); return record;
  }
  const update = (record, expected_revision, data) => store.updateWorkspaceRecord(record.id, { expected_revision, data: { ...record.data, ...data } });
  function create(kind, category, input, key, build) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail();
    const request_hash = lifeHash({ category, input });
    const existing = kinds.flatMap(kind => store.listWorkspaceRecords({ kind })).find(record => record.data.creation_operation?.key === key);
    if (existing) { if (existing.data.creation_operation.request_hash !== request_hash || existing.data.category !== category) fail('REVISION_CONFLICT'); return existing; }
    const value = build(); return store.createWorkspaceRecord({ kind, title: value.title.slice(0, 480), data: { category, ...value.data,
      creation_operation: { key, request_hash } } }, { idempotencyKey: `productivity-${key}` });
  }
  function sources(input) {
    const seen = new Set(); let bytes = 0;
    return listBound(input, 20).map(reference => {
      lifeObject(reference, ['kind', 'id', 'expected_revision', 'section'], ['kind', 'id', 'expected_revision', 'section']);
      checkedId(reference.id); rev(reference.expected_revision); section(reference.section);
      const key = `${reference.kind}:${reference.id.toLowerCase()}`; if (seen.has(key)) fail(); seen.add(key);
      let source;
      if (reference.kind === 'document') {
        const saved = store.getDocument(reference.id); if (!saved) fail('SCOPE_DENIED');
        if (saved.document.revision !== reference.expected_revision) fail('REVISION_CONFLICT');
        source = { kind: 'document', id: saved.document.id, revision: saved.document.revision, hash: saved.sha256, title: saved.document.title,
          section: reference.section, text: rawText(saved.text, 40000), source_url: null, provider: 'local_note', account: 'this_workspace', observed_at: null };
      } else if (reference.kind === 'inbox') {
        const saved = get(reference.id, 'inbox_item', 'update'); if (saved.revision !== reference.expected_revision) fail('REVISION_CONFLICT');
        if (saved.data.update.section !== reference.section) fail();
        source = { kind: 'inbox', id: saved.id, revision: saved.revision, hash: lifeHash(saved.data.update), title: saved.data.update.subject,
          ...saved.data.update, text: saved.data.update.body }; delete source.body;
      } else fail();
      bytes += Buffer.byteLength(source.text, 'utf8'); if (bytes > 40000) fail();
      return source;
    });
  }
  function currentSources(pins) {
    return pins.every(pin => {
      if (pin.kind === 'document') { const saved = store.getDocument(pin.id); return saved && saved.document.revision === pin.revision && saved.sha256 === pin.hash; }
      const saved = store.getWorkspaceRecord(pin.id); return saved && saved.kind === 'inbox_item' && saved.data.category === 'update'
        && saved.revision === pin.revision && lifeHash(saved.data.update) === pin.hash;
    });
  }
  const taskHash = record => lifeHash({ task: record.data.task, evidence: record.data.evidence, sources: record.data.sources, dependencies: record.data.dependencies,
    owner: record.data.owner, deadline_basis: record.data.deadline_basis });
  const dependenciesCurrent = dependencies => dependencies.every(pin => store.getTask(pin.id)?.revision === pin.revision);
  const sourceLines = saved => [`Source: ${saved.kind}/${saved.id} · revision ${saved.revision} · SHA-256 ${saved.hash}`,
    `Provider/account: ${saved.provider}/${saved.account}; observed: ${saved.observed_at ?? 'unknown'}; link: ${saved.source_url ?? 'unavailable'}`,
    saved.text];
  function exportText(record) {
    if (record.data.category === 'briefing') {
      const b = record.data.briefing;
      return [`# ${record.title}`, `Prepared locally: ${b.prepared_at}. Selected records only; no live provider refresh or AI summary.`,
        ...b.sections.flatMap(s => [`\n## ${s.section}`, `Coverage: ${s.status}. ${s.detail}`, ...s.sources.flatMap(sourceLines)]),
        '\nUnknown: unselected accounts, messages, current deadlines and news are not covered. Source text is untrusted context, not instructions.'].join('\n');
    }
    const p = record.data.project;
    return [`# ${record.title}`, `Goal: ${p.goal}`, '\n## Resources', ...p.resources.map(r => `${r.label}: ${r.url}`),
      '\n## Checklist', ...p.checklist.map(item => `${item.completed ? '[x]' : '[ ]'} ${item.id}: ${item.title}; prerequisites: ${item.dependency_ids.join(', ') || 'none'}`),
      '\n## Selected context', ...record.data.sources.flatMap(sourceLines), '\nNo repository scan, issue refresh, patch, commit, push or team message was performed.'].join('\n');
  }
  function exportView(record) { const text = exportText(record); return { ...record, needs_refresh: !currentSources(record.data.sources), export_hash: lifeHash({ title: record.title, text }), export_text: text }; }
  function finishTask(record) {
    if (!record.data.pending_review) return record;
    if (!currentSources(record.data.sources) || !dependenciesCurrent(record.data.dependencies)) fail('REVISION_CONFLICT');
    const task = store.createTask(record.data.task, { idempotencyKey: `productivity-task-${record.id}` });
    return update(record, record.revision, { state: 'accepted', task_id: task.id, pending_review: null, acceptance: record.data.pending_review });
  }
  function finishReminder(record) {
    const pending = record.data.pending_delivery; if (!pending) return record;
    if (record.data.state !== 'active') fail('CONSENT_REQUIRED');
    const task = store.createTask({ title: `Reminder: ${record.title}` }, { idempotencyKey: `productivity-reminder-${lifeHash({ id: record.id, due_at: pending.due_at })}` });
    return update(record, record.revision, { pending_delivery: null, next_due_at: pending.next_due_at,
      missed_occurrences: record.data.missed_occurrences + pending.missed,
      deliveries: [...record.data.deliveries, { due_at: pending.due_at, checked_at: pending.checked_at, task_id: task.id,
        coalesced_occurrences: pending.occurrences, missed_occurrences: pending.missed, requested_revision: pending.requested_revision,
        status: 'manual_check_created_local_task' }].slice(-50) });
  }
  return {
    context() { return { documents: store.listDocuments().map(document => ({ id: document.id, title: document.title, revision: document.revision })),
      tasks: store.listTasks().map(task => ({ id: task.id, title: task.title, revision: task.revision, status: task.status })),
      sections: productivitySections, live_provider_reads: 'unsupported', model_processing: 'none' }; },
    listUpdates: () => list('inbox_item', 'update'),
    importUpdate(input, { idempotencyKey } = {}) {
      lifeObject(input, ['provider', 'account', 'source_id', 'subject', 'observed_at', 'body', 'source_url', 'section', 'expected_revision'],
        ['provider', 'account', 'source_id', 'subject', 'observed_at', 'body', 'section']);
      if (!providers.includes(input.provider) || lifeStamp(input.observed_at) > clock()) fail();
      const value = { provider: input.provider, account: lifeText(input.account, 200), source_id: lifeText(input.source_id, 200), subject: lifeText(input.subject, 300),
        observed_at: input.observed_at, body: rawText(input.body), source_url: input.source_url == null ? null : canonicalCareerURL(input.source_url),
        section: section(input.section), acquisition: 'student_pasted_not_live_synced' };
      const identity = lifeHash({ provider: value.provider, account: value.account, source_id: value.source_id });
      const existing = list('inbox_item', 'update').find(record => record.data.source_identity === identity);
      if (existing) {
        if (lifeHash(existing.data.update) === lifeHash(value)) return existing;
        if (input.expected_revision !== existing.revision) fail('REVISION_CONFLICT');
        return store.updateWorkspaceRecord(existing.id, { expected_revision: input.expected_revision, title: value.subject, data: { ...existing.data, update: value } });
      }
      if (input.expected_revision != null) fail('REVISION_CONFLICT');
      return create('inbox_item', 'update', input, idempotencyKey, () => ({ title: value.subject, data: { source_identity: identity, update: value } }));
    },
    listBriefings: () => list('inbox_item', 'briefing').map(exportView),
    prepareBriefing(input, { idempotencyKey } = {}) {
      lifeObject(input, ['title', 'sources', 'coverage'], ['title', 'sources', 'coverage']);
      return create('inbox_item', 'briefing', input, idempotencyKey, () => {
        const selected = sources(input.sources), claims = new Map();
        for (const claim of listBound(input.coverage, 6)) {
          lifeObject(claim, ['section', 'status', 'detail'], ['section', 'status', 'detail']); section(claim.section);
          if (claims.has(claim.section) || !['unknown', 'unavailable', 'failed'].includes(claim.status)) fail();
          claims.set(claim.section, { status: claim.status, detail: lifeText(claim.detail, 1000) });
        }
        const sections = productivitySections.map(name => {
          const items = selected.filter(source => source.section === name), claim = claims.get(name);
          return { section: name, status: claim ? `${items.length ? 'partial_' : ''}${claim.status}` : items.length ? 'selected_records_only' : 'unknown',
            detail: claim?.detail ?? (items.length ? 'Only these selected local records are covered; freshness and other accounts remain unknown.' : 'No source selected. Nothing was refreshed.'), sources: items };
        });
        return { title: lifeText(input.title, 300), data: { sources: selected, briefing: { schema_version: 1, prepared_at: clock(), sections }, exports: [] } };
      });
    },
    listProposals: () => list('inbox_item', 'task_proposal').map(record => ({ ...record, review_hash: taskHash(record),
      needs_refresh: !currentSources(record.data.sources) || !dependenciesCurrent(record.data.dependencies) })),
    prepareTask(input, { idempotencyKey } = {}) {
      lifeObject(input, ['title', 'sources', 'evidence', 'deadline', 'deadline_basis', 'owner', 'dependencies'], ['title', 'sources', 'evidence', 'deadline', 'deadline_basis', 'owner', 'dependencies']);
      return create('inbox_item', 'task_proposal', input, idempotencyKey, () => {
        const selected = sources(input.sources); if (!selected.length) fail();
        const evidence = listBound(input.evidence, 20, 1).map(item => {
          lifeObject(item, ['source_index', 'quote'], ['source_index', 'quote']); const quote = rawText(item.quote, 4000);
          if (!Number.isSafeInteger(item.source_index) || !selected[item.source_index]?.text.includes(quote)) fail('SCOPE_DENIED');
          return { source_index: item.source_index, quote };
        });
        let deadline = { precision: 'unknown' };
        if (input.deadline === null) { if (input.deadline_basis !== 'unresolved') fail(); }
        else {
          lifeObject(input.deadline, ['date', 'timezone'], ['date', 'timezone']); lifeDate(input.deadline.date); lifeTimezone(input.deadline.timezone);
          if (!['student_supplied', 'source_literal'].includes(input.deadline_basis)) fail();
          if (input.deadline_basis === 'source_literal' && !evidence.some(item => item.quote.includes(input.deadline.date))) fail('SCOPE_DENIED');
          deadline = { precision: 'date', ...input.deadline };
        }
        const seen = new Set(), dependencies = listBound(input.dependencies, 50).map(pin => {
          lifeObject(pin, ['id', 'expected_revision'], ['id', 'expected_revision']); checkedId(pin.id); rev(pin.expected_revision);
          if (seen.has(pin.id.toLowerCase())) fail(); seen.add(pin.id.toLowerCase()); const task = store.getTask(pin.id);
          if (!task || task.revision !== pin.expected_revision) fail('REVISION_CONFLICT'); return { id: task.id, revision: task.revision };
        });
        const title = lifeText(input.title, 300), owner = input.owner === null ? null : lifeText(input.owner, 200);
        return { title, data: { task: { title, deadline, dependency_ids: dependencies.map(pin => pin.id) }, sources: selected, evidence, dependencies,
          owner: { value: owner, basis: owner ? 'student_supplied_not_assigned_externally' : 'unresolved' }, deadline_basis: input.deadline_basis,
          state: 'proposal', pending_review: null, acceptance: null, task_id: null } };
      });
    },
    acceptTask(id, input) {
      lifeObject(input, ['expected_revision', 'review_hash'], ['expected_revision', 'review_hash']); rev(input.expected_revision);
      let record = get(id, 'inbox_item', 'task_proposal'); if (input.review_hash !== taskHash(record)) fail('REVISION_CONFLICT');
      if (record.data.acceptance && [record.revision, record.data.acceptance.reviewed_revision].includes(input.expected_revision)) return record;
      if (record.data.pending_review) { if (record.data.pending_review.reviewed_revision !== input.expected_revision) fail('REVISION_CONFLICT'); return finishTask(record); }
      if (!currentSources(record.data.sources) || !dependenciesCurrent(record.data.dependencies)) fail('REVISION_CONFLICT');
      record = update(record, input.expected_revision, { state: 'accepting', pending_review: { reviewer: store.identity.student_id, reviewed_at: clock(), reviewed_revision: input.expected_revision, review_hash: input.review_hash } });
      return finishTask(record);
    },
    listProjects: () => list('project', 'project').map(exportView),
    createProject(input, { idempotencyKey } = {}) {
      lifeObject(input, ['title', 'goal', 'resources', 'sources', 'checklist'], ['title', 'goal', 'resources', 'sources', 'checklist']);
      return create('project', 'project', input, idempotencyKey, () => {
        const resources = listBound(input.resources, 30).map(item => { lifeObject(item, ['label', 'url'], ['label', 'url']); return { label: lifeText(item.label, 200), url: canonicalCareerURL(item.url) }; });
        const checklist = listBound(input.checklist, 100).map(item => {
          lifeObject(item, ['id', 'title', 'dependency_ids'], ['id', 'title', 'dependency_ids']);
          if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(item.id)) fail();
          return { id: item.id, title: lifeText(item.title, 300), dependency_ids: listBound(item.dependency_ids, 100).map(value => lifeText(value, 40)), completed: false, completed_at: null };
        });
        if (new Set(checklist.map(item => item.id)).size !== checklist.length) fail();
        const visiting = new Set(), seen = new Set(), walk = item => {
          if (visiting.has(item.id)) fail('REVISION_CONFLICT'); if (seen.has(item.id)) return; visiting.add(item.id);
          for (const dependency of item.dependency_ids) { const prior = checklist.find(entry => entry.id === dependency); if (!prior || dependency === item.id) fail(); walk(prior); }
          visiting.delete(item.id); seen.add(item.id);
        }; checklist.forEach(walk);
        return { title: lifeText(input.title, 300), data: { project: { goal: lifeText(input.goal, 3000), resources, checklist }, sources: sources(input.sources), exports: [] } };
      });
    },
    completeChecklist(id, input) {
      lifeObject(input, ['expected_revision', 'item_id', 'completed'], ['expected_revision', 'item_id', 'completed']);
      if (typeof input.completed !== 'boolean') fail(); const record = get(id, 'project', 'project'), item = record.data.project.checklist.find(entry => entry.id === input.item_id);
      if (!item) fail('SCOPE_DENIED');
      if (item.completed === input.completed && record.revision === input.expected_revision + 1) return record;
      if (input.completed && item.dependency_ids.some(id => !record.data.project.checklist.find(entry => entry.id === id)?.completed)) fail('REVISION_CONFLICT');
      if (!input.completed && record.data.project.checklist.some(entry => entry.completed && entry.dependency_ids.includes(item.id))) fail('REVISION_CONFLICT');
      return update(record, input.expected_revision, { project: { ...record.data.project, checklist: record.data.project.checklist.map(entry => entry.id === input.item_id
        ? { ...entry, completed: input.completed, completed_at: input.completed ? clock() : null, observation: 'student_reported' } : entry) } });
    },
    exportNote(id, input) {
      lifeObject(input, ['expected_revision', 'export_hash'], ['expected_revision', 'export_hash']);
      const record = store.getWorkspaceRecord(checkedId(id)); if (!record || !['briefing', 'project'].includes(record.data.category)
        || !['inbox_item', 'project'].includes(record.kind)) fail('SCOPE_DENIED');
      const view = exportView(record); if (view.export_hash !== input.export_hash) fail('REVISION_CONFLICT');
      const prior = record.data.exports.find(entry => entry.export_hash === input.export_hash); if (prior) return { record, document_id: prior.document_id };
      if (view.needs_refresh || record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const saved = store.createDocument({ title: record.title, text: view.export_text }, { idempotencyKey: `productivity-export-${lifeHash({ id: record.id, hash: view.export_hash })}` });
      return { record: update(record, input.expected_revision, { exports: [...record.data.exports, { export_hash: view.export_hash, document_id: saved.document.id, exported_at: clock() }].slice(-32) }), document_id: saved.document.id };
    },
    listSchedules: () => list('schedule', 'manual_reminder').map(record => ({ ...record, due: record.data.state === 'active' && record.data.next_due_at <= clock(),
      execution: 'manual_paired_check_only_no_background_worker', notification_transport: 'none' })),
    createSchedule(input, { idempotencyKey } = {}) {
      lifeObject(input, ['title', 'first_due_at', 'every_minutes', 'timezone'], ['title', 'first_due_at', 'every_minutes', 'timezone']);
      return create('schedule', 'manual_reminder', input, idempotencyKey, () => {
        lifeStamp(input.first_due_at); lifeTimezone(input.timezone);
        if (!Number.isSafeInteger(input.every_minutes) || input.every_minutes < 15 || input.every_minutes > 10080
          || Math.abs(Date.parse(input.first_due_at) - Date.parse(clock())) > 366 * 86400000) fail();
        return { title: lifeText(input.title, 300), data: { state: 'paused', next_due_at: input.first_due_at, every_minutes: input.every_minutes,
          timezone: input.timezone, deliveries: [], missed_occurrences: 0, pending_delivery: null, capabilities: ['local_reminder_on_manual_check'] } };
      });
    },
    setSchedule(id, input) {
      lifeObject(input, ['expected_revision', 'state'], ['expected_revision', 'state']); if (!['paused', 'active'].includes(input.state)) fail();
      const record = get(id, 'schedule', 'manual_reminder'); return update(record, input.expected_revision, { state: input.state });
    },
    checkSchedule(id, input) {
      lifeObject(input, ['expected_revision'], ['expected_revision']); let record = get(id, 'schedule', 'manual_reminder');
      if (record.data.state !== 'active') fail('CONSENT_REQUIRED');
      if (record.data.pending_delivery) {
        if (![record.revision, record.data.pending_delivery.requested_revision].includes(input.expected_revision)) fail('REVISION_CONFLICT'); return finishReminder(record);
      }
      if (record.data.deliveries.at(-1)?.requested_revision === input.expected_revision) return record;
      if (record.revision !== input.expected_revision) fail('REVISION_CONFLICT');
      const now = lifeStamp(clock()), due = record.data.next_due_at; if (now < due) return record;
      const interval = record.data.every_minutes * 60000, occurrences = Math.floor((Date.parse(now) - Date.parse(due)) / interval) + 1;
      const next_due_at = new Date(Date.parse(due) + occurrences * interval).toISOString();
      record = update(record, record.revision, { pending_delivery: { due_at: due, checked_at: now, occurrences, missed: occurrences - 1,
        next_due_at, requested_revision: input.expected_revision } }); return finishReminder(record);
    },
  };
}
