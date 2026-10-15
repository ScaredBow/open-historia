import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { callbackListener, createOAuth, verifyIdentity, ISSUER } from '../electron/chatgpt/oauth.js';
import { createVault } from '../electron/chatgpt/vault.js';
import { createRuntime } from '../electron/chatgpt/runtime.js';
import { ChatGPTError, safeError, responseError } from '../electron/chatgpt/errors.js';
import { buildRequest, consumeResponse, gameResult } from '../electron/chatgpt/inference.js';
import { trustedSender, attachChatGPT } from '../electron/chatgpt/ipc.js';
import { EventEmitter } from 'node:events';

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const completed = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 5, output_tokens: 1 } } };
const profile = () => ({ id: 'p1', clientId: 'issued-1', label: 'Connection 1', identity: { subject: 'u1', email: 'test@example.com' }, scopes: ['chatgpt.tokens.use.direct'], tokens: { access: 'secret-access', refresh: 'secret-refresh', id: 'secret-id', expiresAt: Date.now() + 3600000 } });
const fixture = (overrides = {}) => {
  let saved = { version: 1, hostId: 'urn:uuid:00000000-0000-0000-0000-000000000000', profiles: [profile()], activeId: 'p1' };
  const vault = { read: async () => structuredClone(saved), write: async state => { saved = structuredClone(state); } };
  const runtime = createRuntime({ vault, oauth: {}, ...overrides });
  return { runtime, read: () => saved, vault };
};

test('loopback callback rejects foreign state, paths, duplicate parameters and replay', async () => {
  const listener = await callbackListener('expected', new AbortController().signal);
  try {
    assert.match(listener.uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.equal((await fetch(`${listener.uri}?state=wrong&code=secret`)).status, 400);
    assert.equal((await fetch(`${listener.uri}?state=expected&state=expected&code=secret`)).status, 400);
    assert.equal((await fetch(listener.uri.replace('/auth/callback', '/other'))).status, 404);
    assert.equal((await fetch(`${listener.uri}?state=expected&code=secret&client_id=issued`)).status, 200);
    assert.deepEqual(await listener.result, { code: 'secret', clientId: 'issued' });
    assert.equal((await fetch(`${listener.uri}?state=expected&code=secret`)).status, 400);
  } finally { listener.close(); }
});

test('callback cancellation and denial terminate without returning a code', async () => {
  const controller = new AbortController();
  const listener = await callbackListener('expected', controller.signal);
  controller.abort();
  await assert.rejects(listener.result, { code: 'cancelled' }); listener.close();
  const denied = await callbackListener('expected', new AbortController().signal);
  try {
    await fetch(`${denied.uri}?state=expected&error=access_denied&code=unused`);
    await assert.rejects(denied.result, { code: 'access_denied' });
  } finally { denied.close(); }
});

test('OAuth persists issued registration before exchange and uses exact redirect URI and PKCE', async () => {
  let auth, registered = false;
  const oauth = createOAuth({
    openBrowser: async url => {
      auth = new URL(url);
      assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(auth.searchParams.get('agent_name_hint'), 'Open Historia');
      assert.equal(auth.searchParams.get('ext_agent_host_id'), 'host-1');
      await fetch(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: auth.searchParams.get('state'), code: 'code-1', client_id: 'issued-1' })}`);
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, `${ISSUER}/api/accounts/oauth/token`); assert.equal(registered, true);
      assert.equal(options.body.get('client_id'), 'issued-1');
      assert.equal(options.body.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
      return json({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', id_token: 'i', expires_in: 3600, scope: 'openid' });
    },
    verifyToken: async (_token, client, nonce) => { assert.equal(client, 'issued-1'); assert.equal(nonce, auth.searchParams.get('nonce')); return { subject: 'u' }; },
  });
  const result = await oauth.signIn({ id: 'p' }, 'host-1', new AbortController().signal, async () => { registered = true; });
  assert.deepEqual(result.scopes, ['openid']);
});

test('returning OAuth rejects replacement client IDs before token exchange', async () => {
  let exchanged = false;
  const oauth = createOAuth({
    openBrowser: async url => {
      const auth = new URL(url);
      assert.equal(auth.searchParams.has('agent_name_hint'), false);
      assert.equal(auth.searchParams.get('id_token_hint'), 'secret-id');
      await fetch(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: auth.searchParams.get('state'), code: 'code', client_id: 'other' })}`);
    },
    fetchImpl: async () => { exchanged = true; },
  });
  await assert.rejects(oauth.signIn(profile(), 'host', new AbortController().signal, async () => {}), { code: 'invalid_callback' });
  assert.equal(exchanged, false);
});

