import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../src/handlers.js';
import { createMemoryCalendar } from '../src/integrations/calendar.js';
import { testConfig, silentLog, MONDAY_8AM_DUBAI } from './helpers.js';

function setup({ crmEnabled = true, messengerEnabled = true } = {}) {
  const calendar = createMemoryCalendar();
  const stored = [];
  const crmCalls = [];
  const sent = [];
  const handlers = createHandlers({
    config: testConfig(),
    calendar,
    crm: {
      enabled: crmEnabled,
      async upsertLead(lead) { crmCalls.push(['upsert', lead]); return { id: 'c1' }; },
      async addNote(id, html) { crmCalls.push(['note', id, html]); return { id: 'n1' }; },
    },
    messenger: { enabled: messengerEnabled, async sendRecap(m) { sent.push(m); return { id: 'w1' }; } },
    store: { async append(r) { stored.push(r); } },
    now: () => MONDAY_8AM_DUBAI,
    log: silentLog,
  });
  return { handlers, calendar, stored, crmCalls, sent };
}

const toolCall = (name, args, id = 't1') => ({ id, type: 'function', function: { name, arguments: args } });

test('check_availability returns slots as a flat string', async () => {
  const { handlers } = setup();
  const res = await handlers.onToolCalls({ type: 'tool-calls', call: { id: 'call1' }, toolCallList: [toolCall('check_availability', {})] });
  assert.equal(res.results[0].toolCallId, 't1');
  assert.equal(typeof res.results[0].result, 'string');
  const parsed = JSON.parse(res.results[0].result);
  assert.equal(parsed.slots.length, 3);
});

test('booking a slot creates an event, and the same slot cannot be booked twice', async () => {
  const { handlers, calendar } = setup();
  const msg = (id) => ({
    type: 'tool-calls',
    call: { id },
    customer: { number: '+971501234567' },
    toolCallList: [toolCall('book_discovery_call', JSON.stringify({ start: '2026-10-26T06:00:00.000Z', name: 'Omar', company: 'Bayside Dental' }))],
  });
  const first = await handlers.onToolCalls(msg('call1'));
  assert.match(first.results[0].result, /Booked for Monday/);
  assert.equal(calendar.events.length, 1);
  assert.match(calendar.events[0].summary, /Omar \(Bayside Dental\)/);
  assert.match(calendar.events[0].description, /\+971501234567/);

  const second = await handlers.onToolCalls(msg('call2'));
  assert.ok(second.results[0].error);
  assert.equal(second.results[0].result, undefined);
  assert.equal(calendar.events.length, 1);
});

test('invalid booking input and unknown tools come back as errors, not exceptions', async () => {
  const { handlers } = setup();
  const res = await handlers.onToolCalls({
    type: 'tool-calls',
    call: { id: 'call1' },
    toolCallList: [toolCall('book_discovery_call', { name: 'Omar' }, 'a'), toolCall('do_magic', {}, 'b')],
  });
  assert.match(res.results[0].error, /invalid start/i);
  assert.match(res.results[1].error, /Unknown tool/);
});

test('a calendar outage is reported to Layla as a tool error', async () => {
  const { handlers, calendar } = setup();
  calendar.book = async () => { throw new Error('Google down'); };
  const res = await handlers.onToolCalls({
    type: 'tool-calls',
    call: { id: 'call1' },
    toolCallList: [toolCall('book_discovery_call', { start: '2026-10-26T06:00:00.000Z', name: 'Omar' })],
  });
  assert.match(res.results[0].error, /callback/);
});

function endOfCall(overrides = {}) {
  return {
    type: 'end-of-call-report',
    endedReason: 'customer-ended-call',
    call: { id: 'call1', type: 'inboundPhoneCall' },
    customer: { number: '+971501234567' },
    assistant: { metadata: { language: 'en' } },
    startedAt: '2026-10-26T04:00:00Z',
    endedAt: '2026-10-26T04:02:30Z',
    analysis: {
      summary: 'Omar from Bayside Dental wants a booking website <3 branches>.',
      structuredData: { name: 'Omar Haddad', company: 'Bayside Dental', need: 'Clinic website', budget: 'AED 30-50k', lead_quality: 'hot' },
    },
    artifact: { transcript: 'AI: Hi\nUser: Hello', recordingUrl: 'https://rec.example/1.wav' },
    ...overrides,
  };
}

