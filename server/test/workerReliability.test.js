import test from 'node:test';
import assert from 'node:assert/strict';
import {traceSafe} from '../src/utils/traceSafe.js';
import {recoverInterruptedJobs, INTERRUPTED_MESSAGE} from '../src/workers/recovery.js';

test('traceSafe keeps small objects unchanged', () => {
  assert.deepEqual(traceSafe({a: 1, b: ['x']}), {a: 1, b: ['x']});
});

test('traceSafe never stores "[object Object]" for large objects', () => {
  const big = {scenes: Array.from({length: 8}, (_, i) => ({n: i, narration: 'x'.repeat(1800)}))};
  const out = traceSafe(big, 12000);
  assert.notEqual(out, '[object Object]');
  assert.equal(out.truncated, true);
  assert.ok(out.originalChars > 12000);
  assert.ok(out.preview.startsWith('{"scenes":[{"n":0'));
});

test('traceSafe handles circular references and long strings', () => {
  const a = {name: 'x'}; a.self = a;
  assert.equal(traceSafe(a).self, '[Circular]');
  assert.ok(traceSafe('y'.repeat(20), 10).endsWith('…'));
});

function fakeModel(jobs) {
  const updates = [];
  return {
    updates,
    find: () => ({select: () => ({lean: async () => jobs})}),
    findOneAndUpdate: async (filter, update) => {
      const job = jobs.find(j => j._id === filter._id);
      if (!job || job.status !== filter.status) return null;
      updates.push({id: job._id, update});
      job.status = update.$set.status;
      return job;
    }
  };
}

test('recovers orphaned RUNNING jobs as FAILED and marks the video resumable', async () => {
  const jobs = [{_id: 'j1', videoId: 'v1', status: 'RUNNING', retryCount: 2}, {_id: 'j2', videoId: 'v2', status: 'RUNNING', cancelRequested: true}];
  const model = fakeModel(jobs);
  const videoCalls = [];
  const recovered = await recoverInterruptedJobs({GenerationJob: model, setVideoStatus: async (...args) => videoCalls.push(args), log: {warn() {}}});
  assert.deepEqual(recovered.map(r => r.status), ['FAILED', 'CANCELLED']);
  assert.equal(model.updates[0].update.$set.error, INTERRUPTED_MESSAGE);
  assert.deepEqual(videoCalls[0].slice(0, 2), ['v1', 'FAILED']);
  assert.equal(videoCalls[0][4], 2);
  assert.deepEqual(videoCalls[1].slice(0, 2), ['v2', 'CANCELLED']);
});

test('does not touch a job that stopped running before recovery updates it', async () => {
  const jobs = [{_id: 'j1', videoId: 'v1', status: 'RUNNING'}];
  const model = fakeModel(jobs);
  const origFind = model.find;
  model.find = () => { const r = origFind(); jobs[0].status = 'COMPLETED'; return r; };
  const videoCalls = [];
  const recovered = await recoverInterruptedJobs({GenerationJob: model, setVideoStatus: async (...a) => videoCalls.push(a), log: {warn() {}}});
  assert.equal(recovered.length, 0);
  assert.equal(videoCalls.length, 0);
});
