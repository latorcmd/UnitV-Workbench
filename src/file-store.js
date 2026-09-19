const DB_NAME = 'unitv-browser-lab';
const DB_VERSION = 1;
const STORE = 'python-files';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listFiles() {
  const db = await openDatabase();
  try {
    const files = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return files.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  } finally {
    db.close();
  }
}

export async function saveFile(file) {
  const db = await openDatabase();
  try {
    await requestResult(db.transaction(STORE, 'readwrite').objectStore(STORE).put(file));
    return file;
  } finally {
    db.close();
  }
}

export async function removeFile(id) {
  const db = await openDatabase();
  try {
    await requestResult(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

export function createFile(name = 'untitled.py', code = '', order = Date.now()) {
  return {
    id: crypto.randomUUID(),
    name,
    code,
    order,
    updatedAt: new Date().toISOString()
  };
}