test('ID token signature, issuer, audience, expiry, nonce and returning subject are verified', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const sign = (claims = {}, key = privateKey) => new SignJWT({ sub: 'u1', nonce: 'nonce', ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISSUER).setAudience('issued-1').setIssuedAt().setExpirationTime('5m').sign(key);
  const valid = await sign();
  assert.equal((await verifyIdentity(valid, publicKey, 'issued-1', 'nonce', 'u1')).subject, 'u1');
  for (const [client, nonce, subject] of [['wrong', 'nonce', 'u1'], ['issued-1', 'wrong', 'u1'], ['issued-1', 'nonce', 'other']]) {
    await assert.rejects(verifyIdentity(valid, publicKey, client, nonce, subject), { code: 'invalid_identity' });
  }
  const wrongKey = await generateKeyPair('RS256');
  await assert.rejects(verifyIdentity(await sign({}, wrongKey.privateKey), publicKey, 'issued-1', 'nonce'), { code: 'invalid_identity' });
  for (const token of [
    await new SignJWT({ sub: 'u1', nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://wrong.example').setAudience('issued-1').setIssuedAt().setExpirationTime('5m').sign(privateKey),
    await new SignJWT({ sub: 'u1', nonce: 'nonce' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISSUER).setAudience('issued-1').setIssuedAt().setExpirationTime(1).sign(privateKey),
  ]) await assert.rejects(verifyIdentity(token, publicKey, 'issued-1', 'nonce'), { code: 'invalid_identity' });
});

test('vault encrypts persisted state, survives restart, refuses basic_text and preserves unreadable files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oh-chatgpt-'));
  const key = randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString: buffer => { const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(); },
  };
  try {
    const vault = createVault(directory, safeStorage), state = await vault.read(); state.profiles.push(profile()); await vault.write(state);
    const bytes = await readFile(join(directory, 'accounts.enc'));
    assert.equal(bytes.includes(Buffer.from('secret-access')), false);
    assert.deepEqual(await createVault(directory, safeStorage).read(), state);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'accounts.enc'))).mode & 0o777, 0o600);
    await assert.rejects(createVault(directory, { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }).read(), { code: 'storage_unavailable' });
    await writeFile(join(directory, 'accounts.enc'), 'corrupt');
    await assert.rejects(vault.read(), { code: 'storage_invalid' });
    assert.equal(await readFile(join(directory, 'accounts.enc'), 'utf8'), 'corrupt');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('request conversion preserves tool history and pins streaming/storage policy', () => {
  const body = buildRequest({ systemPrompt: 'system', history: [
    { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { q: 1 } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-1', response: { answer: 2 } } }] },
  ], tool: { name: 'answer', schema: { type: 'object' } }, requireOutputTool: true, lookupTools: [{ name: 'lookup', schema: {} }], store: true, stream: false, maxTokens: 4096 }, 'allowed');
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  assert.equal(body.input[0].call_id, body.input[1].call_id);
  assert.equal(body.tools.length, 1); assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].name, 'open_historia');
  assert.deepEqual(body.tools[0].tools.map(tool => tool.name), ['answer']);
  assert.equal(body.tool_choice, 'required'); assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.input[0].namespace, 'open_historia');
});

