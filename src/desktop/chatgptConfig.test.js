import test from 'node:test';
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
const without = await import('../Game/AI/providerConfig.js?without-desktop');
assert.equal(without.PROVIDER_OPTIONS.some(item => item.value === 'chatgpt'), false);
globalThis.window = { ohChatGPT: {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const config = await import('../Game/AI/providerConfig.js?with-desktop');
test('only the desktop offers a ChatGPT provider and stores only an opaque profile ID', () => {
  assert.equal(config.PROVIDER_OPTIONS.some(item => item.value === 'chatgpt'), true);
  assert.equal(config.providerSetupRequirement('chatgpt'), 'chatgptProfileId');
  const id = config.addConnection({ provider: 'chatgpt', chatgptProfileId: 'p1', apiKey: 'discard-me' });
  config.addEntry({ connectionId: id, model: 'selected-model' });
  const connection = config.getConnections().find(item => item.id === id);
  assert.equal(connection.apiKey, ''); assert.equal(connection.chatgptProfileId, 'p1');
  const entry = config.getResolvedFallbackList().find(item => item.connectionId === id);
  assert.equal(entry.chatgptProfileId, 'p1'); assert.equal(entry.model, 'selected-model');
  assert.equal(config.isFallbackListConfigured(), true);
});
