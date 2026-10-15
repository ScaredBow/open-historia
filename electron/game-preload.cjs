// A narrow desktop-only bridge. Tokens and arbitrary IPC channels never cross it.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`chatgpt:${name}`, ...args);
contextBridge.exposeInMainWorld('ohChatGPT', {
  snapshot: () => invoke('snapshot'),
  signIn: (id, newProfile) => invoke('sign-in', id, newProfile),
  cancelSignIn: () => invoke('cancel-sign-in'),
  select: id => invoke('select', id),
  disconnect: id => invoke('disconnect', id),
  models: id => invoke('models', id),
  manageUsage: () => invoke('usage'),
  infer: (id, request) => invoke('infer', id, request),
  cancel: id => invoke('cancel', id),
  onEvent: listener => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chatgpt:event', handler);
    return () => ipcRenderer.removeListener('chatgpt:event', handler);
  },
});
