// Selected transfer files only. No provider credentials, folder scan or cloud fetch.
export function mountCloudOnboardingUI({ root, request, element, busy, confirmAction, message, navigate }) {
  const $ = (tag, className, text) => element(tag, className, text);
  const state = { generation: 0, bundle: null, reviewed: null, items: [] };
  let fieldId = 0, expiryTimer;
  const status = $('p', 'notice'); status.id = 'cloud-onboarding-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  function button(label) { const node = $('button', 'button secondary', label); node.type = 'button'; return node; }
  function action(control, callback) { busy(control, callback).catch(error => notice(error.message, true)); }
  function invalidate() { state.generation++; state.reviewed = null; clearTimeout(expiryTimer); reviewPanel.hidden = true; reviewPanel.replaceChildren(); notice(''); }
  root.replaceChildren($('p', 'notice', 'Bring only the cloud items you chose on your own signed-in LearnBridge website. This dashboard reads one selected JSON transfer file; it does not log in to providers, scan accounts or grant model access.'), status);
  const preparePanel = $('section', 'panel source-panel'); preparePanel.append($('h2', '', '1. Prepare a selected cloud transfer'));
  preparePanel.append($('p', 'field-help', 'On the website, choose your own Google Docs or Notion account, search for specific items, check up to three, review the returned text and download the selected-source bundle. For Gmail, choose one folder, UTC date window and subject phrase, then review only exact checked messages. This requires your provider connection; developer and desktop accounts are never used as a fallback.'));
  const website = $('a', 'button secondary', 'Open signed-in cloud selection'); website.href = 'https://thelearnbridge.vercel.app/onboarding/cloud'; website.target = '_blank'; website.rel = 'noopener noreferrer'; preparePanel.append(website);
  const emailWebsite = $('a', 'button secondary', 'Choose selected Gmail messages'); emailWebsite.href = 'https://thelearnbridge.vercel.app/onboarding/email'; emailWebsite.target = '_blank'; emailWebsite.rel = 'noopener noreferrer'; preparePanel.append(emailWebsite);
  preparePanel.append($('p', 'field-help', 'Use your own LearnBridge sign-in. Review and download the selected text there, then return here to import it. Sharing with your agent is a separate choice.'));
  const importPanel = $('section', 'panel source-panel'); importPanel.append($('h2', '', '2. Choose one transfer file'));
  const fileLabel = $('label', '', 'Selected-source JSON file'), file = $('input'); file.type = 'file'; file.accept = '.json,application/json'; file.id = `cloud-file-${++fieldId}`; fileLabel.htmlFor = file.id; importPanel.append(fileLabel, file);
  const policyLabel = $('label', '', 'Academic policy for the private copies'), policy = $('select'); policy.id = `cloud-policy-${++fieldId}`; policyLabel.htmlFor = policy.id;
  for (const [value, label] of [['learning_support', 'Learning support'], ['graded_restricted', 'Graded work: scaffolding and feedback only'], ['unrestricted', 'Personal or ungraded material']]) { const option = $('option', '', label); option.value = value; policy.append(option); }
  importPanel.append(policyLabel, policy, $('p', 'field-help', 'An exported graded-work policy cannot be weakened here. Importing preserves private source copies; it does not complete an assignment or verify facts.'));
  const prepare = button('Preview exact selected cloud import'); prepare.disabled = true; importPanel.append(prepare);
  const reviewPanel = $('section', 'panel source-panel'); reviewPanel.hidden = true;
  const listPanel = $('section', 'panel source-panel'); listPanel.append($('h2', '', 'Selected cloud source receipts')); const items = $('div'); listPanel.append(items);
  root.append(preparePanel, importPanel, reviewPanel, listPanel);
  file.addEventListener('change', () => {
    invalidate(); state.bundle = null; prepare.disabled = true; const chosen = file.files?.[0], generation = state.generation;
    if (!chosen) return;
    if (file.files.length !== 1 || chosen.size > 110000) { notice('Choose one selected-source JSON file smaller than 110,000 bytes.', true); return; }
    chosen.text().then(text => { if (generation !== state.generation) return; try { state.bundle = JSON.parse(text); prepare.disabled = false; notice('One transfer file is loaded for preview. No notes or sharing were created.'); } catch { notice('This file is not valid JSON. Choose the reviewed LearnBridge transfer bundle.', true); } }).catch(() => { if (generation === state.generation) notice('The selected file could not be read.', true); });
  });
  policy.addEventListener('change', invalidate);
  function renderPreview(result) {
    const { preview } = result; state.reviewed = result; reviewPanel.hidden = false; reviewPanel.replaceChildren($('h2', '', '3. Review source text and account ownership'));
    reviewPanel.append($('p', 'notice', 'This transfer file reports a hosted identity. Its hash checks integrity; this local workspace has not authenticated that account. Confirm the account is yours and review every selected text passage.'),
      $('p', 'field-help', `App: ${preview.bundle.provider} · account: ${preview.bundle.account_id} · hosted student ID (bundle reported): ${preview.bundle.owner.student_id}`),
      $('p', 'field-help', `Reported website: ${preview.bundle.origin} · retrieved: ${preview.bundle.retrieved_at} · effective policy: ${preview.academic_policy}`),
      $('p', 'field-help', `Change: ${preview.change.replaceAll('_', ' ')}. Live freshness: not checked. AI sharing: not granted.`));
    for (const record of preview.bundle.records) {
      const article = $('article'); article.append($('h3', '', record.title), $('p', 'field-help', `Source ID: ${record.id} · source-reported modification: ${record.modified_at || 'unknown'}`), $('pre', 'source-text', record.text || '(Empty returned text)'), $('p', 'field-help', `Source text SHA-256: ${record.sha256}`));
      if (record.source_metadata?.kind === 'email') { const metadata = record.source_metadata; article.append($('p', 'field-help', `Email thread: ${metadata.thread_id}\nFrom (provider reported): ${metadata.from ?? 'not reported'}\nTo (provider reported): ${metadata.to ?? 'not reported'}\nDate header: ${metadata.date_header ?? 'not reported'}\nSent time (Date header only): ${metadata.sent_at ?? 'not reported'}\nReceived time: not reported\nProvider timestamp (meaning unverified): ${metadata.provider_timestamp ?? 'not reported'}\nSelected folder: ${metadata.selected_scope.folder}\nSelected UTC dates: ${metadata.selected_scope.start_date} to ${metadata.selected_scope.end_date}\nSelected subject phrase: ${metadata.selected_scope.subject_phrase}`)); }
      const reasons = $('ul'); for (const reason of record.limitations) reasons.append($('li', '', reason)); article.append(reasons); reviewPanel.append(article);
    }
    const limits = $('ul'); for (const reason of preview.limitations) limits.append($('li', '', reason)); reviewPanel.append(limits, $('p', 'source-text', `Exact review SHA-256: ${preview.review_hash}`));
    const owner = $('input'); owner.type = 'checkbox'; owner.id = `cloud-owner-${++fieldId}`; const ownerLabel = $('label', '', 'I confirm this exported account is mine, and reviewed all selected text, provenance, academic policy and limits.'); ownerLabel.htmlFor = owner.id; reviewPanel.append(owner, ownerLabel);
    const save = button(preview.change === 'resume_incomplete' ? 'Finish this reviewed private import' : 'Save reviewed private source copies'); reviewPanel.append(save);
    save.addEventListener('click', () => action(save, async () => {
      if (!owner.checked) throw new Error('Review the entire selection and confirm the exported account is yours.');
      const generation = state.generation;
      if (!await confirmAction(`Import ${preview.bundle.records.length} exact selected text copy/copies from ${preview.bundle.provider}, account ${preview.bundle.account_id}, under ${preview.academic_policy}? Review ${preview.review_hash}. This creates private notes; it does not authenticate the cloud account locally or grant AI sharing. Existing notes, history and backups retain separate copies.`, { confirmLabel: 'Import reviewed private copies' })) return;
      if (generation !== state.generation || state.reviewed?.preview_id !== result.preview_id) return;
      let response;
      try { response = await request('/cloud-onboarding/imports', { method: 'POST', body: { preview_id: result.preview_id, review_hash: preview.review_hash, confirm_owner: true } }); }
      catch (error) { if (generation === state.generation) { invalidate(); notice(`${error.message} If the import was interrupted, prepare a new preview of this same file to reconcile exact existing copies.`, true); } return; }
      if (generation !== state.generation) return;
      if (!await refresh()) return; const current = state.items.find(item => item.id === response.item.id);
      if (!current || current.state !== 'active' || !current.notes_current) { notice('The source receipt changed during refresh. Review its current state before sharing.', true); return; }
      notice(`Reviewed private import read back: ${current.notes.length} note(s). Source live freshness is not checked. Select these notes in Writing or Learning; approve model sharing separately in Agent & review.`);
    }));
    clearTimeout(expiryTimer); const generation = state.generation; expiryTimer = setTimeout(() => { if (generation === state.generation) { invalidate(); notice('The exact review expired. Prepare a fresh preview of this file.'); } }, 300000);
  }
  prepare.addEventListener('click', () => action(prepare, async () => {
    if (!state.bundle) throw new Error('Choose a reviewed LearnBridge selected-source file first.'); invalidate(); const generation = state.generation;
    const result = await request('/cloud-onboarding/preview', { method: 'POST', body: { bundle: state.bundle, academic_policy: policy.value } }); if (generation === state.generation) renderPreview(result);
  }));
  function renderItems() {
    items.replaceChildren();
    for (const item of state.items) {
      const card = $('article', 'source-preview'); card.append($('h3', '', item.title), $('p', 'field-help', `${item.state.replaceAll('_', ' ')} · ${item.notes.length} private copies · receipt revision ${item.revision}`),
        $('p', 'notice', item.notes_current ? 'Saved note pins match. Live source freshness remains not checked.' : 'Some private notes changed or were removed. Reusing an unchanged cloud snapshot requires a fresh review or resolving these copies.'),
        $('p', 'field-help', `Upstream account: ${item.account_id} · identity: student-confirmed, bundle reported · original retrieval: ${item.retrieved_at} · latest reviewed observation: ${item.last_observed_at}`));
      const list = $('ul'); for (const record of item.records) list.append($('li', '', `${record.title} · ${record.coverage.replaceAll('_', ' ')} · ${record.sha256}`)); card.append(list);
      for (const [page, label] of [['notes', 'Open private notes'], ['agents', 'Review AI sharing separately']]) { const open = button(label); open.addEventListener('click', () => navigate?.(page)); card.append(open); }
      const remove = button('Remove active source receipt'); card.append(remove); remove.addEventListener('click', () => action(remove, async () => {
        const generation = state.generation;
        if (!await confirmAction(`Remove source receipt “${item.title}” at revision ${item.revision}? Imported private notes, existing note-sharing choices, downloaded files, history and backups retain their separate copies. This does not disconnect the provider account.`, { confirmLabel: 'Remove active receipt' })) return;
        if (generation !== state.generation) return; await request(`/cloud-onboarding/imports/${item.id}`, { method: 'DELETE', body: { expected_revision: item.revision } }); if (generation !== state.generation) return;
        if (await refresh()) notice('Active source receipt removed. Manage its separate notes and any existing sharing choices explicitly.');
      })); items.append(card);
    }
    if (!state.items.length) items.append($('p', 'field-help', 'No reviewed cloud source receipts yet. Choose a specific transfer file to begin.'));
  }
  async function refresh() {
    invalidate(); const generation = state.generation; const result = await request('/cloud-onboarding/imports'); if (generation !== state.generation) return false;
    state.items = result.items; renderItems(); return true;
  }
  function reset() { invalidate(); state.bundle = null; state.items = []; file.value = ''; policy.value = 'learning_support'; prepare.disabled = true; items.replaceChildren(); }
  return { refresh, reset };
}
