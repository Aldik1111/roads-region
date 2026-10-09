import { useCallback, useEffect, useState } from 'react';
import { cleanupConfirmedFieldPhotos, listFieldJobs, reviseRejectedFieldJob, subscribeFieldQueue, type FieldJob } from './fieldQueue';
import { fieldStorage } from './fieldStorage';
import './field-queue-panel.css';

type Props = { ownerId: string; onRetry: () => Promise<void> };
const bytesLabel = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

export default function FieldQueuePanel({ ownerId, onRetry }: Props) {
  const [jobs, setJobs] = useState<FieldJob[]>([]);
  const [receiptCount, setReceiptCount] = useState(0);
  const [confirmed, setConfirmed] = useState<Array<{ kind: string; confirmedAt: string }>>([]);
  const [usage, setUsage] = useState<{ bytes: number; browserUsage: number | null; quota: number | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded,setExpanded]=useState(false);
  const [edits, setEdits] = useState<Record<string, { type: string; description: string }>>({});

  const refresh = useCallback(async () => {
    try {
      const [nextJobs, receipts, nextUsage] = await Promise.all([
        listFieldJobs(ownerId), fieldStorage.keys(ownerId, 'receipt:'), fieldStorage.usage(ownerId),
      ]);
      const confirmedRows = await Promise.all(receipts.map(async key => fieldStorage.get<{ confirmedAt: string; jobFingerprint: string }>(ownerId, key)));
      setJobs(nextJobs); setReceiptCount(receipts.length); setUsage(nextUsage); setError('');
      setConfirmed(confirmedRows.filter((receipt): receipt is NonNullable<typeof receipt> => !!receipt).map(receipt => {
        let kind = 'Операция';
        try { const value=String(JSON.parse(receipt.jobFingerprint).kind??''); kind=({defect:'Сообщение о дефекте',points:'GPS-точки',finish:'Завершение осмотра'} as Record<string,string>)[value]??'Операция'; } catch { /* Older receipt format. */ }
        return { kind, confirmedAt: receipt.confirmedAt };
      }).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, 10));
      setEdits(current => Object.fromEntries(nextJobs.filter(job => job.status === 'rejected').map(job => [job.id, current[job.id] ?? { type: String(job.body.type ?? ''), description: String(job.body.description ?? '') }])));
    } catch (failure) { setError((failure as Error).message || 'Не удалось прочитать локальную очередь.'); }
  }, [ownerId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeFieldQueue(event => { if (event.ownerId === ownerId) void refresh(); });
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [refresh, ownerId]);

  const saveCorrection = async (job: FieldJob) => {
    setBusy(true); setError('');
    try { await reviseRejectedFieldJob(ownerId, job.id, edits[job.id] ?? {}); await refresh(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const retry = async () => { setBusy(true); setError(''); try { await onRetry(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); await refresh(); } };
  const cleanup = async () => {
    if (!window.confirm('Удалить локальные фото, подтверждённые сервером и не используемые очередью или черновиком?')) return;
    setBusy(true); setError('');
    try { const result = await cleanupConfirmedFieldPhotos(ownerId); await refresh(); setError(`Освобождено ${result.deleted} фото (${bytesLabel(result.bytes)}).`); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  const sections: Array<[string, FieldJobStatusGroup]> = [
    ['Ожидают отправки', jobs.filter(job => job.status === 'pending')],
    ['Отправляются', jobs.filter(job => job.status === 'sending')],
    ['Отклонены сервером', jobs.filter(job => job.status === 'rejected')],
    ['Ошибка отправки', jobs.filter(job => job.status === 'error')],
  ];
  return <section className="field-queue-panel" aria-label="Очередь полевых данных">
    <header><div><h2>Очередь устройства</h2><p>{jobs.length} операций · {receiptCount} подтверждено сервером</p></div><button type="button" className="button secondary small" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Свернуть':'Подробнее'}</button><button type="button" className="button secondary small" disabled={busy || !jobs.some(job => job.status !== 'sending') || jobs[0]?.status === 'rejected'} onClick={() => void retry()}>Повторить отправку</button></header>
    {expanded&&<>
    {sections.map(([title, items]) => items.length > 0 && <section className="field-queue-group" key={title}><h3>{title} <span>{items.length}</span></h3>{items.map(job => <article className="field-queue-job" key={job.id}>
      <div className="field-queue-job-title"><b>{job.kind === 'defect' ? `${String(job.body.type ?? 'Дефект')} · ${String(job.body.description ?? 'Без описания')}` : job.kind === 'points' ? 'GPS-точки' : 'Завершение осмотра'}</b><small>Порядок {job.order}</small></div>
      {job.error && <p className="field-queue-error">{job.error}{job.errorStatus ? ` (${job.errorStatus})` : ''}</p>}
      {job.status === 'rejected' && job.kind === 'defect' && <div className="field-queue-edit"><label>Тип<input value={edits[job.id]?.type ?? ''} onChange={event => setEdits(current => ({ ...current, [job.id]: { type: event.target.value, description: current[job.id]?.description ?? String(job.body.description ?? '') } }))}/></label><label>Описание<textarea rows={3} value={edits[job.id]?.description ?? ''} onChange={event => setEdits(current => ({ ...current, [job.id]: { type: current[job.id]?.type ?? String(job.body.type ?? ''), description: event.target.value } }))}/></label><small>Координаты и фотографии сохранены. Исправление останется на этом месте в очереди.</small><button type="button" className="button primary small" disabled={busy} onClick={() => void saveCorrection(job)}>Сохранить исправление</button></div>}
      {job.status === 'error' && job.errorClass === 'ambiguous' && <small>Ответ потерян или соединение прервалось. Сервер мог уже принять сообщение, поэтому оно сохранено с прежним ключом для безопасного повтора.</small>}
      {job.status === 'error' && job.errorClass === 'photo-upload' && <small>Загрузка фотографии не подтвердилась. Сообщение не считается отклонённым и остаётся доступным для повтора.</small>}
      {job.status === 'error' && job.errorClass === 'other' && <small>Сервер вернул {job.errorStatus ?? 'ошибку'}. Исправление доступно только после подтверждённого отказа 400 или 422.</small>}
    </article>)}</section>)}
    {!jobs.length && <p className="field-queue-empty">Нет ожидающих операций. Подтверждённые результаты: {receiptCount}.</p>}
    {confirmed.length > 0 && <section className="field-queue-group"><h3>Подтверждены сервером <span>{receiptCount}</span></h3>{confirmed.map((receipt, index) => <article className="field-queue-confirmed" key={`${receipt.confirmedAt}-${index}`}><b>{receipt.kind}</b><small>{new Date(receipt.confirmedAt).toLocaleString()}</small></article>)}</section>}
    <footer><div><b>Данные этого пользователя: {usage ? bytesLabel(usage.bytes) : 'считаем…'}</b><small>{usage?.quota ? `Использовано браузером: ${usage.browserUsage ? bytesLabel(usage.browserUsage) : 'нет данных'} из ${bytesLabel(usage.quota)}` : 'Оценка размера хранится только на этом устройстве.'}</small></div><button type="button" className="button secondary small" disabled={busy} onClick={() => void cleanup()}>Очистить подтверждённые фото</button></footer>
    {usage?.quota && (usage.browserUsage ?? 0) / usage.quota > 0.75 && <p className="field-queue-warning" role="status">На устройстве мало свободного места. Очистка удалит только фото, уже подтверждённые сервером и не используемые текущим черновиком или очередью.</p>}
    </>}
    {error && <p className="field-queue-notice" role="status">{error}</p>}
  </section>;
}

type FieldJobStatusGroup = FieldJob[];
