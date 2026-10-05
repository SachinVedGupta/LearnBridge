export function mountAcademicTasksUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, cls = '', text = '') => element(tag, cls, text), state = { ready: false, generation: 0, scopeVersion: 0, snapshots: [], proposals: [], previews: [], inspected: null, attempts: new Map() };
  const active = new WeakSet(); let courseFields = [], itemFields = [], refreshSerial = 0;
  const status = $('p', 'notice'); status.id = 'academic-tasks-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  root.replaceChildren($('p', 'notice', 'Turn selected saved course deadlines into local task proposals. Inspect only the current courses you choose, review a preview, then separately accept each task. This does not refresh D2L, send course text to AI, complete assignments or change a calendar.'), status);
  const panel = (title, help) => { const node = $('section', 'panel source-panel'); node.append($('h2', '', title), $('p', 'field-help', help)); root.append(node); return node; };
  const button = (caption, primary = false) => { const node = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, caption); node.type = 'button'; return node; };
  const details = (parent, title, text) => { const node = $('details'); node.append($('summary', '', title), $('pre', 'context-preview', text)); parent.append(node); return node; };
  const picker = panel('Choose current saved courses', 'Import and review school information in School connection or Courses first. All course choices start unchecked. Coverage and deadlines are reported by the saved source, not independently verified as live.');
  const snapshotLabel = $('label', '', 'Current imported snapshot'), snapshotSelect = $('select'); snapshotSelect.id = 'academic-tasks-snapshot'; snapshotLabel.htmlFor = snapshotSelect.id; picker.append(snapshotLabel, snapshotSelect);
  const courses = $('fieldset'); courses.append($('legend', '', 'Choose up to 5 current courses')); picker.append(courses);
  const inspect = button('Inspect selected course deadlines', true), reload = button('Refresh academic task review'); inspect.disabled = reload.disabled = true; picker.append(inspect, reload);
  const selectionPanel = panel('Choose known assignment deadlines', 'Inspect first, then choose up to 3 assignments. Unknown dates stay visible and cannot become a guessed task date. Existing matching tasks or conflicting records are shown for review rather than overwritten.');
  const items = $('fieldset'); items.append($('legend', '', 'No assignments inspected')); selectionPanel.append(items); const prepare = button('Prepare exact task preview', true); prepare.disabled = true; selectionPanel.append(prepare);
  const previewPanel = panel('Saved previews', 'A preview expires after 10 minutes. Saving its exact review creates pending proposals only. A separate confirmation is required to add each task to Today. Changed sources or task matches require a fresh preview.'); const previewList = $('div'); previewPanel.append(previewList);
  const proposalsPanel = panel('Review each proposed task', 'Check the original source deadline and proposed task. Acceptance creates one local task; rejection creates none. Imported source changes, omissions or conflicts never silently edit or delete existing tasks.'); const proposalList = $('div'); proposalsPanel.append(proposalList);
  const scope = () => ({ snapshot_ids: snapshotSelect.value ? [snapshotSelect.value] : [], course_ids: courseFields.filter(row => row.include.checked).map(row => row.course.id).sort() });
  const scopeKey = () => JSON.stringify(scope());
  function current(generation) { return state.ready && generation === state.generation; }
  async function action(target, operation) {
    if (!state.ready || active.has(target)) return; active.add(target); const generation = state.generation;
    try { await busy(target, () => current(generation) ? operation(generation) : undefined); }
    catch (error) { if (current(generation)) notice(error.message || 'This academic review changed. Refresh and inspect its current source before continuing.', true); }
    finally { active.delete(target); if (!state.ready || generation !== state.generation) target.disabled = true; }
  }
  function invalidateSelection() { state.scopeVersion++; state.inspected = null; itemFields = []; items.replaceChildren($('legend', '', 'No assignments inspected')); prepare.disabled = true; notice(''); }
  function renderCourses() {
    courses.replaceChildren($('legend', '', 'Choose up to 5 current courses')); courseFields = [];
    const snapshot = state.snapshots.find(row => row.id === snapshotSelect.value);
    for (const course of snapshot?.courses ?? []) {
      const wrapper = $('label', 'record-choice'), include = $('input'); include.type = 'checkbox'; include.id = `academic-tasks-course-${course.id}`; include.checked = false;
      include.addEventListener('change', invalidateSelection); wrapper.append(include, $('span', '', `${course.code || course.title} · ${course.title}`)); courses.append(wrapper); courseFields.push({ course, include });
    }
    if (!snapshot) courses.append($('p', 'field-help', 'Choose a current imported snapshot first.'));
  }
  snapshotSelect.addEventListener('change', () => { invalidateSelection(); renderCourses(); });
  function deadlineText(deadline) {
    if (deadline.precision === 'date') return `${deadline.date} (${deadline.timezone || 'time zone not supplied'}; date only)`;
    if (deadline.precision === 'instant') return `${deadline.instant} (${deadline.timezone || 'time zone not supplied'}; exact instant)`;
    return `Unknown date: ${deadline.original || deadline.reason || 'not supplied'}`;
  }
  function renderItems() {
    const inspected = state.inspected; items.replaceChildren($('legend', '', 'Choose up to 3 known assignments')); itemFields = [];
    for (const item of inspected?.items ?? []) {
      const wrapper = $('label', 'record-choice'), include = $('input'); include.type = 'checkbox'; include.id = `academic-tasks-item-${item.source.item_id}`; include.checked = false;
      include.disabled = item.state !== 'new_proposal'; wrapper.append(include, $('span', '', `${item.source.title} · ${item.course_label} · ${deadlineText(item.source.deadline)} · ${item.state.replaceAll('_', ' ')}`));
      include.addEventListener('change', () => { const count = itemFields.filter(row => row.include.checked).length; prepare.disabled = count < 1 || count > 3; });
      items.append(wrapper); itemFields.push({ item, include });
    }
    if (!inspected?.items.length) items.append($('p', 'field-help', 'No assignments were returned for this selected saved scope. Existing tasks are preserved.'));
    if (inspected?.truncated) items.append($('p', 'field-help', `Showing the first ${inspected.items.length} of ${inspected.total_items} saved items. Choose fewer courses to narrow the view.`));
    if (inspected) items.append($('p', 'field-help', 'Saved observations only. Partial or unavailable source coverage does not prove an assignment was deleted.')); prepare.disabled = true;
  }
  inspect.addEventListener('click', () => action(inspect, async generation => {
    const selected = scope(), version = state.scopeVersion, key = scopeKey(); if (!selected.snapshot_ids.length || !selected.course_ids.length || selected.course_ids.length > 5) throw new Error('Choose a snapshot and between 1 and 5 courses.');
    const result = await request('/academic-tasks/inspect', { method: 'POST', body: selected });
    if (!current(generation) || version !== state.scopeVersion || key !== scopeKey()) return; state.inspected = result; renderItems(); notice('Only your selected saved course deadlines are shown. Choose exact assignments for a task preview.');
  }));
  prepare.addEventListener('click', () => action(prepare, async generation => {
    const version = state.scopeVersion, key = scopeKey(), assignment_ids = itemFields.filter(row => row.include.checked && !row.include.disabled).map(row => row.item.source.item_id);
    if (!state.inspected || !assignment_ids.length || assignment_ids.length > 3) throw new Error('Inspect first and choose between 1 and 3 known assignments.');
    const body = { ...scope(), assignment_ids }, identity = JSON.stringify(body); if (!state.attempts.has(identity)) state.attempts.set(identity, crypto.randomUUID());
    await request('/academic-tasks/previews', { method: 'POST', body, idempotencyKey: state.attempts.get(identity) });
    if (!current(generation) || version !== state.scopeVersion || key !== scopeKey()) return; state.attempts.delete(identity); await refresh(); if (current(generation)) notice('Exact preview saved. Review it below; no task or pending proposal has been accepted.');
  }));
  reload.addEventListener('click', () => action(reload, () => refresh()));
  function renderPreviews() {
    previewList.replaceChildren(); if (!state.previews.length) previewList.append($('p', 'field-help', 'No academic task previews saved.'));
    for (const preview of [...state.previews].reverse()) {
      const card = $('article', 'review-row'); card.append($('h3', '', preview.title), $('p', 'field-help', `${preview.data.state} · ${preview.expired ? 'expired' : `expires ${preview.data.expires_at}`} · ${preview.needs_refresh ? 'source changed; inspect again' : 'saved source pins'} · revision ${preview.revision}`));
      for (const item of preview.data.items) card.append($('p', 'field-help', `${item.source.title}: ${deadlineText(item.source.deadline)} · ${item.state.replaceAll('_', ' ')} · ${item.state === 'new_proposal' ? 'one pending proposal, not an accepted task' : 'no new proposal'}`));
      details(card, 'Exact proposed task and source metadata', JSON.stringify({ items: preview.data.items, source_pins: preview.data.source_pins }, null, 2));
      if (preview.data.state === 'preview') {
        const save = button('Save pending academic task proposals'); save.disabled = preview.expired || preview.needs_refresh; card.append(save);
        save.addEventListener('click', () => action(save, async generation => {
          const version = state.scopeVersion;
          const approved = await confirmAction('Save exactly the displayed academic task proposals and source deadline metadata? This creates pending local reviews only. No task is accepted, calendar changed, AI called or assignment completed.', { title: 'Review academic task preview', confirmLabel: 'Save pending proposals' });
          if (!approved || !current(generation) || version !== state.scopeVersion || !state.previews.some(row => row.id === preview.id && row.revision === preview.revision && !row.expired && !row.needs_refresh)) return;
          await request(`/academic-tasks/previews/${preview.id}/save`, { method: 'POST', body: { expected_revision: preview.revision, review_hash: preview.data.review_hash } });
          if (!current(generation)) return; await refresh(); if (current(generation)) notice('Pending proposals saved. Accept each exact task separately to add it to Today.');
        }));
      }
      previewList.append(card);
    }
  }
  function renderProposals() {
    proposalList.replaceChildren(); if (!state.proposals.length) proposalList.append($('p', 'field-help', 'No pending academic task proposals.'));
    for (const proposal of state.proposals) {
      const data = proposal.data, card = $('article', 'review-row'); card.append($('h3', '', data.task.title), $('p', 'field-help', `${data.state.replaceAll('_', ' ')} · ${deadlineText(data.source.deadline)} · ${data.task.course_label} · ${proposal.needs_refresh ? 'source changed; new acceptance blocked' : 'saved current source pins'}`));
      details(card, 'Exact task payload and pinned source', JSON.stringify({ task: data.task, source: data.source, source_pins: data.source_pins }, null, 2));
      if (proposal.accepted_task) card.append($('p', 'field-help', proposal.accepted_task.unavailable ? 'Previously accepted task is unavailable. It is not recreated.' : `Accepted local task ${proposal.accepted_task.id}${proposal.accepted_task.changed ? ' has since changed. Your edits are preserved.' : '.'}`));
      if (data.state === 'awaiting_review' || data.state === 'accepting') {
        const accept = button(data.state === 'accepting' ? 'Finish reviewed academic task' : 'Accept this academic task', true); accept.disabled = data.state === 'awaiting_review' && proposal.needs_refresh; card.append(accept);
        if (data.state === 'accepting') card.append($('p', 'field-help', 'This acceptance was interrupted. Finish uses the exact saved review and durable task receipt. A changed source blocks a task that has not been created; a task already saved is not duplicated.'));
        accept.addEventListener('click', () => action(accept, async generation => {
          const approved = await confirmAction(`Add exactly “${data.task.title}” as one local pending task? Deadline: ${deadlineText(data.task.deadline)}. This does not complete schoolwork or change the source. ${data.state === 'accepting' ? 'If the task was already saved, finish its receipt instead of creating another.' : ''}`, { title: 'Review one academic task', confirmLabel: data.state === 'accepting' ? 'Finish saved review' : 'Add this local task' });
          if (!approved || !current(generation) || !state.proposals.some(row => row.id === proposal.id && row.revision === proposal.revision)) return;
          await request(`/academic-tasks/proposals/${proposal.id}/accept`, { method: 'POST', body: { expected_revision: proposal.review_revision, payload_hash: data.payload_hash, confirmed: true } });
          if (!current(generation)) return; invalidateSelection(); await refresh(); if (current(generation)) notice('Exact academic task acceptance saved. Review it in Today. Inspect again before selecting another deadline so existing task matches are current.');
        }));
        if (data.state === 'awaiting_review') {
          const reject = button('Reject this academic task'); card.append(reject); reject.addEventListener('click', () => action(reject, async generation => {
            const approved = await confirmAction(`Reject this exact proposed task “${data.task.title}”? Existing tasks and source information remain.`, { title: 'Review task rejection', confirmLabel: 'Reject proposal' });
            if (!approved || !current(generation) || !state.proposals.some(row => row.id === proposal.id && row.revision === proposal.revision)) return;
            await request(`/academic-tasks/proposals/${proposal.id}/reject`, { method: 'POST', body: { expected_revision: proposal.revision, payload_hash: data.payload_hash, confirmed: true } });
            if (current(generation)) await refresh();
          }));
        }
      }
      proposalList.append(card);
    }
  }
  async function refresh() {
    const generation = state.generation, serial = ++refreshSerial, oldSelection = snapshotSelect.value;
    const [context, previews, proposals] = await Promise.all(['/academic-tasks/context', '/academic-tasks/previews', '/academic-tasks/proposals'].map(path => request(path)));
    if (generation !== state.generation || serial !== refreshSerial) return;
    state.ready = true; state.snapshots = context.snapshots; state.previews = previews.items; state.proposals = proposals.items;
    const available = state.snapshots.some(row => row.id === oldSelection); snapshotSelect.replaceChildren(); const empty = $('option', '', 'Choose a current imported snapshot'); empty.value = ''; snapshotSelect.append(empty);
    for (const row of state.snapshots) { const option = $('option', '', `${row.institution} · saved ${row.retrieved_at}`); option.value = row.id; snapshotSelect.append(option); }
    snapshotSelect.value = available ? oldSelection : ''; if (!available) { invalidateSelection(); renderCourses(); }
    inspect.disabled = !state.snapshots.length; reload.disabled = false; renderPreviews(); renderProposals();
  }
  function reset() {
    state.generation++; state.scopeVersion++; refreshSerial++; state.ready = false; state.snapshots = []; state.proposals = []; state.previews = []; state.inspected = null; state.attempts.clear(); courseFields = []; itemFields = [];
    snapshotSelect.replaceChildren(); snapshotSelect.value = ''; courses.replaceChildren($('legend', '', 'Choose up to 5 current courses')); items.replaceChildren($('legend', '', 'No assignments inspected')); previewList.replaceChildren(); proposalList.replaceChildren(); inspect.disabled = prepare.disabled = reload.disabled = true; notice('');
  }
  return { refresh, reset };
}
