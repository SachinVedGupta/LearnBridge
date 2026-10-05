const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Only a student-selected local File is decoded; original UTF-8 bytes are never replaced or normalized. */
export async function readSelectedExpenseCSV(file, origin) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 40000 || typeof file.name !== 'string' || !file.name.toLowerCase().endsWith('.csv') || /[\/\\]/.test(file.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(origin || '')) throw new Error('Choose a CSV up to 40,000 bytes and enter a simple source label first.');
  const bytes = new Uint8Array(await file.arrayBuffer()); if (bytes.byteLength !== file.size) throw new Error('The selected file changed while reading it. Choose it again.');
  let csv_text; try { csv_text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('This CSV is not valid UTF-8. Save a UTF-8 CSV and choose it again. No preview was sent.'); }
  if (!csv_text.isWellFormed() || new TextEncoder().encode(csv_text).byteLength !== bytes.byteLength) throw new Error('The CSV bytes could not be preserved exactly. No preview was sent.');
  return { origin, filename: file.name, csv_text, file_sha256: await hash(bytes) };
}

export function mountExpenseImportUI({ root, request, element, busy, message }) {
  const $ = (tag, cls, text) => element(tag, cls, text), state = { generation: 0, selection: 0, current: null, previewAttempt: null, commitAttempt: null };
  const status = $('p', 'notice'); status.id = 'expense-import-status'; status.hidden = true; status.setAttribute('role', 'status');
  const notice = (text, error = false) => message ? message(status.id, text, error) : (status.textContent = text, status.hidden = !text, status.classList.toggle('error', error));
  const button = text => { const node = $('button', 'button secondary', text); node.type = 'button'; return node; };
  const action = (control, callback) => busy(control, callback).catch(error => notice(error.message, true));
  const label = (parent, text, control) => { const node = $('label', 'field-help', text); node.append(control); parent.append(node); return control; };
  root.replaceChildren($('p', 'notice', 'Import one local CSV you choose. Preview every row, then explicitly confirm only selected valid expenses. Source labels/hashes identify your file; they do not authenticate a bank. No bank access, formulas, model processing or currency conversion.'), status);
  const panel = $('section', 'panel source-panel'), form = $('form', 'career-form'); panel.append($('h2', '', 'Select a local expense CSV'), form); root.append(panel);
  const origin = $('input'); origin.id = 'expense-import-origin'; origin.type = 'text'; origin.required = true; origin.maxLength = 80; origin.pattern = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}'; label(form, 'Stable source label I choose (for example, student-expenses)', origin);
  const file = $('input'); file.id = 'expense-import-file'; file.type = 'file'; file.accept = '.csv,text/csv'; file.required = true; label(form, 'One UTF-8 CSV file, up to 40,000 bytes and 100 data rows', file);
  form.append($('p', 'field-help', 'Exact columns: date,description,amount,currency,category and optional reference last. Date YYYY-MM-DD; amount plain decimal with at most 2 digits after the decimal, negative for refunds; currency 3 uppercase letters. Quoted commas/newlines/doubled quotes are supported. Formulas and paths stay literal text.'),
    $('pre', 'source-text', 'date,description,amount,currency,category,reference\n2026-10-04,Lunch,12.50,CAD,food,receipt-001\n2026-10-04,Book refund,-5.00,CAD,school,refund-001'));
  const prepare = button('Preview this selected CSV'); prepare.type = 'submit'; form.append(prepare);
  const refreshButton = button('Refresh saved expense imports'), summary = $('section', 'panel source-panel'), list = $('section', 'panel source-panel'), detail = $('section', 'panel source-panel'); detail.hidden = true; root.append(refreshButton, summary, list, detail);
  refreshButton.addEventListener('click', () => action(refreshButton, refresh));
  form.addEventListener('submit', event => { event.preventDefault(); action(prepare, async () => {
    const generation = state.generation, selected = file.files?.[0]; if (file.files?.length !== 1) throw new Error('Choose exactly one local CSV.'); const body = await readSelectedExpenseCSV(selected, origin.value); if (generation !== state.generation || file.files?.[0] !== selected || origin.value !== body.origin) return;
    const fingerprint = JSON.stringify(body); if (state.previewAttempt?.body !== fingerprint) state.previewAttempt = { body: fingerprint, key: `expense_preview_${crypto.randomUUID().replaceAll('-', '')}` };
    const selection = ++state.selection; state.current = null; detail.replaceChildren(); detail.hidden = true;
    const result = await request('/expense-import/previews', { method: 'POST', body, idempotencyKey: state.previewAttempt.key }); if (generation !== state.generation || selection !== state.selection) return;
    state.previewAttempt = null; show(result.preview); await refresh(); if (generation === state.generation) notice('Exact CSV preview saved. No expense is confirmed until you review and commit selected valid rows.');
  }); });
  function show(preview) {
    state.current = preview; state.commitAttempt = null; detail.hidden = false; detail.replaceChildren($('h2', '', preview.data.preview.filename), $('p', 'notice', `${preview.data.state.replaceAll('_', ' ')}: ${preview.counts.imported} rows imported, ${preview.counts.selectable} currently selectable, ${preview.counts.invalid} invalid, ${preview.counts.duplicate} repeated source references, ${preview.counts.already_imported} already imported.`),
      $('p', 'field-help', `Original file SHA-256: ${preview.data.preview.file_sha256}. Exact preview SHA-256: ${preview.data.preview_hash}. Source label: ${preview.data.preview.origin} (student-entered). No-ref changed files may repeat earlier purchases; compare them yourself before confirming.`));
    const original = $('details'); original.append($('summary', '', 'Inspect exact original CSV and parsed source evidence'), $('pre', 'source-text', JSON.stringify(preview.data.preview, null, 2))); detail.append(original);
    const selectionForm = $('form', 'career-form'), controls = []; detail.append(selectionForm);
    for (const row of preview.rows) {
      const group = $('div', 'review-row'); group.append($('strong', '', `Row ${row.row_number} · source lines ${row.start_line}–${row.end_line} · ${row.current_status.replaceAll('_', ' ')}`));
      if (row.expense) group.append($('p', 'field-help', `${row.expense.date} · ${row.expense.merchant} · ${row.expense.amount_cents} cents ${row.expense.currency} · ${row.expense.category}`));
      if (row.reason || row.current_status === 'already_imported') group.append($('p', 'notice', row.reason || 'This source identity was imported after this preview; no second expense will be created.'));
      if (row.selectable) { const check = $('input'); check.type = 'checkbox'; check.checked = false; label(group, 'I reviewed this exact row amount/currency/category and want it confirmed', check); controls.push({ check, row }); }
      selectionForm.append(group);
    }
    const commit = button('Confirm and import only my selected rows atomically'); commit.type = 'submit'; commit.disabled = !controls.length; selectionForm.append(commit);
    selectionForm.addEventListener('submit', event => { event.preventDefault(); action(commit, async () => {
      if (state.current !== preview) return;
      const chosen = controls.filter(item => item.check.checked).map(({ row }) => ({ row_number: row.row_number, row_hash: row.row_hash })); if (!chosen.length || chosen.length > 50) throw new Error('Choose 1 to 50 currently valid rows you reviewed. No rows were imported.');
      const generation = state.generation, body = { expected_revision: preview.revision, preview_hash: preview.data.preview_hash, selected_rows: chosen }, fingerprint = JSON.stringify(body);
      if (state.commitAttempt?.body !== fingerprint) state.commitAttempt = { body: fingerprint, key: `expense_commit_${crypto.randomUUID().replaceAll('-', '')}` };
      const result = await request(`/expense-import/previews/${preview.id}/commit`, { method: 'POST', body, idempotencyKey: state.commitAttempt.key }); if (generation !== state.generation || state.current !== preview) return;
      show(result.preview); await refresh(); if (generation === state.generation) notice(`Verified atomic import: ${result.receipt.rows.length} selected expenses. No other rows were confirmed. Currencies remain separate.`);
    }); });
    const journal = $('details'); journal.append($('summary', '', 'Inspect durable reviewed import receipts'), $('pre', 'source-text', JSON.stringify(preview.data.commits, null, 2))); detail.append(journal);
    const forget = button('Forget this saved CSV preview'); detail.append(forget); forget.addEventListener('click', () => action(forget, async () => { if (state.current !== preview) return; const generation = state.generation;
      const result = await request(`/expense-import/previews/${preview.id}`, { method: 'DELETE', body: { expected_revision: preview.revision, preview_hash: preview.data.preview_hash } }); if (generation !== state.generation || state.current !== preview) return;
      state.selection++; state.current = null; detail.replaceChildren(); detail.hidden = true; await refresh(); if (generation === state.generation) notice(result.retention);
    }));
  }
  async function refresh() {
    const generation = state.generation, data = await request('/expense-import/state'); if (generation !== state.generation) return;
    summary.replaceChildren($('h2', '', 'Confirmed local expense totals')); for (const total of data.totals.totals) summary.append($('p', 'field-help', `${total.currency}: ${total.cents} cents`)); summary.append($('p', 'field-help', data.totals.coverage));
    list.replaceChildren($('h2', '', 'Saved CSV previews')); if (!data.previews.length) list.append($('p', 'field-help', 'No selected CSV preview saved. Opening this page does not read your files.'));
    for (const preview of data.previews) { const row = $('div', 'review-row'), open = button('Open this CSV preview'); row.append($('strong', '', `${preview.filename} · ${preview.origin}`), $('p', 'field-help', `${preview.state.replaceAll('_', ' ')} · ${preview.counts.imported} imported, ${preview.counts.selectable} selectable`), open); list.append(row);
      open.addEventListener('click', () => action(open, async () => { const currentGeneration = state.generation, selection = ++state.selection; state.current = null; detail.replaceChildren(); detail.hidden = true;
        const result = await request(`/expense-import/previews/${preview.id}`); if (currentGeneration === state.generation && selection === state.selection) show(result.preview); })); }
    if (state.current && !data.previews.some(item => item.id === state.current.id && item.revision === state.current.revision && item.counts.selectable === state.current.counts.selectable)) { state.generation++; state.current = null; detail.replaceChildren(); detail.hidden = true; notice('The saved preview or existing expenses changed. Reopen it before reviewing a current batch.'); }
  }
  return { refresh, reset() { state.generation++; state.selection++; state.current = null; state.previewAttempt = null; state.commitAttempt = null; origin.value = ''; file.value = ''; summary.replaceChildren(); list.replaceChildren(); detail.replaceChildren(); detail.hidden = true; notice(''); } };
}
