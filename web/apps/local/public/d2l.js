/** Student-driven school connection. All source text is rendered literally. */
export function mountD2lUI({ root, request, element, busy, confirmAction, message, navigate }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const state = { generation: 0, selection: 0, observation: 0, connection: null, preview: null, capability: null, enabled: false };
  const activeControls = new Set();
  const status = $('p', 'notice'); status.id = 'd2l-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const heading = $('p', 'notice', 'Connect McMaster Avenue using a fresh school browser on this computer. Complete the official school login and MFA yourself. Select course IDs and the information you want to read. No passwords or tokens are entered into LearnBridge.');
  root.replaceChildren(heading, status);
  function button(text) { const value = $('button', 'button secondary', text); value.type = 'button'; return value; }
  function panel(title, help) { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; }
  function action(control, work) {
    const generation = state.generation; state.observation++; activeControls.add(control);
    busy(control, work).finally(() => { activeControls.delete(control); syncControls(); }).catch(error => { if (generation === state.generation) notice(error.message, true); });
  }
  const connectionPanel = panel('1. Sign in to your school', 'The visible Chrome window belongs to this connection. Closing or disconnecting it ends access; disconnect removes its temporary local profile. Your usual browser profile is not used.');
  const connectionInfo = $('p', 'notice'), start = button('Open official Avenue sign-in'), verify = button('Check my school sign-in'), disconnect = button('Disconnect school browser');
  connectionPanel.append(connectionInfo, start, verify, disconnect);
  const selectionPanel = panel('2. Choose course information', 'Find the course number at the end of its Avenue URL, such as /d2l/home/781264. Enter up to five course numbers. LearnBridge does not discover all your courses or open linked files.');
  const courseLabel = $('label', '', 'Course numbers, separated by commas'), courseIds = $('input'); courseIds.id = 'd2l-course-ids'; courseLabel.htmlFor = courseIds.id; courseIds.type = 'text'; courseIds.maxLength = 100;
  selectionPanel.append(courseLabel, courseIds); const choices = [];
  for (const [value, title] of [['assignments', 'Assignment folders and exact returned deadlines'], ['announcements', 'Course announcements'], ['materials', 'Content outline and descriptions']]) {
    const label = $('label', 'record-choice', title), input = $('input'); input.type = 'checkbox'; input.checked = false; input.value = value; input.id = `d2l-${value}`; label.htmlFor = input.id; selectionPanel.append(input, label); choices.push(input);
  }
  const read = button('Read only my selected courses'); selectionPanel.append(read);
  const reviewPanel = panel('3. Review before saving locally', 'A read prepares a preview only. Check the returned facts, dates, coverage, changed and missing items before saving them in Courses. This grants no model access and creates no tasks.'); reviewPanel.hidden = true;
  function invalidate() { state.selection++; state.preview = null; reviewPanel.replaceChildren(); reviewPanel.hidden = true; }
  courseIds.addEventListener('input', invalidate); for (const choice of choices) choice.addEventListener('change', invalidate);
  function syncControls() {
    start.disabled = !state.enabled || Boolean(state.connection) || state.capability?.state !== 'available' || activeControls.has(start);
    verify.disabled = !state.enabled || !state.connection || activeControls.has(verify);
    disconnect.disabled = !state.enabled || !state.connection || activeControls.has(disconnect);
    read.disabled = !state.enabled || state.connection?.state !== 'ready' || activeControls.has(read);
  }
  function showConnection(data) {
    state.observation++; state.connection = data.connection; state.capability = data.capability; state.enabled = true; syncControls();
    connectionInfo.textContent = data.connection?.account ? `School account: ${data.connection.account.display_name}. Check that this is your account. State: ${data.connection.state.replaceAll('_', ' ')}.`
      : data.connection ? 'Finish signing in in the separate school browser, then choose Check my school sign-in.' : data.capability.state === 'available' ? 'Ready to open your official school sign-in.' : 'This connection needs Google Chrome on macOS. Reviewed course exports remain available in Sources.';
  }
  async function refresh() { const generation = state.generation, observation = ++state.observation, data = await request('/d2l/status'); if (generation !== state.generation || observation !== state.observation) return; showConnection(data); }
  start.addEventListener('click', () => action(start, async () => { const generation = state.generation; const data = await request('/d2l/start', { method: 'POST', body: { institution_id: 'mcmaster-avenue' } }); if (generation !== state.generation) return; invalidate(); showConnection(data); notice('School browser opened. Complete the official sign-in and MFA yourself, then check the account here.'); }));
  verify.addEventListener('click', () => action(verify, async () => { const generation = state.generation, connectionId = state.connection?.id; const data = await request('/d2l/verify', { method: 'POST', body: { connection_id: connectionId } }); if (generation !== state.generation || state.connection?.id !== connectionId) return; invalidate(); showConnection(data); notice('Actual school account checked. Choose the courses and categories you want to read.'); }));
  disconnect.addEventListener('click', () => action(disconnect, async () => { const generation = state.generation, connectionId = state.connection?.id; const data = await request('/d2l/disconnect', { method: 'POST', body: { connection_id: connectionId } }); if (generation !== state.generation) return; invalidate(); await refresh(); if (generation === state.generation) notice(data.retention); }));
  read.addEventListener('click', () => action(read, async () => {
    const selected = courseIds.value.split(',').map(value => value.trim()).filter(Boolean), categories = choices.filter(value => value.checked).map(value => value.value);
    if (!selected.length || selected.length > 5 || new Set(selected).size !== selected.length || selected.some(value => !/^[1-9]\d{0,14}$/.test(value)) || !categories.length) throw new Error('Choose one to five distinct course numbers and at least one information category.');
    const generation = state.generation, selection = state.selection, connectionId = state.connection?.id;
    const data = await request('/d2l/preview', { method: 'POST', body: { connection_id: connectionId, selected_course_ids: selected, categories } });
    if (generation !== state.generation || selection !== state.selection || connectionId !== state.connection?.id) return;
    state.preview = data; reviewPanel.hidden = false; reviewPanel.replaceChildren($('h2', '', '3. Review these exact course facts'));
    const snapshot = data.snapshot; for (const category of ['courses', 'assignments', 'announcements', 'materials']) reviewPanel.append($('p', 'field-help', `${category}: ${snapshot[category].length} returned records · ${snapshot.coverage[category].state}`));
    for (const limit of data.limitations) reviewPanel.append($('p', 'notice', limit));
    const details = $('details'); details.append($('summary', '', 'Inspect every returned fact, deadline and change'), $('pre', 'source-text', JSON.stringify(data.refresh, null, 2))); reviewPanel.append(details);
    const reviewed = $('input'); reviewed.type = 'checkbox'; reviewed.checked = false; reviewed.id = 'd2l-reviewed'; const label = $('label', 'record-choice', 'I reviewed these exact facts, dates, changes, coverage and academic policy.'); label.htmlFor = reviewed.id; const save = button('Save reviewed course changes'); reviewPanel.append(reviewed, label, save);
    save.addEventListener('click', () => action(save, async () => {
      if (!reviewed.checked || state.preview !== data) throw new Error('Review the entire exact preview and check the review box before saving.');
      const savingGeneration = state.generation, savingSelection = state.selection;
      if (!await confirmAction('Save this exact reviewed preview to your private course library? Existing history is retained. Missing returned items do not delete tasks.', { confirmLabel: 'Save reviewed courses' })) return;
      if (savingGeneration !== state.generation || savingSelection !== state.selection || state.preview !== data) return;
      await request('/d2l/import', { method: 'POST', body: { preview_id: data.preview_id, review_hash: data.refresh.review_hash } });
      if (savingGeneration !== state.generation || savingSelection !== state.selection || state.preview !== data) return;
      invalidate(); notice('Exact reviewed course changes saved locally. Open Courses to use them; sharing with your agent remains a separate choice.');
    }));
    notice(data.proof === 'fixture' ? 'Synthetic test transport only. These results do not prove real school access.' : 'Selected school reads returned. Review them before saving.');
  }));
  const courses = button('Open course library'); root.append(courses); courses.addEventListener('click', () => navigate?.('courses'));
  function reset() { state.generation++; invalidate(); state.connection = null; state.enabled = false; courseIds.value = ''; for (const choice of choices) choice.checked = false; connectionInfo.textContent = ''; notice(''); syncControls(); }
  reset(); return { refresh, reset };
}
