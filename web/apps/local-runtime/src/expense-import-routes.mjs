import { LearnBridgeError } from '@learnbridge/core';
import { createExpenseImportService } from './expense-import-service.mjs';

export async function handleExpenseImportRoute({ route, method, privateBody, store, session, expenseImportService, stillAuthorized, idempotencyKey }) {
  if (!route.startsWith('/expense-import/')) return null;
  if (typeof session?.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED'); const service = expenseImportService || createExpenseImportService({ store });
  const authorize = () => { if (stillAuthorized) stillAuthorized(); };
  if (route === '/expense-import/state') { if (method !== 'GET') throw new LearnBridgeError('INVALID_INPUT'); authorize(); return { status: 200, data: service.state() }; }
  if (route === '/expense-import/previews') { if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT'); const body = await privateBody(['origin', 'filename', 'csv_text', 'file_sha256'], ['origin', 'filename', 'csv_text', 'file_sha256'], 90000); authorize(); return { status: 201, data: service.preview(body, { idempotencyKey }) }; }
  const matched = /^\/expense-import\/previews\/([a-f0-9-]{36})(?:\/(commit))?$/.exec(route); if (!matched) return null;
  if (!matched[2] && method === 'GET') { authorize(); return { status: 200, data: service.get(matched[1]) }; }
  if ((matched[2] && method !== 'POST') || (!matched[2] && method !== 'DELETE')) throw new LearnBridgeError('INVALID_INPUT');
  const fields = ['expected_revision', 'preview_hash', ...(matched[2] ? ['selected_rows'] : [])], body = await privateBody(fields, fields, 10000); authorize();
  return { status: 200, data: matched[2] ? service.commit(matched[1], body, { idempotencyKey }) : service.forget(matched[1], body) };
}
