/* global __IS_CLIP__ */
(() => {
  'use strict';
  const listeners = new Set();
  const invoke = (method, ...args) => window.webkit.messageHandlers.historia.postMessage({ method, args });
  Object.defineProperty(window, 'ohChatGPT', { value: Object.freeze({
    snapshot: () => invoke('snapshot'),
    signIn: (id, fresh = false) => invoke('signIn', id ?? null, fresh),
    cancelSignIn: () => invoke('cancelSignIn'),
    select: id => invoke('select', id),
    disconnect: id => invoke('disconnect', id),
    models: id => invoke('models', id),
    manageUsage: () => invoke('usage'),
    infer: (id, request) => invoke('infer', id, request),
    cancel: id => invoke('cancel', id),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  }) });
  Object.defineProperty(window, 'ohApple', { value: Object.freeze({
    platform: 'ios', clip: __IS_CLIP__,
    saveArchive: archive => invoke('saveArchive', archive),
    readArchive: () => invoke('readArchive'),
  }) });
  Object.defineProperty(window, '__ohNativeEvent', { value: event => {
    for (const listener of listeners) { try { listener(event); } catch { /* isolated observer */ } }
  } });
})();
