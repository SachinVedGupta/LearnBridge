import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { createLeetCodeReadProvider, LEETCODE_READ_TOOLS, LEETCODE_ENDPOINT, LEETCODE_LIMITS, LeetCodeError, validateLeetCodeArguments, validateLeetCodeSession } from '../apps/local-runtime/src/leetcode-mcp.mjs';
import { createLeetCodeClient } from '../apps/local-runtime/src/leetcode-client.mjs';

const session = 'synthetic_local_leetcode_session', csrf = 'synthetic_local_leetcode_csrf';
const json = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
const isCode = code => error => error instanceof LeetCodeError && error.code === code;
function fixture(respond, options = {}) {
  const calls = []; const provider = createLeetCodeReadProvider({ session, ...options, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return new Response('', { headers: { 'set-cookie': `csrftoken=${csrf}; Path=/; Secure` } });
    return respond(JSON.parse(options.body), options);
  } }); return { calls, provider };
}
test('only eight exact bounded read schemas are allowed before network activity', async () => {
  const { provider, calls } = fixture(() => json({}));
  assert.equal(LEETCODE_READ_TOOLS.length, 8);
  for (const tool of ['run_code', 'submit_solution', 'create_note', 'get_problem_solution', '__proto__']) await assert.rejects(provider.call(tool, {}), isCode('UNSUPPORTED'));
  for (const args of [{ username: 'student', url: 'https://unselected.test' }, { username: 'student', limit: 101 }, { username: 'student', limit: 1.5 }]) await assert.rejects(provider.call('get_recent_submissions', args), isCode('INVALID_INPUT'));
  assert.throws(() => validateLeetCodeArguments('get_all_submissions', { offset: 10001 }), isCode('INVALID_INPUT'));
  assert.throws(() => validateLeetCodeArguments('get_problem_submission_report', { id: -1 }), isCode('INVALID_INPUT'));
  for (const value of ['Cookie=arbitrary; x=1', 'value\r\nInjected: yes', 'x'.repeat(8193)]) assert.throws(() => validateLeetCodeSession(value), isCode('INVALID_INPUT'));
  assert.equal(calls.length, 0); provider.close();
});
test('no session blocks private operations without any network request', async () => {
  const { provider, calls } = fixture(() => json({}), { session: '' });
  for (const [name, args] of [['get_user_status', {}], ['get_all_submissions', {}], ['get_problem_submission_report', { id: 1 }]]) await assert.rejects(provider.call(name, args), isCode('AUTH_REQUIRED'));
  assert.equal(calls.length, 0);
});
test('identity read mirrors fixed-endpoint CSRF bootstrap and strips all other profile fields', async () => {
  const { provider, calls } = fixture(() => json({ userStatus: { isSignedIn: true, username: 'student', email: 'do-not-return@example.test', permissions: ['do-not-return'] } }));
  assert.deepEqual(await provider.call('get_user_status', {}), { isSignedIn: true, username: 'student' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(x => [x.url, x.options.method, x.options.redirect]), [[LEETCODE_ENDPOINT, 'GET', 'error'], [LEETCODE_ENDPOINT, 'POST', 'error']]);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].options.headers.cookie, `csrftoken=${csrf}; LEETCODE_SESSION=${session}`);
  assert.equal(calls[1].options.headers['x-csrftoken'], csrf);
  await provider.call('get_user_status', {}); assert.equal(calls.length, 3, 'CSRF bootstrap is not repeated for an active provider');
});
test('private history is one exact page with real hasNext and normalized timestamp/identity', async () => {
  const { provider, calls } = fixture(({ variables }) => { assert.deepEqual(variables, { offset: 20, limit: 1, slug: 'two-sum' }); return json({ submissionList: { hasNext: true, submissions: [{ id: '101', title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1791230400', statusDisplay: 'Wrong Answer', lang: 'python3', runtime: 'N/A', memory: 'N/A', isPending: 'Not Pending' }] } }); });
  const result = await provider.call('get_all_submissions', { offset: 20, limit: 1, questionSlug: 'two-sum' });
  assert.equal(result.submissions[0].id, '101'); assert.equal(result.submissions[0].timestamp, new Date(1791230400000).toISOString());
  assert.equal(result.submissions[0].runtime, 'N/A'); assert.equal(result.submissions[0].isPending, false); assert.equal(result.hasNext, true); assert.equal(result.coverage, 'private_page'); assert.equal(calls.length, 2);
});
test('public recent window does not invent IDs or full coverage and sends no session', async () => {
  const { provider, calls } = fixture(() => json({ recentSubmissionList: [{ title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1791230400', statusDisplay: 'Wrong Answer', lang: 'python3' }] }), { session: '' });
  const result = await provider.call('get_recent_submissions', { username: 'student', limit: 1 });
  assert.equal(result.submissions[0].id, null); assert.equal(result.hasNext, null); assert.equal(result.coverage, 'recent');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.cookie, undefined);
});
test('solved counts stay distinct from attempts and contest performance', async () => {
  const { provider } = fixture(({ query }) => query.includes('LearnBridgeProfile') ? json({ matchedUser: { username: 'student', profile: { ranking: 100 }, submitStats: { acSubmissionNum: [{ difficulty: 'All', count: 3, submissions: 5 }], totalSubmissionNum: [{ difficulty: 'All', count: 4, submissions: 12 }] } } })
    : json({ userContestRanking: { attendedContestsCount: 1, rating: 1234, globalRanking: 10, totalParticipants: 100, topPercentage: 10 }, userContestRankingHistory: [{ attended: true, problemsSolved: 2, totalProblems: 4, finishTimeInSeconds: 3600, rating: 1234, ranking: 10, contest: { title: 'Synthetic contest', startTime: 1791230400 } }, { attended: false, contest: { title: 'Not attended', startTime: 1791230400 } }] }));
  const profile = await provider.call('get_user_profile', { username: 'student' }); assert.equal(profile.acSubmissionNum[0].count, 3); assert.equal(profile.totalSubmissionNum[0].submissions, 12);
  const contest = await provider.call('get_user_contest_ranking', { username: 'student' }); assert.equal(contest.history.length, 1); assert.equal(contest.ranking.rating, 1234);
});
test('exact submission report retains student code and judge evidence and refuses a different ID', async () => {
  let wrong = false;
  const { provider } = fixture(() => json({ submissionDetails: { id: wrong ? '102' : '101', code: 'return []', timestamp: '1791230400', statusCode: 11, user: { username: 'student' }, question: { titleSlug: 'two-sum' }, lang: { name: 'python3' }, totalCorrect: 2, totalTestcases: 5, lastTestcase: '[2,7]', expectedOutput: '[0,1]', codeOutput: '[]', rawSecret: 'not-returned' } }));
  const report = await provider.call('get_problem_submission_report', { id: 101 }); assert.equal(report.id, '101'); assert.equal(report.code, 'return []'); assert.equal(report.totalCorrect, 2); assert.equal(report.rawSecret, undefined);
  wrong = true; await assert.rejects(provider.call('get_problem_submission_report', { id: 101 }), isCode('SCOPE_DENIED'));
});
test('problem and search return statement/starter metadata without hints or solutions', async () => {
  const { provider } = fixture(({ query, variables }) => query.includes('LearnBridgeProblem') ? json({ question: { questionId: '1', titleSlug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', content: '<p>Find two indices.</p>', topicTags: [{ name: 'Array', slug: 'array' }], codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution: pass' }], hints: ['do-not-return'], solution: { content: 'do-not-return' } } })
    : (assert.deepEqual(variables.filters, { tags: ['array'], difficulty: 'EASY' }), json({ problemsetQuestionList: { total: 1, questions: [{ title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy', acRate: 52, topicTags: [{ name: 'Array', slug: 'array' }] }] } })));
  const problem = await provider.call('get_problem', { titleSlug: 'two-sum' }); assert.equal(problem.hints, undefined); assert.equal(problem.solution, undefined); assert.equal(problem.codeSnippets[0].langSlug, 'python3');
  const search = await provider.call('search_problems', { tags: ['array'], difficulty: 'EASY' }); assert.equal(search.total, 1); assert.equal(search.questions[0].topicTags[0].slug, 'array');
});
test('expiry, security denial, HTML, redirects and provider error text never leak', async () => {
  for (const [response, code] of [[new Response('secret provider text', { status: 401 }), 'AUTH_EXPIRED'], [new Response('Cloudflare secret text', { status: 403 }), 'SCOPE_DENIED'], [new Response('secret provider text', { status: 429 }), 'RATE_LIMITED'], [new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }), 'PROVIDER_FAILURE'], [new Response(JSON.stringify({ errors: [{ message: session }] }), { headers: { 'content-type': 'application/json' } }), 'PROVIDER_FAILURE']]) {
    const { provider } = fixture(() => response); await assert.rejects(provider.call('get_user_status', {}), error => isCode(code)(error) && !error.message.includes('secret') && !error.message.includes(session));
  }
  const { provider } = fixture(() => { const response = json({ userStatus: { isSignedIn: true, username: 'student' } }); Object.defineProperty(response, 'url', { value: 'https://unselected.test/graphql/' }); return response; });
  await assert.rejects(provider.call('get_user_status', {}), isCode('SCOPE_DENIED'));
});
test('response/header/code bounds and missing pagination/status fail closed', async () => {
  const { provider } = fixture(() => new Response('x'.repeat(LEETCODE_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(provider.call('get_user_status', {}), isCode('BUDGET_EXCEEDED'));
  const missing = fixture(() => json({ submissionList: { submissions: [] } })).provider; await assert.rejects(missing.call('get_all_submissions', {}), isCode('PROVIDER_FAILURE'));
  const signedOut = fixture(() => json({ userStatus: { isSignedIn: false, username: null } })).provider; await assert.rejects(signedOut.call('get_user_status', {}), isCode('AUTH_EXPIRED'));
  const badCode = fixture(() => json({ submissionDetails: { id: '1', code: 'x'.repeat(64001), timestamp: '1791230400', statusCode: 11, user: { username: 'student' }, question: { titleSlug: 'two-sum' }, lang: { name: 'python3' } } })).provider; await assert.rejects(badCode.call('get_problem_submission_report', { id: 1 }), isCode('BUDGET_EXCEEDED'));
});
test('timeout, cancellation and close bound an uncooperative synthetic provider', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { provider } = fixture(async () => { await sleep(80); return json({ userStatus: { isSignedIn: true, username: 'student' } }); }, { timeoutMs: 15 });
  await assert.rejects(provider.call('get_user_status', {}), isCode('TIMEOUT'));
  const second = fixture(async () => { await sleep(80); return json({ userStatus: { isSignedIn: true, username: 'student' } }); }).provider;
  const controller = new AbortController(), pending = second.call('get_user_status', {}, { signal: controller.signal }); setTimeout(() => controller.abort(), 10); await assert.rejects(pending, isCode('CANCELLED'));
  const third = fixture(async () => { await sleep(80); return json({ userStatus: { isSignedIn: true, username: 'student' } }); }).provider;
  const reading = third.call('get_user_status', {}); setTimeout(() => third.close(), 10); await assert.rejects(reading, isCode('OFFLINE')); await assert.rejects(third.call('get_user_status', {}), isCode('OFFLINE'));
});
async function connected(t, path) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(path)], env: { PATH: '/usr/bin:/bin' }, stderr: 'pipe', maxBufferSize: 300000 });
  const client = new Client({ name: 'learnbridge-leetcode-protocol-test', version: '1.0.0' }, { capabilities: {} }); let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await client.connect(transport, { timeout: 5000 }); const pid = transport.pid;
  t.after(async () => { await client.close(); assert.equal(diagnostics, ''); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); });
  return client;
}
test('actual bundled stdio inventory contains only reads and denies every write without network', async t => {
  const client = await connected(t, new URL('../apps/local-runtime/src/leetcode-mcp.mjs', import.meta.url));
  const tools = (await client.listTools()).tools; assert.deepEqual(tools.map(tool => tool.name).sort(), [...LEETCODE_READ_TOOLS].sort()); assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true));
  const status = await client.callTool({ name: 'get_user_status', arguments: {} }); assert.equal(status.isError, true); assert.equal(JSON.parse(status.content[0].text).error.code, 'AUTH_REQUIRED');
  for (const name of ['run_code', 'submit_solution', 'create_note', 'get_problem_solution']) await assert.rejects(client.callTool({ name, arguments: {} }));
});
test('synthetic reads travel through real official MCP stdio and private report transport', async t => {
  for (const key of ['OPENAI_API_KEY', 'LEETCODE_SESSION', 'LEARNBRIDGE_LEETCODE_SESSION', 'NODE_OPTIONS', 'LEARNBRIDGE_TEST_SECRET_CANARY']) assert.equal(Object.hasOwn(getDefaultEnvironment(), key), false, `SDK's default environment excludes ${key}`);
  const previous = process.env.LEARNBRIDGE_TEST_SECRET_CANARY; process.env.LEARNBRIDGE_TEST_SECRET_CANARY = 'host-only-canary';
  t.after(() => { if (previous === undefined) delete process.env.LEARNBRIDGE_TEST_SECRET_CANARY; else process.env.LEARNBRIDGE_TEST_SECRET_CANARY = previous; });
  const client = await connected(t, new URL('./fixtures/leetcode-mcp-fixture.mjs', import.meta.url));
  const status = JSON.parse((await client.callTool({ name: 'get_user_status', arguments: {} })).content[0].text); assert.equal(status.username, 'synthetic_student');
  const page = JSON.parse((await client.callTool({ name: 'get_all_submissions', arguments: { offset: 0, limit: 1 } })).content[0].text); assert.equal(page.submissions[0].id, '101'); assert.equal(page.hasNext, true);
  const report = JSON.parse((await client.callTool({ name: 'get_problem_submission_report', arguments: { id: 101 } })).content[0].text); assert.equal(report.code, 'return []'); assert.equal(report.totalTestcases, 5);
});
test('production client starts only bundled read-only child and rejects malformed input before connecting', async () => {
  const client = createLeetCodeClient();
  await assert.rejects(client.call('submit_solution', {}), isCode('UNSUPPORTED'));
  await assert.rejects(client.call('get_user_profile', { username: 'student', command: 'unselected' }), isCode('INVALID_INPUT'));
  await assert.rejects(client.call('get_user_status', {}), isCode('AUTH_REQUIRED'));
  await client.close(); await assert.rejects(client.call('get_user_status', {}), isCode('OFFLINE'));
});
