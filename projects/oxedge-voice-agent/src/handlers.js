import { findSlots, formatSlot, isSlotOpen } from './slots.js';

const MINUTE = 60_000;

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function escapeHtml(text = '') {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function bookingSentence(language, label) {
  if (language === 'ar') {
    return label
      ? `موعد مكالمتك الاستشارية: ${label} بتوقيت دبي.`
      : 'فريقنا بيتواصل معك خلال يوم عمل واحد.';
  }
  return label
    ? `Your discovery call is booked for ${label} (Dubai time).`
    : 'Our team will be in touch within one business day.';
}

/**
 * What Layla's tools do, and what happens after each call.
 * Integrations are passed in so tests (and a missing account) can swap them out.
 */
export function createHandlers({ config, calendar, crm, messenger, store, now = () => new Date(), log = console }) {
  const { business } = config;
  const bookings = new Map();
  const processedCalls = new Set();

  async function busyWindow(at) {
    const timeMax = new Date(at.getTime() + (business.daysAhead + 1) * 24 * 60 * MINUTE);
    try {
      return await calendar.busy(at, timeMax);
    } catch (err) {
      log.error('[calendar] busy lookup failed, offering unfiltered slots:', err.message);
      return [];
    }
  }

  const tools = {
    async check_availability(args) {
      const at = now();
      const busy = await busyWindow(at);
      const { slots, note } = findSlots({ now: at, business, busy, dayHint: args.day_hint, limit: 3 });
      if (!slots.length) {
        return { result: 'No discovery-call slots are free in the next week. Offer a callback from the team instead.' };
      }
      return { result: JSON.stringify({ timezone: 'Dubai time', slots, note: note || undefined }) };
    },

    async book_discovery_call(args, { callId, customerNumber }) {
      const start = new Date(args.start);
      if (Number.isNaN(start.getTime())) {
        return { error: 'Missing or invalid start time. Use a start value returned by check_availability.' };
      }
      const at = now();
      const busy = await busyWindow(at);
      if (!isSlotOpen(start, { now: at, business, busy })) {
        return { error: 'That time is no longer available. Call check_availability again and offer the new times.' };
      }
      const end = new Date(start.getTime() + business.slotMinutes * MINUTE);
      const name = (args.name || '').trim() || 'Caller';
      const label = formatSlot(start, business.timeZone);
      const description = [
        `Booked by Layla (AI receptionist) on a phone call.`,
        `Name: ${name}`,
        args.company && `Company: ${args.company}`,
        customerNumber && `Phone: ${customerNumber}`,
        args.email && `Email: ${args.email}`,
        args.need && `Needs: ${args.need}`,
        callId && `Vapi call: ${callId}`,
      ].filter(Boolean).join('\n');

      const event = await calendar.book({
        start,
        end,
        summary: `OxEdge discovery call: ${name}${args.company ? ` (${args.company})` : ''}`,
        description,
      });
      if (callId) bookings.set(callId, { start: start.toISOString(), label, eventId: event.id });
      return { result: `Booked for ${label}, Dubai time. Confirm this time back to the caller.` };
    },
  };

  async function onToolCalls(message) {
    const ctx = {
      callId: message.call?.id,
      customerNumber: message.customer?.number ?? message.call?.customer?.number,
    };
    const results = [];
    for (const toolCall of message.toolCallList ?? []) {
      const name = toolCall.function?.name;
      const handler = tools[name];
      let outcome;
      if (!handler) {
        outcome = { error: `Unknown tool: ${name}` };
      } else {
        try {
          outcome = await handler(parseArgs(toolCall.function?.arguments), ctx);
        } catch (err) {
          log.error(`[tool ${name}] failed:`, err.message);
          outcome = { error: 'The booking system did not respond. Apologise and offer a callback from the team.' };
        }
      }
      // Vapi wants a flat string in either `result` or `error`, never both.
      results.push({ name, toolCallId: toolCall.id, ...outcome });
    }
    return { results };
  }

  async function onEndOfCall(message) {
    const callId = message.call?.id;
    if (callId && processedCalls.has(callId)) return null;
    if (callId) processedCalls.add(callId);

    const data = message.analysis?.structuredData ?? {};
    const language = message.assistant?.metadata?.language ?? 'en';
    const phone = message.customer?.number ?? message.call?.customer?.number ?? null;
    const startedAt = Date.parse(message.startedAt ?? message.call?.startedAt ?? '');
    const endedAt = Date.parse(message.endedAt ?? message.call?.endedAt ?? '');
    const durationSeconds = Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.round((endedAt - startedAt) / 1000)
      : null;
    const booking = callId ? bookings.get(callId) : undefined;
    if (callId) bookings.delete(callId);

    const lead = {
      callId,
      endedAt: now().toISOString(),
      direction: message.call?.type === 'outboundPhoneCall' ? 'outbound' : 'inbound',
      language,
      phone,
      name: data.name ?? null,
      company: data.company ?? null,
      email: data.email ?? null,
      need: data.need ?? null,
      budget: data.budget ?? null,
      timeline: data.timeline ?? null,
      preferredTime: data.preferred_time ?? null,
      leadQuality: data.lead_quality ?? null,
      wantsHuman: data.wants_human ?? false,
      whatsappOk: data.whatsapp_ok ?? null,
      booking: booking?.label ?? null,
      bookingStart: booking?.start ?? null,
      summary: message.analysis?.summary ?? '',
      endedReason: message.endedReason ?? null,
      durationSeconds,
      costUsd: message.cost ?? null,
      recordingUrl: message.artifact?.recordingUrl ?? null,
    };

    try {
      await store.append({ ...lead, transcript: message.artifact?.transcript ?? '' });
    } catch (err) {
      log.error('[store] could not save lead:', err.message);
    }

    if (phone && crm.enabled) {
      try {
        const contact = await crm.upsertLead({ phone, name: lead.name, company: lead.company, email: lead.email });
        const rows = [
          ['Need', lead.need], ['Budget', lead.budget], ['Timeline', lead.timeline],
          ['Lead quality', lead.leadQuality], ['Discovery call', lead.booking ?? 'Not booked'],
          ['Wants a person', lead.wantsHuman ? 'Yes' : 'No'], ['Language', language], ['Recording', lead.recordingUrl],
        ].filter(([, v]) => v);
        const html = [
          `<p><strong>Layla call summary</strong></p>`,
          `<p>${escapeHtml(lead.summary || 'No summary.')}</p>`,
          `<ul>${rows.map(([k, v]) => `<li><strong>${k}:</strong> ${escapeHtml(v)}</li>`).join('')}</ul>`,
          message.artifact?.transcript ? `<p><strong>Transcript</strong></p><pre>${escapeHtml(message.artifact.transcript)}</pre>` : '',
        ].join('');
        await crm.addNote(contact.id, html, now());
        lead.crmContactId = contact.id;
      } catch (err) {
        log.error('[hubspot] could not log lead:', err.message);
      }
    }

    // Only message people who spoke to Layla and didn't say no to WhatsApp.
    const spoke = (durationSeconds ?? 60) >= 20;
    if (phone && messenger.enabled && spoke && lead.whatsappOk !== false) {
      try {
        const label = booking && language === 'ar'
          ? formatSlot(new Date(booking.start), business.timeZone, 'ar-AE')
          : lead.booking;
        await messenger.sendRecap({ to: phone, language, name: lead.name, bookingSentence: bookingSentence(language, label) });
        lead.whatsappSent = true;
      } catch (err) {
        log.error('[whatsapp] could not send recap:', err.message);
      }
    }

    return lead;
  }

  return { tools, onToolCalls, onEndOfCall, bookings };
}
