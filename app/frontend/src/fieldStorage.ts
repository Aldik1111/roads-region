type StoredRow = { ownerId: string; key: string; value: unknown };
type Lease = { id: string; token: string; expiresAt: number };

const DB_NAME = 'roads-region-field-v1';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;
let writeTail: Promise<void> = Promise.resolve();

function storageError(message: string, cause?: unknown) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'FieldStorageError';
  return error;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(storageError('Локальное хранилище недоступно в этом браузере.'));
  if (!dbPromise) dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) {
        const records = db.createObjectStore('records', { keyPath: ['ownerId', 'key'] });
        records.createIndex('ownerId', 'ownerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('leases')) db.createObjectStore('leases', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(storageError('Не удалось открыть локальное хранилище.', request.error));
    request.onblocked = () => reject(storageError('Локальное хранилище занято другой вкладкой. Закройте лишнюю вкладку и повторите.'));
  }).catch(error => { dbPromise = null; throw error; });
  return dbPromise;
}

function serializeWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = writeTail.then(write, write);
  writeTail = next.then(() => undefined, () => undefined);
  return next;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(storageError(
      tx.error?.name === 'QuotaExceededError' ? 'Недостаточно места для сохранения данных на устройстве.' : 'Не удалось сохранить данные на устройстве.',
      tx.error,
    ));
  });
}

export const fieldStorage = {
  async get<T>(ownerId: string, key: string): Promise<T | null> {
    await writeTail;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly');
      const request = tx.objectStore('records').get([ownerId, key]);
      request.onsuccess = () => resolve((request.result as StoredRow | undefined)?.value as T ?? null);
      request.onerror = () => reject(storageError('Не удалось прочитать локальные данные.', request.error));
      tx.onabort = () => reject(storageError('Не удалось прочитать локальные данные.', tx.error));
    });
  },

  set<T>(ownerId: string, key: string, value: T): Promise<void> {
    if (!ownerId || !key) return Promise.reject(storageError('Для локальных данных требуются владелец и ключ.'));
    return serializeWrite(async () => {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readwrite');
      const done = transactionDone(tx);
      try { tx.objectStore('records').put({ ownerId, key, value } satisfies StoredRow); }
      catch (error) {
        try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
        try { await done; } catch { /* Preserve the more specific synchronous clone error below. */ }
        throw storageError('Не удалось сохранить данные на устройстве.', error);
      }
      await done;
    });
  },

  remove(ownerId: string, key: string): Promise<void> {
    return serializeWrite(async () => {
      const db = await openDatabase();
      const tx = db.transaction('records', 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore('records').delete([ownerId, key]);
      await done;
    });
  },

  replaceJob(ownerId: string, oldId: string, next: unknown): Promise<boolean> {
    return serializeWrite(async () => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        let replaced = false;
        const oldRequest = store.get([ownerId, `job:${oldId}`]);
        oldRequest.onsuccess = () => {
          const old = (oldRequest.result as StoredRow | undefined)?.value as { status?: string } | undefined;
          if (!old || old.status !== 'rejected') { tx.abort(); return; }
          const receiptRequest = store.get([ownerId, `receipt:${oldId}`]);
          receiptRequest.onsuccess = () => {
            if (receiptRequest.result) { tx.abort(); return; }
            const nextId = (next as { id: string }).id;
            const collisionRequest = store.get([ownerId, `job:${nextId}`]);
            collisionRequest.onsuccess = () => {
              if (collisionRequest.result) { tx.abort(); return; }
              store.put({ ownerId, key: `job:${nextId}`, value: next } satisfies StoredRow);
              store.delete([ownerId, `job:${oldId}`]);
              replaced = true;
            };
          };
        };
        tx.oncomplete = () => resolve(replaced);
        tx.onabort = tx.onerror = () => {
          if (tx.error) reject(storageError('Не удалось исправить отклонённую операцию.', tx.error));
          else resolve(false);
        };
      });
    });
  },

  cleanupConfirmedPhotos(ownerId: string): Promise<{ deleted: number; bytes: number }> {
    return serializeWrite(async () => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        const range = IDBKeyRange.bound([ownerId, ''], [ownerId, '\uffff']);
        const request = store.getAll(range);
        let deleted = 0, bytes = 0;
        request.onsuccess = () => {
          const rows = request.result as StoredRow[];
          const references = new Set<string>();
          const visit = (value: unknown) => {
            if (typeof value === 'string') { if (value.startsWith('local-photo-')) references.add(value); return; }
            if (Array.isArray(value)) { value.forEach(visit); return; }
            if (value && typeof value === 'object' && !(value instanceof Blob)) Object.values(value).forEach(visit);
          };
          for (const row of rows) if (row.key === 'draft' || row.key.startsWith('job:')) visit(row.value);
          const keys = new Set(rows.map(row => row.key));
          for (const row of rows) {
            if (!row.key.startsWith('photo:')) continue;
            const id = row.key.slice('photo:'.length);
            if (!keys.has(`remote-photo:${id}`) || references.has(id)) continue;
            const photo = row.value as { size?: unknown };
            bytes += Number(photo?.size) || 0;
            store.delete([ownerId, row.key]);
            deleted++;
          }
        };
        tx.oncomplete = () => resolve({ deleted, bytes });
        tx.onabort = tx.onerror = () => reject(storageError('Не удалось очистить подтверждённые фотографии.', tx.error));
      });
    });
  },

  async usage(ownerId: string): Promise<{ bytes: number; browserUsage: number | null; quota: number | null }> {
    const keys = await this.keys(ownerId, '');
    let bytes = 0;
    for (const key of keys) {
      const value = await this.get<unknown>(ownerId, key);
      const count = (item: unknown): number => {
        if (item instanceof Blob) return item.size;
        if (Array.isArray(item)) return item.reduce((sum, child) => sum + count(child), 0);
        if (item && typeof item === 'object') return Object.values(item).reduce<number>((sum, child) => sum + count(child), 0);
        return typeof item === 'string' ? new TextEncoder().encode(item).length : 0;
      };
      bytes += count(value);
    }
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    return { bytes, browserUsage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  },

  increment(ownerId: string, key: string): Promise<number> {
    return serializeWrite(async () => {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        const request = store.get([ownerId, key]);
        let value = 1;
        request.onsuccess = () => {
          value = Number((request.result as StoredRow | undefined)?.value ?? 0) + 1;
          store.put({ ownerId, key, value } satisfies StoredRow);
        };
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(storageError('Не удалось обновить очередь устройства.', tx.error));
      });
    });
  },

  async keys(ownerId: string, prefix: string): Promise<string[]> {
    await writeTail;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readonly');
      const range = IDBKeyRange.bound([ownerId, prefix], [ownerId, `${prefix}\uffff`]);
      const request = tx.objectStore('records').getAllKeys(range);
      request.onsuccess = () => resolve(request.result.map(key => Array.isArray(key) ? String(key[1]) : '').filter(Boolean));
      request.onerror = () => reject(storageError('Не удалось перечислить локальные данные.', request.error));
      tx.onabort = () => reject(storageError('Не удалось перечислить локальные данные.', tx.error));
    });
  },
};

