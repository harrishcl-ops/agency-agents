import { createSign } from 'node:crypto';
import { requestJson } from './http.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Service-account sign-in without the googleapis package: a signed JWT swapped for an access token.
function signedJwt(serviceAccount, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(serviceAccount.private_key, 'base64url')}`;
}

/**
 * Google Calendar when GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID are set,
 * otherwise an in-memory calendar so the agent still works end to end.
 */
export function createCalendar(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const { serviceAccount, calendarId } = config.google;
  if (!serviceAccount || !calendarId) return createMemoryCalendar();

  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < tokenExpiresAt - 60) return token;
    const data = await requestJson(fetchImpl, 'Google auth', TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt(serviceAccount, now) },
    });
    token = data.access_token;
    tokenExpiresAt = now + (data.expires_in || 3600);
    return token;
  }

  async function call(method, path, body) {
    return requestJson(fetchImpl, 'Google Calendar', `${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}` },
      body,
    });
  }

  return {
    enabled: true,
    async busy(timeMin, timeMax) {
      const data = await call('POST', '/freeBusy', {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: calendarId }],
      });
      return data.calendars?.[calendarId]?.busy ?? [];
    },
    async book({ start, end, summary, description }) {
      const timeZone = config.business.timeZone;
      const event = await call('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone },
        end: { dateTime: end.toISOString(), timeZone },
      });
      return { id: event.id, link: event.htmlLink ?? null };
    },
  };
}

export function createMemoryCalendar() {
  const events = [];
  return {
    enabled: false,
    events,
    async busy(timeMin, timeMax) {
      return events
        .filter((e) => e.start < timeMax && e.end > timeMin)
        .map((e) => ({ start: e.start.toISOString(), end: e.end.toISOString() }));
    },
    async book(event) {
      const id = `local-${events.length + 1}`;
      events.push({ id, ...event });
      return { id, link: null };
    },
  };
}
