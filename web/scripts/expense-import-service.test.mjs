import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/local-storage/src/index.mjs';
import { createExpenseImportService, parseExpenseCSV } from '../apps/local-runtime/src/expense-import-service.mjs';
import { createLifeWorkspace } from '../apps/local-runtime/src/life-service.mjs';
import { readSelectedExpenseCSV } from '../apps/local/public/expense-import.js';

const sha = value => createHash('sha256').update(value).digest('hex'), header = 'date,description,amount,currency,category,reference';
const csv = `${header}\r\n2026-10-04,"Lunch, café",12.50,CAD,food,ref-1\r\n2026-10-04,Refund,-2.25,CAD,food,ref-2\r\n2026-10-04,Book,10.01,USD,school,ref-3\r\n2026-10-04,Duplicate,99.00,CAD,food,ref-1\r\n2026-02-30,Impossible,1.00,CAD,food,bad-1\r\n2026-10-04,Bad decimal,1.001,CAD,food,bad-2\r\n`;
const body = (text = csv, extra = {}) => ({ origin: 'student-expenses', filename: 'expenses.csv', csv_text: text, file_sha256: sha(Buffer.from(text)), ...extra });
const pins = preview => ({ expected_revision: preview.revision, preview_hash: preview.data.preview_hash });
const select = (preview, numbers = preview.rows.filter(row => row.selectable).map(row => row.row_number)) => ({ ...pins(preview), selected_rows: numbers.map(number => { const row = preview.rows.find(row => row.row_number === number); return { row_number: number, row_hash: row.row_hash }; }) });
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'learnbridge-expense-csv-')), root = join(parent, 'workspace'); let store = LocalStore.open({ root }), service = createExpenseImportService({ store });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, get store() { return store; }, get service() { return service; },
    restart() { store.close(); store = LocalStore.open({ root }); service = createExpenseImportService({ store }); },
    async restore() { const backup = join(parent, 'backup'); await store.backup(backup); store.close(); const restored = join(parent, 'restored'); await LocalStore.restore({ backupRoot: backup, root: restored }); store = LocalStore.open({ root: restored }); service = createExpenseImportService({ store }); } };
}
const preview = (f, text = csv, key = 'fixture-preview-01', extra = {}) => f.service.preview(body(text, extra), { idempotencyKey: key }).preview;

test('EIS01: exact CSV preview parses source identity/decimal cents/refund/currencies, marks repeated references and malformed rows, and confirms nothing', t => {
  const f = fixture(t), item = preview(f); assert.equal(item.data.preview.csv_text, csv); assert.equal(item.data.preview.file_sha256, sha(csv)); assert.equal(item.data.preview.source_bytes, Buffer.byteLength(csv));
  assert.deepEqual(item.counts, { rows: 6, valid: 3, invalid: 2, duplicate: 1, already_imported: 0, imported: 0, selectable: 3 });
  assert.deepEqual(item.rows.slice(0, 3).map(row => row.expense.amount_cents), [1250, -225, 1001]); assert.equal(item.rows[0].expense.merchant, 'Lunch, café'); assert.equal(item.rows[3].reason, 'same_origin_reference_repeated_in_this_file'); assert.equal(item.rows[4].reason, 'invalid_calendar_date'); assert.equal(item.rows[5].reason, 'invalid_decimal_amount_no_rounding');
  assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 0); assert.deepEqual(f.service.state().totals.totals, []); assert.equal(item.rows[0].expense.confirmed, false);
});

test('EIS02: quoted comma/newline/doubled quotes and BOM/CRLF are parsed literally with independent expected cells/source lines', () => {
  const text = '\ufeffdate,description,amount,currency,category\r\n2026-10-04,"Café, \"\"favorite\"\"\r\nshop",1.20,CAD,food\r\n2026-10-05,Plain,-0.5,USD,other';
  const result = parseExpenseCSV(text); assert.deepEqual(result.columns, ['date', 'description', 'amount', 'currency', 'category']); assert.deepEqual(result.rows[0].cells, ['2026-10-04', 'Café, "favorite"\r\nshop', '1.20', 'CAD', 'food']); assert.equal(result.rows[0].start_line, 2); assert.equal(result.rows[0].end_line, 3); assert.equal(result.rows[1].start_line, 4);
});

