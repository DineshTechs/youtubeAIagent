import test from 'node:test';
import assert from 'node:assert/strict';
import {removeSeries} from '../src/services/seriesRemoval.js';

function world({series, stories = {}, runningFor = []}) {
  const docs = series.map(s => ({...s, save: async function () { const i = docs.indexOf(this); docs[i] = this; }}));
  const log = {deletedSeries: [], deletedCharsFor: []};
  const Series = {
    findById: async id => docs.find(d => d._id === id) || null,
    deleteOne: async ({_id}) => { log.deletedSeries.push(_id); docs.splice(docs.findIndex(d => d._id === _id), 1); },
    findOne: () => ({sort: async () => docs.filter(d => !d.archived).sort((a, b) => b.createdAt - a.createdAt)[0] || null}),
    updateMany: async ({_id}) => { for (const d of docs) if (d._id !== _id.$ne) d.active = false; }
  };
  return {
    docs, log,
    models: {
      Series,
      Story: {countDocuments: async ({seriesId}) => stories[seriesId] || 0},
      Character: {deleteMany: async ({seriesId}) => log.deletedCharsFor.push(seriesId)},
      GenerationJob: {exists: async q => runningFor.includes(q['payload.seriesId'])}
    }
  };
}

test('profile without videos is deleted completely, with its characters', async () => {
  const w = world({series: [{_id: 'a', name: 'A', active: false, createdAt: 1}]});
  const r = await removeSeries(w.models, 'a');
  assert.equal(r.mode, 'deleted');
  assert.deepEqual(w.log.deletedSeries, ['a']);
  assert.deepEqual(w.log.deletedCharsFor, ['a']);
});

test('profile with videos is archived so old videos can still be continued and re-rendered', async () => {
  const w = world({series: [{_id: 'a', name: 'Motivation', active: false, createdAt: 1}], stories: {a: 3}});
  const r = await removeSeries(w.models, 'a', {now: () => new Date('2026-11-16T00:00:00Z')});
  assert.equal(r.mode, 'archived');
  assert.equal(w.log.deletedSeries.length, 0);
  assert.equal(w.docs[0].archived, true);
  assert.match(w.docs[0].name, /^Motivation \(deleted 2026-11-16 /, 'name freed for reuse');
});

test('deleting the default profile makes the newest remaining profile the default', async () => {
  const w = world({series: [{_id: 'a', name: 'A', active: true, createdAt: 1}, {_id: 'b', name: 'B', active: false, createdAt: 5}, {_id: 'c', name: 'C', active: false, createdAt: 3}]});
  const r = await removeSeries(w.models, 'a');
  assert.equal(r.newDefault.name, 'B');
  assert.equal(w.docs.find(d => d._id === 'b').active, true);
});

test('refuses while a video is being generated with the profile', async () => {
  const w = world({series: [{_id: 'a', name: 'A', createdAt: 1}], runningFor: ['a']});
  await assert.rejects(removeSeries(w.models, 'a'), e => e.status === 409);
});

test('unknown or already-archived profile returns 404', async () => {
  const w = world({series: [{_id: 'x', name: 'X', archived: true, createdAt: 1}]});
  await assert.rejects(removeSeries(w.models, 'nope'), e => e.status === 404);
  await assert.rejects(removeSeries(w.models, 'x'), e => e.status === 404);
});
