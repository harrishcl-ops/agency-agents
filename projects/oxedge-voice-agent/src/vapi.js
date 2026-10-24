import { requestJson } from './integrations/http.js';

export function createVapi({ apiKey, fetch: fetchImpl = globalThis.fetch, baseUrl = 'https://api.vapi.ai' }) {
  const call = (method, path, body) =>
    requestJson(fetchImpl, 'Vapi', `${baseUrl}${path}`, { method, headers: { Authorization: `Bearer ${apiKey}` }, body });

  return {
    createAssistant: (body) => call('POST', '/assistant', body),
    updateAssistant: (id, body) => call('PATCH', `/assistant/${id}`, body),
    getAssistant: (id) => call('GET', `/assistant/${id}`),
    updatePhoneNumber: (id, body) => call('PATCH', `/phone-number/${id}`, body),
    createCall: (body) => call('POST', '/call', body),
  };
}
