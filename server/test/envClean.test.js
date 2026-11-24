import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanEnvValue} from '../src/config/env.js';

// Regression 2026-11-24 (server): every provider answered 401 "API key not valid".
test('keys pasted with quotes, spaces or line breaks are cleaned', () => {
  assert.equal(cleanEnvValue('"AIzaSyAbc123"'), 'AIzaSyAbc123');
  assert.equal(cleanEnvValue(" 'sk-proj-abc' \n"), 'sk-proj-abc');
  assert.equal(cleanEnvValue('﻿cf-token\r\n'), 'cf-token');
  assert.equal(cleanEnvValue('"\'nested\'"'), 'nested');
  assert.equal(cleanEnvValue('mongodb+srv://u:p@x/db?retryWrites=true'), 'mongodb+srv://u:p@x/db?retryWrites=true');
  assert.equal(cleanEnvValue('ab"c'), 'ab"c', 'quotes inside a value are kept');
});
