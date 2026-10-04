import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { verifyWordDownload } from '../apps/local/public/writing.js';

const API = '/api/local/v1';
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha = text => createHash('sha256').update(text).digest('hex');
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });
const route = record => `/writing/items/${record.id}/export-docx`;
const bodyCanary = 'SYNTHETIC_WORD_SOURCE_BODY_CANARY';
const unrelatedCanary = 'SYNTHETIC_WORD_UNSELECTED_BODY_CANARY';
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-word-http-')), root = join(parent, 'workspace'); let runtime;
  const sessions = [], calls = { source_operations: 0, host_turns: 0 };
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_http_fixture_no_native_parser' });
  const sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { calls.source_operations++; throw new Error('Export must not discover sources.'); },
    inventorySource: async () => { calls.source_operations++; throw new Error('Export must not inventory sources.'); },
    readSelectedEntry: async () => { calls.source_operations++; throw new Error('Export must not acquire sources.'); } };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}, encodedBody) {
    const result = await fetch(runtime.origin + API + path, { method, headers: { Origin: runtime.origin,
      ...(body === undefined && encodedBody === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined && encodedBody === undefined ? {} : { body: encodedBody ?? JSON.stringify(body) }) });
    return { status: result.status, data: await result.json() };
  }
  async function pair() {
    const response = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: runtime.createPairingCode() }) });
    assert.equal(response.status, 200); const session = await response.json(); const cookie = response.headers.get('set-cookie').split(';')[0];
    const credentials = { Cookie: cookie, 'X-LearnBridge-Nonce': session.nonce }; sessions.push(credentials);
    return (path, body, method, headers = {}, encodedBody) => raw(path, body, method, { ...credentials, ...headers }, encodedBody);
  }
  async function restart(dataRoot = root) {
    await runtime?.close(); runtime = await startRuntime({ dataRoot, port: 0, sourceAdapter,
      hostAdapter: { enabled: false, execute: async () => { calls.host_turns++; throw new Error('Export must not contact a model.'); } } });
    return pair();
  }
  return { root, parent, sessions, calls, raw, pair, restart, close: () => runtime.close(), call: await restart() };
}
async function seed(f, { apply = false, academicPolicy = 'learning_support', origin = 'agent_paste', kind = 'revision' } = {}) {
  const source = await f.call('/documents', { title: 'Selected synthetic source', content: `Original résumé 🧠\r\nA café paragraph.\r\n${bodyCanary}\r\n`, academic_policy: academicPolicy });
  assert.equal(source.status, 201); const unselected = await f.call('/documents', { title: 'Unselected synthetic source', content: unrelatedCanary }); assert.equal(unselected.status, 201);
  const task = await f.call('/tasks', { title: 'Student-owned task', effort_minutes: 30 }); assert.equal(task.status, 201);
  const created = await f.call('/writing/proposals', { title: 'Reviewed résumé & notes', kind, draft_text: `Reviewed résumé 🧠\r\nSecond paragraph & <literal markup>.\r\n${bodyCanary}\r\n`,
    source_documents: [{ id: source.data.document.id, revision: source.data.document.revision, sha256: source.data.sha256 }], academic_policy: academicPolicy, origin });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const accepted = await f.call(`/writing/items/${created.data.item.id}/${apply ? 'apply-revision' : 'accept'}`, review(created.data.item));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  return { source: source.data, unselected: unselected.data, task: task.data.task, created: created.data.item, accepted: accepted.data.item };
}
async function privateState(call) {
  const documents = (await call('/documents')).data.items;
  return { documents: await Promise.all(documents.map(async document => ({ item: (await call(`/documents/${document.id}`)).data,
    revisions: (await call(`/documents/${document.id}/revisions`)).data.items }))), tasks: (await call('/tasks')).data.items,
    writing: (await call('/writing/items')).data.items, grants: (await call('/agent-grants')).data.items,
    sources: (await call('/sources')).data.items, reports: (await call('/onboarding/reports')).data.items };
}
function artifact(response, savedText) {
  assert.equal(response.status, 200, JSON.stringify(response.data)); const data = response.data;
  assert.equal(data.mime, MIME); assert.equal(data.encoding, 'base64'); assert.match(data.filename, /\.docx$/);
  assert.equal(/[\\/]/.test(data.filename), false);
  assert.match(data.sha256, /^[a-f0-9]{64}$/); assert.equal(typeof data.base64, 'string');
  const bytes = Buffer.from(data.base64, 'base64'); assert.equal(bytes.toString('base64'), data.base64);
  assert.equal(bytes.length, data.byte_length); assert.equal(sha(bytes), data.sha256); assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(data.validation, 'fixed_ooxml_structure_and_exact_text_hash'); assert.equal(data.sharing, 'not_granted'); assert.equal(data.visual_review, 'pending');
  assert.equal(typeof data.warning, 'string'); assert.ok(data.warning.length > 0); assert.equal(typeof data.manifest, 'object');
  assert.equal(JSON.stringify(data).includes(unrelatedCanary), false);
  assert.equal(data.manifest.format, 'learnbridge-word-text-artifact'); assert.equal(data.manifest.normalization, 'crlf_cr_to_lf');
  assert.equal(data.manifest.visual_review, 'pending'); assert.equal(data.manifest.sharing, 'not_granted');
  if (savedText !== undefined) {
    assert.equal(data.manifest.original_text_sha256, sha(savedText)); assert.equal(data.manifest.original_text_bytes, Buffer.byteLength(savedText));
    const normalized = savedText.replace(/\r\n?/g, '\n'); assert.equal(data.manifest.normalized_text_sha256, sha(normalized));
    assert.equal(data.manifest.normalized_text_bytes, Buffer.byteLength(normalized)); assert.equal(data.manifest.provenance.document.sha256, sha(savedText));
  }
  return data;
}

