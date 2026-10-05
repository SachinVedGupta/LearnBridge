export function mountPublicJobsUI({ root, request, element, busy, message }) {
  const $ = (tag, cls, text) => element(tag, cls, text), state = { generation: 0, boards: [], roles: [], current: null };
  const status = $('p', 'notice'); status.id = 'public-jobs-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const button = text => { const node = $('button', 'button secondary', text); node.type = 'button'; return node; };
  const action = (control, callback) => busy(control, callback).catch(error => notice(error.message, true));
  const label = (parent, title, node) => { const wrapper = $('label', 'field-help', title); wrapper.append(node); parent.append(wrapper); return node; };
  root.replaceChildren($('p', 'notice', 'Find public postings from one company board you choose. Search keeps metadata; read a selected posting to save its source evidence. No account credentials, application submission, browser control or model sharing are used.'), status);
  const searchPanel = $('section', 'panel source-panel'), form = $('form', 'career-form'); searchPanel.append($('h2', '', 'Choose an official public board'), form); root.append(searchPanel);
  const provider = $('select'); provider.id = 'public-job-provider'; for (const [value, title] of [['greenhouse', 'Greenhouse'], ['lever', 'Lever (global)']]) { const option = $('option', '', title); option.value = value; provider.append(option); } label(form, 'Posting provider', provider);
  const slug = $('input'); slug.id = 'public-job-slug'; slug.type = 'text'; slug.required = true; slug.maxLength = 100; slug.pattern = '[a-z0-9][a-z0-9_-]{0,99}'; label(form, 'Company board slug from its official careers link', slug);
  form.append($('p', 'field-help', 'For example, job-boards.greenhouse.io/company or jobs.lever.co/company uses the board slug company. Select at most one board per search. Lever list responses contain extra public fields; only metadata is kept until you explicitly read one posting.'));
  const search = button('Search this public board'); search.type = 'submit'; form.append(search);
  const refreshButton = button('Refresh saved discovery'), boardBox = $('section', 'panel source-panel'), roleBox = $('section', 'panel source-panel'), currentBox = $('section', 'panel source-panel');
  currentBox.hidden = true; root.append(refreshButton, boardBox, roleBox, currentBox); refreshButton.addEventListener('click', () => action(refreshButton, refresh));
  form.addEventListener('submit', event => { event.preventDefault(); action(search, async () => {
    const generation = state.generation, data = await request('/public-jobs/search', { method: 'POST', body: { provider: provider.value, board_slug: slug.value.trim() } }); if (generation !== state.generation) return;
    await refresh(); if (generation !== state.generation) return; notice(`Board check: ${data.board.data.last_check.status.replaceAll('_', ' ')}. ${data.board.data.items.length} metadata items retained. Read only the postings you select.`);
  }); });
  async function read(control, selection) {
    const generation = state.generation, data = await request('/public-jobs/read', { method: 'POST', body: selection }); if (generation !== state.generation) return;
    show(data.role); await refresh(); if (generation === state.generation) notice(`Selected posting check: ${data.role.availability.replaceAll('_', ' ')}. ${data.role.verification_notice}`);
  }
  function sourceLink(parent, url, text) { const link = $('a', 'button secondary', text); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link); }
  function render() {
    boardBox.replaceChildren($('h2', '', 'Board metadata'));
    if (!state.boards.length) boardBox.append($('p', 'field-help', 'No company board checked yet. Opening this screen does not run a search.'));
    for (const board of state.boards) {
      const data = board.data, group = $('div', 'source-panel'); group.append($('h3', '', `${data.selection.provider} · ${data.selection.board_slug}`),
        $('p', 'field-help', `Last check: ${data.last_check.status.replaceAll('_', ' ')} · ${data.last_check.checked_at}. Last retained observation: ${data.observed_at || 'none'}. Missing list entries do not close saved roles.`));
      if (data.last_check.status !== 'complete') group.append($('p', 'notice', 'Coverage is incomplete or unavailable. Earlier saved content may be retained; this is not a claim that there are no openings.'));
      for (const item of data.items) { const row = $('div', 'review-row'); row.append($('strong', '', item.title), $('p', 'field-help', `${item.locations.join(', ')} · source ID ${item.job_id}`),
          $('p', 'field-help', `Metadata observed: ${item.metadata_observed_at || data.observed_at || 'unknown'}${data.last_check.status !== 'complete' || item.metadata_observed_at !== data.last_check.checked_at ? ' · retained or incomplete metadata; read this selected source before relying on it' : ''}.`));
        const open = button('Read this selected posting'); row.append(open); open.addEventListener('click', () => action(open, () => read(open, { provider: item.provider, board_slug: item.board_slug, job_id: item.job_id }))); group.append(row); }
      boardBox.append(group);
    }
    roleBox.replaceChildren($('h2', '', 'Saved postings and shortlist'));
    if (!state.roles.length) roleBox.append($('p', 'field-help', 'No posting body saved. Select a metadata result to read one official source.'));
    for (const role of state.roles) { const row = $('div', 'review-row'); row.append($('strong', '', role.title), $('p', 'field-help', `${role.data.selection.board_slug} · ${role.availability.replaceAll('_', ' ')} · shortlist ${role.data.shortlist?.state || 'not set'}`));
      const open = button('Open saved posting'); row.append(open); open.addEventListener('click', () => action(open, async () => { const generation = state.generation, data = await request(`/public-jobs/roles/${role.id}`); if (generation === state.generation) show(data.role); })); roleBox.append(row); }
  }
  function show(role) {
    state.current = role; currentBox.hidden = false; currentBox.replaceChildren($('h2', '', role.title), $('p', 'notice', `${role.availability.replaceAll('_', ' ')}. ${role.verification_notice}`));
    const data = role.data; currentBox.append($('p', 'field-help', `Official source observed: ${data.source_observed_at || 'no successful body read'}. Last attempted check: ${data.last_check.checked_at}.`));
    const recheck = button('Check this official source again'); currentBox.append(recheck); recheck.addEventListener('click', () => action(recheck, () => read(recheck, data.selection)));
    if (data.request?.source_api_url) sourceLink(currentBox, data.request.source_api_url, 'Open official API source');
    if (data.snapshot) {
      sourceLink(currentBox, data.snapshot.posting_url, 'Open provider posting page'); currentBox.append($('pre', 'source-text', data.snapshot.display_text),
        $('p', 'field-help', `Source SHA-256: ${data.snapshot.source_sha256}. Extracted text SHA-256: ${data.snapshot.display_text_sha256}. Public posting evidence does not establish eligibility or verify interpretation.`));
      const details = $('details'); details.append($('summary', '', 'Inspect original selected provider fields and observation receipt'), $('pre', 'source-text', JSON.stringify({ selected_content: data.snapshot.selected_content, source_sha256: data.snapshot.source_sha256, source_observation_request: data.source_request, last_attempt: data.request, coverage: data.snapshot.coverage, extraction: data.snapshot.extraction }, null, 2))); currentBox.append(details);
    } else currentBox.append($('p', 'notice', 'No compatible selected body was saved. A failed check is not an opening or a closed-role claim.'));
    const shortlist = $('form', 'career-form'), choice = $('select'); for (const value of ['saved', 'investigating', 'preparing', 'dismissed']) { const option = $('option', '', value); option.value = value; choice.append(option); } choice.value = data.shortlist?.state || 'saved'; label(shortlist, 'My shortlist decision', choice);
    const note = $('textarea', 'career-textarea'); note.maxLength = 2000; note.value = data.shortlist?.note || ''; label(shortlist, 'My note (optional)', note);
    const save = button('Save reviewed shortlist decision'); save.type = 'submit'; shortlist.append(save); currentBox.append(shortlist);
    shortlist.addEventListener('submit', event => { event.preventDefault(); action(save, async () => { const generation = state.generation;
      const result = await request(`/public-jobs/roles/${role.id}/shortlist`, { method: 'POST', body: { expected_revision: role.revision, state: choice.value, note: note.value } });
      if (generation !== state.generation || state.current?.id !== role.id || state.current?.revision !== role.revision) return; show(result.role); await refresh(); if (generation === state.generation) notice('Reviewed local shortlist saved. No application was prepared, uploaded or submitted.');
    }); });
  }
  async function refresh() {
    const generation = state.generation, data = await request('/public-jobs/state'); if (generation !== state.generation) return; state.boards = data.boards; state.roles = data.roles; render();
    if (state.current && !state.roles.some(role => role.id === state.current.id && role.revision === state.current.revision && role.availability === state.current.availability)) {
      state.generation++; state.current = null; currentBox.replaceChildren(); currentBox.hidden = true; notice('The saved posting or source observation changed. Reopen it before reviewing its current shortlist or content.');
    }
  }
  return { refresh, reset() { state.generation++; state.boards = []; state.roles = []; state.current = null; boardBox.replaceChildren(); roleBox.replaceChildren(); currentBox.replaceChildren(); currentBox.hidden = true; form.reset(); notice(''); } };
}
