import test from 'node:test';
import assert from 'node:assert/strict';
import { callChatGPT } from './chatgptClient.js';
import { runWithFallback } from '../Game/AI/fallbackRunner.js';

const bridge = overrides => {
  let listener, removed = false;
  const api = { onEvent(fn) { listener = fn; return () => { removed = true; }; }, cancel: async () => ({ ok: true }),
    infer: async (id, request) => {
      assert.equal(request.profileId, 'p1'); assert.equal(request.apiKey, undefined);
      listener({ id, type: 'delta', delta: 'one' }); listener({ id, type: 'delta', delta: ' two' });
      return { ok: true, value: { result: { rawText: 'one two', toolInput: null } } };
    }, ...overrides };
  globalThis.window = { ohChatGPT: api };
  return { api, removed: () => removed };
};
test('renderer bridge preserves accumulated stream text and removes listeners', async () => {
  const mock = bridge(), chunks = [];
  assert.equal(await callChatGPT('system', [], { entrySettings: { chatgptProfileId: 'p1', apiKey: 'must-not-cross' }, onChunk: (delta, full) => chunks.push([delta, full]) }), 'one two');
  assert.deepEqual(chunks, [['one', 'one'], [' two', 'one two']]); assert.equal(mock.removed(), true);
});
test('plan usage failure cannot silently spend an API-key fallback', async () => {
  bridge({ infer: async () => ({ ok: false, error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Manage usage' } }) });
  let paid = false;
  await assert.rejects(runWithFallback({ entries: [{ id: 'plan' }, { id: 'paid' }], store: new Map(), attempt: async entry => {
    if (entry.id === 'paid') { paid = true; return 'paid'; }
    return callChatGPT('', [], { entrySettings: { chatgptProfileId: 'p1' } });
  } }), /Manage usage/);
  assert.equal(paid, false);
});
test('cancellation reaches main and cannot accept a late successful result', async () => {
  const controller = new AbortController(); let cancelled = false;
  const mock = bridge({ cancel: async () => { cancelled = true; }, infer: async () => {
    controller.abort(); return { ok: true, value: { result: { rawText: 'late' } } };
  } });
  await assert.rejects(callChatGPT('', [], { signal: controller.signal, entrySettings: { chatgptProfileId: 'p1' } }), { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(mock.removed(), true);
});
