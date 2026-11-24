import test from 'node:test';
import assert from 'node:assert/strict';
import {narrationLooksCut, minSpeechSeconds} from '../src/utils/audioTiming.js';

const hindi = 'आज हम बात करेंगे कि कैसे छोटी-छोटी आदतें आपकी पूरी ज़िंदगी बदल सकती हैं, और क्यों ज़्यादातर लोग इन्हें नज़रअंदाज़ कर देते हैं।';

test('audio far shorter than its words is flagged as cut', () => {
  assert.equal(hindi.length > 100, true);
  assert.equal(narrationLooksCut(hindi, 1.5), true);
  assert.equal(narrationLooksCut(hindi, minSpeechSeconds(hindi) - 0.1), true);
});
test('normal and fast narration is accepted', () => {
  assert.equal(narrationLooksCut(hindi, hindi.length / 14), false); // normal Hindi pace
  assert.equal(narrationLooksCut(hindi, hindi.length / 24), false); // very fast voice
  assert.equal(narrationLooksCut('Hello there.', 0.4), false);      // very short lines are not judged
  assert.equal(narrationLooksCut(hindi, 0), false);                 // unknown length is not judged
});
