import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ChatGPTError, responseError, fetchResponse, transportError } from './errors.js';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function callbackListener(state, signal) {
  signal.throwIfAborted();
  let resolve, reject, settled = false;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A browser-launch failure can happen before the caller awaits the callback.
  result.catch(() => {});
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400).end('Invalid callback'); return; }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || req.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      res.writeHead(404).end('Not found'); return;
    }
    const params = url.searchParams;
    if (settled || ['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1) || !equal(params.get('state'), state)) {
      res.writeHead(400).end('Invalid callback'); return;
    }
    settled = true;
    res.end('Return to Open Historia to see the sign-in result. You can close this tab.');
    if (params.has('error')) reject(new ChatGPTError(params.get('error') === 'access_denied' ? 'access_denied' : 'invalid_callback'));
    else if (!params.get('code')) reject(new ChatGPTError('invalid_callback'));
    else resolve({ code: params.get('code'), clientId: params.get('client_id') });
  });
  const cancel = () => { settled = true; reject(new ChatGPTError('cancelled')); server.close(); server.closeAllConnections(); };
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    result,
    uri: `http://127.0.0.1:${server.address()?.port}/auth/callback`,
    close() { signal.removeEventListener('abort', cancel); server.close(); server.closeAllConnections(); },
  };
}

export async function verifyIdentity(token, keys, clientId, nonce, subject, receivedAt) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'], clockTolerance: 30,
      ...(receivedAt ? { currentDate: new Date(receivedAt) } : {}),
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.iat > (receivedAt || Date.now()) / 1000 + 30 || (nonce && payload.nonce !== nonce) || (subject && payload.sub !== subject)
        || (payload.azp && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new ChatGPTError('invalid_identity');
    return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : '', name: typeof payload.name === 'string' ? payload.name : '' };
  } catch (error) {
    if (error.code === 'invalid_identity' || error.code?.startsWith('ERR_JWT') || error.code?.startsWith('ERR_JWS') || error.code === 'ERR_JOSE_ALG_NOT_ALLOWED') throw new ChatGPTError('invalid_identity');
    // A key-server outage must preserve the checkpointed rotating token.
    throw transportError(error);
  }
}

export function createOAuth({ fetchImpl = fetch, openBrowser, verifyToken } = {}) {
  let discovery, keys;
  const metadata = async () => {
    if (!discovery) {
      const response = await fetchResponse(fetchImpl, `${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new ChatGPTError('network');
      const data = await response.json();
      if (data.issuer !== ISSUER) throw new ChatGPTError('invalid_identity');
      for (const field of ['jwks_uri', 'revocation_endpoint']) {
        const url = new URL(data[field]);
        if (url.origin !== ISSUER || url.username || url.password) throw new ChatGPTError('invalid_identity');
      }
      discovery = data;
    }
    return discovery;
  };
  const verify = verifyToken || (async (token, clientId, nonce, subject, receivedAt) => {
    const meta = await metadata();
    keys ||= createRemoteJWKSet(new URL(meta.jwks_uri));
    return verifyIdentity(token, keys, clientId, nonce, subject, receivedAt);
  });
  const tokenRequest = async (params, signal) => {
    const response = await fetchResponse(fetchImpl, TOKEN_URL, { method: 'POST', body: new URLSearchParams({ ...params, resource: RESOURCE }), signal, redirect: 'error' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(data.error, response.status);
    if (typeof data.access_token !== 'string' || !data.access_token || data.token_type?.toLowerCase() !== 'bearer'
        || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || typeof data.id_token !== 'string'
        || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string')) throw new ChatGPTError('invalid_identity');
    return data;
  };
  const validated = async (data, profile, nonce, receivedAt = Date.now()) => {
    const identity = await verify(data.id_token, profile.clientId, nonce, profile.identity?.subject, receivedAt);
    return { ...profile, identity, tokens: {
      access: data.access_token, refresh: data.refresh_token || profile.tokens?.refresh,
      id: data.id_token, expiresAt: receivedAt + data.expires_in * 1000,
      earliestRefreshAt: data.earliest_refresh_at,
    }, scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/) : (nonce ? [] : profile.scopes || []), pendingRefresh: undefined };
  };
  return {
    async signIn(profile, hostId, signal, saveRegistration) {
      const state = random(), nonce = random(), verifier = random();
      const listener = await callbackListener(state, signal);
      try {
        const url = new URL(`${ISSUER}/api/accounts/authorize`);
        url.search = new URLSearchParams({
          client_id: profile.clientId || 'dynamic_agent_client',
          ...(!profile.clientId ? { agent_name_hint: 'Open Historia' } : {}),
          ext_agent_host_id: hostId, response_type: 'code', redirect_uri: listener.uri,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          ...(profile.clientId && !profile.scopes?.includes('chatgpt.tokens.use.direct') ? { prompt: 'consent' } : {}),
          ...(profile.tokens?.id ? { id_token_hint: profile.tokens.id } : {}),
          ...(profile.identity?.email ? { login_hint: profile.identity.email } : {}),
        }).toString();
        signal.throwIfAborted();
        await openBrowser(url.href);
        const callback = await listener.result;
        const clientId = callback.clientId || profile.clientId;
        if (!clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9._:-]{1,512}$/.test(clientId) || (profile.clientId && profile.clientId !== clientId)) throw new ChatGPTError('invalid_callback');
        const registered = { ...profile, clientId };
        await saveRegistration(registered);
        const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: callback.code, code_verifier: verifier, redirect_uri: listener.uri }, signal);
        return await validated(data, registered, nonce);
      } finally { listener.close(); }
    },
    async refresh(profile, checkpoint, callerSignal) {
      const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(callerSignal ? [callerSignal] : [])]);
      signal.throwIfAborted();
      // Persist received rotation before verifying identity; a JWKS outage must
      // not discard the only valid successor refresh token. It is never used
      // for inference until validation succeeds, including after a restart.
      let pending = profile.pendingRefresh;
      if (!pending) {
        if (!profile.tokens?.refresh) throw new ChatGPTError('sign_in_required');
        pending = { data: await tokenRequest({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.tokens.refresh }, signal), receivedAt: Date.now() };
        await checkpoint(pending);
      }
      return validated(pending.data, profile, undefined, pending.receivedAt);
    },
    async revoke(profile) {
      if (!profile.tokens?.refresh && !profile.pendingRefresh?.data.refresh_token) return true;
      try {
        const meta = await metadata();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetchResponse(fetchImpl, meta.revocation_endpoint, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
              body: new URLSearchParams({ token: profile.pendingRefresh?.data.refresh_token || profile.tokens.refresh, token_type_hint: 'refresh_token', client_id: profile.clientId }),
            });
            if (response.status === 200) return true;
            if (response.status < 500) return false;
          } catch { /* One bounded retry before local sign-out. */ }
          if (!attempt) await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch { /* The UI explains unconfirmed remote revocation. */ }
      return false;
    },
  };
}
