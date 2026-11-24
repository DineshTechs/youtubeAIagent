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

import {pickBlocker, waitingDecision, waitingMessage, blockerReason} from '../src/services/autopilot/autopilotRules.js';
const apOn = normalizeAutopilot({enabled: true, graceMinutes: 120});
const ago = h => new Date(Date.now() - h * 3600000).toISOString();

test('waiting is on by default and can be turned off', () => {
  assert.equal(normalizeAutopilot({}).waitForPublish, true);
  assert.equal(normalizeAutopilot({waitForPublish: false}).waitForPublish, false);
});

test('the oldest video that is not on YouTube yet blocks the next slot', () => {
  const videos = [
    {_id: 'a', title: 'Old published', status: 'PUBLISHED', createdAt: ago(48)},
    {_id: 'b', title: 'Needs approval', status: 'AWAITING_APPROVAL', createdAt: ago(20)},
    {_id: 'c', title: 'Being made', status: 'VIDEO_RENDERING', createdAt: ago(1)},
    {_id: 'd', title: 'Failed', status: 'FAILED', createdAt: ago(30)},
    {_id: 'e', title: 'Scheduled', status: 'SCHEDULED', createdAt: ago(25)}
  ];
  const b = pickBlocker({videos});
  assert.equal(b.videoId, 'b');
  assert.equal(b.reason, 'is waiting for your approval');
  assert.equal(pickBlocker({videos: videos.filter(v => v._id !== 'b')}).reason, 'is still being made');
  assert.equal(pickBlocker({videos: [videos[0], videos[3], videos[4]]}), null);
  assert.equal(pickBlocker({videos: [], generatingRuns: [{_id: 'r', videoId: null}]}).reason, 'is still being made');
  assert.equal(blockerReason('APPROVED'), 'is approved but not on YouTube yet');
});

test('a waiting slot: wait, publish the approved video, make a new one, or give up when time passes', () => {
  const slotAt = new Date(Date.now() + 60 * 60000);
  const run = {slotAt};
  const waiting = {videoId: 'b', title: 'Needs approval', status: 'AWAITING_APPROVAL', reason: 'is waiting for your approval'};
  assert.deepEqual(waitingDecision({run, blocker: waiting, settings: apOn}), {action: 'wait', videoId: 'b'});
  const approved = {...waiting, status: 'APPROVED'};
  assert.equal(waitingDecision({run, blocker: approved, settings: apOn}).action, 'take');
  assert.equal(waitingDecision({run, blocker: approved, settings: apOn, heldVideoIds: ['b']}).action, 'wait', 'never two slots for one video');
  assert.equal(waitingDecision({run, blocker: null, settings: apOn}).action, 'generate');
  const late = waitingDecision({run: {slotAt: new Date(Date.now() - 3 * 3600000)}, blocker: waiting, settings: apOn});
  assert.equal(late.action, 'skip');
  assert.match(late.message, /No new video was made/);
  assert.equal(waitingDecision({run, blocker: waiting, settings: {...apOn, enabled: false}}).action, 'skip');
});

test('the Telegram message says why and what to do', () => {
  const m = waitingMessage({title: 'Honest woodcutter', status: 'AWAITING_APPROVAL', reason: 'is waiting for your approval'}, '24 Nov 2026, 7:30 pm');
  assert.match(m, /No new video for 24 Nov 2026, 7:30 pm: "Honest woodcutter" is waiting for your approval/);
  assert.match(m, /Approve it and it is published at this time/);
  assert.doesNotMatch(waitingMessage({title: 'X', status: 'VIDEO_RENDERING', reason: 'is still being made'}, 'now'), /Approve it/);
});
