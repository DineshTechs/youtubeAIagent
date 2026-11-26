import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWhen, formatWhen, nextFreeSlot, slotSettingsFor} from '../src/services/autopilot/publishSlots.js';

const now = new Date('2026-11-26T05:53:00Z'); // Thu 26 Nov, 11:23 am India time
const when = t => { const r = parseWhen(t, 'Asia/Kolkata', now); return r.at ? formatWhen(r.at) : `ERR ${r.error}`; };

test('typed times are read in the profile time zone', () => {
  assert.equal(when('27 Nov 18:30'), 'Fri, 27 Nov, 6:30 pm');
  assert.equal(when('tomorrow 9am'), 'Fri, 27 Nov, 9:00 am');
  assert.equal(when('kal 7 pm'), 'Fri, 27 Nov, 7:00 pm');
  assert.equal(when('19:30'), 'Thu, 26 Nov, 7:30 pm');
  assert.equal(when('10:00'), 'Fri, 27 Nov, 10:00 am', 'a time already passed today means tomorrow');
  assert.equal(when('27/11 7pm'), 'Fri, 27 Nov, 7:00 pm');
  assert.equal(when('2026-12-01 08:15'), 'Tue, 1 Dec, 8:15 am');
  assert.equal(when('Dec 3 9:00 pm'), 'Thu, 3 Dec, 9:00 pm');
  assert.equal(parseWhen('19:30', 'Asia/Kolkata', now).at.toISOString(), '2026-11-26T14:00:00.000Z');
});

test('bad or past times are refused with a reason', () => {
  assert.match(when('hello'), /include a time/);
  assert.match(when('31 Feb 10:00'), /does not exist/);
  assert.match(when('25 Nov 10:00'), /already passed/);
  assert.match(when('today 11:30'), /too soon/);
  assert.match(when('13 pm'), /1–12/);
});

test('the next free slot skips times already used', () => {
  const ap = slotSettingsFor({autopilot: {enabled: true, times: ['12:30', '19:30']}});
  assert.equal(formatWhen(nextFreeSlot(ap, [], now)), 'Thu, 26 Nov, 12:30 pm');
  assert.equal(formatWhen(nextFreeSlot(ap, [new Date('2026-11-26T07:00:00Z')], now)), 'Thu, 26 Nov, 7:30 pm');
  assert.equal(formatWhen(nextFreeSlot(ap, [], new Date('2026-11-26T06:50:00Z'))), 'Thu, 26 Nov, 7:30 pm', 'less than 15 minutes away is skipped');
  const daily = slotSettingsFor({uploadSettings: {scheduleTime: '9:00'}});
  assert.equal(formatWhen(nextFreeSlot(daily, [], now)), 'Fri, 27 Nov, 9:00 am');
});
