// Where the student's code-making key lives on the phone.
//
// The key is stored in IndexedDB as a non-extractable CryptoKey: the app can
// ask the browser to make codes with it (so the ID works offline), but no
// script can read the secret itself back out.

const DB_NAME = 'gaucho-pass';
const STORE = 'keys';
const memory = new Map(); // fallback when IndexedDB is unavailable (some private modes)

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/** Some browsers have, at times, left IndexedDB requests hanging. Never wait on it forever. */
function withTimeout(promise, ms = 2500) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB timed out')), ms))]);
}

async function withStore(mode, work) {
  const db = await withTimeout(open());
  try {
    return await withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  } finally {
    db.close();
  }
}

export async function saveKey(userId, version, key) {
  memory.set(userId, { version, key });
  try {
    await withStore('readwrite', (s) => s.put({ version, key }, userId));
  } catch {
    // Kept in memory only: the ID works until the page closes, then needs the network once.
  }
}

export async function loadKey(userId) {
  if (memory.has(userId)) return memory.get(userId);
  try {
    const found = await withStore('readonly', (s) => s.get(userId));
    if (found && found.key) {
      memory.set(userId, found);
      return found;
    }
  } catch { /* no stored key */ }
  return null;
}

export async function clearKeys() {
  memory.clear();
  try {
    await withStore('readwrite', (s) => s.clear());
  } catch { /* nothing to clear */ }
}