test('WHA01: an exact paired accepted alternative exports deterministic Word bytes without changing sources, notes, tasks, reports or permissions', async t => {
  const f = await fixture(t), saved = await seed(f), before = await privateState(f.call);
  const acceptedNote = (await f.call(`/documents/${saved.accepted.data.accepted_note.id}`)).data;
  const first = artifact(await f.call(route(saved.accepted), review(saved.accepted)), acceptedNote.content);
  const second = artifact(await f.call(route(saved.accepted), review(saved.accepted)), acceptedNote.content);
  assert.equal(first.base64, second.base64); assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.document.id, saved.accepted.data.accepted_note.id); assert.equal(first.document.revision, saved.accepted.data.accepted_note.revision);
  assert.deepEqual(first.source_documents, saved.accepted.data.source_documents); assert.equal(first.content_status, 'student_reviewed_model_output_facts_unverified');
  assert.deepEqual(first.manifest.provenance.writing_record, { id: saved.accepted.id, revision: saved.accepted.revision, payload_hash: saved.accepted.data.payload_hash, state: 'accepted' });
  assert.deepEqual(first.manifest.provenance.source_documents, saved.accepted.data.source_documents.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })));
  assert.deepEqual(await privateState(f.call), before); assert.deepEqual(f.calls, { source_operations: 0, host_turns: 0 });
  const original = (await f.call(`/documents/${saved.source.document.id}`)).data; assert.equal(original.content, saved.source.content); assert.equal(original.document.revision, 1);
});

test('WHA02: applied revisions export the exact reviewed current document and retain the original revision', async t => {
  const f = await fixture(t), saved = await seed(f, { apply: true, origin: 'student' }); const before = await privateState(f.call);
  const current = (await f.call(`/documents/${saved.source.document.id}`)).data;
  const word = artifact(await f.call(route(saved.accepted), review(saved.accepted)), current.content);
  assert.equal(word.document.id, saved.source.document.id); assert.equal(word.document.revision, 2); assert.equal(word.content_status, 'student_reviewed_content');
  assert.deepEqual(word.manifest.provenance.writing_record, { id: saved.accepted.id, revision: saved.accepted.revision, payload_hash: saved.accepted.data.payload_hash, state: 'applied_revision' });
  assert.deepEqual((await f.call(`/documents/${saved.source.document.id}/revisions`)).data.items.map(item => item.revision), [1, 2]);
  const markdown = await f.call(`/writing/items/${saved.accepted.id}/export`, review(saved.accepted)); assert.equal(markdown.status, 200);
  assert.equal(markdown.data.mime, 'text/markdown; charset=utf-8'); assert.equal(markdown.data.text, saved.created.data.payload.draft_text);
  assert.equal(markdown.data.sha256, current.sha256); assert.deepEqual(await privateState(f.call), before);
});

test('WHA03: Word export requires paired cookie, nonce and same-origin authority and rejects incorrect methods or query expansion', async t => {
  const f = await fixture(t), saved = await seed(f), path = route(saved.accepted), before = await privateState(f.call);
  assert.equal((await f.raw(path, review(saved.accepted))).status, 401);
  assert.equal((await f.call(path, review(saved.accepted), 'POST', { 'X-LearnBridge-Nonce': '' })).status, 403);
  assert.equal((await f.call(path, review(saved.accepted), 'POST', { 'X-LearnBridge-Nonce': 'wrong' })).status, 403);
  assert.equal((await f.call(path, review(saved.accepted), 'POST', { Origin: 'https://outside.example' })).status, 403);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    const result = await f.call(path, method === 'GET' ? undefined : review(saved.accepted), method); assert.ok([400, 405].includes(result.status), JSON.stringify(result));
    assert.equal('base64' in result.data, false);
  }
  assert.equal((await f.call(path + '?destination=cloud', review(saved.accepted))).status, 400);
  assert.deepEqual(await privateState(f.call), before);
});

