import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupAdoptionClient } from '../apps/web/src/lib/adoption/client.mjs';
import { ADOPTION_CONSENT_VERSION, ADOPTION_FIELDS } from '../apps/web/src/lib/adoption/policy.mjs';
const consent = { consent_version: ADOPTION_CONSENT_VERSION, reviewed_fields: [...ADOPTION_FIELDS] };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('fresh opt-in drains its new observation after an older aborted generation settles without resending discarded observations', async () => {
  const calls = []; let finishOld;
  const client = createSetupAdoptionClient({ enabled: true, send: async (_url, options) => {
    calls.push({ event: JSON.parse(options.body).event, signal: options.signal });
    if (calls.length === 1) return await new Promise(resolve => { finishOld = resolve; });
    return { status: 202 };
  } });
  client.optIn(consent); client.observePageView(); client.observeCopySucceeded();
  assert.equal(client.status().queued, 2); client.optOut(); assert.equal(calls[0].signal.aborted, true);
  client.optIn(consent); client.observePageView(); assert.equal(client.status().queued, 1);
  finishOld({ status: 202 }); await settle(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].event.event_name, 'setup_page_view');
  assert.notEqual(calls[1].event.event_id, calls[0].event.event_id);
  assert.equal(client.status().queued, 0); assert.equal(client.status().accepted_observations, 1);
  assert.equal(calls.filter(call => call.event.event_name === 'setup_prompt_copy_succeeded').length, 0);
});

test('a later opt-out prevents generation recovery and unchanged-generation outages do not start background retries', async () => {
  const calls = []; let finish;
  const client = createSetupAdoptionClient({ enabled: true, send: async (_url, options) => {
    calls.push(options); return await new Promise(resolve => { finish = resolve; });
  } });
  client.optIn(consent); client.observePageView(); client.optOut(); client.optIn(consent); client.observePageView(); client.optOut();
  finish({ status: 202 }); await settle(); assert.equal(calls.length, 1); assert.equal(client.status().queued, 0);
  const unavailable = createSetupAdoptionClient({ enabled: true, send: async () => { calls.push('outage'); return { status: 503 }; } });
  unavailable.optIn(consent); unavailable.observePageView(); await settle(); await settle();
  assert.equal(calls.length, 2); assert.equal(unavailable.status().queued, 1); assert.equal(unavailable.status().accepted_observations, 0);
  unavailable.optOut();
});

test('optional event ID failure never throws or blocks the setup observer', () => {
  const client = createSetupAdoptionClient({ enabled: true, createId: () => { throw new Error('synthetic unsupported browser ID'); }, send: () => { throw new Error('network must not run'); } });
  client.optIn(consent); assert.equal(client.observePageView(), false); assert.equal(client.observeCopyFailed(), false);
  assert.equal(client.status().dropped_observations, 2); assert.equal(client.status().queued, 0);
});
