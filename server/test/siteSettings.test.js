import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSite, publicSite, SITE_DEFAULTS} from '../src/services/siteSettings.js';

test('contact details are cleaned and checked before saving', () => {
  const s = normalizeSite({email: 'help@aivideomanager.com', whatsapp: '+91 98765-43210', telegram: 'https://t.me/aivm_support', instagram: '@ai.video.manager', refund: '  Full refund within 7 days.  '});
  assert.equal(s.whatsapp, '919876543210');
  assert.equal(s.telegram, 'aivm_support');
  assert.equal(s.instagram, 'ai.video.manager');
  assert.equal(s.refund, 'Full refund within 7 days.');
  assert.equal(s.brand, 'AI Video Manager');
  assert.throws(() => normalizeSite({email: 'not-an-email'}), /Email: that is not a valid/);
  assert.throws(() => normalizeSite({whatsapp: '12'}), /country code/);
  assert.throws(() => normalizeSite({telegram: 'a b'}), /username only/);
  assert.throws(() => normalizeSite({refund: 'x'.repeat(601)}), /under 600/);
});

test('fields that are not sent keep their saved value; blank brand falls back', () => {
  const saved = normalizeSite({email: 'a@b.co', brand: 'My Brand'});
  const next = normalizeSite({whatsapp: '919876543210'}, saved);
  assert.equal(next.email, 'a@b.co');
  assert.equal(normalizeSite({brand: ''}, saved).brand, 'AI Video Manager');
  assert.deepEqual(Object.keys(publicSite(SITE_DEFAULTS)).sort(), Object.keys(SITE_DEFAULTS).sort());
  assert.equal(normalizeSite({business: 'A\u0000B'}).business, 'AB');
});