test('WHA04: export body cannot forge destination, text, filename, provenance or record authority', async t => {
  const f = await fixture(t), saved = await seed(f), path = route(saved.accepted), exact = review(saved.accepted), before = await privateState(f.call);
  const invalid = [{}, { expected_revision: exact.expected_revision }, { payload_hash: exact.payload_hash }, { ...exact, expected_revision: 0 },
    { ...exact, expected_revision: '2' }, { ...exact, payload_hash: 'not-a-hash' }, ...['text', 'filename', 'destination', 'provenance', 'encoding', 'document', 'source_documents', 'confirmed'].map(field => ({ ...exact, [field]: 'FORGED_WORD_EXPORT_BODY_CANARY' }))];
  for (const body of invalid) {
    const denied = await f.call(path, body); assert.equal(denied.status, 400, JSON.stringify(denied));
    assert.equal(JSON.stringify(denied.data).includes('FORGED_WORD_EXPORT_BODY_CANARY'), false); assert.equal('base64' in denied.data, false);
  }
  const wrongHash = await f.call(path, { ...exact, payload_hash: 'f'.repeat(64) }); assert.equal(wrongHash.status, 409);
  const oldReview = await f.call(path, review(saved.created)); assert.ok([403, 409].includes(oldReview.status));
  assert.equal((await f.call(path, exact, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.call(path, exact, 'POST', {}, '{malformed JSON')).status, 400);
  assert.equal((await f.call(path, { ...exact, payload_hash: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual(await privateState(f.call), before);
});

test('WHA05: unaccepted, rejected, forgotten and wrong-kind records cannot export Word artifacts', async t => {
  const f = await fixture(t), saved = await seed(f);
  const proposal = await f.call('/writing/proposals', { title: 'Unreviewed draft', kind: 'outline', draft_text: 'Unreviewed synthetic draft',
    source_documents: [], academic_policy: 'learning_support', origin: 'student' }); assert.equal(proposal.status, 201);
  assert.equal((await f.call(route(proposal.data.item), review(proposal.data.item))).status, 403);
  const rejected = await f.call(`/writing/items/${proposal.data.item.id}/reject`, review(proposal.data.item)); assert.equal(rejected.status, 200);
  assert.equal((await f.call(route(rejected.data.item), review(rejected.data.item))).status, 403);
  assert.equal((await f.call(`/writing/items/${saved.task.id}/export-docx`, review(saved.accepted))).status, 403);
  const before = await privateState(f.call); assert.equal((await f.call(`/writing/items/${saved.accepted.id}`, { expected_revision: saved.accepted.revision }, 'DELETE')).status, 200);
  const forgotten = await f.call(route(saved.accepted), review(saved.accepted)); assert.equal(forgotten.status, 403); assert.equal('base64' in forgotten.data, false);
  assert.equal((await f.call('/documents')).data.items.length, before.documents.length); assert.equal((await f.call('/agent-grants')).data.items.length, before.grants.length);
});

test('WHA06: changed or removed source versions and edited accepted private copies deny export without creating another artifact', async t => {
  for (const mode of ['source_edit', 'source_forget', 'accepted_edit', 'accepted_forget']) {
    const f = await fixture(t), saved = await seed(f), target = mode.startsWith('source') ? saved.source.document : saved.accepted.data.accepted_note;
    const mutate = mode.endsWith('forget') ? await f.call(`/documents/${target.id}`, { expected_revision: target.revision }, 'DELETE')
      : await f.call(`/documents/${target.id}`, { expected_revision: target.revision, content: 'Changed version after exact review' }, 'PATCH');
    assert.equal(mutate.status, 200); const before = await privateState(f.call);
    const denied = await f.call(route(saved.accepted), review(saved.accepted)); assert.equal(denied.status, 409, JSON.stringify(denied)); assert.equal('base64' in denied.data, false);
    assert.deepEqual(await privateState(f.call), before); assert.equal(f.calls.host_turns, 0);
  }
});

test('WHA07: mutation after an applied revision invalidates Word export while retained history stays intact', async t => {
  const f = await fixture(t), saved = await seed(f, { apply: true });
  const current = (await f.call(`/documents/${saved.source.document.id}`)).data;
  assert.equal((await f.call(`/documents/${saved.source.document.id}`, { expected_revision: current.document.revision, content: 'Later student edit' }, 'PATCH')).status, 200);
  const before = await privateState(f.call), denied = await f.call(route(saved.accepted), review(saved.accepted)); assert.equal(denied.status, 409);
  assert.deepEqual((await f.call(`/documents/${saved.source.document.id}/revisions`)).data.items.map(item => item.revision), [1, 2, 3]);
  assert.deepEqual(await privateState(f.call), before);
});

test('WHA08: permitted graded scaffolding retains its policy and fact-review labels in the exported Word provenance', async t => {
  const f = await fixture(t), saved = await seed(f, { kind: 'outline', academicPolicy: 'graded_restricted', origin: 'agent_paste' });
  const exported = artifact(await f.call(route(saved.accepted), review(saved.accepted)));
  assert.equal(exported.document.academic_policy, 'graded_restricted'); assert.equal(exported.content_status, 'student_reviewed_model_output_facts_unverified');
  assert.equal(JSON.stringify(exported.manifest).includes('graded_restricted'), true); assert.equal(f.calls.host_turns, 0);
});

test('WHA09: restart and a fresh backup restore return identical Word bytes and preserve explicit sharing boundaries', async t => {
  const f = await fixture(t), saved = await seed(f), original = artifact(await f.call(route(saved.accepted), review(saved.accepted))); const before = await privateState(f.call);
  const oldSession = f.sessions.at(-1); let call = await f.restart();
  assert.equal((await f.raw(route(saved.accepted), review(saved.accepted), 'POST', oldSession)).status, 401);
  const restarted = artifact(await call(route(saved.accepted), review(saved.accepted))); assert.equal(restarted.base64, original.base64); assert.deepEqual(restarted.manifest, original.manifest);
  assert.deepEqual(await privateState(call), before);
  await f.close(); const store = LocalStore.open({ root: f.root }); const backup = join(f.parent, 'backup');
  try { await store.backup(backup); } finally { store.close(); }
  const restoredRoot = join(f.parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restoredRoot }); call = await f.restart(restoredRoot);
  const restored = artifact(await call(route(saved.accepted), review(saved.accepted))); assert.equal(restored.base64, original.base64); assert.deepEqual(restored.manifest, original.manifest);
  assert.deepEqual(await privateState(call), before); assert.deepEqual(f.calls, { source_operations: 0, host_turns: 0 });
});

test('WHA10: another local workspace cannot export the first student’s accepted Word artifact', async t => {
  const first = await fixture(t), second = await fixture(t), saved = await seed(first); const before = await privateState(second.call);
  const denied = await second.call(route(saved.accepted), review(saved.accepted)); assert.equal(denied.status, 403); assert.equal('base64' in denied.data, false);
  assert.deepEqual(await privateState(second.call), before); assert.deepEqual(second.calls, { source_operations: 0, host_turns: 0 });
});

test('WHA11: supplementary Unicode titles produce whole-letter bounded Word and Markdown filenames that pass the client verifier', async t => {
  const f = await fixture(t), letter = '\u{10400}', cases = [
    { title: 'A'.repeat(79) + letter, stem: 'A'.repeat(79) },
    { title: 'A'.repeat(78) + letter, stem: 'A'.repeat(78) + letter },
    { title: letter.repeat(45), stem: letter.repeat(40) },
  ];
  for (const { title, stem } of cases) {
    const draft = 'Synthetic reviewed text for a supplementary-letter filename.';
    const proposed = await f.call('/writing/proposals', { title, kind: 'markdown_artifact', draft_text: draft,
      source_documents: [], academic_policy: 'unrestricted', origin: 'student' });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
    const accepted = await f.call(`/writing/items/${proposed.data.item.id}/accept`, review(proposed.data.item));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); const record = accepted.data.item;
    const saved = await f.call(`/documents/${record.data.accepted_note.id}`); assert.equal(saved.status, 200);
    assert.ok(saved.data.content.includes(draft));
    const before = await privateState(f.call), word = artifact(await f.call(route(record), review(record)), saved.data.content);
    const markdown = await f.call(`/writing/items/${record.id}/export`, review(record)); assert.equal(markdown.status, 200);
    assert.equal(word.filename, stem + '.docx'); assert.equal(markdown.data.filename, stem + '.md');
    assert.ok(word.filename.length <= 100); assert.ok(markdown.data.filename.length <= 100);
    assert.equal(word.filename.isWellFormed(), true); assert.equal(markdown.data.filename.isWellFormed(), true);
    const verified = await verifyWordDownload(word, record);
    assert.deepEqual(Buffer.from(verified), Buffer.from(word.base64, 'base64')); assert.equal(sha(verified), word.sha256);
    assert.equal(markdown.data.mime, 'text/markdown; charset=utf-8'); assert.equal(markdown.data.text, saved.data.content);
    assert.equal(markdown.data.sha256, saved.data.sha256); assert.deepEqual(await privateState(f.call), before);
  }
  assert.deepEqual(f.calls, { source_operations: 0, host_turns: 0 });
});