test('stream requires completion and rejects interrupted, incomplete, malformed and late limit failures', async () => {
  assert.equal((await consumeResponse(sse([completed]))).status, 'completed');
  for (const events of [[], [{ type: 'response.output_text.delta', delta: 'partial' }], [{ type: 'response.incomplete' }]]) {
    await assert.rejects(consumeResponse(sse(events)), { code: 'incomplete' });
  }
  await assert.rejects(consumeResponse(sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), { code: 'subscription_sharing_usage_limit_exceeded' });
  await assert.rejects(consumeResponse(new Response('data: broken\n\n', { headers: { 'content-type': 'text/event-stream' } })), { code: 'incomplete' });
});

test('SSE handles boundaries across UTF-8 bytes and CRLF', async () => {
  const event = { ...completed, response: { ...completed.response, output: [{ type: 'message', content: [{ type: 'output_text', text: 'café' }] }] } };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(gameResult(await consumeResponse(response)).rawText, 'café');
});

test('completed tool output and lookup calls preserve game contract', () => {
  assert.deepEqual(gameResult({ output: [{ type: 'function_call', name: 'lookup', call_id: 'id', arguments: '{"q":"x"}' }] }, 'answer').lookupCalls, [{ id: 'id', name: 'lookup', args: { q: 'x' } }]);
  assert.deepEqual(gameResult({ output: [{ type: 'function_call', name: 'answer', call_id: 'id', arguments: '{"events":[]}' }] }, 'answer').toolInput, { events: [] });
  assert.throws(() => gameResult({ output: [{ type: 'function_call', name: 'answer', arguments: 'bad' }] }, 'answer'), { code: 'incomplete' });
});

test('runtime sends bearer only to public OpenAI endpoints and returns safe snapshots', async () => {
  const calls = [];
  const { runtime } = fixture({ fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, 'Bearer secret-access');
    return url.endsWith('/models') ? json({ models: [{ slug: 'allowed', display_name: 'Allowed', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }) : sse([completed]);
  } });
  const snapshot = JSON.stringify(await runtime.snapshot());
  assert.equal(/secret-|clientId|tokens/.test(snapshot), false);
  assert.equal((await runtime.models('p1')).length, 1);
  const response = await runtime.infer({ profileId: 'p1', model: 'allowed', systemPrompt: 's', history: [] }, () => {});
  assert.equal(response.result.rawText, 'Hello');
  assert.ok(calls.every(url => url === 'https://api.openai.com/v1/models' || url === 'https://api.openai.com/v1/responses'));
  await assert.rejects(runtime.infer({ profileId: 'p1', model: 'hidden', systemPrompt: '', history: [] }, () => {}), { code: 'model_unavailable' });
});

test('identity-only sign-in cannot perform inference', async () => {
  const { runtime, read, vault } = fixture(); const state = read(); state.profiles[0].scopes = ['openid']; await vault.write(state);
  assert.equal((await runtime.snapshot()).profiles[0].sharing, false);
  await assert.rejects(runtime.models('p1'), { code: 'sharing_not_enabled' });
});

