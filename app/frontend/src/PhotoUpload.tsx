import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, Loader2, RefreshCw, Upload, X } from 'lucide-react';
import { ApiError, upload } from './api';
import type { Photo } from './types';
import { useDeviceLocation } from './geolocation';

export function UploadField({ photos, onChange, label = 'Фотография', onBusyChange }: { photos: Photo[]; onChange: (photos: Photo[]) => void; label?: string; onBusyChange?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [errorCode, setErrorCode] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadedName, setUploadedName] = useState('');
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible');
  const picker = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null);
  const sending = useRef(false), alive = useRef(true), photosRef = useRef(photos), changeRef = useRef(onChange), busyRef = useRef(onBusyChange);
  photosRef.current = photos; changeRef.current = onChange; busyRef.current = onBusyChange;
  const location = useDeviceLocation();
  useEffect(() => { alive.current = true; return () => { alive.current = false; busyRef.current?.(false); }; }, []);
  useEffect(() => { const update = () => setPageVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);

  async function send(file: File) {
    if (sending.current) return;
    sending.current = true; setBusy(true); busyRef.current?.(true); setError(''); setErrorCode('');
    try {
      const photo = await upload(file);
      if (!alive.current) return;
      changeRef.current([...photosRef.current, photo]); setPendingFile(null); setUploadedName(file.name);
    } catch (failure) {
      if (!alive.current) return;
      setError((failure as Error).message || 'Не удалось загрузить фотографию.');
      setErrorCode(failure instanceof ApiError ? failure.code : 'NETWORK_ERROR');
    } finally {
      sending.current = false;
      if (alive.current) { setBusy(false); busyRef.current?.(false); }
    }
  }
  function select(file?: File) {
    if (!file || sending.current) return;
    setUploadedName(''); setError(''); setErrorCode(''); setPendingFile(null);
    if (!file.size) { setError('Файл пустой. Выберите другую фотографию.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Фотография больше 10 МБ. Уменьшите её размер или выберите другой файл.'); return; }
    setPendingFile(file); void send(file);
  }
  // GPS_REQUIRED happens before any request; safely retry the retained file once location returns.
  useEffect(() => { if (errorCode === 'GPS_REQUIRED' && location.ready && pageVisible && pendingFile && !sending.current) void send(pendingFile); }, [errorCode, location.ready, pageVisible, pendingFile]);
  const retryable = pendingFile && (['NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'INVALID_UPLOAD_RESPONSE', 'GPS_REQUIRED'].includes(errorCode) || /^5\d\d$/.test(errorCode));
  return <div className="upload-block">
    <span className="section-label">{label} <span className="required">*</span></span>
    {!!photos.length && <div className="upload-previews">{photos.map(photo => <div key={photo.id}><img src={photo.url} alt={photo.name}/><button type="button" className="icon-button" aria-label={`Убрать фото ${photo.name}`} disabled={busy} onClick={() => onChange(photos.filter(item => item.id !== photo.id))}><X size={16}/></button></div>)}</div>}
    <div className={`upload-zone photo-upload-zone ${busy ? 'busy' : ''}`} aria-busy={busy}>
      {busy ? <Loader2 size={27}/> : <Upload size={27}/>}
      <strong>{busy ? 'Загружаем фотографию…' : photos.length ? 'Добавить ещё фото' : 'Добавьте фотографию'}</strong>
      <small>JPG, PNG или WebP · до 10 МБ</small>
      {pendingFile && <span className="upload-filename">{pendingFile.name}</span>}
      <div className="upload-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => picker.current?.click()}><Upload size={16}/>Выбрать файл</button><button type="button" className="button secondary small upload-camera" disabled={busy} onClick={() => camera.current?.click()}><Camera size={16}/>Сделать фото</button></div>
      <input ref={picker} className="photo-file-input" aria-label={label} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; select(file); }}/>
      <input ref={camera} className="photo-file-input" aria-label="Сделать фото камерой" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; select(file); }}/>
    </div>
    {uploadedName && !error && <div className="upload-success" role="status"><CheckCircle2 size={15}/>Фото «{uploadedName}» загружено</div>}
    {error && <div className="alert error upload-error" role="alert"><span>{error}{errorCode === 'GPS_REQUIRED' ? ' Файл сохранён в форме и загрузится после восстановления геолокации.' : ''}</span>{retryable && <button type="button" className="button secondary small" disabled={busy || errorCode === 'GPS_REQUIRED' && !location.ready} onClick={() => pendingFile && void send(pendingFile)}><RefreshCw size={15}/>Повторить загрузку</button>}</div>}
  </div>;
}