test('EIS03: bounded malformed row reasons never invent a recovered transaction, and wrong headers fail explicitly', t => {
  const f = fixture(t), text = `${header}\n2026-10-04,Bad"quote,1,CAD,food,a\n2026-10-04,"closed"x,1,CAD,food,b\n2026-10-04,Too few,1,CAD\n2026-10-04,"unclosed,1,CAD,food,c\nambiguous later line`;
  const item = preview(f, text); assert.deepEqual(item.rows.map(row => row.reason), ['unexpected_quote', 'text_after_closing_quote', 'wrong_column_count', 'unclosed_quoted_field']); assert.equal(item.counts.selectable, 0);
  for (const bad of ['Date,description,amount,currency,category\n', 'date,description,amount,currency,category,extra\n', 'date,description,amount,currency\n', '']) assert.throws(() => preview(f, bad, `fixture-header-${randomUUID()}`), { code: 'INVALID_INPUT' });
});

test('EIS04: a selected valid batch atomically creates confirmed Life expenses and durable exact source receipts with separate signed totals', t => {
  const f = fixture(t), item = preview(f), result = f.service.commit(item.id, select(item), { idempotencyKey: 'fixture-commit-01' });
  assert.equal(result.preview.data.state, 'imported'); assert.equal(result.preview.counts.imported, 3); assert.equal(result.receipt.rows.length, 3); assert.equal(result.receipt.reviewer, f.store.identity.student_id); assert.equal(result.receipt.file_sha256, sha(csv));
  const life = createLifeWorkspace(f.store), expenses = life.listExpenses(); assert.equal(expenses.length, 3); assert.equal(expenses.every(record => record.data.expense.confirmed), true); assert.deepEqual([...life.totals().totals].sort((a, b) => a.currency.localeCompare(b.currency)), [{ currency: 'CAD', cents: 1025 }, { currency: 'USD', cents: 1001 }]); assert.equal(life.totals().converted, false);
  for (const expense of expenses) { assert.equal(expense.data.import_source.preview_id, item.id); const row = item.rows.find(row => row.row_number === expense.data.import_source.row_number); assert.equal(expense.data.import_source.row_hash, row.row_hash); assert.equal(expense.data.expense.source_id, row.expense.source_id); }
});

test('EIS05: exact selected subset/remainder are separate reviewed atomic batches; stale or rejected rows cannot mutate any expense', t => {
  const f = fixture(t), item = preview(f), first = f.service.commit(item.id, select(item, [1]), { idempotencyKey: 'fixture-subset-01' }); assert.equal(first.preview.data.state, 'partially_imported'); assert.equal(first.preview.counts.imported, 1); assert.equal(first.preview.counts.selectable, 2);
  for (const selection of [select(item, [2]), select(first.preview, [4]), { ...select(first.preview, [2]), preview_hash: 'f'.repeat(64) }, { ...select(first.preview, [2]), selected_rows: [{ row_number: 2, row_hash: 'f'.repeat(64) }] }]) assert.throws(() => f.service.commit(item.id, selection, { idempotencyKey: 'fixture-bad-subset' }), { code: 'REVISION_CONFLICT' });
  assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 1); const rest = f.service.commit(item.id, select(first.preview), { idempotencyKey: 'fixture-subset-02' }); assert.equal(rest.preview.counts.imported, 3);
});

test('EIS06: identical file and origin-scoped references deduplicate across changed files/filenames while other origins remain distinct', t => {
  const f = fixture(t), item = preview(f); f.service.commit(item.id, select(item), { idempotencyKey: 'fixture-dedup-commit' });
  const repeat = preview(f, csv, 'fixture-repeat-preview', { filename: 'renamed.csv' }); assert.equal(repeat.counts.already_imported, 3); assert.equal(repeat.counts.selectable, 0);
  const changed = preview(f, `${header}\n2026-10-05,Updated old reference,1,CAD,food,ref-1\n2026-10-05,New reference,1,CAD,food,new-ref\n`, 'fixture-changed-file'); assert.equal(changed.rows[0].current_status, 'already_imported'); assert.equal(changed.rows[1].selectable, true);
  const other = preview(f, csv, 'fixture-other-origin', { origin: 'another-source' }); assert.equal(other.counts.selectable, 3);
});

test('EIS07: no-reference row identity preserves distinct identical purchases and scopes exact reimports; changed files visibly warn instead of guessing duplicates', t => {
  const f = fixture(t), text = 'date,description,amount,currency,category\n2026-10-04,Coffee,2.50,CAD,food\n2026-10-04,Coffee,2.50,CAD,food\n', item = preview(f, text); assert.notEqual(item.rows[0].expense.source_id, item.rows[1].expense.source_id);
  f.service.commit(item.id, select(item), { idempotencyKey: 'fixture-no-ref-commit' }); const exact = preview(f, text, 'fixture-no-ref-repeat'); assert.equal(exact.counts.already_imported, 2);
  const changed = preview(f, text.replace('2.50', '2.51'), 'fixture-no-ref-changed'); assert.equal(changed.counts.selectable, 2); assert.ok(changed.data.preview.limitations.some(line => line.includes('changed no-ref files')));
});

