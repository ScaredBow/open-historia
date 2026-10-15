import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ChatGPTQuickSetup from '../desktop/ChatGPTQuickSetup.jsx';

function Welcome({ close }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} aria-label="Welcome to Open Historia" onCancel={event => { event.preventDefault(); close(); }} style={{ color: '#eee', background: '#18181b', border: '1px solid #666', borderRadius: 16, padding: 24, width: 'min(420px, calc(100vw - 48px))', maxHeight: '85dvh', overflow: 'auto' }}>
    <h1 style={{ fontSize: 24 }}>Open Historia</h1>
    <p>Your game runs on this device. Sign in to use your ChatGPT plan for AI turns.</p>
    <ChatGPTQuickSetup onSaved={close} />
    <button type="button" onClick={close} style={{ marginTop: 20, minHeight: 44, padding: '8px 16px' }}>Explore first</button>
    {window.ohApple?.clip && <p>App Clip saves are temporary. Use Keep saves and install the full app to continue your campaign.</p>}
  </dialog>;
}

export function showAppleWelcome() {
  if (localStorage.getItem('oh:apple-welcome') === '1') return;
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const close = () => { localStorage.setItem('oh:apple-welcome', '1'); root.unmount(); element.remove(); };
  root.render(<Welcome close={close} />);
}
