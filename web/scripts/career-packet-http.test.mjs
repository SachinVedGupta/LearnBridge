import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { profileHash } from '../apps/local-runtime/src/profile.mjs';
import { mountCareerPacketsUI, verifyCareerPacketDownload } from '../apps/local/public/career-packets.js';

const API = '/api/local/v1', choice = { provider: 'greenhouse', board_slug: 'fixturecompany' }, selected = { ...choice, job_id: '123' };
const posting = { id: 123, title: 'Synthetic Software Internship', location: { name: 'Toronto' }, content: '<p>Build useful student tools.</p>' };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const review = record => ({ expected_revision: record.revision, payload_hash: record.data.payload_hash });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-career-packet-http-')), root = join(parent, 'workspace'), calls = []; let runtime;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_packet_no_native_parser' });
  const sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { throw new Error('No private discovery'); }, inventorySource: async () => { throw new Error('No private inventory'); }, readSelectedEntry: async () => { throw new Error('No private read'); } };
  const publicJobFetch = async (url, options) => { calls.push({ url, method: options.method }); if (url === 'https://boards-api.greenhouse.io/v1/boards/fixturecompany/jobs') return response({ jobs: [posting] }); if (url === 'https://boards-api.greenhouse.io/v1/boards/fixturecompany/jobs/123') return response(posting); throw new Error('Unexpected public source'); };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const result = await fetch(runtime.origin + API + route, { method, headers: { Origin: runtime.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: result.status, data: await result.json() };
  }
  async function pair() {
    const result = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(result.status, 200);
    const paired = await result.json(), credentials = { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': paired.nonce };
    return { credentials, call: (route, body, method, headers = {}) => raw(route, body, method, { ...credentials, ...headers }) };
  }
  async function restart() { await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0, publicJobFetch, sourceAdapter, hostAdapter: { enabled: false, execute: async () => { throw new Error('No inference'); } } }); return pair(); }
  return { parent, root, calls, raw, restart, pair, ...await restart() };
}
async function seed(f) {
  assert.equal((await f.call('/public-jobs/search', choice)).status, 200); const role = (await f.call('/public-jobs/read', selected)).data.role;
  const source = (await f.call('/documents', { title: 'Selected experience source', content: 'Built a synthetic student planning tool.', academic_policy: 'unrestricted' })).data;
  await f.call('/documents', { title: 'Unselected private document', content: 'PRIVATE_HTTP_PACKET_CANARY' });
  async function fact(field, value, extra = {}) {
    const result = await f.call('/profile', { field, value, ...extra }, 'POST', { 'Idempotency-Key': `fixture-profile-${randomUUID()}` }); assert.equal(result.status, 201, JSON.stringify(result.data)); const record = result.data.fact;
    const confirmed = await f.call(`/profile/${record.id}/review`, { expected_revision: record.revision, decision: 'confirm', fingerprint: profileHash(record.data) }); assert.equal(confirmed.status, 200); return confirmed.data.fact;
  }
  const name = await fact('name', 'Fixture Student'), email = await fact('email', 'student@example.edu'), university = await fact('university', 'Fixture University'), experience = await fact('experience', 'Built a synthetic student planning tool.',
    { evidence: { kind: 'document', id: source.document.id, revision: source.document.revision, sha256: source.sha256, excerpt: 'Built a synthetic student planning tool.' } });
  const pending = (await f.call('/writing/proposals', { title: 'My reviewed resume draft', kind: 'markdown_artifact', draft_text: '# Fixture Student\nBuilt a synthetic student planning tool.', academic_policy: 'unrestricted', origin: 'student', source_documents: [{ id: source.document.id, revision: source.document.revision, sha256: source.sha256 }] })).data.item;
  const writing = (await f.call(`/writing/items/${pending.id}/accept`, review(pending))).data.item;
  const body = { role_ref: { id: role.id, revision: role.revision, source_sha256: role.data.snapshot.source_sha256 }, profile_refs: [name, email, university, experience].map(record => ({ id: record.id, revision: record.revision, fingerprint: profileHash(record.data) })),
    writing_refs: [{ slot: 'resume', id: writing.id, revision: writing.revision, payload_hash: writing.data.payload_hash }], questions: [{ id: 'experience', prompt: 'Describe relevant experience', required: true, fact_field: 'experience', fact_ids: [experience.id], draft_answer: experience.data.value }] };
  return { role, source, writing, body };
}
async function create(f, body, key = 'fixture-http-packet') { const result = await f.call('/career-packets', body, 'POST', { 'Idempotency-Key': key }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.packet; }
async function state(f) { return { docs: (await f.call('/documents')).data.items, tasks: (await f.call('/tasks')).data.items, grants: (await f.call('/agent-grants')).data.items, sources: (await f.call('/sources')).data.items }; }

test('CPH01: actual paired HTTP creates/reviews/exports exact sourced packet with typed email and no public/provider/model/private-file side effects', async t => {
  const f = await fixture(t), data = await seed(f), before = await state(f), packet = await create(f, data.body);
  assert.equal(packet.checklist_complete, true); assert.equal(packet.exportable, false); assert.equal(packet.data.payload.profile_facts.some(fact => fact.field === 'email' && fact.value === 'student@example.edu'), true);
  assert.equal(JSON.stringify(packet).includes('PRIVATE_HTTP_PACKET_CANARY'), false); assert.equal((await f.call(`/career-packets/items/${packet.id}/export-json`, review(packet))).status, 403);
  const result = await f.call(`/career-packets/items/${packet.id}/review`, review(packet)); assert.equal(result.status, 200); const reviewed = result.data.packet;
  for (const format of ['markdown', 'json']) { const output = await f.call(`/career-packets/items/${packet.id}/export-${format}`, review(reviewed)); assert.equal(output.status, 200); assert.equal(output.data.sha256, sha(output.data.text)); assert.deepEqual(Buffer.from(await verifyCareerPacketDownload(output.data, reviewed, format)), Buffer.from(output.data.text)); }
  assert.equal(f.calls.length, 2); assert.deepEqual(await state(f), before); assert.equal((await f.call('/career/applications')).data.items.length, 0);
});

test('CPH02: actual HTTP pairing/nonce/Origin, exact bodies, methods, IDs and query boundaries deny forged authority before mutation', async t => {
  const f = await fixture(t), other = await fixture(t), data = await seed(f);
  assert.equal((await f.raw('/career-packets', data.body, 'POST', { 'Idempotency-Key': 'fixture-unauthenticated' })).status, 401);
  for (const headers of [{ Origin: 'https://attacker.test' }, { 'X-LearnBridge-Nonce': '' }, { 'X-LearnBridge-Nonce': 'wrong' }]) assert.equal((await f.call('/career-packets', data.body, 'POST', { 'Idempotency-Key': 'fixture-denied-packet', ...headers })).status, 403);
  for (const body of [{ ...data.body, source_url: 'http://127.0.0.1/secret' }, { ...data.body, submitted: true }, { ...data.body, role_ref: { ...data.body.role_ref, revision: 0 } }, {}]) assert.equal((await f.call('/career-packets', body, 'POST', { 'Idempotency-Key': 'fixture-invalid-packet' })).status, 400);
  assert.equal((await f.call('/career-packets', data.body)).status, 400); assert.equal((await f.call('/career-packets?all=true', data.body, 'POST', { 'Idempotency-Key': 'fixture-query-packet' })).status, 400);
  assert.equal((await f.call('/career-packets/state', undefined, 'POST')).status, 400); assert.equal((await f.call('/career-packets', undefined, 'GET')).status, 400);
  const packet = await create(f, data.body); assert.equal((await other.call(`/career-packets/items/${packet.id}`)).status, 403);
  assert.equal((await f.call(`/career-packets/items/${randomUUID()}`)).status, 403); assert.equal((await f.call('/career-packets/items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 400);
  for (const action of ['submit', 'upload', 'send', 'fill-form', 'model']) assert.equal((await f.call(`/career-packets/items/${packet.id}/${action}`, {})).status, 404);
  for (const action of ['review', 'export-markdown', 'export-json']) assert.equal((await f.call(`/career-packets/items/${packet.id}/${action}`, undefined, 'GET')).status, 400);
  assert.equal(f.calls.length, 2); assert.equal((await f.call('/career-packets/state')).data.packets.length, 1);
});

test('CPH03: actual source/profile/writing change blocks old review/export; incomplete manually selected checklist remains explicit without fabricated eligibility', async t => {
  const f = await fixture(t), data = await seed(f), body = { ...data.body, profile_refs: [], writing_refs: [], questions: [{ id: 'gpa', prompt: 'GPA', required: true, fact_field: 'gpa', fact_ids: [], draft_answer: null }], requirements: [{ key: 'gpa', required: true }, { key: 'work_authorization', required: true }, { key: 'resume', required: true }] }, packet = await create(f, body);
  assert.equal(packet.checklist_complete, false); assert.equal(packet.data.payload.questions[0].answer, null); assert.deepEqual(packet.data.payload.missing.required.map(item => item.key), ['gpa', 'work_authorization', 'resume', 'question:gpa']);
  const reviewed = (await f.call(`/career-packets/items/${packet.id}/review`, review(packet))).data.packet; assert.equal((await f.call(`/career-packets/items/${packet.id}/export-json`, review(reviewed))).status, 200);
  await f.call('/public-jobs/read', selected); assert.equal((await f.call(`/career-packets/items/${packet.id}/export-json`, review(reviewed))).status, 409); assert.equal((await f.call(`/career-packets/items/${packet.id}`)).data.packet.stale, true);
  const latestRole = (await f.call('/career-packets/state')).data.roles[0], freshBody = { ...data.body, role_ref: { id: latestRole.id, revision: latestRole.revision, source_sha256: latestRole.source_sha256 } }, fresh = await create(f, freshBody, 'fixture-source-stale-packet');
  await f.call(`/documents/${data.source.document.id}`, { content: 'Changed selected experience evidence.', expected_revision: data.source.document.revision }, 'PATCH');
  const denial = await f.call(`/career-packets/items/${fresh.id}/review`, review(fresh)); assert.ok([403, 409].includes(denial.status)); assert.equal((await f.call(`/career-packets/items/${fresh.id}`)).data.packet.stale, true);
});

test('CPH04: actual restart invalidates old browser session while exact durable review/download survives with no new provider calls', async t => {
  const f = await fixture(t), data = await seed(f), packet = await create(f, data.body), reviewed = (await f.call(`/career-packets/items/${packet.id}/review`, review(packet))).data.packet;
  const artifact = (await f.call(`/career-packets/items/${packet.id}/export-json`, review(reviewed))).data, old = f.credentials, previous = (await f.call(`/career-packets/items/${packet.id}`)).data;
  f.call = (await f.restart()).call; assert.equal((await f.raw('/career-packets/state', undefined, 'GET', old)).status, 401); assert.deepEqual((await f.call(`/career-packets/items/${packet.id}`)).data, previous); assert.deepEqual((await f.call(`/career-packets/items/${packet.id}/export-json`, review(reviewed))).data, artifact); assert.equal(f.calls.length, 2);
});

class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.parent = null; this.listeners = new Map(); this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } if (this.tagName === 'select' && this.children.length === 1) this.value = this.children[0].value; }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  setAttribute() {} addEventListener(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); } set textContent(value) { this.replaceChildren(); this.text = String(value); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } } click() { this.clicked = true; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click') => { for (const listener of node.listeners.get(type) || []) listener({ preventDefault() {} }); };
async function harness(f, t, intercept) {
  const root = new Node('section'), requests = [], pending = [], registered = [], unregistered = [];
  const request = async (route, options = {}) => { requests.push(route); const response = await f.call(route, options.body, options.method, options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}); if (response.status >= 400) throw new Error(response.data.message || response.data.error || 'HTTP denied'); const altered = intercept?.(route, response.data); return altered === undefined ? response.data : await altered; };
  const ui = mountCareerPacketsUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text), busy(control, callback) { const promise = Promise.resolve().then(callback); pending.push(promise); return promise; }, registerDownload(url) { registered.push(url); }, unregisterDownload(url) { unregistered.push(url); } });
  t.after(() => ui.reset());
  const settle = async () => { for (let index = 0; index < 6; index++) { await Promise.resolve(); await Promise.all(pending.map(promise => promise.catch(() => {}))); } };
  const find = text => { const result = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(result, text); return result; };
  await ui.refresh(); return { root, ui, requests, registered, unregistered, settle, find, click: async text => { fire(find(text)); await settle(); },
    prepare() { const form = walk(root).find(node => node.tagName === 'form'); fire(form, 'submit'); return settle(); } };
}

