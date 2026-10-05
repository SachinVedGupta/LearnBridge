// Trusted synthetic transport fixture: no real account, network or file reads.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createLeetCodeMcpServer, LEETCODE_ENDPOINT } from '../../apps/local-runtime/src/leetcode-mcp.mjs';
if (process.env.LEARNBRIDGE_TEST_SECRET_CANARY || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) process.exit(3);
const session = 'synthetic_session_for_leetcode_test';
const server = createLeetCodeMcpServer({ session, fetchImpl: async (url, options) => {
  if (url !== LEETCODE_ENDPOINT || options.redirect !== 'error') throw new Error('Fixture rejected an unexpected destination.');
  if (options.method === 'GET') return new Response('', { headers: { 'set-cookie': 'csrftoken=synthetic_csrf_for_leetcode_test; Path=/; Secure' } });
  if (options.headers.cookie !== 'csrftoken=synthetic_csrf_for_leetcode_test; LEETCODE_SESSION=synthetic_session_for_leetcode_test') throw new Error('Fixture rejected missing session initialization.');
  const { query, variables } = JSON.parse(options.body);
  let data;
  if (query.includes('LearnBridgeStatus')) data = { userStatus: { isSignedIn: true, username: 'synthetic_student' } };
  else if (query.includes('LearnBridgeSubmissions')) data = { submissionList: { hasNext: true, submissions: [{ id: '101', title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1791230400', statusDisplay: 'Wrong Answer', lang: 'python3', runtime: 'N/A', memory: 'N/A', isPending: 'Not Pending' }] } };
  else if (query.includes('LearnBridgeSubmission(')) data = { submissionDetails: { id: String(variables.id), code: 'return []', timestamp: '1791230400', statusCode: 11, user: { username: 'synthetic_student' }, question: { titleSlug: 'two-sum' }, lang: { name: 'python3' }, runtimeDisplay: 'N/A', memoryDisplay: 'N/A', totalCorrect: 2, totalTestcases: 5, lastTestcase: '[2,7,11,15]', expectedOutput: '[0,1]', codeOutput: '[]' } };
  else throw new Error('Unsupported fixture read.');
  return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
} });
serveStdio(() => server);
