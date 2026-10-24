import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createCalendar } from '../src/integrations/calendar.js';
import { createCrm } from '../src/integrations/hubspot.js';
import { createMessenger } from '../src/integrations/whatsapp.js';
import { getConfig } from '../src/config.js';
import { fakeFetch } from './helpers.js';

test('Google Calendar signs a valid service-account JWT and books in Dubai time', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = { client_email: 'layla@oxedge.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const config = getConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'), GOOGLE_CALENDAR_ID: 'team@oxedge.ae' });
  const fetch = fakeFetch([
    { status: 200, body: { access_token: 'tok', expires_in: 3600 } },
    { status: 200, body: { calendars: { 'team@oxedge.ae': { busy: [{ start: 'a', end: 'b' }] } } } },
    { status: 200, body: { id: 'evt1', htmlLink: 'https://calendar/evt1' } },
  ]);
  const calendar = createCalendar(config, { fetch });
  assert.equal(calendar.enabled, true);

  const busy = await calendar.busy(new Date('2026-10-26T00:00:00Z'), new Date('2026-11-02T00:00:00Z'));
  assert.deepEqual(busy, [{ start: 'a', end: 'b' }]);

  const assertion = new URLSearchParams(fetch.calls[0].body).get('assertion');
  const [h, c, sig] = assertion.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${c}`);
  assert.equal(verifier.verify(publicKey, sig, 'base64url'), true);
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, serviceAccount.client_email);

  const event = await calendar.book({ start: new Date('2026-10-26T06:00:00Z'), end: new Date('2026-10-26T06:30:00Z'), summary: 's', description: 'd' });
  assert.deepEqual(event, { id: 'evt1', link: 'https://calendar/evt1' });
  assert.match(fetch.calls[2].url, /calendars\/team%40oxedge\.ae\/events$/);
  assert.equal(JSON.parse(fetch.calls[2].body).start.timeZone, 'Asia/Dubai');
  assert.equal(fetch.calls.length, 3); // token reused, not fetched twice
});

test('HubSpot updates an existing contact found by phone, then attaches the note', async () => {
  const fetch = fakeFetch([
    { status: 200, body: { results: [{ id: '42' }] } },
    { status: 200, body: { id: '42' } },
    { status: 201, body: { id: 'note9' } },
  ]);
  const crm = createCrm(getConfig({ HUBSPOT_TOKEN: 'pat' }), { fetch });
  const contact = await crm.upsertLead({ phone: '+971501234567', name: 'Omar Al Haddad', company: 'Bayside', email: null });
  assert.deepEqual(contact, { id: '42', created: false });
  assert.equal(fetch.calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(fetch.calls[1].body).properties, { phone: '+971501234567', company: 'Bayside', firstname: 'Omar', lastname: 'Al Haddad' });

  await crm.addNote('42', '<p>hi</p>');
  const note = JSON.parse(fetch.calls[2].body);
  assert.equal(note.associations[0].to.id, '42');
  assert.equal(note.associations[0].types[0].associationTypeId, 202);
});

test('HubSpot creates a contact when the phone is new', async () => {
  const fetch = fakeFetch([{ status: 200, body: { results: [] } }, { status: 201, body: { id: '77' } }]);
  const crm = createCrm(getConfig({ HUBSPOT_TOKEN: 'pat' }), { fetch });
  assert.deepEqual(await crm.upsertLead({ phone: '+971501234567' }), { id: '77', created: true });
});

test('HubSpot errors name the service and status', async () => {
  const fetch = fakeFetch([{ status: 401, body: { message: 'bad token' } }]);
  const crm = createCrm(getConfig({ HUBSPOT_TOKEN: 'pat' }), { fetch });
  await assert.rejects(crm.upsertLead({ phone: '+1' }), /HubSpot POST .* failed \(401\)/);
});

test('WhatsApp sends the approved template in the caller language', async () => {
  const fetch = fakeFetch([{ status: 200, body: { messages: [{ id: 'wamid.1' }] } }]);
  const messenger = createMessenger(getConfig({
    WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE_EN: 'layla_recap', WHATSAPP_TEMPLATE_AR: 'layla_recap_ar',
  }), { fetch });
  const res = await messenger.sendRecap({ to: '+971 50 123 4567', language: 'ar', name: 'Sara Ali', bookingSentence: 'x' });
  assert.deepEqual(res, { id: 'wamid.1' });
  const body = JSON.parse(fetch.calls[0].body);
  assert.equal(body.to, '971501234567');
  assert.equal(body.template.name, 'layla_recap_ar');
  assert.equal(body.template.language.code, 'ar');
  assert.equal(body.template.components[0].parameters[0].text, 'Sara');
});

test('integrations without credentials report themselves as disabled', () => {
  const config = getConfig({});
  assert.equal(createCalendar(config).enabled, false);
  assert.equal(createCrm(config).enabled, false);
  assert.equal(createMessenger(config).enabled, false);
});
