import { LearnBridgeError } from '@learnbridge/core';
import { createPublicJobService } from './public-job-service.mjs';

/** Paired student authority; no MCP/source grant can initiate public scans. */
export async function handlePublicJobRoute({ route, method, privateBody, store, session, publicJobService, stillAuthorized }) {
  if (!route.startsWith('/public-jobs/')) return null;
  if (!session?.nonce || typeof session.nonce !== 'string') throw new LearnBridgeError('AUTH_REQUIRED');
  const service = publicJobService || createPublicJobService({ store });
  const authorize = () => { if (stillAuthorized) stillAuthorized(); return true; };
  if (route === '/public-jobs/state') { if (method !== 'GET') throw new LearnBridgeError('INVALID_INPUT'); authorize(); return { status: 200, data: service.state() }; }
  if (route === '/public-jobs/search' || route === '/public-jobs/read') {
    if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT');
    const fields = route.endsWith('/read') ? ['provider', 'board_slug', 'job_id'] : ['provider', 'board_slug'];
    const body = await privateBody(fields, fields, 4096); authorize();
    const data = await (route.endsWith('/read') ? service.read(body, { authorize }) : service.search(body, { authorize })); authorize();
    return { status: 200, data };
  }
  const match = /^\/public-jobs\/roles\/([a-f0-9-]{36})(?:\/(shortlist))?$/.exec(route);
  if (!match) return null;
  if (!match[2]) { if (method !== 'GET') throw new LearnBridgeError('INVALID_INPUT'); authorize(); return { status: 200, data: service.get(match[1]) }; }
  if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT');
  const body = await privateBody(['expected_revision', 'state', 'note'], ['expected_revision', 'state'], 4096); authorize(); return { status: 200, data: service.shortlist(match[1], body) };
}
