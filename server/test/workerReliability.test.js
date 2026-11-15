import test from 'node:test';
import assert from 'node:assert/strict';
import {traceSafe} from '../src/utils/traceSafe.js';
import {recoverInterruptedJobs, INTERRUPTED_MESSAGE, STALE_AFTER_MS, HEARTBEAT_INTERVAL_MS} from '../src/workers/recovery.js';

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

// Minimal in-memory evaluation of the recovery filter.
function matches(job, filter) {
  if (filter._id !== undefined && job._id !== filter._id) return false;
  if (filter.status !== undefined && job.status !== filter.status) return false;
  if (filter.$or) {
    const ok = filter.$or.some(c => {
      const cond = c.lastHeartbeatAt;
      if (cond === null) return job.lastHeartbeatAt == null;
      if (cond.$exists === false) return job.lastHeartbeatAt === undefined;
      if (cond.$lt) return job.lastHeartbeatAt instanceof Date && job.lastHeartbeatAt < cond.$lt;
      return false;
    });
    if (!ok) return false;
  }
  return true;
}
function fakeModel(jobs) {
  const updates = [];
  return {
    updates,
    find: (filter) => ({select: () => ({lean: async () => jobs.filter(j => matches(j, filter)).map(j => ({...j}))})}),
    findOneAndUpdate: async (filter, update) => {
      const job = jobs.find(j => matches(j, filter));
      if (!job) return null;
      updates.push({id: job._id, update});
      Object.assign(job, update.$set);
      return job;
    }
  };
}
const NOW = new Date('2026-11-15T14:15:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const quiet = {warn() {}};

test('recovers RUNNING jobs whose heartbeat stopped (real crash/restart)', async () => {
  const jobs = [{_id: 'j1', videoId: 'v1', status: 'RUNNING', retryCount: 2, lastHeartbeatAt: ago(5 * 60_000)},
                {_id: 'j2', videoId: 'v2', status: 'RUNNING', cancelRequested: true, lastHeartbeatAt: ago(3 * 60_000)},
                {_id: 'j3', videoId: 'v3', status: 'RUNNING'}];
  const model = fakeModel(jobs);
  const videoCalls = [];
  const recovered = await recoverInterruptedJobs({GenerationJob: model, setVideoStatus: async (...a) => videoCalls.push(a), now: () => NOW, log: quiet});
  assert.deepEqual(recovered.map(r => r.status), ['FAILED', 'CANCELLED', 'FAILED']);
  assert.equal(model.updates[0].update.$set.error, INTERRUPTED_MESSAGE);
  assert.deepEqual(videoCalls[0].slice(0, 2), ['v1', 'FAILED']);
  assert.equal(videoCalls[0][4], 2);
  assert.deepEqual(videoCalls[1].slice(0, 2), ['v2', 'CANCELLED']);
});

test('never interrupts a job that another live process is working on (fresh heartbeat)', async () => {
  // Regression: a second backend instance started while job j1 was running
  // 2 seconds earlier must leave it alone.
  const jobs = [{_id: 'j1', videoId: 'v1', status: 'RUNNING', lastHeartbeatAt: ago(2_000)},
                {_id: 'j2', videoId: 'v2', status: 'RUNNING', lastHeartbeatAt: ago(STALE_AFTER_MS - 1_000)}];
  const model = fakeModel(jobs);
  const videoCalls = [];
  const recovered = await recoverInterruptedJobs({GenerationJob: model, setVideoStatus: async (...a) => videoCalls.push(a), now: () => NOW, log: quiet});
  assert.equal(recovered.length, 0);
  assert.equal(videoCalls.length, 0);
  assert.equal(jobs[0].status, 'RUNNING');
});

test('skips a job whose heartbeat arrives between the scan and the update', async () => {
  const jobs = [{_id: 'j1', videoId: 'v1', status: 'RUNNING', lastHeartbeatAt: ago(10 * 60_000)}];
  const model = fakeModel(jobs);
  const origFind = model.find;
  model.find = (f) => { const r = origFind(f); jobs[0].lastHeartbeatAt = NOW; return r; };
  const recovered = await recoverInterruptedJobs({GenerationJob: model, setVideoStatus: async () => {}, now: () => NOW, log: quiet});
  assert.equal(recovered.length, 0);
  assert.equal(jobs[0].status, 'RUNNING');
});

test('never touches the job this process is currently running', async () => {
  const jobs = [{_id: 'mine', videoId: 'v1', status: 'RUNNING', lastHeartbeatAt: ago(10 * 60_000)}];
  const recovered = await recoverInterruptedJobs({GenerationJob: fakeModel(jobs), setVideoStatus: async () => {}, now: () => NOW, excludeJobId: 'mine', log: quiet});
  assert.equal(recovered.length, 0);
});

test('heartbeat interval is well inside the stale window', () => {
  assert.ok(HEARTBEAT_INTERVAL_MS * 4 <= STALE_AFTER_MS);
});
