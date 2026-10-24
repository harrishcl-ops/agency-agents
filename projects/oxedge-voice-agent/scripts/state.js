import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Remembers the Vapi assistant IDs so re-running setup updates Layla instead of creating duplicates.
const FILE = '.vapi-state.json';

export function readState() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { assistants: {} };
}

export function writeState(state) {
  writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`);
}
