import { mountRichWritingControls } from './rich-writing.js';
// Plain text only: preparation and proposals are not verified model answers.
// Exact paired student review is required before saving an alternative or edit.
export async function verifyWordDownload(result, record) {
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const pin = record.data.state === 'applied_revision' ? record.data.applied_note : record.data.accepted_note;
  const manifest = result?.manifest, provenance = manifest?.provenance;
  const samePin = value => value?.id === pin?.id && value?.revision === pin?.revision && value?.sha256 === pin?.sha256;
  const sources = values => Array.isArray(values) ? values.map(value => `${value.id}:${value.revision}:${value.sha256}`).sort().join('|') : null;
  if (!pin || !['accepted', 'applied_revision'].includes(record.data.state) || result?.mime !== mime || result.encoding !== 'base64'
    || result.validation !== 'fixed_ooxml_structure_and_exact_text_hash' || result.visual_review !== 'pending' || result.sharing !== 'not_granted'
    || typeof result.base64 !== 'string' || result.base64.length > 682668
    || result.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)
    || !Number.isSafeInteger(result.byte_length) || result.byte_length < 1 || result.byte_length > 512000
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)
    || typeof result.filename !== 'string' || result.filename.length > 100 || !/^(?![.-])[\p{L}\p{N}._-]+\.docx$/u.test(result.filename)
    || manifest?.format !== 'learnbridge-word-text-artifact' || manifest.schema_version !== 1 || manifest.generator_version !== 'learnbridge_word_text.v1'
    || manifest.normalization !== 'crlf_cr_to_lf' || manifest.original_text_sha256 !== pin.sha256
    || manifest.rendering !== 'literal_text' || manifest.visual_review !== 'pending' || manifest.sharing !== 'not_granted'
    || !/^[a-f0-9]{64}$/.test(manifest.normalized_text_sha256 || '')
    || !samePin(provenance?.document) || !samePin(result.document)
    || provenance?.writing_record?.id !== record.id || provenance.writing_record.revision !== record.revision
    || provenance.writing_record.payload_hash !== record.data.payload_hash || provenance.writing_record.state !== record.data.state
    || provenance.academic_policy !== record.data.academic_policy || provenance.content_status !== record.data.content_status
    || result.content_status !== record.data.content_status
    || sources(result.source_documents) !== sources(record.data.source_documents)
    || sources(provenance.source_documents) !== sources(record.data.source_documents)) throw new Error('The Word download did not match this exact reviewed item. No file was prepared.');
  const decoded = atob(result.base64);
  if (btoa(decoded) !== result.base64 || decoded.length !== result.byte_length) throw new Error('The Word file encoding or size did not match its receipt. No file was prepared.');
  const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0));
  if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('The Word file did not have the expected package format. No file was prepared.');
  const digest = await crypto.subtle.digest('SHA-256', bytes), exactHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (exactHash !== result.sha256) throw new Error('The Word file hash did not match its receipt. No file was prepared.');
  return bytes;
}

