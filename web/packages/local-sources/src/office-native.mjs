import { spawn } from 'node:child_process';
import { access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LearnBridgeError } from '@learnbridge/core';

export const OFFICE_LIMITS = Object.freeze({ maxOfficeBytes: 4_000_000, maxZipEntries: 1000,
  maxUncompressedBytes: 8_000_000, maxXmlBytes: 2_000_000, maxXmlDepth: 64, maxXmlNodes: 100_000,
  maxSections: 1000, maxTextBytes: 256_000, maxMetadataBytes: 96_000, maxResultBytes: 128_000, maxDurationMs: 5000 });
export const OFFICE_PARSER_VERSION = 'stdlib_ooxml.v1';
const PYTHON = fileURLToPath(new URL('../../../../.venv/bin/python3', import.meta.url));
const HELPER = fileURLToPath(new URL('./office-text.py', import.meta.url));
const error = code => new LearnBridgeError(code);

/** Prerequisites only: no archive, import or child process at startup. */
export async function officePrerequisites() {
  if (!['darwin', 'linux'].includes(process.platform)) return false;
  try {
    const [binary, helper] = await Promise.all([stat(PYTHON), lstat(HELPER)]);
    if (!binary.isFile() || !helper.isFile() || helper.isSymbolicLink()) return false;
    await Promise.all([access(PYTHON, constants.X_OK), access(HELPER, constants.R_OK)]);
    return true;
  } catch { return false; }
}

/** Fixed stdlib parser; options are trusted package seams, never HTTP input. */
export async function runOfficeParser(bytes, { documentType, maxTextBytes = 48_000, signal,
  timeoutMs = OFFICE_LIMITS.maxDurationMs, onSpawn } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw error('UNSUPPORTED');
  if (!Buffer.isBuffer(bytes) || bytes.length > OFFICE_LIMITS.maxOfficeBytes || !['docx', 'pptx'].includes(documentType)
    || !Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > OFFICE_LIMITS.maxTextBytes
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > OFFICE_LIMITS.maxDurationMs
    || (signal !== undefined && !(signal instanceof AbortSignal)) || (onSpawn !== undefined && typeof onSpawn !== 'function')) throw error('INVALID_INPUT');
  if (signal?.aborted) throw error('CANCELLED');
  return await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', '-S', '-B', '-X', 'utf8', '-u', HELPER], {
      shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { TZ: 'UTC' },
    });
    let done = false, exited = false, failure = null, outputBytes = 0, stderrBytes = 0;
    const output = []; let escalation, cleanupTimer, groupTimer;
    const killGroup = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
    const groupAlive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch (value) { return value?.code !== 'ESRCH'; } };
    const closeStreams = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
    const confirmCleanup = () => { if (done) return; killGroup('SIGKILL'); if (exited) closeStreams(); else cleanupTimer = setTimeout(confirmCleanup, 250); };
    const stop = code => { if (done) return; failure ??= code; killGroup('SIGTERM'); escalation ??= setTimeout(() => killGroup('SIGKILL'), 500); cleanupTimer ??= setTimeout(confirmCleanup, 2500); };
    const timer = setTimeout(() => stop('BUDGET_EXCEEDED'), timeoutMs);
    const abort = () => stop('CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
    const finish = (failureValue, value) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanupTimer); clearTimeout(groupTimer); signal?.removeEventListener('abort', abort); failureValue ? reject(failureValue) : resolve(value); };
    const finishAfterExit = (failureValue, value) => { if (done) return; if (!exited || groupAlive()) { killGroup('SIGKILL'); groupTimer = setTimeout(() => finishAfterExit(failureValue, value), 25); return; } finish(failureValue, value); };
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > OFFICE_LIMITS.maxResultBytes) stop('BUDGET_EXCEEDED'); else output.push(chunk); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) stop('PROVIDER_FAILURE'); });
    child.once('error', () => { if (!child.pid) { exited = true; finish(error('UNSUPPORTED')); } else stop('UNSUPPORTED'); });
    child.once('exit', () => { exited = true; if (failure) { killGroup('SIGKILL'); closeStreams(); } });
    child.once('close', code => {
      if (signal?.aborted) failure = 'CANCELLED';
      if (failure) return finishAfterExit(error(failure));
      if (code !== 0 || !outputBytes) return finishAfterExit(error('PROVIDER_FAILURE'));
      let value; try { value = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { return finishAfterExit(error('PROVIDER_FAILURE')); }
      if (value?.status === 'budget_exceeded') return finishAfterExit(error('BUDGET_EXCEEDED'));
      finishAfterExit(null, value);
    });
    child.once('spawn', () => { if (signal?.aborted) return stop('CANCELLED'); if (onSpawn) Promise.resolve().then(() => onSpawn({ phase: 'office_process_started', pid: child.pid })).catch(() => stop('PROVIDER_FAILURE')); });
    const header = Buffer.from(JSON.stringify({ document_type: documentType, max_text_bytes: maxTextBytes }) + '\n');
    child.stdin.end(Buffer.concat([header, bytes]));
  });
}
