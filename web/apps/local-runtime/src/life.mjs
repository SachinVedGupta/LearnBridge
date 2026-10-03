import { createHash } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { canonicalCareerURL } from './career.mjs';
const fail = (code = 'INVALID_INPUT') => { throw new LearnBridgeError(code); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
export const lifeHash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function lifeObject(input, allowed, required = []) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(input, key))) fail();
}
export function lifeText(input, max = 500) {
  if (typeof input !== 'string' || !input.trim() || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) fail();
  return input.trim();
}
export function lifeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail();
  return value;
}
export function lifeStamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) fail(); return value;
}
export function lifeTimezone(value) { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date()); } catch { fail(); } return lifeText(value, 100); }
export function localDay(now, timezone) {
  lifeStamp(now); lifeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = type => parts.find(p => p.type === type).value; return `${get('year')}-${get('month')}-${get('day')}`;
}
const name = value => lifeText(value, 200).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const units = { g: ['weight', 1n], kg: ['weight', 1000n], ml: ['volume', 1n], l: ['volume', 1000n], count: ['count', 1n] };
const baseUnits = { weight: 'g', volume: 'ml', count: 'count' };
function quantity(value, unit, allowZero = false) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,6})?$/.test(value) || !Object.hasOwn(units, unit)) fail();
  const [whole, decimal = ''] = value.split('.'), micro = (BigInt(whole) * 1000000n + BigInt(decimal.padEnd(6, '0'))) * units[unit][1];
  if (micro < 0n || (!allowZero && micro === 0n)) fail(); return { dimension: units[unit][0], micro };
}
function display(micro) { const whole = micro / 1000000n, fraction = (micro % 1000000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${whole}${fraction ? `.${fraction}` : ''}`; }
const ceil = (top, bottom) => (top + bottom - 1n) / bottom;
export function normalizePantry(input, { now = new Date().toISOString() } = {}) {
  lifeObject(input, ['name', 'quantity', 'unit', 'confirmed', 'expiry'], ['name', 'quantity', 'unit', 'confirmed']);
  quantity(input.quantity, input.unit, true); if (typeof input.confirmed !== 'boolean') fail();
  return { schema_version: 1, name: lifeText(input.name, 200), normalized_name: name(input.name), quantity: input.quantity,
    unit: input.unit, confirmed: input.confirmed, expiry: input.expiry == null ? null : lifeDate(input.expiry), confirmed_at: input.confirmed ? lifeStamp(now) : null };
}
export function normalizeRecipe(input) {
  lifeObject(input, ['title', 'servings', 'ingredients', 'prep_minutes', 'source_url'], ['title', 'servings', 'ingredients', 'prep_minutes']);
  if (!Number.isSafeInteger(input.servings) || input.servings < 1 || input.servings > 100 || !Number.isSafeInteger(input.prep_minutes)
    || input.prep_minutes < 1 || input.prep_minutes > 1440 || !Array.isArray(input.ingredients) || !input.ingredients.length || input.ingredients.length > 100) fail();
  const ingredients = input.ingredients.map(item => {
    lifeObject(item, ['name', 'quantity', 'unit', 'labels_complete'], ['name', 'quantity', 'unit', 'labels_complete']);
    quantity(item.quantity, item.unit); if (typeof item.labels_complete !== 'boolean') fail();
    return { name: lifeText(item.name, 200), normalized_name: name(item.name), quantity: item.quantity, unit: item.unit, labels_complete: item.labels_complete };
  });
  return { schema_version: 1, title: lifeText(input.title, 300), servings: input.servings, prep_minutes: input.prep_minutes, ingredients,
    source_url: input.source_url == null ? null : canonicalCareerURL(input.source_url), source_verification: 'student_entered' };
}
export function planMeals(input, { pantry = [], recipes = [], now = new Date().toISOString(), timezone = 'UTC' } = {}) {
  lifeObject(input, ['meals', 'restrictions', 'max_prep_minutes'], ['meals', 'restrictions']); lifeStamp(now);
  if (!Array.isArray(input.meals) || !input.meals.length || input.meals.length > 50 || !Array.isArray(input.restrictions)
    || input.restrictions.length > 50 || !Array.isArray(pantry) || pantry.length > 500 || !Array.isArray(recipes) || recipes.length > 500) fail();
  const restrictions = [...new Set(input.restrictions.map(name))];
  const max = input.max_prep_minutes ?? 1440; if (!Number.isSafeInteger(max) || max < 1 || max > 1440) fail();
  const totals = new Map(), questions = [], blocked = [], meals = [];
  for (const meal of input.meals) {
    lifeObject(meal, ['recipe_id', 'servings', 'date'], ['recipe_id', 'servings', 'date']); lifeDate(meal.date);
    if (!Number.isSafeInteger(meal.servings) || meal.servings < 1 || meal.servings > 100) fail();
    const saved = recipes.find(record => record.id === meal.recipe_id); if (!saved) fail('SCOPE_DENIED');
    const savedRecipe = saved.recipe;
    const recipe = normalizeRecipe({ title: savedRecipe.title, servings: savedRecipe.servings, prep_minutes: savedRecipe.prep_minutes,
      source_url: savedRecipe.source_url, ingredients: savedRecipe.ingredients.map(item => ({ name: item.name, quantity: item.quantity, unit: item.unit, labels_complete: item.labels_complete })) });
    if (recipe.prep_minutes > max) blocked.push({ recipe_id: saved.id, reason: 'exceeds_selected_preparation_time' });
    meals.push({ ...meal, title: recipe.title, prep_minutes: recipe.prep_minutes });
    for (const ingredient of recipe.ingredients) {
      if (restrictions.includes(ingredient.normalized_name)) blocked.push({ recipe_id: saved.id, ingredient: ingredient.name, reason: 'declared_prohibited_ingredient' });
      if (!ingredient.labels_complete) questions.push({ recipe_id: saved.id, ingredient: ingredient.name, reason: 'ingredient_labels_not_reviewed' });
      const q = quantity(ingredient.quantity, ingredient.unit), key = `${ingredient.normalized_name}:${q.dimension}`;
      if (!totals.has(key)) totals.set(key, { name: ingredient.name, normalized_name: ingredient.normalized_name, dimension: q.dimension, required: 0n });
      totals.get(key).required += ceil(q.micro * BigInt(meal.servings), BigInt(recipe.servings));
    }
  }
  const stock = new Map();
  for (const record of pantry) {
    const p = record.pantry;
    const item = normalizePantry({ name: p.name, quantity: p.quantity, unit: p.unit, confirmed: p.confirmed, expiry: p.expiry }, { now });
    if (!item.confirmed || (item.expiry && item.expiry < localDay(now, timezone))) {
      questions.push({ pantry_id: record.id, ingredient: item.name, reason: item.confirmed ? 'recorded_expiry_not_counted_check_stock' : 'unconfirmed_stock_not_counted' }); continue;
    }
    const q = quantity(item.quantity, item.unit, true), key = `${item.normalized_name}:${q.dimension}`;
    stock.set(key, (stock.get(key) ?? 0n) + q.micro);
    for (const required of totals.values()) if (required.normalized_name === item.normalized_name && required.dimension !== q.dimension) {
      questions.push({ pantry_id: record.id, ingredient: item.name, reason: 'incompatible_units_no_weight_volume_conversion' });
    }
  }
  const grocery = [...totals.entries()].map(([key, item]) => {
    const available = stock.get(key) ?? 0n, deficit = item.required > available ? item.required - available : 0n;
    return { name: item.name, normalized_name: item.normalized_name, unit: baseUnits[item.dimension], required: display(item.required),
      pantry_counted: display(available > item.required ? item.required : available), quantity: display(deficit), price: 'unknown' };
  }).filter(item => item.quantity !== '0');
  if (restrictions.length && questions.some(q => q.reason === 'ingredient_labels_not_reviewed')) blocked.push({ reason: 'restriction_check_incomplete' });
  return { schema_version: 1, meals, restrictions, grocery, questions, blocked, state: blocked.length ? 'blocked' : 'proposal',
    prepared_at: now, timezone, safety: 'No allergy, expiry or nutritional safety guarantee. Review ingredient labels and recorded quantities yourself.',
    cost: { status: grocery.length ? 'incomplete_prices_unknown' : 'no_grocery_deficit', totals_by_currency: [] }, purchasing: 'unsupported' };
}

export function normalizeRoutine(input, { now = new Date().toISOString() } = {}) {
  lifeObject(input, ['title', 'start_date', 'every_days', 'timezone', 'create_next_task'], ['title', 'start_date', 'every_days', 'timezone', 'create_next_task']);
  lifeStamp(now); if (!Number.isSafeInteger(input.every_days) || input.every_days < 1 || input.every_days > 365 || typeof input.create_next_task !== 'boolean') fail();
  return { schema_version: 1, title: lifeText(input.title, 300), start_date: lifeDate(input.start_date), every_days: input.every_days,
    timezone: lifeTimezone(input.timezone), create_next_task: input.create_next_task, observations: [], notifications: 'off', created_at: now };
}
export function nextRoutineDate(routine, from) {
  lifeDate(from); const start = Date.parse(`${routine.start_date}T00:00:00.000Z`), target = Date.parse(`${from}T00:00:00.000Z`);
  const periods = Math.max(0, Math.ceil((target - start) / (86400000 * routine.every_days)));
  return lifeDate(new Date(start + periods * routine.every_days * 86400000).toISOString().slice(0, 10));
}
export function completeRoutine(routine, date, { now = new Date().toISOString() } = {}) {
  lifeDate(date); lifeStamp(now);
  if (date > localDay(now, routine.timezone) || nextRoutineDate(routine, date) !== date || routine.observations.length >= 1000) fail();
  if (routine.observations.some(item => item.date === date)) return structuredClone(routine);
  return { ...structuredClone(routine), observations: [...routine.observations, { date, status: 'completed', source: 'student_reported', recorded_at: now }] };
}

export function parseMoneyCents(value) {
  if (typeof value !== 'string' || !/^-?\d{1,7}(?:\.\d{1,2})?$/.test(value)) fail();
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0')); return negative ? -cents : cents;
}
export function normalizeExpense(input) {
  lifeObject(input, ['source_id', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed'], ['source_id', 'date', 'merchant', 'category', 'amount_cents', 'currency', 'confirmed']);
  if (!Number.isSafeInteger(input.amount_cents) || Math.abs(input.amount_cents) > 999999999 || typeof input.currency !== 'string'
    || !/^[A-Z]{3}$/.test(input.currency) || typeof input.confirmed !== 'boolean') fail();
  return { schema_version: 1, source_id: lifeText(input.source_id, 200), date: lifeDate(input.date), merchant: lifeText(input.merchant, 300),
    category: lifeText(input.category, 100), amount_cents: input.amount_cents, currency: input.currency, confirmed: input.confirmed, source: 'student_entered', estimate: false };
}
export function expenseTotals(expenses) {
  if (!Array.isArray(expenses) || expenses.length > 10000) fail();
  const totals = new Map(), categories = new Map(); let unconfirmed = 0;
  for (const value of expenses) {
    const expense = normalizeExpense({ source_id: value.source_id, date: value.date, merchant: value.merchant, category: value.category,
      amount_cents: value.amount_cents, currency: value.currency, confirmed: value.confirmed });
    if (!expense.confirmed) { unconfirmed++; continue; }
    const key = `${expense.currency}:${expense.category}`;
    totals.set(expense.currency, (totals.get(expense.currency) ?? 0) + expense.amount_cents);
    categories.set(key, { currency: expense.currency, category: expense.category,
      cents: (categories.get(key)?.cents ?? 0) + expense.amount_cents });
  }
  return { totals: [...totals].map(([currency, cents]) => ({ currency, cents })), categories: [...categories.values()],
    unconfirmed_excluded: unconfirmed, coverage: 'Only the records entered here; missing periods and accounts are unknown.', converted: false };
}

export function prepareTravelChecklist(input, { now = new Date().toISOString() } = {}) {
  lifeObject(input, ['title', 'event_at', 'timezone', 'trip_minutes', 'buffer_minutes', 'source_url', 'source_checked_at', 'room', 'items'],
    ['title', 'event_at', 'timezone', 'trip_minutes', 'buffer_minutes', 'source_url', 'items']);
  lifeStamp(now); const event_at = lifeStamp(input.event_at); lifeTimezone(input.timezone);
  for (const value of [input.trip_minutes, input.buffer_minutes]) if (!Number.isSafeInteger(value) || value < 0 || value > 1440) fail();
  if (!Array.isArray(input.items) || input.items.length > 50) fail();
  const checked = input.source_checked_at == null ? null : lifeStamp(input.source_checked_at); if (checked && checked > now) fail();
  return { schema_version: 1, title: lifeText(input.title, 300), event_at, timezone: input.timezone,
    departure_at: new Date(Date.parse(event_at) - (input.trip_minutes + input.buffer_minutes) * 60000).toISOString(),
    assumptions: { trip_minutes: input.trip_minutes, buffer_minutes: input.buffer_minutes, method: 'student_entered_scheduled_estimate' },
    source_url: canonicalCareerURL(input.source_url), source_checked_at: checked, freshness: checked ? 'student_reported_check_not_live_verified' : 'unknown',
    room: input.room == null ? null : lifeText(input.room, 300), room_mapping: 'unresolved', items: input.items.map(item => ({ text: lifeText(item, 500), state: 'pending' })),
    booking: 'unsupported', geolocation: 'unused', calendar_writes: 'unsupported' };
}
