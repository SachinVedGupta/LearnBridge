import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic native-process protocol seam; never proves actual speech/video.
const mode = process.argv[2], kind = process.argv[3], args = process.argv.slice(4);
if (mode === 'slow') { setTimeout(() => {}, 30000); }
else if (mode === 'fail') { process.stderr.write('SYNTHETIC_PRIVATE_TEXT_CANARY /private/path'); process.exitCode = 1; }
else if (mode === 'oversized') { process.stdout.write('x'.repeat(17000)); }
else if (kind === 'say') {
  const output = args[args.indexOf('-o') + 1], script = readFileSync(args[args.indexOf('-f') + 1], 'utf8');
  if (!script || args.includes(script)) process.exit(1);
  const dataLength = mode === 'long' ? 44100 * 301 : 44100, data = Buffer.alloc(44 + dataLength);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(dataLength, 40); data.fill(1, 44);
  if (mode === 'silence') data.fill(0, 44); if (mode === 'corrupt') data.writeUInt16LE(3, 20); writeFileSync(output, data, { mode: 0o600 });
} else if (kind === 'swift') {
  let text = ''; for await (const part of process.stdin) text += part; const input = JSON.parse(text), duration = input.segments.reduce((total, row) => total + row.duration_seconds, 0);
  writeFileSync(join(input.directory, 'lecture.mp4'), Buffer.from('SYNTHETIC_MP4_NOT_ACTUAL_VIDEO'), { mode: 0o600 });
  writeFileSync(join(input.directory, 'video-only.mp4'), Buffer.from('synthetic silent intermediate'), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: 'available', duration_seconds: duration, audio_duration_seconds: duration,
    video_duration_seconds: mode === 'desync' ? duration + 1 : duration, width: 1280, height: 720, audio_tracks: 1, video_tracks: 1, renderer_version: 'macos_avfoundation_lecture.v1' }));
}
