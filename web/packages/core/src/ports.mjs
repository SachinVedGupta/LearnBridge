import { LearnBridgeError } from './errors.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reject = () => { throw new LearnBridgeError('INVALID_INPUT', { next_action: 'review_input' }); };
function dataObject(value, keys) {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
    || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value')
    || !descriptors[key].enumerable)) reject();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

/**
 * Domain shape check only: this is not authentication. Identity must already be
 * produced by Supabase verification or the future local pairing/IPC adapter.
 */
export function assertEditionIdentity(edition, identity) {
  if (!['local', 'hosted'].includes(edition)) reject();
  const expected = edition === 'local' ? ['edition', 'student_id'] : ['edition', 'user_id', 'session_ref'];
  identity = dataObject(identity, expected);
  if (identity.edition !== edition) reject();
  const id = edition === 'local' ? identity.student_id : identity.user_id;
  if (typeof id !== 'string' || !uuid.test(id)) reject();
  if (edition === 'hosted' && (typeof identity.session_ref !== 'string'
    || identity.session_ref.length < 1 || identity.session_ref.length > 200)) reject();
  return Object.freeze({ ...identity });
}

/** Source-read permission does not imply cloud processing permission. */
export function parseExecutionDestination(value) {
  value = dataObject(value, ['surface', 'processor']);
  if (['local_ui', 'local_worker'].includes(value.surface)) {
    if (value.processor !== null) reject();
  } else if (['cloud_host', 'embedded_cloud_agent'].includes(value.surface)) {
    if (typeof value.processor !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.processor)) reject();
  } else reject();
  return Object.freeze({ ...value });
}
