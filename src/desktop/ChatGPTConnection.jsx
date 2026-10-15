import React, { useCallback, useEffect, useRef, useState } from 'react';
import { unwrap } from './chatgptClient.js';
import { updateConnection, entriesUsingConnection, updateEntry } from '../Game/AI/providerConfig.js';

import { bindChatGPTProfile, selectedChatGPTModel } from './chatgptConnectionState.js';

const button = { background: '#fff', color: '#111', border: '1px solid #888', borderRadius: 8, padding: '9px 14px', cursor: 'pointer', font: 'inherit' };
const select = { width: '100%', padding: 9, borderRadius: 6, background: '#222', color: '#fff', margin: '8px 0' };

export default function ChatGPTConnection({ connection }) {
  const bridge = window.ohChatGPT;
  const [profiles, setProfiles] = useState([]);
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const id = connection.chatgptProfileId;
  const profile = profiles.find(item => item.id === id);
  const refresh = useCallback(async (profileId = id) => {
    const revision = ++generation.current;
    const state = await unwrap(bridge.snapshot());
    if (revision !== generation.current) return;
    setProfiles(state.profiles); setModels([]);
    const selected = state.profiles.find(item => item.id === profileId);
    if (selected?.sharing) {
      const catalog = await unwrap(bridge.models(profileId));
      if (revision === generation.current) setModels(catalog);
    }
  }, [bridge, id]);
  useEffect(() => {
    void refresh().catch(error => { setMessage(error.message); setFailed(true); });
    // This is a request-generation counter, not a DOM ref. Invalidate pending reads.
    const counter = generation;
    return () => { counter.current++; };
  }, [refresh]);
  const run = async task => {
    setBusy(true); setFailed(false); setMessage('');
    try { await task(); }
    catch (error) { setFailed(true); setMessage(error.message); }
    finally { setBusy(false); setSigningIn(false); }
  };
  const bind = profileId => bindChatGPTProfile(connection.id, profileId);
  const entries = entriesUsingConnection(connection.id);
  const selectedModel = selectedChatGPTModel(connection, entries);
  const mixedModels = new Set(entries.map(entry => entry.model || '')).size > 1;
  const signIn = newProfile => run(async () => {
    setSigningIn(true);
    const signed = await unwrap(bridge.signIn(newProfile ? undefined : id, newProfile));
    bind(signed.id); await refresh(signed.id);
  });
  return <section aria-label="ChatGPT connection" style={{ padding: 14, border: '1px solid #666', borderRadius: 10, marginBottom: 16 }}>
    <strong>Use your ChatGPT plan</strong>
    <p>Continue with an eligible ChatGPT account and allow Open Historia to use your plan. No API key is needed. Your account’s usage limits apply.</p>
    <label>ChatGPT account
      <select aria-label="ChatGPT account" style={select} value={id || ''} disabled={busy} onChange={event => {
        const next = event.target.value;
        void run(async () => { await unwrap(bridge.select(next)); bind(next); await refresh(next); });
      }}>
        <option value="" disabled>Choose an account or sign in</option>
        {profiles.map(item => <option key={item.id} value={item.id}>{item.label} — {item.email || item.status}</option>)}
      </select>
    </label>
    <p role="status">{profile?.sharing ? 'Connected · ChatGPT plan usage enabled' : profile?.status === 'connected' ? 'Connected · ChatGPT plan usage is not enabled' : 'Not connected'}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" style={button} disabled={busy} onClick={() => void signIn(false)}>{profile ? 'Reconnect with ChatGPT' : 'Continue with ChatGPT'}</button>
      {profiles.length > 0 && <button type="button" style={button} disabled={busy} onClick={() => void signIn(true)}>Add account</button>}
      {signingIn && <button type="button" style={button} onClick={() => void unwrap(bridge.cancelSignIn()).catch(() => {})}>Cancel sign-in</button>}
      <button type="button" style={button} onClick={() => void unwrap(bridge.manageUsage()).catch(error => { setFailed(true); setMessage(error.message); })}>Manage usage</button>
      {profile?.status === 'connected' && <button type="button" style={button} disabled={busy} onClick={() => void run(async () => {
        const result = await unwrap(bridge.disconnect(id)); await refresh();
        setMessage(result.revoked ? 'Signed out.' : 'Signed out locally. Remote revocation was not confirmed; disconnect Open Historia in ChatGPT Settings.');
      })}>Sign out</button>}
    </div>
    {profile?.sharing && <>
      <label>Available model
        <select aria-label="ChatGPT model" style={select} disabled={busy || !models.length} value={selectedModel} onChange={event => {
          for (const entry of entriesUsingConnection(connection.id)) updateEntry(entry.id, { model: event.target.value });
          updateConnection(connection.id, { suggestedModel: event.target.value });
          setMessage('Model selected for this connection’s entries.'); setFailed(false);
        }}>
          <option value="" disabled>{mixedModels ? 'Multiple models selected in entries' : 'Automatic (first available model)'}</option>
          {selectedModel && !models.some(model => model.slug === selectedModel) && <option value={selectedModel} disabled>{selectedModel} (unavailable)</option>}
          {models.map(model => <option key={model.slug} value={model.slug}>{model.name}</option>)}
        </select>
      </label>
      <button type="button" style={button} disabled={busy} onClick={() => void run(() => refresh())}>Refresh models</button>
      {models.length === 0 && <p>No models available. Refresh or manage your ChatGPT access.</p>}
    </>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    <p style={{ fontSize: '0.8em', opacity: 0.75 }}>Credentials stay in this app’s OS-protected storage. Manage usage opens ChatGPT Settings. Signing out stops active ChatGPT requests.</p>
  </section>;
}
