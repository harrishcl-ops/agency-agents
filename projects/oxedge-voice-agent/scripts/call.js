// Has Layla call a phone number.
//
//   npm run call -- +9715XXXXXXXX
//   npm run call -- +9715XXXXXXXX --lang ar --name "Omar" --context "Asked about a clinic booking website"
//
// UAE telemarketing rules only allow marketing calls between 9am and 6pm Dubai time,
// so this refuses to dial outside those hours unless you pass --force (e.g. testing on your own phone).
import { getConfig, loadDotEnv, requireConfig } from '../src/config.js';
import { outboundOverrides } from '../src/assistant.js';
import { createVapi } from '../src/vapi.js';
import { readState } from './state.js';

// Show setup problems as one readable line instead of a stack trace.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(`\n${err?.message ?? err}`);
    process.exit(1);
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function dubaiHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

const args = parseArgs(process.argv.slice(2));
const number = args._[0];
if (!number || !/^\+\d{8,15}$/.test(number)) {
  console.error('Usage: npm run call -- +9715XXXXXXXX [--lang en|ar] [--name "Name"] [--context "What they asked about"] [--force]');
  process.exit(1);
}

const hour = dubaiHour();
if ((hour < 9 || hour >= 18) && !args.force) {
  console.error(`It's ${hour}:00 in Dubai. Marketing calls are only allowed 9am to 6pm. Add --force if you're calling your own phone to test.`);
  process.exit(1);
}

loadDotEnv();
const config = getConfig();
requireConfig(config, ['vapi.apiKey', 'vapi.phoneNumberId']);

const language = args.lang || config.agent.languages[0];
const assistantId = readState().assistants[language];
if (!assistantId) {
  console.error(`No Layla assistant for "${language}" yet. Add it to LANGUAGES in .env and run: npm run setup`);
  process.exit(1);
}

const vapi = createVapi({ apiKey: config.vapi.apiKey });
const call = await vapi.createCall({
  assistantId,
  phoneNumberId: config.vapi.phoneNumberId,
  customer: { number, ...(args.name ? { name: args.name } : {}) },
  assistantOverrides: outboundOverrides({ language, customerName: args.name, leadContext: args.context }),
});

console.log(`Calling ${number} in ${language === 'ar' ? 'Arabic' : 'English'}. Call ID: ${call.id}`);
console.log('Watch it live in the Vapi dashboard under Call Logs. The lead lands in data/leads.jsonl when the call ends.');
