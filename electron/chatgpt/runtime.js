import { randomUUID } from 'node:crypto';
import { ChatGPTError } from './errors.js';
import { apiRequest, buildRequest, consumeResponse, gameResult } from './inference.js';

export function createRuntime({ vault, oauth, fetchImpl = fetch }) {
  let state, queue = Promise.resolve(), changing = false, signInController;
  const running = new Set();
  const serial = task => {
    const next = queue.then(task); queue = next.catch(() => {}); return next;
  };
  const load = async () => { if (!state) { const loaded = await vault.read(); await vault.write(loaded); state = loaded; } return state; };
  const save = async () => vault.write(state);
  const profileById = id => {
    const profile = state.profiles.find(p => p.id === id);
    if (!profile) throw new ChatGPTError('sign_in_required');
    return profile;
  };
  const publicProfile = profile => ({
    id: profile.id, label: profile.label, email: profile.identity?.email || '',
    status: profile.tokens ? 'connected' : 'disconnected',
    sharing: Boolean(profile.tokens && !profile.pendingRefresh && profile.scopes?.includes('chatgpt.tokens.use.direct')),
  });
  const stop = () => { for (const controller of running) controller.abort(); };
  const mutate = async task => {
    if (changing) throw new ChatGPTError('busy');
    changing = true; stop();
    try { return await serial(async () => { await load(); return task(); }); }
    finally { changing = false; }
  };
  const credentials = async (profileId, signal) => serial(async () => {
    signal.throwIfAborted();
    await load();
    const profile = profileById(profileId);
    if (!profile.tokens) throw new ChatGPTError('sign_in_required');
    if (profile.pendingRefresh || profile.tokens.expiresAt < Date.now() + 60000) {
      const earliest = profile.tokens.earliestRefreshAt;
      const earliestMs = typeof earliest === 'number' ? earliest * 1000 : Date.parse(earliest || '');
      if (earliestMs > Date.now() && !profile.pendingRefresh) {
        if (profile.tokens.expiresAt <= Date.now()) throw new ChatGPTError('service_unavailable');
      } else {
        try {
          const updated = await oauth.refresh(profile, async pending => { profile.pendingRefresh = pending; await save(); }, signal);
          Object.assign(profile, updated); await save();
        } catch (error) {
          if (['sign_in_required', 'invalid_identity'].includes(error.code)) {
            // Keep identity and registration for explicit reauthorization.
            delete profile.tokens; delete profile.pendingRefresh; profile.scopes = []; await save();
          }
          throw error;
        }
      }
    }
    if (!profile.scopes?.includes('chatgpt.tokens.use.direct')) throw new ChatGPTError('sharing_not_enabled');
    if (profile.tokens.expiresAt <= Date.now()) throw new ChatGPTError('service_unavailable');
    return profile.tokens.access;
  });
  const withRequest = async (profileId, callerSignal, task) => {
    if (changing) throw new ChatGPTError('busy');
    const controller = new AbortController(); running.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000), ...(callerSignal ? [callerSignal] : [])]);
    try { const access = await credentials(profileId, signal); signal.throwIfAborted(); return await task(access, signal); }
    finally { running.delete(controller); }
  };
  const modelsWith = async (access, signal) => {
    const response = await apiRequest('models', access, { fetchImpl, signal });
    const data = await response.json();
    if (!Array.isArray(data.models)) throw new ChatGPTError('model_unavailable');
    return data.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string')
      .map(model => ({ slug: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug }));
  };
  return {
    snapshot: () => serial(async () => { await load(); return { activeId: state.activeId, profiles: state.profiles.map(publicProfile) }; }),
    signIn: (profileId, newProfile = false) => mutate(async () => {
      const profile = !newProfile && profileId ? profileById(profileId) : { id: randomUUID(), label: `Connection ${state.profiles.length + 1}`, scopes: [] };
      signInController = new AbortController();
      const signal = AbortSignal.any([signInController.signal, AbortSignal.timeout(10 * 60_000)]);
      try {
        const result = await oauth.signIn(profile, state.hostId, signal, async registered => {
          const existing = state.profiles.find(p => p.id === registered.id);
          if (existing) Object.assign(existing, registered); else state.profiles.push(registered);
          await save();
        });
        signal.throwIfAborted();
        const index = state.profiles.findIndex(p => p.id === result.id);
        state.profiles[index] = result; state.activeId = result.id; await save();
        return publicProfile(result);
      } finally { signInController = undefined; }
    }),
    cancelSignIn() { signInController?.abort(); },
    select: id => mutate(async () => { profileById(id); state.activeId = id; await save(); }),
    disconnect: id => mutate(async () => {
      const profile = profileById(id);
      const revoked = await oauth.revoke(profile);
      delete profile.tokens; delete profile.pendingRefresh; profile.scopes = [];
      await save(); return { revoked };
    }),
    models: (id, signal) => withRequest(id, signal, modelsWith),
    infer: (request, onEvent, signal) => withRequest(request?.profileId, signal, async (access, requestSignal) => {
      const models = await modelsWith(access, requestSignal);
      const model = request.model || models[0]?.slug;
      if (!model || !models.some(item => item.slug === model)) throw new ChatGPTError('model_unavailable');
      const body = buildRequest(request, model);
      const response = await apiRequest('responses', access, { fetchImpl, signal: requestSignal, body,
        onResponse: response => onEvent({ type: 'request', status: response.status, model }),
      });
      const completed = await consumeResponse(response, onEvent);
      return { result: gameResult(completed, request.tool?.name), model, usage: completed.usage };
    }),
    close() { signInController?.abort(); stop(); },
  };
}
