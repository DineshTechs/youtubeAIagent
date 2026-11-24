import test from 'node:test';
import assert from 'node:assert/strict';
import {describeNetworkError, isRetryableNetworkError} from '../src/utils/networkError.js';
import {createMcpClient} from '../src/services/media/mcpTts.js';

const fail = code => Object.assign(new TypeError('fetch failed'), {cause: Object.assign(new Error(`connect ${code}`), {code})});
const URL_ = 'https://app.aiawaaz.io/api/mcp';

test('"fetch failed" is explained from its real cause', () => {
  assert.match(describeNetworkError(fail('ENOTFOUND'), URL_), /could not look up app\.aiawaaz\.io \(DNS\)/);
  assert.match(describeNetworkError(fail('UND_ERR_CONNECT_TIMEOUT'), URL_), /allow outgoing HTTPS \(port 443\) to app\.aiawaaz\.io/);
  assert.match(describeNetworkError(fail('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), URL_), /certificate/);
  assert.match(describeNetworkError(new TypeError('fetch failed'), URL_), /failed before any answer/);
  assert.equal(isRetryableNetworkError(fail('ECONNRESET')), true);
  assert.equal(isRetryableNetworkError(fail('ENOTFOUND')), false);
});

test('AI Awaaz retries a dropped connection, then reports the reason', async () => {
  let calls = 0;
  const ok = () => new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: {tools: []}}), {status: 200, headers: {'content-type': 'application/json'}});
  const flaky = async () => { calls++; if (calls === 1) throw fail('ECONNRESET'); return ok(); };
  await createMcpClient({url: URL_, apiKey: 'k', sleep: async () => {}}, flaky).listTools();
  assert.ok(calls >= 2);
  const down = createMcpClient({url: URL_, apiKey: 'k', sleep: async () => {}}, async () => { throw fail('ETIMEDOUT'); });
  await assert.rejects(down.listTools(), /allow outgoing HTTPS \(port 443\) to app\.aiawaaz\.io/);
});
