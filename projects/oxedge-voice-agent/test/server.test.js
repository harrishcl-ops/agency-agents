import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, isAuthorized } from '../src/server.js';
import { testConfig, silentLog } from './helpers.js';

let server;
let base;
const seen = [];

before(async () => {
  const handlers = {
    async onToolCalls(message) {
      seen.push(message.type);
      return { results: [{ toolCallId: 'x', result: 'ok' }] };
    },
    async onEndOfCall(message) {
      seen.push(message.type);
      return { callId: 'c1', phone: '+971500000000' };
    },
  };
  const store = { async recent() { return [{ callId: 'c1' }]; } };
  server = createServer({ config: testConfig(), handlers, store, integrations: { hubspot: false }, log: silentLog });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (body, headers = {}) =>
  fetch(`${base}/vapi/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

test('health check is public', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, integrations: { hubspot: false } });
});

test('webhook rejects requests without the secret', async () => {
  const res = await post(JSON.stringify({ message: { type: 'tool-calls' } }));
  assert.equal(res.status, 401);
  const wrong = await post(JSON.stringify({ message: { type: 'tool-calls' } }), { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
});

test('webhook routes tool calls and returns the results body', async () => {
  const res = await post(JSON.stringify({ message: { type: 'tool-calls', toolCallList: [] } }), { Authorization: 'Bearer test-secret' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: [{ toolCallId: 'x', result: 'ok' }] });
});

test('webhook accepts the x-vapi-secret header and acknowledges end-of-call reports', async () => {
  const res = await post(JSON.stringify({ message: { type: 'end-of-call-report' } }), { 'x-vapi-secret': 'test-secret' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  assert.ok(seen.includes('end-of-call-report'));
});

test('other Vapi events are acknowledged, bad JSON is a 400', async () => {
  const ok = await post(JSON.stringify({ message: { type: 'status-update' } }), { Authorization: 'Bearer test-secret' });
  assert.equal(ok.status, 200);
  const bad = await post('{not json', { Authorization: 'Bearer test-secret' });
  assert.equal(bad.status, 400);
});

test('leads endpoint needs the secret', async () => {
  assert.equal((await fetch(`${base}/leads`)).status, 401);
  const res = await fetch(`${base}/leads`, { headers: { Authorization: 'Bearer test-secret' } });
  assert.deepEqual(await res.json(), { leads: [{ callId: 'c1' }] });
});

test('isAuthorized refuses everything when no secret is configured', () => {
  assert.equal(isAuthorized({ authorization: 'Bearer ' }, ''), false);
});
