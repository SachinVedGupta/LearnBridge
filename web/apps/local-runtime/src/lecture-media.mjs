import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LearnBridgeError } from '@learnbridge/core';

const WORKER = fileURLToPath(new URL('./lecture-video.swift', import.meta.url));
const FORMAT = 'learnbridge_lecture_media.v1', MARKER = '.learnbridge-lecture-media', JOB_MARKER = '.learnbridge-lecture-job';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new LearnBridgeError(code); };
export const LECTURE_MEDIA_LIMITS = Object.freeze({ segments: 8, script_bytes: 2500, total_script_bytes: 16000,
  image_bytes: 2_000_000, audio_bytes: 12_000_000, video_bytes: 80_000_000, cache_bytes: 200_000_000, lectures: 12, duration_seconds: 1200,
  segment_seconds: 300, speech_timeout_ms: 30000, video_timeout_ms: 150000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ASSET = /^(?:slide-0[1-8]\.(?:wav|png)|lecture\.mp4)$/;
let voiceCheckAt = 0, installedVoice = false;
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT'); return value.toLowerCase(); }
function ownObject(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
function privateFile(path, { directory = false, maxBytes = 65536 } = {}) {
  let value; try { value = lstatSync(path); } catch { fail('SCOPE_DENIED'); }
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1)
    || (process.getuid && value.uid !== process.getuid()) || value.mode & 0o077) fail('SCOPE_DENIED');
  if (!directory && value.size > maxBytes) fail('BUDGET_EXCEEDED');
  return value;
}
function canonicalRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || realpathSync(value) !== value) fail('SCOPE_DENIED');
  const stat = privateFile(value, { directory: true });
  const marker = join(value, '.learnbridge-local-root'); privateFile(marker);
  if (readFileSync(marker, 'utf8') !== 'learnbridge-local-data-v1\n') fail('SCOPE_DENIED');
  let ancestor = value; while (true) { try { lstatSync(join(ancestor, '.git')); fail('SCOPE_DENIED'); } catch (error) { if (error instanceof LearnBridgeError) throw error; if (error.code !== 'ENOENT') fail('SCOPE_DENIED'); } const next = dirname(ancestor); if (next === ancestor) break; ancestor = next; }
  return { root: value, dev: stat.dev, ino: stat.ino };
}
function pngInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > LECTURE_MEDIA_LIMITS.image_bytes
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(8) !== 13) fail('INVALID_INPUT');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || width > 1600 || !height || height > 1600) fail('INVALID_INPUT');
  return { width, height };
}
/** Exact local PCM frame duration, never word-count or wall-clock estimation. */
export function lectureWavDuration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > LECTURE_MEDIA_LIMITS.audio_bytes
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('PROVIDER_FAILURE');
  let offset = 12, format = null, dataBytes = null, audible = false;
  while (offset + 8 <= bytes.length) {
    const name = bytes.subarray(offset, offset + 4).toString('ascii'), length = bytes.readUInt32LE(offset + 4), start = offset + 8, next = start + length + length % 2;
    if (next > bytes.length) fail('PROVIDER_FAILURE');
    if (name === 'fmt ') {
      if (format || length !== 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 22050
        || bytes.readUInt32LE(start + 8) !== 44100 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) fail('PROVIDER_FAILURE');
      format = true;
    } else if (name === 'data') { if (dataBytes !== null || !length || length % 2) fail('PROVIDER_FAILURE'); dataBytes = length; audible = bytes.subarray(start, start + length).some(byte => byte !== 0); }
    offset = next;
  }
  if (offset !== bytes.length || !format || dataBytes === null || !audible) fail('PROVIDER_FAILURE');
  const seconds = dataBytes / 44100; if (seconds <= 0 || seconds > LECTURE_MEDIA_LIMITS.segment_seconds) fail('BUDGET_EXCEEDED'); return seconds;
}
function selection(input) {
  ownObject(input, ['segments', 'voice', 'rate'], ['segments']);
  const voice = input.voice ?? 'Samantha', rate = input.rate ?? 180;
  if (voice !== 'Samantha' || !Number.isSafeInteger(rate) || rate < 120 || rate > 240 || !Array.isArray(input.segments)
    || Object.getPrototypeOf(input.segments) !== Array.prototype || input.segments.length < 1 || input.segments.length > LECTURE_MEDIA_LIMITS.segments) fail('INVALID_INPUT');
  const segments = [], seen = new Set(); let total = 0;
  for (let index = 0; index < input.segments.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.segments, index); if (!descriptor || !('value' in descriptor)) fail('INVALID_INPUT'); const row = descriptor.value;
    ownObject(row, ['page', 'script', 'png', 'pngBuffer'], ['page', 'script']);
    if (Object.hasOwn(row, 'png') === Object.hasOwn(row, 'pngBuffer')) fail('INVALID_INPUT');
    if (!Number.isSafeInteger(row.page) || row.page < 1 || row.page > 200 || seen.has(row.page) || typeof row.script !== 'string' || !row.script.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(row.script) || /[\ud800-\udfff]/u.test(row.script) || /\[\[|\]\]/.test(row.script)
      || Buffer.byteLength(row.script) > LECTURE_MEDIA_LIMITS.script_bytes) fail('INVALID_INPUT');
    total += Buffer.byteLength(row.script); if (total > LECTURE_MEDIA_LIMITS.total_script_bytes) fail('BUDGET_EXCEEDED'); seen.add(row.page);
    const original = row.pngBuffer ?? row.png, dimensions = pngInfo(original);
    segments.push({ page: row.page, script: row.script, png: Buffer.from(original), dimensions });
  }
  return { voice, rate, segments };
}
function environment(directory) { return { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' }; }

/** Silent, local native narration. Factory/platform seams are trusted tests only. */
export function createLectureMedia({ workspaceRoot, factory = spawn, platform = process.platform } = {}) {
  if (typeof factory !== 'function') fail('INVALID_INPUT');
  let rootIdentity; try { rootIdentity = canonicalRoot(workspaceRoot); } catch (error) { if (error instanceof LearnBridgeError) throw error; fail('SCOPE_DENIED'); }
  const directory = join(rootIdentity.root, 'lecture-media'), markerValue = JSON.stringify({ format: FORMAT, workspace_dev: String(rootIdentity.dev), workspace_ino: String(rootIdentity.ino) }) + '\n';
  let busy = false, closed = false, activeController = null, activeSettled = null;
  function checkRoot() { const current = canonicalRoot(rootIdentity.root); if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) fail('SCOPE_DENIED'); }
  function check({ signal, authorize } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_INPUT');
    if (closed || signal?.aborted) fail('CANCELLED'); if (authorize !== undefined && (typeof authorize !== 'function' || authorize() !== true)) fail('CONSENT_REQUIRED');
    checkRoot();
  }
  function owned({ cleanup = false } = {}) {
    if (cleanup) checkRoot(); else check();
    try { lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') fail('SCOPE_DENIED'); mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, MARKER), markerValue, { mode: 0o600, flag: 'wx' }); }
    privateFile(directory, { directory: true }); privateFile(join(directory, MARKER)); if (readFileSync(join(directory, MARKER), 'utf8') !== markerValue) fail('SCOPE_DENIED'); return directory;
  }
  const jobMarker = recordId => JSON.stringify({ format: FORMAT, id: id(recordId), workspace_dev: String(rootIdentity.dev), workspace_ino: String(rootIdentity.ino) }) + '\n';
  function childDirectory(recordId, options = {}) {
    const path = join(owned(options), id(recordId)); privateFile(path, { directory: true }); privateFile(join(path, JOB_MARKER));
    if (readFileSync(join(path, JOB_MARKER), 'utf8') !== jobMarker(recordId)) fail('SCOPE_DENIED'); return path;
  }
  function deleteOwned(path, identity, valueId) {
    const actual = privateFile(childDirectory(valueId, { cleanup: true }), { directory: true });
    if (actual.dev !== identity.dev || actual.ino !== identity.ino || path !== join(directory, id(valueId))) fail('SCOPE_DENIED');
    rmSync(path, { recursive: true });
  }
  function cacheUsage() {
    let bytes = 0, count = 0, files = 0;
    function walk(path, depth) {
      if (depth > 12) fail('SCOPE_DENIED');
      for (const name of readdirSync(path)) {
        const value = join(path, name), stat = lstatSync(value);
        if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || ++files > 2000) fail('SCOPE_DENIED');
        if (stat.isDirectory()) walk(value, depth + 1);
        else if (!stat.isFile() || stat.nlink !== 1) fail('SCOPE_DENIED');
        else bytes += stat.size;
        if (bytes > LECTURE_MEDIA_LIMITS.cache_bytes) fail('BUDGET_EXCEEDED');
      }
    }
    for (const name of readdirSync(owned())) {
      if (name === MARKER) continue; if (!UUID.test(name)) fail('SCOPE_DENIED');
      const path = childDirectory(name); count++; walk(path, 0);
    }
    return { bytes, count };
  }
  function prerequisite() {
    if (platform !== 'darwin') return false;
    try {
      if (!lstatSync(WORKER).isFile() || lstatSync(WORKER).isSymbolicLink()) return false;
      // A programmatic synthetic worker seam is only used by protocol tests;
      // it does not pretend that native binaries exist on Linux CI runners.
      if (factory !== spawn) return true;
      for (const file of ['/usr/bin/say', '/usr/bin/swift']) { if (!lstatSync(file).isFile()) return false; accessSync(file, constants.X_OK); }
      if (Date.now() - voiceCheckAt > 60000) {
        const result = spawnSync('/usr/bin/say', ['-v', '?'], { shell: false, timeout: 2000, maxBuffer: 65536,
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        installedVoice = result.status === 0 && /^Samantha\s+en_US\s+/m.test(result.stdout?.toString('utf8') || ''); voiceCheckAt = Date.now();
      }
      return installedVoice;
    } catch { return false; }
  }
  function asset(path, name, mime, maxBytes) { const value = join(path, name); privateFile(value, { maxBytes }); const bytes = readFileSync(value); return { name, mime, bytes: bytes.length, sha256: sha(bytes) }; }
  function save(path, value, replace = false) { const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 16000) fail('BUDGET_EXCEEDED'); const file = join(path, replace ? 'manifest-next.json' : 'manifest.json'); writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }); if (replace) renameSync(file, join(path, 'manifest.json')); }
  function manifest(recordId) {
    const valueId = id(recordId), path = childDirectory(valueId); privateFile(join(path, 'manifest.json'), { maxBytes: 16000 }); let value;
    try { value = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')); } catch { fail('VERSION_MISMATCH'); }
    ownObject(value, ['format', 'id', 'voice', 'rate', 'created_at', 'segments', 'duration_seconds', 'video']);
    if (value.format !== FORMAT || value.id !== valueId || value.voice !== 'Samantha' || !Number.isSafeInteger(value.rate) || value.rate < 120 || value.rate > 240 || !Array.isArray(value.segments)
      || !value.segments.length || value.segments.length > 8 || typeof value.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.created_at) || !Number.isFinite(Date.parse(value.created_at))
      || !Number.isFinite(value.duration_seconds) || value.duration_seconds <= 0 || value.duration_seconds > 1200) fail('VERSION_MISMATCH');
    let time = 0; const pages = new Set();
    function verify(info, name, mime, max) {
      ownObject(info, ['name', 'mime', 'bytes', 'sha256'], ['name', 'mime', 'bytes', 'sha256']);
      if (info.name !== name || info.mime !== mime || !Number.isSafeInteger(info.bytes) || info.bytes < 1 || info.bytes > max || !/^[a-f0-9]{64}$/.test(info.sha256)) fail('VERSION_MISMATCH');
      const actual = asset(path, name, mime, max); if (actual.bytes !== info.bytes || actual.sha256 !== info.sha256) fail('VERSION_MISMATCH');
    }
    for (let index = 0; index < value.segments.length; index++) {
      const row = value.segments[index], label = String(index + 1).padStart(2, '0'); ownObject(row, ['page', 'script_sha256', 'audio', 'image', 'duration_seconds', 'start_seconds', 'end_seconds']);
      if (!Number.isSafeInteger(row.page) || row.page < 1 || row.page > 200 || pages.has(row.page) || !/^[a-f0-9]{64}$/.test(row.script_sha256)) fail('VERSION_MISMATCH'); pages.add(row.page);
      verify(row.audio, `slide-${label}.wav`, 'audio/wav', LECTURE_MEDIA_LIMITS.audio_bytes); verify(row.image, `slide-${label}.png`, 'image/png', LECTURE_MEDIA_LIMITS.image_bytes);
      const duration = lectureWavDuration(readFileSync(join(path, row.audio.name))); pngInfo(readFileSync(join(path, row.image.name)));
      if (row.duration_seconds !== duration || row.start_seconds !== time || row.end_seconds !== time + duration) fail('VERSION_MISMATCH'); time += duration;
    }
    if (value.duration_seconds !== time) fail('VERSION_MISMATCH');
    if (value.video !== null) {
      ownObject(value.video, ['asset', 'duration_seconds', 'audio_duration_seconds', 'video_duration_seconds', 'width', 'height', 'audio_tracks', 'video_tracks', 'renderer_version']);
      verify(value.video.asset, 'lecture.mp4', 'video/mp4', LECTURE_MEDIA_LIMITS.video_bytes);
      if (value.video.width !== 1280 || value.video.height !== 720 || value.video.audio_tracks !== 1 || value.video.video_tracks !== 1 || value.video.renderer_version !== 'macos_avfoundation_lecture.v1'
        || ['duration_seconds', 'audio_duration_seconds', 'video_duration_seconds'].some(key => !Number.isFinite(value.video[key]) || Math.abs(value.video[key] - time) > .05)) fail('VERSION_MISMATCH');
    }
    return { value, path };
  }
  async function run(binary, args, path, { signal, authorize, timeoutMs, input = null } = {}) {
    check({ signal, authorize });
    return new Promise((resolve, reject) => {
      let child; try { child = factory(binary, args, { shell: false, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: environment(path) }); } catch { return reject(new LearnBridgeError('UNSUPPORTED')); }
      let done = false, exited = false, reason = null, size = 0, stderr = 0; const chunks = []; let escalation, cleanup;
      const kill = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} } };
      const alive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
      const stop = code => { if (done) return; reason ??= code; kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), 250); };
      const abort = () => stop('CANCELLED'), timer = setTimeout(() => stop('BUDGET_EXCEEDED'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      function finish(code) {
        if (done) return; if (!exited || alive()) { kill('SIGKILL'); cleanup = setTimeout(() => finish(code), 25); return; }
        done = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(cleanup); signal?.removeEventListener('abort', abort);
        try { check({ signal, authorize }); } catch (error) { reason ??= error.code; }
        if (reason) reject(new LearnBridgeError(reason)); else if (code !== 0) reject(new LearnBridgeError('PROVIDER_FAILURE')); else resolve(Buffer.concat(chunks));
      }
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 16384) stop('BUDGET_EXCEEDED'); else chunks.push(chunk); });
      child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 100000) stop('PROVIDER_FAILURE'); });
      child.once('error', () => { if (!child.pid) { exited = true; reason = 'UNSUPPORTED'; finish(1); } else stop('PROVIDER_FAILURE'); });
      child.once('exit', () => { exited = true; }); child.once('close', finish);
      child.once('spawn', () => { try { check({ signal, authorize }); } catch (error) { stop(error.code); } });
      if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
      if (signal?.aborted) stop('CANCELLED');
    });
  }
  async function operation(options, callback) {
    check(options); if (!prerequisite()) fail('UNSUPPORTED'); if (busy) fail('RATE_LIMITED'); busy = true;
    const controller = new AbortController(), abort = () => controller.abort(); activeController = controller; options.signal?.addEventListener('abort', abort, { once: true });
    let settle; activeSettled = new Promise(resolve => { settle = resolve; });
    try { check(options); return await callback({ ...options, signal: controller.signal }); }
    finally { options.signal?.removeEventListener('abort', abort); activeController = null; busy = false; settle(); activeSettled = null; }
  }
  const service = {
    capability() { const available = prerequisite(); return { id: 'lecture_media', state: available ? 'available' : 'unsupported', processing: 'local_macos_speech_and_avfoundation', voices: available ? [{ id: 'Samantha', label: 'Samantha · English (US)', locale: 'en-US', source: 'macos_local_system_voice' }] : [], native_proof: factory === spawn ? 'native_prerequisites_only' : 'synthetic_test_only', voice_cloning: false, timing: 'actual_pcm_frames', interactive_quiz_in_video: false, cache_backed_up: false, limits: LECTURE_MEDIA_LIMITS }; },
    async generateNarration(input, options = {}) {
      const chosen = selection(input);
      return operation(options, async runOptions => {
        if (cacheUsage().count >= LECTURE_MEDIA_LIMITS.lectures) fail('BUDGET_EXCEEDED');
        const valueId = randomUUID(), path = join(owned(), valueId); mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, JOB_MARKER), jobMarker(valueId), { mode: 0o600, flag: 'wx' }); const identity = privateFile(path, { directory: true }); let kept = false;
        try {
          const segments = []; let time = 0;
          for (let index = 0; index < chosen.segments.length; index++) {
            check(runOptions); const row = chosen.segments[index], label = String(index + 1).padStart(2, '0'), script = join(path, `script-${label}.txt`), name = `slide-${label}.wav`;
            writeFileSync(script, row.script, { mode: 0o600, flag: 'wx' }); writeFileSync(join(path, `slide-${label}.png`), row.png, { mode: 0o600, flag: 'wx' });
            await run('/usr/bin/say', ['-v', chosen.voice, '-r', String(chosen.rate), '-o', join(path, name), '--file-format=WAVE', '--data-format=LEI16@22050', '-f', script], path, { ...runOptions, timeoutMs: LECTURE_MEDIA_LIMITS.speech_timeout_ms });
            chmodSync(join(path, name), 0o600); rmSync(script); check(runOptions); const audio = asset(path, name, 'audio/wav', LECTURE_MEDIA_LIMITS.audio_bytes), duration = lectureWavDuration(readFileSync(join(path, name)));
            if (time + duration > LECTURE_MEDIA_LIMITS.duration_seconds) fail('BUDGET_EXCEEDED');
            segments.push({ page: row.page, script_sha256: sha(row.script), audio, image: asset(path, `slide-${label}.png`, 'image/png', LECTURE_MEDIA_LIMITS.image_bytes), duration_seconds: duration, start_seconds: time, end_seconds: time + duration }); time += duration;
            cacheUsage();
          }
          check(runOptions); const value = { format: FORMAT, id: valueId, voice: chosen.voice, rate: chosen.rate, created_at: new Date().toISOString(), segments, duration_seconds: time, video: null };
          save(path, value); cacheUsage(); check(runOptions); manifest(valueId); kept = true; return structuredClone(value);
        } finally { if (!kept) deleteOwned(path, identity, valueId); }
      });
    },
    getManifest(recordId, options = {}) { check(options); return structuredClone(manifest(recordId).value); },
    async exportVideo(recordId, options = {}) {
      return operation(options, async runOptions => {
        const saved = manifest(recordId); if (saved.value.video) return structuredClone(saved.value);
        const modules = join(saved.path, 'modules'); mkdirSync(modules, { mode: 0o700 }); let kept = false;
        try {
          const output = await run('/usr/bin/swift', ['-module-cache-path', modules, WORKER], saved.path, { ...runOptions, timeoutMs: LECTURE_MEDIA_LIMITS.video_timeout_ms,
            input: JSON.stringify({ operation: 'export', directory: saved.path, segments: saved.value.segments.map(row => ({ audio: row.audio.name, image: row.image.name, duration_seconds: row.duration_seconds })) }) });
          check(runOptions); let result; try { result = JSON.parse(output.toString('utf8')); } catch { fail('PROVIDER_FAILURE'); }
          ownObject(result, ['status', 'duration_seconds', 'audio_duration_seconds', 'video_duration_seconds', 'width', 'height', 'audio_tracks', 'video_tracks', 'renderer_version']);
          if (result.status !== 'available' || result.width !== 1280 || result.height !== 720 || result.audio_tracks !== 1 || result.video_tracks !== 1 || result.renderer_version !== 'macos_avfoundation_lecture.v1'
            || ['duration_seconds', 'audio_duration_seconds', 'video_duration_seconds'].some(key => !Number.isFinite(result[key]) || Math.abs(result[key] - saved.value.duration_seconds) > .05)) fail('VERSION_MISMATCH');
          chmodSync(join(saved.path, 'lecture.mp4'), 0o600); const { status, ...details } = result;
          const updated = { ...saved.value, video: { asset: asset(saved.path, 'lecture.mp4', 'video/mp4', LECTURE_MEDIA_LIMITS.video_bytes), ...details } };
          // Recheck all existing slide/audio hashes immediately before commit.
          manifest(recordId); check(runOptions);
          // Compiler modules and the silent intermediate video are disposable;
          // only final lecture media counts toward the durable cache budget.
          rmSync(modules, { recursive: true }); rmSync(join(saved.path, 'video-only.mp4'));
          cacheUsage(); check(runOptions); save(saved.path, updated, true);
          const verified = manifest(recordId).value; kept = true; return structuredClone(verified);
        } finally {
          for (const file of ['video-only.mp4', ...(kept ? [] : ['lecture.mp4', 'manifest-next.json'])]) { const path = join(saved.path, file); try { const stat = lstatSync(path); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) rmSync(path); } catch {} }
          try { privateFile(modules, { directory: true }); rmSync(modules, { recursive: true }); } catch {}
        }
      });
    },
    readAsset(recordId, name, options = {}) {
      check(options); if (typeof name !== 'string' || !ASSET.test(name)) fail('INVALID_INPUT'); const { value, path } = manifest(recordId);
      const known = [...value.segments.flatMap(row => [row.audio, row.image]), ...(value.video ? [value.video.asset] : [])].find(row => row.name === name); if (!known) fail('SCOPE_DENIED');
      const bytes = readFileSync(join(path, name)); check(options); if (sha(bytes) !== known.sha256) fail('VERSION_MISMATCH'); return { ...known, data: bytes };
    },
    remove(recordId, options = {}) { check(options); if (busy) fail('RATE_LIMITED'); const { path } = manifest(recordId), identity = privateFile(path, { directory: true }); check(options); deleteOwned(path, identity, recordId); return { removed: true }; },
    async close() { closed = true; activeController?.abort(); if (activeSettled) await activeSettled; },
  };
  return service;
}
