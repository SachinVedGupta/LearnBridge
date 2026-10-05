import { createHash, randomUUID } from 'node:crypto';
import { LearnBridgeError } from '@learnbridge/core';
import { normalizeExpense, parseMoneyCents, expenseTotals, lifeDate } from './life.mjs';

export const EXPENSE_IMPORT_FORMAT = 'expense_import_preview_v1';
export const EXPENSE_IMPORT_LIMITS = Object.freeze({ fileBytes: 40000, rows: 100, batchRows: 50, previewBytes: 100000, recordBytes: 120000, previews: 100 });
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => sha(canonical(value));
const fail = code => { throw new LearnBridgeError(code); };
function object(raw, allowed, required = allowed) { if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('INVALID_INPUT'); const props = Object.getOwnPropertyDescriptors(raw); if (Reflect.ownKeys(props).some(key => typeof key !== 'string' || !allowed.includes(key) || !props[key].enumerable || !Object.hasOwn(props[key], 'value')) || required.some(key => !Object.hasOwn(props, key))) fail('INVALID_INPUT'); }
function text(raw, limit, empty = false) { if (typeof raw !== 'string' || !raw.isWellFormed() || (!empty && !raw.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw) || Buffer.byteLength(raw) > limit) fail('INVALID_INPUT'); return raw; }
function digest(raw) { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) fail('INVALID_INPUT'); return raw; }
function revision(raw) { if (!Number.isSafeInteger(raw) || raw < 1) fail('INVALID_INPUT'); return raw; }
function key(raw) { if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(raw)) fail('INVALID_INPUT'); return raw; }
function recordId(raw) { if (typeof raw !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw)) fail('INVALID_INPUT'); return raw; }

/** Strict CSV tokenizer with original bytes retained separately. It never executes cell text. */
export function parseExpenseCSV(raw) {
  text(raw, EXPENSE_IMPORT_LIMITS.fileBytes); let csv = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  const result = []; let cells = [], field = '', quoted = false, afterQuote = false, started = false, line = 1, start = 1, columns = 1, problem = null;
  function cell() { if (cells.length < 7) cells.push(field); field = ''; afterQuote = false; }
  function row() { cell(); result.push({ cells, columns, start_line: start, end_line: line, parse_reason: problem }); if (result.length > EXPENSE_IMPORT_LIMITS.rows + 1) fail('BUDGET_EXCEEDED'); cells = []; field = ''; columns = 1; started = false; problem = null; }
  for (let index = 0; index < csv.length; index++) {
    const character = csv[index]; started = true;
    if (quoted) {
      if (character === '"') { if (csv[index + 1] === '"') { field += '"'; index++; } else { quoted = false; afterQuote = true; } }
      else { field += character; if (character === '\n') line++; else if (character === '\r' && csv[index + 1] !== '\n') line++; }
      continue;
    }
    if (character === ',') { cell(); columns++; continue; }
    if (character === '\r' || character === '\n') { row(); if (character === '\r' && csv[index + 1] === '\n') index++; line++; start = line; continue; }
    if (character === '"' && !field && !afterQuote) { quoted = true; continue; }
    if (character === '"') problem ||= 'unexpected_quote'; else if (afterQuote) problem ||= 'text_after_closing_quote'; field += character;
  }
  if (quoted) problem ||= 'unclosed_quoted_field'; if (started || field || cells.length) row();
  const header = result.shift(); const expected = ['date', 'description', 'amount', 'currency', 'category'];
  if (!header || header.parse_reason || ![5, 6].includes(header.columns) || expected.some((name, index) => header.cells[index] !== name) || (header.columns === 6 && header.cells[5] !== 'reference')) fail('INVALID_INPUT');
  return { columns: header.cells, rows: result };
}

