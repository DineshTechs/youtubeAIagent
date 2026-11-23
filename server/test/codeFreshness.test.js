import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newestFileTime, codeChangedSinceStart} from '../src/utils/codeFreshness.js';

test('dashboard is told to restart when code changed after the backend started', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'x.js'), '1');
  const t = newestFileTime(dir);
  assert.ok(t > 0);
  assert.equal(codeChangedSinceStart(dir, {now: 1e15, startedAt: t + 60000}), false);
  assert.equal(codeChangedSinceStart(dir, {now: 2e15, startedAt: t - 60000}), true);
});
