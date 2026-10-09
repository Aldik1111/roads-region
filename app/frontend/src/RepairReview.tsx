import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, MapPin, ShieldCheck, WifiOff } from 'lucide-react';
import { formatDate, PhotoGallery, UploadField } from './components';
import { useDeviceLocation } from './geolocation';
import type { DefectDetail, Photo, Repair } from './types';
import './repair-review.css';

type Props = {
  detail: DefectDetail;
  busy: boolean;
  onAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
};
type ChecklistKey = 'surface_restored' | 'no_visible_damage' | 'area_safe';
type Checklist = Record<ChecklistKey, boolean>;
type StoredReviewEvidence = {
  photos?: Photo[];
  inspector_id?: string;
  checked_at?: string;
  distance_m?: number;
  lat?: number;
  lng?: number;
  accuracy_m?: number | null;
  recorded_at?: string;
  checklist?: Partial<Checklist>;
};
type RepairWithEvidence = Repair & { review_evidence?: StoredReviewEvidence | null };

const CHECKS: { key: ChecklistKey; label: string }[] = [
  { key: 'surface_restored', label: 'Покрытие восстановлено' },
  { key: 'no_visible_damage', label: 'Видимых повреждений нет' },
  { key: 'area_safe', label: 'Участок безопасен' },
];
const EMPTY_CHECKLIST: Checklist = { surface_restored: false, no_visible_damage: false, area_safe: false };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось отправить решение. Повторите попытку.';
const distanceBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
const distanceLabel = (meters: number) => meters >= 1000
  ? `${(meters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
  : `${Math.round(meters)} м`;

export default function RepairReview({ detail, busy, onAction }: Props) {
  const location = useDeviceLocation();
  const latestRepair = detail.repairs.at(-1) as RepairWithEvidence | undefined;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [checklist, setChecklist] = useState<Checklist>(EMPTY_CHECKLIST);
  const [comment, setComment] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    return () => { window.removeEventListener('online', updateNetwork); window.removeEventListener('offline', updateNetwork); };
  }, []);
  useEffect(() => {
    setPhotos([]); setChecklist(EMPTY_CHECKLIST); setComment(''); setError(''); setSubmitting(false);
  }, [detail.id, detail.version]);

  const allChecked = CHECKS.every(({ key }) => checklist[key]);
  const gpsFix = location.hasFreshPosition ? location.position : null;
  const distance = useMemo(() => gpsFix ? distanceBetween(gpsFix, detail) : null, [gpsFix?.lat, gpsFix?.lng, detail.lat, detail.lng]);
  const canApprove = !!gpsFix && photos.length > 0 && allChecked && online && !busy && !submitting && !photoUploading;
  const canReject = comment.trim().length >= 2 && !busy && !submitting;

  async function sendDecision(action: 'approve' | 'reject') {
    if (action === 'reject') {
      if (!canReject) return;
      setError(''); setSubmitting(true);
      try { await onAction('reject', { comment: comment.trim() }); }
      catch (failure) { setError(errorMessage(failure)); }
      finally { setSubmitting(false); }
      return;
    }
    if (!canApprove || !gpsFix) return;
    setError(''); setSubmitting(true);
    try {
      await onAction('approve', {
        review_evidence: {
          photo_ids: photos.map((photo) => photo.id),
          checklist,
          lat: gpsFix.lat,
          lng: gpsFix.lng,
          accuracy_m: gpsFix.accuracy_m,
          recorded_at: gpsFix.recorded_at,
        },
        comment: comment.trim(),
      });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSubmitting(false); }
  }

  if (!latestRepair) return <section className="rr-panel card" aria-labelledby="rr-title"><div className="rr-heading"><span className="rr-icon"><AlertTriangle size={19}/></span><div><span className="section-label">ПРОВЕРКА РЕМОНТА</span><h3 id="rr-title">Отчёт не найден</h3></div></div><p className="rr-empty">В карточке нет попытки ремонта, которую можно проверить. Обновите данные обращения.</p></section>;

  return <section className="rr-panel card" aria-labelledby="rr-title">
    <div className="rr-heading"><span className="rr-icon"><ShieldCheck size={19}/></span><div><span className="section-label">ПРОВЕРКА РЕМОНТА</span><h3 id="rr-title">Сравните состояние участка</h3><p>Попытка {detail.repairs.length} · отправлена {formatDate(latestRepair.created_at)}</p></div></div>

    <div className="rr-comparison">
      <article className="rr-photo-side rr-before"><div className="rr-photo-title"><span>ДО РЕМОНТА</span><small>Исходные фотографии дефекта</small></div><PhotoGallery photos={detail.photos}/></article>
      <article className="rr-photo-side rr-after"><div className="rr-photo-title"><span>ПОСЛЕ РЕМОНТА</span><small>{latestRepair.photos.length} фото · отчёт исполнителя</small></div><PhotoGallery photos={latestRepair.photos}/><p className="rr-repair-comment">{latestRepair.comment}</p></article>
    </div>

    <div className="rr-evidence-area">
      <div className="rr-checklist"><div className="rr-subheading"><span className="section-label">ПРОВЕРКА УСЛОВИЙ</span><span>Все пункты обязательны для приёмки</span></div>
        {CHECKS.map(({ key, label }) => <label className={`rr-check ${checklist[key] ? 'checked' : ''}`} key={key}><input type="checkbox" checked={checklist[key]} disabled={busy || submitting} onChange={(event) => setChecklist((current) => ({ ...current, [key]: event.target.checked }))}/><span className="rr-checkmark">{checklist[key] && <Check size={14}/>}</span><span>{label}</span></label>)}
      </div>

      <div className="rr-gps-card">
        <div className="rr-subheading"><span className="section-label">ПОЗИЦИЯ ИНСПЕКТОРА</span>{gpsFix ? <span className="rr-gps-live"><i/>Свежая позиция</span> : <span className="rr-gps-wait">Ожидаем GPS</span>}</div>
        {gpsFix ? <div className="rr-gps-metrics"><div><MapPin size={15}/><span>{distance === null ? 'Расстояние не рассчитано' : `${distanceLabel(distance)} до точки дефекта`}</span></div><div><span className="rr-accuracy-dot"/><span>Точность GPS ±{Math.round(gpsFix.accuracy_m)} м</span></div><small>Показаны данные устройства на момент проверки; это не подтверждение точности координат дефекта.</small></div> : <p className="rr-gps-message">Для приёмки нужна актуальная позиция. После восстановления GPS её время и координаты будут сохранены вместе с проверкой.</p>}
      </div>
    </div>

    <label className="field rr-comment-field"><span>Комментарий инспектора <small>необязательно при приёмке, обязательно при возврате</small></span><textarea className="textarea" rows={3} value={comment} disabled={busy || submitting} onChange={(event) => setComment(event.target.value)} placeholder="Опишите решение или необходимые исправления…"/></label>

    <div className="rr-upload"><UploadField photos={photos} onChange={setPhotos} onBusyChange={setPhotoUploading} label="Контрольные фотографии инспектора"/></div>
    {!online && <div className="rr-network-message" role="status"><WifiOff size={15}/><span>Нет подключения к сети. Приёмка станет доступна после восстановления подключения.</span></div>}
    {location.status === 'reconnecting' && !gpsFix && location.showRecoveryNotice && <div className="rr-position-message" role="status"><MapPin size={15}/><span>GPS восстанавливается. Фото отчёта и комментарий сохраняются в форме.</span>{location.showRecoveryNotice && <small>До окончания периода восстановления: {location.recoveryRemainingSeconds} с</small>}</div>}
    {error && <div className="alert error rr-error" role="alert">{error}</div>}
    <div className="rr-actions"><button type="button" className="button danger" disabled={!canReject} onClick={() => void sendDecision('reject')}>{submitting ? 'Отправляем…' : 'Вернуть на доработку'}</button><button type="button" className="button primary" disabled={!canApprove} onClick={() => void sendDecision('approve')}>{busy || submitting ? 'Сохраняем…' : photoUploading ? 'Загрузка фото…' : !gpsFix ? 'Ожидаем GPS' : !online ? 'Нет подключения' : 'Принять ремонт'}</button></div>
    {photos.length > 0 && !photoUploading && !allChecked && <small className="rr-helper">Отметьте все три пункта проверки, чтобы принять ремонт.</small>}
  </section>;
}

export function ReviewEvidenceView({ repair }: { repair: Repair }) {
  const evidence = (repair as RepairWithEvidence).review_evidence;
  if (!evidence) return null;
  return <section className="rr-stored-evidence" aria-label="Доказательства проверки ремонта">
    <div className="rr-stored-heading"><CheckCircle2 size={17}/><div><strong>Материалы проверки инспектора</strong><small>{evidence.checked_at ? `Проверено ${formatDate(evidence.checked_at)}` : 'Время проверки не указано'}</small></div></div>
    <div className="rr-stored-meta">{Number.isFinite(evidence.distance_m) && <span>До дефекта · {distanceLabel(evidence.distance_m!)}</span>}{Number.isFinite(evidence.lat) && Number.isFinite(evidence.lng) && <span>Координаты · {evidence.lat!.toFixed(5)}, {evidence.lng!.toFixed(5)}</span>}{evidence.accuracy_m != null && <span>Точность GPS · ±{Math.round(evidence.accuracy_m)} м</span>}{evidence.recorded_at && <span>Позиция записана · {formatDate(evidence.recorded_at)}</span>}</div>
    {evidence.checklist && <ul className="rr-stored-checks">{CHECKS.map(({ key, label }) => <li className={evidence.checklist?.[key] ? 'passed' : ''} key={key}>{evidence.checklist?.[key] ? <CheckCircle2 size={14}/> : <span/>}{label}</li>)}</ul>}
    <div className="rr-stored-photos"><span className="section-label">ФОТОГРАФИИ ПРОВЕРКИ</span><PhotoGallery photos={evidence.photos ?? []}/></div>
  </section>;
}
