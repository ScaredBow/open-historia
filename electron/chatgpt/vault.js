import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatGPTError } from './errors.js';

// Only the Electron main process owns this store. Electron's single-instance
// lock and the runtime's mutation queue serialize all writes/refresh rotation.
export function createVault(directory, safeStorage, { platform = process.platform, renameFile = rename, wait = delay } = {}) {
  const file = join(directory, 'accounts.enc');
  const available = () => safeStorage.isEncryptionAvailable()
    && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const requireKey = () => { if (!available()) throw new ChatGPTError('storage_unavailable'); };
  return {
    async read() {
      requireKey();
      let bytes;
      try { bytes = await readFile(file); } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [], activeId: null };
        throw new ChatGPTError('storage_invalid');
      }
      try {
        const state = JSON.parse(safeStorage.decryptString(bytes));
        if (state.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(state.hostId) || !Array.isArray(state.profiles)) throw new Error();
        return state;
      } catch { throw new ChatGPTError('storage_invalid'); }
    },
    async write(state) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        requireKey();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(safeStorage.encryptString(JSON.stringify(state))); await handle.sync(); }
        finally { await handle.close(); }
        // Node/libuv uses MOVEFILE_REPLACE_EXISTING on Windows. Retry transient
        // file locks without unlinking the destination and risking token loss.
        for (let attempt = 0; ; attempt++) {
          try { await renameFile(temporary, file); break; }
          catch (error) {
            if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
            await wait(50 * 2 ** attempt);
          }
        }
      } catch (error) {
        throw error instanceof ChatGPTError ? error : new ChatGPTError('storage_write_failed');
      }
      finally { await unlink(temporary).catch(() => {}); }
    },
  };
}
