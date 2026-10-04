import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { AcademicError } from '../../../packages/local-academic/src/index.mjs';
import { createD2lBrowser, cloneD2lData, D2L_INSTITUTION } from './d2l-browser.mjs';

export const D2L_CATEGORIES = Object.freeze(['assignments', 'announcements', 'materials']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
function object(value, keys) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(); }
function sourceId(value) { if (Number.isSafeInteger(value) && value > 0) return String(value); if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) fail(); return value; }
function text(value, max = 300, empty = false) { if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) fail(); return value; }
function rows(value, max = 2000) { if (!Array.isArray(value) || value.length > max) fail('BUDGET_EXCEEDED'); return value; }
function rich(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || Array.isArray(value)) fail();
  if (typeof value.Text === 'string' && value.Text.length) return text(value.Text, 50000, true);
  if (typeof value.Html === 'string') return text(value.Html, 50000, true);
  if (typeof value.Text === 'string') return '';
  fail('UNSUPPORTED');
}
function date(value) { return value === undefined || value === null || value === '' ? null : text(value, 300); }
function link(value) {
  if (value === undefined || value === null) return null;
  const candidate = text(value, 2048);
  // Brightspace TOC URLs can be root-relative. Preserve a canonical reference;
  // this does not open the file or authorize an external read.
  return candidate.startsWith('/') && !candidate.startsWith('//') ? new URL(candidate, D2L_INSTITUTION.origin).href : candidate;
}
function apiVersions(value) {
  const result = {};
  for (const product of ['lp', 'le']) {
    const matches = rows(value, 30).filter(row => row?.ProductCode === product);
    if (matches.length !== 1 || !Array.isArray(matches[0].SupportedVersions)) fail('UNSUPPORTED');
    const supported = rows(matches[0].SupportedVersions, 200).filter(value => typeof value === 'string' && /^1\.(0|[1-9]\d{0,2})$/.test(value));
    supported.sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)));
    if (!supported.length || !supported.includes(matches[0].LatestVersion) || (product === 'lp' && +supported[0].slice(2) < 49)) fail('UNSUPPORTED');
    result[product] = supported[0];
  }
  return result;
}
function identity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('AUTH_REQUIRED');
  const identifier = sourceId(value.Identifier);
  const name = typeof value.DisplayName === 'string' && value.DisplayName.trim() ? text(value.DisplayName)
    : [text(value.FirstName, 150), text(value.LastName, 150)].join(' ');
  return { account_ref: `${D2L_INSTITUTION.id}:${hash(D2L_INSTITUTION.origin + '\0' + identifier).slice(0, 40)}`, display_name: name };
}
function course(value, selected) {
  if (!value || typeof value !== 'object' || sourceId(value.Identifier) !== selected) fail('SCOPE_DENIED');
  return { source_id: selected, title: text(value.Name), code: text(value.Code, 120), url: `${D2L_INSTITUTION.origin}/d2l/home/${selected}` };
}
function categoryRows(category, value, courseId) {
  if (category === 'assignments') return rows(value).map(row => ({ source_id: sourceId(row.Id), course_id: courseId, title: text(row.Name),
    description: rich(row.CustomInstructions), due: date(row.DueDate) }));
  if (category === 'announcements') return rows(value).map(row => ({ source_id: sourceId(row.Id), course_id: courseId, title: text(row.Title),
    body: rich(row.Body), published_at: date(row.CreatedDate) }));
  const output = []; let count = 0;
  function modules(items, depth) {
    if (depth > 12) fail('BUDGET_EXCEEDED');
    for (const module of rows(items)) {
      if (++count > 2000) fail('BUDGET_EXCEEDED');
      output.push({ source_id: `module:${sourceId(module.ModuleId)}`, course_id: courseId, title: text(module.Title), body: rich(module.Description), type: 'module' });
      for (const topic of rows(module.Topics || [])) {
        if (++count > 2000) fail('BUDGET_EXCEEDED');
        output.push({ source_id: `topic:${sourceId(topic.TopicId)}`, course_id: courseId, title: text(topic.Title),
          body: '', url: link(topic.Url), type: topic.TypeIdentifier === undefined ? 'topic' : text(topic.TypeIdentifier, 100) });
      }
      modules(module.Modules || [], depth + 1);
    }
  }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'Modules')) fail('UNSUPPORTED'); modules(value.Modules, 0); return output;
}

