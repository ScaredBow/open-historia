import { STORES, idbSnapshot, idbImportEmpty } from '../runtime/web/idb.js';
import { encode, decode } from './archive.js';
import { unwrap } from '../desktop/chatgptClient.js';

export async function installAppleSaves() {
  const bridge = window.ohApple;
  if (!bridge) throw new Error('Native save transfer unavailable.');
  let saving = false;
  window.ohKeepAppleSaves = async () => {
    if (saving) throw new Error('Transfer already in progress.');
    saving = true;
    try {
      const stores = {};
      const snapshot = await idbSnapshot();
      for (const name of Object.values(STORES)) stores[name] = await encode(snapshot[name]);
      const settings = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
      const archive = JSON.stringify({ format: 1, stores, settings });
      if (new TextEncoder().encode(archive).length > 100_000_000) throw new Error('Use individual game exports for libraries larger than 100 MB.');
      await unwrap(bridge.saveArchive(archive));
    } finally { saving = false; }
  };
  if (bridge.clip) {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'note');
    notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147482999;background:#222;color:white;padding:8px;font:12px system-ui;text-align:center';
    notice.textContent = 'App Clip saves are temporary. Use Keep saves, then get the full app to continue.';
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', 'Dismiss save notice');
    dismiss.style.cssText = 'color:white;background:transparent;border:0;font:22px system-ui;min-width:44px;min-height:44px';
    dismiss.onclick = () => notice.remove();
    notice.append(dismiss);
    document.body.append(notice);
  } else {
    // Import only into a genuinely empty library. Never replace an existing
    // full-app game, even if a stale Clip archive remains in the shared group.
    try {
      const text = await unwrap(bridge.readArchive());
      if (!text || localStorage.getItem('oh:apple-transfer') === '1') return;
      const archive = JSON.parse(text);
      if (archive.format !== 1 || !archive.stores || !archive.settings) throw new Error('Invalid transfer archive.');
      const records = Object.fromEntries(Object.values(STORES).map(name => [name, decode(archive.stores[name])]));
      if (!await idbImportEmpty(records)) return;
      for (const [key, value] of Object.entries(archive.settings)) if (typeof value === 'string') localStorage.setItem(key, value);
      localStorage.setItem('oh:apple-transfer', '1');
    } catch {
      // A simulator without signing has no App Group. Keep ordinary local play
      // available and make transfer failure visible, without logging save data.
      console.warn('App Clip save transfer unavailable; existing saves are unchanged.');
    }
  }
}
