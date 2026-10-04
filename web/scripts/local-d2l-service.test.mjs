import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createStudentWorkspace } from '../apps/local-runtime/src/student-workspace.mjs';
import { createD2lService } from '../apps/local-runtime/src/d2l-service.mjs';
import { createD2lRoutes } from '../apps/local-runtime/src/d2l-routes.mjs';
import { cloneD2lData } from '../apps/local-runtime/src/d2l-browser.mjs';
import { syntheticSchool } from './fixtures/d2l-test-support.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-d2l-service-')); const store = LocalStore.open({ root: join(parent, 'workspace') });
  const school = syntheticSchool(join(parent, 'control.json')); const studentWorkspace = createStudentWorkspace(store); let now = Date.now();
  const options = { studentWorkspace, browserFactory: () => school.factory(), clock: () => now };
  const service = createD2lService(options), routes = createD2lRoutes(options);
  t.after(async () => { await service.close(); await routes.clear(); school.assertClosed(assert); store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { store, school, service, routes, advance: ms => { now += ms; } };
}
async function connect(f) { const opened = await f.service.start({ institution_id: 'mcmaster-avenue' }); const id = opened.connection.id; await f.service.verify({ connection_id: id }); return id; }
const selection = id => ({ connection_id: id, selected_course_ids: ['781264'], categories: ['materials'] });
const denied = (action, code) => assert.rejects(action, error => error.code === code);

test('D2LS01: strict JSON clone rejects executable, inherited, sparse, cyclic, oversized and ambiguous data without evaluating accessors', async t => {
  const f = fixture(t); let accessorCalls = 0; const getter = { get institution_id() { accessorCalls++; return 'mcmaster-avenue'; } };
  await denied(f.service.start(getter), 'INVALID_INPUT'); assert.equal(accessorCalls, 0); assert.equal(f.school.launches.length, 0);
  const bad = [Object.create({ institution_id: 'mcmaster-avenue' }), { institution_id: 'mcmaster-avenue', token: 'PRIVATE_TOKEN_CANARY' }];
  for (const value of bad) await denied(f.service.start(value), 'INVALID_INPUT');
  const sparse = Array(1), cycle = {}; cycle.self = cycle;
  for (const value of [sparse, cycle, { nested: new Date() }, { nested: () => {} }, { nested: undefined }]) assert.throws(() => cloneD2lData(value), error => error.code === 'INVALID_INPUT');
  assert.throws(() => cloneD2lData({ x: 'x'.repeat(4097) }, 4096), error => error.code === 'BUDGET_EXCEEDED');
  assert.equal(f.store.listWorkspaceRecords().length, 0);
});

test('D2LS02: supported versions are institution-observed and sorted numerically; obsolete or mismatched course responses cannot gain live access', async t => {
  const f = fixture(t); f.school.change({ versions: [{ ProductCode: 'lp', LatestVersion: '1.100', SupportedVersions: ['1.99','1.100','1.49'] }, { ProductCode: 'le', LatestVersion: '1.90', SupportedVersions: ['1.9','1.90'] }] });
  const id = await connect(f); assert.ok(f.school.reads.includes('/d2l/api/lp/1.100/users/whoami')); const preview = await f.service.preview(selection(id)); assert.equal(preview.proof, 'fixture');
  assert.ok(f.school.reads.includes('/d2l/api/le/1.90/781264/content/toc')); assert.equal(f.store.listWorkspaceRecords().length, 0);
  f.school.change({ wrongCourse: true }); await denied(f.service.preview(selection(id)), 'SCOPE_DENIED'); assert.equal(f.store.listWorkspaceRecords().length, 0);
  await f.service.disconnect({ connection_id: id }); f.school.change({ versions: [{ ProductCode: 'lp', LatestVersion: '1.43', SupportedVersions: ['1.43'] }, { ProductCode: 'le', LatestVersion: '1.57', SupportedVersions: ['1.57'] }] });
  const next = await f.service.start({ institution_id: 'mcmaster-avenue' }); await denied(f.service.verify({ connection_id: next.connection.id }), 'UNSUPPORTED'); assert.equal(f.service.status().connection.proof, 'none');
});

test('D2LS03: exact route preview expires after five minutes; clear/disconnect erase ownership and retained reviews without saving records', async t => {
  const f = fixture(t); const session = { nonce: 'synthetic-owner-nonce' };
  const call = (route, body) => f.routes.handle({ route, method: body === undefined ? 'GET' : 'POST', session, privateBody: async () => body });
  const opened = await call('/d2l/start', { institution_id: 'mcmaster-avenue' }); const id = opened.data.connection.id;
  await call('/d2l/verify', { connection_id: id }); assert.equal(f.routes.capability().state, 'connected'); assert.equal(f.routes.capability().proof, 'none'); assert.equal(JSON.stringify(f.routes.capability()).includes('Synthetic Student'), false);
  const reviewed = await call('/d2l/preview', selection(id)); assert.equal(f.routes.capability().proof, 'fixture');
  f.advance(300000); await denied(call('/d2l/import', { preview_id: reviewed.data.preview_id, review_hash: reviewed.data.refresh.review_hash }), 'CONSENT_REQUIRED');
  const fresh = await call('/d2l/preview', selection(id)); await f.routes.clear();
  await denied(call('/d2l/import', { preview_id: fresh.data.preview_id, review_hash: fresh.data.refresh.review_hash }), 'CONSENT_REQUIRED'); assert.equal(f.routes.capability().state, 'requires_auth'); assert.equal(f.routes.capability().proof, 'none');
  assert.equal(f.store.listWorkspaceRecords().length, 0); f.school.assertClosed(assert);
});

test('D2LS04: clear while official browser launch is awaiting its private pipe cancels start and permits no late session owner', async t => {
  const f = fixture(t); f.school.change({ slowStart: true }); const session = { nonce: 'old-owner' }, next = { nonce: 'new-owner' };
  const call = (route, body, owner = session) => f.routes.handle({ route, method: body === undefined ? 'GET' : 'POST', session: owner, privateBody: async () => body });
  const pending = call('/d2l/start', { institution_id: 'mcmaster-avenue' }); await f.school.waitCommand(commands => commands.some(value => value.method === 'Target.createTarget'));
  await f.routes.clear(); await denied(pending, 'CANCELLED'); f.school.assertClosed(assert); assert.equal((await call('/d2l/status', undefined, next)).data.connection, null);
  f.school.change({ slowStart: false }); assert.equal((await call('/d2l/start', { institution_id: 'mcmaster-avenue' }, next)).status, 201); assert.equal(f.store.listWorkspaceRecords().length, 0);
});
