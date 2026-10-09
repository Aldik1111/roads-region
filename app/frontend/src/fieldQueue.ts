import { api, upload } from './api';
import type { Photo } from './types';
import { fieldStorage, withFieldQueueLock } from './fieldStorage';

export type FieldJobKind = 'defect' | 'points' | 'finish';
export type FieldJobStatus = 'pending' | 'sending' | 'error';
export type FieldJob = {
  id: string;
  kind: FieldJobKind;
  inspectionId?: string;
  body: Record<string, unknown>;
  status: FieldJobStatus;
  error?: string;
  createdAt: string;
  order: number;
};
type StagedPhoto = { file: Blob; name: string; type: string; size: number; createdAt: string };
type QueueReceipt = { result: unknown; confirmedAt: string; jobFingerprint: string };
type QueueEvent = { ownerId: string };

const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const listeners = new Set<(event: QueueEvent) => void>();
let channel: BroadcastChannel | null = null;

function invalidPhoto(message: string) {
  const error = new Error(message);
  error.name = 'FieldPhotoValidationError';
  return error;
}

function emit(ownerId: string) {
  const event = { ownerId };
  for (const listener of listeners) listener(event);
  if (typeof BroadcastChannel !== 'undefined') {
    channel ??= new BroadcastChannel('roads-field-queue-v1');
    channel.postMessage(event);
  }
}

export function subscribeFieldQueue(listener: (event: QueueEvent) => void): () => void {
  listeners.add(listener);
  if (typeof BroadcastChannel !== 'undefined') {
    channel ??= new BroadcastChannel('roads-field-queue-v1');
    channel.onmessage = message => {
      if (message.data && typeof message.data.ownerId === 'string') {
        for (const callback of listeners) callback({ ownerId: message.data.ownerId });
      }
    };
  }
  return () => { listeners.delete(listener); };
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fingerprint(job: { kind: FieldJobKind; inspectionId?: string; body: Record<string, unknown> }) {
  return JSON.stringify({ kind: job.kind, inspectionId: job.inspectionId ?? null, body: job.body });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Не удалось подготовить предварительный просмотр фотографии.'));
    reader.onerror = () => reject(new Error('Не удалось прочитать фотографию на устройстве.'));
    reader.readAsDataURL(file);
  });
}

async function verifyImage(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  let type = '';
  if (starts([0xff, 0xd8, 0xff])) type = 'image/jpeg';
  else if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) type = 'image/png';
  else if (starts([0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) type = 'image/webp';
  if (!IMAGE_TYPES.has(type)) throw invalidPhoto('Поддерживаются только читаемые фотографии JPG, PNG и WebP.');
  const decodableBlob = new Blob([file], { type });
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(decodableBlob);
      const valid = bitmap.width > 0 && bitmap.height > 0;
      bitmap.close();
      if (valid) return type;
    } else {
      const url = URL.createObjectURL(decodableBlob);
      try {
        await new Promise<void>((resolve, reject) => {
          const image = new Image();
          image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(new Error('bad image dimensions'));
          image.onerror = () => reject(new Error('image decode failed'));
          image.src = url;
        });
        return type;
      } finally { URL.revokeObjectURL(url); }
    }
  } catch { /* Report one stable validation error below. */ }
  throw invalidPhoto('Файл не является читаемой фотографией. Выберите JPG, PNG или WebP.');
}

export async function stageFieldPhoto(ownerId: string, file: File): Promise<Photo> {
  if (!ownerId) throw new Error('Не определён владелец локального фото.');
  if (!(file instanceof Blob) || file.size <= 0) throw invalidPhoto('Файл пустой. Выберите другую фотографию.');
  if (file.size > MAX_PHOTO_SIZE) throw invalidPhoto('Фотография больше 10 МБ. Уменьшите её размер или выберите другой файл.');
  const actualType = await verifyImage(file);
  const id = `local-photo-${uuid()}`;
  const preview = await readAsDataUrl(new File([file], file.name, { type: actualType, lastModified: file.lastModified }));
  const staged: StagedPhoto = { file, name: file.name, type: actualType, size: file.size, createdAt: new Date().toISOString() };
  await fieldStorage.set(ownerId, `photo:${id}`, staged);
  return { id, url: preview, name: file.name };
}

