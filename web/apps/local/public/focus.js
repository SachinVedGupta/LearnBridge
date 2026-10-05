export function mountFocusUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, cls = '', text = '') => element(tag, cls, text), state = { ready: false, generation: 0, selection: 0, tasks: [], sessions: [], attempts: new Map() };
  const active = new WeakSet(); let serial = 0, poll = null;
  const status = $('p', 'notice'); status.id = 'focus-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Choose an intentional focus timer. Recorded duration counts only observed intervals while LearnBridge is running. Long sleep gaps and restart downtime are excluded. A timer does not prove attention, learning, mastery or productivity. Notifications stay inside this app.'), status);
  const panel = (title, help) => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; };
  const button = caption => { const node = $('button', 'button secondary compact', caption); node.type = 'button'; return node; };
  const createPanel = panel('Start one focus timer', 'A planned duration is an intention, not earned focus time. One open session is allowed. Pause, end or discard the existing session before starting another. Tasks are optional and never automatically completed.');
  const form = $('form', 'career-form'); createPanel.append(form);
  function field(label, inputId, type, value) { const wrapper = $('label', '', label), input = $('input'); input.id = inputId; input.type = type; input.value = value; wrapper.htmlFor = inputId; form.append(wrapper, input); input.addEventListener('input', () => { state.selection++; }); return input; }
  const title = field('Focus on', 'focus-title', 'text', ''), minutes = field('Planned minutes', 'focus-minutes', 'number', '25'), timezone = field('Time zone', 'focus-timezone', 'text', Intl.DateTimeFormat().resolvedOptions().timeZone); minutes.min = '1'; minutes.max = '240'; title.maxLength = 300;
  const taskLabel = $('label', '', 'Optional local task'), task = $('select'); task.id = 'focus-task'; taskLabel.htmlFor = task.id; form.append(taskLabel, task); task.addEventListener('change', () => { state.selection++; });
  const start = button('Review and start focus'), reload = button('Refresh focus sessions'); start.type = 'submit'; start.disabled = reload.disabled = true; form.append(start); createPanel.append(reload);
  const sessionsPanel = panel('Current session and history', 'The runtime saves observations about every 30 seconds and on a reviewed pause/end. The current interval is provisional until saved. Sleep, restart or clock changes require recovery review; excluded gaps are never automatically added. Paused time stays excluded.'); const sessions = $('div'); sessionsPanel.append(sessions);
  const current = generation => state.ready && state.generation === generation;
  async function action(target, operation) {
    if (!state.ready || active.has(target)) return; active.add(target); const generation = state.generation;
    try { await busy(target, () => current(generation) ? operation(generation) : undefined); }
    catch (error) { if (current(generation)) notice(error.message || 'This timer changed. Refresh and review its current state.', true); }
    finally { active.delete(target); if (!current(generation)) target.disabled = true; }
  }
  const input = () => { const planned_minutes = Number(minutes.value); if (!title.value.trim() || !Number.isInteger(planned_minutes) || planned_minutes < 1 || planned_minutes > 240 || !timezone.value.trim()) throw new Error('Enter a title, 1–240 planned minutes and a time zone.'); return { title: title.value.trim(), planned_minutes, timezone: timezone.value.trim(), task_id: task.value || null, confirmed: true }; };
  form.addEventListener('submit', event => { event.preventDefault(); action(start, async generation => {
    const body = input(), selection = state.selection, key = JSON.stringify(body);
    const approved = await confirmAction(`Start a ${body.planned_minutes}-minute planned focus timer for “${body.title}”? Only observed runtime intervals are recorded. The optional task will not be completed or edited.`, { title: 'Review focus start', confirmLabel: 'Start this timer' });
    if (!approved || !current(generation) || selection !== state.selection || JSON.stringify(input()) !== key) return;
    if (!state.attempts.has(key)) state.attempts.set(key, crypto.randomUUID()); const result = await request('/focus/sessions', { method: 'POST', body, idempotencyKey: state.attempts.get(key) });
    if (!current(generation)) return; state.attempts.delete(key); title.value = ''; await refresh(); if (current(generation)) notice(result.item.data.state === 'running' ? 'Focus timer started. The planned duration is not credited time.' : 'The earlier exact start is already saved. Its current state is shown.');
  }); });
  reload.addEventListener('click', () => action(reload, () => refresh()));
  const duration = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  // Periodic observations may advance elapsed time/revision during a review.
  // A different human operation/state or immutable timer identity still cancels it.
  const reviewIdentity = row => JSON.stringify({ id: row.id, state: row.data.state, title: row.data.title, planned_minutes: row.data.planned_minutes,
    timezone: row.data.timezone, started_at: row.data.started_at, task_ref: row.data.task_ref, last_receipt: row.data.last_receipt });
  function render() {
    sessions.replaceChildren(); if (!state.sessions.length) sessions.append($('p', 'field-help', 'No focus sessions recorded.'));
    for (const row of state.sessions) {
      const data = row.data, card = $('article', 'review-row'); card.append($('h3', '', data.title), $('p', '', `${data.state} · recorded ${duration(data.observed_active_ms)} · planned ${data.planned_minutes} min · ${data.timezone}`));
      if (data.state === 'running') card.append($('p', 'field-help', `Current unsaved interval: ${duration(row.pending_interval_ms)}. This does not certify attention or learning.`));
      if (row.needs_recovery) card.append($('p', 'notice', 'Recovery review needed. Unobserved time is excluded. Resume with a new interval, end using only recorded time, or discard this session.'));
      if (data.last_gap) card.append($('p', 'field-help', `Last interruption: ${data.last_gap.reason.replaceAll('_', ' ')} at ${data.last_gap.observed_at}. No absent time is awarded.`));
      if (data.task_ref) card.append($('p', 'field-help', `Associated task: ${data.task_ref.title}${row.task_changed ? ' · task since changed or unavailable; its edits are preserved' : ''}. Timer actions do not complete it.`));
      const history = $('details'); history.append($('summary', '', 'Recorded observations and exact session metadata'), $('pre', 'context-preview', JSON.stringify({ observed_active_ms: data.observed_active_ms, observations: data.observations, interval_count: data.interval_count, task_ref: data.task_ref, last_gap: data.last_gap, last_receipt: data.last_receipt }, null, 2))); card.append(history);
      if (['running', 'paused', 'interrupted'].includes(data.state)) {
        const operations = data.state === 'running' ? [['pause', 'Pause this focus timer']] : [['resume', 'Resume this focus timer']]; operations.push(['end', 'End this focus session'], ['discard', 'Discard this focus session']);
        for (const [operation, caption] of operations) {
          const control = button(caption); card.append(control); control.addEventListener('click', () => action(control, async generation => {
            const approved = await confirmAction(`${caption} for “${data.title}”? Recorded time is ${duration(data.observed_active_ms)}${data.state === 'running' ? ' plus a bounded current interval' : ''}. ${operation === 'resume' ? 'Sleep and downtime remain excluded.' : operation === 'discard' ? 'Keep its private history labelled discarded; no completion is credited.' : 'No task is completed, source changed or attention verified.'}`, { title: 'Review focus timer', confirmLabel: caption });
            if (!approved || !current(generation) || !state.sessions.some(item => reviewIdentity(item) === reviewIdentity(row))) return;
            const latest = (await request(`/focus/sessions/${row.id}`)).item;
            if (!current(generation) || reviewIdentity(latest) !== reviewIdentity(row) || !state.sessions.some(item => reviewIdentity(item) === reviewIdentity(row))) return;
            const result = await request(`/focus/sessions/${row.id}/${operation}`, { method: 'POST', body: { expected_revision: latest.revision, session_hash: latest.session_hash, confirmed: true } });
            if (!current(generation)) return; await refresh(); if (current(generation)) notice(result.item.needs_recovery ? 'An unobserved gap was excluded. Review the recovered timer before resuming or ending.' : `Timer is ${result.item.data.state}. Only recorded observed time is retained.`);
          }));
        }
      }
      sessions.append(card);
    }
  }
  async function refresh() {
    const generation = state.generation, version = ++serial, selectedTask = task.value;
    const [context, saved] = await Promise.all(['/focus/context', '/focus/sessions'].map(path => request(path)));
    if (generation !== state.generation || version !== serial) return;
    state.ready = true; state.tasks = context.tasks; state.sessions = saved.items;
    task.replaceChildren(); const empty = $('option', '', 'No associated task'); empty.value = ''; task.append(empty);
    for (const row of state.tasks) { const option = $('option', '', row.title); option.value = row.id; task.append(option); } task.value = state.tasks.some(row => row.id === selectedTask) ? selectedTask : '';
    start.disabled = Boolean(context.open_session); reload.disabled = false; render();
    if (poll === null) { poll = setInterval(() => { if (state.ready) refresh().catch(error => { if (current(generation)) notice(error.message || 'Refresh the current timer before continuing.', true); }); }, 30000); poll.unref?.(); }
  }
  function reset() { state.generation++; state.selection++; serial++; state.ready = false; state.tasks = []; state.sessions = []; state.attempts.clear(); if (poll !== null) clearInterval(poll); poll = null; sessions.replaceChildren(); task.replaceChildren(); task.value = ''; title.value = ''; start.disabled = reload.disabled = true; notice(''); }
  return { refresh, reset };
}
