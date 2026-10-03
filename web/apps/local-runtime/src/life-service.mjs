import { LearnBridgeError } from '@learnbridge/core';
import { lifeObject, lifeHash, lifeText, localDay, normalizePantry, normalizeRecipe, planMeals, normalizeRoutine,
  nextRoutineDate, completeRoutine, normalizeExpense, expenseTotals, prepareTravelChecklist } from './life.mjs';
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const kinds = ['pantry_item', 'meal_plan', 'routine', 'expense', 'administration_item'];

export function createLifeWorkspace(store, { clock = () => new Date().toISOString() } = {}) {
  const list = (kind, category) => store.listWorkspaceRecords({ kind }).filter(record => record.data.category === category);
  function get(id, kind, category) {
    const record = store.getWorkspaceRecord(id); if (!record || record.kind !== kind || record.data.category !== category) fail('SCOPE_DENIED'); return record;
  }
  function create(kind, category, input, key, build) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail();
    const request_hash = lifeHash({ category, input });
    const existing = kinds.flatMap(kind => store.listWorkspaceRecords({ kind })).find(r => r.data.creation_operation?.key === key);
    if (existing) { if (existing.data.creation_operation.request_hash !== request_hash || existing.data.category !== category) fail('REVISION_CONFLICT'); return existing; }
    const value = build();
    return store.createWorkspaceRecord({ kind, title: value.title.slice(0, 480), data: { category, ...value.data, creation_operation: { key, request_hash } } },
      { idempotencyKey: `life-${key}` });
  }
  const update = (record, input, data) => store.updateWorkspaceRecord(record.id, { expected_revision: input.expected_revision, data: { ...record.data, ...data } });
  const pin = record => ({ kind: record.kind, id: record.id, revision: record.revision, hash: lifeHash(record.data) });
  function currentPins(pins) { return pins.every(p => { const record = store.getWorkspaceRecord(p.id); return record && record.revision === p.revision && lifeHash(record.data) === p.hash; }); }
  function currentMealPins(record) {
    const pantryIds = record.data.source_pins.filter(pin => pin.kind === 'pantry_item').map(pin => pin.id).sort();
    return currentPins(record.data.source_pins) && JSON.stringify(pantryIds) === JSON.stringify(list('pantry_item', 'pantry').map(record => record.id).sort());
  }
  function finishRoutine(record) {
    const transition = record.data.pending_transition; if (!transition) return record;
    let task_completion_notice = null;
    if (transition.previous_task) {
      const task = store.getTask(transition.previous_task.id);
      if (task && task.revision === transition.previous_task.revision && task.status !== 'completed') store.updateTask(task.id, { status: 'completed' }, task.revision);
      else if (!task || task.status !== 'completed') task_completion_notice = 'The previous local task changed or was removed; review it separately. Its data was preserved.';
    }
    const routine = record.data.routine;
    const task = routine.create_next_task ? store.createTask({ title: routine.title, deadline: { precision: 'date', date: transition.next_date, timezone: routine.timezone } },
      { idempotencyKey: `routine-${record.id}-${transition.next_date}` }) : null;
    return store.updateWorkspaceRecord(record.id, { expected_revision: record.revision, data: { ...record.data,
      next_date: transition.next_date, next_task: task ? { id: task.id, revision: task.revision } : null, pending_transition: null, task_completion_notice } });
  }
  return {
    listPantry: () => list('pantry_item', 'pantry'),
    createPantry(input, { idempotencyKey } = {}) { return create('pantry_item', 'pantry', input, idempotencyKey, () => {
      const pantry = normalizePantry(input, { now: clock() }); return { title: pantry.name, data: { pantry } };
    }); },
    updatePantry(id, input) {
      lifeObject(input, ['expected_revision', 'quantity', 'unit', 'confirmed', 'expiry'], ['expected_revision', 'quantity', 'unit', 'confirmed']);
      const record = get(id, 'pantry_item', 'pantry');
      const pantry = normalizePantry({ name: record.data.pantry.name, quantity: input.quantity, unit: input.unit, confirmed: input.confirmed,
        expiry: Object.hasOwn(input, 'expiry') ? input.expiry : record.data.pantry.expiry }, { now: clock() }); return update(record, input, { pantry });
    },
    listRecipes: () => list('meal_plan', 'recipe'),
    createRecipe(input, { idempotencyKey } = {}) { return create('meal_plan', 'recipe', input, idempotencyKey, () => {
      const recipe = normalizeRecipe(input); return { title: recipe.title, data: { recipe } };
    }); },
    listMealPlans: () => list('meal_plan', 'meal_plan').map(record => ({ ...record, plan_hash: lifeHash(record.data.plan), needs_refresh: !currentMealPins(record) })),
    prepareMeals(input, { idempotencyKey } = {}) {
      return create('meal_plan', 'meal_plan', input, idempotencyKey, () => {
        const pantry = list('pantry_item', 'pantry'), recipes = list('meal_plan', 'recipe');
        const plan = planMeals(input, { now: clock(), timezone: store.identity.timezone,
          pantry: pantry.map(record => ({ id: record.id, pantry: record.data.pantry })), recipes: recipes.map(record => ({ id: record.id, recipe: record.data.recipe })) });
        const selectedRecipes = recipes.filter(record => plan.meals.some(meal => meal.recipe_id === record.id));
        return { title: 'Meal and grocery plan', data: { plan, source_pins: [...pantry, ...selectedRecipes].map(pin), state: plan.state, acceptance: null } };
      });
    },
    acceptMeals(id, input) {
      lifeObject(input, ['expected_revision', 'plan_hash'], ['expected_revision', 'plan_hash']);
      const record = get(id, 'meal_plan', 'meal_plan'); if (input.plan_hash !== lifeHash(record.data.plan)) fail('REVISION_CONFLICT');
      if (record.data.acceptance && [record.revision, record.revision - 1].includes(input.expected_revision)) return record;
      if (record.data.plan.state === 'blocked') fail('CONSENT_REQUIRED');
      if (!currentMealPins(record)) fail('REVISION_CONFLICT');
      return update(record, input, { state: 'accepted', acceptance: { reviewer: store.identity.student_id, reviewed_at: clock(), plan_hash: input.plan_hash } });
    },
    listRoutines: () => list('routine', 'routine').map(record => ({ ...record, today: localDay(clock(), record.data.routine.timezone), observation_policy: 'Missing days are unrecorded, never inferred failures.' })),
    createRoutine(input, { idempotencyKey } = {}) {
      const record = create('routine', 'routine', input, idempotencyKey, () => {
        const routine = normalizeRoutine(input, { now: clock() }), next_date = nextRoutineDate(routine, localDay(clock(), routine.timezone));
        return { title: routine.title, data: { routine, next_date, next_task: null,
          pending_transition: { kind: 'initial', next_date, previous_task: null, original_revision: 1 } } };
      });
      return finishRoutine(record);
    },
    completeRoutine(id, input) {
      lifeObject(input, ['expected_revision', 'date'], ['expected_revision', 'date']);
      let record = get(id, 'routine', 'routine');
      if (record.data.pending_transition) {
        if (record.data.pending_transition.original_revision !== input.expected_revision
          || (record.data.pending_transition.kind === 'completion' && record.data.pending_transition.date !== input.date)) fail('REVISION_CONFLICT');
        return finishRoutine(record);
      }
      if (record.data.routine.observations.some(item => item.date === input.date)) return record;
      if (record.revision !== input.expected_revision || record.data.next_date !== input.date) fail('REVISION_CONFLICT');
      const routine = completeRoutine(record.data.routine, input.date, { now: clock() });
      const from = new Date(Date.parse(`${input.date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10), next_date = nextRoutineDate(routine, from);
      record = update(record, input, { routine, pending_transition: { kind: 'completion', date: input.date, next_date,
        previous_task: record.data.next_task, original_revision: input.expected_revision } });
      return finishRoutine(record);
    },
    listExpenses: () => list('expense', 'expense'),
    totals: () => expenseTotals(list('expense', 'expense').map(record => record.data.expense)),
    createExpense(input, { idempotencyKey } = {}) {
      return create('expense', 'expense', input, idempotencyKey, () => {
        const expense = normalizeExpense(input);
        if (list('expense', 'expense').some(record => record.data.expense.source_id === expense.source_id)) fail('REVISION_CONFLICT');
        return { title: `${expense.merchant}: ${expense.currency}`, data: { expense } };
      });
    },
    updateExpense(id, input) {
      lifeObject(input, ['expected_revision', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed'], ['expected_revision']);
      const record = get(id, 'expense', 'expense'), { expected_revision, ...changes } = input;
      const expense = normalizeExpense({ source_id: record.data.expense.source_id, date: record.data.expense.date, merchant: record.data.expense.merchant,
        category: record.data.expense.category, amount_cents: record.data.expense.amount_cents, currency: record.data.expense.currency,
        confirmed: record.data.expense.confirmed, ...changes }); return update(record, { expected_revision }, { expense });
    },
    listTravel: () => list('administration_item', 'travel'),
    prepareTravel(input, { idempotencyKey } = {}) { return create('administration_item', 'travel', input, idempotencyKey, () => {
      const travel = prepareTravelChecklist(input, { now: clock() }); return { title: travel.title, data: { travel } };
    }); },
  };
}
