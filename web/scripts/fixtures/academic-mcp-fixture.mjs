// Synthetic protocol fixture only. It has no network, file, account or credential access.
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const runtimeRequire = createRequire(new URL('../../apps/local-runtime/package.json', import.meta.url));
const z = runtimeRequire('zod/v4');
const mode = process.argv[2] || 'normal';
if (!['normal', 'expired', 'oversized', 'slow'].includes(mode)) process.exit(2);
// The transport must not inherit arbitrary variables from its host process.
if (process.env.LEARNBRIDGE_TEST_SECRET_CANARY !== undefined) {
  process.stderr.write('Fixture received an unexpected host environment variable.\n');
  process.exit(3);
}
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const courseSchema = z.object({ orgUnitId: z.number().optional() }).strict();
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

// stdout is exclusively protocol framing; all source text below is invented.
serveStdio(() => {
  const server = new McpServer({ name: 'learnbridge-academic-synthetic-fixture', version: '1.0.0' });
  server.registerTool('get_assignments', { description: 'Synthetic selected-course assignments.', inputSchema: courseSchema, annotations }, async input => {
    if (input.orgUnitId !== 781264) return { ...json({ error: '403 unselected fixture course' }), isError: true };
    if (mode === 'expired') return { ...json({ error: '401 session expired: SYNTHETIC_ERROR_DO_NOT_EXPOSE' }), isError: true };
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 400));
    return json([{ id: 11, name: 'Fixture design exercise', dueDate: 'Mon, Oct 5, 2026, 11:59 PM',
      instructions: mode === 'oversized' ? 'x'.repeat(300_000) : 'Explain one design choice in your own words.', attachments: [], links: [] }]);
  });
  server.registerTool('get_announcements', { description: 'Synthetic course announcements.', inputSchema: courseSchema, annotations }, input => {
    if (input.orgUnitId !== 781264) return { ...json({ error: '403 unselected fixture course' }), isError: true };
    return json([{ id: 7, title: 'Fixture office hours', body: 'Bring your questions.', date: '2026-10-02T15:30:00Z', attachments: [] }]);
  });
  // These advertised tools deliberately exist to prove the adapter blocks them.
  // Even if called accidentally, their handlers have no side effects.
  server.registerTool('tasks_add', { description: 'Prohibited synthetic write.', inputSchema: z.object({ title: z.string() }).strict(), annotations: { readOnlyHint: false } }, () => ({ ...json({ error: 'PROHIBITED_FIXTURE_TOOL_CALLED' }), isError: true }));
  server.registerTool('read_file', { description: 'Prohibited synthetic path tool.', inputSchema: z.object({ filePath: z.string() }).strict(), annotations }, () => ({ ...json({ error: 'PROHIBITED_FIXTURE_TOOL_CALLED' }), isError: true }));
  server.registerTool('get_my_courses', { description: 'Prohibited unselected global course discovery.', inputSchema: z.object({}).strict(), annotations }, () => ({ ...json({ error: 'PROHIBITED_FIXTURE_TOOL_CALLED' }), isError: true }));
  return server;
});
