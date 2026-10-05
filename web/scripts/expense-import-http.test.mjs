import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../apps/local-runtime/src/server.mjs';
import { mountExpenseImportUI } from '../apps/local/public/expense-import.js';

const API = '/api/local/v1', sha = value => createHash('sha256').update(value).digest('hex'), csv = 'date,description,amount,currency,category,reference\r\n2026-10-04,"Lunch, café",12.50,CAD,food,a\r\n2026-10-04,Refund,-2.25,CAD,food,b\r\n2026-10-04,Book,10.01,USD,school,c\r\n2026-02-30,Bad date,1,CAD,food,bad\r\n';
const body = { origin: 'student-expenses', filename: 'fixture.csv', csv_text: csv, file_sha256: sha(csv) };
const pins = preview => ({ expected_revision: preview.revision, preview_hash: preview.data.preview_hash });
const select = preview => ({ ...pins(preview), selected_rows: preview.rows.filter(row => row.selectable).map(row => ({ row_number: row.row_number, row_hash: row.row_hash })) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-expense-http-')), root = join(parent, 'workspace'); let runtime;
  const unsupported = async () => ({ state: 'unsupported', verification: 'synthetic_csv_no_native_parser' });
  const sourceAdapter = { probeSourceCapability: unsupported, probePdfCapability: unsupported, probeOfficeCapability: unsupported,
    describeRoot: async () => { throw new Error('No private discovery'); }, inventorySource: async () => { throw new Error('No private inventory'); }, readSelectedEntry: async () => { throw new Error('No private file read'); } };
  t.after(async () => { await runtime?.close(); rmSync(parent, { recursive: true, force: true }); });
  async function raw(route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const response = await fetch(runtime.origin + API + route, { method, headers: { Origin: runtime.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() };
  }
  async function pair() {
    const result = await fetch(runtime.origin + API + '/pair', { method: 'POST', headers: { Origin: runtime.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: runtime.createPairingCode() }) }); assert.equal(result.status, 200); const session = await result.json(), credentials = { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-LearnBridge-Nonce': session.nonce };
    return { credentials, call: (route, body, method, headers = {}) => raw(route, body, method, { ...credentials, ...headers }) };
  }
  async function restart() { await runtime?.close(); runtime = await startRuntime({ dataRoot: root, port: 0, sourceAdapter, publicJobFetch: async () => { throw new Error('CSV cannot fetch providers'); }, hostAdapter: { enabled: false, execute: async () => { throw new Error('CSV cannot contact models'); } } }); return pair(); }
  return { root, parent, raw, restart, pair, ...await restart() };
}
async function seed(f, key = 'fixture-http-csv-preview') { const result = await f.call('/expense-import/previews', body, 'POST', { 'Idempotency-Key': key }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.preview; }
async function preserved(f) { return { documents: (await f.call('/documents')).data.items, tasks: (await f.call('/tasks')).data.items, grants: (await f.call('/agent-grants')).data.items, sources: (await f.call('/sources')).data.items }; }

test('EIH01: actual paired HTTP source preview and exact atomic commit appear in real Life expenses with signed per-currency totals and source receipts', async t => {
  const f = await fixture(t); await f.call('/documents', { title: 'Private unrelated CSV note', content: 'PRIVATE_CSV_HTTP_CANARY' }); const before = await preserved(f), item = await seed(f);
  assert.equal(item.counts.invalid, 1); assert.equal((await f.call('/life/expenses')).data.items.length, 0); const request = select(item), result = await f.call(`/expense-import/previews/${item.id}/commit`, request, 'POST', { 'Idempotency-Key': 'fixture-http-csv-commit' }); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.receipt.rows.length, 3); const expenses = (await f.call('/life/expenses')).data.items; assert.equal(expenses.length, 3); assert.ok(expenses.every(record => record.data.expense.confirmed && record.data.import_source.file_sha256 === sha(csv)));
  const totals = (await f.call('/expense-import/state')).data.totals; assert.deepEqual([...totals.totals].sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'CAD', cents: 1025 }, { currency: 'USD', cents: 1001 }]); assert.equal(totals.converted, false); assert.equal(JSON.stringify(result.data).includes('PRIVATE_CSV_HTTP_CANARY'), false); assert.deepEqual(await preserved(f), before);
  const replay = await f.call(`/expense-import/previews/${item.id}/commit`, request, 'POST', { 'Idempotency-Key': 'fixture-http-csv-commit' }); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal((await f.call('/life/expenses')).data.items.length, 3);
});

test('EIH02: actual cookie/nonce/Origin, unknown fields/query/methods/IDs and exact row/file/revision hashes deny unauthorized mutations', async t => {
  const f = await fixture(t), other = await fixture(t); assert.equal((await f.raw('/expense-import/previews', body, 'POST', { 'Idempotency-Key': 'fixture-unauth-csv' })).status, 401);
  for (const headers of [{ Origin: 'https://outside.example' }, { 'X-LearnBridge-Nonce': '' }, { 'X-LearnBridge-Nonce': 'wrong' }]) assert.equal((await f.call('/expense-import/previews', body, 'POST', { 'Idempotency-Key': 'fixture-invalid-auth', ...headers })).status, 403);
  for (const patch of [{ file_sha256: 'f'.repeat(64) }, { filename: '../private.csv' }, { origin: 'http://bank.test' }, { url: 'http://127.0.0.1/private' }]) assert.ok([400, 409].includes((await f.call('/expense-import/previews', { ...body, ...patch }, 'POST', { 'Idempotency-Key': 'fixture-invalid-csv' })).status));
  assert.equal((await f.call('/expense-import/previews', body)).status, 400); assert.equal((await f.call('/expense-import/previews?url=secret', body, 'POST', { 'Idempotency-Key': 'fixture-csv-query' })).status, 400); assert.equal((await f.call('/expense-import/state', {}, 'POST')).status, 400);
  const item = await seed(f); assert.equal((await other.call(`/expense-import/previews/${item.id}`)).status, 403); assert.equal((await f.call(`/expense-import/previews/${randomUUID()}`)).status, 403); assert.equal((await f.call('/expense-import/previews/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 400);
  for (const input of [{ ...select(item), preview_hash: 'f'.repeat(64) }, { ...select(item), selected_rows: [{ row_number: 1, row_hash: 'f'.repeat(64) }] }, { ...select(item), selected_rows: [{ row_number: 4, row_hash: item.rows[3].row_hash }] }]) assert.equal((await f.call(`/expense-import/previews/${item.id}/commit`, input, 'POST', { 'Idempotency-Key': 'fixture-denied-rows' })).status, 409);
  assert.equal((await f.call(`/expense-import/previews/${item.id}/commit`, undefined, 'GET')).status, 400); assert.equal((await f.call(`/expense-import/previews/${item.id}/bank-connect`, {})).status, 404); assert.equal((await f.call('/life/expenses')).data.items.length, 0);
});

test('EIH03: HTTP restart keeps exact CSV/journal/totals, denies old browser authority and exact file/reference duplicates create no second transaction', async t => {
  const f = await fixture(t), item = await seed(f), request = select(item), result = await f.call(`/expense-import/previews/${item.id}/commit`, request, 'POST', { 'Idempotency-Key': 'fixture-http-restart' }), previous = (await f.call(`/expense-import/previews/${item.id}`)).data, old = f.credentials;
  f.call = (await f.restart()).call; assert.equal((await f.raw('/expense-import/state', undefined, 'GET', old)).status, 401); assert.deepEqual((await f.call(`/expense-import/previews/${item.id}`)).data, previous);
  const replay = await f.call(`/expense-import/previews/${item.id}/commit`, request, 'POST', { 'Idempotency-Key': 'fixture-http-restart' }); assert.equal(replay.status, 200); assert.deepEqual(replay.data.receipt, result.data.receipt);
  const next = await seed(f, 'fixture-second-identical-csv'); assert.equal(next.counts.already_imported, 3); assert.equal(next.counts.selectable, 0); assert.equal((await f.call('/life/expenses')).data.items.length, 3);
  const forgotten = await f.call(`/expense-import/previews/${item.id}`, pins(replay.data.preview), 'DELETE'); assert.equal(forgotten.status, 200); assert.equal((await f.call('/life/expenses')).data.items.length, 3); assert.equal((await f.call(`/expense-import/previews/${item.id}`)).status, 403);
});

class Node {
  constructor(tag, cls = '', text = '') { this.tagName = tag; this.className = cls; this.text = text; this.children = []; this.parent = null; this.listeners = new Map(); this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); } setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); } set textContent(value) { this.replaceChildren(); this.text = String(value); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const fire = (node, type = 'click') => { for (const callback of node.listeners.get(type) || []) callback({ preventDefault() {} }); };
async function harness(f, t, intercept) {
  const root = new Node('section'), requests = [], pending = [], request = async (route, options = {}) => { requests.push({ route, ...options }); const result = await f.call(route, options.body, options.method, options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}); if (result.status >= 400) throw new Error(result.data.message || 'HTTP denied'); const altered = intercept?.(route, result.data); return altered === undefined ? result.data : await altered; };
  const ui = mountExpenseImportUI({ root, request, element: (tag, cls, text) => new Node(tag, cls, text), busy(node, callback) { const result = Promise.resolve().then(callback); pending.push(result); return result; } }); t.after(() => ui.reset());
  const settle = async () => { for (let index = 0; index < 5; index++) { await Promise.resolve(); await Promise.all(pending.map(promise => promise.catch(() => {}))); } };
  const find = text => { const node = walk(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(node, text); return node; };
  await ui.refresh(); return { root, ui, requests, settle, find, click: async text => { fire(find(text)); await settle(); }, preview: async file => { walk(root).find(node => node.id === 'expense-import-origin').value = 'student-expenses'; walk(root).find(node => node.id === 'expense-import-file').files = [file]; fire(walk(root).find(node => node.tagName === 'form'), 'submit'); await settle(); } };
}

test('EIH04: shipped controller + actual HTTP reads only selected File, defaults all rows unchecked, confirms exact chosen subset and displays truthful invalid/refund/currency/source receipts', async t => {
  const f = await fixture(t), h = await harness(f, t); assert.deepEqual(h.requests.map(request => request.route), ['/expense-import/state']); await h.preview(new File([Buffer.from(csv)], 'fixture.csv'));
  assert.ok(h.root.textContent.includes('invalid_calendar_date')); assert.ok(h.root.textContent.includes('-225 cents CAD')); assert.ok(h.root.textContent.includes('1001 cents USD')); assert.ok(h.root.textContent.includes(sha(csv)));
  const checks = walk(h.root).filter(node => node.tagName === 'input' && node.type === 'checkbox'); assert.equal(checks.length, 3); assert.equal(checks.every(node => !node.checked), true);
  checks[0].checked = true; checks[1].checked = true; fire(walk(h.root).filter(node => node.tagName === 'form')[1], 'submit'); await h.settle(); const commit = h.requests.find(request => request.route.endsWith('/commit')); assert.equal(commit.body.selected_rows.length, 2);
  assert.deepEqual((await f.call('/expense-import/state')).data.totals.totals, [{ currency: 'CAD', cents: 1025 }]); assert.equal((await f.call('/life/expenses')).data.items.length, 2); assert.ok(h.root.textContent.includes('durable reviewed import receipts'));
  await h.click('Forget this saved CSV preview'); assert.ok(h.root.textContent.includes('Imported expenses remain')); assert.equal((await f.call('/life/expenses')).data.items.length, 2);
});

test('EIH05: invalid UTF8 and late File/HTTP response after reset never send or expose unauthorized selected source data', async t => {
  const f = await fixture(t), h = await harness(f, t); await h.preview(new File([Uint8Array.from([0xc3, 0x28])], 'invalid.csv')); assert.equal(h.requests.some(request => request.route === '/expense-import/previews'), false); assert.ok(h.root.textContent.includes('not valid UTF-8'));
  const started = deferred(), released = deferred(), second = await harness(f, t, (route, data) => { if (route === '/expense-import/previews') { started.resolve(data); return released.promise; } });
  walk(second.root).find(node => node.id === 'expense-import-origin').value = body.origin; walk(second.root).find(node => node.id === 'expense-import-file').files = [new File([Buffer.from(csv)], 'fixture.csv')]; fire(walk(second.root).find(node => node.tagName === 'form'), 'submit'); const result = await started.promise; second.ui.reset(); released.resolve(result); await second.settle(); assert.equal(second.root.textContent.includes('Lunch, café'), false); assert.equal(second.root.textContent.includes(sha(csv)), false);
});

test('EIH06: changed source label during selected file reading and detached old review/forget controls cannot issue mutations', async t => {
  const f = await fixture(t), h = await harness(f, t), started = deferred(), released = deferred(), selected = { name: 'fixture.csv', size: Buffer.byteLength(csv), arrayBuffer() { started.resolve(); return released.promise; } };
  const origin = walk(h.root).find(node => node.id === 'expense-import-origin'), picker = walk(h.root).find(node => node.id === 'expense-import-file'); origin.value = body.origin; picker.files = [selected]; fire(walk(h.root).find(node => node.tagName === 'form'), 'submit'); await started.promise;
  origin.value = 'changed-source'; released.resolve(Uint8Array.from(Buffer.from(csv)).buffer); await h.settle(); assert.equal(h.requests.some(request => request.route === '/expense-import/previews'), false);
  await h.preview(new File([Buffer.from(csv)], 'fixture.csv')); const detachedReview = walk(h.root).filter(node => node.tagName === 'form')[1], detachedForget = h.find('Forget this saved CSV preview'); walk(detachedReview).filter(node => node.type === 'checkbox')[0].checked = true;
  const before = h.requests.length; h.ui.reset(); fire(detachedReview, 'submit'); fire(detachedForget); await h.settle(); assert.equal(h.requests.length, before); assert.equal((await f.call('/life/expenses')).data.items.length, 0);
});
