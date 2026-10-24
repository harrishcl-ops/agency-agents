import { getConfig, loadDotEnv, requireConfig } from './config.js';
import { createHandlers } from './handlers.js';
import { createServer } from './server.js';
import { createCalendar } from './integrations/calendar.js';
import { createCrm } from './integrations/hubspot.js';
import { createMessenger } from './integrations/whatsapp.js';
import { createStore } from './integrations/store.js';

loadDotEnv();
const config = getConfig();
requireConfig(config, ['webhookSecret']);

const calendar = createCalendar(config);
const crm = createCrm(config);
const messenger = createMessenger(config);
const store = createStore(config);
const handlers = createHandlers({ config, calendar, crm, messenger, store });

const integrations = {
  googleCalendar: calendar.enabled,
  hubspot: crm.enabled,
  whatsapp: messenger.enabled,
};

createServer({ config, handlers, store, integrations }).listen(config.port, () => {
  console.log(`Layla webhook server listening on :${config.port}`);
  console.log(`Webhook URL for Vapi: ${config.publicUrl || 'http://localhost:' + config.port}/vapi/webhook`);
  for (const [name, on] of Object.entries(integrations)) {
    console.log(`  ${name.padEnd(15)} ${on ? 'connected' : 'not set (using local fallback)'}`);
  }
});
