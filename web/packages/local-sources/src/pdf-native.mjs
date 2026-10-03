import { spawn } from 'node:child_process';
import { mkdtemp, rm, chmod, access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LearnBridgeError } from '@learnbridge/core';

export const PDF_LIMITS = Object.freeze({ maxPdfBytes: 4_000_000, maxPages: 200, maxTextBytes: 256_000,
  maxMetadataBytes: 96_000, maxResultBytes: 128_000, maxDurationMs: 30_000 });
export const PDF_PARSER_VERSION = 'macos_pdfkit.v1';
const HELPER = fileURLToPath(new URL('./pdf-text.swift', import.meta.url));
const error = code => new LearnBridgeError(code);

/** Startup checks prerequisites only; no compiler or document is launched. */
export async function nativePdfPrerequisites() {
  if (process.platform !== 'darwin') return false;
  try {
    const [binary, helper] = await Promise.all([stat('/usr/bin/swift'), lstat(HELPER)]);
    if (!binary.isFile() || !helper.isFile() || helper.isSymbolicLink()) return false;
    await Promise.all([access('/usr/bin/swift', constants.X_OK), access(HELPER, constants.R_OK)]);
    return true;
  } catch { return false; }
}

/** Fixed native invocation. Its options are trusted package code, never HTTP input. */
export async function runNativePdf(bytes, { signal, maxTextBytes = 48_000, timeoutMs = PDF_LIMITS.maxDurationMs, onSpawn } = {}) {
  if (process.platform !== 'darwin') throw error('UNSUPPORTED');
  if ((bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length > PDF_LIMITS.maxPdfBytes))
    || !Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > PDF_LIMITS.maxTextBytes
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > PDF_LIMITS.maxDurationMs
    || (signal !== undefined && !(signal instanceof AbortSignal)) || (onSpawn !== undefined && typeof onSpawn !== 'function')) throw error('INVALID_INPUT');
  if (signal?.aborted) throw error('CANCELLED');
  const directory = await mkdtemp(join(tmpdir(), 'learnbridge-native-pdf-'));
  try {
    await chmod(directory, 0o700);
    if (signal?.aborted) throw error('CANCELLED');
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/swift', ['-module-cache-path', join(directory, 'modules'), HELPER], {
        shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' },
      });
      let done = false, exited = false, failure = null, outputBytes = 0, stderrBytes = 0;
      const output = [];
      let escalation, cleanupTimer, groupTimer;
      const killGroup = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
      const groupAlive = () => {
        if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (value) { return value?.code !== 'ESRCH'; }
      };
      const closeStreams = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
      const confirmCleanup = () => {
        if (done) return;
        killGroup('SIGKILL');
        // A timer is not evidence of exit. Do not settle or remove the private
        // cache while a lingering child still has access to it. SIGKILL is
        // repeated until the operating system acknowledges the exit; streams
        // can be destroyed only after that acknowledgement.
        if (exited) closeStreams();
        else cleanupTimer = setTimeout(confirmCleanup, 250);
      };
      const stop = code => {
        if (done) return;
        failure ??= code;
        killGroup('SIGTERM');
        escalation ??= setTimeout(() => killGroup('SIGKILL'), 500);
        cleanupTimer ??= setTimeout(confirmCleanup, 2500);
      };
      const timer = setTimeout(() => stop('BUDGET_EXCEEDED'), timeoutMs);
      const abort = () => stop('CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (failureValue, value) => {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanupTimer); clearTimeout(groupTimer); signal?.removeEventListener('abort', abort);
        failureValue ? reject(failureValue) : resolve(value);
      };
      const finishAfterExit = (failureValue, value) => {
        if (done) return;
        if (!exited || groupAlive()) {
          killGroup('SIGKILL');
          groupTimer = setTimeout(() => finishAfterExit(failureValue, value), 25);
          return;
        }
        finish(failureValue, value);
      };
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > PDF_LIMITS.maxResultBytes) stop('BUDGET_EXCEEDED'); else output.push(chunk); });
      // Compiler/native diagnostics may contain source excerpts or paths. They
      // are never printed, persisted or returned, including on malformed PDFs.
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16_384) stop('UNSUPPORTED'); });
      child.once('error', () => { if (!child.pid) { exited = true; finish(error('UNSUPPORTED')); } else stop('UNSUPPORTED'); });
      child.once('exit', () => { exited = true; if (failure) { killGroup('SIGKILL'); closeStreams(); } });
      child.once('close', code => {
        if (signal?.aborted) failure = 'CANCELLED';
        if (failure) return finishAfterExit(error(failure));
        if (code !== 0 || !outputBytes) return finishAfterExit(error('UNSUPPORTED'));
        let value;
        try { value = JSON.parse(Buffer.concat(output).toString('utf8')); } catch { return finishAfterExit(error('PROVIDER_FAILURE')); }
        if (value?.status === 'budget_exceeded') return finishAfterExit(error('BUDGET_EXCEEDED'));
        finishAfterExit(null, value);
      });
      child.once('spawn', () => {
        if (signal?.aborted) return stop('CANCELLED');
        if (onSpawn) Promise.resolve().then(() => onSpawn({ phase: 'pdf_process_started', pid: child.pid })).catch(() => stop('PROVIDER_FAILURE'));
      });
      const header = Buffer.from(JSON.stringify(bytes === null ? { operation: 'probe' } : { operation: 'extract', max_text_bytes: maxTextBytes }) + '\n');
      child.stdin.end(bytes === null ? header : Buffer.concat([header, bytes]));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
