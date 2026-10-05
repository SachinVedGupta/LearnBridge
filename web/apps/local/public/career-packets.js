const VERSION = 'learnbridge_career_packet.v1';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
const invalid = () => { throw new Error('The packet download did not match this exact current review. No file was prepared.'); };

/** Verify bytes and the selected sources against the exact packet displayed before creating a download URL. */
export async function verifyCareerPacketDownload(result, packet, format) {
  if (!packet || packet.stale || !packet.exportable || packet.data?.state !== 'reviewed' || !['markdown', 'json'].includes(format) || !result || result.format !== format || result.sharing !== 'not_granted' || result.submission_supported !== false || result.validation !== 'exact_current_reviewed_payload_and_source_pins') invalid();
  const mime = format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8';
  if (result.mime !== mime || result.filename !== `LearnBridge-application-packet-${packet.id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}` || typeof result.text !== 'string' || !result.text.isWellFormed()) invalid();
  const bytes = new TextEncoder().encode(result.text); if (!Number.isSafeInteger(result.byte_length) || result.byte_length > 220000 || bytes.byteLength !== result.byte_length || await hash(result.text) !== result.sha256) invalid();
  let artifact; try { artifact = JSON.parse(format === 'json' ? result.text : /^````````````json\n([\s\S]*)\n````````````\n$/m.exec(result.text)?.[1]); } catch { invalid(); }
  const payload = packet.data.payload;
  const expected = { format: VERSION, packet: { id: packet.id, revision: packet.revision, payload_hash: packet.data.payload_hash }, reviewed: packet.data.review,
    source_fresh_until: payload.job.source_fresh_until, source_identity: payload.job.source_identity, source_sha256: payload.job.snapshot.source_sha256,
    selected_fact_ids: payload.profile_facts.map(fact => fact.id), writing_copy_hashes: payload.writing_drafts.map(draft => ({ slot: draft.slot, sha256: draft.sha256 })),
    checklist_complete: payload.missing.required.length === 0, missing_required: payload.missing.required, submission_supported: false, uploads: false, sharing: 'not_granted', rendering: 'text_only_no_attachment_verification' };
  if (!artifact || canonical(result.manifest) !== canonical(expected) || canonical(artifact.manifest) !== canonical(expected) || canonical(artifact.payload) !== canonical(payload) || await hash(canonical(artifact.payload)) !== packet.data.payload_hash
    || !Number.isFinite(Date.parse(expected.source_fresh_until)) || Date.parse(expected.source_fresh_until) <= Date.now() || (payload.job.snapshot.deadline_at && Date.parse(payload.job.snapshot.deadline_at) <= Date.now())) invalid();
  return bytes;
}

