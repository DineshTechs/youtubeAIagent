import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSeo,applySeoRules,seoReport,generateUploadSeo,isShortForm,seoInstruction,hashtagOf} from '../src/services/youtube/uploadSeo.js';
import {buildUploadMetadata,normalizeUploadSettings} from '../src/services/uploadSettings.js';

test('extractSeo normalizes the shapes models return', () => {
  assert.equal(extractSeo(null), null);
  assert.equal(extractSeo({foo: 1}), null);
  const a = extractSeo({seo: {seoTitle: 'T', videoDescription: 'D', keywords: 'a, b', hash_tags: [], search_queries: ['q1']}});
  assert.equal(a.title, 'T');
  assert.equal(a.description, 'D');
  assert.deepEqual(a.tags, ['a', 'b']);
  assert.equal(a.focusKeyword, 'q1');
  const b = extractSeo({title: 'X', tags: [{text: 'one'}, ''], hashtags: ['shorts', '#Hindi Kahani'], focusKeyword: 'kalyug story'});
  assert.deepEqual(b.tags, ['one']);
  assert.deepEqual(b.hashtags, ['#shorts', '#HindiKahani']);
  assert.equal(hashtagOf('# नैतिक कहानी'), '#नैतिककहानी');
});

test('rules: keyword tag first, hashtags appended once, #shorts for Shorts, limits kept', () => {
  const meta = {title: 'कलयुग की सच्ची कहानी #shorts', description: 'First line about कलयुग कहानी\n\n\n\nMore text #Kahani', tags: ['Kahani', 'kahani', '#story', 'x'.repeat(120)]};
  const out = applySeoRules(meta, {focusKeyword: 'कलयुग कहानी', isShort: true, hashtags: ['kahani', 'hindi']});
  assert.equal(out.title, 'कलयुग की सच्ची कहानी');
  assert.ok(!out.description.includes('\n\n\n'));
  assert.match(out.description, /#shorts #hindi$/);
  assert.equal((out.description.match(/#kahani/gi) || []).length, 1);
  assert.deepEqual(out.tags, ['कलयुग कहानी', 'Kahani', 'story']);
  const many = applySeoRules({title: 't', description: 'd', tags: Array.from({length: 200}, (_, i) => `tag ${i}`)}, {});
  const chars = many.tags.reduce((n, t) => n + t.length + 2, 0) + many.tags.length;
  assert.ok(chars <= 500);
  assert.equal(applySeoRules({title: 'x'.repeat(150), description: '', tags: []}, {}).title.length, 100);
});

test('report scores keyword placement and hygiene', () => {
  const good = applySeoRules({title: 'Kalyug story: the honest woodcutter', description: 'Kalyug story of an honest woodcutter who refuses gold.\nA short Hindi moral tale about truth and greed.\nSubscribe for a new story every day.', tags: ['woodcutter', 'moral story', 'hindi story', 'kalyug', 'honesty'], defaultLanguage: 'hi'}, {focusKeyword: 'Kalyug story', isShort: true, hashtags: ['kahani']});
  const r = seoReport({...good, defaultLanguage: 'hi'}, {focusKeyword: 'Kalyug story', isShort: true});
  assert.equal(r.score, 100, JSON.stringify(r.checks.filter(c => !c.ok)));
  const bad = seoReport({title: 'WATCH THIS NOW', description: '', tags: []}, {focusKeyword: '', isShort: true});
  assert.ok(bad.score < 30);
  assert.ok(bad.checks.find(c => c.id === 'shorts'));
  assert.ok(!seoReport({title: 'a', description: '', tags: []}, {isShort: false}).checks.find(c => c.id === 'shorts'));
});

test('AI SEO is generated in the channel language and grounded in narration', async () => {
  let seen;
  const provider = {generateJson: async (instruction, input, label) => { seen = {instruction, input, label}; return {focusKeyword: 'ईमानदार लकड़हारा', title: 'ईमानदार लकड़हारा और सोने की कुल्हाड़ी', description: 'ईमानदार लकड़हारा...', tags: ['लकड़हारा'], hashtags: ['shorts'], searchQueries: ['honest woodcutter story hindi']}; }};
  const seo = await generateUploadSeo({provider, story: {title: 'T', scenes: [{narration: 'एक लकड़हारा था'}, {narration: 'उसने सच बोला'}]}, series: {name: 'Kalyug', language: 'Hindi'}, profile: {language: 'Hindi', niche: 'Moral stories'}, settings: {seoKeywords: ['hindi kahani']}, isShort: true});
  assert.equal(seen.label, 'upload-seo');
  assert.match(seen.instruction, /in Hindi/);
  assert.match(seen.instruction, /#shorts/);
  assert.equal(seen.input.narration, 'एक लकड़हारा था उसने सच बोला');
  assert.deepEqual(seen.input.channelKeywords, ['hindi kahani']);
  assert.equal(seo.focusKeyword, 'ईमानदार लकड़हारा');
  assert.equal(seo.language, 'Hindi');
  await assert.rejects(generateUploadSeo({provider: {generateJson: async () => ({})}, story: {}, isShort: false}), /no usable SEO/);
  assert.doesNotMatch(seoInstruction({language: 'English', isShort: false}), /#shorts/);
});

test('upload metadata prefers AI SEO, then generation SEO, and accepts edited tags', () => {
  const settings = normalizeUploadSettings({tags: ['profile'], seoKeywords: ['channel kw']});
  const story = {title: 'Story title', youtubeOptimization: {seo: {description: 'old desc', tags: ['old']}}};
  const withAi = buildUploadMetadata({story, settings, seo: {title: 'AI title', description: 'AI desc', tags: ['ai']}});
  assert.equal(withAi.title, 'AI title');
  assert.match(withAi.description, /^AI desc/);
  assert.deepEqual(withAi.tags, ['profile', 'ai', 'old', 'channel kw']);
  const noAi = buildUploadMetadata({story, settings});
  assert.equal(noAi.title, 'Story title');
  assert.match(noAi.description, /^old desc/);
  assert.deepEqual(buildUploadMetadata({story, settings, opts: {tags: ['mine', '#x']}}).tags, ['mine', 'x']);
  assert.equal(isShortForm({durationSec: 55, aspectRatio: '9:16'}), true);
  assert.equal(isShortForm({durationSec: 600, aspectRatio: '16:9'}), false);
});
