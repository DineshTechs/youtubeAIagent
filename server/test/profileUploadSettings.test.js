import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUploadSettings,buildUploadMetadata,nextScheduledSlot,languageCode} from '../src/services/uploadSettings.js';
import {resolveVideoProfiles,profileVideoFilter,countByProfile} from '../src/services/videoProfiles.js';
import {buildChannelProfile,profileDirectives} from '../src/services/channelProfile.js';

test('upload settings default to private, not made for kids, AI disclosure on', () => {
  const s = normalizeUploadSettings({}, {language: 'Hindi'});
  assert.equal(s.privacyStatus, 'private');
  assert.equal(s.madeForKids, false);
  assert.equal(s.containsSyntheticMedia, true);
  assert.equal(s.defaultLanguage, 'hi');
  assert.equal(s.categoryId, '24');
  assert.equal(normalizeUploadSettings({}, {kids: true}).madeForKids, true);
});

test('upload settings reject invalid values', () => {
  const s = normalizeUploadSettings({privacyStatus: 'everyone', categoryId: '999', scheduleTime: '25:00', timezone: 'Mars/Base', playlistId: 'bad id!', hashtags: '#motivation, #hindi shorts,,', tags: 'a,b,a'});
  assert.equal(s.privacyStatus, 'private');
  assert.equal(s.categoryId, '24');
  assert.equal(s.scheduleTime, '');
  assert.equal(s.timezone, 'Asia/Kolkata');
  assert.equal(s.playlistId, '');
  assert.deepEqual(s.hashtags, ['motivation', 'hindishorts']);
  assert.deepEqual(s.tags, ['a', 'b']);
  assert.equal(normalizeUploadSettings({madeForKids: 'false'}, {kids: true}).madeForKids, false);
  assert.equal(normalizeUploadSettings({scheduleTime: '7:05'}).scheduleTime, '07:05');
});

test('metadata merges profile settings with story SEO and caps limits', () => {
  const settings = normalizeUploadSettings({titleTemplate: '{title} | {channel}', hashtags: ['shorts'], descriptionFooter: 'Follow for more <3', tags: ['profile tag'], privacyStatus: 'unlisted', categoryId: '27', playlistId: 'PLabcdefghijk123'});
  const story = {title: 'Story <title>', youtubeOptimization: {seo: {description: 'SEO description', tags: Array.from({length: 80}, (_, i) => `tag number ${i}`)}}};
  const m = buildUploadMetadata({story, video: {}, settings, profileName: 'Kalyug'});
  assert.equal(m.title, 'Story title | Kalyug');
  assert.match(m.description, /^SEO description\n\n#shorts\n\nFollow for more 3$/);
  assert.equal(m.tags[0], 'profile tag');
  const tagChars = m.tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + m.tags.length - 1;
  assert.ok(tagChars <= 500, `tags use ${tagChars} chars`);
  assert.equal(m.privacyStatus, 'unlisted');
  assert.equal(m.categoryId, '27');
  assert.equal(m.selfDeclaredMadeForKids, false);
  assert.equal(m.playlistId, 'PLabcdefghijk123');
  const o = buildUploadMetadata({story, settings, opts: {title: 'Custom', description: 'Mine', privacyStatus: 'public', madeForKids: true}});
  assert.equal(o.title, 'Custom');
  assert.equal(o.description, 'Mine');
  assert.equal(o.privacyStatus, 'public');
  assert.equal(o.selfDeclaredMadeForKids, true);
  assert.ok(buildUploadMetadata({story: {title: 'x'.repeat(300)}, settings}).title.length <= 100);
});

test('next publish slot respects the profile time zone', () => {
  const now = new Date('2026-11-19T10:00:00Z'); // 15:30 in India
  assert.equal(nextScheduledSlot('18:00', 'Asia/Kolkata', now).toISOString(), '2026-11-19T12:30:00.000Z');
  assert.equal(nextScheduledSlot('09:00', 'Asia/Kolkata', now).toISOString(), '2026-11-20T03:30:00.000Z');
  assert.equal(nextScheduledSlot('10:05', 'UTC', now).toISOString(), '2026-11-20T10:05:00.000Z', 'needs 15 min lead time');
  assert.equal(nextScheduledSlot('09:00', 'America/New_York', now).toISOString(), '2026-11-19T14:00:00.000Z');
  assert.equal(nextScheduledSlot('', 'UTC', now), null);
  assert.equal(languageCode('English'), 'en');
  assert.equal(languageCode('pt-BR'), 'pt-BR');
});

test('videos are linked to profiles, including legacy videos via their story', async () => {
  const Story = {find: q => ({select: () => ({lean: async () => q._id.$in.map(id => ({_id: id, seriesId: id === 'st1' ? 'p1' : null}))}), distinct: async () => ['st1']})};
  const Series = {find: () => ({select: () => ({lean: async () => [{_id: 'p1', name: 'Kalyug'}, {_id: 'p2', name: 'Old', archived: true}]})})};
  const out = await resolveVideoProfiles([
    {_id: 'v1', seriesId: 'p2', status: 'PUBLISHED'},
    {_id: 'v2', storyId: 'st1', status: 'FAILED'},
    {_id: 'v3', storyId: 'st9', status: 'FAILED'},
    {_id: 'v4', storyId: {_id: 'st5', seriesId: 'p1'}, status: 'APPROVED'},
    {_id: 'v5', seriesId: 'gone', status: 'FAILED'}
  ], {Story, Series});
  assert.deepEqual(out.map(v => v.profile?.name ?? null), ['Old', 'Kalyug', null, 'Kalyug', 'Deleted profile']);
  assert.equal(out[0].profile.archived, true);
  assert.equal(out[1].profile.archived, false);
  const counts = countByProfile(out);
  assert.deepEqual(counts.p1, {total: 2, name: 'Kalyug', archived: false, FAILED: 1, APPROVED: 1});
  assert.equal(counts.p2.archived, true);
  assert.equal(counts.none.total, 1);
  const f = await profileVideoFilter('p1', {Story, isValidId: () => true});
  assert.deepEqual(f.$or[0], {seriesId: 'p1'});
  assert.deepEqual(f.$or[1].$and[1], {storyId: {$in: ['st1']}});
  assert.deepEqual(await profileVideoFilter('ALL', {Story, isValidId: () => true}), {});
  assert.deepEqual(await profileVideoFilter('x', {Story, isValidId: () => false}), {_id: null});
});

test('profile keeps caption, voice and content-rule settings', () => {
  const p = buildChannelProfile({name: 'K', channelProfile: {visual: {subtitles: 'off', subtitlePosition: 'top'}, narration: {voices: {gemini: 'Puck', openai: ''}}, content: {callToAction: 'Subscribe for daily stories'}, editorial: {avoidTopics: ['politics', ' ', 'gore']}}});
  assert.equal(p.visual.subtitles, 'off');
  assert.equal(p.visual.subtitlePosition, 'top');
  assert.deepEqual(p.narration.voices, {gemini: 'Puck'});
  assert.deepEqual(p.editorial.avoidTopics, ['politics', 'gore']);
  const d = profileDirectives(p);
  assert.match(d, /Subscribe for daily stories/);
  assert.match(d, /politics; gore/);
  const plain = buildChannelProfile({name: 'K', channelProfile: {visual: {subtitles: 'sometimes'}}});
  assert.equal(plain.visual.subtitles, 'default');
  assert.equal(plain.visual.subtitlePosition, 'default');
  assert.equal(profileDirectives(plain), '');
});
