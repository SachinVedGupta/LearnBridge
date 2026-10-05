/** Shipped reviewed local ICS flow. File import into another calendar remains the student's separate action. */
export function mountCalendarExportUI({ root, request, element, busy, confirmAction, message, downloadFile }) {
  const $ = (tag, cls = '', text = '') => element(tag, cls, text), state = { ready: false, generation: 0, selection: 0, tasks: [], plans: [], previews: [], attempts: new Map() };
  const active = new WeakSet(); let taskFields = [], serial = 0;
  const status = $('p', 'notice'); status.id = 'calendar-export-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Prepare a reviewed calendar file from local tasks or an accepted study plan. Deadline markers keep date-only and exact-instant precision; study blocks use the saved hours. No calendar account is changed. You choose whether to import the file elsewhere.'), status);
  const panel = (title, help) => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; };
  const button = caption => { const node = $('button', 'button secondary compact', caption); node.type = 'button'; return node; };
  const selectionPanel = panel('Choose local calendar content', 'All tasks and plans start unselected. Up to 25 selected active tasks produce transparent deadline markers. Unknown dates and subsecond instants are listed as omitted, never guessed. Saved study plans must be accepted, current and free of unresolved block conflicts.');
  const modeLabel = $('label', '', 'Export type'), mode = $('select'); mode.id = 'calendar-export-mode'; modeLabel.htmlFor = mode.id;
  for (const [value, label] of [['tasks', 'Selected task deadlines'], ['study_plan', 'Exact accepted study plan']]) { const option = $('option', '', label); option.value = value; mode.append(option); }
  mode.value = 'tasks'; selectionPanel.append(modeLabel, mode);
  const tasks = $('fieldset'); tasks.append($('legend', '', 'Choose task deadlines')); selectionPanel.append(tasks);
  const planLabel = $('label', '', 'Accepted saved plan'), plan = $('select'); plan.id = 'calendar-export-plan'; planLabel.htmlFor = plan.id; selectionPanel.append(planLabel, plan);
  const prepare = button('Prepare exact calendar preview'), reload = button('Refresh calendar exports'); prepare.disabled = reload.disabled = true; selectionPanel.append(prepare, reload);
  const previewPanel = panel('Review exact calendar files', 'Check every event, omission, source and file hash. Preparing a download requires a separate confirmation and current unchanged source/task/plan pins. Stable event IDs help compatible calendar clients recognize repeat imports, but duplicate prevention depends on the calendar importer. This app cannot verify that an external import succeeded.'); const previews = $('div'); previewPanel.append(previews);
  const current = generation => state.ready && state.generation === generation;
  const invalidate = () => { state.selection++; notice(''); };
  mode.addEventListener('change', invalidate); plan.addEventListener('change', invalidate);
  async function action(target, operation) {
    if (!state.ready || active.has(target)) return; active.add(target); const generation = state.generation;
    try { await busy(target, () => current(generation) ? operation(generation) : undefined); }
    catch (error) { if (current(generation)) notice(error.message || 'Calendar content changed. Refresh and prepare a new exact preview.', true); }
    finally { active.delete(target); if (!current(generation)) target.disabled = true; }
  }
  const deadlineText = value => value.precision === 'date' ? `${value.date} · date only · ${value.timezone || 'source time zone unspecified'}` : value.precision === 'instant' ? `${value.instant} · exact instant · ${value.timezone || 'source time zone unspecified'}` : `unknown date · ${value.original || value.reason || 'not supplied'}`;
  function renderChoices() {
    tasks.replaceChildren($('legend', '', 'Choose up to 25 task deadlines')); taskFields = [];
    for (const task of state.tasks) {
      const wrapper = $('label', 'record-choice'), include = $('input'); include.type = 'checkbox'; include.id = `calendar-export-task-${task.id}`; include.checked = false; include.disabled = ['completed', 'cancelled'].includes(task.status);
      include.addEventListener('change', invalidate); wrapper.append(include, $('span', '', `${task.title} · ${deadlineText(task.deadline)} · ${task.status}`)); tasks.append(wrapper); taskFields.push({ task, include });
    }
    if (!state.tasks.length) tasks.append($('p', 'field-help', 'No accepted local tasks. Review and accept a task in Today or Academic tasks first.'));
    plan.replaceChildren(); const empty = $('option', '', 'Choose an accepted current saved plan'); empty.value = ''; plan.append(empty);
    for (const row of state.plans) { const option = $('option', '', `${row.title} · ${row.state} · revision ${row.revision} · ${row.block_count} blocks · ${row.timezone}${row.eligible ? '' : ' · unavailable: stale, unaccepted or unresolved'}`); option.value = row.id; option.disabled = !row.eligible; plan.append(option); }
    plan.value = '';
  }
  function input() {
    if (mode.value === 'tasks') { const task_ids = taskFields.filter(row => row.include.checked && !row.include.disabled).map(row => row.task.id).sort(); if (!task_ids.length || task_ids.length > 25) throw new Error('Choose between 1 and 25 active local tasks.'); return { mode: 'tasks', task_ids }; }
    if (mode.value !== 'study_plan') throw new Error('Choose a supported export type.'); const selected = state.plans.find(row => row.id === plan.value && row.eligible); if (!selected) throw new Error('Choose one accepted, current saved study plan.');
    return { mode: 'study_plan', plan_id: selected.id, expected_revision: selected.revision, plan_hash: selected.plan_hash };
  }
  prepare.addEventListener('click', () => action(prepare, async generation => {
    const body = input(), identity = JSON.stringify(body), selection = state.selection; if (!state.attempts.has(identity)) state.attempts.set(identity, crypto.randomUUID());
    await request('/calendar-export/previews', { method: 'POST', body, idempotencyKey: state.attempts.get(identity) });
    if (!current(generation) || selection !== state.selection) return; state.attempts.delete(identity); await refresh(); if (current(generation)) notice('Exact file preview prepared. Review it below before downloading. No task or calendar was changed.');
  }));
  reload.addEventListener('click', () => action(reload, () => refresh()));
  async function savePayload(payload, generation) {
    if (payload.mime !== 'text/calendar;charset=utf-8' || !/^learnbridge-[a-f0-9-]{36}\.ics$/.test(payload.filename) || typeof payload.content !== 'string' || payload.bytes > 48000) throw new Error('This calendar download payload is invalid.');
    const encoded = new TextEncoder().encode(payload.content); const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (encoded.length !== payload.bytes || actual !== payload.sha256) throw new Error('Calendar file integrity check failed. Refresh before downloading.');
    if (!current(generation)) return;
    if (downloadFile) await downloadFile({ filename: payload.filename, mime: payload.mime, content: payload.content });
    else {
      const url = URL.createObjectURL(new Blob([payload.content], { type: payload.mime })), link = document.createElement('a'); link.href = url; link.download = payload.filename; document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    if (current(generation)) notice('Calendar download requested. Check your browser downloads, then import the file into your chosen calendar if desired. External import is not verified.');
  }
  function renderPreviews() {
    previews.replaceChildren(); if (!state.previews.length) previews.append($('p', 'field-help', 'No calendar previews prepared.'));
    for (const row of [...state.previews].reverse()) {
      const data = row.data, card = $('article', 'review-row'); card.append($('h3', '', row.title), $('p', 'field-help', `${data.events.length} events · ${data.omitted.length} omissions · ${data.bytes} bytes · ${row.expired ? 'expired' : `expires ${data.expires_at}`} · ${row.needs_refresh ? 'content changed: prepare a new preview' : 'current pinned local content'}`));
      for (const event of data.events) card.append($('p', 'field-help', `${event.title} · ${event.kind === 'study_block' ? `${event.start} → ${event.end} · exact saved block` : deadlineText(event.deadline)} · ${event.timezone || 'source time zone unspecified'}`));
      for (const omitted of data.omitted) card.append($('p', 'field-help', `Omitted: ${omitted.title} · ${deadlineText(omitted.deadline)} · ${omitted.reason.replaceAll('_', ' ')}`));
      const meta = $('details'); meta.append($('summary', '', 'Exact event provenance, source pins and capacity warnings'), $('pre', 'context-preview', JSON.stringify({ events: data.events, omitted: data.omitted, warnings: data.warnings, pins: data.pins }, null, 2))); card.append(meta);
      const file = $('details'); file.append($('summary', '', `Exact ICS file · SHA-256 ${data.sha256}`), $('pre', 'context-preview', data.content)); card.append(file);
      const download = button('Review and download this calendar'); download.disabled = row.expired || row.needs_refresh; card.append(download);
      download.addEventListener('click', () => action(download, async generation => {
        const selection = state.selection;
        const approved = await confirmAction(`Prepare a download of this exact ${data.events.length}-event calendar file (${data.bytes} bytes)? It contains the displayed task titles, dates, saved study hours and source references. You decide whether to import it elsewhere. No provider calendar is changed.`, { title: 'Review exact calendar file', confirmLabel: 'Download this ICS file' });
        if (!approved || !current(generation) || selection !== state.selection || !state.previews.some(item => item.id === row.id && item.revision === row.revision && !item.expired && !item.needs_refresh)) return;
        const payload = await request(`/calendar-export/previews/${row.id}/download`, { method: 'POST', body: { expected_revision: row.revision, review_hash: data.review_hash, confirmed: true } });
        if (!current(generation)) return;
        if (payload.sha256 !== data.sha256 || payload.content !== data.content || payload.bytes !== data.bytes) throw new Error('Reviewed calendar content changed. Prepare a fresh exact preview.');
        await savePayload(payload, generation); if (current(generation)) await refresh();
      }));
      previews.append(card);
    }
  }
  async function refresh() {
    const generation = state.generation, version = ++serial;
    const [context, saved] = await Promise.all(['/calendar-export/context', '/calendar-export/previews'].map(path => request(path)));
    if (generation !== state.generation || version !== serial) return;
    state.ready = true; state.tasks = context.tasks; state.plans = context.plans; state.previews = saved.items; state.selection++; renderChoices(); renderPreviews(); prepare.disabled = reload.disabled = false;
  }
  function reset() { state.generation++; state.selection++; serial++; state.ready = false; state.tasks = []; state.plans = []; state.previews = []; state.attempts.clear(); taskFields = []; tasks.replaceChildren($('legend', '', 'Choose task deadlines')); plan.replaceChildren(); plan.value = ''; previews.replaceChildren(); prepare.disabled = reload.disabled = true; notice(''); }
  return { refresh, reset };
}
