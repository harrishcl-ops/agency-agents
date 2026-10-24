// Creates or updates Layla on Vapi, one assistant per language in LANGUAGES,
// and points the Vapi phone number at the inbound assistant.
//
//   npm run setup
import { readFileSync } from 'node:fs';
import { getConfig, loadDotEnv, requireConfig } from '../src/config.js';
import { buildAssistant } from '../src/assistant.js';
import { createVapi } from '../src/vapi.js';
import { readState, writeState } from './state.js';

// Show setup problems as one readable line instead of a stack trace.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(`\n${err?.message ?? err}`);
    process.exit(1);
  });
}

loadDotEnv();
const config = getConfig();
requireConfig(config, ['vapi.apiKey', 'publicUrl', 'webhookSecret']);
if (!config.publicUrl.startsWith('https://')) {
  throw new Error('PUBLIC_URL must be the https:// address where the webhook server is reachable (use ngrok for local testing).');
}

const knowledge = readFileSync(config.agent.knowledgeFile, 'utf8');
const todos = knowledge.split('\n').filter((line) => /\bTODO\b/.test(line)).length;
if (todos) {
  console.log(`Note: ${todos} TODO line(s) in ${config.agent.knowledgeFile} are left out of Layla's knowledge until you fill them in.`);
}
const vapi = createVapi({ apiKey: config.vapi.apiKey });
const state = readState();

for (const language of config.agent.languages) {
  const body = buildAssistant({ config, language, knowledge });
  const existingId = state.assistants[language];
  let assistant;
  if (existingId) {
    try {
      assistant = await vapi.updateAssistant(existingId, body);
      console.log(`Updated Layla (${language}): ${assistant.id}`);
    } catch (err) {
      if (!/\(404\)/.test(err.message)) throw err;
      console.log(`Saved assistant ${existingId} no longer exists on Vapi, creating a new one.`);
    }
  }
  if (!assistant) {
    assistant = await vapi.createAssistant(body);
    console.log(`Created Layla (${language}): ${assistant.id}`);
  }
  state.assistants[language] = assistant.id;
}
writeState(state);

if (config.vapi.phoneNumberId) {
  const inboundId = state.assistants[config.vapi.inboundLanguage] ?? Object.values(state.assistants)[0];
  await vapi.updatePhoneNumber(config.vapi.phoneNumberId, { assistantId: inboundId });
  console.log(`Inbound calls to your Vapi number now go to Layla (${config.vapi.inboundLanguage}).`);
} else {
  console.log('VAPI_PHONE_NUMBER_ID is not set, so no phone number was connected. You can still test from the Vapi dashboard.');
}

console.log('\nDone. Place a test call with:  npm run call -- +9715XXXXXXXX');