test('concurrent requests serialize token refresh and preserve a checkpoint on network failure', async () => {
  let refreshes = 0;
  const { runtime, read, vault } = fixture({ oauth: { refresh: async (p, checkpoint) => {
    refreshes++; await checkpoint({ data: { refresh_token: 'rotated' }, receivedAt: Date.now() });
    return { ...p, pendingRefresh: undefined, tokens: { ...p.tokens, access: 'new-access', expiresAt: Date.now() + 3600000 } };
  } }, fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer new-access'); return json({ models: [] }); } });
  const state = read(); state.profiles[0].tokens.expiresAt = 1; await vault.write(state);
  await Promise.all([runtime.models('p1'), runtime.models('p1')]); assert.equal(refreshes, 1);
  assert.equal(read().profiles[0].pendingRefresh, undefined);
  const failing = fixture({ oauth: { refresh: async (_p, checkpoint) => { await checkpoint({ data: { refresh_token: 'replacement' } }); throw new ChatGPTError('network'); } } });
  const expired = failing.read(); expired.profiles[0].tokens.expiresAt = 1; await failing.vault.write(expired);
  await assert.rejects(failing.runtime.models('p1'), { code: 'network' });
  assert.equal(failing.read().profiles[0].pendingRefresh.data.refresh_token, 'replacement');
});

test('sign-out clears local credentials but retains registration and reports unconfirmed revocation', async () => {
  const { runtime, read } = fixture({ oauth: { revoke: async () => false } });
  assert.deepEqual(await runtime.disconnect('p1'), { revoked: false });
  assert.equal(read().profiles[0].tokens, undefined); assert.equal(read().profiles[0].clientId, 'issued-1');
  assert.equal((await runtime.snapshot()).profiles[0].sharing, false);
});

test('IPC rejects foreign windows, origins and subframes and redacts unknown errors', async () => {
  const frame = { url: 'http://localhost:3000/' };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, send() {} });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const event = { sender: contents, senderFrame: frame };
  assert.equal(trustedSender(event, window, 'http://localhost:3000'), true);
  assert.equal(trustedSender({ ...event, senderFrame: { url: frame.url } }, window, 'http://localhost:3000'), false);
  assert.equal(trustedSender(event, window, 'http://evil.example'), false);
  const handlers = new Map();
  attachChatGPT({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }, window,
    runtime: { snapshot: async () => { throw new Error('secret-access'); }, close() {} }, origin: 'http://localhost:3000' });
  const reply = await handlers.get('chatgpt:snapshot')(event);
  assert.equal(JSON.stringify(reply).includes('secret-access'), false);
  assert.equal((await handlers.get('chatgpt:snapshot')({})).ok, false);
  window.emit('closed'); assert.equal(handlers.size, 0);
  assert.equal(safeError(new Error('secret')).message.includes('secret'), false);
});

test('reasoning and tool output survive a store:false lookup round', async () => {
  const { appendLookupRound } = await import('../src/Game/AI/toolTurns.js');
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning', summary: [] },
    { type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{"q":"x"}' },
  ];
  const result = gameResult({ output }, 'answer');
  const history = appendLookupRound([], result.lookupCalls, [{ id: 'call_1', name: 'lookup', response: { found: true } }]);
  const body = buildRequest({ systemPrompt: '', history }, 'model');
  assert.deepEqual(body.input.slice(0, 2), output);
  assert.equal(body.input[2].type, 'function_call_output');
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
});

test('switching accounts cancels an in-flight request before it can return', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const { runtime, read, vault } = fixture({ fetchImpl: async (_url, { signal }) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const state = read(); state.profiles.push({ ...profile(), id: 'p2', clientId: 'issued-2' }); await vault.write(state);
  const request = runtime.models('p1');
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await began; await runtime.select('p2'); await rejected;
  assert.equal((await runtime.snapshot()).activeId, 'p2');
});

test('a failed initial host write cannot let sign-in start with an unpersisted host ID', async () => {
  let writes = 0, browserOpened = false;
  const runtime = createRuntime({ vault: {
    read: async () => ({ version: 1, hostId: 'host', profiles: [], activeId: null }),
    write: async () => { writes++; throw new ChatGPTError('storage_unavailable'); },
  }, oauth: { signIn: async () => { browserOpened = true; } } });
  await assert.rejects(runtime.snapshot(), { code: 'storage_unavailable' });
  await assert.rejects(runtime.signIn(), { code: 'storage_unavailable' });
  assert.equal(writes, 2); assert.equal(browserOpened, false);
});

const terminalRefreshCodes = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];
for (const code of terminalRefreshCodes) test(`refresh ${code} clears credentials and retains registration`, async () => {
  const oauth = createOAuth({ fetchImpl: async () => new Response(JSON.stringify({ error: code }), { status: 400 }) });
  const { runtime, read, vault } = fixture({ oauth });
  const state = read(); state.profiles[0].tokens.expiresAt = 1; await vault.write(state);
  await assert.rejects(runtime.models('p1'), { code: 'sign_in_required' });
  assert.equal(read().profiles[0].tokens, undefined);
  assert.equal(read().profiles[0].clientId, 'issued-1');
  assert.equal((await runtime.snapshot()).profiles[0].status, 'disconnected');
});

