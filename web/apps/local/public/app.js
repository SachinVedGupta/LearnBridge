'use strict';

// All private state is in memory. Session credentials are HTTP-only cookies;
// the request nonce is obtained from the paired runtime, never browser storage.
const API = '/api/local/v1';
const $ = id => document.getElementById(id);
const state = { nonce: null, expires: null, page: 'today', filter: 'active', tasks: [], documents: [], sources: [], sourceEntries: [], inventory: null, academicPreview: null, grants: [], proposals: [], note: null, noteDirty: false, taskDrafts: new Map(), sessionReady: false, pendingTaskCreate: null, pendingNoteCreate: null };
let activeConfirmation = null;
let hostPoll;
Object.assign(state, { profiles: [], snapshots: [], plans: [], runs: [], profileContextPreview: null, today: null });
const extensionUIs = new Map();
async function loadExtension(page) {
  if (!['career', 'learning', 'life', 'writing', 'research', 'productivity'].includes(page)) return;
  const nonce = state.nonce;
  if (!extensionUIs.has(page)) {
    const module = await import(`/${page}.js`);
    if (!state.sessionReady || state.nonce !== nonce) return;
    const mount = { career: module.mountCareerUI, learning: module.mountLearningUI, life: module.mountLifeUI, writing: module.mountWritingUI, research: module.mountResearchUI, productivity: module.mountProductivityUI }[page];
    extensionUIs.set(page, mount({ root: $(`${page}-workspace`), request, element, busy, confirmAction, message }));
  }
  await extensionUIs.get(page).refresh();
}

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function request(path, { method = 'GET', body, bootstrap = false, idempotencyKey } = {}) {
  const requestNonce = state.nonce;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (!bootstrap && state.nonce) headers['X-LearnBridge-Nonce'] = state.nonce;
  let response;
  try { response = await fetch(`${API}${path}`, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new ApiError(0, 'RUNTIME_UNAVAILABLE', 'The local runtime is unavailable. Check that the LearnBridge launcher is running, then try again.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError(response.status, 'INVALID_RESPONSE', 'The local runtime returned an unexpected response. Try refreshing this page.'); }
  if (!response.ok) {
    const code = data?.error?.code || data?.code || 'REQUEST_FAILED';
    const messages = {
      REVISION_CONFLICT: 'This item changed elsewhere. Your edits have been kept. Reload the saved version before trying again.',
      INVALID_INPUT: 'Check the fields and try again.',
      NOT_FOUND: 'This item is no longer available. Refresh the list to see what is saved.',
      CONSENT_REQUIRED: 'This action needs fresh permission. Review the source or sharing selection, then try again.',
      AUTH_REQUIRED: 'Your local session ended. Pair this browser again to continue.',
      PAIRING_FAILED: 'That pairing code is invalid or has expired. Use the current code from the launcher.',
      RATE_LIMITED: 'Too many attempts. Wait briefly before trying again.',
      STORAGE_BUSY: 'Another change is being saved. Wait briefly and try again.',
      STORAGE_ERROR: 'The change could not be saved. Your input is still here. Check the launcher for diagnostics.',
    };
    if (response.status === 401 && state.sessionReady) showPair();
    const help = path === '/pair' && response.status === 401 ? messages.PAIRING_FAILED
      : response.status === 413 ? 'This input is larger than the local runtime allows. Your input is still here; reduce its size before saving.'
        : messages[code] || (response.status === 409 ? messages.REVISION_CONFLICT : response.status === 401 ? messages.AUTH_REQUIRED : 'The request could not be completed. Your input has been kept; try again.');
    throw new ApiError(response.status, code, help);
  }
  if (!bootstrap && (!state.sessionReady || state.nonce !== requestNonce)) throw new ApiError(401, 'AUTH_REQUIRED', 'Your local session ended. Pair this browser again to continue.');
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(id, text, error = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('error', error);
  node.hidden = !text;
}

async function busy(button, action) {
  button.disabled = true;
  try { return await action(); }
  finally { button.disabled = false; }
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function deadlineFromInput(value) {
  return value ? { precision: 'date', date: value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { precision: 'unknown' };
}

function deadlineDate(task) {
  if (task.deadline?.precision === 'date') return task.deadline.date;
  if (task.deadline?.precision === 'instant') return localDate(new Date(task.deadline.instant));
  return null;
}

function deadlineLabel(task) {
  const deadline = task.deadline;
  if (deadline?.precision === 'date') return `Due ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${deadline.date}T12:00:00`))} · date only`;
  if (deadline?.precision === 'instant') return `Due ${new Date(deadline.instant).toLocaleString()}`;
  return deadline?.original ? 'Due date needs review' : 'No due date';
}

function hasUnsavedChanges() { return state.noteDirty || [...state.taskDrafts.values()].some(draft => draft.dirty); }

function confirmAction(text, { title = 'Review this action', confirmLabel = 'Continue' } = {}) {
  if (activeConfirmation) return Promise.resolve(false);
  return new Promise(resolve => {
    activeConfirmation = { resolve, previousFocus: document.activeElement };
    $('confirmation-title').textContent = title;
    $('confirmation-message').textContent = text;
    $('confirmation-accept').textContent = confirmLabel;
    $('confirmation-dialog').hidden = false;
    $('workspace').inert = true;
    $('confirmation-cancel').focus();
  });
}

function resolveConfirmation(accepted) {
  if (!activeConfirmation) return;
  const { resolve, previousFocus } = activeConfirmation;
  activeConfirmation = null;
  $('confirmation-dialog').hidden = true;
  $('workspace').inert = false;
  if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus();
  else if (!$('workspace').hidden) $('main').focus();
  resolve(accepted);
}

function createAttempt(kind, body) {
  const field = kind === 'task' ? 'pendingTaskCreate' : 'pendingNoteCreate';
  const payload = JSON.stringify(body);
  if (state[field]?.payload !== payload) state[field] = { payload, key: crypto.randomUUID() };
  return state[field].key;
}

function showPair() {
  resolveConfirmation(false);
  state.nonce = null;
  state.sessionReady = false;
  clearTimeout(hostPoll); state.hostRequest = null; $('host-turn-form').reset(); $('host-turn-list').replaceChildren(); $('host-turn-grant').replaceChildren(); $('host-capability').textContent = ''; message('host-turn-message', '');
  state.tasks = []; state.today = null;
  state.documents = [];
  state.sources = []; state.sourceEntries = []; state.inventory = null; state.academicPreview = null; state.grants = []; state.proposals = [];
  state.profiles = []; state.snapshots = []; state.plans = []; state.runs = []; state.profileContextPreview = null; $('profile-export').hidden = true;
  for (const module of extensionUIs.values()) module.reset();
  for (const id of ['profile-list', 'profile-context-choices', 'course-snapshots', 'course-choices', 'course-results', 'plan-list', 'workflow-list']) $(id).replaceChildren();
  for (const id of ['profile-context', 'course-citation', 'workflow-detail']) { $(id).textContent = ''; $(id).hidden = true; }
  $('profile-form').reset(); $('course-search-form').reset(); $('plan-form').reset(); $('academic-library-import').hidden = true;
  state.note = null;
  state.noteDirty = false;
  state.taskDrafts.clear();
  state.pendingTaskCreate = null;
  state.pendingNoteCreate = null;
  $('workspace').hidden = true;
  $('pair-screen').hidden = false;
  $('task-list').replaceChildren();
  $('note-list').replaceChildren();
  for (const id of ['source-list', 'source-entry-list', 'inventory-list', 'grant-records', 'grant-list', 'proposal-list']) $(id).replaceChildren();
  $('source-form').reset(); $('academic-form').reset(); $('academic-preview').textContent = ''; $('academic-preview').hidden = true; $('academic-import').hidden = true;
  for (const id of ['source-message', 'academic-message', 'grant-message']) message(id, '');
  $('note-form').reset();
  $('new-task-form').reset();
  $('pair-code').value = '';
  $('note-revision').textContent = '';
  $('note-hash').textContent = '';
  $('note-evidence').hidden = true;
  $('note-conflict').hidden = true;
  $('pending-count').textContent = '0';
  $('today-count').textContent = '0';
  $('completed-count').textContent = '0';
  message('global-message', '');
  message('note-message', '');
  message('task-create-message', '');
}

async function openWorkspace(session) {
  if (typeof session.nonce !== 'string' || !session.nonce) throw new ApiError(0, 'INVALID_RESPONSE', 'The local session is incomplete. Pair again through the launcher.');
  state.nonce = session.nonce;
  state.expires = session.expires_at || null;
  state.sessionReady = true;
  $('pair-code').value = '';
  message('pair-message', '');
  $('pair-screen').hidden = true;
  $('workspace').hidden = false;
  $('day-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  await newNote(false);
  const results = await Promise.allSettled([loadTasks(), loadDocuments(), loadStatus(), loadSources(), loadAgentReview(), loadCourses(), loadPlanning(), loadProfile()]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) message('global-message', failed.reason.message, true);
  renderGrantSelection();
  $('main').focus();
}

function navigate(page) {
  if (!['today', 'notes', 'sources', 'agents', 'setup', 'courses', 'planning', 'profile', 'career', 'learning', 'life', 'writing', 'research', 'productivity'].includes(page)) return;
  state.page = page;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${page}`;
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  message('global-message', '');
  const refresh = { today: loadTasks, notes: loadDocuments, courses: loadCourses, planning: loadPlanning, profile: loadProfile,
    agents: async () => { await Promise.all([loadTasks(), loadDocuments(), loadSources(), loadAgentReview()]); renderGrantSelection(); } }[page];
  if (refresh) refresh().catch(error => message('global-message', error.message, true));
  if (['career', 'learning', 'life', 'writing', 'research', 'productivity'].includes(page)) loadExtension(page).catch(error => message('global-message', error.message, true));
}

async function loadTasks() {
  const [data, today] = await Promise.all([request('/tasks'), request('/today')]);
  if (!Array.isArray(data.items)) throw new ApiError(0, 'INVALID_RESPONSE', 'The saved task list could not be read. Try refreshing.');
  state.tasks = data.items; state.today = today;
  renderTasks();
}

function taskAction(task, label, action, className = 'quiet compact') {
  const button = element('button', `button ${className}`, label);
  button.type = 'button';
  if (label && task.title) button.setAttribute('aria-label', `${label}: ${task.title}`);
  button.addEventListener('click', () => busy(button, action).catch(error => message('global-message', error.message, true)));
  return button;
}

function renderTasks() {
  const active = state.tasks.filter(task => task.status !== 'completed' && task.status !== 'cancelled');
  $('pending-count').textContent = active.length;
  $('today-count').textContent = state.today?.ordered.filter(task => task.ranking_reason === 'due_today').length ?? active.filter(task => deadlineDate(task) === localDate()).length;
  $('completed-count').textContent = state.tasks.filter(task => task.status === 'completed').length;
  const shown = state.tasks.filter(task => state.filter === 'all' || (state.filter === 'completed' ? task.status === 'completed' : task.status !== 'completed' && task.status !== 'cancelled'));
  const ordered = state.today ? [...state.today.ordered, ...state.today.review, ...state.today.undated] : [];
  const ranking = new Map(ordered.map((task, index) => [task.id, { ...task, index }]));
  shown.sort((a, b) => (ranking.get(a.id)?.index ?? Number.MAX_SAFE_INTEGER) - (ranking.get(b.id)?.index ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  $('task-list').replaceChildren();
  if (!shown.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('h3', '', state.filter === 'completed' ? 'Progress will show up here.' : 'A little space to begin.'), element('p', '', state.filter === 'completed' ? 'Complete a task to keep a record of it.' : 'Add one small next step above. You can build from there.'));
    $('task-list').append(empty);
    return;
  }
  for (const task of shown) {
    const row = element('article', `task-row${task.status === 'completed' ? ' completed' : ''}`);
    row.dataset.taskId = task.id;
    const main = element('div', 'task-row-main');
    const check = taskAction(task, task.status === 'completed' ? '✓' : '', async () => {
      try {
        await request(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { expected_revision: task.revision, status: task.status === 'completed' ? 'pending' : 'completed' } });
        await loadTasks();
        message('global-message', 'Task saved.');
      } catch (error) {
        if (error.status === 409) addTaskConflict(row, task, error.message);
        else throw error;
      }
    }, 'task-check');
    check.className = 'task-check';
    check.setAttribute('aria-pressed', String(task.status === 'completed'));
    check.setAttribute('aria-label', `${task.status === 'completed' ? 'Mark as to do' : 'Complete task'}: ${task.title}`);
    const copy = element('div', 'task-text');
    const dueDate = deadlineDate(task);
    copy.append(element('p', 'task-title', task.title), element('p', `task-meta${dueDate && dueDate < localDate() && task.status !== 'completed' ? ' task-overdue' : ''}`, `${deadlineLabel(task)} · Revision ${task.revision}`));
    const rank = ranking.get(task.id);
    const reasons = { overdue: 'Due date has passed', manually_pinned: 'You pinned this task', due_today: 'Due today', dated: 'Upcoming dated work', deadline_needs_review: 'Confirm the source deadline', intentionally_undated: 'You left this without a due date' };
    if (rank?.revision === task.revision) copy.append(element('p', 'field-help', `${reasons[rank.ranking_reason]} · ${rank.estimate_status === 'needs_effort' ? 'Add a time estimate for planning' : `${task.effort_minutes} minutes estimated`}`));
    const actions = element('div', 'task-row-actions');
    actions.append(taskAction(task, 'Edit', async () => {
      if (state.taskDrafts.has(task.id)) return;
      state.taskDrafts.set(task.id, { title: task.title, date: task.deadline?.precision === 'date' ? task.deadline.date : '', effort: task.effort_minutes ?? '', dirty: false, base: task });
      renderTasks();
      document.querySelector(`[data-task-id="${task.id}"] input`)?.focus();
    }), taskAction(task, 'Delete', async () => {
      if (!await confirmAction(`Delete “${task.title}” from this workspace?`, { title: 'Delete task?', confirmLabel: 'Delete task' })) return;
      try {
        await request(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE', body: { expected_revision: task.revision } });
        state.taskDrafts.delete(task.id);
        await loadTasks();
        message('global-message', 'Task deleted.');
      } catch (error) {
        if (error.status === 409) addTaskConflict(row, task, error.message);
        else throw error;
      }
    }, 'danger quiet compact'));
    main.append(check, copy, actions);
    row.append(main);
    if (state.taskDrafts.has(task.id)) row.append(taskEditForm(task, row));
    $('task-list').append(row);
  }
}

function addTaskConflict(row, task, text) {
  row.querySelector('.task-conflict')?.remove();
  const notice = element('div', 'notice error task-conflict');
  notice.setAttribute('role', 'alert');
  notice.append(element('p', '', text));
  notice.append(taskAction(task, 'Reload saved task', async () => {
    const draft = state.taskDrafts.get(task.id);
    if (draft?.dirty && !await confirmAction('Replace your unsaved task edits with the saved version?', { title: 'Reload saved task?', confirmLabel: 'Reload saved task' })) return;
    state.taskDrafts.delete(task.id);
    await loadTasks();
  }, 'secondary compact'));
  row.append(notice);
}

function taskEditForm(task, row) {
  const draft = state.taskDrafts.get(task.id);
  const form = element('form', 'task-edit');
  const titleGroup = element('div', 'input-group');
  const titleLabel = element('label', '', 'Task'); titleLabel.htmlFor = `task-title-${task.id}`;
  const title = element('input'); title.id = titleLabel.htmlFor; title.required = true; title.maxLength = 300; title.value = draft.title;
  const dateGroup = element('div', 'input-group');
  const dateLabel = element('label', '', 'Due date'); dateLabel.htmlFor = `task-due-${task.id}`;
  const date = element('input'); date.id = dateLabel.htmlFor; date.type = 'date'; date.value = draft.date;
  const effortGroup = element('div', 'input-group'); const effortLabel = element('label', '', 'Estimated minutes'); effortLabel.htmlFor = `task-effort-${task.id}`;
  const effort = element('input'); effort.id = effortLabel.htmlFor; effort.type = 'number'; effort.min = '1'; effort.max = '144000'; effort.value = draft.effort; effortGroup.append(effortLabel, effort);
  const updateDraft = () => { draft.title = title.value; draft.date = date.value; draft.effort = effort.value; draft.dirty = draft.title !== draft.base.title || draft.date !== (draft.base.deadline?.precision === 'date' ? draft.base.deadline.date : '') || String(draft.effort) !== String(draft.base.effort_minutes ?? ''); };
  title.addEventListener('input', updateDraft); date.addEventListener('input', updateDraft); effort.addEventListener('input', updateDraft);
  titleGroup.append(titleLabel, title); dateGroup.append(dateLabel, date);
  const actions = element('div', 'task-edit-actions');
  const save = element('button', 'button primary compact', 'Save changes'); save.type = 'submit';
  const cancel = element('button', 'button quiet compact', 'Cancel'); cancel.type = 'button';
  cancel.addEventListener('click', () => { state.taskDrafts.delete(task.id); renderTasks(); });
  actions.append(save, cancel); form.append(titleGroup, dateGroup, effortGroup, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(save, async () => {
      const body = { expected_revision: draft.base.revision, title: title.value.trim() };
      if (String(effort.value) !== String(draft.base.effort_minutes ?? '')) body.effort_minutes = effort.value ? Number(effort.value) : null;
      if (date.value !== (draft.base.deadline?.precision === 'date' ? draft.base.deadline.date : '')) body.deadline = deadlineFromInput(date.value);
      try {
        await request(`/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body });
        state.taskDrafts.delete(task.id);
        await loadTasks();
        message('global-message', 'Task changes saved.');
      } catch (error) {
        if (error.status === 409) addTaskConflict(row, task, error.message);
        else throw error;
      }
    }).catch(error => message('global-message', error.message, true));
  });
  return form;
}

async function loadDocuments() {
  const data = await request('/documents');
  if (!Array.isArray(data.items)) throw new ApiError(0, 'INVALID_RESPONSE', 'The saved note list could not be read. Try refreshing.');
  state.documents = data.items;
  renderNoteList();
}

function renderNoteList() {
  $('note-list').replaceChildren();
  if (!state.documents.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('p', '', 'No notes yet. Start one on the right.'));
    $('note-list').append(empty);
    return;
  }
  for (const doc of [...state.documents].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))) {
    const button = element('button', 'note-list-item'); button.type = 'button';
    button.dataset.documentId = doc.id;
    if (state.note?.document.id === doc.id) button.setAttribute('aria-current', 'true');
    button.append(element('strong', '', doc.title), element('span', '', `Revision ${doc.current_revision || doc.revision} · ${new Date(doc.updated_at).toLocaleDateString()}`));
    button.addEventListener('click', async () => {
      if (state.note?.document.id === doc.id) return;
      if (state.noteDirty && !await confirmAction('Discard the unsaved changes in this note and open the selected note?', { title: 'Switch notes?', confirmLabel: 'Discard and switch' })) return;
      busy(button, () => openNote(doc.id)).catch(error => message('note-message', error.message, true));
    });
    $('note-list').append(button);
  }
}

async function newNote(ask = true) {
  if (ask && state.noteDirty && !await confirmAction('Discard the unsaved changes in this note and start a new one?', { title: 'Start a new note?', confirmLabel: 'Discard and start new' })) return;
  state.note = null;
  state.noteDirty = false;
  state.pendingNoteCreate = null;
  $('note-form').reset();
  $('editor-heading').textContent = 'New note';
  $('delete-note-button').hidden = true;
  $('note-conflict').hidden = true;
  $('note-evidence').hidden = true;
  message('note-message', '');
  updateNoteSaveState();
  renderNoteList();
  if (ask) $('note-title').focus();
}

async function openNote(id) {
  const data = await request(`/documents/${encodeURIComponent(id)}`);
  if (!data.document || typeof data.content !== 'string') throw new ApiError(0, 'INVALID_RESPONSE', 'The saved note could not be read.');
  state.note = data;
  const listed = state.documents.findIndex(doc => doc.id === data.document.id);
  if (listed === -1) state.documents.push(data.document);
  else state.documents[listed] = data.document;
  state.noteDirty = false;
  $('note-title').value = data.document.title;
  $('note-content').value = data.content;
  $('editor-heading').textContent = 'Edit note';
  $('delete-note-button').hidden = false;
  $('note-conflict').hidden = true;
  message('note-message', '');
  showNoteEvidence(data);
  updateNoteSaveState();
  renderNoteList();
}

function showNoteEvidence(data) {
  const revision = typeof data.revision === 'object' ? data.revision.revision : data.revision || data.document.current_revision;
  const hash = data.sha256 || data.revision?.sha256;
  $('note-revision').textContent = `Saved revision ${revision} · ${new Date(data.document.updated_at).toLocaleString()}`;
  $('note-hash').textContent = hash ? `SHA-256 ${hash}` : 'Content hash not returned by this runtime.';
  $('note-evidence').hidden = false;
}

function updateNoteSaveState() {
  const indicator = $('note-save-state');
  indicator.textContent = state.noteDirty ? 'Unsaved changes' : state.note ? 'Saved locally' : 'Not saved';
  indicator.classList.toggle('unsaved', state.noteDirty);
}

function markNoteDirty() {
  state.noteDirty = !state.note || $('note-title').value !== state.note.document.title || $('note-content').value !== state.note.content;
  updateNoteSaveState();
}

async function saveNote() {
  const body = { title: $('note-title').value.trim(), content: $('note-content').value };
  if (!body.title) { message('note-message', 'Give this note a title before saving.', true); $('note-title').focus(); return; }
  message('note-message', '');
  try {
    const data = state.note
      ? await request(`/documents/${encodeURIComponent(state.note.document.id)}`, { method: 'PATCH', body: { ...body, expected_revision: state.note.document.revision } })
      : await request('/documents', { method: 'POST', body: { ...body, kind: 'note' }, idempotencyKey: createAttempt('note', { ...body, kind: 'note' }) });
    const doc = data.document || data;
    if (!doc.id) throw new ApiError(0, 'INVALID_RESPONSE', 'The save result could not be verified. Refresh the saved note before trying again.');
    // Retain the persisted identity even if the following verification read
    // fails. Retrying a new-note save must not silently create a duplicate.
    if (!state.note) state.note = { document: doc, content: null };
    // Read the persisted content independently; do not label a save successful
    // from the mutation response alone.
    const saved = await request(`/documents/${encodeURIComponent(doc.id)}`);
    if (saved.document?.title !== body.title || saved.content !== body.content) throw new ApiError(0, 'SAVE_UNVERIFIED', 'The saved content does not match your input. Your text is still here. Reload the saved version to review it.');
    state.note = saved;
    state.pendingNoteCreate = null;
    state.noteDirty = $('note-title').value !== saved.document.title || $('note-content').value !== saved.content;
    $('editor-heading').textContent = 'Edit note';
    $('delete-note-button').hidden = false;
    $('note-conflict').hidden = true;
    showNoteEvidence(saved);
    updateNoteSaveState();
    await loadDocuments();
    message('note-message', state.noteDirty ? 'The submitted version was saved locally. Your newer edits are still unsaved.' : 'Saved locally. The stored title and content match your note.');
  } catch (error) {
    if (error.status === 409) { $('note-conflict').hidden = false; message('note-message', ''); }
    else message('note-message', error.message, true);
  }
}

async function loadStatus() {
  const data = await request('/status');
  $('capability-list').replaceChildren();
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
  if (!capabilities.length) $('capability-list').append(element('p', 'field-help', 'The runtime has not reported any capabilities. Refresh status or check the launcher diagnostics.'));
  for (const capability of capabilities) {
    const row = element('div', 'capability-row');
    const copy = element('div');
    copy.append(element('h3', '', capability.label || capability.id), element('p', '', capability.detail || 'No additional detail reported.'));
    const available = capability.state === 'available';
    row.append(copy, element('span', `capability-state${available ? ' available' : ''}`, available ? 'Available locally' : capability.state === 'unsupported' ? 'Not available' : String(capability.state || 'Unknown')));
    $('capability-list').append(row);
  }
  $('session-expiry').textContent = state.expires ? `This browser session expires ${new Date(state.expires).toLocaleString()}.` : 'Session expiration is managed by the local runtime.';
}

$('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const code = $('pair-code').value.trim();
  $('pair-code').value = '';
  message('pair-message', '');
  busy(event.submitter, async () => {
    try { await openWorkspace(await request('/pair', { method: 'POST', body: { code }, bootstrap: true })); }
    catch (error) { message('pair-message', error.message, true); }
  });
});

for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => navigate(button.dataset.page));
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  for (const filter of document.querySelectorAll('[data-filter]')) filter.setAttribute('aria-pressed', String(filter === button));
  renderTasks();
});

$('new-task-form').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('new-task-title').value.trim();
  const date = $('new-task-due').value;
  if (!title) { message('task-create-message', 'Give this task a title.', true); return; }
  message('task-create-message', '');
  busy(event.submitter, async () => {
    try {
      const body = { title, deadline: deadlineFromInput(date), effort_minutes: $('new-task-effort').value ? Number($('new-task-effort').value) : null };
      await request('/tasks', { method: 'POST', body, idempotencyKey: createAttempt('task', body) });
      state.pendingTaskCreate = null;
      if ($('new-task-title').value.trim() === title && $('new-task-due').value === date) $('new-task-form').reset();
      await loadTasks();
      message('global-message', 'Task added to your local workspace.');
      $('new-task-title').focus();
    } catch (error) { message('task-create-message', error.message, true); }
  });
});

$('refresh-tasks').addEventListener('click', event => busy(event.currentTarget, loadTasks).catch(error => message('global-message', error.message, true)));
$('refresh-status').addEventListener('click', event => busy(event.currentTarget, loadStatus).catch(error => message('global-message', error.message, true)));
$('new-note-button').addEventListener('click', () => newNote());
$('note-title').addEventListener('input', markNoteDirty);
$('note-content').addEventListener('input', markNoteDirty);
$('note-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, saveNote); });
$('reload-note-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!state.note || !await confirmAction('Replace your unsaved text with the saved version?', { title: 'Reload saved note?', confirmLabel: 'Reload saved version' })) return;
  busy(button, () => openNote(state.note.document.id)).catch(error => message('note-message', error.message, true));
});
$('delete-note-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!state.note || !await confirmAction(`Delete “${state.note.document.title}” from the active workspace and search? Historical versions may remain in the local database and backups.`, { title: 'Delete note?', confirmLabel: 'Delete note' })) return;
  busy(button, async () => {
    try {
      await request(`/documents/${encodeURIComponent(state.note.document.id)}`, { method: 'DELETE', body: { expected_revision: state.note.document.revision } });
      await newNote(false);
      await loadDocuments();
      message('note-message', 'Note deleted.');
    } catch (error) {
      if (error.status === 409) $('note-conflict').hidden = false;
      else message('note-message', error.message, true);
    }
  });
});
$('logout-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (hasUnsavedChanges() && !await confirmAction('Disconnect this browser and discard unsaved changes?', { title: 'Disconnect browser?', confirmLabel: 'Discard and disconnect' })) return;
  busy(button, async () => {
    try {
      await request('/logout', { method: 'POST', body: {} });
      showPair();
      message('pair-message', 'Browser disconnected. Restart the launcher to get a new pairing code.');
    } catch (error) { message('global-message', error.message, true); }
  });
});
async function loadSources() {
  const data = await request('/sources');
  state.sources = data.items; state.sourceEntries = data.entries;
  $('source-list').replaceChildren(); $('source-entry-list').replaceChildren();
  for (const source of state.sources) {
    const row = element('article', 'review-row');
    row.append(element('h3', '', source.label), element('p', 'field-help', `${source.state} · revision ${source.revision}`));
    if (source.state === 'active') row.append(taskAction(source, 'Review file list', async () => {
      if (!await confirmAction(`List file names and sizes in “${source.label}”? No file bodies will be read.`, { title: 'Review folder inventory', confirmLabel: 'List files' })) return;
      const result = await request(`/sources/${source.id}/inventory`, { method: 'POST', body: {} });
      state.inventory = result.inventory; renderInventory();
    }, 'secondary compact'), taskAction(source, 'Revoke folder', async () => {
      if (!await confirmAction('Revoke new reads and agent access to snapshots from this source? Existing local snapshots and backups are retained.', { title: 'Revoke source', confirmLabel: 'Revoke' })) return;
      await request(`/sources/${source.id}/revoke`, { method: 'POST', body: { expected_revision: source.revision } });
      state.inventory = null; $('inventory-list').replaceChildren(); await loadSources();
    }, 'danger compact'));
    $('source-list').append(row);
  }
  for (const entry of state.sourceEntries) {
    const row = element('article', 'review-row');
    row.append(element('h3', '', entry.title), element('p', 'hash-text', `SHA-256 ${entry.sha256}`));
    row.append(taskAction(entry, 'Read saved snapshot', async () => {
      const result = await request(`/source-entries/${entry.id}`);
      row.querySelector('pre')?.remove(); row.append(element('pre', 'source-text', result.entry.text));
    }, 'secondary compact'));
    $('source-entry-list').append(row);
  }
  if (!state.sourceEntries.length) $('source-entry-list').append(element('p', 'field-help', 'No text imported yet.'));
}
function renderInventory() {
  const saved = state.inventory;
  $('inventory-list').replaceChildren();
  if (!saved) return;
  const inventory = saved.inventory;
  $('inventory-list').append(element('h3', '', 'Review these files'), element('p', 'field-help', 'Only explicit Import reads a file body. Imports are capped at 48,000 bytes each in this dashboard. Excluded formats and secret paths are never offered.'));
  $('inventory-list').append(element('p', 'field-help', `${inventory.counts.entriesVisited} items checked · ${inventory.counts.eligibleFiles} supported files · ${inventory.counts.excludedEntries} excluded · ${inventory.counts.totalBytes.toLocaleString()} eligible bytes. Coverage: ${inventory.coverage.state}.`));
  const exclusionNames = { secret: 'credential paths', symlink: 'symbolic links', special: 'special files', unsupportedType: 'unsupported formats', hardlink: 'hard links', depth: 'depth limit', permission: 'permission denied', changed: 'changed files' };
  const exclusions = Object.entries(inventory.exclusions).filter(([, count]) => count).map(([key, count]) => `${count} ${exclusionNames[key] || key}`);
  if (exclusions.length) $('inventory-list').append(element('p', 'field-help', `Excluded: ${exclusions.join(', ')}.`));
  if (inventory.coverage.reasons.length) $('inventory-list').append(element('p', 'field-help', 'This list is incomplete. Narrow the folder or review unavailable permissions before treating it as full coverage.'));
  for (const entry of inventory.entries) {
    const row = element('div', 'review-row');
    row.append(element('p', '', `${entry.relativePath} · ${entry.snapshot?.size ?? entry.size ?? '?'} bytes`));
    row.append(taskAction(entry, 'Import', async () => {
      if (!await confirmAction(`Read and save the text of “${entry.relativePath}” locally? This does not allow model processing.`, { title: 'Import selected text', confirmLabel: 'Import this file' })) return;
      await request(`/sources/${saved.source_id}/import`, { method: 'POST', body: { inventory_id: saved.id, entry_id: entry.id } });
      await loadSources(); message('source-message', 'Selected snapshot saved locally. Review it before allowing agent sharing.');
    }, 'secondary compact'));
    $('inventory-list').append(row);
  }
}
async function loadAgentReview() {
  const [grants, proposals, turns] = await Promise.all([request('/agent-grants'), request('/task-proposals'), request('/host-turns')]);
  state.grants = grants.items; state.proposals = proposals.items;
  $('grant-list').replaceChildren(); $('proposal-list').replaceChildren();
  for (const grant of state.grants) {
    const row = element('article', 'review-row');
    row.append(element('h3', '', `${grant.destination} · ${grant.state}`), element('p', 'field-help', `Grant ${grant.id}\nExpires ${new Date(grant.expires_at).toLocaleString()} · ${grant.used_bytes}/${grant.max_bytes} bytes used`));
    if (grant.state === 'active') row.append(taskAction(grant, 'Revoke sharing', async () => {
      await request(`/agent-grants/${grant.id}/revoke`, { method: 'POST', body: { expected_revision: grant.revision } });
      await loadAgentReview(); message('grant-message', 'Sharing revoked for future reads. Previously shared text may remain in the host’s conversation.');
    }, 'danger compact'));
    $('grant-list').append(row);
  }
  for (const proposal of state.proposals) {
    const row = element('article', 'review-row');
    row.append(element('h3', '', proposal.payload.title), element('p', 'field-help', `${proposal.destination} · ${proposal.state} · ${deadlineLabel({ deadline: proposal.payload.deadline })}`), element('p', '', proposal.payload.reason || 'No reason supplied.'), element('p', 'hash-text', `Payload SHA-256 ${proposal.payload_hash}`));
    if (proposal.state === 'awaiting_review') for (const action of ['accept', 'reject']) row.append(taskAction(proposal, action === 'accept' ? 'Accept task' : 'Reject', async () => {
      if (action === 'accept' && !await confirmAction(`Add exactly this local task: “${proposal.payload.title}”? ${deadlineLabel({ deadline: proposal.payload.deadline })}.`, { title: 'Accept reviewed proposal', confirmLabel: 'Add local task' })) return;
      await request(`/task-proposals/${proposal.id}/${action}`, { method: 'POST', body: { expected_revision: proposal.revision, payload_hash: proposal.payload_hash } });
      await loadAgentReview(); await loadTasks(); message('grant-message', action === 'accept' ? 'Reviewed task saved. No connected app was changed.' : 'Proposal rejected.');
    }, action === 'accept' ? 'primary compact' : 'quiet compact'));
    $('proposal-list').append(row);
  }
  if (!state.proposals.length) $('proposal-list').append(element('p', 'field-help', 'No proposals yet. Your agent can suggest a next step through the LearnBridge MCP bridge.'));
  const selected = $('host-turn-grant').value; $('host-turn-grant').replaceChildren();
  for (const grant of state.grants.filter(grant => grant.destination === 'codex' && grant.state === 'active' && Date.parse(grant.expires_at) > Date.now())) {
    const option = element('option', '', `Codex selection · ${grant.id.slice(0, 8)} · ${grant.used_bytes}/${grant.max_bytes} bytes`); option.value = grant.id; $('host-turn-grant').append(option);
  }
  if ([...$('host-turn-grant').options].some(option => option.value === selected)) $('host-turn-grant').value = selected;
  $('host-capability').textContent = turns.capability.detail; $('host-turn-submit').disabled = turns.capability.state === 'unavailable' || !$('host-turn-grant').options.length;
  $('host-turn-list').replaceChildren();
  for (const turn of turns.items) {
    const row = element('article', 'review-row'); row.append(element('h3', '', `Codex · ${turn.data.state.replaceAll('_', ' ')}`), element('p', 'field-help', new Date(turn.created_at).toLocaleString()));
    if (turn.data.visibility === 'withheld_scope_changed') row.append(element('p', 'field-help', 'This selection changed, expired or was revoked. Its cached reply is withheld. Review fresh context before a new request.'));
    else { if (turn.data.prompt) row.append(element('p', '', turn.data.prompt)); if (turn.data.text) row.append(element('pre', 'source-text', turn.data.text)); }
    if (turn.data.error_code) row.append(element('p', 'field-help', `Host result: ${turn.data.error_code}. Check official host access and the reviewed selection. Interrupted requests are never replayed automatically.`));
    if (['queued', 'running'].includes(turn.data.state)) row.append(taskAction(turn, 'Stop this request', async () => { await request(`/host-turns/${turn.id}/cancel`, { method: 'POST', body: { expected_revision: turn.revision } }); await loadAgentReview(); }, 'danger quiet compact'));
    if (turn.data.progress.length || turn.data.tool_receipts.length) { const details = element('details'); details.append(element('summary', '', 'Tool progress and verification receipts'), element('pre', 'source-text', JSON.stringify({ progress: turn.data.progress, receipts: turn.data.tool_receipts }, null, 2))); row.append(details); }
    $('host-turn-list').append(row);
  }
  clearTimeout(hostPoll); if (turns.items.some(turn => ['queued', 'running'].includes(turn.data.state))) { const nonce = state.nonce; hostPoll = setTimeout(() => { if (state.sessionReady && state.nonce === nonce) loadAgentReview().catch(error => message('host-turn-message', error.message, true)); }, 2000); }
}
function hostRetryKey(body) { const fingerprint = JSON.stringify(body); if (state.hostRequest?.fingerprint !== fingerprint) state.hostRequest = { fingerprint, key: crypto.randomUUID() }; return state.hostRequest.key; }
$('host-turn-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const body = { grant_id: $('host-turn-grant').value, prompt: $('host-turn-prompt').value, confirmed: true };
    if (!await confirmAction(`Send this exact request to your official Codex host using selection ${body.grant_id.slice(0, 8)}?\n\n${body.prompt}`, { title: 'Review Codex request', confirmLabel: 'Send this request' })) return;
    const result = await request('/host-turns', { method: 'POST', body, idempotencyKey: hostRetryKey(body) }); state.hostRequest = null;
    await loadAgentReview(); message('host-turn-message', `Request ${result.item.data.state.replaceAll('_', ' ')}. Any proposed changes appear in the task or writing review queue.`);
  }).catch(error => message('host-turn-message', error.message, true));
});
function renderGrantSelection() {
  $('grant-records').replaceChildren();
  for (const [kind, records] of [['tasks', state.tasks], ['documents', state.documents], ['source_entries', state.sourceEntries]]) for (const record of records) {
    const label = element('label', 'record-choice'); const checkbox = element('input');
    checkbox.type = 'checkbox'; checkbox.value = record.id; checkbox.dataset.kind = kind; checkbox.dataset.revision = record.revision;
    label.append(checkbox, element('span', '', `${record.title} · ${kind.replace('_', ' ')} · revision ${record.revision}`));
    $('grant-records').append(label);
  }
  if (!$('grant-records').childElementCount) $('grant-records').append(element('p', 'field-help', 'You can allow an empty selection for task proposals, or first add a note or selected source.'));
}
$('source-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const body = { path: $('source-path').value, label: $('source-label').value.trim() };
    if (!await confirmAction(`Register “${body.label}” at ${body.path}? LearnBridge will verify this folder’s identity. Its file list and text require separate choices.`, { title: 'Choose local folder', confirmLabel: 'Register folder' })) return;
    await request('/sources', { method: 'POST', body }); $('source-form').reset(); await loadSources();
    message('source-message', 'Folder registered. Choose Review file list to inspect metadata.');
  }).catch(error => message('source-message', error.message, true));
});
$('grant-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const expected = { tasks: [], documents: [], source_entries: [] };
    for (const checkbox of $('grant-records').querySelectorAll('input:checked')) expected[checkbox.dataset.kind].push({ id: checkbox.value, revision: Number(checkbox.dataset.revision) });
    const body = { destination: $('agent-destination').value, task_ids: expected.tasks.map(item => item.id), document_ids: expected.documents.map(item => item.id), source_entry_ids: expected.source_entries.map(item => item.id), expected_records: expected, max_bytes: Number($('grant-budget').value), expires_in_minutes: Number($('grant-minutes').value) };
    const titles = [...$('grant-records').querySelectorAll('input:checked')].map(node => node.parentNode.textContent).join('; ');
    if (!await confirmAction(`Allow ${body.destination} to process ${titles || 'no existing records (task proposals only)'}? Total budget ${body.max_bytes} UTF-8 bytes; expires in ${body.expires_in_minutes} minutes. Your host’s model service receives only this reviewed selection.`, { title: 'Review agent sharing', confirmLabel: 'Allow selected sharing' })) return;
    const result = await request('/agent-grants', { method: 'POST', body }); await loadAgentReview();
    message('grant-message', `Sharing saved. Tell your agent to use grant ${result.grant.id}.`);
  }).catch(error => message('grant-message', error.message, true));
});
$('academic-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    state.academicPreview = null; $('academic-import').hidden = true; $('academic-library-import').hidden = true;
    const result = await request('/academic/preview', { method: 'POST', body: { export: JSON.parse($('academic-export').value), selected_course_ids: $('academic-courses').value.split(',').map(value => value.trim()).filter(Boolean) } });
    state.academicPreview = result.preview_id; renderAcademicPreview(result.snapshot); $('academic-preview').hidden = false; $('academic-import').hidden = false; $('academic-library-import').hidden = false;
    message('academic-message', 'Preview only. Check course selection and uncertain deadlines before saving.');
  }).catch(error => message('academic-message', error.message, true));
});
function renderAcademicPreview(snapshot) {
  const panel = $('academic-preview'); panel.replaceChildren();
  panel.append(element('h3', '', `${snapshot.institution.name} · reviewed import`), element('p', 'field-help', `Selected courses: ${snapshot.selected_course_ids.join(', ')}. ${snapshot.assignments.length} assignments, ${snapshot.announcements.length} announcements, ${snapshot.materials.length} materials. This export does not prove a live connection or complete university coverage.`));
  for (const course of snapshot.courses) panel.append(element('p', '', course.title));
  for (const assignment of snapshot.assignments) {
    const row = element('div', 'review-row');
    row.append(element('h3', '', assignment.title), element('p', 'field-help', `${deadlineLabel(assignment)}${assignment.deadline?.precision === 'unknown' && assignment.deadline.original ? ` · Source says: ${assignment.deadline.original}` : ''}`));
    if (assignment.description) row.append(element('p', '', assignment.description));
    panel.append(row);
  }
  for (const item of [...snapshot.announcements, ...snapshot.materials]) {
    const row = element('div', 'review-row'); row.append(element('h3', '', item.title), element('p', '', item.body || '')); panel.append(row);
  }
  const details = element('details'); details.append(element('summary', '', 'Exact normalized snapshot'), element('pre', 'source-text', JSON.stringify(snapshot, null, 2))); panel.append(details);
}
$('academic-import').addEventListener('click', event => busy(event.currentTarget, async () => {
  const previewId = state.academicPreview;
  if (!previewId || !await confirmAction('Save exactly the reviewed academic snapshot as a local note? No live D2L connection or task is created.', { title: 'Save reviewed export', confirmLabel: 'Save snapshot' })) return;
  await request('/academic/import', { method: 'POST', body: { preview_id: previewId } }); await loadDocuments();
  message('academic-message', 'Reviewed snapshot saved in Notes. Agent sharing is a separate choice.');
}).catch(error => message('academic-message', error.message, true)));
$('refresh-sources').addEventListener('click', event => busy(event.currentTarget, loadSources).catch(error => message('source-message', error.message, true)));
$('refresh-agents').addEventListener('click', event => busy(event.currentTarget, async () => { await Promise.all([loadTasks(), loadDocuments(), loadSources(), loadAgentReview()]); renderGrantSelection(); }).catch(error => message('grant-message', error.message, true)));

async function loadCourses() {
  state.snapshots = (await request('/courses')).items;
  const selected = $('course-snapshot').value;
  $('course-snapshot').replaceChildren(); $('course-snapshots').replaceChildren();
  const placeholder = element('option', '', 'Choose a reviewed snapshot'); placeholder.value = ''; $('course-snapshot').append(placeholder);
  for (const record of state.snapshots) {
    const snapshot = record.data.snapshot;
    const option = element('option', '', `${snapshot.institution.name} · ${new Date(snapshot.retrieved_at).toLocaleString()}`); option.value = record.id; $('course-snapshot').append(option);
    const row = element('article', 'review-row');
    row.append(element('h3', '', snapshot.institution.name), element('p', 'field-help', `${snapshot.courses.map(course => course.title).join(', ')} · ${snapshot.assignments.length} assignments · ${snapshot.materials.length} materials`));
    const coverage = element('details'); coverage.append(element('summary', '', 'Coverage and unknown deadlines'), element('pre', 'source-text', JSON.stringify({ coverage: snapshot.coverage, warnings: snapshot.warnings }, null, 2))); row.append(coverage);
    row.append(taskAction(record, 'Remove from active library', async () => {
      if (!await confirmAction('Remove this snapshot from active course search? Historical versions and backups may retain it.', { title: 'Remove course snapshot', confirmLabel: 'Remove from library' })) return;
      await request(`/courses/${record.id}`, { method: 'DELETE', body: { expected_revision: record.revision } });
      $('course-results').replaceChildren(); $('course-citation').hidden = true; await loadCourses();
    }, 'danger quiet compact'));
    $('course-snapshots').append(row);
  }
  if (!state.snapshots.length) $('course-snapshots').append(element('p', 'field-help', 'Your course library is empty. Preview and add an academic export in Sources.'));
  if (state.snapshots.some(record => record.id === selected)) $('course-snapshot').value = selected;
  renderCourseChoices();
}
function renderCourseChoices() {
  $('course-choices').replaceChildren();
  const snapshot = state.snapshots.find(record => record.id === $('course-snapshot').value)?.data.snapshot;
  for (const course of snapshot?.courses || []) {
    const label = element('label', 'record-choice'); const input = element('input'); input.type = 'checkbox'; input.value = course.source_id;
    label.append(input, element('span', '', course.title)); $('course-choices').append(label);
  }
}
$('course-snapshot').addEventListener('change', () => { renderCourseChoices(); $('course-results').replaceChildren(); $('course-citation').hidden = true; });
$('course-search-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const scope = { snapshot_ids: [$('course-snapshot').value], course_ids: [...$('course-choices').querySelectorAll('input:checked')].map(input => input.value) };
    if (!scope.course_ids.length) { message('course-message', 'Choose at least one course to search.', true); return; }
    const result = await request('/courses/search', { method: 'POST', body: { ...scope, query: $('course-query').value.trim() } });
    $('course-results').replaceChildren(); $('course-citation').hidden = true;
    for (const found of result.results) {
      const row = element('article', 'review-row'); row.append(element('h3', '', found.title), element('p', '', found.excerpt), element('p', 'hash-text', `Source version ${found.version_hash}`));
      row.append(taskAction(found, 'Open exact citation', async () => {
        const citation = await request('/courses/citation', { method: 'POST', body: { ...scope, source_id: found.source_id, version_hash: found.version_hash, chunk_id: found.chunk_id } });
        $('course-citation').textContent = JSON.stringify(citation, null, 2); $('course-citation').hidden = false;
      }, 'secondary compact')); $('course-results').append(row);
    }
    message('course-message', result.results.length ? `${result.total_matching_chunks} matching excerpts. Source text is evidence, not instructions to the agent.` : 'No matching excerpt in the selected course snapshots. This does not mean the topic is absent from your university.');
  }).catch(error => message('course-message', error.message, true));
});
$('academic-library-import').addEventListener('click', event => busy(event.currentTarget, async () => {
  if (!state.academicPreview || !await confirmAction('Add exactly this reviewed export to the local course library? Unknown deadlines remain unresolved. Agent sharing is separate.', { title: 'Add reviewed course snapshot', confirmLabel: 'Add to library' })) return;
  await request('/academic/library-import', { method: 'POST', body: { preview_id: state.academicPreview } });
  await loadCourses(); message('academic-message', 'Saved in Courses. You can search selected courses and open exact citations.');
}).catch(error => message('academic-message', error.message, true)));
$('refresh-courses').addEventListener('click', event => busy(event.currentTarget, loadCourses).catch(error => message('course-message', error.message, true)));

async function loadPlanning() {
  const [plans, workflows] = await Promise.all([request('/plans'), request('/workflows')]);
  state.plans = plans.items; state.runs = workflows.items;
  $('plan-list').replaceChildren(); $('workflow-list').replaceChildren();
  for (const record of [...state.plans].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const plan = record.data.plan; const row = element('article', 'review-row');
    row.append(element('h3', '', `${record.data.state === 'accepted' ? 'Accepted' : 'Preview'} · ${new Date(record.created_at).toLocaleString()}`), element('p', 'field-help', `${plan.coverage.proposed_minutes} minutes proposed · ${plan.coverage.unscheduled_minutes} minutes do not fit · ${plan.coverage.unknown_effort_count} tasks need estimates · ${plan.timezone}`));
    for (const block of plan.blocks) row.append(element('p', '', `${new Date(block.start).toLocaleTimeString()}–${new Date(block.end).toLocaleTimeString()} · ${block.title} · ${block.minutes} min${block.needs_review ? ' · needs review' : ''}`));
    for (const item of plan.unscheduled) row.append(element('p', 'field-help', `${item.title} · ${item.reason.replaceAll('_', ' ')}${item.remaining_minutes ? ` · ${item.remaining_minutes} min remaining` : ''}`));
    if (plan.conflicts.length) row.append(element('pre', 'source-text', JSON.stringify(plan.conflicts, null, 2)));
    if (record.data.state === 'proposal') row.append(taskAction(record, 'Accept this local plan', async () => {
      if (!await confirmAction(`Save exactly these ${plan.blocks.length} work blocks as your accepted local plan? Unscheduled work remains visible. No connected calendar is changed.`, { title: 'Accept study plan', confirmLabel: 'Accept local plan' })) return;
      await request(`/plans/${record.id}/accept`, { method: 'POST', body: { expected_revision: record.revision, plan_hash: plan.plan_hash } }); await loadPlanning();
      message('plan-message', 'Accepted plan saved. You can return to it after restarting LearnBridge.');
    }, 'primary compact'));
    const evidence = element('details'); evidence.append(element('summary', '', 'Exact saved plan and evidence'), element('pre', 'source-text', JSON.stringify(record.data, null, 2))); row.append(evidence); $('plan-list').append(row);
  }
  if (!state.plans.length) $('plan-list').append(element('p', 'field-help', 'No study plans yet. Give your tasks effort estimates and choose an available time window.'));
  for (const run of state.runs) {
    const row = element('article', 'review-row'); row.append(element('h3', '', `${run.recipe_id} · ${run.state.replaceAll('_', ' ')}`), element('p', 'field-help', `${run.used.tool_calls}/${run.budget.tool_calls} operations · ${run.used.bytes}/${run.budget.bytes} bytes · checkpoint ${run.checkpoint?.next_step ?? 0}`));
    if (run.error) row.append(element('p', 'field-help', `${run.error.code}: ${run.error.next_action || 'Review this workflow.'}`));
    row.append(taskAction(run, 'View verified steps', async () => {
      const detail = await request(`/workflows/${run.id}`); $('workflow-detail').textContent = JSON.stringify(detail, null, 2); $('workflow-detail').hidden = false;
    }, 'secondary compact'));
    if (['ready', 'interrupted', 'failed', 'partial'].includes(run.state) && !run.cancel_requested && run.checkpoint?.resumable) row.append(taskAction(run, 'Run / resume', async () => {
      const result = await request(`/workflows/${run.id}/execute`, { method: 'POST', body: {} }); await loadPlanning(); message('plan-message', `Workflow ${result.run.state.replaceAll('_', ' ')}. Check its saved steps and result.`);
    }, 'primary compact'));
    if (!['completed', 'cancelled', 'expired'].includes(run.state)) row.append(taskAction(run, 'Cancel further work', async () => {
      await request(`/workflows/${run.id}/cancel`, { method: 'POST', body: { expected_revision: run.revision } }); await loadPlanning();
    }, 'danger quiet compact'));
    $('workflow-list').append(row);
  }
}
$('plan-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const start = new Date($('plan-start').value).toISOString(); const end = new Date($('plan-end').value).toISOString();
    const prepared = await request('/workflows', { method: 'POST', body: { recipe_id: 'plan.today', input: { availability: [{ start, end }], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, horizonEnd: end, maxDailyMinutes: Number($('plan-limit').value), bufferMinutes: Number($('plan-buffer').value) } } });
    await loadPlanning();
    const result = await request(`/workflows/${prepared.run.id}/execute`, { method: 'POST', body: {} }); await loadPlanning();
    message('plan-message', result.run.state === 'completed' ? 'Preview saved and independently verified. Review what fits and what remains before accepting.' : `Workflow ${result.run.state}. Review its progress and remaining action.`);
  }).catch(error => message('plan-message', error.message, true));
});
$('refresh-planning').addEventListener('click', event => busy(event.currentTarget, loadPlanning).catch(error => message('plan-message', error.message, true)));

async function loadProfile() {
  state.profileContextPreview = null; $('profile-export').hidden = true; $('profile-context').hidden = true; $('profile-context').textContent = '';
  state.profiles = (await request('/profile')).items;
  $('profile-list').replaceChildren(); $('profile-context-choices').replaceChildren();
  for (const record of state.profiles) {
    const fact = record.data; const row = element('article', 'review-row');
    row.append(element('h3', '', fact.field.replaceAll('_', ' ')), element('p', '', fact.value), element('p', 'field-help', `${fact.state}${record.stale ? ' · stale evidence' : ''}${record.conflict ? ' · conflicting confirmed values' : ''} · ${fact.evidence.kind.replaceAll('_', ' ')} · purposes: ${fact.purposes.join(', ')}`));
    if (fact.state === 'candidate') for (const decision of ['confirm', 'reject']) row.append(taskAction(record, decision === 'confirm' ? 'Confirm exact fact' : 'Reject', async () => {
      if (decision === 'confirm' && !await confirmAction(`Confirm your statement “${fact.value}” for ${fact.field.replaceAll('_', ' ')}? It stays local until you separately share context.`, { title: 'Confirm profile fact', confirmLabel: 'Confirm this fact' })) return;
      await request(`/profile/${record.id}/review`, { method: 'POST', body: { expected_revision: record.revision, decision, fingerprint: record.fingerprint } }); await loadProfile();
    }, decision === 'confirm' ? 'primary compact' : 'quiet compact'));
    if (fact.state !== 'rejected') {
      const edit = element('form', 'task-edit'); const label = element('label', '', 'Correct this statement'); const input = element('input'); input.id = `profile-correct-${record.id}`; label.htmlFor = input.id; input.value = fact.value; input.maxLength = 2000; input.required = true;
      const save = element('button', 'button secondary compact', 'Save correction'); save.type = 'submit'; edit.append(label, input, save);
      edit.addEventListener('submit', event => { event.preventDefault(); busy(save, async () => {
        if (!await confirmAction(`Replace this fact with your corrected statement “${input.value}”?`, { title: 'Review corrected fact', confirmLabel: 'Save correction' })) return;
        await request(`/profile/${record.id}/review`, { method: 'POST', body: { expected_revision: record.revision, decision: 'correct', fingerprint: record.fingerprint, value: input.value } }); await loadProfile();
      }).catch(error => message('profile-message', error.message, true)); });
      const details = element('details'); details.append(element('summary', '', 'Correct a value'), edit); row.append(details);
    }
    row.append(taskAction(record, 'Forget active fact', async () => {
      if (!await confirmAction('Remove this fact from your active profile and context previews? Historical local revisions and backups may retain it.', { title: 'Forget active profile fact', confirmLabel: 'Remove active fact' })) return;
      await request(`/profile/${record.id}`, { method: 'DELETE', body: { expected_revision: record.revision } }); $('profile-context').textContent = ''; $('profile-context').hidden = true; await loadProfile();
    }, 'danger quiet compact')); $('profile-list').append(row);
    if (fact.state === 'confirmed' && !record.stale && !record.conflict) {
      const label = element('label', 'record-choice'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = record.id;
      label.append(checkbox, element('span', '', `${fact.field.replaceAll('_', ' ')}: ${fact.value}`)); $('profile-context-choices').append(label);
    }
  }
  if (!state.profiles.length) $('profile-list').append(element('p', 'field-help', 'No facts yet. Start with a learning preference or a goal in your own words.'));
}
$('profile-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    await request('/profile', { method: 'POST', body: { field: $('profile-field').value, value: $('profile-value').value } }); $('profile-form').reset(); await loadProfile(); message('profile-message', 'Candidate saved. Confirm or correct its exact value below.');
  }).catch(error => message('profile-message', error.message, true));
});
$('profile-context-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const input = { purpose: $('profile-purpose').value, allowed_ids: [...$('profile-context-choices').querySelectorAll('input:checked')].map(input => input.value) };
    const result = await request('/profile/context', { method: 'POST', body: input });
    state.profileContextPreview = { ...input, context_hash: result.context_hash };
    $('profile-export').hidden = !result.items.length;
    $('profile-context').textContent = JSON.stringify(result, null, 2); $('profile-context').hidden = false;
  }).catch(error => message('profile-message', error.message, true));
});
$('profile-context-form').addEventListener('change', () => { state.profileContextPreview = null; $('profile-export').hidden = true; $('profile-context').hidden = true; $('profile-context').textContent = ''; });
$('profile-export').addEventListener('click', event => busy(event.currentTarget, async () => {
  const preview = state.profileContextPreview; if (!preview) return;
  if (!await confirmAction('Save this exact purpose-limited profile as a private note? This creates a retained copy. You choose separately whether an agent may read that note.', { title: 'Save reviewed profile context', confirmLabel: 'Save private note' })) return;
  const result = await request('/profile/export', { method: 'POST', body: preview });
  message('profile-message', `Saved private note “${result.document.title}”. In Agent access, select that note and approve the destination before using it with Codex or Claude.`);
}).catch(error => message('profile-message', error.message, true)));
$('refresh-profile').addEventListener('click', event => busy(event.currentTarget, loadProfile).catch(error => message('profile-message', error.message, true)));

window.addEventListener('beforeunload', event => { if (state.sessionReady && hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
$('confirmation-cancel').addEventListener('click', () => resolveConfirmation(false));
$('confirmation-accept').addEventListener('click', () => resolveConfirmation(true));
$('confirmation-dialog').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); resolveConfirmation(false); }
  else if (event.key === 'Tab') {
    const first = $('confirmation-cancel'); const last = $('confirmation-accept');
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

(async () => {
  const pairButton = $('pair-form').querySelector('button');
  pairButton.disabled = true;
  try { await openWorkspace(await request('/session', { bootstrap: true })); }
  catch (error) {
    showPair();
    // An unpaired browser is expected on first use; network failures need help.
    if (error.status !== 401 && error.status !== 403) message('pair-message', error.message, true);
  }
  finally { pairButton.disabled = false; }
})();
