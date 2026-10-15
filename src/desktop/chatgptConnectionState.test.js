import test from 'node:test';
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
globalThis.window = { ohChatGPT: {}, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
const config = await import('../Game/AI/providerConfig.js');
const { bindChatGPTProfile, selectedChatGPTModel } = await import('./chatgptConnectionState.js');

test('reconnecting preserves each saved model; switching accounts resets models and suggestion', () => {
  const id = config.addConnection({ provider: 'chatgpt', chatgptProfileId: 'p1', suggestedModel: 'first' });
  config.addEntry({ connectionId: id, model: 'first' });
  config.addEntry({ connectionId: id, model: 'second' });
  bindChatGPTProfile(id, 'p1');
  assert.deepEqual(config.entriesUsingConnection(id).map(entry => entry.model), ['first', 'second']);
  bindChatGPTProfile(id, 'p2');
  assert.deepEqual(config.entriesUsingConnection(id).map(entry => entry.model), ['', '']);
  assert.equal(config.getConnections().find(c => c.id === id).suggestedModel, '');
});

test('model selection reflects saved entries, mixed models, automatic selection, and empty connections', () => {
  const connection = { suggestedModel: 'old' };
  assert.equal(selectedChatGPTModel(connection, [{ model: 'saved' }, { model: 'saved' }]), 'saved');
  assert.equal(selectedChatGPTModel(connection, [{ model: 'a' }, { model: 'b' }]), '');
  assert.equal(selectedChatGPTModel(connection, [{ model: '' }]), '');
  assert.equal(selectedChatGPTModel(connection, []), 'old');
});
