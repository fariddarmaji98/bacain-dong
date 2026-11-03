// Draft store (IndexedDB). Shared by background.js (importScripts) and offscreen.js (<script>).
// A draft = one folder: { id: folder name, title, url, savedAt, files: [{ name, type, blob }] }.
const DB_NAME = 'bacain-dong';
const DRAFT_STORE = 'drafts';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t, req;
    try {
      t = db.transaction(DRAFT_STORE, mode);
      req = run(t.objectStore(DRAFT_STORE));
    } catch (e) {
      db.close();
      return reject(e);
    }
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

const putDraft = (draft) => withStore('readwrite', (s) => s.put(draft));
const getDraft = (id) => withStore('readonly', (s) => s.get(id));
const listDrafts = () => withStore('readonly', (s) => s.getAll());
const deleteDraft = (id) => withStore('readwrite', (s) => s.delete(id));
