export function mountRemoteUI({ root, request, element, busy, confirmAction, navigate }) {
  const $ = (tag, cls, text) => element(tag, cls, text);
  const state = { generation: 0, pollEpoch: 0, status: null, jobs: [], results: [], writing: [], grants: [], preview: null, timer: null };
  const foreground = () => root.hidden !== true && globalThis.document?.hidden !== true;
  const notice = $('p', 'notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
  root.replaceChildren($('p', 'notice', 'Optional phone access uses the LearnBridge HTTPS relay. Pairing and selected-source permission are separate from setup. Keep this page open for foreground polling. Result text is sent only after your exact local review.'), notice);
  const status = $('p', 'field-help'); root.append(status);
  const setMessage = (text, error = false) => { notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', error); };
  const button = text => { const node = $('button', 'button secondary', text); node.type = 'button'; return node; };
  const action = (node, callback) => busy(node, callback).catch(error => setMessage(error.message, true)).finally(applyControls);
  const section = title => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title)); root.append(node); return node; };
  let index = 0;
  const field = (parent, label, type = 'text') => { const wrapper = $('div'), input = $(type === 'textarea' ? 'textarea' : 'input', type === 'textarea' ? 'career-textarea' : ''), name = $('label', '', label);
    input.id = `remote-field-${++index}`; name.htmlFor = input.id; if (type !== 'textarea') input.type = type; wrapper.append(name, input); parent.append(wrapper); return input; };
  const select = (parent, label) => { const wrapper = $('div'), name = $('label', '', label), input = $('select'); input.id = `remote-field-${++index}`; name.htmlFor = input.id; wrapper.append(name, input); parent.append(wrapper); return input; };
  const options = (select, rows, label) => { const previous = select.value; select.replaceChildren(); const empty = $('option', '', label); empty.value = ''; select.append(empty);
    for (const row of rows) { const node = $('option', '', row.label); node.value = row.id; select.append(node); } select.value = rows.some(row => row.id === previous) ? previous : ''; };
  const pairing = section('1. Pair this computer with your phone'), code = field(pairing, 'Paste the pairing JSON from your signed-in phone', 'textarea'); code.maxLength = 1000;
  const grant = select(pairing, 'Select a current Codex sharing grant'), native = field(pairing, 'Allow scoped study requests to run the verified local Codex adapter', 'checkbox');
  pairing.append($('p', 'field-help', 'The relay can read submitted prompts. Source bodies stay local. Each response needs another review before it is sent. Pairing lasts up to 30 minutes, permits up to three requests and never enables telemetry.'));
  const pair = button('Review and pair phone'); pairing.append(pair); pair.addEventListener('click', () => action(pair, async () => {
    const exactCode = code.value; let parsed; try { parsed = JSON.parse(exactCode); } catch { throw Error('Paste the exact phone pairing JSON.'); }
    if (Object.keys(parsed).sort().join(',') !== 'challenge,pending_id') throw Error('Use only the pending_id and challenge supplied by your phone.');
    const generation = state.generation, selectedGrant = grant.value, nativeChoice = native.checked;
    if (!selectedGrant) throw Error('Choose a current sharing grant with selected notes first.');
    if (!await confirmAction(`Pair this phone account with this computer using grant ${selectedGrant}? Up to 30 minutes and three study questions. The relay sees phone prompts. Local agent execution: ${nativeChoice ? 'requested, requires verified adapter' : 'disabled'}. Every result still needs exact local review.`, { confirmLabel: 'Pair selected phone' })) return;
    if (generation !== state.generation || code.value !== exactCode || grant.value !== selectedGrant || native.checked !== nativeChoice) return;
    await request('/remote/pair', { method: 'POST', body: { ...parsed, confirmed: true, host_grant_id: selectedGrant, expires_in_minutes: 30, max_requests: 3, max_request_bytes: 16384, native_execution_confirmed: nativeChoice } });
    if (generation !== state.generation) return; code.value = ''; await refresh(); setMessage('Phone paired. Start foreground polling when you want this computer to handle requests.');
  }));
  const processing = section('2. Handle selected phone requests'), jobs = $('div'); processing.append(jobs);
  const check = button('Check phone messages'), start = button('Start foreground polling'), pause = button('Pause polling'); processing.append(check, start, pause);
  async function poll() { if (!foreground()) { pauseForeground(); return; } const generation = state.generation; const result = await request('/remote/poll', { method: 'POST', body: {} });
    if (generation !== state.generation || !foreground()) return; await request('/remote/delivery/poll', { method: 'POST', body: {} }); if (generation !== state.generation || !foreground()) return;
    await refresh(); if (generation === state.generation) setMessage(`Phone request: ${result.native?.state || result.request?.state || 'checked'}. Review proposed writing locally before sharing.`); }
  check.addEventListener('click', () => action(check, poll));
  const stopPolling = () => { state.pollEpoch++; if (state.timer !== null) clearTimeout(state.timer); state.timer = null; };
  start.addEventListener('click', () => action(start, async () => {
    if (!state.status?.paired || !state.status.permission_current) throw Error('Pair your phone with a current permission first.'); stopPolling(); const generation = state.generation, epoch = state.pollEpoch;
    const loop = async () => { if (!foreground()) { pauseForeground(); return; } if (generation !== state.generation || epoch !== state.pollEpoch) return;
      try { await poll(); } catch (error) { if (generation === state.generation && epoch === state.pollEpoch) { setMessage(error.message, true); stopPolling(); } return; }
      if (generation === state.generation && epoch === state.pollEpoch) state.timer = setTimeout(loop, 3000); }; await loop();
  })); pause.addEventListener('click', () => { stopPolling(); setMessage('Foreground polling paused. Pairing remains until you unpair or its permission expires.'); });
  const review = section('3. Review an exact response for the phone'), job = select(review, 'Phone request'), writing = select(review, 'Accepted or applied writing item');
  const previewButton = button('Preview exact text and relay permission'), previewPanel = $('div'); review.append(previewButton, previewPanel);
  for (const field of [job, writing]) field.addEventListener('change', () => { state.preview = null; previewPanel.replaceChildren(); });
  previewButton.addEventListener('click', () => action(previewButton, async () => {
    if (!job.value || !writing.value) throw Error('Choose a phone request and an accepted writing item.'); const selectedJob = job.value, selectedWriting = writing.value;
    const row = state.writing.find(row => row.id === selectedWriting), generation = state.generation;
    const result = await request('/remote/results/preview', { method: 'POST', body: { job_id: selectedJob, writing_record_id: selectedWriting, expected_revision: row.revision, payload_hash: row.payload_hash, expires_in_minutes: 15 } });
    if (generation !== state.generation || job.value !== selectedJob || writing.value !== selectedWriting) return; state.preview = result;
    previewPanel.replaceChildren($('p', 'notice', result.preview.disclosure), $('pre', 'source-text', result.preview.text), $('p', 'field-help', `Exact text SHA-256: ${result.preview.policy.result_sha256}. Permission expires ${result.preview.policy.expires_at}.`));
    const approve = button('Approve this exact response for the relay'); previewPanel.append(approve);
    approve.addEventListener('click', () => action(approve, async () => {
      const generation = state.generation, exact = state.preview; if (!exact) throw Error('Preview this exact selection again.');
      if (!await confirmAction('Send this exact reviewed response through the trusted plaintext relay to your paired phone? Relay retention is 24 hours. Local history, backups and delivered copies may retain it.', { confirmLabel: 'Approve exact response' })) return;
      if (generation !== state.generation || exact !== state.preview) return;
      await request('/remote/results', { method: 'POST', body: { preview_id: exact.preview_id, review_hash: exact.preview.review_hash, confirmed: true } });
      if (generation !== state.generation) return; state.preview = null; previewPanel.replaceChildren(); await refresh(); setMessage('Exact response approved locally. Use Send reviewed response below to transmit it.');
    }));
  }));
  const saved = section('Reviewed responses'), resultList = $('div'); saved.append(resultList);
  const disconnect = button('Unpair phone and stop future requests'); root.append(disconnect); disconnect.addEventListener('click', () => action(disconnect, async () => {
    const generation = state.generation; if (!await confirmAction('Revoke this phone pairing? An offline relay may require recovery from the website. Delivered copies and local notes are retained.', { confirmLabel: 'Unpair phone' })) return;
    if (generation !== state.generation) return; reset(); const next = state.generation, result = await request('/remote/unpair', { method: 'POST', body: { confirmed: true } });
    if (next !== state.generation) return; await refresh(); if (next === state.generation) setMessage(result.acknowledged ? 'Phone pairing revoked by the relay.' : 'Stopped locally. Use website recovery to acknowledge relay revocation.');
  }));
  function applyControls() {
    const actual = state.status;
    native.disabled = !actual?.enabled || !actual?.native_available || actual?.paired === true;
    pair.disabled = !actual?.enabled || actual?.paired === true;
    check.disabled = !actual?.paired || !actual?.permission_current; start.disabled = check.disabled;
    pause.disabled = !actual?.paired; previewButton.disabled = check.disabled; disconnect.disabled = !actual?.paired;
  }
  async function refresh() {
    const generation = state.generation, [actual, jobRows, resultRows, writingRows, grantRows] = await Promise.all([request('/remote/status'), request('/remote/jobs'), request('/remote/results'), request('/writing/items'), request('/agent-grants')]);
    if (generation !== state.generation) return; Object.assign(state, { status: actual, jobs: jobRows.items, results: resultRows.items, writing: writingRows.items, grants: grantRows.items });
    status.textContent = actual.enabled ? actual.paired ? !actual.permission_current ? 'Phone pairing remains, but permission is expired or changed. Recover or unpair before continuing.' : `Phone paired. ${actual.native_execution ? 'Verified local agent execution permitted.' : 'Agent execution unavailable; context preparation only.'} Foreground polling is required.` : 'Phone access enabled but this computer is not paired.' : 'Phone access is disabled until hosted account, device and retention checks pass.';
    applyControls();
    options(grant, state.grants.filter(row => row.destination === 'codex' && row.state === 'active').map(row => ({ id: row.id, label: `${row.id.slice(0, 8)} · expires ${row.expires_at}` })), 'Choose exact sharing grant');
    options(job, state.jobs.filter(row => row.state === 'awaiting_student').map(row => ({ id: row.job_id, label: `${row.job_id.slice(0, 8)} · ${row.native?.state || row.state}` })), 'Choose phone request');
    options(writing, state.writing.filter(row => ['accepted', 'applied_revision'].includes(row.state) && !row.stale).map(row => ({ id: row.id, label: `${row.title} · revision ${row.revision}` })), 'Choose reviewed writing');
    if (state.preview && (!actual.permission_current || actual.binding_id !== state.preview.preview.policy.binding_id
      || !state.writing.some(row => row.id === state.preview.preview.policy.writing_record.id && row.revision === state.preview.preview.policy.writing_record.revision && !row.stale)
      || state.preview.preview.policy.expires_at <= new Date().toISOString())) { state.preview = null; previewPanel.replaceChildren(); }
    jobs.replaceChildren(); for (const row of state.jobs) { const card = $('div', 'review-row'); card.append($('p', 'field-help', `${row.job_id.slice(0, 8)} · ${row.native?.state || row.state}`));
      if (row.native?.writing_record_id) { const open = button('Open Writing review'); open.addEventListener('click', () => navigate('writing')); card.append(open); } jobs.append(card); }
    resultList.replaceChildren(); for (const row of state.results) { const card = $('div', 'review-row'); card.append($('p', 'field-help', `${row.job_id.slice(0, 8)} · ${row.state} · ${row.result_bytes} bytes · permission expires ${row.expires_at}`));
      if (row.state !== 'revoked') for (const operation of ['send', 'revoke']) { const control = button(operation === 'send' ? 'Send reviewed response' : 'Revoke response permission'); card.append(control);
        control.addEventListener('click', () => action(control, async () => { const generation = state.generation;
          if (operation === 'revoke' && !await confirmAction('Revoke this exact result and request relay deletion? Delivered copies, local history and backups may remain.', { confirmLabel: 'Revoke result' })) return;
          if (generation !== state.generation) return; const result = await request(`/remote/results/${row.id}/${operation}`, { method: 'POST', body: { expected_revision: row.revision, review_hash: row.review_hash } });
          if (generation !== state.generation) return; await refresh(); setMessage(operation === 'send' ? 'Reviewed response acknowledged by the relay. Your phone still needs a fresh local delivery check.' : result.item.relay_revocation_acknowledged ? 'Relay acknowledged result revocation.' : 'Revoked locally. Relay deletion is not acknowledged; recover from the website or wait for verified purge.');
        })); } resultList.append(card); }
  }
  function reset() { state.generation++; stopPolling(); state.preview = null; state.status = null; state.jobs = []; state.results = []; state.writing = []; state.grants = []; code.value = ''; native.checked = false;
    for (const node of [grant, job, writing, jobs, resultList, previewPanel]) node.replaceChildren(); setMessage(''); applyControls(); }
  function pauseForeground() { state.generation++; stopPolling(); state.preview = null; previewPanel.replaceChildren(); code.value = '';
    setMessage('Foreground polling paused. Already accepted work may finish; press Start to resume.'); }
  const visibility = () => { if (globalThis.document?.hidden === true) pauseForeground(); };
  globalThis.document?.addEventListener?.('visibilitychange', visibility);
  globalThis.window?.addEventListener?.('pagehide', pauseForeground);
  applyControls();
  return { refresh, reset, pause: pauseForeground };
}
