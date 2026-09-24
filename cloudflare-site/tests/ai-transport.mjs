import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { AI_OUTPUT_TOKENS, AI_RESPONSE_LIMITS, fetchAiResponse, outputTokenBudget } from '../src/ai-transport.js';

const encoder = new TextEncoder();
assert.equal(AI_RESPONSE_LIMITS.timeoutMs, 25000);
assert.equal(AI_RESPONSE_LIMITS.maxBytes, 2 * 1024 * 1024);
assert.equal(outputTokenBudget(undefined), 2500);
assert.equal(outputTokenBudget(1), 1);
assert.equal(outputTokenBudget(4000), 4000);
for (const invalid of [0, -1, 1.2, 4001, '3000', null, true, {}, NaN, Infinity]) {
  assert.throws(() => outputTokenBudget(invalid), (error) => error.status === 400);
}

// Receiving headers is not completion: a stalled body must still hit deadline.
{
  let cancelled = false, signal;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('{"choices":')); },
    cancel() { cancelled = true; }
  });
  const started = Date.now();
  await assert.rejects(fetchAiResponse('https://mock.invalid', {}, {
    timeoutMs: 30, maxBytes: 1024,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Response(body); }
  }), (error) => error.status === 504 && /超时/.test(error.message));
  assert.ok(Date.now() - started < 1500, 'A body stall must not run beyond the short test deadline');
  assert.ok(signal.aborted); assert.ok(cancelled, 'Timed-out response body is cancelled');
}

// A transport that ignores abort is also bounded, without waiting for headers.
{
  let signal;
  await assert.rejects(fetchAiResponse('https://mock.invalid', {}, {
    timeoutMs: 20,
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); }
  }), (error) => error.status === 504);
  assert.ok(signal.aborted);
}

// No Content-Length is required: count chunks and stop before reading it all.
{
  let cancelled = false, pulled = 0, signal;
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  await assert.rejects(fetchAiResponse('https://mock.invalid', {}, {
    maxBytes: 32, timeoutMs: 500,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Response(body); }
  }), (error) => error.status === 502 && /过大/.test(error.message));
  assert.equal(pulled, 2, 'The endless body is not buffered in full');
  assert.ok(cancelled); assert.ok(signal.aborted);
}

// Reject a declared oversized body before consuming any bytes.
{
  let cancelled = false, pulled = false;
  const body = new ReadableStream({ pull() { pulled = true; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(fetchAiResponse('https://mock.invalid', {}, {
    maxBytes: 32,
    fetchImpl: async () => new Response(body, { headers: { 'Content-Length': '33' } })
  }), (error) => error.status === 502);
  assert.ok(cancelled); assert.equal(pulled, false);
}

// Content at the limit succeeds, combining multiple chunks without truncation.
{
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('1234')); controller.enqueue(encoder.encode('5678')); controller.close();
  } });
  const result = await fetchAiResponse('https://mock.invalid', {}, { maxBytes: 8, fetchImpl: async () => new Response(body) });
  assert.equal(result.status, 200); assert.equal(new TextDecoder().decode(result.output), '12345678');
}

// Error responses are cancelled; upstream messages must not leak to clients.
{
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchAiResponse('https://mock.invalid', {}, { fetchImpl: async () => new Response(body, { status: 429 }) }),
    (error) => error.status === 502 && !error.message.includes('429'));
  assert.ok(cancelled);
}

// Exercise the real Worker route using a local session/database stub. No model
// endpoint or actual credential is read or contacted by this test.
{
  const member = { id: 'transport-test-member', display_name: '本地测试成员', role: 'developer', must_change_password: 0 };
  const env = {
    SHIJIAN_BASE_URL: 'https://mock.invalid/v1', SHIJIAN_API_KEY: 'local-fixture-only', SHIJIAN_MODEL: 'local-fixture-model',
    DB: { prepare(query) {
      const statement = { bind() { return statement; }, async first() {
        if (query === 'SELECT 1 AS ok') return 1;
        if (query.startsWith('SELECT u.*')) return member;
        if (query === 'SELECT system_prompt FROM team_settings WHERE id=1') return { system_prompt: '本地规则' };
        throw new Error('Unexpected test database query');
      } };
      return statement;
    } }
  };
  const nativeFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://mock.invalid/v1/chat/completions');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"local fixture"}' } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const call = async (extra = {}) => worker.fetch(new Request('https://team.example/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://team.example', Cookie: '__Host-shijian_session=' + 'a'.repeat(64) },
    body: JSON.stringify({ messages: [{ role: 'user', content: '本地测试题目' }], ...extra })
  }), env);
  try {
    assert.equal((await call()).status, 200);
    assert.equal(calls[0].max_tokens, AI_OUTPUT_TOKENS.default);
    assert.equal(calls[0].messages[0].content, '本地规则');
    assert.equal((await call({ max_tokens: 4000 })).status, 200);
    assert.equal(calls[1].max_tokens, AI_OUTPUT_TOKENS.max);
    for (const value of [0, -1, 1.2, 4001, '3000', null]) {
      const response = await call({ max_tokens: value });
      assert.equal(response.status, 400); assert.match((await response.json()).error, /max_tokens/);
    }
    assert.equal(calls.length, 2, 'Invalid budgets never reach the upstream transport');
  } finally { globalThis.fetch = nativeFetch; }
}

console.log('AI transport passed: full-response deadline, bounded streaming and cancellation, token defaults/limits, Worker integration; no external model calls.');