test('CPH05: actual shipped controller + real HTTP explicitly selects source/facts/writing, reviews exact missing-aware packet and prepares independently readable JSON/Markdown Blobs', async t => {
  const f = await fixture(t), data = await seed(f), before = f.calls.length, h = await harness(f, t); assert.equal(f.calls.length, before); assert.ok(h.root.textContent.includes('not a discovered employer form'));
  walk(h.root).find(node => node.id === 'career-packet-role').value = data.role.id; walk(h.root).find(node => node.id === 'career-packet-resume').value = data.writing.id;
  for (const checkbox of walk(h.root).filter(node => node.tagName === 'input' && node.type === 'checkbox').slice(0, 4)) checkbox.checked = true;
  await h.click('Add a manual application question'); const prompts = walk(h.root).filter(node => node.tagName === 'textarea'); prompts[0].value = 'Why are you interested?'; prompts[1].value = 'My manually entered motivation.';
  await h.prepare(); assert.ok(h.root.textContent.includes('Exact payload SHA-256')); assert.ok(h.root.textContent.includes('manual_draft_facts_unverified')); assert.equal(f.calls.length, before);
  await h.click('I reviewed this exact private packet and its missing fields'); const packetSummary = (await f.call('/career-packets/state')).data.packets[0], packet = (await f.call(`/career-packets/items/${packetSummary.id}`)).data.packet; assert.equal(packet.data.state, 'reviewed');
  for (const format of ['JSON', 'Markdown']) { await h.click(`Download reviewed packet ${format}`); const url = h.registered.at(-1), bytes = Buffer.from(await (await fetch(url)).arrayBuffer()); const output = (await f.call(`/career-packets/items/${packet.id}/export-${format.toLowerCase()}`, review(packet))).data; assert.equal(sha(bytes), output.sha256); assert.equal(bytes.length, output.byte_length); if (format === 'JSON') assert.deepEqual(JSON.parse(bytes.toString()).payload, packet.data.payload); }
  assert.equal(h.registered.length, 2); assert.equal(f.calls.length, before); assert.equal((await f.call('/career/applications')).data.items.length, 0);
  h.ui.reset(); assert.deepEqual(h.unregistered, h.registered); for (const url of h.registered) await assert.rejects(fetch(url));
});

