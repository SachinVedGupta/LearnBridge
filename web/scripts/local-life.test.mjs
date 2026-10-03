import test from 'node:test';
import assert from 'node:assert/strict';
import { planMeals, normalizeRecipe, normalizePantry, normalizeRoutine, completeRoutine, nextRoutineDate, localDay,
  parseMoneyCents, normalizeExpense, expenseTotals, prepareTravelChecklist } from '../apps/local-runtime/src/life.mjs';
const now = '2026-10-03T16:00:00.000Z';
const rice = normalizeRecipe({ title: 'Fixture rice', servings: 2, prep_minutes: 20,
  ingredients: [{ name: 'Rice', quantity: '0.2', unit: 'kg', labels_complete: true }] });
const pantry = (quantity, unit = 'g', confirmed = true) => normalizePantry({ name: 'rice', quantity, unit, confirmed }, { now });

test('meal arithmetic scales servings and consolidates exact compatible units without floating point drift', () => {
  const result = planMeals({ meals: [{ recipe_id: 'rice', date: '2026-10-04', servings: 4 }, { recipe_id: 'rice', date: '2026-10-05', servings: 2 }], restrictions: [] },
    { now, recipes: [{ id: 'rice', recipe: rice }], pantry: [{ id: 'stock', pantry: pantry('0.25', 'kg') }] });
  assert.deepEqual(result.grocery, [{ name: 'Rice', normalized_name: 'rice', unit: 'g', required: '600', pantry_counted: '250', quantity: '350', price: 'unknown' }]);
  assert.equal(result.purchasing, 'unsupported'); assert.equal(result.cost.status, 'incomplete_prices_unknown');
});
test('incompatible, unconfirmed or expired stock never becomes a guessed subtraction', () => {
  const result = planMeals({ meals: [{ recipe_id: 'rice', date: '2026-10-04', servings: 2 }], restrictions: [] }, { now,
    recipes: [{ id: 'rice', recipe: rice }], pantry: [{ id: 'volume', pantry: pantry('1', 'l') }, { id: 'unknown', pantry: pantry('200', 'g', false) },
      { id: 'expiry', pantry: { ...pantry('200'), expiry: '2026-10-01' } }] });
  assert.equal(result.grocery[0].quantity, '200'); assert.equal(result.grocery[0].pantry_counted, '0');
  assert.equal(result.questions.length, 3); assert(result.questions.some(q => q.reason === 'incompatible_units_no_weight_volume_conversion'));
  assert.throws(() => normalizePantry({ name: 'rice', quantity: '1e3', unit: 'g', confirmed: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizePantry({ name: 'rice', quantity: '1', unit: 'cups', confirmed: true }), { code: 'INVALID_INPUT' });
});
test('declared prohibited ingredient and incomplete labels block acceptance without a safe badge', () => {
  const blocked = planMeals({ meals: [{ recipe_id: 'rice', date: '2026-10-04', servings: 2 }], restrictions: [' RICE '] }, { now, recipes: [{ id: 'rice', recipe: rice }] });
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blocked[0].reason, 'declared_prohibited_ingredient');
  const unknown = { ...rice, ingredients: [{ ...rice.ingredients[0], labels_complete: false }] };
  const incomplete = planMeals({ meals: [{ recipe_id: 'rice', date: '2026-10-04', servings: 2 }], restrictions: ['peanuts'] }, { now, recipes: [{ id: 'rice', recipe: unknown }] });
  assert.equal(incomplete.state, 'blocked'); assert.match(incomplete.safety, /No allergy/); assert.equal(Object.hasOwn(incomplete, 'verified_safe'), false);
});
test('routines use local calendar dates across DST and missing observations never become failure', () => {
  const routine = normalizeRoutine({ title: 'Student routine', start_date: '2026-10-31', every_days: 1, timezone: 'America/Toronto', create_next_task: true }, { now });
  assert.equal(nextRoutineDate(routine, '2026-11-01'), '2026-11-01'); assert.equal(nextRoutineDate(routine, '2026-11-02'), '2026-11-02');
  assert.equal(localDay('2026-11-02T04:30:00.000Z', 'America/Toronto'), '2026-11-01');
  const completed = completeRoutine(routine, '2026-11-01', { now: '2026-11-02T04:30:00.000Z' });
  assert.deepEqual(completeRoutine(completed, '2026-11-01', { now: '2026-11-02T04:30:00.000Z' }), completed);
  assert.deepEqual(completed.observations.map(o => o.status), ['completed']); assert.equal(completed.notifications, 'off');
  assert.throws(() => completeRoutine(routine, '2026-11-02', { now: '2026-11-02T04:30:00.000Z' }), { code: 'INVALID_INPUT' });
});
test('expense cents arithmetic separates currencies/refunds and excludes unconfirmed observations', () => {
  assert.equal(parseMoneyCents('0.10'), 10); assert.equal(parseMoneyCents('-12.50'), -1250);
  const e = (source_id, amount, currency, confirmed = true) => normalizeExpense({ source_id, date: '2026-10-03', merchant: 'Fixture', category: 'Food', amount_cents: parseMoneyCents(amount), currency, confirmed });
  const totals = expenseTotals([e('a', '0.10', 'CAD'), e('b', '0.20', 'CAD'), e('c', '-0.05', 'CAD'), e('d', '12.50', 'USD'), e('e', '100', 'CAD', false)]);
  assert.deepEqual(totals.totals, [{ currency: 'CAD', cents: 25 }, { currency: 'USD', cents: 1250 }]);
  assert.equal(totals.unconfirmed_excluded, 1); assert.equal(totals.converted, false);
  for (const amount of ['1.001', '1e3', 'NaN', '$1.00']) assert.throws(() => parseMoneyCents(amount), { code: 'INVALID_INPUT' });
});
test('manual travel estimate subtracts explicit minutes/buffer and preserves unknown live service/room mapping', () => {
  const plan = prepareTravelChecklist({ title: 'Fixture class', event_at: '2026-10-03T13:00:00.000Z', timezone: 'America/Toronto',
    trip_minutes: 30, buffer_minutes: 10, source_url: 'https://www.mcmaster.ca/campus', room: 'Unknown room', items: ['Bring notes'] }, { now });
  assert.equal(plan.departure_at, '2026-10-03T12:20:00.000Z'); assert.equal(plan.freshness, 'unknown'); assert.equal(plan.room_mapping, 'unresolved');
  assert.equal(plan.booking, 'unsupported'); assert.equal(plan.geolocation, 'unused'); assert.equal(plan.calendar_writes, 'unsupported');
});
