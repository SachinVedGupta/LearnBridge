// Synthetic source/AI/media shapes. This fixture does not authenticate or call providers.
export const lectureFixtureHash = 'a'.repeat(64);
export function makeLectureFixture({ audio = 'ready', generation = 'accepted' } = {}) {
  const hash = lectureFixtureHash;
  return { item: { id: 'lecture-1', revision: 1, title: 'Recursion, explained', created_at: '2026-10-05T12:00:00Z', data: { pages: [1, 2, 3] } }, lecture_hash: hash, pack_hash: 'b'.repeat(64), context_document: { id: 'lecture-note', revision: 1, sha256: hash }, generation: { state: generation, progress: [] }, audio: { state: audio, manifest: audio === 'ready' ? { id: 'audio-1', voice: 'Samantha', rate: 170, duration_seconds: 56.25 } : null }, export: { state: 'none' }, clarifications: [], progress: { chapter_index: 0, position_seconds: 0, state: 'paused', completed_chapter_ids: [], attempts: [], answered_quiz_ids: [] }, chapters: [
    { id: 'p1', physical_page: 1, title: 'Why recursion works', narration: 'A recursive function solves a small part of a problem, then asks the same function to solve a smaller instance. Imagine a stack of boxes: opening one box reveals a smaller one. Every call needs a path toward stopping.', example: 'Count down from three until zero.', takeaway: 'Reduce the problem with each call.', citation: { physical_page: 1 }, quiz: null },
    { id: 'p2', physical_page: 2, title: 'The base case', narration: 'The base case tells the function when it can answer immediately. If the base case is missing, calls can continue until the stack is exhausted. In a countdown, zero is the base case and subtracting one is the recursive step.', example: 'countdown(0) returns immediately.', takeaway: 'A stopping rule and a smaller input work together.', citation: { physical_page: 2 }, quiz: { id: 'q2', question: 'Why does a base case alone not guarantee that a recursive function stops?', citation: { physical_page: 2 } } },
    { id: 'p3', physical_page: 3, title: 'Follow the calls', narration: 'Trace one small input instead of guessing what the function does. Write down the input for each call, stop at the base case, and then work back through the return values. This makes the order of computation visible.', example: 'Trace three calls and the returns.', takeaway: 'Small traces expose the order of the calls.', citation: { physical_page: 3 }, quiz: null },
  ] };
}
export function createLectureFixtureTransport(options = {}) {
  const fixture = options.view || makeLectureFixture(), calls = [], grants = options.grants || [], clone = value => structuredClone(value);
  const summary = () => ({ id: fixture.item.id, title: fixture.item.title, created_at: fixture.item.created_at, revision: fixture.item.revision, generation: fixture.generation, stale: false });
  async function request(path, extra = {}) {
    calls.push({ path, ...clone(extra) }); const override = options.handle?.(path, extra); if (override !== undefined) return await override;
    if (/^\/course-studio\/sessions\/[^/]+\/lectures$/.test(path)) {
      if (extra.method === 'POST') { fixture.item.data.pages = extra.body.pages; fixture.item.title = extra.body.title; fixture.generation.state = 'draft'; fixture.chapters = []; fixture.audio = { state: 'none', manifest: null }; return { item: clone(fixture) }; }
      return { items: [summary()], capability: { state: 'available' } };
    }
    if (path === '/lectures/capability') return { state: 'available', voices: ['Samantha'], private_audio: true };
    if (path === '/agent-grants') { if (extra.method === 'POST') { const grant = { id: `grant-${grants.length + 1}`, destination: 'codex', state: 'active', expires_at: new Date(Date.now() + 600000).toISOString(), pins: { tasks: [], source_entries: [], documents: clone(extra.body.expected_records.documents) } }; grants.push(grant); return { item: clone(grant) }; } return { items: clone(grants) }; }
    if (path === '/lectures/lecture-1') return clone(fixture);
    if (path === '/lectures/lecture-1/review-preview') return { lecture_revision: fixture.item.revision, output_sha256: 'c'.repeat(64), pack_hash: fixture.pack_hash, chapters: fixture.chapters.map(row => ({ ...clone(row), ...(row.quiz ? { quiz: { ...clone(row.quiz), reference_answer: 'The input must reach the base case.', explanation: 'Each call has to move toward a stopping input.' } } : {}) })) };
    const media = /^\/lectures\/lecture-1\/chapters\/(p\d)\/(asset|audio)$/.exec(path);
    if (media) { if (media[2] === 'asset') return { asset: { physical_page: Number(media[1].slice(1)), png_base64: 'SYNTHETIC_RENDERED_SLIDE' } }; return new Blob(['SYNTHETIC_MEDIA_TRANSPORT'], { type: 'audio/wav' }); }
    if (path === '/lectures/lecture-1/video') return new Blob(['SYNTHETIC_MP4_TRANSPORT'], { type: 'video/mp4' });
    const mutation = /^\/lectures\/lecture-1\/([^/]+)$/.exec(path);
    if (mutation && extra.method === 'POST') {
      if (extra.body.expected_revision !== fixture.item.revision || extra.body.lecture_hash !== fixture.lecture_hash) throw new Error('Exact lecture revision required');
      if (mutation[1] === 'preview-run') return { prompt: 'EXACT SYNTHETIC LECTURE PROMPT', prompt_sha256: lectureFixtureHash };
      if (mutation[1] === 'clarification-preview') return { prompt: `EXACT QUESTION ON ${extra.body.chapter_id}: ${extra.body.question}`, prompt_sha256: lectureFixtureHash };
      fixture.item.revision++;
      if (mutation[1] === 'run') fixture.generation = { state: 'running', host_turn_id: 'fixture-turn', progress: [] };
      if (mutation[1] === 'accept') fixture.generation.state = 'accepted';
      if (mutation[1] === 'audio') fixture.audio.state = 'running';
      if (mutation[1] === 'export-video') fixture.export.state = 'running';
      if (mutation[1] === 'remove-media') { fixture.audio = { state: 'none', manifest: null }; fixture.export = { state: 'none', descriptor: null }; }
      if (mutation[1] === 'cancel') { if (fixture.generation.state === 'running') fixture.generation.state = 'failed'; if (fixture.audio.state === 'running') fixture.audio.state = 'failed'; if (fixture.export.state === 'running') fixture.export.state = 'failed'; }
      if (mutation[1] === 'progress') fixture.progress = { ...fixture.progress, chapter_index: extra.body.chapter_index, position_seconds: extra.body.position_seconds, state: extra.body.state, completed_chapter_ids: extra.body.completed_chapter_ids };
      if (mutation[1] === 'answer') { const attempt = { id: 'attempt-1', quiz_id: extra.body.quiz_id, response: extra.body.response, assessment: 'unassessed', mastery_claim: false }; fixture.progress.attempts.push(attempt); fixture.progress.answered_quiz_ids.push(extra.body.quiz_id); return { item: clone(fixture), attempt, reference_answer: 'Each call must approach the base case.', explanation: 'The base case only stops inputs that actually reach it.' }; }
      if (mutation[1] === 'clarifications') fixture.clarifications.push({ id: 'clarify-1', chapter_id: extra.body.chapter_id, question: extra.body.question, state: 'running', text: '', progress: [], host_turn_id: 'fixture-clarify-turn' });
      return { item: clone(fixture) };
    }
    throw new Error(`Unknown synthetic lecture route: ${path}`);
  }
  return { fixture, calls, grants, request };
}