/** Selected local CSV → pinned preview → exact atomic reviewed expense batch. No bank, model or URL/file scanning. */
export function createExpenseImportService({ store, clock = () => Date.now() }) {
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value)) fail('INVALID_INPUT'); return new Date(value).toISOString(); };
  const expenses = () => store.listWorkspaceRecords({ kind: 'expense' }).filter(record => record.data.category === 'expense');
  const previews = () => store.listWorkspaceRecords({ kind: 'administration_item' }).filter(record => record.data.format === EXPENSE_IMPORT_FORMAT && record.data.category === 'expense_import_preview');
  function get(record) { const item = store.getWorkspaceRecord(recordId(record)); if (!item || item.kind !== 'administration_item' || item.data.format !== EXPENSE_IMPORT_FORMAT || item.data.category !== 'expense_import_preview') fail('SCOPE_DENIED'); if (hash(item.data.preview) !== item.data.preview_hash) fail('VERSION_MISMATCH'); return item; }
  function view(item, full = true) {
    const imported = new Map(item.data.commits.flatMap(commit => commit.rows.map(row => [row.row_number, row]))), known = new Map(expenses().map(record => [record.data.expense.source_id, record]));
    const rows = item.data.preview.rows.map(row => ({ ...row, selectable: row.status === 'valid' && !imported.has(row.row_number) && !known.has(row.expense.source_id), current_status: imported.has(row.row_number) ? 'imported' : row.status === 'valid' && known.has(row.expense.source_id) ? 'already_imported' : row.status,
      imported_record: imported.get(row.row_number)?.record_id || null }));
    const counts = { rows: rows.length, valid: rows.filter(row => row.status === 'valid').length, invalid: rows.filter(row => row.status === 'invalid').length, duplicate: rows.filter(row => row.status === 'duplicate_in_file').length, already_imported: rows.filter(row => row.current_status === 'already_imported').length, imported: imported.size, selectable: rows.filter(row => row.selectable).length };
    return full ? { ...item, rows, counts } : { id: item.id, revision: item.revision, filename: item.data.preview.filename, origin: item.data.preview.origin, file_sha256: item.data.preview.file_sha256, preview_hash: item.data.preview_hash, state: item.data.state, counts };
  }
  function checked(raw, selection = false) {
    object(raw, selection ? ['expected_revision', 'preview_hash', 'selected_rows'] : ['expected_revision', 'preview_hash']); revision(raw.expected_revision); digest(raw.preview_hash);
    if (!selection) return raw;
    if (!Array.isArray(raw.selected_rows) || Object.getPrototypeOf(raw.selected_rows) !== Array.prototype || !raw.selected_rows.length || raw.selected_rows.length > EXPENSE_IMPORT_LIMITS.batchRows) fail('INVALID_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(raw.selected_rows); if (Reflect.ownKeys(descriptors).length !== raw.selected_rows.length + 1) fail('INVALID_INPUT');
    const selected_rows = Array.from({ length: raw.selected_rows.length }, (_, index) => { if (!descriptors[index] || !Object.hasOwn(descriptors[index], 'value') || !descriptors[index].enumerable) fail('INVALID_INPUT'); const row = descriptors[index].value; object(row, ['row_number', 'row_hash']); if (!Number.isSafeInteger(row.row_number) || row.row_number < 1 || row.row_number > EXPENSE_IMPORT_LIMITS.rows) fail('INVALID_INPUT'); digest(row.row_hash); return { ...row }; });
    if (new Set(selected_rows.map(row => row.row_number)).size !== selected_rows.length) fail('INVALID_INPUT'); return { ...raw, selected_rows };
  }
  return {
    state() { const current = expenses(); return { previews: previews().map(item => view(item, false)), totals: expenseTotals(current.map(record => record.data.expense)), limits: EXPENSE_IMPORT_LIMITS,
      schema: ['date', 'description', 'amount', 'currency', 'category', 'reference (optional last column)'], capabilities: { bank_reads: false, formulas: false, model_calls: false, conversion: false } }; },
    get: record => ({ preview: view(get(record)) }),
    preview(raw, { idempotencyKey } = {}) {
      object(raw, ['origin', 'filename', 'csv_text', 'file_sha256']); key(idempotencyKey);
      if (typeof raw.origin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw.origin)) fail('INVALID_INPUT');
      text(raw.filename, 160); if (/[\/\\]/.test(raw.filename) || !raw.filename.toLowerCase().endsWith('.csv')) fail('INVALID_INPUT'); text(raw.csv_text, EXPENSE_IMPORT_LIMITS.fileBytes); digest(raw.file_sha256);
      if (sha(Buffer.from(raw.csv_text, 'utf8')) !== raw.file_sha256) fail('REVISION_CONFLICT');
      const request_hash = hash(raw), previous = previews().find(record => record.data.creation_operation.key === idempotencyKey);
      if (previous) { if (previous.data.creation_operation.request_hash !== request_hash) fail('REVISION_CONFLICT'); return { preview: view(previous) }; }
      if (previews().length >= EXPENSE_IMPORT_LIMITS.previews) fail('BUDGET_EXCEEDED');
      const parsed = parseExpenseCSV(raw.csv_text), seen = new Set(), known = new Map(expenses().map(record => [record.data.expense.source_id, record]));
      const rows = parsed.rows.map((item, index) => {
        const row_number = index + 1; let reason = item.parse_reason, expense = null, reference = null;
        if (!reason && item.columns !== parsed.columns.length) reason = 'wrong_column_count';
        if (!reason) {
          const [date, description, amount, currency, category, ref = ''] = item.cells;
          try { lifeDate(date); } catch { reason = 'invalid_calendar_date'; }
          let amount_cents; if (!reason) { try { amount_cents = parseMoneyCents(amount); } catch { reason = 'invalid_decimal_amount_no_rounding'; } }
          if (!reason && !/^[A-Z]{3}$/.test(currency)) reason = 'invalid_currency_code';
          if (!reason) { try { reference = ref ? text(ref, 160) : null; expense = normalizeExpense({ source_id: `csv:${hash(reference ? [raw.origin, 'reference', reference] : [raw.origin, 'file_row', raw.file_sha256, row_number])}`, date, merchant: description, category, amount_cents, currency, confirmed: false }); } catch { reason = 'invalid_description_category_or_reference'; } }
        }
        let status = reason ? 'invalid' : 'valid'; if (expense) { if (seen.has(expense.source_id)) { status = 'duplicate_in_file'; reason = 'same_origin_reference_repeated_in_this_file'; } else if (known.has(expense.source_id)) { status = 'already_imported'; reason = 'same_source_identity_already_in_local_expenses'; } seen.add(expense.source_id); }
        const row = { row_number, start_line: item.start_line, end_line: item.end_line, cells: item.cells, status, reason, reference, expense }; return { ...row, row_hash: hash(row) };
      });
      const preview = { origin: raw.origin, origin_verification: 'student_entered_label_not_authenticated_bank', filename: raw.filename, file_sha256: raw.file_sha256, source_bytes: Buffer.byteLength(raw.csv_text), csv_text: raw.csv_text, columns: parsed.columns, rows, prepared_at: now(),
        limitations: ['No-ref row identity uses this file hash; changed no-ref files may contain old purchases and need student duplicate review.', 'Identical purchases on distinct source rows without references are preserved.', 'Currencies are kept separate; no rates, formulas, provider reads or model processing.'] };
      if (Buffer.byteLength(JSON.stringify(preview)) > EXPENSE_IMPORT_LIMITS.previewBytes) fail('BUDGET_EXCEEDED');
      const data = { format: EXPENSE_IMPORT_FORMAT, category: 'expense_import_preview', preview, preview_hash: hash(preview), state: 'awaiting_review', commits: [], creation_operation: { key: idempotencyKey, request_hash } };
      return { preview: view(store.createWorkspaceRecord({ kind: 'administration_item', title: `Expense CSV: ${raw.filename}`.slice(0, 480), data }, { idempotencyKey: `expense-import-${sha(idempotencyKey)}` })) };
    },
    commit(record, raw, { idempotencyKey } = {}) {
      key(idempotencyKey); const request = checked(raw, true), item = get(record), request_hash = hash(request);
      if (item.data.preview_hash !== request.preview_hash) fail('REVISION_CONFLICT');
      const replay = item.data.commits.find(commit => commit.key === idempotencyKey);
      if (replay) { if (replay.request_hash !== request_hash || replay.reviewer !== store.identity.student_id) fail('REVISION_CONFLICT'); return { preview: view(item), receipt: replay, replayed: true }; }
      if (item.revision !== request.expected_revision || item.data.preview_hash !== request.preview_hash) fail('REVISION_CONFLICT');
      const known = new Set(expenses().map(record => record.data.expense.source_id)), selected = request.selected_rows.map(ref => {
        const row = item.data.preview.rows.find(row => row.row_number === ref.row_number);
        if (!row || row.row_hash !== ref.row_hash || row.status !== 'valid' || item.data.commits.some(commit => commit.rows.some(selected => selected.row_number === row.row_number)) || known.has(row.expense.source_id)) fail('REVISION_CONFLICT'); return row;
      });
      if (typeof store.commitExpenseImportBatch !== 'function') fail('OFFLINE');
      const reviewed_at = now(), creates = selected.map(row => ({ id: randomUUID(), kind: 'expense', title: `${row.expense.merchant}: ${row.expense.currency}`.slice(0, 480), data: { category: 'expense', expense: normalizeExpense({ ...Object.fromEntries(Object.entries(row.expense).filter(([field]) => ['source_id', 'date', 'merchant', 'category', 'amount_cents', 'currency'].includes(field))), confirmed: true }),
        import_source: { kind: 'student_reviewed_local_csv', preview_id: item.id, file_sha256: item.data.preview.file_sha256, origin: item.data.preview.origin, filename: item.data.preview.filename, row_number: row.row_number, row_hash: row.row_hash, reference: row.reference, reviewer: store.identity.student_id, reviewed_at } } }));
      const receipt = { key: idempotencyKey, request_hash, reviewer: store.identity.student_id, reviewed_at, preview_hash: item.data.preview_hash, file_sha256: item.data.preview.file_sha256,
        rows: selected.map((row, index) => ({ row_number: row.row_number, row_hash: row.row_hash, record_id: creates[index].id })), selection_totals: expenseTotals(creates.map(record => record.data.expense)), verification: 'atomic_workspace_batch_exact_readback' };
      const committedCount = item.data.commits.reduce((sum, commit) => sum + commit.rows.length, 0) + selected.length, validCount = item.data.preview.rows.filter(row => row.status === 'valid').length;
      const data = { ...item.data, state: committedCount === validCount ? 'imported' : 'partially_imported', commits: [...item.data.commits, receipt] };
      if (Buffer.byteLength(JSON.stringify(data)) > EXPENSE_IMPORT_LIMITS.recordBytes) fail('BUDGET_EXCEEDED');
      const saved = store.commitExpenseImportBatch({ creates, preview_update: { id: item.id, expected_revision: item.revision, data } });
      return { preview: view(saved.updates[0]), receipt, replayed: false };
    },
    forget(record, raw) { const request = checked(raw), item = get(record); if (item.revision !== request.expected_revision || item.data.preview_hash !== request.preview_hash) fail('REVISION_CONFLICT'); store.deleteWorkspaceRecord(item.id, item.revision); return { deleted: true, retention: 'Imported expenses remain. Historical local revisions and backups may retain the original selected CSV; remove those separately.' }; },
  };
}
