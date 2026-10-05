import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createLectureMedia, lectureWavDuration } from '../apps/local-runtime/src/lecture-media.mjs';

const fixture = fileURLToPath(new URL('./fixtures/lecture-media-fixture.mjs', import.meta.url)), inspect = fileURLToPath(new URL('./fixtures/lecture-video-inspect.swift', import.meta.url));
const exec = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex'), isCode = code => error => error.code === code && !error.message.includes('SYNTHETIC_PRIVATE_TEXT_CANARY');
function png(color = [255, 0, 0]) {
  function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
  function chunk(name, body) { const data = Buffer.alloc(body.length + 12); data.writeUInt32BE(body.length); data.write(name, 4); body.copy(data, 8); data.writeUInt32BE(crc(data.subarray(4, -4)), data.length - 4); return data; }
  const header = Buffer.alloc(13); header.writeUInt32BE(20); header.writeUInt32BE(10, 4); header[8] = 8; header[9] = 2;
  const data = Buffer.alloc(610); for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) color.forEach((channel, n) => { data[y * 61 + 1 + x * 3 + n] = channel; });
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
function setup(t, mode = 'normal', native = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'learnbridge-lecture-media-'))), root = join(parent, 'workspace'); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, '.learnbridge-local-root'), 'learnbridge-local-data-v1\n', { mode: 0o600 });
  const launches = []; const media = createLectureMedia({ workspaceRoot: root, ...(native ? {} : { factory(binary, args, config) { launches.push({ binary, args, config }); return spawn(process.execPath, [fixture, mode, binary === '/usr/bin/say' ? 'say' : 'swift', ...args], config); }, platform: 'darwin' }) });
  t.after(() => { media.close(); rmSync(parent, { recursive: true, force: true }); });
  const input = { voice: 'Samantha', rate: 180, segments: [{ page: 1, script: 'A base case stops recursion.', pngBuffer: png() }, { page: 2, script: 'A smaller problem brings us closer to that base case.', pngBuffer: png([0, 0, 255]) }] };
  return { parent, root, media, input, launches, cache: join(root, 'lecture-media') };
}
test('local narration uses exact PCM durations and atomically retains hashed private images/audio without spoken text in its manifest', async t => {
  const f = setup(t), manifest = await f.media.generateNarration(f.input, { authorize: () => true });
  assert.equal(manifest.duration_seconds, 2); assert.deepEqual(manifest.segments.map(row => [row.page, row.start_seconds, row.end_seconds]), [[1,0,1],[2,1,2]]);
  assert.equal(JSON.stringify(manifest).includes(f.input.segments[0].script), false); assert.equal(manifest.segments[0].script_sha256, sha(f.input.segments[0].script)); assert.equal(manifest.video, null);
  for (const name of readdirSync(join(f.cache, manifest.id))) { assert.equal(name.startsWith('script-'), false); assert.equal(lstatSync(join(f.cache, manifest.id, name)).mode & 0o077, 0); }
  assert.equal(lstatSync(f.cache).mode & 0o077, 0); assert.equal(lstatSync(join(f.cache, manifest.id)).mode & 0o077, 0); assert.deepEqual(f.media.getManifest(manifest.id), manifest);
  const blob = f.media.readAsset(manifest.id, manifest.segments[0].audio.name); assert.equal(blob.mime, 'audio/wav'); assert.equal(lectureWavDuration(blob.data), 1); assert.equal(sha(blob.data), blob.sha256);
  const reopened = createLectureMedia({ workspaceRoot: f.root }); assert.deepEqual(reopened.getManifest(manifest.id), manifest); reopened.close();
});
test('fixed speech command reads a private text file and inherits no account/model credentials or source text in arguments', async t => {
  const before = process.env.LECTURE_PRIVATE_CANARY; process.env.LECTURE_PRIVATE_CANARY = 'synthetic-user-secret'; t.after(() => { if (before === undefined) delete process.env.LECTURE_PRIVATE_CANARY; else process.env.LECTURE_PRIVATE_CANARY = before; });
  const f = setup(t); await f.media.generateNarration(f.input);
  for (const launch of f.launches) { assert.equal(launch.binary, '/usr/bin/say'); assert.equal(launch.config.shell, false); assert.equal(launch.config.detached, true); assert.equal(launch.config.env.LECTURE_PRIVATE_CANARY, undefined); assert.equal(launch.config.env.OPENAI_API_KEY, undefined); assert.equal(launch.config.env.NODE_OPTIONS, undefined); assert.equal(launch.args.includes(f.input.segments[0].script), false); assert.ok(launch.args.includes('-f')); }
});
test('linear MP4 export binds the saved audio/image hashes and measured track durations and safely reuses an existing export', async t => {
  const f = setup(t), saved = await f.media.generateNarration(f.input), video = await f.media.exportVideo(saved.id); assert.equal(video.video.audio_tracks, 1); assert.equal(video.video.video_tracks, 1); assert.equal(video.video.duration_seconds, 2);
  assert.deepEqual(video.segments, saved.segments); assert.equal(f.media.readAsset(saved.id, 'lecture.mp4').mime, 'video/mp4'); assert.deepEqual(await f.media.exportVideo(saved.id), video); assert.equal(f.launches.filter(row => row.binary === '/usr/bin/swift').length, 1);
  assert.equal(existsSync(join(f.cache, saved.id, 'modules')), false); assert.equal(existsSync(join(f.cache, saved.id, 'video-only.mp4')), false);
  assert.deepEqual(f.media.remove(saved.id), { removed: true }); assert.equal(existsSync(join(f.cache, saved.id)), false); assert.equal(existsSync(f.root), true);
});
test('input snapshots reject arbitrary voice/commands, duplicate pages, speech directives, oversized UTF8 scripts, paths and non-PNG bytes before any launch', async t => {
  const f = setup(t), one = f.input.segments[0];
  for (const input of [{ ...f.input, voice: '--fake' }, { ...f.input, voice: 'Alex' }, { ...f.input, rate: 500 }, { ...f.input, segments: [] }, { ...f.input, segments: Array(9).fill(one) }, { ...f.input, segments: [one, one] }, { ...f.input, segments: [{ ...one, script: '[[rate 999]] hi' }] }, { ...f.input, segments: [{ ...one, script: '🧠'.repeat(700) }] }, { ...f.input, segments: [{ ...one, script: 'x\0y' }] }, { ...f.input, segments: [{ ...one, pngBuffer: '/private/path' }] }, { ...f.input, segments: [{ ...one, pngBuffer: Buffer.from('not png') }] }, { ...f.input, segments: [{ ...one, image_path: '/private/path' }] }]) await assert.rejects(f.media.generateNarration(input), isCode('INVALID_INPUT'));
  let reads = 0; const getter = { ...one }; Object.defineProperty(getter, 'script', { enumerable: true, get() { reads++; return one.script; } }); await assert.rejects(f.media.generateNarration({ ...f.input, segments: [getter] }), isCode('INVALID_INPUT')); assert.equal(reads, 0); assert.equal(f.launches.length, 0); assert.equal(existsSync(f.cache), false);
});
test('source images and narration scripts are snapshotted before the asynchronous native job', async t => {
  const f = setup(t), original = sha(f.input.segments[0].pngBuffer), pending = f.media.generateNarration(f.input); f.input.segments[0].pngBuffer.fill(0); f.input.segments[0].script = 'different edited text'; const saved = await pending; assert.equal(saved.segments[0].image.sha256, original); assert.equal(saved.segments[0].script_sha256, sha('A base case stops recursion.'));
});
test('denied or cancelled jobs publish no playable manifest and remove only their private partial directory', async t => {
  const denied = setup(t); await assert.rejects(denied.media.generateNarration(denied.input, { authorize: () => false }), isCode('CONSENT_REQUIRED')); assert.equal(existsSync(denied.cache), false);
  const f = setup(t, 'slow'), controller = new AbortController(), pending = f.media.generateNarration(f.input, { signal: controller.signal }); setTimeout(() => controller.abort(), 100); await assert.rejects(pending, isCode('CANCELLED')); assert.deepEqual(readdirSync(f.cache), ['.learnbridge-lecture-media']); assert.equal(existsSync(f.root), true);
});
test('revoked source authorization after native work discards every partial file without provider diagnostics', async t => {
  const f = setup(t), authorize = () => f.launches.length < 1; await assert.rejects(f.media.generateNarration(f.input, { authorize }), isCode('CONSENT_REQUIRED')); assert.deepEqual(readdirSync(f.cache), ['.learnbridge-lecture-media']);
});
for (const [mode, code] of [['fail','PROVIDER_FAILURE'],['corrupt','PROVIDER_FAILURE'],['silence','PROVIDER_FAILURE'],['long','BUDGET_EXCEEDED'],['oversized','BUDGET_EXCEEDED']]) test(`native ${mode} fails without a retained ready lecture`, async t => {
  const f = setup(t, mode); await assert.rejects(f.media.generateNarration(f.input), isCode(code)); assert.deepEqual(readdirSync(f.cache), ['.learnbridge-lecture-media']);
});
test('desynchronized video is discarded while the original valid narrated lesson remains readable', async t => {
  const f = setup(t, 'desync'), saved = await f.media.generateNarration(f.input); await assert.rejects(f.media.exportVideo(saved.id), isCode('VERSION_MISMATCH')); assert.deepEqual(f.media.getManifest(saved.id), saved); assert.equal(existsSync(join(f.cache, saved.id, 'lecture.mp4')), false); assert.equal(existsSync(join(f.cache, saved.id, 'modules')), false);
});
test('asset path traversal and altered audio, image or timeline bytes fail closed', async t => {
  const f = setup(t), saved = await f.media.generateNarration(f.input);
  for (const name of ['../manifest.json', '/private/path', 'manifest.json', 'slide-99.wav']) assert.throws(() => f.media.readAsset(saved.id, name), isCode('INVALID_INPUT'));
  assert.throws(() => f.media.getManifest('../../'), isCode('INVALID_INPUT'));
  const path = join(f.cache, saved.id, saved.segments[0].audio.name), original = readFileSync(path); writeFileSync(path, Buffer.alloc(original.length), { mode: 0o600 }); assert.throws(() => f.media.getManifest(saved.id), isCode('VERSION_MISMATCH')); writeFileSync(path, original, { mode: 0o600 });
  const manifestPath = join(f.cache, saved.id, 'manifest.json'), altered = structuredClone(saved); altered.segments[1].start_seconds = .5; writeFileSync(manifestPath, JSON.stringify(altered), { mode: 0o600 }); assert.throws(() => f.media.getManifest(saved.id), isCode('VERSION_MISMATCH'));
});
test('symlinked, unmarked, permissive or Git workspace/cache roots cannot be used or recursively erased', async t => {
  const f = setup(t), link = join(f.parent, 'linked'); symlinkSync(f.root, link); assert.throws(() => createLectureMedia({ workspaceRoot: link }), isCode('SCOPE_DENIED'));
  const unmarked = join(f.parent, 'unmarked'); mkdirSync(unmarked, { mode: 0o700 }); assert.throws(() => createLectureMedia({ workspaceRoot: unmarked }), isCode('SCOPE_DENIED'));
  writeFileSync(join(f.parent, '.git'), 'synthetic'); assert.throws(() => createLectureMedia({ workspaceRoot: f.root }), isCode('SCOPE_DENIED')); rmSync(join(f.parent, '.git'));
  mkdirSync(f.cache, { mode: 0o755 }); await assert.rejects(f.media.generateNarration(f.input), isCode('SCOPE_DENIED')); assert.equal(f.launches.length, 0); chmodSync(f.cache, 0o700); await assert.rejects(f.media.generateNarration(f.input), isCode('SCOPE_DENIED'));
});
test('unsupported platforms expose an explicit local media limitation and never spawn a fallback/network provider', async t => {
  const f = setup(t), media = createLectureMedia({ workspaceRoot: f.root, platform: 'linux', factory() { assert.fail('must not spawn'); } }); assert.equal(media.capability().state, 'unsupported'); assert.deepEqual(media.capability().voices, []); assert.equal(media.capability().cache_backed_up, false); await assert.rejects(media.generateNarration(f.input), isCode('UNSUPPORTED')); media.close();
});
test('close cancels active native generation and a busy adapter cannot start another job or remove existing files', async t => {
  const f = setup(t, 'slow'), pending = f.media.generateNarration(f.input); await assert.rejects(f.media.generateNarration(f.input), isCode('RATE_LIMITED')); const cancelled = assert.rejects(pending, isCode('CANCELLED')); await f.media.close(); await cancelled; await assert.rejects(f.media.generateNarration(f.input), isCode('CANCELLED')); assert.deepEqual(readdirSync(f.cache), ['.learnbridge-lecture-media']);
});
test('cache count denies a thirteenth lecture without deleting historical ready assets', async t => {
  const f = setup(t), input = { ...f.input, segments: [f.input.segments[0]] }; let first; for (let index = 0; index < 12; index++) { const row = await f.media.generateNarration(input); first ??= row; } await assert.rejects(f.media.generateNarration(input), isCode('BUDGET_EXCEEDED')); assert.deepEqual(f.media.getManifest(first.id), first); assert.equal(readdirSync(f.cache).length, 13);
});
test('a full private cache denies new work and preserves earlier media rather than deleting it automatically', async t => {
  const f = setup(t), saved = await f.media.generateNarration(f.input), file = join(f.cache, saved.id, 'synthetic-budget-test-file'); writeFileSync(file, '', { mode: 0o600 }); truncateSync(file, 200000001);
  const launches = f.launches.length; await assert.rejects(f.media.generateNarration(f.input), isCode('BUDGET_EXCEEDED')); assert.equal(f.launches.length, launches); assert.deepEqual(f.media.getManifest(saved.id), saved); assert.equal(existsSync(file), true);
});
test('symlink-swapped media assets and unmarked cache entries cannot be read, used or removed', async t => {
  const f = setup(t), saved = await f.media.generateNarration(f.input), file = join(f.cache, saved.id, saved.segments[0].audio.name), outside = join(f.parent, 'unrelated.wav'); writeFileSync(outside, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(outside, file);
  assert.throws(() => f.media.readAsset(saved.id, saved.segments[0].audio.name), isCode('SCOPE_DENIED')); assert.throws(() => f.media.remove(saved.id), isCode('SCOPE_DENIED')); assert.equal(existsSync(outside), true);
  const unmarked = join(f.cache, '38a77fcb-427b-4841-994c-7b6fefc34b13'); mkdirSync(unmarked, { mode: 0o700 }); writeFileSync(join(unmarked, 'keep'), 'unrelated', { mode: 0o600 }); await assert.rejects(f.media.generateNarration(f.input), isCode('SCOPE_DENIED')); assert.equal(readFileSync(join(unmarked, 'keep'), 'utf8'), 'unrelated');
});
test('actual macOS speech and AVFoundation export retain audible PCM, exact track timing and the selected red-to-blue slide boundary', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
  const f = setup(t, 'normal', true), saved = await f.media.generateNarration(f.input), video = await f.media.exportVideo(saved.id);
  assert(saved.duration_seconds > 2 && saved.duration_seconds < 30); assert(saved.segments.every(row => row.duration_seconds > .1));
  const audio = f.media.readAsset(saved.id, saved.segments[0].audio.name).data; assert(audio.subarray(audio.indexOf(Buffer.from('data')) + 8).some(byte => byte !== 0));
  const mp4 = f.media.readAsset(saved.id, 'lecture.mp4'); assert(mp4.data.subarray(4, 8).toString('ascii') === 'ftyp'); assert.equal(video.video.audio_tracks, 1); assert.equal(video.video.video_tracks, 1); assert(Math.abs(video.video.duration_seconds - saved.duration_seconds) < .05);
  const boundary = saved.segments[1].start_seconds, samples = [saved.segments[0].duration_seconds / 2, boundary - .04, boundary + .04, boundary + saved.segments[1].duration_seconds / 2];
  const { stdout } = await exec('/usr/bin/swift', ['-module-cache-path', join(f.parent, 'inspection-modules'), inspect, join(f.cache, saved.id, 'lecture.mp4'), ...samples.map(String)], { timeout: 45000, maxBuffer: 32000, env: { PATH: '/usr/bin:/bin', HOME: f.parent, TMPDIR: f.parent } });
  const checked = JSON.parse(stdout); assert.equal(checked.audio_tracks, 1); assert.equal(checked.video_tracks, 1);
  for (const index of [0,1]) assert(checked.pixels[index][0] > 200 && checked.pixels[index][2] < 50);
  for (const index of [2,3]) assert(checked.pixels[index][2] > 200 && checked.pixels[index][0] < 50);
  t.diagnostic(JSON.stringify({ proof: 'actual_native_synthetic_media', voice: saved.voice, segments: saved.segments.map(row => ({ page: row.page, duration_seconds: row.duration_seconds, start_seconds: row.start_seconds, end_seconds: row.end_seconds })),
    video: { duration_seconds: video.video.duration_seconds, audio_duration_seconds: video.video.audio_duration_seconds, video_duration_seconds: video.video.video_duration_seconds, bytes: mp4.bytes, sha256: mp4.sha256, width: video.video.width, height: video.video.height },
    frame_sample_seconds: samples, frame_center_rgb: checked.pixels, no_user_data: true, audio_quality: 'subjective_review_not_claimed' }));
});