test('EIS08: journal retries after actual commit/lost response create no duplicates, while changed retry keys/payload cannot authorize new rows', t => {
  const f = fixture(t), item = preview(f), request = select(item), original = f.store.commitExpenseImportBatch.bind(f.store); let failResponse = true;
  f.store.commitExpenseImportBatch = input => { const result = original(input); if (failResponse) { failResponse = false; throw new Error('Simulated lost completion response'); } return result; };
  assert.throws(() => f.service.commit(item.id, request, { idempotencyKey: 'fixture-lost-response' }), /lost completion/); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 3);
  const retried = f.service.commit(item.id, request, { idempotencyKey: 'fixture-lost-response' }); assert.equal(retried.replayed, true); assert.equal(retried.receipt.rows.length, 3); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 3);
  assert.throws(() => f.service.commit(item.id, { ...request, selected_rows: request.selected_rows.slice(0, 1) }, { idempotencyKey: 'fixture-lost-response' }), { code: 'REVISION_CONFLICT' });
});

test('EIS09: concurrent source duplicate and denied transaction stop the entire selected batch before partial imports', t => {
  const f = fixture(t), item = preview(f); createLifeWorkspace(f.store).createExpense({ ...Object.fromEntries(Object.entries(item.rows[0].expense).filter(([key]) => !['schema_version', 'source', 'estimate'].includes(key))), confirmed: true }, { idempotencyKey: 'fixture-existing-expense' });
  assert.equal(f.service.get(item.id).preview.rows[0].selectable, false); assert.throws(() => f.service.commit(item.id, select(item), { idempotencyKey: 'fixture-concurrent-denied' }), { code: 'REVISION_CONFLICT' }); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 1);
  f.store.commitExpenseImportBatch = () => { throw new Error('Synthetic transaction denied'); }; assert.throws(() => f.service.commit(item.id, select(item, [2, 3]), { idempotencyKey: 'fixture-transaction-denied' }), /transaction denied/); assert.equal(f.service.get(item.id).preview.data.commits.length, 0); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 1);
});

test('EIS10: restart/fresh backup restore retain exact source file, selection receipt, imported identities and totals with no duplicates', async t => {
  const f = fixture(t), item = preview(f), request = select(item), result = f.service.commit(item.id, request, { idempotencyKey: 'fixture-persist-commit' }), before = f.service.state(); f.restart(); assert.deepEqual(f.service.state(), before); await f.restore(); assert.deepEqual(f.service.state(), before);
  const replay = f.service.commit(item.id, request, { idempotencyKey: 'fixture-persist-commit' }); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.service.get(item.id).preview.data.preview.csv_text, csv); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 3);
});

test('EIS11: monetary/currency/calendar limits reject rounding, scientific/localized/overflow values while formulas/URLs remain inert description text', t => {
  const f = fixture(t), rows = ['1.001', '+1.00', '1e3', '10000000', '1,000', 'NaN'].map((amount, index) => `2026-10-04,Bad${index},"${amount}",CAD,food,a${index}`).join('\n'); const item = preview(f, `${header}\n${rows}\n2026-10-04,"=SUM(1,2) https://127.0.0.1/private",0.01,CAD,food,formula\n2026-10-04,Bad currency,1,cad,food,curr\n`);
  assert.equal(item.counts.selectable, 1); assert.equal(item.rows[6].expense.amount_cents, 1); assert.ok(item.rows[6].expense.merchant.startsWith('=SUM')); assert.equal(item.rows[7].reason, 'invalid_currency_code'); assert.equal(f.store.listTasks().length, 0); assert.equal(f.store.listAgentGrants().length, 0);
});

