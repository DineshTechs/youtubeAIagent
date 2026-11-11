import test from 'node:test';
import assert from 'node:assert/strict';
import {findHookCompletionTime, analyzeOpeningPacing, analyzeHookText} from '../src/utils/retentionAnalysis.js';

test('finds hook completion across multiple caption cues', () => {
  const srt = `1\n00:00:00,000 --> 00:00:01,200\nWhat is hiding\n\n2\n00:00:01,200 --> 00:00:02,400\nbehind the little door?\n`;
  const result = findHookCompletionTime(srt, 'What is hiding behind the little door?');
  assert.equal(result.found, true);
  assert.equal(result.endSec, 2.4);
  assert.equal(result.endWithin3Sec, true);
});

test('flags a hook that completes after three seconds', () => {
  const srt = `1\n00:00:00,000 --> 00:00:04,200\nA very long opening hook\n`;
  assert.equal(findHookCompletionTime(srt, 'A very long opening hook').endWithin3Sec, false);
});

test('opening pacing summarizes only scenes overlapping first 15 seconds', () => {
  const result = analyzeOpeningPacing([4, 5, 6, 8]);
  assert.equal(result.sceneCount, 3);
  assert.equal(result.coverageSec, 15);
  assert.equal(result.longestSceneSec, 6);
  assert.equal(result.complete, true);
});


test('matches hook when subtitles omit punctuation and split words across cues', () => {
  const srt = `1\n00:00:00,000 --> 00:00:01,000\nWhat is hiding\n\n2\n00:00:01,000 --> 00:00:02,700\nbehind the little door\n`;
  const result = findHookCompletionTime(srt, 'What is hiding behind the little door?');
  assert.equal(result.found, true);
  assert.equal(result.endWithin3Sec, true);
  assert.equal(result.matchRatio, 1);
});

test('flags hooks that are too long for a fast opening', () => {
  assert.equal(analyzeHookText('What is hiding behind this little door?').concise, true);
  assert.equal(analyzeHookText('Today we are going to explain everything you need to know about this complicated topic').concise, false);
});
