import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalBlockReason} from '../src/utils/approvalGate.js';

const passedQa = (version) => ({version, pass: true, checks: [{name: 'Rendered file', status: 'PASS'}]});
const fullReview = {imagesMatch: true, subtitlesReadable: true, ageAppropriate: true};

test('blocks approval without visual review for every QA version, including new ones', () => {
  for (const version of ['1.2', '1.5.0', '1.6.1', '1.7.0', '9.9.9', undefined]) {
    assert.match(approvalBlockReason({qa: passedQa(version), visualReview: {}}), /visual review/i, `version ${version}`);
  }
});

test('blocks approval when technical QA failed', () => {
  assert.match(approvalBlockReason({qa: {...passedQa('1.7.0'), pass: false}, visualReview: fullReview}), /Technical QA has failed/);
});

test('blocks approval when no QA report exists', () => {
  assert.match(approvalBlockReason({visualReview: fullReview}), /No technical QA report/);
});

test('blocks a partial visual review', () => {
  assert.ok(approvalBlockReason({qa: passedQa('1.7.0'), visualReview: {imagesMatch: true, subtitlesReadable: true}}));
});

test('allows approval with passing QA and complete visual review', () => {
  assert.equal(approvalBlockReason({qa: passedQa('1.7.0'), visualReview: fullReview}), null);
});