export function mountCareerPacketsUI({ root, request, element, busy, message, registerDownload = () => {}, unregisterDownload = () => {} }) {
  const $ = (tag, cls, text) => element(tag, cls, text), state = { generation: 0, selection: 0, data: null, current: null, attempt: null }, questions = [], downloads = new Map(), inFlight = new Set();
  const status = $('p', 'notice'); status.id = 'career-packets-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const button = text => { const node = $('button', 'button secondary', text); node.type = 'button'; return node; };
  const action = (control, callback) => busy(control, callback).catch(error => notice(error.message, true));
  const label = (parent, title, control) => { const node = $('label', 'field-help', title); node.append(control); parent.append(node); return control; };
  const option = (select, value, title) => { const node = $('option', '', title); node.value = value; select.append(node); };
  function cleanupDownloads() { for (const [url, saved] of downloads) { clearTimeout(saved.timer); URL.revokeObjectURL(url); unregisterDownload(url); saved.link.remove(); } downloads.clear(); }
  root.replaceChildren($('p', 'notice', 'Build a private application review packet from one current official posting, career facts you confirmed and Writing drafts you already reviewed. Questions and answers are entered here manually. Required fields are your checklist, not a discovered employer form. No model call, form filling, upload or submission occurs.'), status);
  const compose = $('section', 'panel source-panel'), form = $('form', 'career-form'); compose.append($('h2', '', 'Choose this packet’s sources'), form); root.append(compose);
  const roleSelect = $('select'); roleSelect.id = 'career-packet-role'; label(form, 'Current official posting (read it first in Public job discovery)', roleSelect);
  const factBox = $('fieldset', 'source-panel'); factBox.append($('legend', '', 'Choose current confirmed career facts')); form.append(factBox);
  const resume = $('select'); resume.id = 'career-packet-resume'; label(form, 'Resume slot: already reviewed unrestricted Writing draft', resume);
  const coverLetter = $('select'); coverLetter.id = 'career-packet-cover-letter'; label(form, 'Cover-letter slot: already reviewed unrestricted Writing draft (optional)', coverLetter);
  form.append($('p', 'field-help', 'Assign the document slots yourself. A saved Markdown draft is not a verified PDF/DOCX attachment; review claims and its separate document layout before using it elsewhere.'));
  const checklistBox = $('fieldset', 'source-panel'); checklistBox.append($('legend', '', 'My required checklist')); form.append(checklistBox);
  const questionBox = $('section', 'source-panel'), addQuestion = button('Add a manual application question'); questionBox.append($('h3', '', 'My manually entered application questions'), addQuestion); form.append(questionBox);
  const prepare = button('Prepare this private review packet'); prepare.type = 'submit'; form.append(prepare);
  const refreshButton = button('Refresh available packet sources'), listBox = $('section', 'panel source-panel'), detailBox = $('section', 'panel source-panel'); detailBox.hidden = true; root.append(refreshButton, listBox, detailBox);
  refreshButton.addEventListener('click', () => action(refreshButton, refresh));
  let factControls = [], checklistControls = [];
  function sourceControls() {
    const data = state.data; roleSelect.replaceChildren(); option(roleSelect, '', 'Choose a current official posting');
    for (const role of data.roles) option(roleSelect, role.id, `${role.selection.board_slug} · ${role.title} · source current until ${role.source_fresh_until}`);
    factBox.replaceChildren($('legend', '', 'Choose current confirmed career facts')); factControls = [];
    if (!data.facts.length) factBox.append($('p', 'field-help', 'No current confirmed career facts are available. Confirm relevant facts in Profile first; unconfirmed, conflicting, expired and other-purpose facts are excluded.'));
    for (const fact of data.facts) { const control = $('input'); control.type = 'checkbox'; control.checked = false; label(factBox, `${fact.field}: ${fact.value}`, control); factControls.push({ fact, control }); }
    for (const select of [resume, coverLetter]) { select.replaceChildren(); option(select, '', 'No reviewed draft selected — keep missing explicit'); for (const draft of data.writing) option(select, draft.id, `${draft.title} · ${draft.state} · revision ${draft.revision}`); }
    const prior = checklistControls.length ? new Map(checklistControls.map(item => [item.key, item.control.checked])) : null;
    checklistBox.replaceChildren($('legend', '', 'My required checklist')); checklistControls = [];
    const defaults = new Map(data.defaults.map(item => [item.key, item.required]));
    for (const key of ['full_name', 'email', 'education', 'experience', 'graduation', 'resume', 'cover_letter', 'gpa', 'work_authorization', 'sponsorship', 'demographics']) {
      const control = $('input'); control.type = 'checkbox'; control.checked = prior?.has(key) ? prior.get(key) : defaults.get(key) || false; label(checklistBox, `${key.replaceAll('_', ' ')}${data.capabilities.unsupported_typed_fields.includes(key) ? ' (typed fact unavailable; stays missing if required)' : ''}`, control); checklistControls.push({ key, control });
    }
  }
  function addManualQuestion() {
    if (questions.length >= 20) { notice('A packet supports at most 20 manually entered questions.', true); return; }
    const row = $('fieldset', 'source-panel'); row.append($('legend', '', `Manual question ${questions.length + 1}`));
    const prompt = $('textarea', 'career-textarea'); prompt.maxLength = 2000; prompt.required = true; label(row, 'Exact question text', prompt);
    const required = $('input'); required.type = 'checkbox'; required.checked = true; label(row, 'Required in my checklist', required);
    const field = $('select'); option(field, '', 'Freeform manual draft — facts remain unverified'); for (const key of ['name', 'email', 'university', 'program', 'graduation', 'experience', 'goals', ...state.data.capabilities.unsupported_typed_fields]) option(field, key, key.replaceAll('_', ' ')); label(row, 'Confirmed fact field, when applicable', field);
    const fact = $('select'); option(fact, '', 'No fact selected'); for (const item of state.data.facts) option(fact, item.id, `${item.field}: ${item.value}`); label(row, 'Exact selected confirmed fact (must also be checked above)', fact);
    const answer = $('textarea', 'career-textarea'); answer.maxLength = 6000; label(row, 'My exact manual answer draft (leave unresolved facts blank)', answer);
    const copyFact = button('Use exact selected fact as my draft'); row.append(copyFact); copyFact.addEventListener('click', () => { const selected = state.data.facts.find(item => item.id === fact.value); if (!selected) { notice('Select one current confirmed fact first.', true); return; } field.value = selected.field; answer.value = selected.value; });
    row.append($('p', 'field-help', 'Confirmed-fact drafts must match the exact selected fact. Email needs a dedicated confirmed email fact. Missing GPA/work-authorization/sponsorship/demographic fields stay blank; other profile text cannot authorize those answers. Freeform text is your draft and has no automated fact verification.'));
    const remove = button('Remove this manual question'); row.append(remove); const item = { id: `manual_${crypto.randomUUID().replaceAll('-', '')}`, row, prompt, required, field, fact, answer }; questions.push(item); questionBox.append(row);
    remove.addEventListener('click', () => { const index = questions.indexOf(item); if (index >= 0) questions.splice(index, 1); row.remove(); });
  }
  addQuestion.addEventListener('click', () => { if (state.data) addManualQuestion(); });
  form.addEventListener('submit', event => { event.preventDefault(); action(prepare, async () => {
    const generation = state.generation, role = state.data?.roles.find(item => item.id === roleSelect.value); if (!role) throw new Error('Choose a current selected official posting first.');
    const writing_refs = [['resume', resume], ['cover_letter', coverLetter]].flatMap(([slot, select]) => { if (!select.value) return []; const draft = state.data.writing.find(item => item.id === select.value); if (!draft) throw new Error('Refresh the Writing source before preparing this packet.'); return [{ slot, id: draft.id, revision: draft.revision, payload_hash: draft.payload_hash }]; });
    const body = { role_ref: { id: role.id, revision: role.revision, source_sha256: role.source_sha256 },
      profile_refs: factControls.filter(item => item.control.checked).map(({ fact }) => ({ id: fact.id, revision: fact.revision, fingerprint: fact.fingerprint })), writing_refs,
      questions: questions.map(item => ({ id: item.id, prompt: item.prompt.value, required: item.required.checked, fact_field: item.field.value || null, fact_ids: item.fact.value ? [item.fact.value] : [], draft_answer: item.answer.value || null })),
      requirements: checklistControls.map(item => ({ key: item.key, required: item.control.checked })) };
    const serialized = canonical(body); if (state.attempt?.body !== serialized) state.attempt = { body: serialized, key: `packet_${crypto.randomUUID().replaceAll('-', '')}` };
    const selection = ++state.selection; cleanupDownloads(); state.current = null; detailBox.replaceChildren(); detailBox.hidden = true;
    const result = await request('/career-packets', { method: 'POST', body, idempotencyKey: state.attempt.key }); if (generation !== state.generation || selection !== state.selection) return;
    state.attempt = null; show(result.packet); await refresh(false); if (generation === state.generation) notice('Exact private packet saved for review. Missing fields and manual fact-review limits remain explicit.');
  }); });
  function show(packet) {
    cleanupDownloads(); state.current = packet; detailBox.hidden = false; const payload = packet.data.payload;
    detailBox.replaceChildren($('h2', '', packet.title), $('p', 'notice', `${packet.stale ? 'Stale — refresh source evidence and prepare a new packet.' : packet.data.state.replaceAll('_', ' ')}. ${packet.checklist_complete ? 'Your selected checklist is complete.' : `${payload.missing.required.length} required checklist entries remain unresolved.`} No submission or upload is supported.`));
    detailBox.append($('p', 'field-help', `Exact payload SHA-256: ${packet.data.payload_hash}. Posting observed: ${payload.job.source_observed_at}. Source freshness boundary: ${payload.job.source_fresh_until}. Presence does not verify student eligibility or role suitability.`));
    const posting = $('a', 'button secondary', 'Open the selected official posting'); posting.href = payload.job.snapshot.posting_url; posting.target = '_blank'; posting.rel = 'noopener noreferrer'; detailBox.append(posting);
    const missing = $('section', 'source-panel'); missing.append($('h3', '', 'Unresolved checklist and questions'));
    for (const entry of [...payload.missing.required, ...payload.missing.optional]) missing.append($('p', 'field-help', `${entry.required ? 'Required' : 'Optional'}: ${entry.key} — ${entry.reason}`));
    missing.append($('p', 'field-help', `Checklist origin: ${payload.checklist.origin}. Employer form: ${payload.missing.employer_form_schema}. Question coverage: ${payload.missing.question_coverage}. Typed eligibility: not evaluated.`)); detailBox.append(missing);
    const original = $('details'); original.append($('summary', '', 'Review exact job source, selected facts, writing drafts, questions and missing manifest'), $('pre', 'source-text', JSON.stringify(payload, null, 2))); detailBox.append(original);
    for (const draft of payload.writing_drafts) detailBox.append($('h3', '', `${draft.slot.replaceAll('_', ' ')} — reviewed Markdown draft`), $('p', 'field-help', `${draft.content_status}; factual quality and attachment rendering require your separate review.`), $('pre', 'source-text', draft.text));
    for (const question of payload.questions) detailBox.append($('h3', '', question.prompt), $('p', 'field-help', `${question.required ? 'Required' : 'Optional'} · ${question.status}`), $('pre', 'source-text', question.answer || 'UNRESOLVED — no answer authorized.'));
    const forget = button('Forget this private packet'); detailBox.append(forget); forget.addEventListener('click', () => action(forget, async () => {
      const generation = state.generation, result = await request(`/career-packets/items/${packet.id}`, { method: 'DELETE', body: { expected_revision: packet.revision, payload_hash: packet.data.payload_hash } });
      if (generation !== state.generation || state.current !== packet) return; state.selection++; cleanupDownloads(); state.current = null; detailBox.replaceChildren(); detailBox.hidden = true; await refresh(false); if (generation === state.generation) notice(`Current private packet forgotten. ${result.retention}`);
    }));
    if (!packet.stale && packet.data.state === 'awaiting_review') {
      const review = button('I reviewed this exact private packet and its missing fields'); detailBox.append(review); review.addEventListener('click', () => action(review, async () => {
        const generation = state.generation, result = await request(`/career-packets/items/${packet.id}/review`, { method: 'POST', body: { expected_revision: packet.revision, payload_hash: packet.data.payload_hash } });
        if (generation !== state.generation || state.current !== packet) return; show(result.packet); await refresh(false); if (generation === state.generation) notice('Exact packet review saved. This authorizes only private text downloads, with missing facts retained.');
      }));
    }
    if (packet.exportable) for (const format of ['markdown', 'json']) {
      const control = button(`Download reviewed packet ${format === 'markdown' ? 'Markdown' : 'JSON'}`); detailBox.append(control); control.addEventListener('click', () => action(control, async () => {
        const key = `${packet.id}:${packet.revision}:${format}`; if (inFlight.has(key)) return; inFlight.add(key); const generation = state.generation;
        try {
          const result = await request(`/career-packets/items/${packet.id}/export-${format}`, { method: 'POST', body: { expected_revision: packet.revision, payload_hash: packet.data.payload_hash } });
          const bytes = await verifyCareerPacketDownload(result, packet, format);
          if (generation !== state.generation || state.current !== packet) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })), link = $('a', 'button secondary', `Download verified packet ${format}`); link.href = url; link.download = result.filename; detailBox.append(link); registerDownload(url); link.click();
          const timer = setTimeout(() => { URL.revokeObjectURL(url); unregisterDownload(url); link.remove(); downloads.delete(url); }, 30000); timer.unref?.(); downloads.set(url, { timer, link }); notice(`Verified private packet download prepared: ${result.filename}. ${result.warning}`);
        } finally { inFlight.delete(key); }
      }));
    }
  }
  async function refresh(rebuildSources = true) {
    const generation = state.generation, data = await request('/career-packets/state'); if (generation !== state.generation) return; state.data = data; if (rebuildSources) { sourceControls(); for (const question of questions) question.row.remove(); questions.length = 0; }
    listBox.replaceChildren($('h2', '', 'Saved private application packets'));
    if (!data.packets.length) listBox.append($('p', 'field-help', 'No application packet saved. Select current source evidence and prepare one.'));
    for (const packet of data.packets) { const row = $('div', 'review-row'), open = button('Open this private packet'); row.append($('strong', '', packet.title), $('p', 'field-help', `${packet.stale ? 'stale' : packet.state.replaceAll('_', ' ')} · ${packet.missing_required_count} unresolved required entries · current source until ${packet.source_fresh_until}`), open); listBox.append(row);
      open.addEventListener('click', () => action(open, async () => { const currentGeneration = state.generation, selection = ++state.selection; cleanupDownloads(); state.current = null; detailBox.replaceChildren(); detailBox.hidden = true;
        const data = await request(`/career-packets/items/${packet.id}`); if (currentGeneration === state.generation && selection === state.selection) show(data.packet); })); }
    if (state.current && !data.packets.some(packet => packet.id === state.current.id && packet.revision === state.current.revision && packet.stale === state.current.stale)) { state.generation++; cleanupDownloads(); state.current = null; detailBox.replaceChildren(); detailBox.hidden = true; notice('The packet or selected source changed. Reopen its current preview before reviewing or downloading.'); }
  }
  return { refresh, reset() { state.generation++; state.selection++; cleanupDownloads(); state.data = null; state.current = null; state.attempt = null; questions.length = 0; factControls = []; checklistControls = []; listBox.replaceChildren(); detailBox.replaceChildren(); detailBox.hidden = true; roleSelect.replaceChildren(); factBox.replaceChildren(); checklistBox.replaceChildren(); resume.replaceChildren(); coverLetter.replaceChildren(); questionBox.replaceChildren($('h3', '', 'My manually entered application questions'), addQuestion); notice(''); } };
}
