const user = 'FixtureStudent';
export function leetcodeFixtureClient({ mode = 'private', count = 45 } = {}) {
  const calls = [], closed = []; let currentUser = user, signedIn = true, handler = null;
  const rows = Array.from({ length: count }, (_, i) => ({ id: String(10000 + i), title: i % 3 ? 'Two Sum' : 'Valid Parentheses', titleSlug: i % 3 ? 'two-sum' : 'valid-parentheses', statusDisplay: i % 2 ? 'Accepted' : 'Wrong Answer', lang: i % 4 ? 'python3' : 'java', timestamp: new Date(Date.UTC(2026, 9, 5, 0, 0, i)).toISOString() }));
  const clientFactory = ({ session }) => ({ async call(name, args) {
    calls.push({ name, args }); if (handler) { const result = await handler(name, args); if (result !== undefined) return result; }
    if (name === 'get_user_status') return { username: currentUser, isSignedIn: signedIn };
    if (name === 'get_user_profile') return { username: args.username, ranking: 900, acSubmissionNum: [{ difficulty: 'All', count: 2, submissions: 9 }], totalSubmissionNum: [{ difficulty: 'All', count: 2, submissions: count }] };
    if (name === 'get_user_contest_ranking') return { ranking: { rating: 1500, globalRanking: 100 }, history: [] };
    if (name === 'get_all_submissions') return { submissions: rows.slice(args.offset, args.offset + args.limit), hasNext: args.offset + args.limit < rows.length };
    if (name === 'get_recent_submissions') return { submissions: rows.slice(0, Math.min(20, args.limit)).map(({ id, ...row }) => row), hasNext: null };
    if (name === 'get_problem') return { titleSlug: args.titleSlug, title: 'Two Sum', content: '<p>Return two indices. &lt;tag&gt;</p><script>UNTRUSTED_SCRIPT_CANARY</script>', difficulty: 'Easy', topicTags: [{ name: 'Array' }, { name: 'Hash Table' }], codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution:\n    pass' }], exampleTestcases: '[2,7,11,15]\n9', isPaidOnly: false, hints: ['SPOILER_CANARY'] };
    if (name === 'get_problem_submission_report') { const row = rows.find(row => row.id === String(args.id)); return { id: row.id, username: currentUser, titleSlug: row.titleSlug, code: 'def two_sum(nums, target):\n    return [0, 1]', lang: 'python3', statusCode: 10, runtime: '20 ms', memory: '16 MB', totalCorrect: 63, totalTestcases: 63, timestamp: row.timestamp }; }
    throw new Error('Unexpected fixture tool');
  }, async close() { closed.push(session ? 'private' : 'public'); } });
  return { calls, closed, rows, clientFactory, switchUser: value => { currentUser = value; }, expire: () => { signedIn = false; }, handle: fn => { handler = fn; }, mode };
}
