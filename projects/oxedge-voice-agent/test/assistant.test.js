import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAssistant, cleanKnowledge, outboundOverrides } from '../src/assistant.js';
import { testConfig } from './helpers.js';

const knowledge = readFileSync(new URL('../knowledge/oxedge.md', import.meta.url), 'utf8');

test('English assistant uses Claude, ElevenLabs, Deepgram and points at our webhook with the secret', () => {
  const a = buildAssistant({ config: testConfig(), language: 'en', knowledge });
  assert.equal(a.model.provider, 'anthropic');
  assert.equal(a.model.model, 'claude-haiku-5-5');
  assert.equal(a.voice.provider, '11labs');
  assert.equal(a.voice.language, 'en');
  assert.equal(a.transcriber.provider, 'deepgram');
  assert.equal(a.transcriber.language, 'en');
  assert.equal(a.server.url, 'https://layla.example.com/vapi/webhook');
  assert.equal(a.server.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(a.metadata, { language: 'en', app: 'oxedge-voice-agent' });
  assert.deepEqual(a.model.tools.map((t) => t.function?.name ?? t.type), ['check_availability', 'book_discovery_call', 'endCall']);
  assert.equal(a.analysisPlan.structuredDataPlan.enabled, true);
});

test('Arabic assistant listens and speaks Arabic', () => {
  const a = buildAssistant({ config: testConfig(), language: 'ar', knowledge });
  assert.equal(a.transcriber.language, 'ar');
  assert.equal(a.voice.language, 'ar');
  assert.match(a.firstMessage, /ليلى/);
  assert.match(a.model.messages[0].content, /Gulf Arabic/);
});

test('transfer tool is added only when a team number is set', () => {
  const config = testConfig();
  const withTransfer = buildAssistant({
    config: { ...config, agent: { ...config.agent, transferNumber: '+971500000001' } },
    language: 'en',
    knowledge,
  });
  const transfer = withTransfer.model.tools.find((t) => t.type === 'transferCall');
  assert.equal(transfer.destinations[0].number, '+971500000001');
  assert.match(withTransfer.model.messages[0].content, /transferCall tool/);
});

test('editor comments and TODO lines never reach the prompt', () => {
  const cleaned = cleanKnowledge(knowledge);
  assert.doesNotMatch(cleaned, /TODO|<!--/);
  assert.match(cleaned, /Mobile apps/);
  const a = buildAssistant({ config: testConfig(), language: 'en', knowledge });
  assert.doesNotMatch(a.model.messages[0].content, /TODO/);
});

test('outbound overrides switch the prompt into follow-up mode', () => {
  const o = outboundOverrides({ language: 'en', customerName: 'Omar', leadContext: 'Asked about a clinic website' });
  assert.equal(o.variableValues.direction, 'outbound');
  assert.equal(o.variableValues.customer_name, 'Omar');
  assert.match(o.variableValues.lead_context, /clinic website/);
  assert.match(o.firstMessage, /calling from Dubai/);
});

test('without PUBLIC_URL Layla runs in demo mode: no webhook, no booking tools', () => {
  const config = testConfig({ publicUrl: '' });
  const a = buildAssistant({ config, language: 'en', knowledge });
  assert.equal(a.server, undefined);
  assert.equal(a.serverMessages, undefined);
  assert.deepEqual(a.model.tools.map((t) => t.type), ['endCall']);
  assert.doesNotMatch(a.model.messages[0].content, /check_availability/);
  assert.match(a.model.messages[0].content, /confirm the exact time on WhatsApp/);
});

