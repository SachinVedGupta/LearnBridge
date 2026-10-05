import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LeetCodeError, LEETCODE_LIMITS, validateLeetCodeArguments, validateLeetCodeSession } from './leetcode-mcp.mjs';

const bundledScript = fileURLToPath(new URL('./leetcode-mcp.mjs', import.meta.url));
/** Fixed bundled read-only child. No shell, download, configurable script/URL,
 * credential argument, inherited provider key or diagnostic logging. */
export function createLeetCodeClient({ session = '' } = {}) {
  session = validateLeetCodeSession(session);
  let client = null, transport = null, starting = null, ended = false, busy = false;
  async function ready(signal) {
    if (ended) throw new LeetCodeError('OFFLINE');
    if (!starting) starting = (async () => {
      const env = { PATH: '/usr/bin:/bin', LEARNBRIDGE_LEETCODE_SESSION: session }; session = '';
      transport = new StdioClientTransport({ command: process.execPath, args: [bundledScript], env, stderr: 'ignore', maxBufferSize: LEETCODE_LIMITS.responseBytes + 16000 });
      client = new Client({ name: 'learnbridge-leetcode-local-client', version: '1.0.0' }, { capabilities: {} });
      try { await client.connect(transport, { timeout: 5000, signal }); }
      finally { delete env.LEARNBRIDGE_LEETCODE_SESSION; }
    })().catch(async () => { await close(); throw new LeetCodeError(signal?.aborted ? 'CANCELLED' : 'OFFLINE'); });
    await starting;
  }
  async function close() { ended = true; session = ''; try { await client?.close(); } catch {} try { await transport?.close(); } catch {} }
  return {
    async call(name, args = {}, { signal } = {}) {
      const input = validateLeetCodeArguments(name, args); if (signal?.aborted) throw new LeetCodeError('CANCELLED');
      if (busy) throw new LeetCodeError('SCOPE_DENIED'); busy = true;
      try {
        await ready(signal);
        const result = await client.callTool({ name, arguments: input }, { signal, timeout: LEETCODE_LIMITS.requestTimeoutMs + 1000 });
        if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') throw new LeetCodeError('PROVIDER_FAILURE');
        const raw = result.content[0].text; if (Buffer.byteLength(raw) > LEETCODE_LIMITS.responseBytes) throw new LeetCodeError('BUDGET_EXCEEDED');
        const value = JSON.parse(raw); if (result.isError || value?.error) throw new LeetCodeError(value?.error?.code || 'PROVIDER_FAILURE'); return value;
      } catch (error) {
        if (error instanceof LeetCodeError) throw error;
        if (signal?.aborted) throw new LeetCodeError('CANCELLED'); throw new LeetCodeError('PROVIDER_FAILURE');
      } finally { busy = false; }
    }, close,
  };
}
