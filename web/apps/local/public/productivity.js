export function mountProductivityUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const sections = ['academic', 'communications', 'projects', 'career', 'life', 'news'];
  const state = { documents: [], tasks: [], updates: [], briefings: [], proposals: [], projects: [], schedules: [], attempts: new Map(), generation: 0 };
  let sequence = 0;
  const status = $('p', 'notice'); status.id = 'productivity-status'; status.setAttribute('role', 'status'); status.hidden = true;
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Bring in a dated update you choose, combine exact saved notes into a briefing, review source-backed task proposals, and track project checklists. These deterministic local recipes do not read connected accounts, send, edit repositories, call AI or run in the background.'), status);
  function panel(title, help) { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; }
  function field(parent, label, { type = 'text', value = '', required = false, multiline = false } = {}) {
    const wrapper = $('label', '', label), input = $(multiline ? 'textarea' : 'input'); if (!multiline) input.type = type;
    input.required = required; input.value = value; input.maxLength = multiline ? 20000 : 1000;
    if (multiline) { input.rows = 4; input.className = 'career-textarea'; } wrapper.append(input); parent.append(wrapper); return input;
  }
  function select(parent, label, choices) {
    const wrapper = $('div'), caption = $('label', '', label), input = $('select'); input.id = `productivity-select-${++sequence}`; caption.htmlFor = input.id;
    options(input, choices); wrapper.append(caption, input); parent.append(wrapper); return input;
  }
  function options(input, choices) { const selected = input.value; input.replaceChildren(); for (const [value, title] of choices) { const option = $('option', '', title); option.value = value; input.append(option); } if (choices.some(([value]) => value === selected)) input.value = selected; }
  function check(parent, label, checked = false) { const wrapper = $('label', 'record-choice'), input = $('input'); input.type = 'checkbox'; input.checked = checked; wrapper.append(input, $('span', '', label)); parent.append(wrapper); return input; }
  const form = parent => { const node = $('form', 'career-form'); parent.append(node); return node; };
  const button = (caption, primary = false) => { const input = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, caption); input.type = 'button'; return input; };
  const details = (parent, caption, text) => { const node = $('details'); node.append($('summary', '', caption), $('pre', 'context-preview', text)); parent.append(node); return node; };
  function localTime(date = new Date()) { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 16); }
  function attempt(name, body) { const payload = JSON.stringify(body); if (state.attempts.get(name)?.payload !== payload) state.attempts.set(name, { payload, key: crypto.randomUUID() }); return state.attempts.get(name).key; }
  async function action(target, fn) { try { await busy(target, fn); } catch (error) { notice(error.message || 'Your local operation could not finish. Your input is still here.', true); } }
  async function create(path, name, body) { const result = await request(`/productivity/${path}`, { method: 'POST', body, idempotencyKey: attempt(name, body) }); state.attempts.delete(name); await refresh(); return result; }
  const choices = () => [...state.documents.map(d => ({ key: `document:${d.id}`, kind: 'document', id: d.id, revision: d.revision, title: `Note: ${d.title}` })),
    ...state.updates.map(r => ({ key: `inbox:${r.id}`, kind: 'inbox', id: r.id, revision: r.revision, section: r.data.update.section,
      title: `Update: ${r.title} · ${r.data.update.provider}/${r.data.update.account}` }))];
  function sourcePicker(parent, caption) {
    const node = $('fieldset'); node.append($('legend', '', caption)); parent.append(node); let fields = [];
    return { render() {
      const previous = new Map(fields.map(f => [f.source.key, { checked: f.include.checked, section: f.section?.value }])); node.replaceChildren($('legend', '', caption)); fields = [];
      for (const source of choices()) {
        const row = $('div'), include = check(row, `${source.title} (revision ${source.revision})`, previous.get(source.key)?.checked ?? false);
        const group = source.kind === 'document' ? select(row, 'Section for this selected note', sections.map(s => [s, s])) : null;
        if (group && previous.get(source.key)?.section) group.value = previous.get(source.key).section;
        node.append(row); fields.push({ source, include, section: group });
      }
      if (!fields.length) node.append($('p', 'field-help', 'Save a note in Notes or paste an update below first. Nothing is selected automatically.'));
    }, selected: () => fields.filter(f => f.include.checked).map(f => ({ kind: f.source.kind, id: f.source.id, expected_revision: f.source.revision, section: f.source.section ?? f.section.value })),
    reset() { fields = []; node.replaceChildren($('legend', '', caption)); } };
  }

  const inboxPanel = panel('Selected updates', 'Paste only the message or update you choose. Provider and account labels distinguish identical message IDs across accounts. Dates and links are your records; no inbox was automatically refreshed.');
  const inboxForm = form(inboxPanel), provider = select(inboxForm, 'Provider label', ['manual', 'gmail', 'outlook', 'teams', 'discord', 'slack', 'github', 'linear', 'notion', 'other'].map(s => [s, s]));
  const account = field(inboxForm, 'Selected account label', { required: true }), sourceId = field(inboxForm, 'Message or update ID', { required: true });
  const subject = field(inboxForm, 'Subject or update title', { required: true }), observed = field(inboxForm, 'Source date and time (this computer’s time zone)', { type: 'datetime-local', value: localTime(), required: true });
  const body = field(inboxForm, 'Selected update text', { multiline: true, required: true }), sourceURL = field(inboxForm, 'Source link (optional; no credential query parameters)', { type: 'url' });
  const inboxSection = select(inboxForm, 'Section', sections.map(s => [s, s])); inboxSection.value = 'communications';
  const inboxSave = button('Save selected update', true); inboxSave.type = 'submit'; inboxForm.append(inboxSave);
  inboxForm.addEventListener('submit', event => { event.preventDefault(); action(inboxSave, async () => {
    await create('updates', 'update', { provider: provider.value, account: account.value, source_id: sourceId.value, subject: subject.value,
      observed_at: new Date(observed.value).toISOString(), body: body.value, source_url: sourceURL.value || null, section: inboxSection.value }); notice('Selected update saved. Its text remains context, not executable instructions.');
  }); }); const inboxList = $('div'); inboxPanel.append(inboxList);

  const briefingPanel = panel('Selected-source briefing', 'Choose exact local notes and updates. The briefing quotes these sources and pins their revisions. Every section reports coverage; empty sections and live freshness remain unknown. Save its preview as a note before sharing it through your existing agent grants.');
  const briefingForm = form(briefingPanel), briefingTitle = field(briefingForm, 'Briefing title', { value: 'My selected-source briefing', required: true });
  const briefingSources = sourcePicker(briefingForm, 'Choose sources for this briefing');
  const coverageSection = select(briefingForm, 'Section with a coverage gap (optional)', sections.map(section => [section, section]));
  const coverageState = select(briefingForm, 'Coverage status', [['unavailable', 'Unavailable'], ['failed', 'Refresh failed'], ['unknown', 'Unknown']]);
  const coverage = field(briefingForm, 'Describe a coverage gap (optional)', { multiline: true });
  coverage.placeholder = 'Teams was not refreshed';
  const briefingSave = button('Prepare briefing preview', true); briefingSave.type = 'submit'; briefingForm.append(briefingSave);
  briefingForm.addEventListener('submit', event => { event.preventDefault(); action(briefingSave, async () => {
    const claims = coverage.value.trim() ? [{ section: coverageSection.value, status: coverageState.value, detail: coverage.value.trim() }] : [];
    await create('briefings', 'briefing', { title: briefingTitle.value, sources: briefingSources.selected(), coverage: claims }); notice('Briefing preview prepared. Review selected source text and unknown coverage.');
  }); }); const briefingList = $('div'); briefingPanel.append(briefingList);

  const proposalPanel = panel('Source-backed tasks', 'Choose one exact source and a literal supporting quote. “Next week” remains unresolved unless you explicitly supply a date. Owners are your statements and are not assigned externally. Acceptance creates one local task after an exact review.');
  const proposalForm = form(proposalPanel), proposalSource = select(proposalForm, 'Source for this task', []), proposalSection = select(proposalForm, 'Section for a selected note', sections.map(s => [s, s]));
  const readSource = button('View this chosen source'); proposalForm.append(readSource); const selectedPreview = $('div'); proposalForm.append(selectedPreview);
  readSource.addEventListener('click', () => action(readSource, async () => {
    const chosen = choices().find(c => c.key === proposalSource.value); if (!chosen) throw new Error('Select a source first.'); const generation = state.generation;
    let text;
    if (chosen.kind === 'document') { const saved = await request(`/documents/${chosen.id}`); if (generation !== state.generation) return;
      const listed = state.documents.find(d => d.id === chosen.id); if (listed) listed.revision = saved.document.revision; text = saved.content;
    } else text = state.updates.find(r => r.id === chosen.id).data.update.body;
    selectedPreview.replaceChildren(); const shown = details(selectedPreview, `${chosen.title} — exact chosen text`, text); shown.open = true;
  }));
  proposalSource.addEventListener('change', () => selectedPreview.replaceChildren());
  const proposalTitle = field(proposalForm, 'Proposed local task title', { required: true }), quote = field(proposalForm, 'Literal evidence quote', { multiline: true, required: true }); quote.maxLength = 4000;
  const dueDate = field(proposalForm, 'Due date (optional)', { type: 'date' }), deadlineBasis = select(proposalForm, 'Basis when a date is provided', [['student_supplied', 'I am explicitly choosing this date'], ['source_literal', 'This exact ISO date appears in the evidence quote']]);
  const owner = field(proposalForm, 'Owner statement (optional; stays unresolved when blank)'), dependencies = $('fieldset'); dependencies.append($('legend', '', 'Optional existing local prerequisites')); proposalForm.append(dependencies); let dependencyFields = [];
  const proposalSave = button('Prepare task proposal', true); proposalSave.type = 'submit'; proposalForm.append(proposalSave);
  proposalForm.addEventListener('submit', event => { event.preventDefault(); action(proposalSave, async () => {
    const chosen = choices().find(c => c.key === proposalSource.value); if (!chosen) throw new Error('Select a source first.');
    await create('proposals', 'proposal', { title: proposalTitle.value, sources: [{ kind: chosen.kind, id: chosen.id, expected_revision: chosen.revision, section: chosen.section ?? proposalSection.value }],
      evidence: [{ source_index: 0, quote: quote.value }], deadline: dueDate.value ? { date: dueDate.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null,
      deadline_basis: dueDate.value ? deadlineBasis.value : 'unresolved', owner: owner.value || null,
      dependencies: dependencyFields.filter(f => f.include.checked).map(f => ({ id: f.task.id, expected_revision: f.task.revision })) }); notice('Task proposal saved. No task exists until you review and accept this exact payload.');
  }); }); const proposalList = $('div'); proposalPanel.append(proposalList);

  const projectPanel = panel('Project workspace', 'Record a goal, chosen public resources, selected local context and an ordered checklist. Completion is your report. This page performs no repository scan, issue mutation, patch, commit, push or team message.');
  const projectForm = form(projectPanel), projectTitle = field(projectForm, 'Project name', { required: true }), goal = field(projectForm, 'Project goal', { multiline: true, required: true }); goal.maxLength = 3000;
  const resources = field(projectForm, 'Resource links (optional, one HTTPS link per line)', { multiline: true }), projectSources = sourcePicker(projectForm, 'Choose local project context');
  const checklist = field(projectForm, 'Checklist (one step per line)', { multiline: true }); checklist.placeholder = 'Read the chosen note\nExplain the base case\nCheck my explanation';
  const orderedSteps = check(projectForm, 'Finish each step before the next', true);
  const projectSave = button('Save project workspace', true); projectSave.type = 'submit'; projectForm.append(projectSave);
  projectForm.addEventListener('submit', event => { event.preventDefault(); action(projectSave, async () => {
    const rows = resources.value.split('\n').map(line => line.trim()).filter(Boolean).map(url => { let parsed; try { parsed = new URL(url); } catch { throw new Error('Use one complete HTTPS link per resource line.'); } if (parsed.protocol !== 'https:') throw new Error('Resource links must begin with https://.'); return { label: parsed.hostname, url }; });
    const items = checklist.value.split('\n').map(line => line.trim()).filter(Boolean).map((title, index) => ({ id: `step-${index + 1}`, title, dependency_ids: orderedSteps.checked && index > 0 ? [`step-${index}`] : [] }));
    await create('projects', 'project', { title: projectTitle.value, goal: goal.value, resources: rows, sources: projectSources.selected(), checklist: items }); notice('Project saved. Ordered checklist progress is reported by you.');
  }); }); const projectList = $('div'); projectPanel.append(projectList);

  const schedulePanel = panel('Manual due reminders', 'Create a paused reminder, explicitly activate it, then use “Check due now” while paired. A manual check coalesces elapsed occurrences into one local task and counts missed occurrences. No source refresh, sleeping-laptop execution, remote notification or background agent is enabled.');
  const scheduleForm = form(schedulePanel), scheduleTitle = field(scheduleForm, 'Reminder title', { required: true }), firstDue = field(scheduleForm, 'First due time (this computer’s time zone)', { type: 'datetime-local', value: localTime(), required: true });
  const interval = field(scheduleForm, 'Repeat every (minutes, 15 to 10080)', { type: 'number', value: '60', required: true }); interval.min = '15'; interval.max = '10080';
  const scheduleTimezone = field(scheduleForm, 'Display time zone', { value: Intl.DateTimeFormat().resolvedOptions().timeZone, required: true }), scheduleSave = button('Save paused reminder', true); scheduleSave.type = 'submit'; scheduleForm.append(scheduleSave);
  scheduleForm.addEventListener('submit', event => { event.preventDefault(); action(scheduleSave, async () => { await create('schedules', 'schedule', { title: scheduleTitle.value, first_due_at: new Date(firstDue.value).toISOString(), every_minutes: Number(interval.value), timezone: scheduleTimezone.value }); notice('Reminder saved paused. Activate it explicitly before a manual due check.'); }); });
  const scheduleList = $('div'); schedulePanel.append(scheduleList);

  function renderUpdates() {
    inboxList.replaceChildren();
    for (const record of state.updates) {
      const update = record.data.update, row = $('article', 'review-row'); row.append($('h3', '', update.subject), $('p', 'field-help', `${update.provider}/${update.account} · ${update.observed_at} · ${update.section} · revision ${record.revision} · student pasted, not live synced`));
      details(row, 'Selected update text', update.body); if (update.source_url) { const link = $('a', '', 'Open chosen source link'); link.href = update.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      const edit = $('details'); edit.append($('summary', '', 'Correct this saved update')); const editor = form(edit), text = field(editor, 'Corrected update text', { value: update.body, multiline: true, required: true }), save = button('Save exact correction'); save.type = 'submit'; editor.append(save);
      editor.addEventListener('submit', event => { event.preventDefault(); action(save, async () => { await create('updates', `update-${record.id}`, { provider: update.provider, account: update.account, source_id: update.source_id, subject: update.subject, observed_at: update.observed_at,
        body: text.value, section: update.section, source_url: update.source_url, expected_revision: record.revision }); notice('Correction saved. Older proposals and exports now require fresh source review.'); }); }); row.append(edit); inboxList.append(row);
    }
  }
  function addExport(row, record, path) {
    details(row, 'Exact note export preview', record.export_text); details(row, 'Export review fingerprint', record.export_hash);
    const save = button('Save reviewed preview as a note'); save.disabled = record.needs_refresh; row.append(save);
    save.addEventListener('click', () => action(save, async () => {
      if (!await confirmAction(`Save exactly this preview of “${record.title}” as a local note? It retains the selected text and source versions. Sharing with Codex or Claude requires your existing, separate selection and grant.`, { title: 'Review local note export', confirmLabel: 'Save this note' })) return;
      const result = await request(`/productivity/${path}/${record.id}/export`, { method: 'POST', body: { expected_revision: record.revision, export_hash: record.export_hash } }); await refresh(); notice(`Reviewed note saved locally (${result.document_id}). Choose it in Agents only when you want to share it.`);
    }));
    for (const exported of record.data.exports) row.append($('p', 'field-help', `Retained note: ${exported.document_id}`));
  }
  function renderBriefings() {
    briefingList.replaceChildren();
    for (const record of state.briefings) { const row = $('article', 'review-row'); row.append($('h3', '', `${record.title}${record.needs_refresh ? ' · source changed' : ''}`));
      for (const section of record.data.briefing.sections) row.append($('p', 'field-help', `${section.section}: ${section.status}; ${section.sources.length} selected record(s). ${section.detail}`));
      addExport(row, record, 'briefings'); briefingList.append(row); }
  }
  function renderProposals() {
    proposalList.replaceChildren();
    for (const record of state.proposals) {
      const data = record.data, row = $('article', 'review-row'); row.append($('h3', '', record.title), $('p', 'field-help', `${data.state}${record.needs_refresh ? ' · source or dependency changed' : ''} · owner ${data.owner.value ?? 'unresolved'} · ${data.task.deadline.precision === 'date' ? `${data.task.deadline.date} (${data.deadline_basis})` : 'deadline unresolved'}`));
      for (const evidence of data.evidence) row.append($('blockquote', '', evidence.quote));
      details(row, 'Exact task and selected source payload', JSON.stringify({ task: data.task, owner: data.owner, sources: data.sources, dependencies: data.dependencies }, null, 2)); details(row, 'Review fingerprint', record.review_hash);
      if (data.task_id) row.append($('p', 'notice', `Accepted local task: ${data.task_id}`));
      else { const accept = button(data.pending_review ? 'Finish reviewed local task' : 'Accept this local task'); accept.disabled = record.needs_refresh; row.append(accept);
        accept.addEventListener('click', () => action(accept, async () => { if (!await confirmAction(`Create exactly the displayed local task “${record.title}”? Date: ${data.task.deadline.date ?? 'unresolved'}. Owner statement: ${data.owner.value ?? 'unresolved'}. No provider is changed.`, { title: 'Review source-backed task', confirmLabel: 'Add this local task' })) return;
          await request(`/productivity/proposals/${record.id}/accept`, { method: 'POST', body: { expected_revision: data.pending_review?.reviewed_revision ?? record.revision, review_hash: record.review_hash } }); await refresh(); notice('Reviewed task saved once in Today.'); })); }
      proposalList.append(row);
    }
  }
  function renderProjects() {
    projectList.replaceChildren();
    for (const record of state.projects) { const data = record.data.project, row = $('article', 'review-row'); row.append($('h3', '', `${record.title}${record.needs_refresh ? ' · context source changed' : ''}`), $('p', '', data.goal));
      for (const resource of data.resources) { const link = $('a', '', resource.label); link.href = resource.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      for (const item of data.checklist) { const entry = $('div', 'review-row'); entry.append($('p', '', `${item.completed ? '✓' : '□'} ${item.title}`), $('p', 'field-help', `First finish: ${item.dependency_ids.map(id => data.checklist.find(step => step.id === id)?.title || 'missing step').join(', ') || 'no earlier step'} · your reported progress`));
        const toggle = button(item.completed ? 'Mark unrecorded' : 'Report completion'); toggle.disabled = !item.completed && item.dependency_ids.some(id => !data.checklist.find(i => i.id === id)?.completed);
        entry.append(toggle); toggle.addEventListener('click', () => action(toggle, async () => { if (!await confirmAction(`${item.completed ? 'Remove your completion report for' : 'Record your completion of'} “${item.title}”? Other checklist records are preserved.`, { title: 'Review checklist progress', confirmLabel: 'Save my report' })) return;
          await request(`/productivity/projects/${record.id}/checklist`, { method: 'POST', body: { expected_revision: record.revision, item_id: item.id, completed: !item.completed } }); await refresh(); })); row.append(entry); }
      addExport(row, record, 'projects'); projectList.append(row); }
  }
  function renderSchedules() {
    scheduleList.replaceChildren();
    for (const record of state.schedules) { const data = record.data, row = $('article', 'review-row'); row.append($('h3', '', record.title), $('p', 'field-help', `${data.state} · every ${data.every_minutes} minutes · next ${new Date(data.next_due_at).toLocaleString(undefined, { timeZone: data.timezone })} (${data.timezone}) · missed ${data.missed_occurrences} · manual checks only`));
      const toggle = button(data.state === 'paused' ? 'Activate manual reminder' : 'Pause reminder'), due = button(data.pending_delivery ? 'Finish saved reminder' : 'Check due now'); due.disabled = data.state !== 'active'; row.append(toggle, due);
      toggle.addEventListener('click', () => action(toggle, async () => { const target = data.state === 'paused' ? 'active' : 'paused'; if (!await confirmAction(`${target === 'active' ? 'Activate' : 'Pause'} this manual reminder? A paired manual due check can create one local task; there is no automatic source refresh or background agent.`, { title: 'Review manual reminder', confirmLabel: target === 'active' ? 'Activate' : 'Pause' })) return;
        await request(`/productivity/schedules/${record.id}/state`, { method: 'POST', body: { expected_revision: record.revision, state: target } }); await refresh(); }));
      due.addEventListener('click', () => action(due, async () => { if (!await confirmAction('Check this reminder now and create one local task if due? Elapsed times will be counted as coalesced/missed occurrences, not background executions.', { title: 'Review manual due check', confirmLabel: 'Check due now' })) return;
        await request(`/productivity/schedules/${record.id}/check`, { method: 'POST', body: { expected_revision: record.revision } }); await refresh(); notice('Manual due check saved. Review the local task and occurrence history.'); }));
      for (const delivery of data.deliveries) row.append($('p', 'field-help', `${delivery.checked_at}: one local task; ${delivery.coalesced_occurrences} coalesced occurrence(s), ${delivery.missed_occurrences} missed.`)); scheduleList.append(row); }
  }
  async function refresh() {
    const generation = state.generation, values = await Promise.all(['context', 'updates', 'briefings', 'proposals', 'projects', 'schedules'].map(path => request(`/productivity/${path}`)));
    if (generation !== state.generation) return;
    state.documents = values[0].documents; state.tasks = values[0].tasks; [state.updates, state.briefings, state.proposals, state.projects, state.schedules] = values.slice(1).map(v => v.items);
    briefingSources.render(); projectSources.render(); options(proposalSource, choices().map(c => [c.key, c.title])); proposalSave.disabled = !choices().length;
    const chosen = new Set(dependencyFields.filter(f => f.include.checked).map(f => f.task.id)); dependencies.replaceChildren($('legend', '', 'Optional existing local prerequisites'));
    dependencyFields = state.tasks.map(task => ({ task, include: check(dependencies, `${task.title} · ${task.status} (revision ${task.revision})`, chosen.has(task.id)) }));
    renderUpdates(); renderBriefings(); renderProposals(); renderProjects(); renderSchedules();
  }
  function reset() { state.generation++; state.documents = []; state.tasks = []; state.updates = []; state.briefings = []; state.proposals = []; state.projects = []; state.schedules = []; state.attempts.clear();
    for (const node of root.querySelectorAll('form')) node.reset(); for (const node of [inboxList, briefingList, proposalList, projectList, scheduleList, selectedPreview, dependencies]) node.replaceChildren();
    briefingSources.reset(); projectSources.reset(); proposalSource.replaceChildren(); dependencyFields = []; notice(''); }
  return { refresh, reset };
}
