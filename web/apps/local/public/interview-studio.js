export function mountInterviewStudioUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, cls = '', value = '') => element(tag, cls, value);
  const state = { ready: false, generation: 0, sessions: [], roles: [], facts: [], grants: [], selected: null, retries: new Map(), drafts: new Map() };
  let serial = 0, fields = [], poll = null, recognition = null, fieldId = 0;
  const active = new WeakSet(), status = $('p', 'notice'); status.id = 'interview-studio-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (value, error = false) => message ? message(status.id, value, error) : (status.textContent = value, status.hidden = !value, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Practice a real one-question-at-a-time interview with your official Codex subscription. Choose a saved posting and reviewed profile facts, review sharing, answer in your own words, and get feedback tied to your actual response. Coding answers are reviewed; this studio does not execute your code or predict hiring.'), status);
  const button = (value, primary = false) => { const node = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, value); node.type = 'button'; return node; };
  const panel = (title, help) => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title)); if (help) node.append($('p', 'field-help', help)); root.append(node); return node; };
  function field(parent, label, tag = 'input') { const wrapper = $('div'), labelNode = $('label', '', label), input = $(tag); input.id = `interview-studio-field-${++fieldId}`; labelNode.htmlFor = input.id; if (tag === 'textarea') { input.rows = 7; input.maxLength = 7000; input.className = 'career-textarea'; } wrapper.append(labelNode, input); parent.append(wrapper); return input; }
  function option(input, value, label) { const node = $('option', '', label); node.value = value; input.append(node); }
  function attempt(type, body) { const signature = JSON.stringify(body), prior = state.retries.get(type); if (prior?.signature === signature) return prior.key; const key = crypto.randomUUID(); state.retries.set(type, { signature, key }); return key; }
  function current(generation, record) { return state.ready && state.generation === generation && (!record || state.sessions.some(item => item.id === record.id && item.revision === record.revision)); }
  async function action(control, callback) { if (!state.ready || active.has(control)) return; active.add(control); const generation = state.generation; try { await busy(control, () => current(generation) ? callback(generation) : undefined); } catch (error) { if (current(generation)) notice(error.message, true); } finally { active.delete(control); if (!current(generation)) control.disabled = true; } }
  const review = record => ({ expected_revision: record.revision, context_hash: record.data.context_hash });
  const createPanel = panel('Set up an interview', 'Posting context stays local until you review an exact coaching note and allow a short-lived Codex selection. Nothing is selected by default. Choose a few relevant facts; if the selection is too large, uncheck details or choose a shorter reviewed posting excerpt and try again.');
  const form = $('form', 'career-form'); createPanel.append(form);
  const roleChoice = field(form, 'Saved posting to practice for', 'select'); roleChoice.required = true;
  const rolePreview = $('pre', 'source-text'); rolePreview.hidden = true; form.append(rolePreview);
  roleChoice.addEventListener('change', () => { const role = state.roles.find(row => row.id === roleChoice.value); rolePreview.hidden = !role; rolePreview.textContent = role ? `${role.title}\n${role.source_status}\n\n${role.excerpt}` : ''; });
  const mode = field(form, 'Interview style', 'select'); for (const [value, label] of [['behavioral', 'Behavioral'], ['technical', 'Technical discussion'], ['coding', 'Coding reasoning (no code execution)']]) option(mode, value, label);
  const count = field(form, 'Number of questions (1–10)'); count.type = 'number'; count.min = '1'; count.max = '10'; count.value = '3'; count.required = true;
  const factPicker = $('fieldset'); factPicker.append($('legend', '', 'Reviewed profile facts to include')); form.append(factPicker);
  const create = button('Create private interview', true); create.type = 'submit'; create.disabled = true; form.append(create);
  function createBody() { const role = state.roles.find(row => row.id === roleChoice.value); if (!role) throw new Error('Select a saved posting. Add one in Career or Find internships first.'); return { role_ref: { id: role.id, revision: role.revision, sha256: role.sha256 }, profile_refs: fields.filter(row => row.input.checked).map(({ fact }) => ({ id: fact.id, revision: fact.revision, fingerprint: fact.fingerprint })), mode: mode.value, round_limit: Number(count.value) }; }
  form.addEventListener('submit', event => { event.preventDefault(); action(create, async generation => {
    const body = createBody(), signature = JSON.stringify(body); if (!await confirmAction('Create this private interview using the exact selected posting and checked profile facts? This local action creates no sharing grant and sends nothing to Codex.', { title: 'Review interview context', confirmLabel: 'Create private interview' }) || !current(generation) || signature !== JSON.stringify(createBody())) return;
    const result = await request('/interview-studio/sessions', { method: 'POST', body, idempotencyKey: attempt('create', body) }); if (!current(generation)) return; state.retries.delete('create'); state.selected = result.item.id; await refresh(); if (current(generation)) notice('Interview saved. Review its coaching note before allowing model sharing.');
  }); });
  const savedPanel = panel('Your practice sessions', 'Questions, exact answers, feedback and linked AI sessions survive a restart. Interrupted requests are never replayed automatically.');
  const reload = button('Refresh interview studio'); savedPanel.append(reload); reload.addEventListener('click', () => action(reload, refresh));
  const capability = $('p', 'field-help'); savedPanel.append(capability); const list = $('div'); savedPanel.append(list);
  const currentPanel = panel('Current interview', 'The next question stays hidden until it is actually generated. Feedback reflects only the saved response, not overall mastery.'); currentPanel.hidden = true;
  const hostPanel = panel('Linked AI session', 'Only a verified host reply becomes a structured question or feedback. Invalid envelopes remain failed and never become a scored attempt.'); hostPanel.hidden = true;
  function stopVoice() { try { recognition?.abort(); } catch { /* The browser may already have stopped capture. */ } recognition = null; globalThis.speechSynthesis?.cancel(); }
  function speak(text, parent) {
    const read = button('Read aloud'), stop = button('Stop voice'); read.disabled = !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance;
    if (read.disabled) parent.append($('p', 'field-help', 'Read-aloud is unavailable in this browser. Text practice works normally.'));
    read.addEventListener('click', () => { stopVoice(); const utterance = new SpeechSynthesisUtterance(text); utterance.rate = 1; speechSynthesis.speak(utterance); }); stop.addEventListener('click', stopVoice); parent.append(read, stop);
  }
  function dictation(input, parent) {
    const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition, dictate = button('Dictate my answer'), stop = button('Stop microphone'); dictate.disabled = !Recognition; stop.disabled = true;
    parent.append($('p', 'field-help', Recognition ? 'Optional dictation uses your browser’s speech service, which may send audio to its provider. Start only if you want this. Review and edit the text before saving; recording never submits an answer.' : 'Dictation is unavailable in this browser. Type your answer instead.'), dictate, stop);
    dictate.addEventListener('click', () => action(dictate, async generation => {
      if (!await confirmAction('Use this browser’s microphone and speech recognition for this answer? Audio may be processed by the browser’s speech provider. Review the resulting text before saving.', { title: 'Optional interview dictation', confirmLabel: 'Start microphone' }) || !current(generation)) return;
      stopVoice(); const session = new Recognition(); recognition = session; session.continuous = true; session.interimResults = false; session.lang = navigator.language || 'en-US'; stop.disabled = false;
      session.onresult = event => { if (!current(generation) || recognition !== session) return; for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) { const next = `${input.value}${input.value ? '\n' : ''}${event.results[index][0].transcript}`; if (next.length <= input.maxLength) { input.value = next; input.dispatchEvent(new Event('input')); } } };
      session.onerror = () => { if (current(generation)) notice('Dictation stopped. Your existing typed answer is preserved.', true); };
      session.onend = () => { if (recognition === session) recognition = null; stop.disabled = true; }; session.start();
    })); stop.addEventListener('click', () => { try { recognition?.stop(); } catch {} recognition = null; stop.disabled = true; });
  }
  async function showHost(record, generation) {
    const id = record.data.pending?.turn_id || record.data.rounds.at(-1)?.feedback_origin?.turn_id || record.data.rounds.at(-1)?.question_origin?.turn_id; if (!id) return;
    const result = await request(`/host-turns/${id}`); if (!current(generation)) return; const turn = result.item; hostPanel.hidden = false; hostPanel.replaceChildren($('h2', '', `AI session · ${turn.data.state.replaceAll('_', ' ')}`), $('p', 'field-help', `Session ${turn.id} · ${turn.data.visibility}`));
    if (turn.data.prompt) hostPanel.append($('details')); const details = hostPanel.lastChild;
    if (turn.data.prompt) details.append($('summary', '', 'Exact reviewed host request'), $('pre', 'source-text', turn.data.prompt));
    if (turn.data.text) hostPanel.append($('pre', 'source-text', turn.data.text));
    hostPanel.append($('pre', 'source-text', JSON.stringify({ progress: turn.data.progress, receipts: turn.data.tool_receipts, error_code: turn.data.error_code }, null, 2))); hostPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function renderCurrent() {
    const record = state.sessions.find(row => row.id === state.selected); currentPanel.hidden = !record; if (!record) return; stopVoice();
    const data = record.data; currentPanel.replaceChildren($('h2', '', record.title), $('p', 'field-help', `${data.mode} · ${data.state.replaceAll('_', ' ')} · ${data.rounds.length}/${data.round_limit} questions generated · revision ${record.revision}`));
    if (record.stale) { currentPanel.append($('p', 'notice error', 'Selected posting or profile evidence changed. Cached model text is withheld; create a fresh interview from current selections.')); return; }
    const context = $('details'); context.append($('summary', '', 'Review exact local context'), $('pre', 'source-text', JSON.stringify(data.context, null, 2))); currentPanel.append(context);
    if (!data.context_note) { const exportNote = button('Create exact private coaching note', true); currentPanel.append(exportNote); exportNote.addEventListener('click', () => action(exportNote, async generation => {
      if (!await confirmAction('Save this exact selected posting and reviewed profile context as a private note? It remains local and may persist in database history and backups. Sharing is a separate action.', { title: 'Review coaching note', confirmLabel: 'Create private note' }) || !current(generation, record)) return;
      await request(`/interview-studio/sessions/${record.id}/export-context`, { method: 'POST', body: review(record) }); if (current(generation)) await refresh();
    })); return; }
    currentPanel.append($('p', 'field-help', `Coaching note: ${data.context_note.title} · revision ${data.context_note.revision}`));
    const validGrants = state.grants.filter(grant => grant.destination === 'codex' && grant.state === 'active' && Date.parse(grant.expires_at) > Date.now() && !grant.pins.tasks.length && !grant.pins.source_entries.length && grant.pins.documents.length === 1 && grant.pins.documents[0].id === data.context_note.id);
    const allow = button(validGrants.length ? 'Review a fresh sharing selection' : 'Allow this exact note for Codex', true); currentPanel.append(allow); allow.addEventListener('click', () => action(allow, async generation => {
      if (!await confirmAction(`Allow your official Codex host to process ONLY “${data.context_note.title}” for 30 minutes, with a 256,000-byte total read budget? This includes the displayed posting and selected profile facts. Interview answers require a separate Send review for each turn.`, { title: 'Review exact interview sharing', confirmLabel: 'Allow selected note' }) || !current(generation, record)) return;
      const note = data.context_note; await request('/agent-grants', { method: 'POST', body: { destination: 'codex', task_ids: [], document_ids: [note.id], source_entry_ids: [], expected_records: { tasks: [], documents: [{ id: note.id, revision: note.revision }], source_entries: [] }, max_bytes: 256000, expires_in_minutes: 30 } }); if (current(generation)) await refresh();
    }));
    if (record.model_output_withheld) currentPanel.append($('p', 'notice error', 'A model question or feedback is withheld because its sharing selection expired or was revoked. Your actual answers remain local; start a fresh interview to continue with a new selection.'));
    for (const round of data.rounds) {
      const card = $('article', 'review-row'); card.append($('h3', '', `${round.id.replace('round-', 'Question ')}: ${round.question?.question || 'Model question withheld'}`));
      if (round.question) { card.append($('p', 'field-help', `Focus: ${round.question.focus} · selected evidence ${round.question.source_refs.join(', ')}`)); speak(round.question.question, card); }
      if (round.answer) card.append($('h3', '', 'Your exact answer'), $('pre', 'source-text', round.answer.text), $('p', 'field-help', `Saved ${new Date(round.answer.answered_at).toLocaleString()} · this attempt remains unassessed for code execution.`));
      if (round.feedback) {
        card.append($('h3', '', 'AI coaching on this response'), $('p', '', round.feedback.summary)); for (const item of round.feedback.strengths) card.append($('p', '', `Strength: ${item}`)); for (const item of round.feedback.improvements) card.append($('p', '', `Try next: ${item}`));
        for (const row of round.feedback.rubric) card.append($('p', 'field-help', `${row.dimension}: ${row.assessment.replaceAll('_', ' ')}. ${row.reason}${row.evidence_quote ? ` Evidence from your answer: “${row.evidence_quote}”` : ''}`));
        speak(round.feedback.summary, card);
      }
      currentPanel.append(card);
    }
    const last = data.rounds.at(-1), running = data.pending?.state === 'running';
    if (running) currentPanel.append($('p', 'notice', `Codex is preparing ${data.pending.phase}. This session is saved; you can return later while the local runtime stays on.`));
    else if (data.pending && data.pending.state !== 'completed') currentPanel.append($('p', 'notice error', `Previous AI request: ${data.pending.state.replaceAll('_', ' ')}${data.pending.error_code ? ` (${data.pending.error_code})` : ''}. Review a fresh request to retry; no automatic replay occurred.`));
    if (data.state === 'ready' && last && !last.answer && last.question && !running) {
      const answerForm = $('form', 'career-form'); answerForm.append($('h3', '', 'Your response')); const answer = field(answerForm, 'Answer in your own words', 'textarea'); answer.required = true; answer.value = state.drafts.get(`${record.id}:${last.id}`) || ''; answer.addEventListener('input', () => state.drafts.set(`${record.id}:${last.id}`, answer.value)); dictation(answer, answerForm);
      const save = button('Save my exact answer', true); save.type = 'submit'; answerForm.append(save); currentPanel.append(answerForm);
      answerForm.addEventListener('submit', event => { event.preventDefault(); action(save, async generation => {
        const body = { ...review(record), round_id: last.id, student_answer: answer.value }; stopVoice();
        await request(`/interview-studio/sessions/${record.id}/answer`, { method: 'POST', body }); if (!current(generation)) return; state.drafts.delete(`${record.id}:${last.id}`); await refresh(); if (current(generation)) notice('Exact answer saved locally. Review the next request to share it with Codex for coaching.');
      }); });
    }
    if (data.state === 'ready' && !running && (!last || last.answer) && !record.model_output_withheld) {
      const send = button(last && !last.feedback ? 'Review AI feedback request' : 'Review next AI question', true); send.disabled = !validGrants.length; currentPanel.append(send);
      if (!validGrants.length) currentPanel.append($('p', 'field-help', 'Allow the exact coaching note first. Check Local AI if your official host is not signed in.'));
      send.addEventListener('click', () => action(send, async generation => {
        const preview = await request(`/interview-studio/sessions/${record.id}/preview-run`, { method: 'POST', body: review(record) }); if (!current(generation, record)) return;
        const body = { ...review(record), grant_id: validGrants.at(-1).id, prompt_sha256: preview.item.prompt_sha256, confirmed: true };
        if (!await confirmAction(`Send this exact ${preview.item.phase} request to your official Codex host using ONLY the selected coaching note?\n\n${preview.item.prompt}`, { title: 'Review exact Codex request', confirmLabel: 'Send this request' }) || !current(generation, record)) return;
        await request(`/interview-studio/sessions/${record.id}/run`, { method: 'POST', body, idempotencyKey: attempt(`run-${record.id}`, body) }); if (!current(generation)) return; state.retries.delete(`run-${record.id}`); await refresh();
      }));
    }
    const open = button('Open linked AI session'); open.disabled = !data.pending?.turn_id && !last?.question_origin; currentPanel.append(open); open.addEventListener('click', () => action(open, generation => showHost(record, generation)));
    for (const [name, label] of data.state === 'paused' ? [['resume', 'Resume interview']] : data.state === 'ready' ? [['pause', running ? 'Stop AI and pause interview' : 'Pause interview'], ['finish', 'Finish early']] : []) {
      const transition = button(label); currentPanel.append(transition); transition.addEventListener('click', () => action(transition, async generation => {
        if (!await confirmAction(`${label}? Your saved questions and exact answers remain. ${running ? 'The active AI request will be interrupted, with no automatic replay.' : ''}`, { title: 'Review interview checkpoint', confirmLabel: label }) || !current(generation, record)) return;
        stopVoice(); await request(`/interview-studio/sessions/${record.id}/transition`, { method: 'POST', body: { ...review(record), action: name } }); if (current(generation)) await refresh();
      }));
    }
  }
  function render() {
    const chosenRole = roleChoice.value, selectedFacts = new Set(fields.filter(row => row.input.checked).map(row => row.fact.id)); roleChoice.replaceChildren(); option(roleChoice, '', 'Choose a saved posting'); for (const role of state.roles) option(roleChoice, role.id, `${role.company}: ${role.title} · ${role.source_status.replaceAll('_', ' ')}`); if (state.roles.some(row => row.id === chosenRole)) roleChoice.value = chosenRole;
    fields = []; factPicker.replaceChildren($('legend', '', 'Reviewed profile facts to include'));
    for (const fact of state.facts) { const wrapper = $('label', 'record-choice'), input = $('input'); input.type = 'checkbox'; input.checked = selectedFacts.has(fact.id); input.id = `interview-studio-fact-${fact.id}`; wrapper.append(input, $('span', '', `${fact.data.field}: ${fact.data.value}`)); factPicker.append(wrapper); fields.push({ fact, input }); }
    if (!fields.length) factPicker.append($('p', 'field-help', 'No current career profile facts. Add and confirm experience in Profile, or practice using the selected posting alone.'));
    create.disabled = !state.ready || !state.roles.length; capability.textContent = state.capability?.detail || 'Official host status unavailable.'; list.replaceChildren();
    for (const record of state.sessions) { const row = $('article', 'review-row'), open = button('Open practice'); row.append($('h3', '', record.title), $('p', 'field-help', `${record.data.state.replaceAll('_', ' ')} · ${record.data.rounds.filter(round => round.answer).length} actual responses · ${record.stale ? 'sources changed' : record.data.pending?.state || 'not started'}`), open); open.addEventListener('click', () => { state.selected = record.id; hostPanel.hidden = true; renderCurrent(); currentPanel.scrollIntoView({ block: 'start' }); }); list.append(row); }
    if (!state.sessions.length) list.append($('p', 'field-help', 'No interview sessions yet.')); renderCurrent();
  }
  async function refresh() {
    const generation = state.generation, ownSerial = ++serial; const [data, grants] = await Promise.all([request('/interview-studio/state'), request('/agent-grants')]); if (generation !== state.generation || ownSerial !== serial) return;
    state.ready = true; state.sessions = data.sessions; state.roles = data.roles; state.facts = data.facts; state.capability = data.capability; state.grants = grants.items; render(); clearTimeout(poll);
    if (data.sessions.some(row => row.data.pending?.state === 'running')) poll = setTimeout(() => { if (current(generation)) refresh().catch(error => notice(error.message, true)); }, 1800);
  }
  function reset() { state.generation++; serial++; clearTimeout(poll); poll = null; stopVoice(); state.ready = false; state.sessions = []; state.roles = []; state.facts = []; state.grants = []; state.selected = null; state.retries.clear(); state.drafts.clear(); fields = []; list.replaceChildren(); factPicker.replaceChildren($('legend', '', 'Reviewed profile facts to include')); roleChoice.replaceChildren(); rolePreview.textContent = ''; rolePreview.hidden = true; currentPanel.replaceChildren(); currentPanel.hidden = true; hostPanel.replaceChildren(); hostPanel.hidden = true; create.disabled = true; notice(''); }
  return { refresh, reset, pause() { state.generation++; serial++; clearTimeout(poll); stopVoice(); } };
}
