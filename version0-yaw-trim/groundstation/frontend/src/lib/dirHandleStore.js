// Remembers a File System Access directory handle across page loads.
//
// Handles are structured-cloneable but cannot go in localStorage, so they live in IndexedDB.
// A restored handle usually comes back WITHOUT permission: the browser only re-grants it from a
// user gesture (requestPermission inside a click), which is why the panel shows "Reconnect".
// Every call resolves (null on any failure), so a private window or blocked storage just means
// the folder has to be chosen again.

const DB = 'v0-groundstation';
const STORE = 'handles';

function open() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadDirHandle(key) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveDirHandle(key, handle) {
  const db = await open();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export const fsAccessSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
