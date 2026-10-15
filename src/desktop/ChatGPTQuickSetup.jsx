import React, { useState } from 'react';
import { unwrap } from './chatgptClient.js';
import { addConnection, addEntry, getConnections, getFallbackList, moveEntry } from '../Game/AI/providerConfig.js';

export default function ChatGPTQuickSetup({ onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async () => {
    setBusy(true); setError('');
    try {
      const bridge = window.ohChatGPT;
      const snapshot = await unwrap(bridge.snapshot());
      let profile = snapshot.profiles.find(item => item.id === snapshot.activeId)
        || snapshot.profiles.find(item => item.status === 'disconnected');
      if (!profile?.sharing) profile = await unwrap(bridge.signIn(profile?.id, !profile));
      if (!profile.sharing) throw new Error('Allow ChatGPT plan usage in ChatGPT Settings, then reconnect.');
      const models = await unwrap(bridge.models(profile.id));
      if (!models.length) throw new Error('No models available for this ChatGPT account. Check Manage usage.');
      const connectionId = getConnections().find(item => item.provider === 'chatgpt' && item.chatgptProfileId === profile.id)?.id
        || addConnection({ provider: 'chatgpt', chatgptProfileId: profile.id });
      const entryId = getFallbackList().find(item => item.connectionId === connectionId)?.id
        || addEntry({ connectionId, model: models[0].slug });
      moveEntry(entryId, 0);
      onSaved?.();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="ChatGPT sign-in" style={{ border: '1px solid #777', borderRadius: 10, padding: 14, marginTop: 16 }}>
    <strong>Use your ChatGPT plan</strong>
    <p>Sign in with an eligible account and allow plan usage. No API key needed; your account’s limits apply.</p>
    <button type="button" disabled={busy} onClick={() => void connect()} style={{ background: 'white', color: 'black', borderRadius: 8, padding: '10px 18px', cursor: 'pointer' }}>Continue with ChatGPT</button>
    {busy && <button type="button" onClick={() => void window.ohChatGPT.cancelSignIn()}>Cancel sign-in</button>}
    <button type="button" onClick={() => void unwrap(window.ohChatGPT.manageUsage()).catch(failure => setError(failure.message))}>Manage usage</button>
    {error && <p role="alert">{error}</p>}
    <p style={{ fontSize: '0.8em' }}>Manage accounts and models later in Settings → AI.</p>
  </section>;
}