test('permission, eligibility, configuration and transient errors have distinct recovery', () => {
  for (const code of ['subscription_sharing_user_not_eligible', 'subscription_sharing_route_not_supported', 'subscription_sharing_unsupported_capability', 'invalid_client']) {
    assert.equal(responseError(code, 403).code, code);
  }
  for (const code of ['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']) {
    assert.equal(responseError(code, 403).code, 'authorization_context_invalid');
  }
  assert.equal(responseError(undefined, 403).code, 'permission_denied');
  assert.equal(responseError('subscription_sharing_user_unavailable', 503).code, 'service_unavailable');
  assert.equal(responseError('subscription_sharing_usage_unavailable', 503).code, 'subscription_sharing_usage_unavailable');
});

for (const sharing of [true, false]) test(`returning OAuth requests consent only when plan permission is missing (${sharing})`, async () => {
  const p = profile(); if (!sharing) p.scopes = ['openid'];
  const oauth = createOAuth({ openBrowser: async url => {
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('prompt'), sharing ? null : 'consent');
    assert.equal(auth.searchParams.get('client_id'), p.clientId);
    assert.ok(auth.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
    await fetch(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: auth.searchParams.get('state'), error: 'access_denied' })}`);
  } });
  await assert.rejects(oauth.signIn(p, 'host', new AbortController().signal, async () => {}), { code: 'access_denied' });
});

for (const action of ['cancel', 'select', 'disconnect', 'close']) test(`${action} preserves in-flight rotation without starting inference`, { timeout: 2000 }, async () => {
  let started, release, tokenSignal, revokedToken;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const oauth = createOAuth({ fetchImpl: async (_url, { signal }) => {
    tokenSignal = signal; started(); await gate;
    signal.throwIfAborted();
    return json({ access_token: 'new-access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
  } });
  oauth.revoke = async p => { revokedToken = p.tokens.refresh; return true; };
  let apiCalls = 0;
  const { runtime, read, vault } = fixture({ oauth, fetchImpl: async () => { apiCalls++; return json({ models: [] }); } });
  const state = read(); state.profiles[0].tokens.expiresAt = 1; await vault.write(state);
  const controller = new AbortController();
  const rejected = assert.rejects(runtime.models('p1', controller.signal), { name: 'AbortError' });
  await began;
  let mutation;
  if (action === 'cancel') controller.abort();
  else if (action === 'close') runtime.close();
  else mutation = runtime[action]('p1');
  assert.equal(tokenSignal.aborted, false);
  release(); await rejected; await mutation;
  assert.equal(apiCalls, 0);
  if (action === 'disconnect') {
    assert.equal(revokedToken, 'rotated'); assert.equal(read().profiles[0].tokens, undefined);
  } else {
    assert.equal(read().profiles[0].tokens.refresh, 'rotated');
    await runtime.models('p1'); assert.equal(apiCalls, 1);
  }
});

test('received rotation is checkpointed even if cancellation arrives before validation', async () => {
  const controller = new AbortController(); let saved;
  const oauth = createOAuth({ fetchImpl: async () => {
    controller.abort();
    return json({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', id_token: 'id', expires_in: 3600 });
  }, verifyToken: async () => { throw new ChatGPTError('network'); } });
  await assert.rejects(oauth.refresh(profile(), async pending => { saved = pending; }, controller.signal), { code: 'network' });
  assert.equal(saved.data.refresh_token, 'rotated');
});

for (const status of [401, 403, 429, 503]) test(`rejected Responses HTTP ${status} reaches request telemetry`, async () => {
  const events = [];
  const { runtime } = fixture({ fetchImpl: async url => url.endsWith('/models')
    ? json({ models: [{ slug: 'allowed', visibility: 'list' }] })
    : new Response('{}', { status }) });
  await assert.rejects(runtime.infer({ profileId: 'p1', history: [], systemPrompt: '' }, event => events.push(event)));
  assert.deepEqual(events, [{ type: 'request', status, model: 'allowed' }]);
});

test('missing SSE content type is allowed, incompatible types and incomplete bodies are rejected', async () => {
  const response = sse([completed]); response.headers.delete('content-type');
  assert.equal((await consumeResponse(response)).status, 'completed');
  const bad = sse([completed]); bad.headers.set('content-type', 'application/json');
  await assert.rejects(consumeResponse(bad), { code: 'incomplete' });
  const truncated = sse([{ type: 'response.output_text.delta', delta: 'partial' }]); truncated.headers.delete('content-type');
  await assert.rejects(consumeResponse(truncated), { code: 'incomplete' });
});

test('namespaced lookup calls replay their namespace without requiring reasoning output', async () => {
  const { appendLookupRound } = await import('../src/Game/AI/toolTurns.js');
  const output = [{ type: 'function_call', namespace: 'open_historia', name: 'lookup', call_id: 'call_1', arguments: '{"q":"x"}' }];
  const result = gameResult({ output }, 'answer');
  const history = appendLookupRound([], result.lookupCalls, [{ id: 'call_1', name: 'lookup', response: { found: true } }]);
  const body = buildRequest({ systemPrompt: '', history, tool: { name: 'answer', schema: {} }, lookupTools: [{ name: 'lookup', schema: {} }] }, 'model');
  assert.deepEqual(body.input[0], output[0]);
  assert.deepEqual(body.tools[0].tools.map(tool => tool.name), ['answer', 'lookup']);
  assert.equal(body.input[1].call_id, 'call_1');
});

test('vault replaces existing files, retries Windows locks, and preserves the old vault on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oh-vault-replace-'));
  // Encryption behavior is covered separately; this test isolates filesystem replacement.
  const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  try {
    const vault = createVault(directory, storage), state = await vault.read();
    await vault.write(state); state.profiles = [profile()]; await vault.write(state);
    state.profiles[0].tokens.refresh = 'rotated'; await vault.write(state);
    assert.deepEqual(await vault.read(), state);
    let attempts = 0;
    const retrying = createVault(directory, storage, { platform: 'win32', wait: async () => {}, renameFile: async (...args) => {
      if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      await rename(...args);
    } });
    delete state.profiles[0].tokens; await retrying.write(state);
    assert.equal(attempts, 3); assert.deepEqual(await vault.read(), state);
    const bytes = await readFile(join(directory, 'accounts.enc')); attempts = 0;
    const locked = createVault(directory, storage, { platform: 'win32', wait: async () => {}, renameFile: async () => {
      attempts++; throw Object.assign(new Error('locked'), { code: 'EACCES' });
    } });
    await assert.rejects(locked.write({ ...state, profiles: [] }), { code: 'storage_write_failed' });
    assert.equal(attempts, 5);
    assert.deepEqual(await readFile(join(directory, 'accounts.enc')), bytes);
    assert.deepEqual(await readdir(directory), ['accounts.enc']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unclassified main-process failures stay terminal through IPC and the fallback runner', async () => {
  const { callChatGPT } = await import('../src/desktop/chatgptClient.js');
  const { runWithFallback } = await import('../src/Game/AI/fallbackRunner.js');
  const frame = { url: 'http://localhost:3000/' };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, send() {} });
  const appWindow = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const handlers = new Map(); let failure;
  attachChatGPT({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }, window: appWindow,
    runtime: { infer: async () => { throw failure; }, close() {} }, origin: 'http://localhost:3000' });
  const before = globalThis.window;
  globalThis.window = { ohChatGPT: {
    onEvent: () => () => {},
    infer: (id, request) => handlers.get('chatgpt:infer')({ sender: contents, senderFrame: frame }, id, request),
  } };
  try {
    for (failure of [new Error('secret'), new TypeError('secret bug'), Object.assign(new Error('secret path'), { code: 'EACCES' }), new ChatGPTError('storage_write_failed')]) {
      let paid = false;
      await assert.rejects(runWithFallback({ entries: [{ id: 'plan' }, { id: 'paid' }], store: new Map(), attempt: async entry => {
        if (entry.id === 'paid') { paid = true; return 'paid'; }
        return callChatGPT('', [], { entrySettings: { chatgptProfileId: 'p1' } });
      } }), error => {
        assert.equal(error.code, failure instanceof ChatGPTError ? 'storage_write_failed' : 'internal_error');
        assert.equal(error.message.includes('secret'), false); return true;
      });
      assert.equal(paid, false);
    }
  } finally { globalThis.window = before; appWindow.emit('closed'); }
});

test('HTTP transport failures are classified explicitly; bugs, malformed data and aborts are not network failures', async () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']) {
    const { runtime } = fixture({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code } }); } });
    await assert.rejects(runtime.models('p1'), { code: 'network' });
  }
  for (const failure of [new Error('bug'), new TypeError('invalid argument'), new DOMException('cancelled', 'AbortError')]) {
    const { runtime } = fixture({ fetchImpl: async () => { throw failure; } });
    await assert.rejects(runtime.models('p1'), error => {
      assert.equal(safeError(error).code, failure.name === 'AbortError' ? 'cancelled' : 'internal_error'); return true;
    });
  }
  const { runtime } = fixture({ fetchImpl: async () => new Response('malformed', { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(runtime.models('p1'), error => { assert.equal(safeError(error).code, 'internal_error'); return true; });
});

test('refresh transport failure preserves credentials but unexpected identity verification errors stay terminal', async () => {
  const oauth = createOAuth({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); } });
  const { runtime, read, vault } = fixture({ oauth });
  const state = read(); state.profiles[0].tokens.expiresAt = 1; await vault.write(state);
  await assert.rejects(runtime.models('p1'), { code: 'network' });
  assert.equal(read().profiles[0].tokens.refresh, 'secret-refresh');
  const { privateKey } = await generateKeyPair('RS256');
  const token = await new SignJWT({ sub: 'u1' }).setProtectedHeader({ alg: 'RS256' }).setIssuer(ISSUER).setAudience('issued-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(verifyIdentity(token, async () => { throw new Error('unexpected'); }, 'issued-1'), error => {
    assert.equal(safeError(error).code, 'internal_error'); return true;
  });
});

test('vault directory and encryption failures are sanitized persistence errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oh-vault-errors-'));
  const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  try {
    const vault = createVault(directory, storage), state = await vault.read(); await vault.write(state);
    const bytes = await readFile(join(directory, 'accounts.enc'));
    const broken = createVault(directory, { ...storage, encryptString: () => { throw new Error('secret platform error'); } });
    await assert.rejects(broken.write(state), { code: 'storage_write_failed' });
    assert.deepEqual(await readFile(join(directory, 'accounts.enc')), bytes);
    assert.deepEqual(await readdir(directory), ['accounts.enc']);
    const invalidDirectory = join(directory, 'not-a-directory'); await writeFile(invalidDirectory, 'file');
    await assert.rejects(createVault(invalidDirectory, storage).write(state), { code: 'storage_write_failed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refresh without ID token retains verified identity and survives restart', async () => {
  let verifications = 0, checkpoint;
  const oauth = createOAuth({ fetchImpl: async () => json({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 }),
    verifyToken: async () => { verifications++; throw new Error('must not reverify the old ID token'); } });
  const previous = profile();
  const updated = await oauth.refresh(previous, async pending => { checkpoint = pending; });
  assert.deepEqual(updated.identity, previous.identity);
  assert.equal(updated.tokens.id, previous.tokens.id);
  assert.equal(updated.tokens.refresh, 'rotated');
  assert.deepEqual(updated.scopes, previous.scopes);
  assert.equal(verifications, 0);
  const restored = await oauth.refresh({ ...previous, pendingRefresh: checkpoint }, async () => { throw new Error('must reuse checkpoint'); });
  assert.deepEqual(restored, updated);
});

test('new refresh ID tokens are verified and pre-cancelled refresh never starts', async () => {
  let verified = false, fetched = 0;
  const oauth = createOAuth({ fetchImpl: async () => { fetched++; return json({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', id_token: 'new-id', expires_in: 3600 }); },
    verifyToken: async (token, client, nonce, subject) => {
      assert.equal(token, 'new-id'); assert.equal(client, 'issued-1'); assert.equal(subject, 'u1');
      assert.equal(nonce, undefined); verified = true; return { subject: 'u1', email: 'new@example.com' };
    } });
  const updated = await oauth.refresh(profile(), async () => {});
  assert.equal(verified, true); assert.equal(updated.tokens.id, 'new-id');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(oauth.refresh(profile(), async () => {}, controller.signal), { name: 'AbortError' });
  assert.equal(fetched, 1);
});

test('authorization-code exchange still requires an ID token', async () => {
  const oauth = createOAuth({ openBrowser: async url => {
    const auth = new URL(url);
    await fetch(`${auth.searchParams.get('redirect_uri')}?${new URLSearchParams({ state: auth.searchParams.get('state'), code: 'code', client_id: 'issued-1' })}`);
  }, fetchImpl: async () => json({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 }) });
  await assert.rejects(oauth.signIn({ id: 'p' }, 'host', new AbortController().signal, async () => {}), { code: 'invalid_identity' });
});

test('final output cannot silently bypass concurrent lookup calls', () => {
  const answer = { type: 'function_call', namespace: 'open_historia', name: 'answer', call_id: 'a', arguments: '{"events":[]}' };
  const lookup = { type: 'function_call', namespace: 'open_historia', name: 'lookup', call_id: 'b', arguments: '{}' };
  const request = buildRequest({ systemPrompt: '', history: [], tool: { name: 'answer', schema: {} }, lookupTools: [{ name: 'lookup', schema: {} }] }, 'model');
  assert.equal(request.parallel_tool_calls, false);
  for (const output of [[answer, lookup], [lookup, answer], [answer, { ...answer, call_id: 'c' }]]) {
    assert.throws(() => gameResult({ output }, 'answer'), { code: 'incomplete' });
  }
  assert.deepEqual(gameResult({ output: [answer] }, 'answer').toolInput, { events: [] });
  assert.equal(gameResult({ output: [lookup] }, 'answer').lookupCalls.length, 1);
});

for (const refreshToken of [undefined, '', null, 123]) test(`refresh requires a usable replacement token (${String(refreshToken)})`, async () => {
  const oauth = createOAuth({ fetchImpl: async () => json({ access_token: 'new', refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600 }) });
  const { runtime, read, vault } = fixture({ oauth });
  const state = read(); state.profiles[0].tokens.expiresAt = 1; await vault.write(state);
  await assert.rejects(runtime.models('p1'), { code: 'invalid_identity' });
  assert.equal(read().profiles[0].tokens, undefined);
  assert.equal((await runtime.snapshot()).profiles[0].status, 'disconnected');
});
