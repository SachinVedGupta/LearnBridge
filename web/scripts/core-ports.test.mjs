import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEditionIdentity, parseExecutionDestination } from '../packages/core/src/ports.mjs';

const student = 'a7c111a5-9d34-4c16-8d01-bdc5fc900a01';
test('local identity cannot be used as hosted identity or acquire an auth bypass flag', () => {
  const local = { edition: 'local', student_id: student };
  assert.deepEqual(assertEditionIdentity('local', local), local);
  assert.throws(() => assertEditionIdentity('hosted', local), { code: 'INVALID_INPUT' });
  assert.throws(() => assertEditionIdentity('local', { ...local, authenticated: true }), { code: 'INVALID_INPUT' });
  assert.throws(() => assertEditionIdentity('local', Object.create(local)), { code: 'INVALID_INPUT' });
});
test('hosted identity preserves verified-session reference and the shape check is immutable', () => {
  const input = { edition: 'hosted', user_id: student, session_ref: 'verified-session-reference' };
  const parsed = assertEditionIdentity('hosted', input);
  assert.deepEqual(parsed, input);
  input.session_ref = 'changed';
  assert.equal(parsed.session_ref, 'verified-session-reference');
  assert(Object.isFrozen(parsed));
  assert.throws(() => assertEditionIdentity('hosted', { edition: 'hosted', user_id: student, session_ref: '' }));
});
test('cloud destinations require an explicit named processor, local destinations cannot claim one', () => {
  assert.deepEqual(parseExecutionDestination({ surface: 'cloud_host', processor: 'openai' }),
    { surface: 'cloud_host', processor: 'openai' });
  assert.deepEqual(parseExecutionDestination({ surface: 'local_ui', processor: null }),
    { surface: 'local_ui', processor: null });
  for (const value of [
    { surface: 'cloud_host', processor: null },
    { surface: 'local_worker', processor: 'openai' },
    { surface: 'cloud_host', processor: 'https://unreviewed.invalid' },
    { surface: 'unknown', processor: null },
    { surface: 'cloud_host', processor: 'openai', bypass: true },
  ]) assert.throws(() => parseExecutionDestination(value), { code: 'INVALID_INPUT' });
});
test('identity and destination shapes reject accessors and hidden properties without invoking them', () => {
  let reads = 0;
  const identity = { edition: 'local', student_id: student };
  Object.defineProperty(identity, 'edition', { enumerable: true, get() { reads++; return 'local'; } });
  assert.throws(() => assertEditionIdentity('local', identity), { code: 'INVALID_INPUT' });
  const destination = { surface: 'cloud_host', processor: 'openai' };
  Object.defineProperty(destination, 'processor', { enumerable: true, get() { reads++; return 'openai'; } });
  assert.throws(() => parseExecutionDestination(destination), { code: 'INVALID_INPUT' });
  for (const property of ['hidden', Symbol('hidden')]) {
    const input = { edition: 'local', student_id: student };
    Object.defineProperty(input, property, { value: true });
    assert.throws(() => assertEditionIdentity('local', input), { code: 'INVALID_INPUT' });
  }
  assert.equal(reads, 0);
});
