import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import type { Defect, DefectDetail, Inspection, Photo, Section, TrackPoint, User } from './types';
import { DEFECT_TYPES } from './types';
import { formatDate, History, Icon, MapView, PhotoGallery, StatusBadge, UploadField } from './components';
import './inspector.css';

type View = 'sections' | 'survey' | 'create' | 'list' | 'detail';
type DefectTab = 'created' | 'review';
type Bootstrap = { user: User; sections: Section[] };
type LocationFix = { lat: number; lng: number; accuracy_m: number | null; source: 'gps' | 'manual' };

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const fmtCoord = (v: number) => v.toFixed(5);

export default function Inspector({ user }: { user: User }) {
  const [view, setView] = useState<View>('sections');
  const [tab, setTab] = useState<DefectTab>('created');
  const [sections, setSections] = useState<Section[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [defects, setDefects] = useState<Defect[]>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [detail, setDetail] = useState<DefectDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [gps, setGps] = useState<LocationFix | null>(null);
  const [liveGps, setLiveGps] = useState<LocationFix | null>(null);
  const [gpsError, setGpsError] = useState('');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [type, setType] = useState<string>(DEFECT_TYPES[0]);
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [clarification, setClarification] = useState('');
  const [previousDefectId, setPreviousDefectId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const idempotency = useRef<{ fingerprint: string; key: string; body: Record<string, unknown> } | null>(null);
  const currentView = useRef(view);
  currentView.current = view;
  const watchId = useRef<number | null>(null);
  const pendingPoints = useRef<TrackPoint[]>([]);
  const sendingPoints = useRef(false);
  const lastSentPoint = useRef<string>('');

  const loadBase = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [boot, inProgress, allDefects] = await Promise.all([
        api.get<Bootstrap>('/bootstrap'), api.get<Inspection[]>('/inspections'), api.get<Defect[]>('/defects'),
      ]);
      setSections(boot.sections ?? []);
      setInspections(inProgress ?? []);
      setDefects(allDefects ?? []);
      setInspection((inProgress ?? []).find((x) => x.status === 'active' && x.inspector_id === user.id) ?? null);
    } catch (e) { setError(errText(e)); }
    finally { if (!quiet) setLoading(false); }
  }, [user.id]);

  useEffect(() => { void loadBase(); }, [loadBase]);
  useEffect(() => { const timer = window.setInterval(() => setClockNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const warnBeforeExit = (event: BeforeUnloadEvent) => {
      if (!pendingPoints.current.length && !sendingPoints.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeExit);
    return () => window.removeEventListener('beforeunload', warnBeforeExit);
  }, []);
  useEffect(() => { return () => { if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current); }; }, []);

  const sendPendingPoints = useCallback(async (id: string, throwOnFailure = false) => {
    while (sendingPoints.current) await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (!pendingPoints.current.length) return;
    sendingPoints.current = true;
    const batch = pendingPoints.current;
    pendingPoints.current = [];
    try {
      const updated = await api.post<Inspection>(`/inspections/${id}/points`, { points: batch });
      setInspection(updated);
    } catch (e) {
      pendingPoints.current = [...batch, ...pendingPoints.current];
      setError(`Точки маршрута пока не отправлены: ${errText(e)}. Они останутся в форме до повторной отправки.`);
      if (throwOnFailure) throw e;
    } finally { sendingPoints.current = false; }
  }, []);

  const startWatch = useCallback((active: Inspection) => {
    if (!navigator.geolocation) { setGpsError('Браузер не поддерживает геолокацию. Укажите координаты вручную.'); return; }
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    setGpsError('');
    watchId.current = navigator.geolocation.watchPosition((pos) => {
      const fix: LocationFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null, source: 'gps' };
      setLiveGps(fix);
      if (currentView.current === 'survey') setGps(fix);
      const stamp = new Date(pos.timestamp || Date.now()).toISOString();
      if (stamp === lastSentPoint.current) return;
      lastSentPoint.current = stamp;
      pendingPoints.current.push({ client_id: uuid(), lat: fix.lat, lng: fix.lng, recorded_at: stamp, accuracy_m: fix.accuracy_m });
      void sendPendingPoints(active.id);
    }, (e) => {
      setGpsError(e.code === 1 ? 'Нет доступа к геолокации. Разрешите её в браузере или введите координаты вручную.' : 'Не удалось получить координаты. Можно продолжить с ручной отметкой.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }, [sendPendingPoints]);

  useEffect(() => {
    if (inspection?.status !== 'active') return;
    const syncWatch = () => {
      if (document.visibilityState === 'visible') startWatch(inspection);
      else if (watchId.current !== null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    };
    syncWatch();
    document.addEventListener('visibilitychange', syncWatch);
    return () => {
      document.removeEventListener('visibilitychange', syncWatch);
      if (watchId.current !== null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    };
  }, [inspection?.id, inspection?.status, startWatch]);

  const openSection = async (s: Section) => {
    setSection(s); setError(''); setNotice('');
    if (inspection?.section_id === s.id && inspection.status === 'active') { setView('survey'); return; }
    setBusy(true);
    try {
      const created = await api.post<Inspection>('/inspections', { section_id: s.id });
      setInspection(created); setGps(null); pendingPoints.current = []; setView('survey');
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const goToSectionSurvey = (s: Section) => { setSection(s); if (inspection?.section_id === s.id && inspection.status === 'active') setView('survey'); };
  const finishInspection = async () => {
    if (!inspection) return;
    if (watchId.current !== null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
    setBusy(true); setError('');
    const acceptFinished = async (finished: Inspection) => {
      if (watchId.current !== null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
      const ignored = pendingPoints.current.length;
      pendingPoints.current = [];
      setInspection(finished);
      setShowFinishConfirm(false);
      setView('sections');
      setNotice(ignored ? `Осмотр уже завершён. ${ignored} GPS-точек, полученных после завершения, не отправлялись.` : 'Осмотр завершён и сохранён.');
      await loadBase(true);
    };
    try {
      const latest = await api.get<Inspection>(`/inspections/${inspection.id}`);
      if (latest.status === 'finished') { await acceptFinished(latest); return; }
      setInspection(latest);
      await sendPendingPoints(inspection.id, true);
      const result = await api.post<Inspection>(`/inspections/${inspection.id}/finish`, { confirmed: true });
      await acceptFinished(result);
    } catch (e) {
      let latest: Inspection | null = null;
      try { latest = await api.get<Inspection>(`/inspections/${inspection.id}`); } catch { /* Keep queued points until the server status can be confirmed. */ }
      if (latest?.status === 'finished') await acceptFinished(latest);
      else {
        setError(errText(e));
        if (latest?.status === 'active') {
          setInspection(latest);
          if (document.visibilityState === 'visible') startWatch(latest);
        }
      }
    }
    finally { setBusy(false); }
  };

  const manualCoordinates = (latRaw: string, lngRaw: string) => {
    if (!latRaw.trim() || !lngRaw.trim()) { setGpsError('Введите широту и долготу.'); return; }
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setGpsError('Введите широту от −90 до 90 и долготу от −180 до 180.'); return;
    }
    setGps({ lat, lng, accuracy_m: null, source: 'manual' }); setGpsError('');
  };

  const beginCreate = (previousId: string | null = null) => {
    setType(DEFECT_TYPES[0]); setDescription(''); setPhotos([]); setError(''); setNotice('');
    setPreviousDefectId(previousId);
    if (!section && sections[0]) setSection(sections[0]);
    setGps((previous) => previous ?? null); setView('create');
  };

  const submitDefect = async (e: FormEvent) => {
    e.preventDefault();
    if (!section || !gps) { setError('Отметьте место на карте или укажите координаты вручную.'); return; }
    if (!photos.length) { setError('Добавьте хотя бы одну фотографию перед отправкой.'); return; }
    const body = { section_id: section.id, inspection_id: inspection?.status === 'active' && inspection.section_id === section.id ? inspection.id : null, type, description: description.trim(), lat: gps.lat, lng: gps.lng, location_source: gps.source, accuracy_m: gps.accuracy_m, observed_at: new Date().toISOString(), photo_ids: photos.map((p) => p.id), ...(previousDefectId ? {previous_defect_id: previousDefectId} : {}) };
    const fingerprint = JSON.stringify({ ...body, observed_at: '' });
    if (!idempotency.current || idempotency.current.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: uuid(), body };
    const retryBody = idempotency.current.body;
    setBusy(true); setError('');
    try {
      const created = await api.post<DefectDetail>('/defects', retryBody, { 'Idempotency-Key': idempotency.current.key });
      idempotency.current = null; setDetail(created); setNotice('Сообщение о дефекте отправлено.'); setView('detail'); await loadBase(true);
    } catch (err) { setError(`${errText(err)} Повторная отправка с теми же данными использует тот же ключ запроса.`); }
    finally { setBusy(false); }
  };

  const openList = async (which: DefectTab) => { setTab(which); setView('list'); setError(''); await loadBase(true); };
  const openDetail = async (d: Defect) => {
    setBusy(true); setError('');
    try { setDetail(await api.get<DefectDetail>(`/defects/${d.id}`)); setSection(sections.find((s) => s.id === d.section_id) ?? section); setView('detail'); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!detail) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.post<DefectDetail>(`/defects/${detail.id}/actions`, { action, version: detail.version, ...payload });
      setDetail(updated); setClarification(''); setNotice(action === 'approve' ? 'Дефект принят и закрыт.' : action === 'reject' ? 'Работа отправлена на доработку.' : 'Сообщение отправлено.');
      await loadBase(true);
    } catch (e) { setError(errText(e)); if (String((e as { code?: string })?.code) === 'CONFLICT') { try { setDetail(await api.get<DefectDetail>(`/defects/${detail.id}`)); } catch {} } }
    finally { setBusy(false); }
  };

  const reviewDefects = useMemo(() => defects.filter((d) => d.status === 'review'), [defects]);
  const createdDefects = useMemo(() => defects.filter((d) => d.inspector_id === user.id), [defects, user.id]);
  const visibleDefects = tab === 'review' ? reviewDefects : createdDefects;
  const sectionDefects = defects.filter((d) => d.section_id === section?.id);
  const surveySeconds = inspection?.started_at ? Math.max(0, Math.floor((clockNow - Date.parse(inspection.started_at)) / 1000)) : 0;
  const pointCount = inspection?.points.length ?? 0;
  const distanceKm = useMemo(() => {
    const points = inspection?.points ?? [];
    let meters = 0;
    for (let i = 1; i < points.length; i++) meters += distance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    return meters / 1000;
  }, [inspection?.points]);
  const gapCount = useMemo(() => {
    const points = inspection?.points ?? [];
    return points.slice(1).reduce((count, point, index) => count + (Date.parse(point.recorded_at) - Date.parse(points[index].recorded_at) > 60000 ? 1 : 0), 0);
  }, [inspection?.points]);

  return <div className="inspector-app">
    <main className="inspector-main">
      <div className="inspector-pagehead"><div><div className="eyebrow">ПОЛЕВОЙ КАБИНЕТ</div><h1>{pageTitle(view, section)}</h1><p className="muted">{view === 'sections' ? 'Ваши участки и последние осмотры' : view === 'survey' ? 'Записывайте маршрут и отмечайте найденные дефекты' : view === 'create' ? 'Сохраните исходную фотографию и точку обнаружения' : view === 'list' ? 'Сообщения и дефекты, ожидающие проверки' : 'История и фотографии сохраняются в карточке дефекта'}</p></div>{view === 'sections' && <button className="button primary inspector-head-action" onClick={() => void openList('created')}><Icon name="clipboard" size={17} /> Мои дефекты</button>}</div>
      {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}<button className="inspector-alert-close" aria-label="Закрыть" onClick={() => setNotice('')}>×</button></div>}
      {loading ? <div className="card inspector-loading"><span className="inspector-spinner" /> Загружаем данные…</div> : <>
        {view === 'sections' && <section className="inspector-sections-view">
          {inspection?.status === 'active' && <div className="inspector-resume card"><div className="inspector-resume-icon"><Icon name="activity" size={20} /></div><div><strong>Осмотр продолжается</strong><span className="muted">{sections.find((s) => s.id === inspection.section_id)?.name ?? 'Участок'} · начат {formatDate(inspection.started_at)}</span></div><button className="button primary small" onClick={() => { setSection(sections.find((s) => s.id === inspection.section_id) ?? null); setView('survey'); }}>Продолжить <Icon name="arrow" size={15} /></button></div>}
          <div className="inspector-grid">{sections.map((s) => {
            const active = inspection?.section_id === s.id && inspection.status === 'active';
            const latest = inspections.find((i) => i.section_id === s.id && i.status === 'finished');
            return <article className="inspector-section-card card" key={s.id}>
              <div className="inspector-section-map"><MapView section={s} defects={defects.filter((d) => d.section_id === s.id)} height={168} /><span className="inspector-section-code">{s.code}</span></div>
              <div className="inspector-section-content"><div className="inspector-section-title"><div><div className="eyebrow">{s.is_demo ? 'ДЕМО-УЧАСТОК' : 'УЧАСТОК'}</div><h2>{s.name}</h2></div><span className="inspector-length">{Number(s.length_km).toFixed(1)} км</span></div>
                <div className="inspector-section-meta"><span><Icon name="user" size={15} /> {s.responsible}</span><span><Icon name="alert" size={15} /> {defects.filter((d) => d.section_id === s.id && !['closed','cancelled'].includes(d.status)).length} открытых</span></div>
                {latest && <p className="inspector-last-check">Последний осмотр: <b>{formatDate(latest.finished_at)}</b></p>}
                <div className="inspector-section-footer">{active ? <button className="button primary" onClick={() => goToSectionSurvey(s)}>Продолжить осмотр <Icon name="arrow" size={16} /></button> : <button className="button secondary" disabled={busy} onClick={() => void openSection(s)}><Icon name="route" size={16} /> Начать осмотр</button>}<button className="inspector-icon-button" aria-label="Дефекты участка" onClick={() => { setSection(s); void openList('created'); }}><Icon name="clipboard" size={18} /></button></div>
              </div>
            </article>;
          })}</div>
          {!sections.length && <div className="empty">Нет доступных участков</div>}
          <div className="inspector-summary"><div><span className="inspector-summary-icon"><Icon name="shield" size={18}/></span><span><b>Точность начинается с наблюдения</b><small>Отмечайте каждый дефект с фотографией и геопозицией. Координаты и история сохраняются вместе с исходным сообщением.</small></span></div><button className="button secondary small" onClick={() => void openList('review')}>Проверить работы <Icon name="arrow" size={15} /></button></div>
        </section>}

        {view === 'survey' && section && inspection && <section className="inspector-survey-view">
          <div className="inspector-survey-top"><button className="button secondary small" onClick={() => setView('sections')}><Icon name="left" size={16}/> Все участки</button><div className="inspector-live"><i/> ИДЁТ ОСМОТР</div><span className="inspector-survey-start">Начат {formatDate(inspection.started_at)}</span></div>
          <div className="inspector-survey-map card"><MapView section={section} defects={sectionDefects} track={inspection.points} onPosition={(lat,lng) => { setGps({lat,lng,accuracy_m:null,source:'manual'}); setManualLat(String(lat)); setManualLng(String(lng)); }} height={420} /></div>
          <div className="inspector-metrics"><div className="stat"><span>Время</span><strong>{elapsed(surveySeconds)}</strong><small>на участке</small></div><div className="stat"><span>Маршрут</span><strong>{distanceKm.toFixed(2)} <small>км</small></strong><small>{pointCount} точек GPS</small></div><div className="stat"><span>Пробелы GPS</span><strong>{gapCount}</strong><small>интервалов более 1 мин</small></div><div className="stat"><span>Дефекты</span><strong>{sectionDefects.filter((d) => d.inspection_id === inspection.id).length}</strong><small>отмечено в этом осмотре</small></div><div className="inspector-gps-stat"><div className="inspector-gps-dot"/><div><b>{gps ? `GPS · ±${Math.round(gps.accuracy_m ?? 0)} м` : 'Ожидаем GPS'}</b><small>{gps ? `${fmtCoord(gps.lat)}, ${fmtCoord(gps.lng)}` : gpsError || 'Включите геолокацию устройства'}</small></div></div></div>
          <div className="inspector-survey-actions"><div><h2>Нашли повреждение?</h2><p className="muted">Добавьте фото и координаты прямо с участка.</p></div><div className="row"><button className="button primary" onClick={() => beginCreate()}><Icon name="plus" size={17}/> Зафиксировать дефект</button><button className="button secondary" onClick={() => setShowFinishConfirm(true)}><Icon name="check" size={17}/> Завершить осмотр</button></div></div>
        </section>}

        {view === 'create' && section && <form className="inspector-create-view" onSubmit={submitDefect}>
          <div className="inspector-form-toolbar"><button type="button" className="button secondary small" onClick={() => setView(inspection?.status === 'active' ? 'survey' : 'sections')}><Icon name="left" size={16}/> Назад к осмотру</button><span className="inspector-context"><Icon name="pin" size={15}/>{section.code} · {section.name}</span></div>
          <div className="inspector-create-grid"><div className="inspector-form-column">
            <div className="card inspector-form-card"><div className="inspector-card-head"><span className="inspector-step">01</span><div><h2>Что обнаружено?</h2><p className="muted">Выберите тип и опишите состояние участка</p></div></div>
              <label className="field"><span>Тип дефекта <em>*</em></span><select className="select" value={type} onChange={(e) => setType(e.target.value)}>{DEFECT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="field"><span>Описание <em>*</em></span><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} maxLength={2000} placeholder="Опишите размер повреждения, состояние покрытия и возможную опасность…" rows={4}/><small className="muted inspector-count">{description.length}/2000</small></label>
            </div>
            <div className="card inspector-form-card"><div className="inspector-card-head"><span className="inspector-step">02</span><div><h2>Фотография</h2><p className="muted">Оригинал фото сохраняется для проверки и истории ремонта</p></div></div><UploadField photos={photos} onChange={setPhotos} label="Добавить фото дефекта" />{!photos.length && <p className="inspector-photo-required"><Icon name="alert" size={15}/> Фото обязательно для отправки</p>}</div>
          </div><div className="inspector-location-column">
            <div className="card inspector-form-card inspector-location-card"><div className="inspector-card-head"><span className="inspector-step">03</span><div><h2>Место дефекта</h2><p className="muted">Точка сохраняется вместе с типом геолокации</p></div></div>
              <div className="inspector-location-map"><MapView section={section} defects={sectionDefects} selectedId={detail?.id} onPosition={(lat,lng) => { setGps({lat,lng,accuracy_m:null,source:'manual'}); setManualLat(String(lat)); setManualLng(String(lng)); setGpsError(''); }} height={236}/><div className="inspector-location-label"><Icon name={gps?.source === 'gps' ? 'gps' : 'pin'} size={15}/>{gps ? `${gps.source === 'gps' ? 'GPS' : 'Отметка на карте'} · ${fmtCoord(gps.lat)}, ${fmtCoord(gps.lng)}` : 'Нажмите на карту, чтобы поставить точку'}</div></div>
              <div className="inspector-manual-coords"><span className="inspector-or">ИЛИ ВВЕДИТЕ КООРДИНАТЫ</span><div className="inspector-coord-fields"><label className="field"><span>Широта</span><input className="input" inputMode="decimal" placeholder="44.848" value={manualLat} onChange={(e) => setManualLat(e.target.value)}/></label><label className="field"><span>Долгота</span><input className="input" inputMode="decimal" placeholder="65.482" value={manualLng} onChange={(e) => setManualLng(e.target.value)}/></label><button type="button" className="button secondary small" onClick={() => manualCoordinates(manualLat,manualLng)}>Применить</button></div></div>
              {gpsError && <div className="inspector-gps-error">{gpsError}</div>}
              <button type="button" className="inspector-use-gps" onClick={() => { if (gps?.source === 'gps') { setManualLat(fmtCoord(gps.lat)); setManualLng(fmtCoord(gps.lng)); } else if (navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { setGps({lat:p.coords.latitude,lng:p.coords.longitude,accuracy_m:p.coords.accuracy,source:'gps'}); setGpsError(''); }, () => setGpsError('Не удалось получить координаты. Проверьте разрешение браузера.'), {enableHighAccuracy:true, timeout:12000}); }}><Icon name="locate" size={16}/> Использовать моё местоположение</button>
            </div>
            <div className="inspector-submit-card"><div><b>Проверьте данные</b><span>{photos.length ? `${photos.length} фото · ` : 'Фото не добавлено · '}{gps ? `${gps.source === 'gps' ? 'GPS' : 'ручная точка'}` : 'место не указано'}</span></div><button className="button primary" type="submit" disabled={busy || !gps || !photos.length}>{busy ? 'Отправляем…' : 'Отправить сообщение'} <Icon name="arrow" size={16}/></button></div>
          </div></div>
        </form>}

        {view === 'list' && <section className="inspector-list-view"><div className="inspector-list-head"><div className="tabs"><button className={`tab ${tab === 'created' ? 'active' : ''}`} onClick={() => setTab('created')}>Мои сообщения <span>{createdDefects.length}</span></button><button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>На проверке <span>{reviewDefects.length}</span></button></div><button className="button primary small" onClick={() => beginCreate()}><Icon name="plus" size={16}/> Новый дефект</button></div>
          {visibleDefects.length ? <div className="inspector-defect-list">{visibleDefects.filter((d) => !section || view !== 'list' || tab !== 'created' || d.section_id === section.id).map((d) => <button type="button" className="inspector-defect-row card" key={d.id} onClick={() => void openDetail(d)}><span className="inspector-defect-thumb">{d.photos[0]?.url ? <img src={d.photos[0].url} alt="Фото дефекта"/> : <Icon name="camera" size={22}/>}</span><span className="inspector-defect-info"><b>{d.type} <small>№ {d.number}</small></b><span>{sections.find((s) => s.id === d.section_id)?.name ?? 'Участок'} · {formatDate(d.observed_at)}</span><small>{d.description || 'Без описания'}</small></span><StatusBadge status={d.status} overdue={d.overdue}/><Icon name="right" size={18}/></button>)}</div> : <div className="empty inspector-empty"><span className="inspector-empty-icon"><Icon name={tab === 'review' ? 'check' : 'clipboard'} size={23}/></span><b>{tab === 'review' ? 'Нет работ на проверке' : 'Сообщений пока нет'}</b><span>{tab === 'review' ? 'Когда подрядчик отправит работу, она появится здесь.' : 'Зафиксируйте первый дефект прямо во время осмотра участка.'}</span>{tab === 'created' && <button className="button secondary small" onClick={() => beginCreate()}>Добавить дефект</button>}</div>}
        </section>}

        {view === 'detail' && detail && <section className="inspector-detail-view"><div className="inspector-form-toolbar"><button className="button secondary small" onClick={() => setView('list')}><Icon name="left" size={16}/> К списку</button><span className="inspector-detail-id">№ {detail.number} · создан {formatDate(detail.received_at)}</span></div>
          <div className="inspector-detail-grid"><div className="inspector-detail-main"><div className="card inspector-detail-card"><div className="inspector-detail-title"><div><div className="eyebrow">{sections.find((s) => s.id === detail.section_id)?.code ?? 'ДЕФЕКТ'}</div><h2>{detail.type}</h2></div><StatusBadge status={detail.status} overdue={detail.overdue}/></div><p className="inspector-detail-description">{detail.description}</p><div className="inspector-detail-meta"><span><Icon name="clock" size={15}/>{formatDate(detail.observed_at)}</span><span><Icon name="pin" size={15}/>{fmtCoord(detail.lat)}, {fmtCoord(detail.lng)} · {detail.location_source === 'gps' ? 'GPS' : 'отмечено вручную'}</span></div><PhotoGallery photos={detail.photos}/>{detail.previous_defect_id && <div className="inspector-recurrence"><Icon name="refresh" size={16}/> Повторное сообщение по ранее закрытому дефекту</div>}</div>
            {detail.repairs?.length > 0 && <div className="card inspector-detail-card"><div className="inspector-card-head"><span className="inspector-step inspector-step-repair"><Icon name="activity" size={17}/></span><div><h2>Фото ремонта</h2><p className="muted">Материалы подрядчика и результат проверки</p></div></div>{detail.repairs.map((r) => <div className="inspector-repair" key={r.id}><div className="inspector-repair-head"><b>{formatDate(r.created_at)}</b>{r.decision && <span className={`inspector-repair-decision ${r.decision}`}>{r.decision === 'accepted' ? 'Принято' : 'На доработку'}</span>}</div><p>{r.comment}</p><PhotoGallery photos={r.photos}/>{r.decision_comment && <div className="inspector-review-comment">Комментарий проверки: {r.decision_comment}</div>}</div>)}</div>}
            <div className="card inspector-detail-card"><div className="inspector-card-head"><span className="inspector-step inspector-step-history"><Icon name="history" size={17}/></span><div><h2>История</h2><p className="muted">Все изменения и сообщения по дефекту</p></div></div><History events={detail.history}/></div>
          </div><aside className="inspector-detail-aside"><div className="card inspector-detail-card"><h3>Расположение</h3><div className="inspector-detail-map"><MapView section={sections.find((s) => s.id === detail.section_id) ?? undefined} defects={[detail]} selectedId={detail.id} height={205}/></div><p className="inspector-detail-address"><Icon name="pin" size={15}/>{fmtCoord(detail.lat)}, {fmtCoord(detail.lng)}</p><span className="muted">{sections.find((s) => s.id === detail.section_id)?.name ?? 'Участок'}</span></div>
              {detail.status === 'review' && <div className="card inspector-review-actions"><span className="inspector-review-mark"><Icon name="check" size={18}/></span><h3>Проверка ремонта</h3><p className="muted">Сравните фотографии ремонта с исходным состоянием.</p><label className="field"><span>Комментарий <em>обязателен при отказе</em></span><textarea className="textarea" rows={3} value={clarification} onChange={(e) => setClarification(e.target.value)} placeholder="Что нужно исправить?"/></label><button className="button primary" disabled={busy} onClick={() => void act('approve')}>Принять ремонт <Icon name="check" size={16}/></button><button className="button danger" disabled={busy || clarification.trim().length < 2} onClick={() => void act('reject', {comment:clarification.trim()})}>Отправить на доработку</button></div>}
              {detail.status === 'needs_info' && detail.inspector_id === user.id && <div className="card inspector-review-actions"><h3>Уточнение диспетчера</h3><p className="muted">Ответьте, чтобы вернуть сообщение в работу.</p><label className="field"><span>Ответ <em>*</em></span><textarea className="textarea" rows={3} value={clarification} onChange={(e) => setClarification(e.target.value)} placeholder="Добавьте уточнение…"/></label><button className="button primary" disabled={busy || clarification.trim().length < 2} onClick={() => void act('clarify',{comment:clarification.trim()})}>Отправить ответ</button></div>}
              {detail.status === 'closed' && <div className="inspector-recurrence-card"><Icon name="refresh" size={19}/><div><b>Повреждение появилось снова?</b><p>Создайте новое сообщение. Закрытый дефект останется в истории.</p><button className="button secondary small" onClick={() => { setSection(sections.find((s) => s.id === detail.section_id) ?? null); setGps({lat:detail.lat,lng:detail.lng,accuracy_m:null,source:'manual'}); beginCreate(detail.id); }}>Сообщить о повторе</button></div></div>}
          </aside></div>
        </section>}
      </>}
    </main>
    <nav className="inspector-mobile-nav"><button className={view === 'sections' || view === 'survey' ? 'active' : ''} onClick={() => setView('sections')}><Icon name="route" size={20}/><span>Участки</span></button><button className={view === 'list' && tab === 'created' ? 'active' : ''} onClick={() => void openList('created')}><Icon name="clipboard" size={20}/><span>Мои дефекты</span></button><button className={view === 'list' && tab === 'review' ? 'active' : ''} onClick={() => void openList('review')}><Icon name="check" size={20}/><span>Проверка</span></button></nav>
    {showFinishConfirm && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowFinishConfirm(false); }}><div className="modal inspector-finish-modal" role="dialog" aria-modal="true" aria-labelledby="finish-title"><span className="inspector-finish-icon"><Icon name="check" size={22}/></span><h2 id="finish-title">Завершить осмотр?</h2><p>Маршрут и найденные дефекты будут сохранены. После завершения продолжить запись GPS-точек нельзя.</p><div className="row"><button className="button secondary" onClick={() => setShowFinishConfirm(false)}>Продолжить осмотр</button><button className="button primary" disabled={busy} onClick={() => void finishInspection()}>{busy ? 'Сохраняем…' : 'Завершить'}</button></div></div></div>}
  </div>;
}

function pageTitle(view: View, section: Section | null) { return view === 'sections' ? 'Мои участки' : view === 'survey' ? section?.name ?? 'Осмотр участка' : view === 'create' ? 'Новое сообщение о дефекте' : view === 'list' ? 'Дефекты' : 'Карточка дефекта'; }
function errText(e: unknown) { return (e as { message?: string })?.message || 'Не удалось выполнить запрос. Проверьте подключение и попробуйте снова.'; }
function elapsed(total: number) { return `${String(Math.floor(total / 3600)).padStart(2,'0')}:${String(Math.floor((total % 3600) / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`; }
function distance(lat1: number,lng1: number,lat2: number,lng2: number) { const rad = Math.PI / 180, dLat = (lat2-lat1)*rad, dLng=(lng2-lng1)*rad; const a=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLng/2)**2; return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