export function mountWritingUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const state = { generation: 0, documents: [], items: [], current: null, selections: new Map(), retries: new Map(), downloads: new Set() };
  let fieldIndex = 0, richControls = null;
  const status = $('p', 'notice'); status.id = 'writing-status'; status.setAttribute('role', 'status'); status.hidden = true;
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Prepare writing instructions for your official Codex or Claude host, then review its actual draft here. Selected local documents are private until you separately approve a sharing grant in Agent & review. This screen does not generate a draft or contact an agent by itself.'), status);
  function panel(title, help) { const node = $('section', 'panel source-panel'); node.append($('h2', '', title)); if (help) node.append($('p', 'field-help', help)); root.append(node); return node; }
  function field(parent, label, { multiline = false, required = false, max = 500, value = '' } = {}) {
    const wrapper = $('div'), name = $('label', '', label), input = $(multiline ? 'textarea' : 'input', multiline ? 'career-textarea' : ''); input.id = `writing-field-${++fieldIndex}`; name.htmlFor = input.id; if (!multiline) input.type = 'text'; input.value = value; input.required = required; input.maxLength = max; wrapper.append(name, input); parent.append(wrapper); return input;
  }
  function select(parent, label, options) { const wrapper = $('div'), name = $('label', '', label), input = $('select'); input.id = `writing-field-${++fieldIndex}`; name.htmlFor = input.id; for (const [value, text] of options) { const option = $('option', '', text); option.value = value; input.append(option); } wrapper.append(name, input); parent.append(wrapper); return input; }
  function check(parent, label, checked = false) { const wrapper = $('div', 'record-choice'), name = $('label', '', label), input = $('input'); input.type = 'checkbox'; input.id = `writing-field-${++fieldIndex}`; name.htmlFor = input.id; input.checked = checked; wrapper.append(input, name); parent.append(wrapper); return input; }
  function button(label, primary = false) { const node = $('button', `button ${primary ? 'primary' : 'secondary'}`, label); node.type = 'button'; return node; }
  function action(control, callback) { busy(control, callback).catch(error => notice(error.message, true)); }
  function retry(kind, body) { const signature = JSON.stringify(body), old = state.retries.get(kind); if (old?.signature === signature) return old.key; const key = crypto.randomUUID(); state.retries.set(kind, { signature, key }); return key; }
  function exactBody(record) { return { expected_revision: record.revision, payload_hash: record.data.payload_hash }; }
  function pinned(document) { return { id: document.id, revision: document.revision, sha256: document.sha256 }; }
  function selected() { if (state.selections.size > 10) throw new Error('Select at most ten source documents.'); return [...state.selections.values()]; }
  function details(parent, label, value) { const node = $('details'); node.append($('summary', '', label), $('pre', 'source-text', JSON.stringify(value, null, 2))); parent.append(node); }
  const kinds = [['revision', 'Revise one selected document'], ['summary', 'Source-backed summary'], ['study_guide', 'Study guide'], ['outline', 'Scaffolding or outline'], ['feedback', 'Feedback on my work'], ['markdown_artifact', 'Private Markdown artifact']];
  const policies = [['learning_support', 'Learning support'], ['graded_restricted', 'Graded work: scaffolding and feedback only'], ['unrestricted', 'Personal or ungraded writing']];
  const policyLabel = value => ({ learning_support: 'Learning support', graded_restricted: 'Graded work: scaffolding only', unrestricted: 'Personal or ungraded writing' }[value] || value);
  const sourcePanel = panel('1. Select exact local sources', 'Only checked versions are included. A changed or removed source stays visibly pinned until you clear or reselect it. Source policies cannot be weakened by choosing a different policy here.');
  const sourceBox = $('fieldset'); sourceBox.append($('legend', '', 'Documents to include')); sourcePanel.append(sourceBox);
  function showSources() {
    sourceBox.replaceChildren($('legend', '', 'Documents to include')); const currentIds = new Set();
    for (const document of state.documents) {
      currentIds.add(document.id); const old = state.selections.get(document.id), stale = old && (old.revision !== document.revision || old.sha256 !== document.sha256);
      const choice = check(sourceBox, `${document.title} · revision ${document.revision} · ${policyLabel(document.academic_policy)}${stale ? ' · changed since selected; clear and reselect' : ''}`, Boolean(old));
      choice.addEventListener('change', () => { if (choice.checked) state.selections.set(document.id, pinned(document)); else state.selections.delete(document.id); showSources(); });
    }
    for (const [id] of state.selections) if (!currentIds.has(id)) { const choice = check(sourceBox, 'Previously selected document is unavailable. Clear this selection before continuing.', true); choice.addEventListener('change', () => { state.selections.delete(id); showSources(); }); }
    if (!state.documents.length) sourceBox.append($('p', 'field-help', 'No local documents yet. Create a private note in Documents first, or prepare an explicitly source-free draft whose facts you will verify separately.'));
  }
  const recipePanel = panel('2. Prepare a host recipe', 'Create a bounded instruction packet with the selected source text. Export it to a private note, then separately approve sharing with your host. Sources and pasted instructions cannot authorize extra tools or actions.');
  const recipeForm = $('form', 'career-form'); recipePanel.append(recipeForm); const recipeTitle = field(recipeForm, 'Recipe title', { required: true }), recipeKind = select(recipeForm, 'Writing task', kinds), recipePolicy = select(recipeForm, 'Academic policy for this recipe', policies), instruction = field(recipeForm, 'What should the host help with?', { multiline: true, required: true, max: 4000 });
  const prepare = button('Prepare private writing recipe', true); prepare.type = 'submit'; recipeForm.append(prepare);
  recipeForm.addEventListener('submit', event => { event.preventDefault(); action(prepare, async () => {
    const body = { title: recipeTitle.value, kind: recipeKind.value, request: instruction.value, academic_policy: recipePolicy.value, source_documents: selected() }, generation = state.generation;
    const data = await request('/writing/recipes', { method: 'POST', body, idempotencyKey: retry('recipe', body) }); if (generation !== state.generation) return; state.retries.delete('recipe'); showItem(data.item); await refresh(); if (generation !== state.generation) return; notice('Writing recipe saved privately. Review and export it, then choose sharing separately in Agent & review.');
  }); });
  const proposalPanel = panel('3. Add an actual draft for review', 'Paste your work or the actual response from your agent. Agent drafts remain unverified model output. An agent connected through LearnBridge can also create a proposal here after you grant access to a selected source.');
  const proposalForm = $('form', 'career-form'); proposalPanel.append(proposalForm); const draftTitle = field(proposalForm, 'Draft title', { required: true }), draftKind = select(proposalForm, 'Draft purpose', kinds), draftPolicy = select(proposalForm, 'Academic policy for this draft', policies), origin = select(proposalForm, 'Who produced this draft?', [['agent_paste', 'Actual agent response, pasted for review'], ['student', 'My own work']]), draft = field(proposalForm, 'Exact draft text', { multiline: true, required: true, max: 60000 });
  const propose = button('Save unreviewed proposal', true); propose.type = 'submit'; proposalForm.append(propose);
  proposalForm.addEventListener('submit', event => { event.preventDefault(); action(propose, async () => {
    if (new TextEncoder().encode(draft.value).byteLength > 60000) throw new Error('Keep this draft below 60 KB of UTF-8 text.');
    const body = { title: draftTitle.value, kind: draftKind.value, draft_text: draft.value, source_documents: selected(), academic_policy: draftPolicy.value, origin: origin.value }, generation = state.generation;
    const data = await request('/writing/proposals', { method: 'POST', body, idempotencyKey: retry('proposal', body) }); if (generation !== state.generation) return; state.retries.delete('proposal'); showItem(data.item); await refresh(); if (generation !== state.generation) return; notice('Unreviewed proposal saved. Check the entire draft and its selected sources before accepting it.');
  }); });
  const savedPanel = panel('Saved writing', 'Private recipes and drafts survive restart. If a pinned source or accepted copy changes, its cached content is unavailable in this view. Local revision history, separately exported notes and backups may retain copies.');
  const refreshButton = button('Refresh writing'); savedPanel.append(refreshButton); refreshButton.addEventListener('click', () => action(refreshButton, refresh)); const itemList = $('div'); savedPanel.append(itemList);
  const currentPanel = panel('4. Review the exact draft', 'Approval applies only to the exact saved proposal shown here.'); currentPanel.hidden = true;
  function sourceSummary(parent, references) {
    if (!references.length) { parent.append($('p', 'notice', 'No source documents were selected. Factual claims and citations need separate verification.')); return; }
    const list = $('ul'); for (const source of references) list.append($('li', '', `${source.title} · selected revision ${source.revision} · ${policyLabel(source.academic_policy)}`)); parent.append(list);
  }
  function showItem(record) {
    richControls?.reset(); richControls = null;
    state.current = record; currentPanel.hidden = false; currentPanel.replaceChildren($('h2', '', record.title), $('p', 'field-help', `${record.data.state.replaceAll('_', ' ')} · ${policyLabel(record.data.academic_policy)} · revision ${record.revision}`)); sourceSummary(currentPanel, record.data.source_documents);
    if (record.data.format === 'writing_recipe') {
      const recipe = record.data.recipe; currentPanel.append($('p', '', recipe.request), $('p', 'field-help', 'The host must enforce these tool and sharing boundaries. This recipe does not grant authority by itself.'));
      const instructions = $('ul'); for (const text of recipe.instructions) instructions.append($('li', '', text)); currentPanel.append(instructions); details(currentPanel, 'Review exact selected source text and host recipe', recipe);
      const exportButton = button('Export recipe to a private note'); currentPanel.append(exportButton); exportButton.addEventListener('click', () => action(exportButton, async () => {
        const generation = state.generation; if (!await confirmAction('Create a private note containing this exact writing recipe and selected source text? Choose sharing separately in Agent & review. The exported note retains its copy until you separately remove it.', { confirmLabel: 'Create private note' })) return; if (generation !== state.generation) return;
        const result = await request(`/writing/items/${record.id}/recipe-export`, { method: 'POST', body: { expected_revision: record.revision, recipe_hash: record.data.recipe_hash } }); if (generation !== state.generation) return; notice(`Recipe exported to “${result.document.title}”. Select that note in Agent & review to approve sharing with Codex or Claude. ${result.retention}`);
      })); return;
    }
    const payload = record.data.payload; currentPanel.append($('p', 'notice', payload.origin === 'student' ? 'Student-provided content. Review it before saving an alternative or revision.' : `Actual ${payload.origin === 'agent_paste' ? 'pasted agent' : payload.origin} draft. Model output is unverified; student review does not establish factual accuracy.`), $('h3', '', 'Entire proposed draft'), $('pre', 'source-text', payload.draft_text));
    if (record.data.diff) {
      const diff = record.data.diff; const comparison = $('details'); comparison.append($('summary', '', 'Compare the changed text with the selected original'), $('h4', '', 'Original changed passage'), $('pre', 'source-text', diff.original_excerpt || '(No original text in this changed passage)'), $('h4', '', 'Proposed changed passage'), $('pre', 'source-text', diff.alternative_excerpt || '(This passage is removed)'));
      if (diff.excerpt_truncated) comparison.append($('p', 'notice', 'This comparison excerpt is shortened. Review the entire proposed draft above and the original document before applying a revision.')); currentPanel.append(comparison);
    }
    details(currentPanel, 'Inspect exact proposal and source references', { payload, payload_hash: record.data.payload_hash, diff: record.data.diff, review_receipt: record.data.review_receipt || null });
    if (record.data.state === 'awaiting_review') {
      const needsReconciliation = state.items.some(item => item.id === record.id && item.state === 'needs_reconciliation');
      if (needsReconciliation) currentPanel.append($('p', 'notice', 'The exact source revision was already saved, but its review receipt was interrupted. Review the same draft and finish the receipt below. This will not apply another document revision.'));
      const reviewed = check(currentPanel, 'I reviewed the entire exact draft, selected source versions, academic policy and factual claims.');
      const controls = $('div', 'review-row'); currentPanel.append(controls); const alternative = button('Keep as a private alternative', true); if (!needsReconciliation) controls.append(alternative);
      function attachReview(control, endpoint, confirmation, success) { control.addEventListener('click', () => action(control, async () => {
        if (!reviewed.checked) throw new Error('Review the entire draft and confirm the exact review before accepting.'); const generation = state.generation;
        if (!await confirmAction(confirmation, { confirmLabel: endpoint === 'apply-revision' ? 'Apply exact revision' : 'Keep private alternative' })) return; if (generation !== state.generation) return;
        const data = await request(`/writing/items/${record.id}/${endpoint}`, { method: 'POST', body: exactBody(record) }); if (generation !== state.generation) return; showItem(data.item); await refresh(); if (generation !== state.generation) return; notice(success);
      })); }
      attachReview(alternative, 'accept', 'Save the exact draft as a new private Markdown note with its provenance? The selected original documents remain unchanged. Factual accuracy stays yours to verify.', 'Exact reviewed alternative saved privately and read back. Original sources were preserved.');
      if (payload.kind === 'revision' && record.data.source_documents.length === 1 && record.data.academic_policy !== 'graded_restricted') {
        const apply = button(needsReconciliation ? 'Finish exact revision receipt' : 'Apply exact revision to the source'); controls.append(apply); const source = record.data.source_documents[0]; attachReview(apply, 'apply-revision', needsReconciliation ? `Finish the receipt for the already saved exact revision to “${source.title}”? Its text will not be written again.` : `Replace the text of “${source.title}” at selected revision ${source.revision} with the entire exact draft shown above? Its original version remains in private revision history.`, 'Exact source revision saved and read back. Its original version remains in private revision history.');
      }
      const reject = button('Reject this draft'); if (!needsReconciliation) controls.append(reject); reject.addEventListener('click', () => action(reject, async () => {
        const generation = state.generation; if (!await confirmAction('Mark this exact proposal as rejected? No document text will be changed. The draft remains in private history.', { confirmLabel: 'Reject draft' })) return; if (generation !== state.generation) return;
        const data = await request(`/writing/items/${record.id}/reject`, { method: 'POST', body: exactBody(record) }); if (generation !== state.generation) return; showItem(data.item); await refresh(); if (generation !== state.generation) return; notice('Draft rejected. Source documents were not changed.');
      }));
    } else if (['accepted', 'applied_revision'].includes(record.data.state)) {
      currentPanel.append($('p', 'notice', record.data.state === 'applied_revision' ? 'Exact reviewed revision saved to the source. Original history is retained.' : 'Exact reviewed alternative saved as a private note. Original sources are unchanged.'));
      const richGeneration = state.generation;
      richControls = mountRichWritingControls({ parent: currentPanel, record, request, element, busy, notice, isCurrent: () => state.generation === richGeneration && state.current?.id === record.id && state.current?.revision === record.revision, registerDownload: url => state.downloads.add(url), unregisterDownload: url => state.downloads.delete(url) });
      const download = button('Download reviewed Markdown', true); currentPanel.append(download); download.addEventListener('click', () => action(download, async () => {
        const generation = state.generation, result = await request(`/writing/items/${record.id}/export`, { method: 'POST', body: exactBody(record) }); if (generation !== state.generation) return;
        const bytes = new TextEncoder().encode(result.text), digest = await crypto.subtle.digest('SHA-256', bytes); if (generation !== state.generation) return; const exactHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== result.byte_length || exactHash !== result.sha256 || result.mime !== 'text/markdown; charset=utf-8' || !/^[\p{L}\p{N}._-]+\.md$/u.test(result.filename)) throw new Error('The export did not match its saved text and filename. No download was prepared.');
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })); state.downloads.add(url); const link = $('a', 'button secondary', 'Download exact saved Markdown'); link.href = url; link.download = result.filename; currentPanel.append(link); link.click(); setTimeout(() => { URL.revokeObjectURL(url); state.downloads.delete(url); link.remove(); }, 30000); notice(`Verified Markdown download prepared: ${result.filename}. ${result.warning}`);
      }));
      currentPanel.append($('p', 'field-help', 'Word text preserves this saved copy and its source evidence. Markdown syntax stays literal; review layout in your document app. Formatted Word and LaTeX source are available below; PDF compilation is separate.'));
      const word = button('Download Word text (.docx)'); currentPanel.append(word); word.addEventListener('click', () => action(word, async () => {
        const generation = state.generation;
        const result = await request(`/writing/items/${record.id}/export-docx`, { method: 'POST', body: exactBody(record) });
        if (generation !== state.generation || state.current?.id !== record.id || state.current?.revision !== record.revision) return;
        const bytes = await verifyWordDownload(result, record);
        if (generation !== state.generation || state.current?.id !== record.id || state.current?.revision !== record.revision) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })); state.downloads.add(url);
        const link = $('a', 'button secondary', 'Download verified Word text'); link.href = url; link.download = result.filename;
        currentPanel.append(link); link.click(); setTimeout(() => { URL.revokeObjectURL(url); state.downloads.delete(url); link.remove(); }, 30000);
        notice(`Verified Word text download prepared: ${result.filename}. ${result.warning}`);
      }));
    }
  }
  function renderItems() {
    itemList.replaceChildren(); for (const row of state.items) {
      const card = $('div', 'review-row'); card.append($('strong', '', row.title), $('p', 'field-help', `${row.state.replaceAll('_', ' ')} · ${row.source_count} selected sources · revision ${row.revision}${row.reason ? ` · ${row.reason}` : ''}`));
      const open = button(row.state === 'needs_reconciliation' ? 'Review interrupted exact revision' : 'Open writing item'); open.disabled = row.stale; card.append(open); open.addEventListener('click', () => action(open, async () => { const generation = state.generation, data = await request(`/writing/items/${row.id}`); if (generation === state.generation) showItem(data.item); }));
      const remove = button('Remove writing item'); card.append(remove); remove.addEventListener('click', () => action(remove, async () => {
        const generation = state.generation; if (!await confirmAction('Remove this item from active writing views? Existing notes, original document revisions and backups may retain copies. This does not delete those separate notes.', { confirmLabel: 'Remove writing item' })) return; if (generation !== state.generation) return;
        await request(`/writing/items/${row.id}`, { method: 'DELETE', body: { expected_revision: row.revision } }); if (generation !== state.generation) return; await refresh(); if (generation === state.generation) notice('Writing item removed from active views. Separate notes and private history may retain copies.');
      })); itemList.append(card);
    }
    if (!state.items.length) itemList.append($('p', 'field-help', 'No writing items yet. Prepare a host recipe, paste an actual draft, or let your approved agent propose an alternative.'));
  }
  async function refresh() {
    const generation = state.generation, [documents, items] = await Promise.all([request('/writing/documents'), request('/writing/items')]); if (generation !== state.generation) return; state.documents = documents.items; state.items = items.items; showSources(); renderItems();
    if (state.current && !state.items.some(row => row.id === state.current.id && row.revision === state.current.revision && !row.stale)) { richControls?.reset(); richControls = null; state.generation++; state.current = null; currentPanel.replaceChildren(); currentPanel.hidden = true; notice('This writing item changed, or its pinned source is unavailable. Cached draft text was cleared from this view. Reopen a current item to review it.'); }
  }
  function reset() { richControls?.reset(); richControls = null; state.generation++; state.documents = []; state.items = []; state.current = null; state.selections.clear(); state.retries.clear(); for (const url of state.downloads) URL.revokeObjectURL(url); state.downloads.clear(); sourceBox.replaceChildren(); itemList.replaceChildren(); currentPanel.replaceChildren(); currentPanel.hidden = true; recipeForm.reset(); proposalForm.reset(); notice(''); }
  return { refresh, reset };
}
