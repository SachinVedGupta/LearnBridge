import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function stateRoute(auth) {
  const source = readFileSync(new URL('../apps/web/src/app/api/state/[kind]/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  const stubs = {
    'next/server': { NextResponse: { json: (body, options) => ({ body, ...options }) } },
    '@/lib/server/auth': { requireUser: auth, AppError },
    '@/lib/server/access': { sameOrigin: () => null, failure: (error) => ({ status: error.status || 500 }) },
  };
  new Function('require', 'module', 'exports', code)((id) => stubs[id] ?? require(id), module, module.exports);
  return module.exports;
}
for (const method of ['GET', 'PUT']) {
  test(`hosted ${method} still requires verified auth despite local edition claims`, async () => {
    let authCalls = 0;
    let bodyReads = 0;
    const route = stateRoute(async () => { authCalls++; throw Object.assign(new Error('Sign in'), { status: 401 }); });
    const request = {
      nextUrl: new URL('https://learnbridge.example/api/state/tasks?edition=local&local=true'),
      headers: new Headers({ 'X-LearnBridge-Edition': 'local', 'X-Student-ID': 'synthetic' }),
      text: async () => { bodyReads++; return JSON.stringify({ edition: 'local', value: [], revision: 0 }); },
    };
    const result = await route[method](request, { params: Promise.resolve({ kind: 'tasks' }) });
    assert.equal(result.status, 401);
    assert.equal(authCalls, 1);
    assert.equal(bodyReads, 0);
  });
}
test('hosted read selects only the server-verified student rather than a request student ID', async () => {
  const selected = [];
  const db = { from: (table) => {
    assert.equal(table, 'student_state');
    const query = { select: () => query, eq: (field, value) => { selected.push([field, value]); return query; },
      maybeSingle: async () => ({ data: { value: [], revision: 2 }, error: null }) };
    return query;
  } };
  const route = stateRoute(async () => ({ db, user: { id: 'server-verified-alice' } }));
  const result = await route.GET({ headers: new Headers({ 'X-Student-ID': 'bob' }) },
    { params: Promise.resolve({ kind: 'tasks' }) });
  assert.deepEqual(selected, [['user_id', 'server-verified-alice'], ['kind', 'tasks']]);
  assert.equal(result.body.revision, 2);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
});
