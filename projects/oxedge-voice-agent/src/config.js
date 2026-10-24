import { existsSync, readFileSync } from 'node:fs';

// Minimal .env loader so the project needs no dependencies.
// Values already set in the real environment win over the file.
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

function list(value, fallback) {
  return (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// The service account key can be pasted as raw JSON or as base64 (easier in hosting dashboards).
function parseServiceAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text);
  if (!json.client_email || !json.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key');
  }
  return json;
}

export function getConfig(env = process.env) {
  const languages = list(env.LANGUAGES, 'en');
  return {
    port: int(env.PORT, 3000),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    webhookSecret: env.WEBHOOK_SECRET || '',
    dataDir: env.DATA_DIR || './data',

    vapi: {
      apiKey: env.VAPI_API_KEY || '',
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID || '',
      inboundLanguage: env.INBOUND_LANGUAGE || languages[0],
    },

    agent: {
      languages,
      llmModel: env.LLM_MODEL || 'claude-haiku-5-5',
      voiceModel: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
      voiceIds: {
        en: env.ELEVENLABS_VOICE_ID_EN || 'sarah',
        ar: env.ELEVENLABS_VOICE_ID_AR || env.ELEVENLABS_VOICE_ID_EN || 'sarah',
      },
      transferNumber: env.TEAM_TRANSFER_NUMBER || '',
      knowledgeFile: env.KNOWLEDGE_FILE || './knowledge/oxedge.md',
    },

    business: {
      timeZone: 'Asia/Dubai',
      // Dubai has no daylight saving, so a fixed UTC+4 offset is exact all year.
      utcOffsetMinutes: 240,
      days: list(env.BUSINESS_DAYS, '1,2,3,4,5').map(Number),
      openHour: int(env.OPEN_HOUR, 10),
      closeHour: int(env.CLOSE_HOUR, 18),
      slotMinutes: int(env.SLOT_MINUTES, 30),
      minNoticeHours: int(env.MIN_NOTICE_HOURS, 2),
      daysAhead: int(env.DAYS_AHEAD, 7),
      maxPerDay: 2,
    },

    google: {
      serviceAccount: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON),
      calendarId: env.GOOGLE_CALENDAR_ID || '',
    },

    hubspot: {
      token: env.HUBSPOT_TOKEN || '',
    },

    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v23.0',
      templates: {
        en: env.WHATSAPP_TEMPLATE_EN || '',
        ar: env.WHATSAPP_TEMPLATE_AR || '',
      },
    },
  };
}

export function requireConfig(config, paths) {
  const missing = paths.filter((path) => !path.split('.').reduce((o, k) => o?.[k], config));
  if (missing.length) {
    const names = {
      publicUrl: 'PUBLIC_URL',
      webhookSecret: 'WEBHOOK_SECRET',
      'vapi.apiKey': 'VAPI_API_KEY',
      'vapi.phoneNumberId': 'VAPI_PHONE_NUMBER_ID',
    };
    throw new Error(`Missing settings: ${missing.map((p) => names[p] || p).join(', ')}. Add them to .env.`);
  }
}