test('CPH06: shipped controller suppresses late duplicate download after logout/reset and changed saved-source refresh removes stale export controls', async t => {
  const f = await fixture(t), data = await seed(f), packet = await create(f, data.body), reviewed = (await f.call(`/career-packets/items/${packet.id}/review`, review(packet))).data.packet, started = deferred(), released = deferred();
  const h = await harness(f, t, (route, data) => { if (route.endsWith('/export-json')) { started.resolve(data); return released.promise; } }); await h.click('Open this private packet');
  fire(h.find('Download reviewed packet JSON')); fire(h.find('Download reviewed packet JSON')); const output = await started.promise; assert.equal(h.requests.filter(route => route.endsWith('/export-json')).length, 1); h.ui.reset(); released.resolve(output); await h.settle(); assert.equal(h.registered.length, 0); assert.equal(h.root.textContent.includes('Built a synthetic'), false);
  const second = await harness(f, t); await second.click('Open this private packet'); await f.call('/public-jobs/read', selected); await second.ui.refresh(); assert.equal(second.root.textContent.includes('Download reviewed packet JSON'), false); assert.equal((await f.call(`/career-packets/items/${reviewed.id}`)).data.packet.stale, true);
});

test('CPH07: actual HTTP/controller forget removes current packet/export controls while preserving source/facts/Writing and exposing historical-copy retention', async t => {
  const f = await fixture(t), data = await seed(f), packet = await create(f, data.body), reviewed = (await f.call(`/career-packets/items/${packet.id}/review`, review(packet))).data.packet, h = await harness(f, t), before = await state(f);
  assert.equal((await f.call(`/career-packets/items/${packet.id}`, review(packet), 'DELETE')).status, 409);
  await h.click('Open this private packet'); await h.click('Forget this private packet'); assert.ok(h.root.textContent.includes('Historical local revisions')); assert.equal(h.root.textContent.includes('Download reviewed packet JSON'), false);
  assert.equal((await f.call(`/career-packets/items/${reviewed.id}`)).status, 403); assert.equal((await f.call('/career-packets/state')).data.packets.length, 0); assert.deepEqual(await state(f), before); assert.equal(f.calls.length, 2);
});