export async function enqueueFieldJob(ownerId: string, job: { id: string; kind: FieldJobKind; inspectionId?: string; body: Record<string, unknown> }): Promise<void> {
  if (!ownerId || !job.id || !job.body || !['defect', 'points', 'finish'].includes(job.kind)) throw new Error('Некорректная локальная операция.');
  await withFieldQueueLock(`enqueue:${ownerId}`, async () => {
    const receipt = await fieldStorage.get<QueueReceipt>(ownerId, `receipt:${job.id}`);
    if (receipt !== null) {
      if (receipt.jobFingerprint !== fingerprint(job)) throw new Error('Этот ключ операции уже подтверждён с другими данными. Создайте новый ключ для изменённой операции.');
      return;
    }
    const existing = await fieldStorage.get<FieldJob>(ownerId, `job:${job.id}`);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(job)) {
        throw new Error('Этот ключ операции уже использован с другими данными. Создайте новый ключ для изменённой операции.');
      }
      return;
    }
    const order = await fieldStorage.increment(ownerId, 'meta:queue-order');
    const stored: FieldJob = { ...job, status: 'pending', createdAt: new Date().toISOString(), order };
    await fieldStorage.set(ownerId, `job:${job.id}`, stored);
    emit(ownerId);
  });
}

export async function listFieldJobs(ownerId: string): Promise<FieldJob[]> {
  const keys = await fieldStorage.keys(ownerId, 'job:');
  const jobs = await Promise.all(keys.map(key => fieldStorage.get<FieldJob>(ownerId, key)));
  return jobs.filter((job): job is FieldJob => !!job).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function verifiedOwner(ownerId: string) {
  const data = await api.get<unknown>('/me');
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const user = record.user && typeof record.user === 'object' ? record.user as Record<string, unknown> : record;
  if (user.id !== ownerId) {
    const error = new Error('Очередь принадлежит другому пользователю. Войдите в нужную учётную запись перед синхронизацией.');
    error.name = 'FieldQueueOwnerMismatch';
    throw error;
  }
}

async function resolvedDefectBody(ownerId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const photoIds = body.photo_ids;
  if (!Array.isArray(photoIds)) return body;
  const resolved: string[] = [];
  for (const value of photoIds) {
    if (typeof value !== 'string' || !value.startsWith('local-photo-')) { resolved.push(String(value)); continue; }
    const mapped = await fieldStorage.get<Photo>(ownerId, `remote-photo:${value}`);
    if (mapped) { resolved.push(mapped.id); continue; }
    const staged = await fieldStorage.get<StagedPhoto>(ownerId, `photo:${value}`);
    if (!staged) throw new Error(`Не найден сохранённый файл ${value}. Операция оставлена в очереди.`);
    const file = new File([staged.file], staged.name, { type: staged.type, lastModified: Date.parse(staged.createdAt) || Date.now() });
    await verifiedOwner(ownerId);
    const remote = await upload(file, value, ownerId);
    if (!remote?.id || !remote.url) throw new Error('Сервер не подтвердил загрузку фотографии. Операция оставлена в очереди.');
    // Persist the stable upload result before posting the defect so retries do not create another file.
    await fieldStorage.set(ownerId, `remote-photo:${value}`, remote);
    resolved.push(remote.id);
  }
  return { ...body, photo_ids: resolved };
}

async function sendJob(ownerId: string, job: FieldJob) {
  const headers = { 'Idempotency-Key': job.id, 'X-Field-Owner': ownerId };
  if (job.kind === 'defect') {
    const body = await resolvedDefectBody(ownerId, job.body);
    await verifiedOwner(ownerId);
    return api.post<unknown>('/defects', body, headers);
  }
  if (!job.inspectionId) throw new Error(`Для операции ${job.kind} не указан осмотр.`);
  await verifiedOwner(ownerId);
  if (job.kind === 'points') return api.post<unknown>(`/inspections/${encodeURIComponent(job.inspectionId)}/points`, job.body, headers);
  return api.post<unknown>(`/inspections/${encodeURIComponent(job.inspectionId)}/finish`, job.body, headers);
}

export async function flushFieldQueue(ownerId: string): Promise<void> {
  if (!ownerId) throw new Error('Не определён владелец очереди.');
  await withFieldQueueLock(ownerId, async () => {
    const jobs = await listFieldJobs(ownerId);
    if (!jobs.length) return;
    for (const original of jobs) {
      const job: FieldJob = { ...original, status: 'sending', error: undefined };
      await fieldStorage.set(ownerId, `job:${job.id}`, job);
      emit(ownerId);
      try {
        await verifiedOwner(ownerId);
        const result = await sendJob(ownerId, job);
        // Receipt must land before deleting the job; after a lost response, stable keys make retry safe.
        await fieldStorage.set(ownerId, `receipt:${job.id}`, { result, confirmedAt: new Date().toISOString(), jobFingerprint: fingerprint(job) });
        await fieldStorage.remove(ownerId, `job:${job.id}`);
        // Keep original staged blobs through reloads and user draft restoration. A later cleanup can reclaim them.
        emit(ownerId);
      } catch (failure) {
        const message = (failure as Error)?.message || 'Сервер не подтвердил операцию. Она сохранена для повтора.';
        await fieldStorage.set(ownerId, `job:${job.id}`, { ...job, status: 'error', error: message });
        emit(ownerId);
        throw failure;
      }
    }
  });
}
