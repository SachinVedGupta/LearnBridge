export function mountPlanTasksUI({ root, request, element, busy, message, confirmAction }) {
  const $ = (tag, cls, text) => element(tag, cls, text), state = { generation: 0, selection: 0, current: null, inspection: null, preparation: null };
  const status = $('p', 'notice'); status.id = 'plan-task-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const button = text => { const node = $('button', 'button secondary', text); node.type = 'button'; return node; };
  const action = (control, callback) => busy(control, callback).catch(error => notice(error.message, true));
  const deadlineText = value => value.precision === 'date' ? `Date only: ${value.date}${value.timezone ? ` (${value.timezone})` : ''}` : value.precision === 'instant' ? `Exact deadline: ${value.instant}${value.timezone ? ` (${value.timezone})` : ''}` : `Unknown deadline${value.original ? `: ${value.original}` : ''}`;
  root.replaceChildren($('p', 'notice', 'Choose a catch-up plan you already reviewed in Learning. Preview selected study tasks, then explicitly accept one exact task at a time into Today. Estimates and source deadlines stay visible. Creating tasks does not prove that you learned or caught up.'), status);
  const refreshControl = button('Refresh accepted learning plans'), plans = $('section', 'panel source-panel'), selectionPanel = $('section', 'panel source-panel'), previews = $('section', 'panel source-panel'), detail = $('section', 'panel source-panel');
  selectionPanel.hidden = true; detail.hidden = true; root.append(refreshControl, plans, selectionPanel, previews, detail); refreshControl.addEventListener('click', () => action(refreshControl, refresh));
  function clear() { state.current = null; state.inspection = null; selectionPanel.replaceChildren(); selectionPanel.hidden = true; detail.replaceChildren(); detail.hidden = true; }
  function inspect(data) {
    state.inspection = data; selectionPanel.hidden = false; selectionPanel.replaceChildren($('h2', '', 'Choose reviewed plan topics'), $('p', 'notice', data.claim), $('p', 'field-help', `Accepted plan revision ${data.plan_ref.revision}. Catch-up SHA-256: ${data.plan_ref.catch_up_hash}. Task deadlines use the exam/goal source, never proposed study-block times.`));
    const form = $('form', 'career-form'), controls = []; selectionPanel.append(form);
    for (const row of data.topics) { const group = $('div', 'review-row'); group.append($('strong', '', row.base_task.title), $('p', 'field-help', `${row.state.replaceAll('_', ' ')} · ${deadlineText(row.base_task.deadline)} · ${row.base_task.effort_minutes === null ? 'Unknown effort' : `${row.base_task.effort_minutes} estimated minutes`}`));
      if (['awaiting_review', 'prerequisites_need_review'].includes(row.state)) { const check = $('input'); check.type = 'checkbox'; check.checked = false; const label = $('label', 'field-help', `Include topic ${row.topic_id} in this private handoff preview`); label.append(check); group.append(label); controls.push({ check, row }); } form.append(group); }
    const prepare = button('Preview only my selected study tasks'); prepare.type = 'submit'; prepare.disabled = !controls.length; form.append(prepare);
    form.addEventListener('submit', event => { event.preventDefault(); action(prepare, async () => {
      if (state.inspection !== data) return; const selected = controls.filter(item => item.check.checked).map(item => item.row.topic_id); if (!selected.length || selected.length > 20) throw new Error('Choose 1 to 20 plan topics. No tasks were created.');
      const generation = state.generation, selection = state.selection, body = { plan_ref: data.plan_ref, topic_ids: selected }, fingerprint = JSON.stringify(body);
      if (state.preparation?.body !== fingerprint) state.preparation = { body: fingerprint, key: `plan_tasks_${crypto.randomUUID().replaceAll('-', '')}` };
      const result = await request('/plan-tasks/previews', { method: 'POST', body, idempotencyKey: state.preparation.key }); if (generation !== state.generation || selection !== state.selection || state.inspection !== data) return;
      state.preparation = null; show(result.preview); await refresh(); if (generation === state.generation) notice('Exact selected task preview saved. No local task was created; accept each intended task separately.');
    }); });
  }
  function show(preview) {
    state.inspection = null; selectionPanel.replaceChildren(); selectionPanel.hidden = true;
    state.current = preview; detail.hidden = false; detail.replaceChildren($('h2', '', preview.title), $('p', 'notice', preview.stale ? 'This plan or its learning evidence changed or is unavailable. New task acceptance is blocked. Existing tasks are retained.' : 'Each acceptance creates at most one local task. Prerequisites require their own review first.'), $('p', 'field-help', `Exact preview SHA-256: ${preview.data.preview_hash}. ${preview.counts.accepted} already accepted; ${preview.counts.pending_recovery} interrupted acceptances.`));
    const source = $('details'); source.append($('summary', '', 'Inspect exact selected learning plan/source pins'), $('pre', 'source-text', JSON.stringify(preview.data.preview, null, 2))); detail.append(source);
    for (const row of preview.rows) {
      const group = $('div', 'review-row'); group.append($('strong', '', `${row.topic_id}: ${row.task.title}`), $('p', 'field-help', `${row.state.replaceAll('_', ' ')} · ${deadlineText(row.task.deadline)} · ${row.task.effort_minutes === null ? 'Unknown effort' : `${row.task.effort_minutes} estimated minutes`} · course ${row.task.course_label || 'not supplied'}`), $('p', 'field-help', `Task SHA-256: ${row.task_hash}`));
      if (row.dependency_pins.length) group.append($('p', 'field-help', `Existing local prerequisites: ${row.dependency_pins.map(pin => `${pin.topic_id} (${pin.task_id}, revision ${pin.task_revision})`).join('; ')}`));
      for (const blocker of row.blockers) group.append($('p', 'notice', `${blocker.topic_id}: ${blocker.reason.replaceAll('_', ' ')}`));
      if (row.completed_prerequisites.length) group.append($('p', 'field-help', `Student-reported completed prerequisites: ${row.completed_prerequisites.map(item => item.topic_id).join(', ')}. This does not establish mastery.`));
      if (row.accepted_task) group.append($('p', 'notice', row.accepted_task.unavailable ? `Earlier task ${row.accepted_task.id} was removed. It will not be recreated.` : `Local task ${row.accepted_task.id}, revision ${row.accepted_task.revision}, ${row.accepted_task.status}${row.accepted_task.changed ? ' — manually changed since handoff' : ''}.`));
      if ((!preview.stale && row.selectable) || row.state === 'acceptance_pending') {
        const form = $('form', 'career-form'), check = $('input'); check.type = 'checkbox'; check.checked = false; const label = $('label', 'field-help', row.state === 'acceptance_pending' ? 'Recover this exact reviewed task only; create nothing else' : 'I reviewed this exact title, source deadline, effort and prerequisites and want this one local task'); label.append(check); form.append(label);
        const accept = button(row.state === 'acceptance_pending' ? 'Recover this reviewed task' : 'Accept this one study task'); accept.type = 'submit'; form.append(accept); group.append(form);
        form.addEventListener('submit', event => { event.preventDefault(); action(accept, async () => {
          if (state.current !== preview) return; if (!check.checked) throw new Error('Review and check this exact task before accepting it. No task was created.');
          const generation = state.generation; if (confirmAction && !await confirmAction(`Create only “${row.task.title}” as a local study task? ${deadlineText(row.task.deadline)}. Planned study blocks are not deadlines. This does not mark it completed or establish mastery.`, { confirmLabel: row.state === 'acceptance_pending' ? 'Recover reviewed task' : 'Create this one local task' })) return;
          if (generation !== state.generation || state.current !== preview) return;
          const result = await request(`/plan-tasks/previews/${preview.id}/accept`, { method: 'POST', body: { expected_revision: preview.revision, preview_hash: preview.data.preview_hash, topic_id: row.topic_id, task_hash: row.task_hash, confirmed: true } });
          if (generation !== state.generation || state.current !== preview) return; show(result.preview); await refresh(); if (generation === state.generation) notice(result.task.unavailable ? 'The existing reviewed task was removed; it was not recreated.' : `Verified local study task ${result.task.id}. ${result.task_effects} new task effect; other topics require separate review.`);
        }); });
      }
      detail.append(group);
    }
    const receipts = $('details'); receipts.append($('summary', '', 'Inspect durable acceptance receipt references'), $('pre', 'source-text', JSON.stringify(preview.data.accepts, null, 2))); detail.append(receipts);
    const reopen = button('Recheck this exact task preview'); detail.append(reopen); reopen.addEventListener('click', () => action(reopen, async () => { if (state.current !== preview) return; const generation = state.generation, result = await request(`/plan-tasks/previews/${preview.id}`); if (generation === state.generation && state.current === preview) show(result.preview); }));
    const forget = button('Forget this handoff preview'); detail.append(forget); forget.addEventListener('click', () => action(forget, async () => { if (state.current !== preview) return; const generation = state.generation;
      const result = await request(`/plan-tasks/previews/${preview.id}`, { method: 'DELETE', body: { expected_revision: preview.revision, preview_hash: preview.data.preview_hash } }); if (generation !== state.generation || state.current !== preview) return; state.selection++; clear(); await refresh(); if (generation === state.generation) notice(result.retention);
    }));
  }
  async function refresh() {
    const generation = state.generation, data = await request('/plan-tasks/state'); if (generation !== state.generation) return;
    plans.replaceChildren($('h2', '', 'Already accepted catch-up plans')); if (!data.plans.length) plans.append($('p', 'field-help', 'First prepare and explicitly accept a catch-up plan in Learning. No plan will be accepted automatically here.'));
    for (const plan of data.plans) { const group = $('div', 'review-row'); group.append($('strong', '', plan.title), $('p', 'field-help', plan.stale ? plan.reason : `${plan.topics} selected topics · revision ${plan.revision}`)); plans.append(group); if (plan.stale) continue;
      const open = button('Inspect this accepted plan'); group.append(open); open.addEventListener('click', () => action(open, async () => { const generation = state.generation, selection = ++state.selection; clear(); const result = await request(`/plan-tasks/plans/${plan.id}`); if (generation === state.generation && selection === state.selection) inspect(result); })); }
    previews.replaceChildren($('h2', '', 'Saved task handoff previews')); if (!data.previews.length) previews.append($('p', 'field-help', 'No handoff preview saved.'));
    for (const preview of data.previews) { const group = $('div', 'review-row'), open = button('Open this task preview'); group.append($('strong', '', preview.title), $('p', 'field-help', `${preview.stale ? 'Stale source' : 'Current source'} · ${preview.counts.accepted} accepted · ${preview.counts.awaiting_review} ready for review`), open); previews.append(group);
      open.addEventListener('click', () => action(open, async () => { const generation = state.generation, selection = ++state.selection; clear(); const result = await request(`/plan-tasks/previews/${preview.id}`); if (generation === state.generation && selection === state.selection) show(result.preview); })); }
    if (state.current && !data.previews.some(row => row.id === state.current.id && row.revision === state.current.revision && row.stale === state.current.stale && row.counts.awaiting_review === state.current.counts.awaiting_review)) { state.generation++; clear(); notice('The plan, preview or prerequisites changed. Reopen the exact current preview before acceptance.'); }
  }
  return { refresh, reset() { state.generation++; state.selection++; clear(); state.preparation = null; plans.replaceChildren(); previews.replaceChildren(); notice(''); } };
}
