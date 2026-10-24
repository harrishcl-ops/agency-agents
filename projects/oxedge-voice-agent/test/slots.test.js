import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlots, isSlotOpen, parseDayHint, slotsForDay, localDate } from '../src/slots.js';
import { testConfig, MONDAY_8AM_DUBAI } from './helpers.js';

const { business } = testConfig();
const offset = business.utcOffsetMinutes;

test('first slot respects opening hour and minimum notice', () => {
  // 08:00 Dubai + 2h notice = 10:00, which is also opening time.
  const { slots } = findSlots({ now: MONDAY_8AM_DUBAI, business });
  assert.equal(slots[0].start, '2026-10-26T06:00:00.000Z'); // 10:00 Dubai
  assert.match(slots[0].label, /Monday/);
  assert.match(slots[0].label, /10:00/);
});

test('offers at most two slots per day so options spread across days', () => {
  const { slots } = findSlots({ now: MONDAY_8AM_DUBAI, business, limit: 3 });
  assert.equal(slots.length, 3);
  assert.match(slots[2].label, /Tuesday/);
});

test('skips weekend days', () => {
  const friday5pm = new Date('2026-10-30T13:00:00Z'); // Friday 17:00 Dubai, too late for notice
  const { slots } = findSlots({ now: friday5pm, business });
  assert.match(slots[0].label, /Monday/);
});

test('skips busy times from the calendar', () => {
  const busy = [{ start: '2026-10-26T06:00:00Z', end: '2026-10-26T07:00:00Z' }]; // 10:00-11:00 Dubai
  const { slots } = findSlots({ now: MONDAY_8AM_DUBAI, business, busy });
  assert.equal(slots[0].start, '2026-10-26T07:00:00.000Z'); // 11:00 Dubai
});

test('last slot ends by closing time', () => {
  const day = localDate(MONDAY_8AM_DUBAI, offset);
  const all = slotsForDay(day, { now: new Date('2026-10-25T00:00:00Z'), business });
  const last = all.at(-1);
  assert.equal(last.end.toISOString(), '2026-10-26T14:00:00.000Z'); // 18:00 Dubai
});

test('day hints in English and Arabic', () => {
  assert.equal(parseDayHint('today', MONDAY_8AM_DUBAI, offset), 0);
  assert.equal(parseDayHint('Tomorrow afternoon', MONDAY_8AM_DUBAI, offset), 1);
  assert.equal(parseDayHint('باكر', MONDAY_8AM_DUBAI, offset), 1);
  assert.equal(parseDayHint('Thursday', MONDAY_8AM_DUBAI, offset), 3);
  assert.equal(parseDayHint('الخميس', MONDAY_8AM_DUBAI, offset), 3);
  assert.equal(parseDayHint('next week', MONDAY_8AM_DUBAI, offset), 7);
  assert.equal(parseDayHint('2026-10-29', MONDAY_8AM_DUBAI, offset), 3);
  assert.equal(parseDayHint('2026-10-01', MONDAY_8AM_DUBAI, offset), null);
  assert.equal(parseDayHint('whenever', MONDAY_8AM_DUBAI, offset), null);
});

test('asking for a closed day falls forward with a note', () => {
  const { slots, note } = findSlots({ now: MONDAY_8AM_DUBAI, business, dayHint: 'Saturday' });
  assert.ok(note);
  assert.match(slots[0].label, /Monday/); // the following Monday
});

test('isSlotOpen only accepts exact free slots', () => {
  const opts = { now: MONDAY_8AM_DUBAI, business };
  assert.equal(isSlotOpen(new Date('2026-10-26T06:00:00Z'), opts), true);
  assert.equal(isSlotOpen(new Date('2026-10-26T06:10:00Z'), opts), false); // not on the grid
  assert.equal(isSlotOpen(new Date('2026-10-26T05:00:00Z'), opts), false); // 09:00, before opening
  assert.equal(isSlotOpen(new Date('2026-10-31T06:00:00Z'), opts), false); // Saturday
});