/** Explicit foreground reads into the existing review/refresh contract. No
 * cloud transport, credentials, model, enrollment scan or automatic persistence.
 */
export function createD2lService({ studentWorkspace, browserFactory = createD2lBrowser, clock = Date.now }) {
  if (!studentWorkspace?.previewAcademicExport || !studentWorkspace?.commitAcademicRefresh || typeof browserFactory !== 'function' || typeof clock !== 'function') fail();
  let current = null, generation = 0, active = false;
  const instant = () => new Date(clock()).toISOString();
  function status() {
    const capability = current?.browser.capability() || browserFactory().capability();
    return { institution: D2L_INSTITUTION, capability, connection: current ? {
      id: current.id, state: current.state, account: current.account ? { ...current.account } : null,
      verified_at: current.verified_at, last_read_at: current.last_read_at, proof: current.last_read_at ? current.browser.proof : 'none',
    } : null, limits: { courses: 5, categories: [...D2L_CATEGORIES], preview_lifetime_seconds: 300 },
    notice: 'Complete official school sign-in yourself. Only selected course reads are available; passwords, tokens, enrollment scans, submissions and model sharing are absent.' };
  }
  function connection(input) {
    const body = cloneD2lData(input, 4096); object(body, ['connection_id']);
    if (typeof body.connection_id !== 'string' || !UUID.test(body.connection_id)) fail();
    if (!current || current.id !== body.connection_id) fail('AUTH_REQUIRED'); return current;
  }
  function same(record, version) { if (current !== record || generation !== version) fail('CANCELLED'); }
  async function observed(record, version) {
    const value = identity(cloneD2lData(await record.browser.readJson(`/d2l/api/lp/${record.versions.lp}/users/whoami`))); same(record, version);
    if (record.account && value.account_ref !== record.account.account_ref) { record.state = 'account_changed'; record.account = null; fail('SCOPE_DENIED'); }
    return value;
  }
  async function exclusive(action) {
    if (active) fail('RATE_LIMITED'); active = true; try { return await action(); } finally { active = false; }
  }
  async function start(input) {
    const body = cloneD2lData(input, 4096); object(body, ['institution_id']); if (body.institution_id !== D2L_INSTITUTION.id) fail('UNSUPPORTED');
    return exclusive(async () => {
      if (current) fail('CONSENT_REQUIRED');
      const record = { id: randomUUID(), browser: browserFactory(), state: 'awaiting_sign_in', account: null, versions: null, verified_at: null, last_read_at: null };
      current = record; const version = ++generation;
      try { await record.browser.start(); same(record, version); return status(); }
      catch (error) { if (current === record) { current = null; generation++; } await record.browser.close(); throw error; }
    });
  }
  async function verify(input) {
    const record = connection(input); return exclusive(async () => {
      const version = generation;
      try {
        if (record.state === 'account_changed') fail('SCOPE_DENIED');
        if (!record.versions) { record.versions = apiVersions(cloneD2lData(await record.browser.readJson('/d2l/api/versions/'))); same(record, version); }
        record.account = await observed(record, version); same(record, version); record.verified_at = instant(); record.state = 'ready'; return status();
      } catch (error) { if (current === record && error.code !== 'CANCELLED' && record.state !== 'account_changed') record.state = error.code === 'SCOPE_DENIED' ? 'permission_denied' : 'awaiting_sign_in'; throw error; }
    });
  }
  async function preview(input) {
    const body = cloneD2lData(input, 4096); object(body, ['connection_id', 'selected_course_ids', 'categories']);
    const record = connection({ connection_id: body.connection_id });
    const selected = rows(body.selected_course_ids, 5).map(value => { if (typeof value !== 'string') fail(); return sourceId(value); }).sort(); if (!selected.length || new Set(selected).size !== selected.length) fail();
    const categories = rows(body.categories, 3); if (!categories.length || new Set(categories).size !== categories.length || categories.some(item => !D2L_CATEGORIES.includes(item))) fail();
    if (record.state !== 'ready' || !record.account) fail('AUTH_REQUIRED');
    return exclusive(async () => {
      try {
      const version = generation; await observed(record, version);
      const raw = { schema_version: 1, institution: { name: D2L_INSTITUTION.name, origin: D2L_INSTITUTION.origin, timezone: D2L_INSTITUTION.timezone },
        account_ref: record.account.account_ref, retrieved_at: instant(), courses: [], assignments: [], announcements: [], materials: [],
        coverage: { courses: { state: 'complete' }, ...Object.fromEntries(D2L_CATEGORIES.map(name => [name, { state: 'unknown' }])) }, errors: [] };
      let totalBytes = 0;
      const read = async path => {
        same(record, version); const value = cloneD2lData(await record.browser.readJson(path)); same(record, version);
        totalBytes += Buffer.byteLength(JSON.stringify(value)); if (totalBytes > 256000) fail('BUDGET_EXCEEDED'); return value;
      };
      for (const id of selected) {
        raw.courses.push(course(await read(`/d2l/api/lp/${record.versions.lp}/courses/${id}`), id));
        for (const category of D2L_CATEGORIES.filter(name => categories.includes(name))) {
          const suffix = { assignments: 'dropbox/folders/', announcements: 'news/', materials: 'content/toc' }[category];
          try { raw[category].push(...categoryRows(category, await read(`/d2l/api/le/${record.versions.le}/${id}/${suffix}`), id)); }
          catch (error) {
            if (!['UNSUPPORTED', 'SCOPE_DENIED', 'PROVIDER_FAILURE'].includes(error.code)) throw error;
            raw.errors.push({ category, course_id: id, code: error.code });
          }
          raw.coverage[category].state = category === 'announcements' && !raw.errors.some(error => error.category === category) ? 'complete' : 'partial';
        }
      }
      await observed(record, version); same(record, version);
      const refresh = studentWorkspace.previewAcademicExport({ export: cloneD2lData(raw), selected_course_ids: selected }); same(record, version);
      record.last_read_at = instant();
      return { connection_id: record.id, account_ref: record.account.account_ref, proof: record.browser.proof,
        selection: { selected_course_ids: selected, categories: D2L_CATEGORIES.filter(name => categories.includes(name)) }, snapshot: refresh.snapshot, refresh,
        limitations: ['Assignments cover Dropbox folders only; quizzes, discussions and calendar events are not included.',
          'Materials include the returned table of contents and descriptions; linked files, external sites and attachments are not opened.',
          'HTML, where returned instead of plain text, remains literal source text. Review dates, coverage and policy before saving.',
          'No tasks, profile facts, model sharing or school changes are created by this read.'],
        notice: 'These facts came from the selected school browser session. Review the exact preview before saving changes to your local course library.' };
      } catch (error) {
        if (current === record && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'TIMEOUT'].includes(error.code)) record.state = 'awaiting_sign_in';
        if (current === record && error.code === 'SCOPE_DENIED' && record.state !== 'account_changed') record.state = 'permission_denied';
        throw error;
      }
    });
  }
  function save(value, { review_hash, idempotency_key }) {
    const record = connection({ connection_id: value.connection_id });
    if (!record.account || record.account.account_ref !== value.account_ref || record.state !== 'ready') fail('CONSENT_REQUIRED');
    return studentWorkspace.commitAcademicRefresh(value.refresh, { review_hash, expected_head_revision: value.refresh.base.revision, idempotency_key });
  }
  async function disconnect(input) { const record = connection(input); current = null; generation++; await record.browser.close(); return { disconnected: true, retention: 'The temporary school browser profile was removed. Reviewed local snapshots, notes, history and backups retain their own records.' }; }
  async function close() { const record = current; current = null; generation++; if (record) await record.browser.close(); }
  return Object.freeze({ status, start, verify, preview, save, disconnect, close });
}
