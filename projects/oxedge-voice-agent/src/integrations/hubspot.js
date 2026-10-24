import { requestJson } from './http.js';

const API = 'https://api.hubapi.com';
// HubSpot's built-in association type for "note to contact".
const NOTE_TO_CONTACT = 202;

function splitName(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstname: parts[0] || '', lastname: parts.slice(1).join(' ') };
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** HubSpot CRM when HUBSPOT_TOKEN is set; otherwise a no-op that reports itself as disabled. */
export function createCrm(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const { token } = config.hubspot;
  if (!token) {
    return {
      enabled: false,
      async upsertLead() { return null; },
      async addNote() { return null; },
    };
  }

  const call = (method, path, body) =>
    requestJson(fetchImpl, 'HubSpot', `${API}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body });

  return {
    enabled: true,
    // Finds the contact by phone so repeat callers don't create duplicates.
    async upsertLead({ phone, name, company, email }) {
      const properties = compact({ phone, company, email, ...splitName(name) });
      const found = await call('POST', '/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
        properties: ['phone'],
        limit: 1,
      });
      const existing = found?.results?.[0];
      if (existing) {
        await call('PATCH', `/crm/v3/objects/contacts/${existing.id}`, { properties });
        return { id: existing.id, created: false };
      }
      const created = await call('POST', '/crm/v3/objects/contacts', { properties });
      return { id: created.id, created: true };
    },
    async addNote(contactId, html, at = new Date()) {
      const note = await call('POST', '/crm/v3/objects/notes', {
        properties: { hs_timestamp: at.toISOString(), hs_note_body: html },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }],
        }],
      });
      return { id: note.id };
    },
  };
}
