import { getConfig } from '../src/config.js';

export function testConfig(overrides = {}) {
  const config = getConfig({ WEBHOOK_SECRET: 'test-secret', PUBLIC_URL: 'https://layla.example.com', DATA_DIR: '/tmp/unused' });
  return { ...config, ...overrides };
}

/** Records every request and answers from a list of canned responses, in order. */
export function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

export const silentLog = { info() {}, error() {} };

// A Monday morning in Dubai: 2026-10-26 08:00 local = 04:00 UTC.
export const MONDAY_8AM_DUBAI = new Date('2026-10-26T04:00:00Z');
