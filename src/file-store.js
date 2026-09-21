const DB_NAME = 'unitv-browser-lab';
const DB_VERSION = 2;
const LEGACY_STORE = 'python-files';
const PROJECT_STORE = 'projects';
const ENTRY_STORE = 'project-entries';
const LEGACY_PROJECT_ID = 'legacy-python-files';

function now() { return new Date().toISOString(); }

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      const transaction = request.transaction;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) {
        const legacy = db.createObjectStore(LEGACY_STORE, { keyPath: 'id' });
        legacy.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const projects = db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');
        projects.createIndex('sourceKey', 'sourceKey');
      }
      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        const entries = db.createObjectStore(ENTRY_STORE, { keyPath: 'id' });
        entries.createIndex('projectId', 'projectId');
        entries.createIndex('projectPath', ['projectId', 'path'], { unique: true });
      }

      if (event.oldVersion < 2 && transaction && db.objectStoreNames.contains(LEGACY_STORE)) {
        const legacyRequest = transaction.objectStore(LEGACY_STORE).getAll();
        legacyRequest.onsuccess = () => {
          const legacyFiles = legacyRequest.result || [];
          if (!legacyFiles.length) return;
          const timestamp = now();
          transaction.objectStore(PROJECT_STORE).put({
            id: LEGACY_PROJECT_ID,
            name: '以前のファイル',
            source: { type: 'local' },
            sourceKey: '',
            activePath: legacyFiles[0].name || 'main.py',
            createdAt: timestamp,
            updatedAt: timestamp,
            settings: {}
          });
          const entryStore = transaction.objectStore(ENTRY_STORE);
          legacyFiles.forEach((file, index) => entryStore.put(createEntry({
            projectId: LEGACY_PROJECT_ID,
            path: file.name || `file-${index + 1}.py`,
            kind: 'text',
            text: String(file.code || ''),
            order: file.order ?? index,
            updatedAt: file.updatedAt || timestamp
          })));
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withDatabase(mode, stores, callback) {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(stores, mode);
    const result = await callback(transaction);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
    return result;
  } finally {
    db.close();
  }
}

export function createProject(name = '新しいプロジェクト', source = { type: 'local' }) {
  const timestamp = now();
  return {
    id: crypto.randomUUID(), name, source,
    sourceKey: source.type === 'github' ? `${source.owner}/${source.repo}:${source.branch}`.toLowerCase() : '',
    activePath: 'main.py', createdAt: timestamp, updatedAt: timestamp, settings: {}
  };
}

export function createEntry({
  projectId, path, kind = 'text', text = '', blob = null, mime = '', size = 0,
  mode = '100644', basePath = null, baseSha = null, baseText = null,
  deleted = false, order = Date.now(), updatedAt = now()
}) {
  return {
    id: crypto.randomUUID(), projectId, path, kind, text, blob, mime,
    size: size || (kind === 'text' ? new Blob([text]).size : blob?.size || 0),
    mode, basePath, baseSha, baseText, deleted, order, updatedAt
  };
}

export async function listProjects() {
  return withDatabase('readonly', [PROJECT_STORE], async transaction => {
    const projects = await requestResult(transaction.objectStore(PROJECT_STORE).getAll());
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name));
  });
}

export async function saveProjectRecord(project) {
  project.updatedAt = now();
  await withDatabase('readwrite', [PROJECT_STORE], transaction => transaction.objectStore(PROJECT_STORE).put(project));
  return project;
}

export async function listProjectEntries(projectId, { includeDeleted = true } = {}) {
  return withDatabase('readonly', [ENTRY_STORE], async transaction => {
    const entries = await requestResult(transaction.objectStore(ENTRY_STORE).index('projectId').getAll(projectId));
    return entries.filter(entry => includeDeleted || !entry.deleted).sort((a, b) => a.path.localeCompare(b.path));
  });
}

export async function saveEntry(entry) {
  entry.updatedAt = now();
  await withDatabase('readwrite', [ENTRY_STORE], transaction => transaction.objectStore(ENTRY_STORE).put(entry));
  return entry;
}

export async function saveEntries(entries) {
  if (!entries.length) return;
  entries.forEach(entry => { entry.updatedAt = now(); });
  await withDatabase('readwrite', [ENTRY_STORE], transaction => {
    const store = transaction.objectStore(ENTRY_STORE);
    entries.forEach(entry => store.put(entry));
  });
}

export async function removeEntry(id) {
  await withDatabase('readwrite', [ENTRY_STORE], transaction => transaction.objectStore(ENTRY_STORE).delete(id));
}

export async function removeEntries(ids) {
  if (!ids.length) return;
  await withDatabase('readwrite', [ENTRY_STORE], transaction => {
    const store = transaction.objectStore(ENTRY_STORE);
    ids.forEach(id => store.delete(id));
  });
}

function deleteEntriesForProject(transaction, projectId) {
  return new Promise((resolve, reject) => {
    const request = transaction.objectStore(ENTRY_STORE).index('projectId').openKeyCursor(IDBKeyRange.only(projectId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      transaction.objectStore(ENTRY_STORE).delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function replaceProjectEntries(projectId, entries) {
  await withDatabase('readwrite', [ENTRY_STORE], async transaction => {
    await deleteEntriesForProject(transaction, projectId);
    const store = transaction.objectStore(ENTRY_STORE);
    entries.forEach(entry => store.put(entry));
  });
}

export async function deleteProject(projectId) {
  await withDatabase('readwrite', [PROJECT_STORE, ENTRY_STORE], async transaction => {
    await deleteEntriesForProject(transaction, projectId);
    transaction.objectStore(PROJECT_STORE).delete(projectId);
  });
}

// Legacy access remains available for importing version 1 data.
export async function listFiles() {
  return withDatabase('readonly', [LEGACY_STORE], async transaction => {
    const files = await requestResult(transaction.objectStore(LEGACY_STORE).getAll());
    return files.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  });
}

export async function saveFile(file) {
  await withDatabase('readwrite', [LEGACY_STORE], transaction => transaction.objectStore(LEGACY_STORE).put(file));
  return file;
}

export async function removeFile(id) {
  await withDatabase('readwrite', [LEGACY_STORE], transaction => transaction.objectStore(LEGACY_STORE).delete(id));
}

export function createFile(name = 'untitled.py', code = '', order = Date.now()) {
  return { id: crypto.randomUUID(), name, code, order, updatedAt: now() };
}