async function leaseTransaction(ownerId: string, token: string, action: 'acquire' | 'renew' | 'release', ttlMs: number): Promise<boolean> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('leases', 'readwrite');
    const store = tx.objectStore('leases');
    const id = `field-queue:${ownerId}`;
    let acquired = false;
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as Lease | undefined;
      if (action === 'acquire') {
        if (!current || current.token === token || current.expiresAt <= Date.now()) {
          store.put({ id, token, expiresAt: Date.now() + ttlMs } satisfies Lease);
          acquired = true;
        }
      } else if (current?.token === token) {
        if (action === 'renew') store.put({ ...current, expiresAt: Date.now() + ttlMs });
        else store.delete(id);
        acquired = true;
      }
    };
    tx.oncomplete = () => resolve(acquired);
    tx.onabort = tx.onerror = () => reject(storageError('Не удалось синхронизировать очередь устройства.', tx.error));
  });
}

export async function withFieldQueueLock<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager?.request) return lockManager.request(`roads-field-queue:${ownerId}`, { mode: 'exclusive' }, work);

  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  while (!await leaseTransaction(ownerId, token, 'acquire', 30_000)) await new Promise(resolve => setTimeout(resolve, 100));
  const heartbeat = setInterval(() => { void leaseTransaction(ownerId, token, 'renew', 30_000).catch(() => false); }, 10_000);
  try { return await work(); }
  finally {
    clearInterval(heartbeat);
    await leaseTransaction(ownerId, token, 'release', 0);
  }
}
