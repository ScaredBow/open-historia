import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { encode, decode } from './archive.js';

test('transfer preserves nested saves, binary views, dates, blobs and undefined', async () => {
  const original = { map: new Blob(['world'], { type: 'application/json' }), array: new Uint16Array([1, 65535]), date: new Date('2026-01-01'), list: [1, undefined, null, { type: 'bytes', data: 'ordinary game content' }] };
  const restored = decode(JSON.parse(JSON.stringify(await encode(original))));
  assert.equal(await restored.map.text(), 'world'); assert.equal(restored.map.type, 'application/json');
  assert.deepEqual(restored.array, original.array); assert.deepEqual(restored.date, original.date); assert.deepEqual(restored.list, original.list);
});
test('typed save decoding rejects constructors and deeply nested payloads', async () => {
  assert.throws(() => decode({ type: 'view', name: 'constructor', data: {} }));
  assert.throws(() => decode({ type: 'unknown' }));
  let value = {}; for (let i = 0; i < 66; i++) value = [value];
  await assert.rejects(encode(value));
  const prototype = decode({ type: 'object', data: [['__proto__', { type: 'object', data: [['admin', true]] }]] });
  assert.equal({}.admin, undefined); assert.equal(Object.hasOwn(prototype, '__proto__'), true);
});
test('native bridge exposes only named operations and isolates observer failures', async () => {
  const calls = [], sandbox = { window: { webkit: { messageHandlers: { historia: { postMessage: async value => { calls.push(value); return { ok: true, value: [] }; } } } } } };
  vm.runInNewContext(fs.readFileSync(new URL('../../apple/Resources/bridge.js', import.meta.url), 'utf8').replaceAll('__IS_CLIP__', 'true'), sandbox);
  const bridge = sandbox.window.ohChatGPT;
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(bridge.token, undefined); assert.equal(bridge.fetch, undefined);
  await bridge.signIn(undefined, true); assert.equal(calls[0].method, 'signIn'); assert.equal(calls[0].args[0], null);
  let received = 0; bridge.onEvent(() => { throw new Error('observer failed'); });
  const stop = bridge.onEvent(() => { received++; });
  sandbox.window.__ohNativeEvent({ type: 'delta' }); stop(); sandbox.window.__ohNativeEvent({ type: 'delta' }); assert.equal(received, 1);
  assert.equal(sandbox.window.ohApple.clip, true);
});
test('ordinary website build cannot opt itself into native ChatGPT code', () => {
  const config = fs.readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /'import.meta.env.VITE_OH_APPLE': JSON.stringify\(mode === 'ios'\)/);
  const code = fs.readFileSync(new URL('../Game/AI/providerConfig.js', import.meta.url), 'utf8');
  assert.match(code, /VITE_OH_APPLE\) && globalThis.window\?\.ohChatGPT/);
});
