export function mountRemindersUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, cls = '', text = '') => element(tag, cls, text), state = { tasks: [], schedules: [], inbox: [], generation: 0, ready: false, attempts: new Map() };
  const active = new WeakSet(); let taskFields = [], refreshSerial = 0;
  const noticeNode = $('p', 'notice'); noticeNode.id = 'reminders-status'; noticeNode.hidden = true; noticeNode.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(noticeNode.id, text, error) : (noticeNode.textContent = text, noticeNode.hidden = !text, noticeNode.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Opt in to reminders for exact tasks you choose. While your local LearnBridge runtime is running, it checks their recorded deadlines and saves updates in this local inbox. It does not send messages, read connected accounts, call AI, create new tasks or run while your laptop sleeps.'), noticeNode);
  const controls = $('section', 'panel source-panel'); controls.append($('h2', '', 'Selected task reminders')); root.append(controls);
  const form = $('form', 'career-form'); controls.append(form);
  function field(label, key, value, type = 'text') {
    const wrapper = $('label', '', label), input = $('input'); input.id = `reminders-${key}`; input.type = type; input.value = value; input.required = true; input.maxLength = 300; wrapper.append(input); form.append(wrapper); return input;
  }
  const title = field('Reminder name', 'title', 'My due tasks'), timezone = field('Fallback time zone for date-only tasks', 'timezone', Intl.DateTimeFormat().resolvedOptions().timeZone),
    minutes = field('Look ahead (minutes, 15 to 10080)', 'minutes', '1440', 'number'); minutes.min = '15'; minutes.max = '10080';
  form.append($('p', 'field-help', 'Exact deadlines use their recorded instant. Date-only tasks keep their recorded time zone, or this fallback; “due today” never means an invented due hour. Unknown dates and completed or cancelled tasks generate no reminders. Selected task changes are followed automatically.'));
  const taskPicker = $('fieldset'); taskPicker.append($('legend', '', 'Choose existing tasks (up to 50)')); form.append(taskPicker);
  const button = (text, primary = false) => { const node = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, text); node.type = 'button'; return node; };
  const save = button('Save paused reminder', true); save.type = 'submit'; save.disabled = true; form.append(save);
  const check = button('Check selected reminders now'), reload = button('Refresh reminder inbox'); controls.append(check, reload); check.disabled = reload.disabled = true;
  const runtimeStatus = $('p', 'field-help'); runtimeStatus.id = 'reminders-runtime-status'; controls.append(runtimeStatus);
  const schedulesPanel = $('section', 'panel source-panel'); schedulesPanel.append($('h2', '', 'Your reminder schedules')); const scheduleList = $('div'); schedulesPanel.append(scheduleList); root.append(schedulesPanel);
  const inboxPanel = $('section', 'panel source-panel'); inboxPanel.append($('h2', '', 'Local reminder inbox')); const inboxList = $('div'); inboxPanel.append(inboxList); root.append(inboxPanel);
  const snapshot = () => JSON.stringify({ title: title.value, task_ids: taskFields.filter(row => row.include.checked).map(row => row.task.id), timezone: timezone.value, due_within_minutes: Number(minutes.value) });
  async function action(target, operation) {
    if (!state.ready || active.has(target)) return; active.add(target);
    const generation = state.generation;
    try { await busy(target, () => current(generation) ? operation(generation) : undefined); }
    catch (error) { if (generation === state.generation) notice(error.message || 'The local reminder could not be saved. Refresh and review its current version.', true); }
    finally { active.delete(target); if (!state.ready || generation !== state.generation) target.disabled = true; }
  }
  function current(generation, record) { return state.ready && generation === state.generation && (!record || state.schedules.some(row => row.id === record.id && row.revision === record.revision)); }
  form.addEventListener('submit', event => { event.preventDefault(); action(save, async generation => {
    const payload = snapshot(), input = JSON.parse(payload); if (!input.task_ids.length || input.task_ids.length > 50) throw new Error('Choose between 1 and 50 existing tasks.');
    if (state.attempts.get(payload) === undefined) state.attempts.set(payload, crypto.randomUUID());
    await request('/reminders/schedules', { method: 'POST', body: input, idempotencyKey: state.attempts.get(payload) });
    if (!current(generation)) return; state.attempts.delete(payload); await refresh();
    if (current(generation)) notice('Reminder saved paused. Review its selected tasks and activate it when you want local inbox checks.');
  }); });
  check.addEventListener('click', () => action(check, async generation => {
    const result = await request('/reminders/check', { method: 'POST', body: { confirmed: true } }); if (!current(generation)) return;
    await refresh(); if (current(generation)) notice(`${result.notifications} new local reminder(s). Unchanged deadlines stay quiet.`);
  }));
  reload.addEventListener('click', () => action(reload, () => refresh()));
  function deadlineText(deadline, fallback) {
    if (deadline.precision === 'date') return `${deadline.date} (${deadline.timezone || fallback}; date only)`;
    if (deadline.precision === 'instant') return `${new Date(deadline.instant).toLocaleString(undefined, { timeZone: deadline.timezone || fallback })} (${deadline.timezone || fallback})`;
    return 'deadline unknown';
  }
  function renderTasks() {
    const chosen = new Set(taskFields.filter(row => row.include.checked).map(row => row.task.id)); taskPicker.replaceChildren($('legend', '', 'Choose existing tasks (up to 50)'));
    taskFields = state.tasks.map(task => { const wrapper = $('label', 'record-choice'), include = $('input'); include.type = 'checkbox'; include.checked = chosen.has(task.id); include.id = `reminders-task-${task.id}`;
      wrapper.append(include, $('span', '', `${task.title} · ${task.status} · ${deadlineText(task.deadline, timezone.value)}`)); taskPicker.append(wrapper); return { task, include }; });
    if (!taskFields.length) taskPicker.append($('p', 'field-help', 'Create or accept a task in Today first. Nothing is selected automatically.')); save.disabled = !state.ready || !taskFields.length;
  }
  function renderSchedules() {
    scheduleList.replaceChildren(); if (!state.schedules.length) scheduleList.append($('p', 'field-help', 'No schedules saved. New schedules start paused.'));
    for (const row of state.schedules) {
      const data = row.data, card = $('article', 'review-row'); card.append($('h3', '', row.title), $('p', 'field-help', `${data.state} · ${data.task_ids.length} selected tasks · ${data.due_within_minutes} minutes ahead · time zone ${data.timezone} · revision ${row.revision}`));
      for (const task of row.selected_tasks) card.append($('p', 'field-help', task.unavailable ? 'A selected task is unavailable; it is never replaced automatically.' : `${task.title}: ${deadlineText(task.deadline, data.timezone)} · ${task.status}`));
      card.append($('p', 'field-help', `${data.discarded_inbox_count} older inbox entries removed from the current schedule view. Workspace revision history and backups may retain previous entries.`));
      if (data.state !== 'cancelled') {
        for (const [nextState, caption] of [[data.state === 'active' ? 'paused' : 'active', data.state === 'active' ? 'Pause local reminders' : 'Activate local reminders'], ['cancelled', 'Cancel this schedule']]) {
          const change = button(caption); card.append(change);
          change.addEventListener('click', () => action(change, async generation => {
            const approved = await confirmAction(`${caption} for “${row.title}”? It follows only the ${data.task_ids.length} displayed tasks. ${nextState === 'active' ? 'While the local runtime runs, due-soon, due-today and overdue updates may appear in your local inbox.' : nextState === 'cancelled' ? 'Cancellation is permanent for this schedule. Saved inbox and history remain.' : 'Saved inbox entries remain; no new checks will publish while paused.'} No account, model or external service is accessed.`, { title: 'Review selected task reminder', confirmLabel: caption });
            if (!approved || !current(generation, row)) return;
            await request(`/reminders/schedules/${row.id}/state`, { method: 'POST', body: { expected_revision: row.revision, state: nextState, confirmed: true } });
            if (!current(generation)) return; await refresh(); if (current(generation)) notice(`Local reminder schedule ${nextState}.`);
          }));
        }
      }
      scheduleList.append(card);
    }
  }
  function renderInbox() {
    inboxList.replaceChildren(); if (!state.inbox.length) inboxList.append($('p', 'field-help', 'No local reminder updates yet. Paused schedules do not run.'));
    for (const event of state.inbox) {
      const card = $('article', 'review-row'); card.append($('h3', '', `${event.stage.replaceAll('_', ' ')}: ${event.task_title}`),
        $('p', 'field-help', `${event.schedule_title} · ${deadlineText(event.deadline, event.timezone)} · observed ${new Date(event.observed_at).toLocaleString(undefined, { timeZone: event.timezone })} · ${event.acknowledged_at ? 'acknowledged' : 'unread'}`),
        $('p', 'field-help', 'This is a snapshot of the task at the observed check time. Later edits or completion may change the task.'));
      if (!event.acknowledged_at) { const ack = button('Acknowledge this reminder'); card.append(ack); ack.addEventListener('click', () => action(ack, async generation => {
        await request(`/reminders/schedules/${event.schedule_id}/ack`, { method: 'POST', body: { expected_revision: event.schedule_revision, event_id: event.id } });
        if (current(generation)) await refresh();
      })); }
      inboxList.append(card);
    }
  }
  async function refresh() {
    const generation = state.generation, serial = ++refreshSerial;
    const [context, schedules, inbox, status] = await Promise.all(['/reminders/context', '/reminders/schedules', '/reminders/inbox', '/reminders/status'].map(path => request(path)));
    if (generation !== state.generation || serial !== refreshSerial) return;
    if (!state.ready) { title.value ||= 'My due tasks'; timezone.value ||= Intl.DateTimeFormat().resolvedOptions().timeZone; minutes.value ||= '1440'; }
    state.ready = !status.stopped; state.tasks = context.tasks; state.schedules = schedules.items; state.inbox = inbox.items;
    runtimeStatus.textContent = `Checks selected tasks every ${status.limits.tick_interval_ms / 1000} seconds while this runtime runs. Last check: ${status.last_check?.at || 'not observed yet'}. Delivery: this local inbox; operating-system and remote notifications are off.`;
    check.disabled = reload.disabled = !state.ready; renderTasks(); renderSchedules(); renderInbox();
  }
  function reset() {
    state.generation++; refreshSerial++; state.ready = false; state.tasks = []; state.schedules = []; state.inbox = []; state.attempts.clear(); taskFields = [];
    taskPicker.replaceChildren($('legend', '', 'Choose existing tasks (up to 50)')); scheduleList.replaceChildren(); inboxList.replaceChildren(); runtimeStatus.textContent = '';
    for (const control of [title, timezone, minutes]) control.value = ''; save.disabled = check.disabled = reload.disabled = true; notice('');
  }
  return { refresh, reset };
}
