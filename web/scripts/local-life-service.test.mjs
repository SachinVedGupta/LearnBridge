import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createLifeWorkspace } from '../apps/local-runtime/src/life-service.mjs';
import { handleLifeRoute } from '../apps/local-runtime/src/life-routes.mjs';
const now = '2026-10-03T16:00:00.000Z';
function fixture(t) { const base = mkdtempSync(join(tmpdir(), 'learnbridge-life-service-')), root = join(base, 'private'), store = LocalStore.open({ root, timezone: 'America/Toronto' });
  t.after(() => { try { store.close(); } catch {} rmSync(base, { recursive: true, force: true }); }); return { base, root, store, service: createLifeWorkspace(store, { clock: () => now }) }; }
const stock = { name: 'Rice', quantity: '100', unit: 'g', confirmed: true };
const recipe = { title: 'Rice bowl', servings: 2, prep_minutes: 20, ingredients: [{ name: 'rice', quantity: '200', unit: 'g', labels_complete: true }] };
const routine = { title: 'Review lecture notes', start_date: '2026-10-03', every_days: 1, timezone: 'America/Toronto', create_next_task: true };

test('meal/grocery exact acceptance persists through backup/fresh restore and creates zero purchases/tasks', async t => {
  const { base, store, service } = fixture(t); service.createPantry(stock, { idempotencyKey: 'life-stock-0001' });
  const savedRecipe = service.createRecipe(recipe, { idempotencyKey: 'life-recipe-0001' });
  const input = { meals: [{ recipe_id: savedRecipe.id, servings: 4, date: '2026-10-04' }], restrictions: [] };
  const saved = service.prepareMeals(input, { idempotencyKey: 'life-plan-0001' }), latest = service.listMealPlans()[0];
  assert.equal(saved.data.plan.grocery[0].quantity, '300');
  const review = { expected_revision: latest.revision, plan_hash: latest.plan_hash };
  const accepted = service.acceptMeals(saved.id, review); assert.equal(accepted.data.state, 'accepted');
  assert.deepEqual(service.acceptMeals(saved.id, review), accepted); assert.equal(store.listTasks().length, 0);
  await store.backup(join(base, 'backup')); store.close(); await LocalStore.restore({ backupRoot: join(base, 'backup'), root: join(base, 'restored') });
  const restored = LocalStore.open({ root: join(base, 'restored') }); try { const actual = createLifeWorkspace(restored, { clock: () => now }).listMealPlans()[0];
    assert.equal(actual.data.state, 'accepted'); assert.deepEqual(actual.data.plan.grocery, accepted.data.plan.grocery); assert.equal(restored.integrity().integrity, 'ok'); } finally { restored.close(); }
});
test('pantry changes/new stock invalidate meal preview; prohibited ingredient cannot be accepted', t => {
  const { service } = fixture(t); const item = service.createPantry(stock, { idempotencyKey: 'life-stock-0001' }), savedRecipe = service.createRecipe(recipe, { idempotencyKey: 'life-recipe-0001' });
  const body = { meals: [{ recipe_id: savedRecipe.id, servings: 4, date: '2026-10-04' }], restrictions: [] };
  const first = service.prepareMeals(body, { idempotencyKey: 'life-plan-0001' }); let view = service.listMealPlans()[0];
  service.updatePantry(item.id, { expected_revision: 1, quantity: '150', unit: 'g', confirmed: true });
  assert.throws(() => service.acceptMeals(first.id, { expected_revision: 1, plan_hash: view.plan_hash }), { code: 'REVISION_CONFLICT' });
  const second = service.prepareMeals(body, { idempotencyKey: 'life-plan-0002' }); view = service.listMealPlans().find(r => r.id === second.id);
  service.createPantry({ name: 'Beans', quantity: '1', unit: 'count', confirmed: true }, { idempotencyKey: 'life-stock-0002' });
  assert.throws(() => service.acceptMeals(second.id, { expected_revision: 1, plan_hash: view.plan_hash }), { code: 'REVISION_CONFLICT' });
  const blocked = service.prepareMeals({ ...body, restrictions: ['rice'] }, { idempotencyKey: 'life-plan-blocked' }), blockedView = service.listMealPlans().find(r => r.id === blocked.id);
  assert.throws(() => service.acceptMeals(blocked.id, { expected_revision: 1, plan_hash: blockedView.plan_hash }), { code: 'CONSENT_REQUIRED' });
});
test('routine completion creates one next dated task, preserves unrelated edited task data and retries once', t => {
  const { store, service } = fixture(t); const initial = service.createRoutine(routine, { idempotencyKey: 'life-routine-0001' }); assert.equal(store.listTasks().length, 1);
  const previous = store.getTask(initial.data.next_task.id); store.updateTask(previous.id, { title: 'Student changed this task' }, previous.revision);
  const completed = service.completeRoutine(initial.id, { expected_revision: initial.revision, date: '2026-10-03' });
  assert.equal(completed.data.routine.observations.length, 1); assert.equal(completed.data.next_date, '2026-10-04'); assert.equal(store.listTasks().length, 2);
  assert.equal(store.getTask(previous.id).title, 'Student changed this task'); assert.match(completed.data.task_completion_notice, /preserved/);
  assert.deepEqual(service.completeRoutine(initial.id, { expected_revision: initial.revision, date: '2026-10-03' }), completed); assert.equal(store.listTasks().length, 2);
});
test('crash after next task write is recoverable after restart without duplicate task or invented completion', t => {
  const { root, store } = fixture(t); let crash = true;
  const interruptedStore = new Proxy(store, { get(target, key) { const value = target[key]; if (key === 'createTask') return (...args) => { const result = value.apply(target, args); if (crash) { crash = false; throw new Error('fixture interruption after durable task write'); } return result; }; return typeof value === 'function' ? value.bind(target) : value; } });
  const body = routine, options = { idempotencyKey: 'life-routine-crash' }, service = createLifeWorkspace(interruptedStore, { clock: () => now });
  assert.throws(() => service.createRoutine(body, options), /fixture interruption/); assert.equal(store.listTasks().length, 1); store.close();
  const reopened = LocalStore.open({ root }); try { const recovered = createLifeWorkspace(reopened, { clock: () => now }).createRoutine(body, options);
    assert.equal(recovered.data.pending_transition, null); assert.equal(recovered.data.routine.observations.length, 0); assert.equal(reopened.listTasks().length, 1); assert.equal(reopened.integrity().integrity, 'ok'); } finally { reopened.close(); }
});
test('expense source dedup/CAS keeps legitimate similar purchases and distinct currencies/refunds', t => {
  const { service } = fixture(t); const expense = { source_id: 'receipt-a', date: '2026-10-03', merchant: 'Fixture merchant', category: 'Food', amount_cents: 1250, currency: 'CAD', confirmed: true };
  const a = service.createExpense(expense, { idempotencyKey: 'life-expense-0001' }); assert.equal(service.createExpense(expense, { idempotencyKey: 'life-expense-0001' }).id, a.id);
  assert.throws(() => service.createExpense(expense, { idempotencyKey: 'life-expense-duplicate' }), { code: 'REVISION_CONFLICT' });
  service.createExpense({ ...expense, source_id: 'receipt-b' }, { idempotencyKey: 'life-expense-0002' });
  service.createExpense({ ...expense, source_id: 'refund', amount_cents: -500 }, { idempotencyKey: 'life-expense-refund' });
  service.createExpense({ ...expense, source_id: 'usd', currency: 'USD' }, { idempotencyKey: 'life-expense-usd' });
  const updated = service.updateExpense(a.id, { expected_revision: 1, amount_cents: 1000 }); assert.equal(updated.revision, 2);
  assert.throws(() => service.updateExpense(a.id, { expected_revision: 1, amount_cents: 500 }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(service.totals().totals.sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'CAD', cents: 1750 }, { currency: 'USD', cents: 1250 }]);
});
test('life routes bound exact schemas and never expose purchase/payment/calendar commands; UI uses text DOM', async t => {
  const { store, service } = fixture(t); let bodyReads = 0;
  const result = await handleLifeRoute({ route: '/life/pantry', method: 'POST', store, service, idempotencyKey: 'life-route-stock', privateBody: async (allowed, required, maxBytes) => {
    bodyReads++; assert(maxBytes <= 64000); assert(Object.keys(stock).every(key => allowed.includes(key))); assert(required.every(key => Object.hasOwn(stock, key))); return stock; } }); assert.equal(result.status, 201);
  for (const route of ['/life/purchase', '/life/payment', '/life/calendar']) await assert.rejects(handleLifeRoute({ route, method: 'POST', store, service, privateBody: async () => { bodyReads++; } }), error => error.status === 404);
  assert.equal(bodyReads, 1);
  const ui = readFileSync(new URL('../apps/local/public/life.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|localStorage|sessionStorage|\.style\.|fetch\(/);
  assert.match(ui, /generation !== state\.generation/); assert.match(ui, /state\.generation\+\+/); assert.match(ui, /caption\.htmlFor = input\.id/);
  assert.match(ui, /input\.defaultValue = value/); assert.match(ui, /input\.defaultChecked = false/);
});