test('end of call stores the lead, logs it in the CRM and sends the WhatsApp recap with the booking', async () => {
  const { handlers, stored, crmCalls, sent } = setup();
  await handlers.onToolCalls({
    type: 'tool-calls',
    call: { id: 'call1' },
    toolCallList: [toolCall('book_discovery_call', { start: '2026-10-26T06:00:00.000Z', name: 'Omar' })],
  });
  const lead = await handlers.onEndOfCall(endOfCall());

  assert.equal(stored.length, 1);
  assert.equal(stored[0].phone, '+971501234567');
  assert.equal(stored[0].durationSeconds, 150);
  assert.match(stored[0].booking, /Monday/);
  assert.equal(lead.crmContactId, 'c1');

  assert.deepEqual(crmCalls[0], ['upsert', { phone: '+971501234567', name: 'Omar Haddad', company: 'Bayside Dental', email: null }]);
  const noteHtml = crmCalls[1][2];
  assert.match(noteHtml, /&lt;3 branches&gt;/); // escaped
  assert.match(noteHtml, /Discovery call:<\/strong> Monday/);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+971501234567');
  assert.match(sent[0].bookingSentence, /Your discovery call is booked for Monday/);
});

test('end of call is processed once even if Vapi retries it', async () => {
  const { handlers, stored } = setup();
  await handlers.onEndOfCall(endOfCall());
  const again = await handlers.onEndOfCall(endOfCall());
  assert.equal(again, null);
  assert.equal(stored.length, 1);
});

test('no WhatsApp when the caller declined it or hung up straight away', async () => {
  const declined = setup();
  await declined.handlers.onEndOfCall(endOfCall({ analysis: { summary: '', structuredData: { whatsapp_ok: false } } }));
  assert.equal(declined.sent.length, 0);

  const short = setup();
  await short.handlers.onEndOfCall(endOfCall({ endedAt: '2026-10-26T04:00:05Z' }));
  assert.equal(short.sent.length, 0);
});

test('Arabic calls get the Arabic recap sentence', async () => {
  const { handlers, sent } = setup();
  await handlers.onEndOfCall(endOfCall({ assistant: { metadata: { language: 'ar' } } }));
  assert.equal(sent[0].language, 'ar');
  assert.match(sent[0].bookingSentence, /فريقنا/);
});

test('a CRM failure does not stop the lead being saved or the recap being sent', async () => {
  const ctx = setup();
  const handlers = createHandlers({
    config: testConfig(),
    calendar: createMemoryCalendar(),
    crm: { enabled: true, async upsertLead() { throw new Error('HubSpot 500'); }, async addNote() {} },
    messenger: { enabled: true, async sendRecap(m) { ctx.sent.push(m); } },
    store: { async append(r) { ctx.stored.push(r); } },
    now: () => MONDAY_8AM_DUBAI,
    log: silentLog,
  });
  await handlers.onEndOfCall(endOfCall());
  assert.equal(ctx.stored.length, 1);
  assert.equal(ctx.sent.length, 1);
});

test('Arabic recap shows the booked time in Arabic', async () => {
  const { handlers, sent } = setup();
  await handlers.onToolCalls({
    type: 'tool-calls',
    call: { id: 'call1' },
    toolCallList: [toolCall('book_discovery_call', { start: '2026-10-26T06:00:00.000Z', name: 'Sara' })],
  });
  await handlers.onEndOfCall(endOfCall({ assistant: { metadata: { language: 'ar' } } }));
  assert.match(sent[0].bookingSentence, /^موعد مكالمتك الاستشارية: .*الاثنين/);
});
