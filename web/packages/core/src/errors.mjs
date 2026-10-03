/** Stable errors shared by the local core. Messages never echo rejected input. */
export const ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED', 'CONSENT_REQUIRED', 'SCOPE_DENIED', 'UNSUPPORTED',
  'RATE_LIMITED', 'OFFLINE', 'VERSION_MISMATCH', 'REVISION_CONFLICT',
  'BUDGET_EXCEEDED', 'CANCELLED', 'INVALID_INPUT', 'UNKNOWN_OUTCOME',
  'PROVIDER_FAILURE',
]);

const DEFAULT_MESSAGES = Object.freeze({
  AUTH_REQUIRED: 'Sign in using the supported authentication flow.',
  CONSENT_REQUIRED: 'Current source permission is required.',
  SCOPE_DENIED: 'The requested operation is outside the approved scope.',
  UNSUPPORTED: 'This capability is not supported.',
  RATE_LIMITED: 'The provider rate limit was reached.',
  OFFLINE: 'The required service is unavailable.',
  VERSION_MISMATCH: 'Saved data or capabilities changed; refresh before continuing.',
  REVISION_CONFLICT: 'The record changed; review the current revision.',
  BUDGET_EXCEEDED: 'The approved execution budget was reached.',
  CANCELLED: 'The operation was cancelled.',
  INVALID_INPUT: 'Input does not satisfy the LearnBridge contract.',
  UNKNOWN_OUTCOME: 'The external outcome must be checked before retrying.',
  PROVIDER_FAILURE: 'The provider operation failed.',
});

/** @typedef {'AUTH_REQUIRED'|'CONSENT_REQUIRED'|'SCOPE_DENIED'|'UNSUPPORTED'|'RATE_LIMITED'|'OFFLINE'|'VERSION_MISMATCH'|'REVISION_CONFLICT'|'BUDGET_EXCEEDED'|'CANCELLED'|'INVALID_INPUT'|'UNKNOWN_OUTCOME'|'PROVIDER_FAILURE'} ErrorCode */

export class LearnBridgeError extends Error {
  /**
   * Only stable, predefined messages enter public error envelopes. Never pass
   * provider responses, paths, tokens or imported content as error text.
   * @param {ErrorCode} code
   * @param {{retryable?: boolean, retry_after_seconds?: number|null, next_action?: 'review_input'|'sign_in'|'review_scope'|'refresh'|'retry_later'|'check_outcome'|null}} [options]
   */
  constructor(code, options = {}) {
    if (!ERROR_CODES.includes(code)) throw new TypeError('Unknown LearnBridge error code.');
    super(DEFAULT_MESSAGES[code]);
    this.name = 'LearnBridgeError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.retry_after_seconds = Number.isSafeInteger(options.retry_after_seconds)
      && options.retry_after_seconds >= 0 ? options.retry_after_seconds : null;
    const actions = ['review_input', 'sign_in', 'review_scope', 'refresh', 'retry_later', 'check_outcome'];
    this.next_action = actions.includes(options.next_action) ? options.next_action : null;
  }

  /** @returns {{code: ErrorCode, message:string, retryable:boolean, retry_after_seconds:number|null, next_action:string|null}} */
  toJSON() {
    return {
      code: this.code, message: this.message, retryable: this.retryable,
      retry_after_seconds: this.retry_after_seconds, next_action: this.next_action,
    };
  }
}

/** Convert unknown failures without revealing a provider error or stack. */
export function toErrorEnvelope(error) {
  return error instanceof LearnBridgeError
    ? error.toJSON()
    : new LearnBridgeError('PROVIDER_FAILURE').toJSON();
}

export function invalidInput() {
  throw new LearnBridgeError('INVALID_INPUT', { next_action: 'review_input' });
}

/** Expected revisions are a concurrency condition, never an overwrite hint. */
export function assertRevision(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected < 1
    || !Number.isSafeInteger(actual) || actual < 1) invalidInput();
  if (expected !== actual) {
    throw new LearnBridgeError('REVISION_CONFLICT', { next_action: 'refresh' });
  }
}
