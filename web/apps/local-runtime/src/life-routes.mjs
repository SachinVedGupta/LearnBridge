import { HttpError } from './policy.mjs';
import { createLifeWorkspace } from './life-service.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const methodError = () => { throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This life-planning operation is unavailable.'); };
/** Root authenticates and rejects query parameters before calling this router. */
export async function handleLifeRoute({ route, method, privateBody, store, idempotencyKey, service }) {
  if (!route.startsWith('/life/')) return null; const life = service ?? createLifeWorkspace(store);
  if (route === '/life/expenses/totals') { if (method !== 'GET') methodError(); return { status: 200, data: life.totals() }; }
  const definitions = {
    '/life/pantry': ['listPantry', 'createPantry', ['name', 'quantity', 'unit', 'confirmed', 'expiry'], ['name', 'quantity', 'unit', 'confirmed']],
    '/life/recipes': ['listRecipes', 'createRecipe', ['title', 'servings', 'ingredients', 'prep_minutes', 'source_url'], ['title', 'servings', 'ingredients', 'prep_minutes']],
    '/life/meals': ['listMealPlans', 'prepareMeals', ['meals', 'restrictions', 'max_prep_minutes'], ['meals', 'restrictions']],
    '/life/routines': ['listRoutines', 'createRoutine', ['title', 'start_date', 'every_days', 'timezone', 'create_next_task'], ['title', 'start_date', 'every_days', 'timezone', 'create_next_task']],
    '/life/expenses': ['listExpenses', 'createExpense', ['source_id', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed'], ['source_id', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed']],
    '/life/travel': ['listTravel', 'prepareTravel', ['title', 'event_at', 'timezone', 'trip_minutes', 'buffer_minutes', 'source_url', 'source_checked_at', 'room', 'items'], ['title', 'event_at', 'timezone', 'trip_minutes', 'buffer_minutes', 'source_url', 'items']],
  };
  const definition = definitions[route];
  if (definition) {
    if (method === 'GET') return { status: 200, data: { items: life[definition[0]]() } };
    if (method !== 'POST') methodError(); const body = await privateBody(definition[2], definition[3], 64000);
    return { status: 201, data: { item: life[definition[1]](body, { idempotencyKey }) } };
  }
  const match = /^\/life\/(pantry|meals|routines|expenses)\/([^/]+)(\/accept|\/complete)?$/.exec(route);
  if (match) {
    if (!uuid.test(match[2])) throw new HttpError(404, 'NOT_FOUND', 'Life-planning item not found.');
    if (method !== 'POST') methodError();
    const def = match[1] === 'pantry' && !match[3] ? ['updatePantry', ['expected_revision', 'quantity', 'unit', 'confirmed', 'expiry'], ['expected_revision', 'quantity', 'unit', 'confirmed']]
      : match[1] === 'meals' && match[3] === '/accept' ? ['acceptMeals', ['expected_revision', 'plan_hash'], ['expected_revision', 'plan_hash']]
        : match[1] === 'routines' && match[3] === '/complete' ? ['completeRoutine', ['expected_revision', 'date'], ['expected_revision', 'date']]
          : match[1] === 'expenses' && !match[3] ? ['updateExpense', ['expected_revision', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed'], ['expected_revision']] : null;
    if (!def) throw new HttpError(404, 'NOT_FOUND', 'Life-planning operation not found.');
    const body = await privateBody(def[1], def[2], 16000); return { status: 200, data: { item: life[def[0]](match[2], body) } };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Life-planning operation not found.');
}
