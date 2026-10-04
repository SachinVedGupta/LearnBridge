// Coverage checks inspect selected local metadata only. Imports and sharing stay separate.
export function mountOnboardingUI({ root, request, element, busy, confirmAction, message, navigate }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const categories = [
    ['profile', 'Your preferences and goals', 'Check profile statements you already saved. Candidate, stale or conflicting statements still need your review.', 'profile', 'Open Profile'],
    ['local_files', 'Your selected files', 'Check saved file snapshot metadata. Folder discovery, file reading and original-file freshness are separate choices.', 'sources', 'Open Sources'],
    ['academic_exports', 'Your courses', 'Check selected saved course exports. University sign-in and live D2L access are separate steps.', 'courses', 'Open Courses'],
    ['agent_bridge', 'Your coding agent', 'Check prepared private notes and existing sharing selections for the host you choose. This does not install a bridge, grant access or run a model.', 'agents', 'Open Agent review'],
  ];
  const labels = Object.fromEntries(categories.map(([id, title]) => [id, title]));
  const stateLabels = { ready: 'Selected metadata checked', partial: 'Some checks need attention', awaiting_student: 'Your next step is needed', stale: 'Saved selection has changed', blocked: 'Cannot use this selection yet', not_requested: 'Not selected for this check' };
  const overallLabels = { review_ready: 'Ready to review this coverage report', partial: 'Review the remaining gaps', awaiting_student: 'Choose your next setup step' };
  const reasonLabels = {
    selected_record_or_permission_changed: 'A selected record changed, or a sharing permission changed, expired or was revoked.',
    selected_record_unavailable_or_no_longer_current: 'A selected record is unavailable, forgotten or no longer the current course version.',
    selected_metadata_now_exceeds_review_budget: 'The selected metadata now exceeds the review limit. Choose fewer records for a fresh report.',
  };
  const state = { generation: 0, selectionVersion: 0, refreshRequest: 0, viewRequest: 0, catalog: null, reports: [], preview: null, timer: null, currentReport: null };
  let fieldIndex = 0;
  const status = $('p', 'notice'); status.id = 'onboarding-status'; status.hidden = true; status.setAttribute('role', 'status');
  function notice(text, error = false) {
    if (message) message(status.id, text, error);
    else { status.textContent = text; status.hidden = !text; status.classList.toggle('error', error); }
  }
  function panel(title, help) {
    const section = $('section', 'panel source-panel'); section.append($('h2', '', title), $('p', 'field-help', help)); root.append(section); return section;
  }
  function button(label, primary = false) {
    const control = $('button', `button ${primary ? 'primary' : 'secondary'}`, label); control.type = 'button'; return control;
  }
  function check(parent, label, name) {
    const row = $('div', 'record-choice'), input = $('input'), caption = $('label', '', label);
    input.type = 'checkbox'; input.id = `onboarding-field-${++fieldIndex}`; input.name = name || ''; caption.htmlFor = input.id;
    row.append(input, caption); parent.append(row); return input;
  }
  function select(parent, label, choices) {
    const row = $('div'), caption = $('label', '', label), input = $('select'); input.id = `onboarding-field-${++fieldIndex}`; caption.htmlFor = input.id;
    for (const [value, title] of choices) { const option = $('option', '', title); option.value = value; input.append(option); }
    row.append(caption, input); parent.append(row); return input;
  }
  function action(control, callback) { busy(control, callback).catch(error => notice(error.message, true)); }
  function go(page) {
    invalidatePreview();
    if (typeof navigate === 'function') navigate(page);
    else notice('Use the workspace menu to open the selected section.');
  }
  function cleanLabel(value) { return typeof value === 'string' ? value.replaceAll('_', ' ') : ''; }
  function instant(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded'; }
  function limitations(parent, values) {
    if (!Array.isArray(values) || !values.length) return;
    const list = $('ul', 'field-help'); for (const text of values) if (typeof text === 'string') list.append($('li', '', reasonLabels[text] || cleanLabel(text))); parent.append(list);
  }
  root.replaceChildren($('p', 'notice', 'Build your workspace a step at a time. Choose what this check should cover, review its gaps, then save a local setup report. LearnBridge checks selected record metadata; it does not search your laptop, read original files, open accounts or contact an AI host from this screen.'), status);

  const start = panel('1. Choose your focus', 'Pick a purpose for this report. Your statements and records remain local; choosing a purpose does not grant an agent access.');
  const form = $('form', 'career-form'); start.append(form);
  const purpose = select(form, 'What would you like to set up first?', [['general', 'My student workspace'], ['learning', 'Learning and courses'], ['career', 'Career preparation'], ['meals', 'Meals and routines'], ['budget', 'Expense tracking']]);
  const reload = button('Refresh available records'); form.append(reload);
  const catalogNotice = $('div'); start.append(catalogNotice);
  const choicesPanel = panel('2. Choose exactly what to check', 'Nothing is selected by default. Check a part of your workspace, then choose existing records below it. You can also check an empty part to see its next setup step. Up to 40 records in total.');
  const categoryControls = new Map(), itemControls = new Map(), categoryBodies = new Map();
  const fieldsByCategory = { profile: ['profile_ids'], local_files: ['source_entry_ids'], academic_exports: ['snapshot_ids'], agent_bridge: ['document_ids', 'agent_grant_ids'] };
  for (const [key, title, help, page, linkLabel] of categories) {
    const box = $('section', 'review-row'); box.append($('h3', '', title), $('p', 'field-help', help));
    const include = check(box, 'Include this part in my coverage check', `requested-${key}`), body = $('div');
    categoryControls.set(key, include); categoryBodies.set(key, body); box.append(body);
    const link = button(linkLabel); link.addEventListener('click', () => go(page)); box.append(link); choicesPanel.append(box);
    include.addEventListener('change', () => {
      if (!include.checked) for (const field of fieldsByCategory[key]) for (const input of itemControls.get(field) || []) input.checked = false;
      updateEnabled(); selectionChanged();
    });
  }
  const destination = select(categoryBodies.get('agent_bridge'), 'Which host are you checking?', [['', 'Choose a host, or leave it unchecked'], ['codex', 'Codex'], ['claude', 'Claude']]);
  const preparedNotes = $('div'), grantList = $('div'); categoryBodies.get('agent_bridge').append(preparedNotes, grantList);
  const profileList = categoryBodies.get('profile'), localList = categoryBodies.get('local_files'), academicList = categoryBodies.get('academic_exports');
  const selectionCount = $('p', 'field-help', 'No records selected.'), previewButton = button('Preview my setup coverage', true);
  choicesPanel.append(selectionCount, previewButton);
  const review = panel('3. Review this coverage check', 'This report records which selected metadata checks passed, which limits remain and what to do next. It cannot certify your complete setup or your actual coding-agent connection.'); review.hidden = true;
  const previewContent = $('div'), previewExpiry = $('p', 'field-help'), save = button('Save this reviewed setup report', true);
  review.append(previewContent, previewExpiry, save);
  const reportsPanel = panel('Saved setup reports', 'Reports are retained local snapshots of your choices and their limitations. Changed records, expired sharing or forgotten sources require a fresh check. Removing a report does not remove your notes, courses, profile or sharing selections.');
  const reportList = $('div'); reportsPanel.append(reportList);
  const savedReview = panel('Review a saved setup report', 'This is a previously saved check. Its source metadata may have changed since you reviewed it.'); savedReview.hidden = true;

  function selection() {
    const result = { purpose: purpose.value, requested: [...categoryControls].filter(([, input]) => input.checked).map(([key]) => key),
      profile_ids: [], source_entry_ids: [], snapshot_ids: [], document_ids: [], agent_grant_ids: [], destination: destination.value || null };
    for (const [key, fields] of Object.entries(fieldsByCategory)) {
      if (!categoryControls.get(key).checked) continue;
      for (const field of fields) result[field] = (itemControls.get(field) || []).filter(input => input.checked).map(input => input.value).sort();
    }
    if (!categoryControls.get('agent_bridge').checked) result.destination = null;
    return result;
  }
  function recordCount(value = selection()) { return ['profile_ids', 'source_entry_ids', 'snapshot_ids', 'document_ids', 'agent_grant_ids'].reduce((sum, field) => sum + value[field].length, 0); }
  function selectedNames(value) {
    return [
      `Purpose: ${purpose.options[purpose.selectedIndex].textContent}`,
      `Parts checked: ${value.requested.map(key => labels[key]).join(', ') || 'None'}`,
      `Profile statements: ${value.profile_ids.length} · File snapshots: ${value.source_entry_ids.length} · Notes: ${value.document_ids.length} · Course exports: ${value.snapshot_ids.length} · Existing sharing selections: ${value.agent_grant_ids.length}`,
      `Host chosen for metadata check: ${value.destination || 'None'}`,
    ].join('\n');
  }
  function invalidatePreview() {
    clearTimeout(state.timer); state.timer = null; state.preview = null;
    previewContent.replaceChildren(); previewExpiry.textContent = ''; review.hidden = true; save.disabled = true;
  }
  function selectionChanged() {
    state.selectionVersion++; invalidatePreview();
    const count = recordCount(); selectionCount.textContent = `${count} of 40 records selected. ${count > 40 ? 'Remove some choices before previewing.' : 'No new access is granted.'}`;
    previewButton.disabled = !state.catalog || count > 40;
  }
  function updateEnabled() {
    for (const [key, fields] of Object.entries(fieldsByCategory)) for (const field of fields) for (const input of itemControls.get(field) || []) {
      input.disabled = !categoryControls.get(key).checked || (field === 'agent_grant_ids' && (!destination.value || input.dataset.destination !== destination.value));
      if (input.disabled) input.checked = false;
    }
    destination.disabled = !categoryControls.get('agent_bridge').checked;
  }
  function addChoices(parent, field, title, rows, label, remembered) {
    itemControls.set(field, []); parent.append($('h4', '', title));
    if (!rows.length) { parent.append($('p', 'field-help', 'No saved records here yet. Open the section above to add or review one.')); return; }
    for (const row of rows) {
      const input = check(parent, label(row), field); input.value = row.id; input.checked = remembered.has(row.id);
      if (field === 'agent_grant_ids') input.dataset.destination = row.destination;
      input.addEventListener('change', selectionChanged); itemControls.get(field).push(input);
    }
  }
  function coverageState(coverage) {
    if (typeof coverage?.state === 'string') return `${cleanLabel(coverage.state)}${coverage.reasons?.length ? ` (${coverage.reasons.map(cleanLabel).join('; ')})` : ''}`;
    if (!coverage || typeof coverage !== 'object') return 'Coverage not recorded';
    return Object.entries(coverage).filter(([, value]) => typeof value?.state === 'string').map(([key, value]) => `${cleanLabel(key)}: ${cleanLabel(value.state)}`).join('; ') || 'Coverage not recorded';
  }
  function renderCatalog(catalog) {
    const remembered = new Set([...itemControls.values()].flatMap(inputs => inputs.filter(input => input.checked).map(input => input.value)));
    profileList.replaceChildren(); localList.replaceChildren(); academicList.replaceChildren(); preparedNotes.replaceChildren(); grantList.replaceChildren();
    addChoices(profileList, 'profile_ids', 'Saved profile statements', catalog.profile, row => `${cleanLabel(row.field)} · ${cleanLabel(row.state)} · revision ${row.revision}${row.stale ? ' · stale evidence' : ''}${row.conflict ? ' · conflicting values' : ''}${row.purposes?.length ? ` · purposes: ${row.purposes.map(cleanLabel).join(', ')}` : ''}`, remembered);
    addChoices(localList, 'source_entry_ids', 'Imported file snapshots', catalog.source_entries, row => `${row.title} · ${cleanLabel(row.format)} · revision ${row.revision} · ${coverageState(row.coverage)} · original file freshness not checked`, remembered);
    addChoices(preparedNotes, 'document_ids', 'Prepared private notes (metadata only)', catalog.documents, row => `${row.title} · revision ${row.revision}`, remembered);
    addChoices(academicList, 'snapshot_ids', 'Current saved course exports', catalog.snapshots, row => `${row.title} · ${row.selected_course_ids.length} selected course(s) · source-reported retrieval ${instant(row.retrieved_at)} · ${coverageState(row.coverage)}`, remembered);
    addChoices(grantList, 'agent_grant_ids', 'Existing agent sharing selections', catalog.grants, row => `${row.destination} · ${row.state} · expires ${instant(row.expires_at)} · revision ${row.revision} · ${row.record_counts.tasks} tasks, ${row.record_counts.documents} notes, ${row.record_counts.source_entries} file snapshots`, remembered);
    catalogNotice.replaceChildren($('p', 'field-help', 'Only record labels, revisions and coverage metadata were loaded. Profile values, file bodies, note bodies and original folder paths are not included.'));
    if (catalog.catalogue_coverage?.state === 'partial') {
      catalogNotice.append($('p', 'notice', 'The record list is incomplete. A report cannot cover records outside this list.'));
      limitations(catalogNotice, catalog.catalogue_coverage.reasons);
    }
    limitations(catalogNotice, catalog.limitations); updateEnabled(); selectionChanged();
  }
  function checks(parent) {
    const box = $('div', 'review-row'); box.append($('h3', '', 'Three separate checks'));
    box.append($('p', '', 'Imported records: this report checks selected saved metadata. It does not inspect original files, discover new records or establish live account freshness.'),
      $('p', '', 'Sharing: saving this report grants no access. Any existing sharing selection is checked as metadata only.'),
      $('p', '', 'Actual host connection: not checked here. No Codex or Claude request is run, and no subscription or model availability is verified.'));
    parent.append(box);
  }
  function metadataLine(item) {
    const parts = [];
    for (const key of ['title', 'field', 'destination', 'state', 'format', 'provenance']) if (typeof item[key] === 'string') parts.push(cleanLabel(item[key]));
    if (item.purpose_compatible === false) parts.push('Does not match this purpose');
    if (item.stale) parts.push('Stale evidence'); if (item.conflict) parts.push('Conflicting profile statements');
    const sharingLabels = { selected_permission_valid: 'Existing selected permission valid; host use untested', selected_permission_stale: 'Existing selected permission is stale', permission_not_current: 'Existing selected permission is not current' };
    if (sharingLabels[item.verification]) parts.push(sharingLabels[item.verification]);
    if (Number.isSafeInteger(item.used_bytes) && Number.isSafeInteger(item.max_bytes)) parts.push(`Existing sharing budget: ${item.used_bytes} of ${item.max_bytes} bytes used`);
    if (Number.isSafeInteger(item.revision)) parts.push(`revision ${item.revision}`);
    if (typeof item.id === 'string') parts.push(`record ${item.id}`);
    if (typeof item.retrieved_at === 'string') parts.push(`source-reported retrieval ${instant(item.retrieved_at)}`);
    if (typeof item.expires_at === 'string') parts.push(`expires ${instant(item.expires_at)}`);
    if (item.coverage) parts.push(coverageState(item.coverage));
    return parts.join(' · ') || 'Selected record metadata checked';
  }
  function renderCoverage(parent, value) {
    parent.replaceChildren($('h3', '', overallLabels[value.overall] || 'Review remaining setup steps'),
      $('p', 'field-help', `Checked ${instant(value.observed_at)} · ${recordCount(value.selection)} selected records · purpose: ${cleanLabel(value.selection.purpose)} · host choice: ${value.selection.destination || 'None'}`));
    checks(parent);
    for (const row of value.coverage) {
      const card = $('article', 'review-row'); card.append($('h3', '', labels[row.category] || cleanLabel(row.category)),
        $('p', 'notice', `${stateLabels[row.state] || cleanLabel(row.state)} · ${row.checked_count} selected records checked`));
      for (const item of row.items || []) card.append($('p', 'field-help', metadataLine(item)));
      limitations(card, row.limitations);
      if (row.next_step?.action) card.append($('p', '', row.next_step.action));
      if (['profile', 'sources', 'courses', 'agents'].includes(row.next_step?.page)) {
        const next = button(`Go to ${row.next_step.page === 'agents' ? 'Agent review' : row.next_step.page[0].toUpperCase() + row.next_step.page.slice(1)}`);
        next.addEventListener('click', () => go(row.next_step.page)); card.append(next);
      }
      parent.append(card);
    }
    parent.append($('p', 'hash-text', `Exact review fingerprint: ${value.review_hash}`));
  }
  function showSaved(record) {
    state.currentReport = record; savedReview.hidden = false; savedReview.replaceChildren($('h2', '', record.title));
    if (record.needs_refresh) {
      savedReview.append($('p', 'notice', 'Needs a fresh check. This saved report describes an older selection; it does not establish current setup coverage.'));
      limitations(savedReview, record.refresh_reasons);
    }
    const content = $('div'); savedReview.append(content); renderCoverage(content, record.data);
    savedReview.append($('p', 'field-help', `Reviewed ${instant(record.data.review?.reviewed_at)} · saved report revision ${record.revision}. Review-only metadata; no import, sharing permission or host request was performed.`));
  }
  function renderReports() {
    reportList.replaceChildren();
    for (const record of state.reports) {
      const row = $('article', 'review-row'); row.append($('h3', '', record.title),
        $('p', 'notice', record.needs_refresh ? 'Needs a fresh check: selected records or sharing changed.' : 'Saved coverage snapshot; actual host use remains untested here.'));
      limitations(row, record.refresh_reasons);
      const open = button('Review saved report'), remove = button('Remove this report'); row.append(open, remove);
      open.addEventListener('click', () => action(open, async () => {
        const generation = state.generation, viewRequest = ++state.viewRequest;
        const result = await request(`/onboarding/reports/${record.id}`);
        if (generation !== state.generation || viewRequest !== state.viewRequest) return; showSaved(result.item);
      }));
      remove.addEventListener('click', () => action(remove, async () => {
        const generation = state.generation;
        if (!await confirmAction(`Remove “${record.title}” from active setup reports? Your source records and sharing selections stay as they are. Historical local revisions and backups may retain this report.`, { title: 'Remove saved setup report', confirmLabel: 'Remove report' })) return;
        if (generation !== state.generation) return;
        await request(`/onboarding/reports/${record.id}`, { method: 'DELETE', body: { expected_revision: record.revision } });
        if (generation !== state.generation) return; await refresh(); notice('Setup report removed. Your records and existing sharing selections were not changed.');
      })); reportList.append(row);
    }
    if (!state.reports.length) reportList.append($('p', 'field-help', 'No setup report saved yet. Choose a few records above and review their coverage.'));
  }
  purpose.addEventListener('change', selectionChanged);
  destination.addEventListener('change', () => { updateEnabled(); selectionChanged(); });
  form.addEventListener('submit', event => event.preventDefault());
  reload.addEventListener('click', () => action(reload, refresh));
  previewButton.disabled = true; save.disabled = true;
  previewButton.addEventListener('click', () => action(previewButton, async () => {
    const selected = selection(), generation = state.generation, selectionVersion = state.selectionVersion, signature = JSON.stringify(selected), started = Date.now();
    if (recordCount(selected) > 40) throw new Error('Choose no more than 40 records for this coverage check.');
    invalidatePreview(); notice('Checking only your selected saved metadata…');
    const result = await request('/onboarding/preview', { method: 'POST', body: selected });
    if (generation !== state.generation || selectionVersion !== state.selectionVersion || signature !== JSON.stringify(selection())) return;
    state.preview = { id: result.preview_id, value: result.preview, signature }; renderCoverage(previewContent, result.preview);
    review.hidden = false; save.disabled = false; previewExpiry.textContent = 'Review this exact report now. Its preview is cleared after five minutes, when you edit your choices or when you refresh available records.';
    state.timer = setTimeout(() => { if (state.preview?.id !== result.preview_id) return; invalidatePreview(); notice('The setup preview expired. Preview your selected metadata again before saving.'); }, Math.max(0, 300000 - (Date.now() - started)));
    notice('Coverage check ready. Review each limitation and next step before saving.');
  }));
  save.addEventListener('click', () => action(save, async () => {
    const reviewed = state.preview, generation = state.generation, selectionVersion = state.selectionVersion;
    if (!reviewed || reviewed.signature !== JSON.stringify(selection())) throw new Error('Preview the current choices again before saving.');
    if (!await confirmAction(`Save exactly this local coverage report?\n\n${selectedNames(reviewed.value.selection)}\n\nFingerprint: ${reviewed.value.review_hash}\n\nThis stores selected metadata and limitations only. It does not import files, grant sharing, install a bridge or run Codex/Claude.`, { title: 'Review exact setup report', confirmLabel: 'Save local report' })) return;
    if (generation !== state.generation || selectionVersion !== state.selectionVersion || state.preview?.id !== reviewed.id || reviewed.signature !== JSON.stringify(selection())) return;
    let result;
    try { result = await request('/onboarding/reports', { method: 'POST', body: { preview_id: reviewed.id, review_hash: reviewed.value.review_hash } }); }
    catch (error) { if (generation === state.generation && [400, 403, 409, 410].includes(error.status)) invalidatePreview(); throw error; }
    if (generation !== state.generation || selectionVersion !== state.selectionVersion) return;
    invalidatePreview(); const refreshed = await refresh(); if (generation !== state.generation || !refreshed) return;
    const current = state.reports.find(record => record.id === result.item.id);
    if (!current) { notice('The saved report is no longer active. Refresh the available records before reviewing again.'); return; }
    showSaved(current);
    notice('Reviewed setup report saved locally. Use its next steps to add records or separately review agent access. Actual host use is still untested by this check.');
  }));
  async function refresh() {
    const generation = state.generation, refreshRequest = ++state.refreshRequest; state.selectionVersion++; state.viewRequest++; invalidatePreview(); previewButton.disabled = true;
    const [catalog, reports] = await Promise.all([request('/onboarding/catalog'), request('/onboarding/reports')]);
    if (generation !== state.generation || refreshRequest !== state.refreshRequest) return false;
    state.catalog = catalog; state.reports = reports.items; renderCatalog(catalog); renderReports();
    if (state.currentReport) {
      const current = state.reports.find(record => record.id === state.currentReport.id);
      if (current) showSaved(current); else { state.currentReport = null; savedReview.replaceChildren(); savedReview.hidden = true; }
    }
    return true;
  }
  function reset() {
    state.generation++; state.selectionVersion++; state.refreshRequest++; state.viewRequest++; invalidatePreview();
    state.catalog = null; state.reports = []; state.currentReport = null;
    purpose.value = 'general'; destination.value = ''; for (const input of categoryControls.values()) input.checked = false;
    for (const inputs of itemControls.values()) for (const input of inputs) input.checked = false;
    itemControls.clear(); for (const list of [profileList, localList, academicList, preparedNotes, grantList, catalogNotice, reportList, savedReview]) list.replaceChildren();
    savedReview.hidden = true; updateEnabled(); previewButton.disabled = true; selectionCount.textContent = 'No records selected.'; notice('');
  }
  updateEnabled();
  return { refresh, reset };
}
