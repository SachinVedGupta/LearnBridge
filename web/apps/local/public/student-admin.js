export function mountStudentAdminUI({ root, request, element, busy, confirmAction, message, navigate }) {
  const $ = (tag, cls = '', text = '') => element(tag, cls, text), state = { ready: false, generation: 0, selection: 0, profiles: [], items: [], previews: [], editing: null, attempts: new Map(), requirements: [], checklist: [] };
  const active = new WeakSet(); let serial = 0;
  const status = $('p', 'notice'); status.id = 'student-admin-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Keep school, scholarship, financial aid and administration requirements together. Paste source text yourself and review each requirement. A URL and quotation are student supplied and unverified; LearnBridge does not determine official eligibility, read accounts or submit forms.'), status);
  const panel = (title, help) => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; };
  const button = text => { const node = $('button', 'button secondary compact', text); node.type = 'button'; return node; };
  const inputPanel = panel('Save a deadline and review its requirements', 'General-purpose confirmed profile facts can optionally support your own review. University, program, career eligibility and other facts are not reused without their existing purpose permission. Missing facts remain unknown. No task is created by saving this record.');
  const form = $('form', 'career-form'); inputPanel.append(form);
  const fields = {};
  function field(label, name, tag = 'input', type = 'text') { const wrapper = $('label', '', label), node = $(tag); node.id = `student-admin-${name}`; wrapper.htmlFor = node.id; if (tag === 'input') node.type = type; form.append(wrapper, node); fields[name] = node; node.addEventListener('input', () => state.selection++); node.addEventListener('change', () => state.selection++); return node; }
  const title = field('Title', 'title'); title.maxLength = 300;
  const category = field('Category', 'category', 'select'); for (const [value, text] of [['school', 'School'], ['scholarship', 'Scholarship'], ['financial_aid', 'Financial aid'], ['administration', 'Administration']]) { const option = $('option', '', text); option.value = value; category.append(option); } category.value = 'school';
  field('Official source URL you chose (not automatically verified)', 'url', 'input', 'url');
  const source = field('Paste the source requirement/deadline text', 'source', 'textarea'); source.rows = 8; source.maxLength = 12000;
  field('When you checked this text (UTC timestamp)', 'checked-at').value = new Date().toISOString();
  field('Time zone', 'timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const precision = field('Deadline precision', 'precision', 'select'); for (const [value, text] of [['unknown', 'Unknown / not confirmed'], ['date', 'Date only'], ['instant', 'Exact UTC instant']]) { const option = $('option', '', text); option.value = value; precision.append(option); } precision.value = 'unknown';
  field('Date only (YYYY-MM-DD; used only for date precision)', 'date', 'input', 'date');
  field('Exact UTC instant (e.g. 2026-10-12T03:30:00.000Z)', 'instant');
  field('Original deadline words / evidence', 'original');
  const requirements = $('div'), checklist = $('div'); form.append($('h3', '', 'Requirement reviews'), $('p', 'field-help', 'Each excerpt must occur exactly in your pasted text. Choose met, not met or unknown yourself and explain the review. All requirements begin unknown.'), requirements);
  const addRequirement = button('Add requirement'), addChecklist = button('Add checklist item'); form.append(addRequirement, $('h3', '', 'Preparation checklist'), checklist, addChecklist);
  const save = button('Review and save record'); save.type = 'submit'; const newRecord = button('Start a new record'), reload = button('Refresh administration'); form.append(save); inputPanel.append(newRecord, reload); save.disabled = reload.disabled = true;
  const recordsPanel = panel('Saved requirements and deadlines', 'Source or requirement corrections invalidate older task previews. A linked task is never edited or recreated here. Correct or cancel an unfinished acceptance before changing its evidence.'); const records = $('div'); recordsPanel.append(records);
  const previewsPanel = panel('Review local task previews', 'A preview creates no task. Accepting creates one local preparation/review task. Unknown dates stay unknown and incomplete requirements stay visible. It never establishes official eligibility or submits an application.'); const previews = $('div'); previewsPanel.append(previews);
  const current = generation => state.ready && state.generation === generation;
  async function action(target, operation) { if (!state.ready || active.has(target)) return; active.add(target); const generation = state.generation;
    try { await busy(target, () => current(generation) ? operation(generation) : undefined); } catch (error) { if (current(generation)) notice(error.message || 'Refresh the source and review its current version.', true); }
    finally { active.delete(target); if (!current(generation)) target.disabled = true; } }
  function rowField(container, label, name, tag = 'input') { const wrapper = $('label', '', label), node = $(tag); node.id = `student-admin-${name}`; wrapper.htmlFor = node.id; container.append(wrapper, node); return node; }
  function addRequirementRow(value = {}) {
    const row = $('div', 'review-row'), index = state.requirements.length, key = value.key ?? `requirement_${index + 1}`;
    const excerpt = rowField(row, 'Exact source requirement excerpt', `${key}-excerpt`, 'textarea'); excerpt.value = value.excerpt ?? ''; excerpt.maxLength = 1000;
    const review = rowField(row, 'Your requirement review', `${key}-review`, 'select'); for (const [name, text] of [['unknown', 'Unknown / needs checking'], ['met', 'I reviewed it as met'], ['not_met', 'I reviewed it as not met']]) { const option = $('option', '', text); option.value = name; review.append(option); } review.value = value.status ?? 'unknown';
    const note = rowField(row, 'Why / what remains unknown', `${key}-note`, 'textarea'); note.value = value.review_note ?? 'Not reviewed yet.'; note.maxLength = 1000;
    const facts = rowField(row, 'Optional selected general-purpose profile fact', `${key}-fact`, 'select'); const empty = $('option', '', 'No profile fact selected'); empty.value = ''; facts.append(empty);
    for (const fact of state.profiles) { const option = $('option', '', `${fact.field}: ${fact.value}`); option.value = fact.id; facts.append(option); }
    // The editor preserves up to ten existing exact pins, even though this simple picker adds at most one.
    const selected = value.profile_fact_ids ?? []; facts.value = selected.length === 1 ? selected[0] : ''; let editedFacts = false;
    facts.addEventListener('change', () => { editedFacts = true; state.selection++; });
    for (const node of [excerpt, review, note]) node.addEventListener('input', () => state.selection++);
    state.requirements.push({ key, excerpt, review, note, facts, originalFacts: selected, factsEdited: () => editedFacts }); requirements.append(row);
  }
  function addChecklistRow(value = {}) { const row = $('div', 'review-row'), index = state.checklist.length, key = value.key ?? `checklist_${index + 1}`, text = rowField(row, 'Preparation step', `${key}-title`), done = rowField(row, 'I completed this checklist step', `${key}-done`); text.value = value.title ?? ''; text.maxLength = 300; done.type = 'checkbox'; done.checked = value.done ?? false;
    text.addEventListener('input', () => state.selection++); done.addEventListener('change', () => state.selection++); state.checklist.push({ key, text, done }); checklist.append(row); }
  function clearEditor(row = null) {
    state.editing = row; state.selection++; state.requirements = []; state.checklist = []; requirements.replaceChildren(); checklist.replaceChildren();
    const data = row?.data.definition; title.value = data?.title ?? ''; category.value = data?.category ?? 'school'; fields.url.value = data?.official_url ?? ''; source.value = data?.source_text ?? ''; fields['checked-at'].value = data?.checked_at ?? new Date().toISOString(); fields.timezone.value = data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    precision.value = data?.deadline.precision ?? 'unknown'; fields.date.value = data?.deadline.date ?? ''; fields.instant.value = data?.deadline.instant ?? ''; fields.original.value = data?.deadline.original ?? '';
    for (const entry of data?.requirements ?? [{}]) addRequirementRow(entry); for (const entry of data?.checklist ?? []) addChecklistRow(entry);
    save.textContent = row ? 'Review and save correction' : 'Review and save record';
  }
  function definition() {
    const deadline = { precision: precision.value }; if (fields.original.value.trim()) deadline.original = fields.original.value.trim();
    if (precision.value === 'date') deadline.date = fields.date.value; else if (precision.value === 'instant') deadline.instant = fields.instant.value.trim(); else deadline.reason = 'Student has not confirmed an exact deadline';
    if (precision.value !== 'unknown') deadline.timezone = fields.timezone.value.trim();
    return { title: title.value.trim(), category: category.value, official_url: fields.url.value.trim(), source_text: source.value.trim(), checked_at: fields['checked-at'].value.trim(), timezone: fields.timezone.value.trim(), deadline,
      requirements: state.requirements.map(row => ({ key: row.key, excerpt: row.excerpt.value.trim(), status: row.review.value, review_note: row.note.value.trim(), profile_fact_ids: row.factsEdited() ? (row.facts.value ? [row.facts.value] : []) : row.originalFacts.length ? row.originalFacts : row.facts.value ? [row.facts.value] : [] })),
      checklist: state.checklist.map(row => ({ key: row.key, title: row.text.value.trim(), done: row.done.checked })) };
  }
  addRequirement.addEventListener('click', () => { if (state.requirements.length < 20) { addRequirementRow(); state.selection++; } }); addChecklist.addEventListener('click', () => { if (state.checklist.length < 20) { addChecklistRow(); state.selection++; } });
  newRecord.addEventListener('click', () => { if (state.ready) clearEditor(); }); reload.addEventListener('click', () => action(reload, () => refresh()));
  form.addEventListener('submit', event => { event.preventDefault(); action(save, async generation => {
    const selected = state.selection, editing = state.editing, payload = definition(), fingerprint = JSON.stringify(payload);
    const approved = await confirmAction(`${editing ? 'Correct' : 'Save'} the student-supplied record “${payload.title}” and its explicit requirement reviews? The source remains unverified. This creates no task, determines no official eligibility and submits no form.`, { title: 'Review administration record', confirmLabel: editing ? 'Save correction' : 'Save record' });
    if (!approved || !current(generation) || selected !== state.selection || fingerprint !== JSON.stringify(definition()) || editing !== state.editing) return;
    if (!state.attempts.has(fingerprint)) state.attempts.set(fingerprint, crypto.randomUUID());
    const result = await request(editing ? `/student-admin/items/${editing.id}` : '/student-admin/items', { method: 'POST', body: editing ? { expected_revision: editing.revision, item_hash: editing.data.item_hash, definition: payload, confirmed: true } : payload, ...(editing ? {} : { idempotencyKey: state.attempts.get(fingerprint) }) });
    if (!current(generation)) return; state.attempts.delete(fingerprint); clearEditor(); await refresh(); if (current(generation)) notice(`Saved “${result.item.data.definition.title}”. No task or external submission was created.`);
  }); });
  const deadlineText = deadline => deadline.precision === 'date' ? `${deadline.date} (date only)` : deadline.precision === 'instant' ? `${deadline.instant} (exact instant)` : 'Unknown deadline';
  function evidence(card, data) { card.append($('p', 'field-help', `${data.definition.category.replaceAll('_', ' ')} · ${deadlineText(data.definition.deadline)} · ${data.definition.timezone}`), $('p', 'field-help', `Student-pasted unverified source: ${data.definition.official_url} · checked by you at ${data.definition.checked_at}`));
    for (const requirement of data.definition.requirements) card.append($('p', '', `${requirement.status}: ${requirement.excerpt} — ${requirement.review_note}`));
    for (const entry of data.definition.checklist) card.append($('p', '', `${entry.done ? 'Completed checklist step' : 'Still to prepare'}: ${entry.title}`));
    const exact = $('details'); exact.append($('summary', '', 'Exact pasted evidence, profile pins and hashes'), $('pre', 'context-preview', JSON.stringify({ source_text: data.definition.source_text, source_hash: data.source_hash, profile_pins: data.profile_pins }, null, 2))); card.append(exact);
  }
  function render() {
    records.replaceChildren(); previews.replaceChildren(); if (!state.items.length) records.append($('p', 'field-help', 'No administration deadlines saved.'));
    for (const row of state.items) { const card = $('article', 'review-row'); card.append($('h3', '', row.data.definition.title), $('p', '', `Requirement review: ${row.eligibility.replaceAll('_', ' ')}. This is not an official eligibility decision.`)); evidence(card, row.data);
      if (row.profile_stale) card.append($('p', 'notice', 'A selected profile fact changed, expired or is no longer allowed. Correct the record and review current facts before preparing a task.'));
      if (row.source_changed_since_acceptance) card.append($('p', 'notice', 'The source record changed after task acceptance. The existing task is preserved; edit it separately if needed.'));
      const edit = button('Correct this record'); edit.disabled = Boolean(row.data.acceptance_preview_id && !row.data.linked_task_id); edit.addEventListener('click', () => { if (state.ready) clearEditor(row); }); card.append(edit);
      if (!row.data.linked_task_id && !row.data.acceptance_preview_id) { const prepare = button('Prepare a local task preview'); prepare.disabled = row.profile_stale; card.append(prepare); prepare.addEventListener('click', () => action(prepare, async generation => {
        const fingerprint = `${row.id}:${row.revision}:${row.data.item_hash}`; if (!state.attempts.has(fingerprint)) state.attempts.set(fingerprint, crypto.randomUUID());
        await request(`/student-admin/items/${row.id}/prepare`, { method: 'POST', body: { expected_revision: row.revision, item_hash: row.data.item_hash }, idempotencyKey: state.attempts.get(fingerprint) });
        if (!current(generation)) return; state.attempts.delete(fingerprint); await refresh(); if (current(generation)) notice('Exact local task preview prepared. Review it below; no task has been accepted.');
      })); }
      if (row.accepted_task) { card.append($('p', 'notice', row.accepted_task.unavailable ? 'The accepted task is unavailable. It will not be recreated.' : `Linked task: ${row.accepted_task.title}${row.accepted_task.changed ? ' · changed separately; preserved' : ''}`)); const open = button('Open local tasks'); open.addEventListener('click', () => { if (state.ready) navigate?.('today'); }); card.append(open); } records.append(card);
    }
    if (!state.previews.length) previews.append($('p', 'field-help', 'No local task previews prepared.'));
    for (const row of state.previews) { const data = row.data, card = $('article', 'review-row'); card.append($('h3', '', data.task.title), $('p', '', `${data.state} · ${deadlineText(data.task.deadline)} · requirements: ${data.eligibility.replaceAll('_', ' ')}`));
      evidence(card, data); for (const blocker of data.blockers) card.append($('p', 'notice', `Unresolved preparation: ${blocker.reason.replaceAll('_', ' ')}${blocker.excerpt ? ` — ${blocker.excerpt}` : blocker.title ? ` — ${blocker.title}` : ''}`));
      if (row.expired && data.state === 'prepared') card.append($('p', 'notice', 'This preview expired. Prepare and review a fresh version.')); if (row.needs_refresh) card.append($('p', 'notice', 'Its evidence or selected profile facts changed. This old preview cannot authorize a new task.'));
      if (data.matches.length) card.append($('p', 'notice', 'An existing local task has the same title. Resolve it separately; this preview cannot create or change it.'));
      if (['prepared', 'accepting'].includes(data.state)) for (const operation of ['accept', 'cancel']) { const control = button(operation === 'accept' ? 'Review and add this local task' : 'Cancel this preview'); if (operation === 'accept' && data.state === 'prepared') control.disabled = row.expired || row.needs_refresh || Boolean(data.matches.length); card.append(control);
        control.addEventListener('click', () => action(control, async generation => {
          const approved = await confirmAction(operation === 'accept' ? `Add exactly the local task “${data.task.title}” with ${deadlineText(data.task.deadline)}? ${data.blockers.length} preparation blockers stay visible. Requirement reviews are your statements, not official eligibility. No application, form, calendar or provider data is submitted or changed.` : 'Cancel this exact preview? A task already durably created cannot be cancelled through this record; recover its saved result first.', { title: 'Review administration task', confirmLabel: operation === 'accept' ? 'Add this local task' : 'Cancel preview' });
          if (!approved || !current(generation) || !state.previews.some(currentRow => currentRow.id === row.id && currentRow.revision === row.revision && currentRow.data.review_hash === data.review_hash && currentRow.data.state === data.state)) return;
          const result = await request(`/student-admin/previews/${row.id}/${operation}`, { method: 'POST', body: { expected_revision: row.revision, review_hash: data.review_hash, confirmed: true } });
          if (!current(generation)) return; await refresh(); if (current(generation)) notice(operation === 'cancel' ? 'Preview cancelled. No external action occurred.' : result.item.accepted_task?.unavailable ? 'Recovered the prior accepted task receipt. Its deleted task is not recreated.' : 'One local task is linked. Open Today to work on it; external submissions remain yours to review.');
        })); }
      previews.append(card);
    }
  }
  async function refresh() { const generation = state.generation, version = ++serial; const [context, saved, pending] = await Promise.all(['/student-admin/context', '/student-admin/items', '/student-admin/previews'].map(path => request(path)));
    if (generation !== state.generation || version !== serial) return; const first = !state.ready; state.ready = true; state.profiles = context.profiles; state.items = saved.items; state.previews = pending.items; save.disabled = reload.disabled = false; if (first) clearEditor(); render(); }
  function reset() { state.generation++; state.selection++; serial++; state.ready = false; state.profiles = []; state.items = []; state.previews = []; state.editing = null; state.attempts.clear(); state.requirements = []; state.checklist = []; records.replaceChildren(); previews.replaceChildren(); requirements.replaceChildren(); checklist.replaceChildren(); for (const node of Object.values(fields)) node.value = ''; save.disabled = reload.disabled = true; notice(''); }
  return { refresh, reset };
}