test('CPH08: actual shipped controller never replaces a newer selected preview with an older slow local read', async t => {
  const f = await fixture(t), data = await seed(f), first = await create(f, data.body, 'fixture-selection-first'), second = await create(f, { ...data.body, questions: [] }, 'fixture-selection-second'), started = deferred(), released = deferred();
  const h = await harness(f, t, (route, result) => { if (route === `/career-packets/items/${first.id}`) { started.resolve(result); return released.promise; } });
  const opens = walk(h.root).filter(node => node.tagName === 'button' && node.textContent === 'Open this private packet'), firstControl = opens.find(node => node.parent.textContent.includes('Application review') && node.parent.textContent.includes(first.title));
  const firstIndex = (await f.call('/career-packets/state')).data.packets.findIndex(packet => packet.id === first.id), secondIndex = (await f.call('/career-packets/state')).data.packets.findIndex(packet => packet.id === second.id);
  fire(opens[firstIndex]); const oldResponse = await started.promise; fire(opens[secondIndex]);
  for (let index = 0; index < 20 && !h.root.textContent.includes(second.data.payload_hash); index++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(h.root.textContent.includes(second.data.payload_hash)); released.resolve(oldResponse); await h.settle(); assert.equal(h.root.textContent.includes(first.data.payload_hash), false); assert.ok(h.root.textContent.includes(second.data.payload_hash)); assert.ok(firstControl);
});
