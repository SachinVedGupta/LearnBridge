/** Durable task-linked host turns. Text is rendered literally, never as HTML. */
export function mountTaskAgentsUI({ root, request, element: el, busy, confirmAction, navigate, onPrepareApplication }) {
  let context, sessions = [], chosen = null, generation = 0, poll, attempt = null;
  const completionDrafts = new Map();
  const notice = el('p', 'notice'); notice.setAttribute('role', 'status');
  const composer = el('section', 'panel'), history = el('section', 'panel source-panel');
  const taskSelect = el('select'); taskSelect.id = 'task-agent-task';
  const instructions = el('textarea'); instructions.id = 'task-agent-instructions'; instructions.rows = 4; instructions.maxLength = 4000;
  instructions.value = 'Get started on this task now. Use my selected context to prepare a concrete useful draft or explain the next step. Tell me what you completed and what needs my review.';
  const notes = el('fieldset'); const start = el('button', 'button primary', 'Get started with agent'); start.type = 'button';
  const refreshButton = el('button', 'button secondary', 'Refresh sessions'); refreshButton.type = 'button';
  const resultList = el('div'); const label = (forId, title) => { const node = el('label', '', title); node.htmlFor = forId; return node; };
  composer.append(el('h2', '', 'Turn a next step into a working session'), el('p', 'field-help', 'This starts your local Codex subscription agent with the selected task and only the notes you choose. The agent works while this dashboard is open or in the background while the local runtime and paired session remain active. Results and proposed edits wait for your review.'), label(taskSelect.id, 'Task'), taskSelect,
    label(instructions.id, 'What should the agent do?'), instructions, notes, start, notice);
  history.append(el('h2', '', 'Your agent sessions'), refreshButton, resultList); root.append(composer, history);
  taskSelect.addEventListener('change', () => { chosen = taskSelect.value; attempt = null; delete start.dataset.previous; });
  instructions.addEventListener('input', () => { attempt = null; }); notes.addEventListener('change', () => { attempt = null; });
  const say = (message, error = false) => { notice.textContent = message; notice.classList.toggle('error', error); };
  const action = (title, handler, cls = 'button secondary compact') => { const button = el('button', cls, title); button.type = 'button'; button.addEventListener('click', () => busy(button, handler).catch(error => say(error.message, true))); return button; };
  function renderSessions() {
    resultList.replaceChildren();
    if (!sessions.length) resultList.append(el('p', 'field-help', 'No sessions yet. Choose one task to begin.'));
    for (const item of sessions) {
      const data = item.data, row = el('article', 'record-card'); row.dataset.sessionId = item.id;
      const stateLabels = { ready_for_review: 'Ready for your review', working: 'Agent is working', queued: 'Waiting to start', done: 'Done — you reviewed the result', needs_refresh: 'Task or source changed — start a fresh session', failed: 'Agent request failed', unknown_outcome: 'Interrupted — outcome needs checking', withheld: 'Permission ended', interrupted: 'Stopped' };
      row.append(el('h3', '', data.task_pin.title), el('p', 'task-meta', `${stateLabels[data.state] ?? data.state} · ${new Date(item.created_at).toLocaleString()}`));
      if (data.state === 'done') row.append(el('p', 'field-help', 'The result you reviewed is retained in local session history and backups. It does not establish an external submission.'));
      const transcript = el('details'); if (data.state === 'ready_for_review') transcript.open = true;
      transcript.append(el('summary', '', 'Open AI session'));
      if (data.instructions) transcript.append(el('p', 'field-help', `You asked: ${data.instructions}`));
      if (data.progress.length) { const steps = el('ul'); for (const step of data.progress) steps.append(el('li', '', `${step.tool.replace('learnbridge_', '').replaceAll('_', ' ')} · ${step.state}`)); transcript.append(steps); }
      if (data.result) transcript.append(el('pre', 'source-text', data.result));
      if (data.error_code) transcript.append(el('p', 'field-help', `Status: ${data.error_code}. Check Local AI or refresh your selection before retrying.`));
      if (!data.result && ['queued', 'working'].includes(data.state)) transcript.append(el('p', 'field-help', 'The answer will appear here after the agent finishes. Tool activity is shown as it happens.'));
      row.append(transcript);
      for (const preparation of data.application_preparation ?? []) row.append(el('p', 'field-help', `Application preparation: ${preparation.state.replaceAll('_', ' ')} · ${preparation.field_writes} reviewed text fields · application not submitted.`));
      if (data.source_current && onPrepareApplication) row.append(action('Prepare application in browser', async () => onPrepareApplication(item)));
      if (['queued', 'working'].includes(data.state)) row.append(action('Stop agent', async () => { await request(`/task-sessions/${item.id}/cancel`, { method: 'POST', body: { expected_revision: item.revision, turn_revision: data.turn_revision } }); await refresh(); }));
      if (data.state === 'ready_for_review') {
        row.append(action('Continue this session', async () => { chosen = data.task_pin.id; taskSelect.value = chosen; instructions.value = 'Continue from the previous result. '; instructions.focus(); start.dataset.previous = item.id; say('Add your follow-up instructions, then choose Get started. The previous approved result is included as context.'); }));
        row.append(action('Review proposed changes', async () => navigate('agents')));
        const evidence = el('input'); evidence.type = 'text'; evidence.maxLength = 1500; evidence.placeholder = 'What did you check to confirm this task is done?'; evidence.setAttribute('aria-label', `Completion evidence for ${data.task_pin.title}`); row.append(evidence);
        const evidenceKey = `${item.id}:${data.task_pin.revision}`; evidence.value = completionDrafts.get(evidenceKey) ?? '';
        evidence.addEventListener('input', () => completionDrafts.set(evidenceKey, evidence.value));
        row.append(action('Mark task done after review', async () => {
          const token = generation;
          if (!evidence.value.trim()) { say('Describe what you checked before marking this task done.', true); evidence.focus(); return; }
          const reviewedEvidence = evidence.value;
          if (!await confirmAction(`Mark “${data.task_pin.title}” done based on your review: ${reviewedEvidence}? A model answer by itself does not confirm a submission or external change. A copy of this reviewed result will remain in local session history and backups.`, { title: 'Review completion', confirmLabel: 'Mark done' })) return;
          if (token !== generation) return;
          await request(`/task-sessions/${item.id}/complete`, { method: 'POST', body: { expected_revision: item.revision, turn_revision: data.turn_revision, task_revision: data.task_pin.revision, evidence_note: reviewedEvidence, confirmed: true } });
          if (token !== generation) return;
          completionDrafts.delete(evidenceKey); if (await refresh()) say('Task marked done with your review evidence. A reviewed copy of the result remains in local session history.');
        }, 'button primary compact'));
      }
      resultList.append(row);
    }
  }
  async function refresh() {
    const token = ++generation; clearTimeout(poll);
    const [next, saved] = await Promise.all([request('/task-sessions/context'), request('/task-sessions')]);
    if (token !== generation) return false;
    context = next; sessions = saved.items; const selected = chosen || taskSelect.value;
    taskSelect.replaceChildren();
    for (const task of context.tasks.filter(task => !['completed', 'cancelled'].includes(task.status))) { const option = el('option', '', task.title); option.value = task.id; taskSelect.append(option); }
    if ([...taskSelect.options].some(option => option.value === selected)) taskSelect.value = selected;
    // Preserve optional selections across ordinary progress refreshes, but a
    // changed exact version becomes unchecked and must be selected again.
    const previouslyChecked = new Set([...notes.querySelectorAll('input:checked')].map(input => input.dataset.pin)); notes.replaceChildren(el('legend', '', 'Optional notes to share (nothing selected by default)'));
    for (const doc of context.documents) { const node = el('label', 'source-choice'), input = el('input'); input.type = 'checkbox'; input.value = doc.id; input.dataset.pin = `${doc.id}:${doc.revision}:${doc.sha256}`; input.checked = previouslyChecked.has(input.dataset.pin); node.append(input, el('span', '', `${doc.title} · revision ${doc.revision}`)); notes.append(node); }
    start.disabled = !taskSelect.options.length || !['available', 'requires_host'].includes(context.capability.state);
    if (!['available', 'requires_host'].includes(context.capability.state)) say('Connect your official ChatGPT subscription in Local AI before starting an agent.');
    renderSessions();
    if (sessions.some(row => ['queued', 'working'].includes(row.data.state))) poll = setTimeout(() => { refresh().catch(error => say(error.message, true)); }, 2000);
    return true;
  }
  start.addEventListener('click', () => busy(start, async () => {
    const token = generation;
    if (!context) return;
    const task = context.tasks.find(item => item.id === taskSelect.value); if (!task || !instructions.value.trim()) return say('Choose a task and give the agent instructions.', true);
    const selected = [...notes.querySelectorAll('input:checked')].map(input => context.documents.find(doc => doc.id === input.value)).map(doc => ({ id: doc.id, revision: doc.revision, sha256: doc.sha256 }));
    const body = { task_id: task.id, expected_revision: task.revision, documents: selected, instructions: instructions.value, confirmed: true, ...(start.dataset.previous ? { previous_session_id: start.dataset.previous } : {}) };
    if (!await confirmAction(`Share “${task.title}” (revision ${task.revision}) and ${selected.length} selected note(s) with Codex for up to 60 minutes, then start this instruction:\n${instructions.value}`, { title: 'Start a task agent', confirmLabel: 'Share and get started' })) return;
    if (token !== generation) return;
    const signature = JSON.stringify(body); if (!attempt || attempt.signature !== signature) attempt = { signature, key: `task-ui-${crypto.randomUUID()}` };
    const result = await request('/task-sessions', { method: 'POST', body, idempotencyKey: attempt.key }); attempt = null; delete start.dataset.previous;
    if (token !== generation) return;
    say(`Session ${result.item.data.state.replaceAll('_', ' ')}. You can leave it running and open its result below.`); await refresh();
  }).catch(error => { if (context) say(error.code === 'BUDGET_EXCEEDED' ? 'The selected task and notes are too large for one agent read. Choose fewer or shorter notes; this task’s source metadata also counts. Review a smaller selection and try again.' : error.message, true); }).finally(() => { if (!context) start.disabled = true; }));
  refreshButton.addEventListener('click', () => busy(refreshButton, refresh).catch(error => say(error.message, true)));
  function selectTask(id) { chosen = id; delete start.dataset.previous; attempt = null; if (taskSelect.options.length) taskSelect.value = id; }
  root.addEventListener('learnbridge-task-selected', event => selectTask(event.detail.task_id));
  function reset() { ++generation; clearTimeout(poll); sessions = []; context = null; chosen = null; attempt = null; completionDrafts.clear(); delete start.dataset.previous; start.disabled = true; resultList.replaceChildren(); notes.replaceChildren(); instructions.value = ''; say(''); }
  return { refresh, selectTask, reset, pause() { ++generation; clearTimeout(poll); } };
}
