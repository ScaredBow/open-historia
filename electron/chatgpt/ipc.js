import { safeError, ChatGPTError } from './errors.js';

export function trustedSender(event, window, origin) {
  try {
    return !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin;
  } catch { return false; }
}

export function attachChatGPT({ ipcMain, window, runtime, origin, openUsage }) {
  const requests = new Map();
  const channels = [];
  const handle = (name, operation) => {
    const channel = `chatgpt:${name}`; channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event, window, origin)) return { ok: false, error: safeError(new ChatGPTError('invalid_request')) };
      try { return { ok: true, value: await operation(...args) }; }
      catch (error) { return { ok: false, error: safeError(error) }; }
    });
  };
  const profileId = id => { if (typeof id !== 'string' || id.length > 100) throw new ChatGPTError('invalid_request'); return id; };
  handle('snapshot', () => runtime.snapshot());
  handle('sign-in', (id, newProfile) => runtime.signIn(id ? profileId(id) : undefined, newProfile === true));
  handle('cancel-sign-in', () => runtime.cancelSignIn());
  handle('select', id => runtime.select(profileId(id)));
  handle('disconnect', id => runtime.disconnect(profileId(id)));
  handle('models', id => runtime.models(profileId(id)));
  handle('usage', () => openUsage());
  handle('cancel', id => { requests.get(id)?.abort(); });
  handle('infer', async (id, request) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || requests.has(id) || requests.size >= 8) throw new ChatGPTError('invalid_request');
    profileId(request?.profileId);
    const controller = new AbortController(); requests.set(id, controller);
    try {
      return await runtime.infer(request, payload => {
        if (!window.isDestroyed()) window.webContents.send('chatgpt:event', { id, ...payload });
      }, controller.signal);
    } finally { requests.delete(id); }
  });
  const cancelAll = () => { for (const controller of requests.values()) controller.abort(); runtime.close(); };
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) cancelAll(); });
  window.webContents.on('render-process-gone', cancelAll);
  window.once('closed', () => { cancelAll(); for (const channel of channels) ipcMain.removeHandler(channel); });
}
