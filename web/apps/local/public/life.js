export function mountLifeUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const state = { pantry: [], recipes: [], meals: [], routines: [], expenses: [], travel: [], generation: 0, attempts: new Map() };
  let fieldSequence = 0;
  const status = $('p', 'notice'); status.id = 'life-status'; status.setAttribute('role', 'status'); status.hidden = true;
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Plan everyday life with your own records: pantry and grocery arithmetic, self-reported routines, separate-currency expense totals, and manual travel checklists. Everything stays local. Purchases, medical guidance, financial advice, live transit, notifications and bookings are not enabled.'), status);
  const units = [['g', 'Grams'], ['kg', 'Kilograms'], ['ml', 'Millilitres'], ['l', 'Litres'], ['count', 'Count']];
  const today = () => { const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const get = type => parts.find(p => p.type === type).value; return `${get('year')}-${get('month')}-${get('day')}`; };
  function panel(title, help) { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; }
  function field(parent, label, { value = '', type = 'text', required = false, multiline = false } = {}) {
    const wrapper = $('label', '', label), input = $(multiline ? 'textarea' : 'input'); if (!multiline) input.type = type;
    input.defaultValue = value; input.value = value; input.required = required; input.maxLength = multiline ? 20000 : 1000; if (multiline) { input.className = 'career-textarea'; input.rows = 4; }
    wrapper.append(input); parent.append(wrapper); return input;
  }
  function select(parent, label, choices) { const wrapper = $('div'), caption = $('label', '', label), input = $('select'); input.id = `life-select-${++fieldSequence}`; caption.htmlFor = input.id;
    for (const [value, text] of choices) { const option = $('option', '', text); option.value = value; input.append(option); } wrapper.append(caption, input); parent.append(wrapper); return input; }
  function check(parent, label, checked = false) { const wrapper = $('label', 'record-choice'), input = $('input'); input.type = 'checkbox'; input.defaultChecked = false; input.checked = checked; wrapper.append(input, $('span', '', label)); parent.append(wrapper); return input; }
  const button = (caption, primary = false) => { const input = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, caption); input.type = 'button'; return input; };
  const form = parent => { const node = $('form', 'career-form'); parent.append(node); return node; };
  function key(name, body) { const payload = JSON.stringify(body); if (state.attempts.get(name)?.payload !== payload) state.attempts.set(name, { payload, key: crypto.randomUUID() }); return state.attempts.get(name).key; }
  function money(value) { if (!/^-?\d{1,7}(?:\.\d{1,2})?$/.test(value)) throw new Error('Use a decimal amount with at most two places, such as 12.50.');
    const negative = value.startsWith('-'), [whole, decimal = ''] = value.replace(/^-/, '').split('.'); return (Number(whole) * 100 + Number(decimal.padEnd(2, '0'))) * (negative ? -1 : 1); }
  async function action(target, fn) { try { await busy(target, fn); } catch (error) { notice(error.message || 'The local change could not finish. Your input is still here.', true); } }
  async function create(path, kind, body) { await request(`/life/${path}`, { method: 'POST', body, idempotencyKey: key(kind, body) }); state.attempts.delete(kind); await refresh(); }

  const pantryPanel = panel('Pantry', 'Use exact supported units. Unknown stock is excluded; recorded expiry dates are a prompt to check your food, not a safety assessment.');
  const pantryForm = form(pantryPanel), pantryName = field(pantryForm, 'Item', { required: true }), pantryQuantity = field(pantryForm, 'Quantity', { required: true });
  pantryQuantity.inputMode = 'decimal'; const pantryUnit = select(pantryForm, 'Unit', units), expiry = field(pantryForm, 'Recorded expiry (optional)', { type: 'date' });
  const pantryConfirmed = check(pantryForm, 'I checked this quantity', true), pantrySave = button('Save pantry item', true); pantrySave.type = 'submit'; pantryForm.append(pantrySave);
  pantryForm.addEventListener('submit', event => { event.preventDefault(); action(pantrySave, async () => { await create('pantry', 'pantry', { name: pantryName.value, quantity: pantryQuantity.value, unit: pantryUnit.value,
    confirmed: pantryConfirmed.checked, expiry: expiry.value || null }); pantryForm.reset(); notice('Pantry item saved locally.'); }); });
  const pantryList = $('div'); pantryPanel.append(pantryList);

  const recipePanel = panel('Recipes', 'Enter your recipe and servings. Ingredient labels need your review; LearnBridge does not guarantee allergy or nutritional safety.');
  const recipeForm = form(recipePanel), recipeTitle = field(recipeForm, 'Recipe name', { required: true }), servings = field(recipeForm, 'Recipe servings', { type: 'number', value: '2', required: true }); servings.min = '1'; servings.max = '100';
  const prepTime = field(recipeForm, 'Preparation minutes', { type: 'number', value: '20', required: true }); prepTime.min = '1'; prepTime.max = '1440';
  const sourceURL = field(recipeForm, 'Recipe source URL (optional)', { type: 'url' }), ingredients = $('fieldset'); ingredients.append($('legend', '', 'Ingredients')); recipeForm.append(ingredients);
  const ingredientFields = [];
  function addIngredient() {
    if (ingredientFields.length >= 50) return;
    const row = $('div', 'review-row'), name = field(row, 'Ingredient', { required: true }), quantity = field(row, 'Quantity', { required: true }), unit = select(row, 'Unit', units), labels = check(row, 'I reviewed the ingredient labels');
    quantity.inputMode = 'decimal'; ingredients.append(row); const entry = { name, quantity, unit, labels }; ingredientFields.push(entry);
    const remove = button('Remove ingredient'); row.append(remove); remove.addEventListener('click', () => { ingredientFields.splice(ingredientFields.indexOf(entry), 1); row.remove(); });
  }
  addIngredient(); const add = button('Add another ingredient'); recipeForm.append(add); add.addEventListener('click', addIngredient);
  const recipeSave = button('Save recipe', true); recipeSave.type = 'submit'; recipeForm.append(recipeSave);
  recipeForm.addEventListener('submit', event => { event.preventDefault(); action(recipeSave, async () => { await create('recipes', 'recipe', { title: recipeTitle.value, servings: Number(servings.value), prep_minutes: Number(prepTime.value),
    ingredients: ingredientFields.map(field => ({ name: field.name.value, quantity: field.quantity.value, unit: field.unit.value, labels_complete: field.labels.checked })), ...(sourceURL.value ? { source_url: sourceURL.value } : {}) });
    recipeForm.reset(); ingredients.replaceChildren($('legend', '', 'Ingredients')); ingredientFields.length = 0; addIngredient(); notice('Recipe saved. Prices and ingredient safety remain yours to check.'); }); });
  const recipeList = $('div'); recipePanel.append(recipeList);

  const mealPanel = panel('Meal and grocery plan', 'Choose recipes, servings and dates. Compatible pantry stock is subtracted once from the consolidated list. We never convert weight to volume or invent prices.');
  const mealForm = form(mealPanel), restrictions = field(mealForm, 'Declared prohibited ingredients (one exact name per line, optional)', { multiline: true }), maxPrep = field(mealForm, 'Maximum preparation minutes', { type: 'number', value: '60', required: true });
  const mealChoices = $('div'); mealForm.append(mealChoices); let mealFields = [];
  const mealSave = button('Prepare grocery preview', true); mealSave.type = 'submit'; mealForm.append(mealSave);
  mealForm.addEventListener('submit', event => { event.preventDefault(); action(mealSave, async () => {
    const meals = mealFields.filter(field => field.include.checked).map(field => ({ recipe_id: field.id, date: field.date.value, servings: Number(field.servings.value) }));
    await create('meals', 'meals', { meals, restrictions: restrictions.value.split('\n').map(s => s.trim()).filter(Boolean), max_prep_minutes: Number(maxPrep.value) }); notice('Meal and grocery preview saved. Review quantities, restrictions and unknowns before accepting.');
  }); });
  const mealList = $('div'); mealPanel.append(mealList);

  const routinePanel = panel('Routines', 'Choose a daily or every-N-days routine. Completion is your report. Missing days stay unrecorded; notifications are off. Optional next tasks use dates in your declared time zone.');
  const routineForm = form(routinePanel), routineTitle = field(routineForm, 'Routine', { required: true }), startDate = field(routineForm, 'Start date', { type: 'date', value: today(), required: true });
  const everyDays = field(routineForm, 'Repeat every (days)', { type: 'number', value: '1', required: true }); everyDays.min = '1'; everyDays.max = '365';
  const timezone = field(routineForm, 'Time zone', { value: Intl.DateTimeFormat().resolvedOptions().timeZone, required: true });
  const createTask = check(routineForm, 'Create a local task for the next occurrence', true), routineSave = button('Save routine', true); routineSave.type = 'submit'; routineForm.append(routineSave);
  routineForm.addEventListener('submit', event => { event.preventDefault(); action(routineSave, async () => { await create('routines', 'routine', { title: routineTitle.value, start_date: startDate.value,
    every_days: Number(everyDays.value), timezone: timezone.value, create_next_task: createTask.checked }); notice('Routine and selected local next task saved.'); }); });
  const routineList = $('div'); routinePanel.append(routineList);

  const expensePanel = panel('Expenses', 'Enter confirmed expenses or refunds. Totals cover these records only and stay separate for each currency. This is a record keeper, not financial advice or a bank connection.');
  const expenseForm = form(expensePanel), expenseDate = field(expenseForm, 'Date', { type: 'date', value: today(), required: true }), merchant = field(expenseForm, 'Merchant', { required: true });
  const category = field(expenseForm, 'Category', { value: 'Other', required: true }), amount = field(expenseForm, 'Amount (negative for a refund)', { required: true }); amount.inputMode = 'decimal';
  const currency = field(expenseForm, 'Currency code', { value: 'CAD', required: true }), reference = field(expenseForm, 'Source reference (optional; distinct purchases can share a merchant/date)');
  const confirmedExpense = check(expenseForm, 'I checked this amount', true), expenseSave = button('Save expense', true); expenseSave.type = 'submit'; expenseForm.append(expenseSave);
  expenseForm.addEventListener('submit', event => { event.preventDefault(); action(expenseSave, async () => {
    const cents = money(amount.value);
    const content = { date: expenseDate.value, merchant: merchant.value, category: category.value, amount_cents: cents, currency: currency.value.toUpperCase(), confirmed: confirmedExpense.checked };
    const idempotencyKey = key('expense', { ...content, reference: reference.value });
    await request('/life/expenses', { method: 'POST', body: { ...content, source_id: reference.value || idempotencyKey }, idempotencyKey });
    state.attempts.delete('expense'); expenseForm.reset(); await refresh(); notice('Expense saved. Unknown or unconfirmed amounts are excluded from totals.');
  }); });
  const expenseTotals = $('div'), expenseList = $('div'); expensePanel.append(expenseTotals, expenseList);

  const travelPanel = panel('Manual travel checklist', 'Enter an event time and scheduled travel estimate from a chosen source. This subtracts your travel time and buffer; it does not fetch live arrivals or map an unverified room.');
  const travelForm = form(travelPanel), travelTitle = field(travelForm, 'Event or trip', { required: true }), eventAt = field(travelForm, 'Event time (this computer’s time zone)', { type: 'datetime-local', required: true });
  const tripMinutes = field(travelForm, 'Scheduled travel minutes', { type: 'number', value: '30', required: true }), bufferMinutes = field(travelForm, 'Buffer minutes', { type: 'number', value: '10', required: true });
  const travelURL = field(travelForm, 'Official source URL', { type: 'url', required: true }), room = field(travelForm, 'Room or place (optional; directions remain unverified)'), items = field(travelForm, 'Checklist (one item per line)', { multiline: true });
  const travelSave = button('Save manual checklist', true); travelSave.type = 'submit'; travelForm.append(travelSave);
  travelForm.addEventListener('submit', event => { event.preventDefault(); action(travelSave, async () => { await create('travel', 'travel', { title: travelTitle.value, event_at: new Date(eventAt.value).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, trip_minutes: Number(tripMinutes.value), buffer_minutes: Number(bufferMinutes.value), source_url: travelURL.value,
    ...(room.value ? { room: room.value } : {}), items: items.value.split('\n').map(s => s.trim()).filter(Boolean) }); notice('Manual checklist saved. Source freshness and directions remain unverified.'); }); });
  const travelList = $('div'); travelPanel.append(travelList);

  function renderPantry() {
    pantryList.replaceChildren();
    for (const record of state.pantry) {
      const item = record.data.pantry, row = $('article', 'review-row'); row.append($('h3', '', `${item.name}: ${item.quantity} ${item.unit}`), $('p', 'field-help', `${item.confirmed ? 'Student-confirmed' : 'Unconfirmed; not counted'}${item.expiry ? ` · recorded expiry ${item.expiry}` : ''}`));
      const quantity = field(row, 'Updated quantity', { value: item.quantity, required: true }), updatedExpiry = field(row, 'Updated recorded expiry (optional)', { type: 'date', value: item.expiry ?? '' }), save = button('Confirm updated stock'); row.append(save);
      save.addEventListener('click', () => action(save, async () => { await request(`/life/pantry/${record.id}`, { method: 'POST', body: { expected_revision: record.revision, quantity: quantity.value, unit: item.unit, confirmed: true, expiry: updatedExpiry.value || null } }); await refresh(); notice('Stock updated. Older meal previews now require a fresh review.'); })); pantryList.append(row);
    }
  }
  function renderRecipes() {
    const previous = new Map(mealFields.map(field => [field.id, { include: field.include.checked, servings: field.servings.value, date: field.date.value }]));
    recipeList.replaceChildren(); mealChoices.replaceChildren(); mealFields = [];
    for (const record of state.recipes) {
      const recipe = record.data.recipe; recipeList.append($('p', 'field-help', `${recipe.title} · ${recipe.servings} servings · ${recipe.prep_minutes} minutes`));
      const row = $('fieldset'), include = check(row, recipe.title), selectedServings = field(row, 'Servings for this meal', { type: 'number', value: String(recipe.servings), required: true }), date = field(row, 'Meal date', { type: 'date', value: today(), required: true });
      const saved = previous.get(record.id); if (saved) { include.checked = saved.include; selectedServings.value = saved.servings; date.value = saved.date; }
      mealChoices.append(row); mealFields.push({ id: record.id, include, servings: selectedServings, date });
    }
    mealSave.disabled = !state.recipes.length;
  }
  function renderMeals() {
    mealList.replaceChildren();
    for (const record of state.meals) {
      const plan = record.data.plan, row = $('article', 'review-row'); row.append($('h3', '', `${record.data.state}${record.needs_refresh ? ' · pantry or source changed' : ''}`));
      for (const meal of plan.meals) row.append($('p', 'field-help', `${meal.date}: ${meal.title} · ${meal.servings} servings`));
      row.append($('h3', '', 'Grocery deficits'));
      for (const item of plan.grocery) row.append($('p', '', `${item.name}: ${item.quantity} ${item.unit} needed (recipe total ${item.required}; pantry counted ${item.pantry_counted})`));
      if (!plan.grocery.length) row.append($('p', 'field-help', 'No deficit from the entered compatible stock. Check the recorded quantities.'));
      for (const issue of [...plan.blocked, ...plan.questions]) row.append($('p', 'field-help', `${issue.ingredient ? `${issue.ingredient}: ` : ''}${issue.reason.replaceAll('_', ' ')}`));
      row.append($('p', 'field-help', `${plan.safety} Prices: ${plan.cost.status.replaceAll('_', ' ')}.`));
      if (!record.data.acceptance) {
        const accept = button('Review and accept local plan'); accept.disabled = plan.state === 'blocked' || record.needs_refresh; row.append(accept);
        accept.addEventListener('click', () => action(accept, async () => {
          if (!await confirmAction(`Accept this exact local meal/grocery snapshot? No purchases are made.\n\n${plan.grocery.map(item => `${item.name}: ${item.quantity} ${item.unit}`).join('\n')}\n\n${plan.safety}\nFingerprint: ${record.plan_hash}`, { title: 'Review grocery quantities', confirmLabel: 'Accept local plan' })) return;
          await request(`/life/meals/${record.id}/accept`, { method: 'POST', body: { expected_revision: record.revision, plan_hash: record.plan_hash } }); await refresh(); notice('Local meal/grocery snapshot accepted. Nothing was purchased.');
        }));
      }
      mealList.append(row);
    }
  }
  function renderRoutines() {
    routineList.replaceChildren();
    for (const record of state.routines) {
      const routine = record.data.routine, row = $('article', 'review-row'); row.append($('h3', '', routine.title), $('p', 'field-help', `Every ${routine.every_days} day(s) · next ${record.data.next_date} · ${routine.timezone} · ${routine.observations.length} self-reported completions · notifications off`));
      row.append($('p', 'field-help', record.observation_policy)); if (record.data.task_completion_notice) row.append($('p', 'notice', record.data.task_completion_notice));
      const complete = button(record.data.pending_transition ? 'Finish saved local update' : 'Mark this occurrence complete'); complete.disabled = !record.data.pending_transition && record.data.next_date > record.today; row.append(complete);
      complete.addEventListener('click', () => action(complete, async () => { const pending = record.data.pending_transition,
        body = { expected_revision: pending?.original_revision ?? record.revision, date: pending?.date ?? record.data.next_date };
        if (!await confirmAction(`Record your completion for ${routine.title} on ${body.date} and prepare its selected next local task? Missing days stay unrecorded.`, { title: 'Review routine completion', confirmLabel: 'Save completion' })) return;
        await request(`/life/routines/${record.id}/complete`, { method: 'POST', body }); await refresh(); notice('Routine observation and next local task saved.');
      })); routineList.append(row);
    }
  }
  function renderExpenses(totals) {
    expenseTotals.replaceChildren(); expenseList.replaceChildren();
    for (const total of totals.totals) expenseTotals.append($('p', 'notice', `${total.currency}: ${(total.cents / 100).toFixed(2)} confirmed total`));
    expenseTotals.append($('p', 'field-help', `${totals.coverage} Unconfirmed excluded: ${totals.unconfirmed_excluded}. No currencies converted.`));
    for (const record of state.expenses) { const item = record.data.expense, row = $('article', 'review-row'); row.append($('h3', '', `${item.merchant}: ${item.currency} ${(item.amount_cents / 100).toFixed(2)}`), $('p', 'field-help', `${item.date} · ${item.category} · ${item.confirmed ? 'confirmed' : 'unconfirmed'}`));
      const edit = $('details'); edit.append($('summary', '', 'Correct or confirm this record')); const editForm = form(edit), newAmount = field(editForm, 'Corrected amount', { value: (item.amount_cents / 100).toFixed(2), required: true }), newCategory = field(editForm, 'Category', { value: item.category, required: true }), confirmed = check(editForm, 'I checked this amount', item.confirmed), save = button('Save correction'); save.type = 'submit'; editForm.append(save); row.append(edit);
      editForm.addEventListener('submit', event => { event.preventDefault(); action(save, async () => { await request(`/life/expenses/${record.id}`, { method: 'POST', body: { expected_revision: record.revision, amount_cents: money(newAmount.value), category: newCategory.value, confirmed: confirmed.checked } }); await refresh(); notice('Expense correction saved. Currency totals recomputed.'); }); }); expenseList.append(row); }
  }
  function renderTravel() {
    travelList.replaceChildren();
    for (const record of state.travel) { const trip = record.data.travel, row = $('article', 'review-row'); row.append($('h3', '', trip.title), $('p', '', `Scheduled departure estimate: ${new Date(trip.departure_at).toLocaleString(undefined, { timeZone: trip.timezone })} (${trip.timezone})`), $('p', 'field-help', `Source freshness: ${trip.freshness}. Room/building mapping: ${trip.room_mapping}. No realtime arrival claim.`));
      const link = $('a', '', 'Open selected source'); link.href = trip.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
      for (const item of trip.items) row.append($('p', '', `□ ${item.text}`)); travelList.append(row); }
  }
  async function refresh() {
    const generation = state.generation, values = await Promise.all(['pantry', 'recipes', 'meals', 'routines', 'expenses', 'travel', 'expenses/totals'].map(path => request(`/life/${path}`)));
    if (generation !== state.generation) return;
    [state.pantry, state.recipes, state.meals, state.routines, state.expenses, state.travel] = values.slice(0, 6).map(value => value.items);
    renderPantry(); renderRecipes(); renderMeals(); renderRoutines(); renderExpenses(values[6]); renderTravel();
  }
  function reset() { state.generation++; state.pantry = []; state.recipes = []; state.meals = []; state.routines = []; state.expenses = []; state.travel = []; state.attempts.clear();
    for (const f of root.querySelectorAll('form')) f.reset(); for (const list of [pantryList, recipeList, mealChoices, mealList, routineList, expenseTotals, expenseList, travelList]) list.replaceChildren(); mealFields = []; notice(''); }
  return { refresh, reset };
}
