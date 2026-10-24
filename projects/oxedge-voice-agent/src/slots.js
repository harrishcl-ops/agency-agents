// Discovery-call slot finding in OxEdge's local time (Asia/Dubai).
// Everything here is pure so it can be tested without a calendar.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  'الأحد': 0, 'الاحد': 0, 'الاثنين': 1, 'الإثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3, 'الاربعاء': 3,
  'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
};
const TODAY = ['today', 'اليوم'];
const TOMORROW = ['tomorrow', 'باكر', 'بكرة', 'بكره', 'غدا', 'غداً', 'بكرا'];

/** Local calendar date of `date` at the given UTC offset. */
export function localDate(date, offsetMinutes) {
  const d = new Date(date.getTime() + offsetMinutes * MINUTE);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
}

/** A UTC Date for a local wall-clock time at the given UTC offset. */
export function fromLocal({ y, m, d }, hour, minute, offsetMinutes) {
  return new Date(Date.UTC(y, m, d, hour, minute) - offsetMinutes * MINUTE);
}

function addDays(day, n, offsetMinutes) {
  return localDate(new Date(fromLocal(day, 12, 0, offsetMinutes).getTime() + n * DAY), offsetMinutes);
}

/**
 * Turns what the caller said ("tomorrow", "Tuesday", "next week", "2026-11-03", "باكر")
 * into a number of days from today. Returns null when there is no usable hint.
 */
export function parseDayHint(hint, now, offsetMinutes) {
  if (!hint) return null;
  const text = String(hint).trim().toLowerCase();
  const today = localDate(now, offsetMinutes);

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const target = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const base = Date.UTC(today.y, today.m, today.d);
    const diff = Math.round((target - base) / DAY);
    return diff >= 0 ? diff : null;
  }
  if (TODAY.some((w) => text.includes(w))) return 0;
  if (TOMORROW.some((w) => text.includes(w))) return 1;
  if (text.includes('next week') || text.includes('الأسبوع الجاي') || text.includes('الاسبوع الجاي')) {
    return ((1 - today.dow + 7) % 7) || 7;
  }
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (text.includes(name)) return (dow - today.dow + 7) % 7;
  }
  return null;
}

function overlaps(start, end, busy) {
  return busy.some((b) => start < new Date(b.end) && end > new Date(b.start));
}

/** Every open slot on one local day, honouring business hours, notice and busy times. */
export function slotsForDay(day, { now, business, busy = [] }) {
  const { days, openHour, closeHour, slotMinutes, minNoticeHours, utcOffsetMinutes } = business;
  if (!days.includes(day.dow)) return [];
  const earliest = now.getTime() + minNoticeHours * 60 * MINUTE;
  const slots = [];
  for (let t = openHour * 60; t + slotMinutes <= closeHour * 60; t += slotMinutes) {
    const start = fromLocal(day, Math.floor(t / 60), t % 60, utcOffsetMinutes);
    const end = new Date(start.getTime() + slotMinutes * MINUTE);
    if (start.getTime() < earliest || overlaps(start, end, busy)) continue;
    slots.push({ start, end });
  }
  return slots;
}

export function formatSlot(date, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

/**
 * Up to `limit` slots to offer the caller, spread over days (at most `maxPerDay` per day).
 * When the caller asked for a day with nothing free, it falls back to the following days
 * and says so in `note`.
 */
export function findSlots({ now, business, busy = [], dayHint, limit = 3 }) {
  const offset = business.utcOffsetMinutes;
  const hinted = parseDayHint(dayHint, now, offset);
  const startDay = hinted ?? 0;
  const today = localDate(now, offset);
  const offered = [];
  let note = '';

  for (let i = startDay; i <= Math.max(startDay, business.daysAhead) && offered.length < limit; i++) {
    const day = addDays(today, i, offset);
    const open = slotsForDay(day, { now, business, busy });
    if (hinted !== null && i === startDay && open.length === 0) {
      note = 'Nothing is free on the day the caller asked for, so these are the next available times.';
    }
    offered.push(...open.slice(0, business.maxPerDay));
  }

  return {
    slots: offered.slice(0, limit).map((s) => ({
      start: s.start.toISOString(),
      label: formatSlot(s.start, business.timeZone),
    })),
    note,
  };
}

/** True when `start` is exactly one of the open slots for its day. */
export function isSlotOpen(start, { now, business, busy = [] }) {
  const day = localDate(start, business.utcOffsetMinutes);
  return slotsForDay(day, { now, business, busy }).some((s) => s.start.getTime() === start.getTime());
}
