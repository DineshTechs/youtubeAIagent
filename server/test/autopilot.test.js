import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAutopilot,slotsAround,dueSlots,nextSlots,autopilotProblems,uploadRequest,DEFAULT_TIMES} from '../src/services/autopilot/autopilotRules.js';

test('defaults: off, twice a day at 12:30 and 19:30 India time', () => {
  const s = normalizeAutopilot({});
  assert.equal(s.enabled, false);
  assert.deepEqual(s.times, DEFAULT_TIMES);
  assert.equal(s.timezone, 'Asia/Kolkata');
  assert.equal(s.leadMinutes, 90);
  assert.equal(s.visibility, 'public');
  const odd = normalizeAutopilot({enabled: true, times: ['25:00', '7:5', '09:00', '09:00', '13:00', '15:00', '18:00', '21:00'], leadMinutes: 5, days: [9, 1], timezone: 'Nope/Zone', visibility: 'everyone'}, {timezone: 'Europe/London'});
  assert.deepEqual(odd.times, ['09:00', '13:00', '15:00', '18:00'], 'invalid dropped, deduped, max 4');
  assert.equal(odd.leadMinutes, 30);
  assert.deepEqual(odd.days, [1]);
  assert.equal(odd.timezone, 'Europe/London');
  assert.equal(odd.visibility, 'public');
});

test('slots are computed in the profile time zone', () => {
  const s = normalizeAutopilot({enabled: true});
  const now = new Date('2026-11-19T05:00:00Z'); // 10:30 IST
  const iso = slotsAround(s, now).map(d => d.toISOString());
  assert.ok(iso.includes('2026-11-19T07:00:00.000Z'), '12:30 IST');
  assert.ok(iso.includes('2026-11-19T14:00:00.000Z'), '19:30 IST');
  assert.deepEqual(nextSlots(s, now, 2).map(d => d.toISOString()), ['2026-11-19T07:00:00.000Z', '2026-11-19T14:00:00.000Z']);
});

test('generation starts lead time before the slot and stops after the grace period', () => {
  const s = normalizeAutopilot({enabled: true, leadMinutes: 90, graceMinutes: 120});
  const at = t => dueSlots(s, new Date(t)).map(d => d.toISOString());
  assert.deepEqual(at('2026-11-19T05:29:00Z'), [], '91 min before 12:30 IST');
  assert.deepEqual(at('2026-11-19T05:30:00Z'), ['2026-11-19T07:00:00.000Z']);
  assert.deepEqual(at('2026-11-19T09:00:00Z'), ['2026-11-19T07:00:00.000Z'], 'app started late, still within grace');
  assert.deepEqual(at('2026-11-19T09:01:00Z'), [], 'grace over -> slot not made');
  const weekdays = normalizeAutopilot({enabled: true, days: [1, 2, 3, 4, 5]});
  assert.deepEqual(dueSlots(weekdays, new Date('2026-11-22T06:30:00Z')), [], 'Sunday skipped');
});

test('automatic approval only for clean, passing videos', () => {
  const s = normalizeAutopilot({enabled: true, minQaScore: 75});
  const good = {status: 'AWAITING_APPROVAL', qa: {pass: true, score: 88}, renderPath: 'x.mp4', mediaAssetDetails: [{sceneNumber: 1}]};
  assert.deepEqual(autopilotProblems(good, s), []);
  assert.match(autopilotProblems({...good, qa: {pass: true, score: 60}}, s).join(), /below the autopilot minimum 75/);
  assert.match(autopilotProblems({...good, qa: {pass: false, score: 90}}, s).join(), /did not pass/);
  assert.match(autopilotProblems({...good, mediaAssetDetails: [{sceneNumber: 2, stale: true}]}, s).join(), /Scene 2 image may not match/);
  assert.deepEqual(autopilotProblems({...good, mediaAssetDetails: [{sceneNumber: 2, stale: true}]}, {...s, blockStaleImages: false}), []);
  assert.match(autopilotProblems({...good, status: 'FAILED'}, s).join(), /FAILED/);
});

test('upload is scheduled for the slot when there is time, otherwise immediate', () => {
  const s = normalizeAutopilot({enabled: true});
  const slot = '2026-11-19T14:00:00.000Z';
  assert.deepEqual(uploadRequest(slot, s, new Date('2026-11-19T13:00:00Z')), {publishAt: slot});
  assert.deepEqual(uploadRequest(slot, s, new Date('2026-11-19T13:55:00Z')), {privacyStatus: 'public'});
  assert.deepEqual(uploadRequest(slot, {...s, visibility: 'unlisted'}, new Date('2026-11-19T10:00:00Z')), {privacyStatus: 'unlisted'});
});
