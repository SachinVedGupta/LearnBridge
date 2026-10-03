// Local-only career records. Never render imported text as HTML, auto-fill an
// external form, execute code, submit an application or send a follow-up here.
export function mountCareerUI({ root, request, element, busy, confirmAction, message }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const state = { roles: [], facts: [], applications: [], practice: [], followups: [], generation: 0, attempts: new Map(), answerDrafts: new Map() };
  let fieldSequence = 0;
  const status = $('p', 'notice'); status.id = 'career-status'; status.setAttribute('role', 'status'); status.hidden = true;
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const intro = $('p', 'notice', 'Your career workspace stays local. Save a posting, prepare factual answers, and record your own practice. Posting entries are student-entered; automatic job discovery and live posting verification are not enabled. Nothing here submits or sends.');
  root.replaceChildren(intro, status);

  function panel(title, help) {
    const node = $('section', 'panel source-panel'); node.append($('h2', '', title));
    if (help) node.append($('p', 'field-help', help)); root.append(node); return node;
  }
  function field(parent, label, { type = 'text', required = false, value = '', multiline = false } = {}) {
    const wrapper = $('label', '', label), input = $(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = type;
    input.value = value; input.required = required;
    if (multiline) { input.rows = 4; input.className = 'career-textarea'; input.maxLength = 20000; }
    else input.maxLength = 1000;
    wrapper.append(input); parent.append(wrapper); return input;
  }
  function select(parent, label, choices) {
    const wrapper = $('div'), caption = $('label', '', label), input = $('select'); input.id = `career-select-${++fieldSequence}`; caption.htmlFor = input.id;
    for (const [value, caption] of choices) { const option = $('option', '', caption); option.value = value; input.append(option); }
    wrapper.append(caption, input); parent.append(wrapper); return input;
  }
  const button = (text, primary = false) => { const b = $('button', `button ${primary ? 'primary' : 'secondary'} compact`, text); b.type = 'button'; return b; };
  function attempt(name, body) {
    const payload = JSON.stringify(body);
    if (state.attempts.get(name)?.payload !== payload) state.attempts.set(name, { payload, key: crypto.randomUUID() });
    return state.attempts.get(name).key;
  }
  async function action(target, fn) {
    try { await busy(target, fn); } catch (error) { notice(error.message || 'The career change could not finish. Your input is still here.', true); }
  }
  function factChoices(parent) {
    const box = $('fieldset'), legend = $('legend', '', 'Choose confirmed profile facts for this draft'); box.append(legend); parent.append(box);
    return { box, render() {
      const selectedIds = new Set([...box.querySelectorAll('input:checked')].map(input => input.value));
      box.replaceChildren(legend);
      for (const fact of state.facts) {
        const label = $('label', 'record-choice'), check = $('input'); check.type = 'checkbox'; check.value = fact.id;
        check.checked = selectedIds.has(fact.id);
        label.append(check, $('span', '', `${fact.key.replaceAll('_', ' ')}: ${fact.value} (revision ${fact.revision})`)); box.append(label);
      }
      if (!state.facts.length) box.append($('p', 'field-help', 'Add and confirm career-purpose facts in Profile first. Generic eligibility text is not treated as GPA, work authorization or a disclosure.'));
    }, selected: () => [...box.querySelectorAll('input:checked')].map(input => input.value) };
  }

  const rolePanel = panel('Save a role', 'Paste a current company or ATS posting. An unverified board lead stays clearly labeled; a saved entry is not proof that the opening remains available.');
  const roleForm = $('form', 'career-form'); rolePanel.append(roleForm);
  const company = field(roleForm, 'Company', { required: true }), title = field(roleForm, 'Role title', { required: true });
  const jobId = field(roleForm, 'Posting ID from the company or ATS', { required: true });
  const url = field(roleForm, 'Posting URL', { required: true, type: 'url' });
  const sourceKind = select(roleForm, 'Source', [['official', 'Official company or ATS link'], ['lead', 'Unverified lead']]);
  const availability = select(roleForm, 'What the posting currently says', [['open', 'Listed as open'], ['unknown', 'Not sure'], ['closed', 'Closed']]);
  const location = field(roleForm, 'Location (optional)'), term = field(roleForm, 'Term (optional)');
  const excerpt = field(roleForm, 'Posting excerpt you reviewed', { required: true, multiline: true });
  const roleSave = button('Save role', true); roleSave.type = 'submit'; roleForm.append(roleSave);
  roleForm.addEventListener('submit', event => { event.preventDefault(); action(roleSave, async () => {
    const body = { company: company.value, title: title.value, provider_job_id: jobId.value, url: url.value,
      source_kind: sourceKind.value, availability: sourceKind.value === 'lead' ? 'unknown' : availability.value,
      source_excerpt: excerpt.value, locations: location.value ? [location.value] : [], ...(term.value ? { term: term.value } : {}) };
    await request('/career/roles', { method: 'POST', body, idempotencyKey: attempt('role', body) });
    roleForm.reset(); state.attempts.delete('role'); await refresh(); notice('Role saved locally. Its live availability has not been checked by LearnBridge.');
  }); });
  const roleList = $('div'); rolePanel.append(roleList);

  const applicationPanel = panel('Prepare factual application answers', 'Choose a saved role and confirmed profile facts. Answers quote those facts exactly. Missing information stays blank; nothing fills or submits an external form.');
  const appForm = $('form', 'career-form'); applicationPanel.append(appForm);
  const roleChoice = select(appForm, 'Role', []), chosenFacts = factChoices(appForm);
  const questionBox = $('fieldset'); questionBox.append($('legend', '', 'Questions to include')); appForm.append(questionBox);
  const questionDefaults = [
    ['experience', 'Describe relevant experience.', true, true], ['full_name', 'Full name', true, false],
    ['education', 'Education', true, false], ['graduation_date', 'Expected graduation date', false, false],
    ['gpa', 'GPA', true, false], ['work_authorization', 'Work authorization', true, false],
  ];
  const questionFields = questionDefaults.map(([key, prompt, checked, isRequired]) => {
    const row = $('div', 'review-row'), includeLabel = $('label', 'record-choice'), include = $('input'); include.type = 'checkbox'; include.checked = checked;
    includeLabel.append(include, $('span', '', `Include ${key.replaceAll('_', ' ')}`)); row.append(includeLabel);
    const wording = field(row, 'Exact question', { value: prompt });
    const requiredLabel = $('label', 'record-choice'), required = $('input'); required.type = 'checkbox'; required.checked = isRequired;
    requiredLabel.append(required, $('span', '', 'Required answer')); row.append(requiredLabel); questionBox.append(row);
    return { key, include, wording, required };
  });
  const prepare = button('Prepare local draft', true); prepare.type = 'submit'; appForm.append(prepare);
  appForm.addEventListener('submit', event => { event.preventDefault(); action(prepare, async () => {
    const body = { role_id: roleChoice.value, selected_profile_ids: chosenFacts.selected(),
      questions: questionFields.filter(q => q.include.checked).map(q => ({ id: q.key, prompt: q.wording.value,
        fact_key: q.key, required: q.required.checked, max_length: 4000 })) };
    await request('/career/applications', { method: 'POST', body, idempotencyKey: attempt('application', body) });
    state.attempts.delete('application'); await refresh(); notice('Application answer draft saved. Review missing facts and every exact answer before accepting it.');
  }); });
  const appList = $('div'); applicationPanel.append(appList);

  const practicePanel = panel('Practice and keep your checkpoint', 'Record your own answers and hints. These local sessions do not execute code or infer mastery; an untested answer remains unassessed.');
  const practiceForm = $('form', 'career-form'); practicePanel.append(practiceForm);
  const practiceTitle = field(practiceForm, 'Practice title', { required: true });
  const practiceMode = select(practiceForm, 'Mode', [['mock_interview', 'Mock interview'], ['hints', 'Hints'], ['timed', 'Timed attempt'], ['walkthrough', 'Walkthrough']]);
  const questionText = field(practiceForm, 'Questions (one per line)', { required: true, multiline: true });
  const practiceStart = button('Start practice', true); practiceStart.type = 'submit'; practiceForm.append(practiceStart);
  practiceForm.addEventListener('submit', event => { event.preventDefault(); action(practiceStart, async () => {
    const questions = questionText.value.split('\n').map(s => s.trim()).filter(Boolean).map((prompt, index) => ({ id: `question-${index + 1}`, prompt }));
    const body = { exercise_id: 'student-created', title: practiceTitle.value, mode: practiceMode.value, questions };
    await request('/career/practice', { method: 'POST', body, idempotencyKey: attempt('practice', body) });
    practiceForm.reset(); state.attempts.delete('practice'); await refresh(); notice('Practice session saved. Only answers you provide count as answered questions.');
  }); });
  const practiceList = $('div'); practicePanel.append(practiceList);

  const followupPanel = panel('Prepare a follow-up and reminder', 'Keep an unsent draft based on selected confirmed facts. A reminder is a separate local task you review; it does not mean an application was submitted or a message was sent.');
  const followupForm = $('form', 'career-form'); followupPanel.append(followupForm);
  const applicationChoice = select(followupForm, 'Related application draft', []);
  const recipient = field(followupForm, 'Recipient or contact label', { required: true });
  const channel = select(followupForm, 'Intended channel', [['email', 'Email'], ['linkedin', 'LinkedIn'], ['other', 'Other']]);
  const remindAt = field(followupForm, 'Remind me at (this computer’s time zone)', { type: 'datetime-local', required: true });
  const followupFacts = factChoices(followupForm), followupSave = button('Save unsent follow-up', true); followupSave.type = 'submit'; followupForm.append(followupSave);
  followupForm.addEventListener('submit', event => { event.preventDefault(); action(followupSave, async () => {
    const body = { application_id: applicationChoice.value, contact_id: recipient.value, recipient: recipient.value, channel: channel.value,
      selected_profile_ids: followupFacts.selected(), remind_at: new Date(remindAt.value).toISOString() };
    await request('/career/followups', { method: 'POST', body, idempotencyKey: attempt('followup', body) });
    state.attempts.delete('followup'); await refresh(); notice('Unsent follow-up saved. Its reminder still needs your separate review.');
  }); });
  const followupList = $('div'); followupPanel.append(followupList);

  function renderRoles() {
    const selectedRole = roleChoice.value;
    roleList.replaceChildren(); roleChoice.replaceChildren();
    for (const record of state.roles) {
      const role = record.data.role, row = $('article', 'review-row');
      row.append($('h3', '', `${role.company} · ${role.title}`));
      const link = $('a', '', 'Open posting'); link.href = role.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
      row.append($('p', 'field-help', `${role.source_kind === 'lead' ? 'Unverified lead' : 'Student-entered official excerpt'} · ${role.availability} · saved ${new Date(role.fetched_at).toLocaleString()}${record.view.stale ? ' · stale; recheck the posting' : ''}`));
      const details = $('details'), summary = $('summary', '', 'Reviewed posting excerpt'); details.append(summary, $('p', 'source-text', role.source_excerpt)); row.append(details);
      const choice = select(row, 'Shortlist status', [['saved', 'Saved'], ['investigating', 'Investigating'], ['preparing', 'Preparing'], ['closed', 'Closed'], ['dismissed', 'Dismissed']]);
      choice.value = record.data.shortlist?.state ?? 'saved';
      const save = button('Save shortlist status'); row.append(save); save.addEventListener('click', () => action(save, async () => {
        await request(`/career/roles/${record.id}/shortlist`, { method: 'POST', body: { expected_revision: record.revision, state: choice.value } });
        await refresh(); notice('Shortlist decision saved.');
      })); roleList.append(row);
      const option = $('option', '', `${role.company} · ${role.title}`); option.value = record.id; roleChoice.append(option);
    }
    if ([...roleChoice.options].some(option => option.value === selectedRole)) roleChoice.value = selectedRole;
    prepare.disabled = !state.roles.length;
  }
  function renderApplications() {
    const selectedApplication = applicationChoice.value;
    appList.replaceChildren(); applicationChoice.replaceChildren();
    for (const record of state.applications) {
      const draft = record.data.draft, row = $('article', 'review-row'); row.append($('h3', '', record.title), $('p', 'field-help', `${draft.state.replaceAll('_', ' ')}${record.needs_refresh ? ' · source changed or expired; prepare a fresh draft' : ''} · no submission capability`));
      for (const answer of draft.answers) row.append($('h3', '', `${answer.prompt}${answer.required ? ' (required)' : ''}`), $('p', 'source-text', answer.answer ?? `Missing: ${answer.unresolved?.replaceAll('_', ' ')}`));
      for (const item of draft.unresolved.filter(item => !item.question_id)) row.append($('p', 'field-help', `${item.required ? 'Required' : 'Optional'}: ${item.reason.replaceAll('_', ' ')}`));
      const fingerprint = $('details'), fingerprintLabel = $('summary', '', 'Exact review fingerprint');
      fingerprint.append(fingerprintLabel, $('p', 'source-text', record.review_hash)); row.append(fingerprint);
      if (!draft.review) for (const decision of ['accept', 'reject']) {
        const review = button(decision === 'accept' ? 'Accept this local draft' : 'Reject draft', decision === 'accept');
        review.disabled = decision === 'accept' && (draft.state === 'blocked' || record.needs_refresh);
        row.append(review); review.addEventListener('click', () => action(review, async () => {
          const packageText = draft.answers.map(a => `${a.prompt}\n${a.answer ?? 'Unresolved'}`).join('\n\n');
          if (!await confirmAction(`${decision === 'accept' ? 'Accept' : 'Reject'} this exact local draft? No application will be submitted.\n\n${packageText}\n\nFingerprint: ${record.review_hash}`, { title: 'Review application answers', confirmLabel: decision === 'accept' ? 'Accept local draft' : 'Reject draft' })) return;
          await request(`/career/applications/${record.id}/review`, { method: 'POST', body: { expected_revision: record.revision, review_hash: record.review_hash, decision } });
          await refresh(); notice('Draft review saved. Nothing was submitted.');
        }));
      }
      appList.append(row); const option = $('option', '', record.title); option.value = record.id; applicationChoice.append(option);
    }
    if ([...applicationChoice.options].some(option => option.value === selectedApplication)) applicationChoice.value = selectedApplication;
    followupSave.disabled = !state.applications.length;
  }
  function renderPractice() {
    practiceList.replaceChildren();
    for (const record of state.practice) {
      const practice = record.data.practice, row = $('article', 'review-row'); row.append($('h3', '', practice.title), $('p', 'field-help', `${practice.state} · ${practice.attempts.length}/${practice.questions.length} questions answered · answers are not assessed by this local entry flow`));
      for (const attempt of practice.attempts) row.append($('h3', '', practice.questions.find(q => q.id === attempt.question_id).prompt), $('p', 'source-text', attempt.student_answer), $('p', 'field-help', `Hints used: ${attempt.hints_used} · ${attempt.outcome.replaceAll('_', ' ')}`));
      if (practice.state === 'active') {
        const question = practice.questions.find(q => q.id === practice.checkpoint.next_question_id); row.append($('h3', '', question.prompt));
        const form = $('form', 'career-form'), answer = field(form, 'Your answer', { required: true, multiline: true }), hints = field(form, 'Hints used', { type: 'number', value: '0' }); hints.min = '0'; hints.max = '100';
        const draft = state.answerDrafts.get(record.id);
        if (draft) { answer.value = draft.answer; hints.value = draft.hints; }
        const remember = () => state.answerDrafts.set(record.id, { answer: answer.value, hints: hints.value });
        answer.addEventListener('input', remember); hints.addEventListener('input', remember);
        const save = button('Save my answer', true); save.type = 'submit'; form.append(save); row.append(form);
        form.addEventListener('submit', event => { event.preventDefault(); action(save, async () => {
          await request(`/career/practice/${record.id}/answer`, { method: 'POST', body: { expected_revision: record.revision, question_id: question.id, student_answer: answer.value, hints_used: Number(hints.value) } });
          state.answerDrafts.delete(record.id);
          await refresh(); notice('Your answer and checkpoint were saved.');
        }); });
      }
      if (['active', 'interrupted'].includes(practice.state)) {
        const actionName = practice.state === 'active' ? 'interrupt' : 'resume', transition = button(actionName === 'interrupt' ? 'Pause practice' : 'Resume at checkpoint'); row.append(transition);
        transition.addEventListener('click', () => action(transition, async () => { await request(`/career/practice/${record.id}/transition`, { method: 'POST', body: { expected_revision: record.revision, action: actionName } }); await refresh(); notice('Practice checkpoint saved.'); }));
      }
      practiceList.append(row);
    }
  }
  function renderFollowups() {
    followupList.replaceChildren();
    for (const record of state.followups) {
      const followup = record.data.followup, row = $('article', 'review-row'); row.append($('h3', '', record.title), $('p', 'source-text', followup.message), $('p', 'field-help', `Unsent ${followup.channel} draft · reminder ${new Date(followup.reminder.at).toLocaleString()}`));
      if (record.data.reminder_task) row.append($('p', 'field-help', 'Local reminder task saved. Nothing was sent.'));
      else {
        const save = button('Review and add reminder'); row.append(save); save.addEventListener('click', () => action(save, async () => {
          if (!await confirmAction(`Add one local task to follow up with ${followup.recipient} at ${new Date(followup.reminder.at).toLocaleString()}?\n\nNo message will be sent.`, { title: 'Review local reminder', confirmLabel: 'Add reminder task' })) return;
          // Hash is returned by the server, binding the exact saved draft/date.
          await request(`/career/followups/${record.id}/reminder`, { method: 'POST', body: { expected_revision: record.revision, followup_hash: record.followup_hash } });
          await refresh(); notice('One local reminder task saved. Nothing was sent.');
        }));
      }
      followupList.append(row);
    }
  }
  async function refresh() {
    const generation = state.generation;
    const values = await Promise.all(['roles', 'facts', 'applications', 'practice', 'followups'].map(path => request(`/career/${path}`)));
    if (generation !== state.generation) return;
    [state.roles, state.facts, state.applications, state.practice, state.followups] = values.map(value => value.items);
    renderRoles(); chosenFacts.render(); renderApplications(); renderPractice(); followupFacts.render(); renderFollowups();
  }
  function reset() {
    state.generation++; state.roles = []; state.facts = []; state.applications = []; state.practice = []; state.followups = []; state.attempts.clear(); state.answerDrafts.clear();
    for (const form of root.querySelectorAll('form')) form.reset();
    roleList.replaceChildren(); appList.replaceChildren(); practiceList.replaceChildren(); followupList.replaceChildren(); roleChoice.replaceChildren(); applicationChoice.replaceChildren();
    chosenFacts.render(); followupFacts.render(); notice('');
  }
  return { refresh, reset };
}
