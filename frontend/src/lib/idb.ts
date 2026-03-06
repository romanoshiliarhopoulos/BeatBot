/**
 * Thin IndexedDB helpers — no external package needed.
 * Used to persist FileSystemDirectoryHandles across page reloads.
 */

const DB_NAME    = "beatbot";
const STORE_NAME = "folders";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export interface StoredFolder {
  id:     string; // stable uuid generated when user adds the folder
  name:   string; // directory name (for display before asking permission)
  handle: FileSystemDirectoryHandle;
}

export async function saveFolderHandle(folder: StoredFolder): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(folder);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadFolderHandles(): Promise<StoredFolder[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as StoredFolder[]);
    req.onerror   = () => reject(req.error);
  });
}

export async function removeFolderHandle(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Ask the browser whether we still hold permission for a saved handle.
 * Returns true if the handle can be used without a new picker prompt.
 */
export async function verifyHandlePermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  try {
    // @ts-ignore – the permission API is in the spec but not in all TS libs yet
    const perm = await handle.queryPermission({ mode: "read" });
    if (perm === "granted") return true;
    // @ts-ignore
    const req = await handle.requestPermission({ mode: "read" });
    return req === "granted";
  } catch {
    return false;
  }
}