test('EIS12: forged file hashes/paths/accessors, selected row accessors/duplicates and explicit file/row/batch budgets fail before import', t => {
  const f = fixture(t); for (const patch of [{ file_sha256: 'f'.repeat(64) }, { filename: '../private.csv' }, { origin: 'https://bank.example' }, { url: 'http://127.0.0.1/private' }]) assert.throws(() => f.service.preview(body(csv, patch), { idempotencyKey: 'fixture-forged-preview' }), error => ['INVALID_INPUT', 'REVISION_CONFLICT'].includes(error.code));
  assert.throws(() => preview(f, `${header}\n${'2026-10-04,a,1,CAD,food,a\n'.repeat(101)}`), { code: 'BUDGET_EXCEEDED' }); assert.throws(() => preview(f, 'x'.repeat(40001)), { code: 'INVALID_INPUT' });
  const item = preview(f), request = select(item, [1]); assert.throws(() => f.service.commit(item.id, { ...request, selected_rows: [request.selected_rows[0], request.selected_rows[0]] }, { idempotencyKey: 'fixture-duplicate-selection' }), { code: 'INVALID_INPUT' });
  let invoked = false; const rows = []; Object.defineProperty(rows, 0, { enumerable: true, get() { invoked = true; return request.selected_rows[0]; } }); assert.throws(() => f.service.commit(item.id, { ...request, selected_rows: rows }, { idempotencyKey: 'fixture-accessor-selection' }), { code: 'INVALID_INPUT' }); assert.equal(invoked, false);
  assert.throws(() => fixture(t).service.get(item.id), { code: 'SCOPE_DENIED' }); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 0);
});

test('EIS13: selected File bytes are preserved with fatal UTF8/BOM/CRLF checks; invalid file/read changes never produce a transferable preview', async () => {
  const text = '\ufeffdate,description,amount,currency,category\r\n2026-10-04,Café,1.20,CAD,food\r\n', file = new File([Buffer.from(text)], 'fixture.csv'), selected = await readSelectedExpenseCSV(file, 'student-expenses'); assert.equal(selected.csv_text, text); assert.equal(selected.file_sha256, sha(Buffer.from(text)));
  await assert.rejects(readSelectedExpenseCSV(new File([Uint8Array.from([0xc3, 0x28])], 'invalid.csv'), 'student-expenses'), /not valid UTF-8/);
  await assert.rejects(readSelectedExpenseCSV({ name: 'changed.csv', size: 2, arrayBuffer: async () => new Uint8Array([1]).buffer }, 'student-expenses'), /changed while reading/);
  await assert.rejects(readSelectedExpenseCSV(new File(['x'.repeat(40001)], 'large.csv'), 'student-expenses'), /40,000/); await assert.rejects(readSelectedExpenseCSV(file, 'http://bank.example'), /source label/);
});

test('EIS14: exact forgetting removes selected CSV current preview while imported expenses and separate history/backup retention remain explicit', t => {
  const f = fixture(t), item = preview(f), imported = f.service.commit(item.id, select(item), { idempotencyKey: 'fixture-forget-commit' }); assert.throws(() => f.service.forget(item.id, pins(item)), { code: 'REVISION_CONFLICT' });
  const result = f.service.forget(item.id, pins(imported.preview)); assert.equal(result.deleted, true); assert.match(result.retention, /Imported expenses remain/); assert.equal(f.service.state().previews.length, 0); assert.equal(f.store.listWorkspaceRecords({ kind: 'expense' }).length, 3); assert.throws(() => f.service.get(item.id), { code: 'SCOPE_DENIED' });
});

test('EIS15: maximum100-row preview uses two explicitly reviewed50-row atomic batches;51-selected and oversized normalized preview fail before persistence', t => {
  const f = fixture(t), text = `${header}\n${Array.from({ length: 100 }, (_, index) => `2026-10-04,Item${index},1.00,CAD,food,ref${index}`).join('\n')}\n`, item = preview(f, text); assert.equal(item.counts.selectable, 100);
  assert.throws(() => f.service.commit(item.id, select(item, Array.from({ length: 51 }, (_, index) => index + 1)), { idempotencyKey: 'fixture-over-batch' }), { code: 'INVALID_INPUT' });
  const first = f.service.commit(item.id, select(item, Array.from({ length: 50 }, (_, index) => index + 1)), { idempotencyKey: 'fixture-large-batch-one' }); assert.equal(first.receipt.rows.length, 50); assert.equal(first.preview.counts.imported, 50);
  const second = f.service.commit(item.id, select(first.preview), { idempotencyKey: 'fixture-large-batch-two' }); assert.equal(second.preview.counts.imported, 100); assert.deepEqual(f.service.state().totals.totals, [{ currency: 'CAD', cents: 10000 }]);
  const oversized = `${header}\n${Array.from({ length: 100 }, (_, index) => `2026-10-04,${'x'.repeat(300)},1.00,CAD,food,ref${index}`).join('\n')}\n`; assert.ok(Buffer.byteLength(oversized) < 40000); assert.throws(() => preview(f, oversized, 'fixture-normalized-budget'), { code: 'BUDGET_EXCEEDED' }); assert.equal(f.service.state().previews.length, 1);
});
