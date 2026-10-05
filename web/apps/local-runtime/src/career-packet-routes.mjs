import { LearnBridgeError } from '@learnbridge/core';
import { createCareerPacketService } from './career-packet-service.mjs';

export async function handleCareerPacketRoute({ route, method, privateBody, store, session, publicJobService, careerPacketService, stillAuthorized, idempotencyKey }) {
  if (route !== '/career-packets' && !route.startsWith('/career-packets/')) return null;
  if (typeof session?.nonce !== 'string' || !session.nonce) throw new LearnBridgeError('AUTH_REQUIRED');
  const service = careerPacketService || createCareerPacketService({ store, publicJobService });
  const authorize = () => { if (stillAuthorized) stillAuthorized(); };
  if (route === '/career-packets/state') { if (method !== 'GET') throw new LearnBridgeError('INVALID_INPUT'); authorize(); return { status: 200, data: service.state() }; }
  if (route === '/career-packets') {
    if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT');
    const body = await privateBody(['role_ref', 'profile_refs', 'writing_refs', 'questions', 'requirements'], ['role_ref', 'profile_refs', 'writing_refs', 'questions'], 64000); authorize();
    return { status: 201, data: service.prepare(body, { idempotencyKey }) };
  }
  const matched = /^\/career-packets\/items\/([a-f0-9-]{36})(?:\/(review|export-markdown|export-json))?$/.exec(route); if (!matched) return null;
  if (!matched[2]) {
    if (method === 'GET') { authorize(); return { status: 200, data: service.get(matched[1]) }; }
    if (method !== 'DELETE') throw new LearnBridgeError('INVALID_INPUT');
    const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096); authorize();
    return { status: 200, data: service.forget(matched[1], body) };
  }
  if (method !== 'POST') throw new LearnBridgeError('INVALID_INPUT');
  const body = await privateBody(['expected_revision', 'payload_hash'], ['expected_revision', 'payload_hash'], 4096); authorize();
  return { status: 200, data: matched[2] === 'review' ? service.review(matched[1], body) : service.exportArtifact(matched[1], body, matched[2] === 'export-json' ? 'json' : 'markdown') };
}
