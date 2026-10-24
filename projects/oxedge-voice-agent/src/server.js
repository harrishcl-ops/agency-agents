import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Vapi sends `Authorization: Bearer <secret>` (set by scripts/setup.js); `x-vapi-secret` also works. */
export function isAuthorized(headers, secret) {
  if (!secret) return false;
  const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : null;
  return (bearer !== null && safeEqual(bearer, secret)) || (headers['x-vapi-secret'] !== undefined && safeEqual(headers['x-vapi-secret'], secret));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer({ config, handlers, store, integrations = {}, log = console }) {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, integrations });
      }

      if (req.method === 'GET' && url.pathname === '/leads') {
        if (!isAuthorized(req.headers, config.webhookSecret)) return send(res, 401, { error: 'Unauthorized' });
        return send(res, 200, { leads: await store.recent(50) });
      }

      if (req.method === 'POST' && url.pathname === '/vapi/webhook') {
        if (!isAuthorized(req.headers, config.webhookSecret)) return send(res, 401, { error: 'Unauthorized' });
        const { message } = await readJson(req);
        switch (message?.type) {
          case 'tool-calls':
            return send(res, 200, await handlers.onToolCalls(message));
          case 'end-of-call-report': {
            const lead = await handlers.onEndOfCall(message);
            if (lead) log.info(`[call ${lead.callId}] ${lead.phone ?? 'web'} · ${lead.leadQuality ?? 'unrated'} · booked: ${lead.booking ?? 'no'}`);
            return send(res, 200, {});
          }
          default:
            // Other Vapi events are informational; acknowledge them.
            return send(res, 200, {});
        }
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error('[server]', err.message);
      return send(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
    }
  });
}
