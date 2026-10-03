'use strict';

// All private state is in memory. Session credentials are HTTP-only cookies;
// the request nonce is obtained from the paired runtime, never browser storage.
const API = '/api/local/v1';
const $ = id => document.getElementById(id);
const state = { nonce: null, expires: null, page: 'today', filter: 'active', tasks: [], documents: [], note: null, noteDirty: false, taskDrafts: new Map(), sessionReady: false, pendingTaskCreate: null, pendingNoteCreate: null };
let activeConfirmation = null;

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
      CONSENT_REQUIRED: 'Pair this browser with the local launcher to continue.',
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
  state.tasks = [];
  state.documents = [];
  state.note = null;
  state.noteDirty = false;
  state.taskDrafts.clear();
  state.pendingTaskCreate = null;
  state.pendingNoteCreate = null;
  $('workspace').hidden = true;
  $('pair-screen').hidden = false;
  $('task-list').replaceChildren();
  $('note-list').replaceChildren();
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
  const results = await Promise.allSettled([loadTasks(), loadDocuments(), loadStatus()]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) message('global-message', failed.reason.message, true);
  $('main').focus();
}

function navigate(page) {
  if (!['today', 'notes', 'setup'].includes(page)) return;
  state.page = page;
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${page}`;
  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  message('global-message', '');
}

async function loadTasks() {
  const data = await request('/tasks');
  if (!Array.isArray(data.items)) throw new ApiError(0, 'INVALID_RESPONSE', 'The saved task list could not be read. Try refreshing.');
  state.tasks = data.items;
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
  $('today-count').textContent = active.filter(task => deadlineDate(task) === localDate()).length;
  $('completed-count').textContent = state.tasks.filter(task => task.status === 'completed').length;
  const shown = state.tasks.filter(task => state.filter === 'all' || (state.filter === 'completed' ? task.status === 'completed' : task.status !== 'completed' && task.status !== 'cancelled'));
  shown.sort((a, b) => {
    const aDate = deadlineDate(a); const bDate = deadlineDate(b);
    const aBucket = a.status === 'completed' ? 3 : aDate && aDate < localDate() ? 0 : aDate ? 1 : 2;
    const bBucket = b.status === 'completed' ? 3 : bDate && bDate < localDate() ? 0 : bDate ? 1 : 2;
    return aBucket - bBucket || (aDate || '').localeCompare(bDate || '') || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
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
    const actions = element('div', 'task-row-actions');
    actions.append(taskAction(task, 'Edit', async () => {
      if (state.taskDrafts.has(task.id)) return;
      state.taskDrafts.set(task.id, { title: task.title, date: task.deadline?.precision === 'date' ? task.deadline.date : '', dirty: false, base: task });
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
  const updateDraft = () => { draft.title = title.value; draft.date = date.value; draft.dirty = draft.title !== draft.base.title || draft.date !== (draft.base.deadline?.precision === 'date' ? draft.base.deadline.date : ''); };
  title.addEventListener('input', updateDraft); date.addEventListener('input', updateDraft);
  titleGroup.append(titleLabel, title); dateGroup.append(dateLabel, date);
  const actions = element('div', 'task-edit-actions');
  const save = element('button', 'button primary compact', 'Save changes'); save.type = 'submit';
  const cancel = element('button', 'button quiet compact', 'Cancel'); cancel.type = 'button';
  cancel.addEventListener('click', () => { state.taskDrafts.delete(task.id); renderTasks(); });
  actions.append(save, cancel); form.append(titleGroup, dateGroup, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(save, async () => {
      const body = { expected_revision: draft.base.revision, title: title.value.trim() };
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
      const body = { title, deadline: deadlineFromInput(date) };
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
