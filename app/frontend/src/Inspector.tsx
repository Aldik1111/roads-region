import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import type { Bootstrap, Defect, DefectDetail, Inspection, Photo, RouteResults, Section, TrackPoint, User } from './types';
import { DEFECT_TYPES } from './types';
import { formatDate, History, Icon, MapView, PhotoGallery, StatusBadge, UploadField } from './components';
import { useDeviceLocation } from './geolocation';
import './inspector.css';

type View = 'sections' | 'survey' | 'create' | 'list' | 'detail' | 'history';
type DefectTab = 'created' | 'review';
type LocationFix = { lat: number; lng: number; accuracy_m: number | null; source: 'gps' | 'manual' };

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const fmtCoord = (v: number) => v.toFixed(5);

export default function Inspector({ user, onLogout }: { user: User; onLogout?: () => void }) {
  const [view, setView] = useState<View>('sections');
  const [tab, setTab] = useState<DefectTab>('created');
  const [sections, setSections] = useState<Section[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [defects, setDefects] = useState<Defect[]>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [routeResults, setRouteResults] = useState<RouteResults | null>(null);
  const [historyInspectionId, setHistoryInspectionId] = useState<string | null>(null);
  const [listSectionId, setListSectionId] = useState<string | null>(null);
  const [createNeedsRoute, setCreateNeedsRoute] = useState(false);
  const [createReturnView, setCreateReturnView] = useState<View>('sections');
  const [detail, setDetail] = useState<DefectDetail | null>(null);
  const [detailReturnView, setDetailReturnView] = useState<View>('list');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [gps, setGps] = useState<LocationFix | null>(null);
  const [gpsError, setGpsError] = useState('');
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [type, setType] = useState<string>(DEFECT_TYPES[0]);
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [clarification, setClarification] = useState('');
  const [previousDefectId, setPreviousDefectId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  const location = useDeviceLocation();
  const gpsGateHeading = useRef<HTMLHeadingElement | null>(null);
  const gpsRetryButton = useRef<HTMLButtonElement | null>(null);
  const idempotency = useRef<{ fingerprint: string; key: string; body: Record<string, unknown> } | null>(null);
  const pendingPoints = useRef<TrackPoint[]>([]);
  const sendingPoints = useRef(false);
  const lastSentPoint = useRef<string>('');
  const finishingInspection = useRef(false);

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
      const active = (inProgress ?? []).find((x) => x.status === 'active' && x.inspector_id === user.id) ?? null;
      setInspection(active);
      setSection((current) => {
        const selected = active?.section_id ?? current?.id;
        return selected ? (boot.sections ?? []).find((s) => s.id === selected) ?? null : null;
      });
    } catch (e) { setError(errText(e)); }
    finally { if (!quiet) setLoading(false); }
  }, [user.id]);

  useEffect(() => { void loadBase(); }, [loadBase]);
  useEffect(() => {
    if (location.ready) return;
    if (location.status === 'requesting') gpsGateHeading.current?.focus();
    else gpsRetryButton.current?.focus();
  }, [location.ready, location.status]);
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

  useEffect(() => {
    const position = location.position;
    if (!location.hasFreshPosition || !position) return;
    const fix: LocationFix = { lat: position.lat, lng: position.lng, accuracy_m: position.accuracy_m, source: 'gps' };
    if (view === 'survey') setGps((current) => current?.source === 'manual' ? current : fix);
    // A form opened during recovery receives its first fix once GPS returns.
    // Existing form coordinates remain stable for edits and idempotent retries.
    if (view === 'create') setGps((current) => current ?? fix);
  }, [location.position, location.hasFreshPosition, view]);

  useEffect(() => {
    if (finishingInspection.current || document.visibilityState !== 'visible' || !location.hasFreshPosition || !location.position || inspection?.status !== 'active') return;
    const { position } = location;
    const stamp = position.recorded_at;
    if (stamp !== lastSentPoint.current) {
      lastSentPoint.current = stamp;
      pendingPoints.current.push({ client_id: uuid(), lat: position.lat, lng: position.lng, recorded_at: stamp, accuracy_m: position.accuracy_m });
    }
    if (pendingPoints.current.length) void sendPendingPoints(inspection.id);
  }, [inspection?.id, inspection?.status, location.position, location.hasFreshPosition, sendPendingPoints]);

  const openSection = async (s: Section, repeat = false) => {
    if (!location.ready) return;
    setSection(s); setError(''); setNotice('');
    if (inspection?.status === 'active') {
      if (inspection.section_id === s.id) { setView('survey'); return; }
      setError(`Сначала завершите осмотр маршрута ${sections.find((route) => route.id === inspection.section_id)?.name ?? 'из списка выше'}. Одновременно можно вести только один осмотр.`);
      return;
    }
    if (!location.hasFreshPosition) return;
    if (s.state === 'completed' && !repeat) {
      setError('Этот маршрут уже осмотрен. Для нового осмотра выберите «Повторить осмотр».');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<Inspection>('/inspections', { section_id: s.id });
      setInspection(created); setSections((routes) => routes.map((route) => route.id === s.id ? { ...route, state: 'in_progress' } : route)); setGps(null); pendingPoints.current = []; lastSentPoint.current = ''; setListSectionId(null); setView('survey');
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const goToSectionSurvey = (s: Section) => { setSection(s); if (inspection?.section_id === s.id && inspection.status === 'active') setView('survey'); };
  const finishInspection = async () => {
    if (!location.ready || !inspection || finishingInspection.current) return;
    finishingInspection.current = true;
    let resumeTrack = false;
    setBusy(true); setError('');
    const acceptFinished = async (finished: Inspection) => {
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
          resumeTrack = true;
        }
      }
    }
    finally {
      finishingInspection.current = false;
      if (resumeTrack && location.ready) {
        const position = location.position;
        if (position && position.recorded_at !== lastSentPoint.current) {
          lastSentPoint.current = position.recorded_at;
          pendingPoints.current.push({ client_id: uuid(), lat: position.lat, lng: position.lng, recorded_at: position.recorded_at, accuracy_m: position.accuracy_m });
        }
        if (pendingPoints.current.length) void sendPendingPoints(inspection.id);
      }
      setBusy(false);
    }
  };

  const manualCoordinates = (latRaw: string, lngRaw: string) => {
    if (!location.ready) return;
    if (!latRaw.trim() || !lngRaw.trim()) { setGpsError('Введите широту и долготу.'); return; }
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setGpsError('Введите широту от −90 до 90 и долготу от −180 до 180.'); return;
    }
    setGps({ lat, lng, accuracy_m: null, source: 'manual' }); setGpsError('');
  };

  const beginCreate = (previousId: string | null = null) => {
    if (!location.ready) return;
    setType(DEFECT_TYPES[0]); setDescription(''); setPhotos([]); setPhotoUploading(false); setError(''); setNotice('');
    setPreviousDefectId(previousId);
    setCreateReturnView(view === 'survey' ? 'survey' : view === 'list' ? 'list' : view === 'detail' ? 'detail' : 'sections');
    const fromActiveSurvey = view === 'survey' && inspection?.status === 'active' && section?.id === inspection.section_id;
    const needsRoute = !previousId && !fromActiveSurvey && !listSectionId;
    setCreateNeedsRoute(needsRoute);
    if (previousId) setGps((previous) => previous ?? null);
    else setGps((current) => fromActiveSurvey && current?.source === 'manual' ? current : location.position ? { lat: location.position.lat, lng: location.position.lng, accuracy_m: location.position.accuracy_m, source: 'gps' } : null);
    setView('create');
  };

  const submitDefect = async (e: FormEvent) => {
    e.preventDefault();
    if (!location.hasFreshPosition) return;
    if (photoUploading) { setError('Дождитесь завершения загрузки фотографии.'); return; }
    if (!section || !gps) { setError('Отметьте место на карте или скорректируйте координаты при включённом GPS.'); return; }
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

  const openList = async (which: DefectTab, routeId: string | null = null) => {
    setTab(which); setListSectionId(routeId); setView('list'); setError('');
    setSection(routeId ? sections.find((route) => route.id === routeId) ?? null : null);
    await loadBase(true);
    if (routeId) setSection(sections.find((route) => route.id === routeId) ?? null);
  };
  const openRouteHistory = async (route: Section) => {
    setSection(route); setRouteResults(null); setHistoryInspectionId(null); setError(''); setBusy(true); setView('history');
    try {
      const result = await api.get<RouteResults>(`/routes/${route.id}/results`);
      setRouteResults(result);
      const latest = [...result.inspections].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).at(-1);
      setHistoryInspectionId(latest?.id ?? null);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  const openDetail = async (d: Defect) => {
    setBusy(true); setError('');
    try { setDetail(await api.get<DefectDetail>(`/defects/${d.id}`)); setDetailReturnView(view === 'history' ? 'history' : 'list'); setSection(sections.find((s) => s.id === d.section_id) ?? section); setView('detail'); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };

  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!location.ready || !detail) return;
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
  const scopedDefects = visibleDefects.filter((d) => !listSectionId || d.section_id === listSectionId);
  const scopedCreatedCount = createdDefects.filter((d) => !listSectionId || d.section_id === listSectionId).length;
  const scopedReviewCount = reviewDefects.filter((d) => !listSectionId || d.section_id === listSectionId).length;
  const sectionDefects = defects.filter((d) => d.section_id === section?.id);
  const historyInspection = routeResults?.inspections.find((item) => item.id === historyInspectionId) ?? null;
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
    <div className="inspector-workspace" aria-hidden={!location.ready} inert={!location.ready}>
    <main className="inspector-main">
      <div className="inspector-pagehead"><div><div className="eyebrow">ПОЛЕВОЙ КАБИНЕТ</div><h1>{pageTitle(view, section)}</h1><p className="muted">{view === 'sections' ? 'Выберите назначенный маршрут и начните осмотр' : view === 'survey' ? 'Записывайте маршрут и отмечайте найденные дефекты' : view === 'create' ? 'Сохраните исходную фотографию и точку обнаружения' : view === 'list' ? 'Сообщения и дефекты, ожидающие проверки' : view === 'history' ? 'Пройденные маршруты, GPS-треки и замечания' : 'История и фотографии сохраняются в карточке дефекта'}</p></div>{view === 'sections' && <button className="button primary inspector-head-action" onClick={() => void openList('created')}><Icon name="clipboard" size={17} /> Мои дефекты</button>}</div>
      {location.status === 'reconnecting' && location.showRecoveryNotice && <div className="inspector-gps-recovery"><Icon name="locate" size={19}/><div><b role="status">Восстанавливаем GPS-сигнал</b><p>Можно продолжать заполнять форму и добавлять фото. Отправка дефекта станет доступна после восстановления GPS.</p></div><span>Ещё {location.recoveryRemainingSeconds} с</span></div>}
      {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}<button className="inspector-alert-close" aria-label="Закрыть" onClick={() => setNotice('')}>×</button></div>}
      {loading ? <div className="card inspector-loading"><span className="inspector-spinner" /> Загружаем данные…</div> : <>
        {view === 'sections' && <section className="inspector-sections-view">
          {inspection?.status === 'active' && <div className="inspector-resume card"><div className="inspector-resume-icon"><Icon name="activity" size={20} /></div><div><strong>Осмотр продолжается</strong><span className="muted">{sections.find((s) => s.id === inspection.section_id)?.name ?? inspection.section_id} · начат {formatDate(inspection.started_at)}</span></div><button className="button primary small" onClick={() => { setSection(sections.find((s) => s.id === inspection.section_id) ?? null); setView('survey'); }}>Продолжить <Icon name="arrow" size={15} /></button></div>}
          <div className="inspector-grid">{sections.map((s) => {
            const active = inspection?.section_id === s.id && inspection.status === 'active';
            const activeElsewhere = inspection?.status === 'active' && !active;
            const completed = s.state === 'completed';
            const latest = inspections.find((i) => i.section_id === s.id && i.status === 'finished');
            return <article className="inspector-section-card card" key={s.id}>
              <div className="inspector-section-map"><MapView section={s} defects={defects.filter((d) => d.section_id === s.id)} locateOnOpen={false} height={168} /><span className="inspector-section-code">{s.code}</span></div>
              <div className="inspector-section-content"><div className="inspector-section-title"><div><div className="eyebrow">{s.source === 'demo' ? 'ДЕМО-МАРШРУТ' : 'НАЗНАЧЕННЫЙ МАРШРУТ'}</div><h2>{s.name}</h2></div><span className="inspector-length">{Number(s.length_km).toFixed(1)} км</span></div>
                {s.notes && <p className="inspector-route-notes">{s.notes}</p>}
                <div className="inspector-section-meta"><span><Icon name="user" size={15} /> {s.inspector_name || user.name}</span><span><Icon name="alert" size={15} /> {defects.filter((d) => d.section_id === s.id && !['closed','cancelled'].includes(d.status)).length} открытых</span></div>
                <div className="inspector-route-state"><span className={`inspector-route-state-pill ${s.state}`}>{routeStateLabel(s.state)}</span>{latest && <span>Последний осмотр: {formatDate(latest.finished_at)}</span>}{Number.isFinite(s.duration_min) && s.duration_min > 0 && <span>Расчётное время · {durationLabel(s.duration_min)}</span>}</div>
                <div className="inspector-section-footer">{active ? <button className="button primary" onClick={() => goToSectionSurvey(s)}>Продолжить осмотр <Icon name="arrow" size={16} /></button> : <button className="button secondary" disabled={busy || activeElsewhere || !location.hasFreshPosition} title={activeElsewhere ? 'Сначала завершите активный осмотр другого маршрута' : undefined} onClick={() => void openSection(s, completed)}><Icon name={completed ? 'refresh' : 'route'} size={16} /> {activeElsewhere ? 'Другой осмотр активен' : !location.hasFreshPosition ? 'Ожидаем GPS' : completed ? 'Повторить осмотр' : 'Начать осмотр'}</button>}
                  {activeElsewhere && <small className="inspector-route-disabled-reason">Сначала завершите активный маршрут</small>}
                  <div className="inspector-route-links">{completed && <button className="button secondary small" onClick={() => void openRouteHistory(s)} disabled={busy}><Icon name="history" size={15}/> История</button>}<button className="inspector-icon-button" aria-label="Дефекты маршрута" title="Дефекты маршрута" onClick={() => void openList('created', s.id)}><Icon name="clipboard" size={18} /></button></div>
                </div>
              </div>
            </article>;
          })}</div>
          {!sections.length && <div className="empty inspector-no-routes"><Icon name="route" size={25}/><b>Маршруты пока не назначены</b><span>Когда диспетчер назначит вам маршрут, он появится здесь.</span></div>}
          <div className="inspector-summary"><div><span className="inspector-summary-icon"><Icon name="shield" size={18}/></span><span><b>Точность начинается с наблюдения</b><small>Отмечайте каждый дефект с фотографией и геопозицией. Координаты и история сохраняются вместе с исходным сообщением.</small></span></div><button className="button secondary small" onClick={() => void openList('review')}>Проверить работы <Icon name="arrow" size={15} /></button></div>
        </section>}

        {view === 'history' && section && <section className="inspector-route-history"><div className="inspector-form-toolbar"><button className="button secondary small" onClick={() => setView('sections')}><Icon name="left" size={16}/> Мои маршруты</button><button className="button primary small" disabled={busy || (inspection?.status === 'active' && inspection.section_id !== section.id)} onClick={() => void openSection(section, true)}><Icon name={inspection?.status === 'active' && inspection.section_id === section.id ? 'arrow' : 'refresh'} size={15}/> {inspection?.status === 'active' && inspection.section_id === section.id ? 'Продолжить осмотр' : 'Повторить осмотр'}</button></div>
          <div className="inspector-history-heading card"><div><div className="eyebrow">{section.code} · ИСТОРИЯ НАЗНАЧЕНИЯ</div><h2>{section.name}</h2>{section.notes && <p>{section.notes}</p>}</div><span className="inspector-route-state-pill completed">{routeStateLabel(section.state)}</span></div>
          {busy && !routeResults ? <div className="card inspector-loading"><span className="inspector-spinner"/> Загружаем историю маршрута…</div> : routeResults && <>
            {historyInspection ? <div className="inspector-history-map card"><MapView section={section} defects={routeResults.defects} track={historyInspection.points} locateOnOpen={false} height={370}/></div> : <div className="empty inspector-empty"><span className="inspector-empty-icon"><Icon name="history" size={23}/></span><b>История осмотров пока пуста</b><span>Завершённые осмотры и GPS-треки появятся здесь.</span></div>}
            {routeResults.inspections.length > 0 && <div className="card inspector-history-inspections"><div className="inspector-card-head"><span className="inspector-step inspector-step-history"><Icon name="history" size={17}/></span><div><h2>Осмотры маршрута</h2><p className="muted">Выберите завершённый осмотр, чтобы посмотреть его GPS-трек</p></div></div><div className="inspector-history-list">{[...routeResults.inspections].sort((a,b) => Date.parse(b.started_at) - Date.parse(a.started_at)).map((item) => <button key={item.id} className={`inspector-history-row ${historyInspectionId === item.id ? 'active' : ''}`} onClick={() => setHistoryInspectionId(item.id)}><span className="inspector-history-date"><b>{formatDate(item.started_at)}</b><small>{item.finished_at ? `Завершён ${formatDate(item.finished_at)}` : 'Осмотр завершён'}</small></span><span className="inspector-history-points">{item.points.length} точек GPS</span><Icon name="right" size={16}/></button>)}</div></div>}
            <div className="card inspector-history-defects"><div className="inspector-card-head"><span className="inspector-step"><Icon name="alert" size={16}/></span><div><h2>Дефекты маршрута</h2><p className="muted">Все сообщения, привязанные к этому маршруту</p></div></div>{routeResults.defects.length ? <div className="inspector-defect-list">{routeResults.defects.map((d) => <button type="button" className="inspector-defect-row card" key={d.id} onClick={() => void openDetail(d)}><span className="inspector-defect-thumb">{d.photos[0]?.url ? <img src={d.photos[0].url} alt="Фото дефекта"/> : <Icon name="camera" size={22}/>}</span><span className="inspector-defect-info"><b>{d.type} <small>№ {d.number}</small></b><span>{formatDate(d.observed_at)}</span><small>{d.description || 'Без описания'}</small></span><StatusBadge status={d.status} overdue={d.overdue}/><Icon name="right" size={18}/></button>)}</div> : <p className="muted inspector-history-empty-defects">На этом маршруте ещё не отмечали дефекты.</p>}</div>
          </>}
        </section>}

        {view === 'survey' && section && inspection && <section className="inspector-survey-view">
          <div className="inspector-survey-top"><button className="button secondary small" onClick={() => setView('sections')}><Icon name="left" size={16}/> Мои маршруты</button><div className="inspector-live"><i/> ИДЁТ ОСМОТР</div><span className="inspector-survey-start">Начат {formatDate(inspection.started_at)}</span></div>
          <div className="inspector-survey-map card"><MapView section={section} defects={sectionDefects} track={inspection.points} selectedPosition={gps ? {lat:gps.lat,lng:gps.lng} : null} onPosition={(lat,lng) => { if (!location.ready) return; setGps({lat,lng,accuracy_m:null,source:'manual'}); setManualLat(String(lat)); setManualLng(String(lng)); }} height={420} /></div>
          <div className="inspector-metrics"><div className="stat"><span>Время</span><strong>{elapsed(surveySeconds)}</strong><small>на участке</small></div><div className="stat"><span>Маршрут</span><strong>{distanceKm.toFixed(2)} <small>км</small></strong><small>{pointCount} точек GPS</small></div><div className="stat"><span>Пробелы GPS</span><strong>{gapCount}</strong><small>интервалов более 1 мин</small></div><div className="stat"><span>Дефекты</span><strong>{sectionDefects.filter((d) => d.inspection_id === inspection.id).length}</strong><small>отмечено в этом осмотре</small></div><div className="inspector-gps-stat"><div className="inspector-gps-dot"/><div><b>{location.position ? `GPS · ±${Math.round(location.position.accuracy_m)} м` : 'Ожидаем GPS'}</b><small>{location.position ? `${fmtCoord(location.position.lat)}, ${fmtCoord(location.position.lng)}` : location.status === 'reconnecting' ? 'Повторное определение позиции' : location.error || 'Определяем позицию'}</small></div></div></div>
          <div className="inspector-survey-actions"><div><h2>Нашли повреждение?</h2><p className="muted">Добавьте фото и координаты прямо с участка.</p></div><div className="row"><button className="button primary" onClick={() => beginCreate()}><Icon name="plus" size={17}/> Зафиксировать дефект</button><button className="button secondary" onClick={() => setShowFinishConfirm(true)}><Icon name="check" size={17}/> Завершить осмотр</button></div></div>
        </section>}

        {view === 'create' && createNeedsRoute && <section className="inspector-route-choice"><div className="inspector-form-toolbar"><button type="button" className="button secondary small" onClick={() => setView(createReturnView)}><Icon name="left" size={16}/> Назад</button><span className="inspector-context">Новое сообщение</span></div><div className="card inspector-route-choice-card"><span className="inspector-route-choice-mark"><Icon name="route" size={20}/></span><h2>Выберите маршрут</h2><p>Каждое сообщение должно быть привязано к одному из назначенных вам маршрутов.</p>{sections.length ? <label className="field"><span>Мой маршрут <em>*</em></span><select className="select" value="" onChange={(e) => { const selected = sections.find((route) => route.id === e.target.value); if (selected) { setSection(selected); setCreateNeedsRoute(false); setGps(location.position ? {lat:location.position.lat,lng:location.position.lng,accuracy_m:location.position.accuracy_m,source:'gps'} : null); } }}><option value="" disabled>Выберите маршрут…</option>{sections.map((route) => <option value={route.id} key={route.id}>{route.code} · {route.name}</option>)}</select></label> : <div className="empty">Нет назначенных маршрутов</div>}</div></section>}
        {view === 'create' && !createNeedsRoute && section && <form className="inspector-create-view" onSubmit={submitDefect}>
          <div className="inspector-form-toolbar"><button type="button" className="button secondary small" onClick={() => setView(createReturnView)}><Icon name="left" size={16}/> Назад</button><span className="inspector-context"><Icon name="pin" size={15}/>{section.code} · {section.name}</span></div>
          <div className="inspector-create-grid"><div className="inspector-form-column">
            <div className="card inspector-form-card"><div className="inspector-card-head"><span className="inspector-step">01</span><div><h2>Что обнаружено?</h2><p className="muted">Выберите тип и опишите состояние участка</p></div></div>
              <label className="field"><span>Тип дефекта <em>*</em></span><select className="select" value={type} onChange={(e) => setType(e.target.value)}>{DEFECT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="field"><span>Описание <em>*</em></span><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={3} maxLength={2000} placeholder="Опишите размер повреждения, состояние покрытия и возможную опасность…" rows={4}/><small className="muted inspector-count">{description.length}/2000</small></label>
            </div>
            <div className="card inspector-form-card"><div className="inspector-card-head"><span className="inspector-step">02</span><div><h2>Фотография</h2><p className="muted">Оригинал фото сохраняется для проверки и истории ремонта</p></div></div><UploadField photos={photos} onChange={setPhotos} onBusyChange={setPhotoUploading} label="Добавить фото дефекта" />{!photos.length && <p className="inspector-photo-required"><Icon name="alert" size={15}/> Фото обязательно для отправки</p>}</div>
          </div><div className="inspector-location-column">
            <div className="card inspector-form-card inspector-location-card"><div className="inspector-card-head"><span className="inspector-step">03</span><div><h2>Место дефекта</h2><p className="muted">Точка сохраняется вместе с типом геолокации</p></div></div>
              <div className="inspector-location-map"><MapView section={section} defects={sectionDefects} selectedId={detail?.id} selectedPosition={gps ? {lat:gps.lat,lng:gps.lng} : null} onPosition={(lat,lng) => { if (!location.ready) return; setGps({lat,lng,accuracy_m:null,source:'manual'}); setManualLat(String(lat)); setManualLng(String(lng)); setGpsError(''); }} height={236}/><div className="inspector-location-label"><Icon name={gps?.source === 'gps' ? 'locate' : 'pin'} size={15}/>{gps ? `${gps.source === 'gps' ? 'GPS' : 'Отметка на карте'} · ${fmtCoord(gps.lat)}, ${fmtCoord(gps.lng)}` : 'Нажмите на карту, чтобы поставить точку'}</div></div>
              <div className="inspector-manual-coords"><span className="inspector-or">ИЛИ ВВЕДИТЕ КООРДИНАТЫ</span><div className="inspector-coord-fields"><label className="field"><span>Широта</span><input className="input" inputMode="decimal" placeholder="44.848" value={manualLat} onChange={(e) => setManualLat(e.target.value)}/></label><label className="field"><span>Долгота</span><input className="input" inputMode="decimal" placeholder="65.482" value={manualLng} onChange={(e) => setManualLng(e.target.value)}/></label><button type="button" className="button secondary small" onClick={() => manualCoordinates(manualLat,manualLng)}>Применить</button></div></div>
              {gpsError && <div className="inspector-gps-error">{gpsError}</div>}
              <button type="button" className="inspector-use-gps" disabled={!location.hasFreshPosition} onClick={() => { if (!location.ready || !location.position) return; const fix = {lat:location.position.lat,lng:location.position.lng,accuracy_m:location.position.accuracy_m,source:'gps' as const}; setGps(fix); setManualLat(fmtCoord(fix.lat)); setManualLng(fmtCoord(fix.lng)); setGpsError(''); }}><Icon name="locate" size={16}/> Использовать моё местоположение</button>
            </div>
            <div className="inspector-submit-card"><div><b>Проверьте данные</b><span>{photoUploading ? 'Загружаем фото · ' : ''}{photos.length ? `${photos.length} фото · ` : 'Фото не добавлено · '}{gps ? `${gps.source === 'gps' ? 'GPS' : 'ручная точка'}` : 'место не указано'}</span></div><button className="button primary" type="submit" disabled={busy || photoUploading || !gps || !photos.length || !location.hasFreshPosition}>{busy ? 'Отправляем…' : photoUploading ? 'Загрузка фото…' : !location.hasFreshPosition ? 'Ожидаем GPS' : 'Отправить сообщение'} <Icon name="arrow" size={16}/></button></div>
          </div></div>
        </form>}

        {view === 'list' && <section className="inspector-list-view"><div className="inspector-list-head"><div className="tabs"><button className={`tab ${tab === 'created' ? 'active' : ''}`} onClick={() => setTab('created')}>Мои сообщения <span>{scopedCreatedCount}</span></button><button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>На проверке <span>{scopedReviewCount}</span></button></div><button className="button primary small" onClick={() => beginCreate()}><Icon name="plus" size={16}/> Новый дефект</button></div>
          {listSectionId && <div className="inspector-route-filter"><Icon name="route" size={16}/><span>Маршрут: <b>{sections.find((route) => route.id === listSectionId)?.name ?? section?.name}</b></span><button className="button secondary small" onClick={() => void openList(tab)}>Показать все</button></div>}
          {scopedDefects.length ? <div className="inspector-defect-list">{scopedDefects.map((d) => <button type="button" className="inspector-defect-row card" key={d.id} onClick={() => void openDetail(d)}><span className="inspector-defect-thumb">{d.photos[0]?.url ? <img src={d.photos[0].url} alt="Фото дефекта"/> : <Icon name="camera" size={22}/>}</span><span className="inspector-defect-info"><b>{d.type} <small>№ {d.number}</small></b><span>{sections.find((s) => s.id === d.section_id)?.name ?? d.section_id} · {formatDate(d.observed_at)}</span><small>{d.description || 'Без описания'}</small></span><StatusBadge status={d.status} overdue={d.overdue}/><Icon name="right" size={18}/></button>)}</div> : <div className="empty inspector-empty"><span className="inspector-empty-icon"><Icon name={tab === 'review' ? 'check' : 'clipboard'} size={23}/></span><b>{tab === 'review' ? 'Нет работ на проверке' : listSectionId ? 'На этом маршруте пока нет сообщений' : 'Сообщений пока нет'}</b><span>{tab === 'review' ? 'Когда подрядчик отправит работу, она появится здесь.' : 'Зафиксируйте дефект на одном из назначенных маршрутов.'}</span>{tab === 'created' && <button className="button secondary small" onClick={() => beginCreate()}>Добавить дефект</button>}</div>}
        </section>}

        {view === 'detail' && detail && <section className="inspector-detail-view"><div className="inspector-form-toolbar"><button className="button secondary small" onClick={() => setView(detailReturnView)}><Icon name="left" size={16}/> {detailReturnView === 'history' ? 'К истории маршрута' : 'К списку'}</button><span className="inspector-detail-id">№ {detail.number} · создан {formatDate(detail.received_at)}</span></div>
          <div className="inspector-detail-grid"><div className="inspector-detail-main"><div className="card inspector-detail-card"><div className="inspector-detail-title"><div><div className="eyebrow">{sections.find((s) => s.id === detail.section_id)?.code ?? 'ДЕФЕКТ'}</div><h2>{detail.type}</h2></div><StatusBadge status={detail.status} overdue={detail.overdue}/></div><p className="inspector-detail-description">{detail.description}</p><div className="inspector-detail-meta"><span><Icon name="clock" size={15}/>{formatDate(detail.observed_at)}</span><span><Icon name="pin" size={15}/>{fmtCoord(detail.lat)}, {fmtCoord(detail.lng)} · {detail.location_source === 'gps' ? 'GPS' : 'отмечено вручную'}</span></div><PhotoGallery photos={detail.photos}/>{detail.previous_defect_id && <div className="inspector-recurrence"><Icon name="refresh" size={16}/> Повторное сообщение по ранее закрытому дефекту</div>}</div>
            {detail.repairs?.length > 0 && <div className="card inspector-detail-card"><div className="inspector-card-head"><span className="inspector-step inspector-step-repair"><Icon name="activity" size={17}/></span><div><h2>Фото ремонта</h2><p className="muted">Материалы подрядчика и результат проверки</p></div></div>{detail.repairs.map((r) => <div className="inspector-repair" key={r.id}><div className="inspector-repair-head"><b>{formatDate(r.created_at)}</b>{r.decision && <span className={`inspector-repair-decision ${r.decision}`}>{r.decision === 'accepted' ? 'Принято' : 'На доработку'}</span>}</div><p>{r.comment}</p><PhotoGallery photos={r.photos}/>{r.decision_comment && <div className="inspector-review-comment">Комментарий проверки: {r.decision_comment}</div>}</div>)}</div>}
            <div className="card inspector-detail-card"><div className="inspector-card-head"><span className="inspector-step inspector-step-history"><Icon name="history" size={17}/></span><div><h2>История</h2><p className="muted">Все изменения и сообщения по дефекту</p></div></div><History events={detail.history}/></div>
          </div><aside className="inspector-detail-aside"><div className="card inspector-detail-card"><h3>Расположение</h3><div className="inspector-detail-map"><MapView section={sections.find((s) => s.id === detail.section_id) ?? undefined} defects={[detail]} selectedId={detail.id} locateOnOpen={false} height={205}/></div><p className="inspector-detail-address"><Icon name="pin" size={15}/>{fmtCoord(detail.lat)}, {fmtCoord(detail.lng)}</p><span className="muted">{sections.find((s) => s.id === detail.section_id)?.name ?? 'Маршрут'}</span></div>
              {detail.status === 'review' && <div className="card inspector-review-actions"><span className="inspector-review-mark"><Icon name="check" size={18}/></span><h3>Проверка ремонта</h3><p className="muted">Сравните фотографии ремонта с исходным состоянием.</p><label className="field"><span>Комментарий <em>обязателен при отказе</em></span><textarea className="textarea" rows={3} value={clarification} onChange={(e) => setClarification(e.target.value)} placeholder="Что нужно исправить?"/></label><button className="button primary" disabled={busy} onClick={() => void act('approve')}>Принять ремонт <Icon name="check" size={16}/></button><button className="button danger" disabled={busy || clarification.trim().length < 2} onClick={() => void act('reject', {comment:clarification.trim()})}>Отправить на доработку</button></div>}
              {detail.status === 'needs_info' && detail.inspector_id === user.id && <div className="card inspector-review-actions"><h3>Уточнение диспетчера</h3><p className="muted">Ответьте, чтобы вернуть сообщение в работу.</p><label className="field"><span>Ответ <em>*</em></span><textarea className="textarea" rows={3} value={clarification} onChange={(e) => setClarification(e.target.value)} placeholder="Добавьте уточнение…"/></label><button className="button primary" disabled={busy || clarification.trim().length < 2} onClick={() => void act('clarify',{comment:clarification.trim()})}>Отправить ответ</button></div>}
              {detail.status === 'closed' && <div className="inspector-recurrence-card"><Icon name="refresh" size={19}/><div><b>Повреждение появилось снова?</b><p>Создайте новое сообщение. Закрытый дефект останется в истории.</p><button className="button secondary small" onClick={() => { setSection(sections.find((s) => s.id === detail.section_id) ?? null); setGps({lat:detail.lat,lng:detail.lng,accuracy_m:null,source:'manual'}); beginCreate(detail.id); }}>Сообщить о повторе</button></div></div>}
          </aside></div>
        </section>}
      </>}
    </main>
    <nav className="inspector-mobile-nav"><button className={view === 'sections' || view === 'survey' || view === 'history' ? 'active' : ''} onClick={() => { setSection(null); setListSectionId(null); setView('sections'); }}><Icon name="route" size={20}/><span>Маршруты</span></button><button className={view === 'list' && tab === 'created' ? 'active' : ''} onClick={() => void openList('created')}><Icon name="clipboard" size={20}/><span>Мои дефекты</span></button><button className={view === 'list' && tab === 'review' ? 'active' : ''} onClick={() => void openList('review')}><Icon name="check" size={20}/><span>Проверка</span></button></nav>
    {showFinishConfirm && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowFinishConfirm(false); }}><div className="modal inspector-finish-modal" role="dialog" aria-modal="true" aria-labelledby="finish-title"><span className="inspector-finish-icon"><Icon name="check" size={22}/></span><h2 id="finish-title">Завершить осмотр?</h2><p>Маршрут и найденные дефекты будут сохранены. После завершения продолжить запись GPS-точек нельзя.</p><div className="row"><button className="button secondary" onClick={() => setShowFinishConfirm(false)}>Продолжить осмотр</button><button className="button primary" disabled={busy} onClick={() => void finishInspection()}>{busy ? 'Сохраняем…' : 'Завершить'}</button></div></div></div>}
    </div>
    {!location.ready && <div className="inspector-gps-gate" role="alertdialog" aria-modal="true" aria-labelledby="inspector-gps-title" aria-describedby="inspector-gps-description"><div className="card inspector-gps-gate-card"><span className="inspector-gps-gate-icon"><Icon name="locate" size={24}/></span><span className="eyebrow">ОПРЕДЕЛЕНИЕ МЕСТА</span><h2 id="inspector-gps-title" ref={gpsGateHeading} tabIndex={-1}>{location.status === 'requesting' ? 'Определяем местоположение' : 'Не удалось определить местоположение'}</h2><p id="inspector-gps-description">{location.error || 'Для работы инспектора нужна актуальная позиция устройства. Получаем её через браузер; дождитесь ответа или повторите запрос.'}</p><div className="inspector-gps-gate-actions"><button ref={gpsRetryButton} className="button primary" onClick={location.retry} disabled={location.status === 'requesting'}><Icon name={location.status === 'requesting' ? 'loader' : 'refresh'} size={17}/>{location.status === 'requesting' ? 'Определяем местоположение…' : 'Повторить определение'}</button>{onLogout && <button className="button secondary" onClick={onLogout}>Выйти из кабинета</button>}</div></div></div>}
  </div>;
}

function pageTitle(view: View, section: Section | null) { return view === 'sections' ? 'Мои маршруты' : view === 'survey' ? section?.name ?? 'Осмотр маршрута' : view === 'create' ? 'Новое сообщение о дефекте' : view === 'list' ? 'Дефекты' : view === 'history' ? `История · ${section?.name ?? 'маршрута'}` : 'Карточка дефекта'; }
function errText(e: unknown) { return (e as { message?: string })?.message || 'Не удалось выполнить запрос. Проверьте подключение и попробуйте снова.'; }
function elapsed(total: number) { return `${String(Math.floor(total / 3600)).padStart(2,'0')}:${String(Math.floor((total % 3600) / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`; }
function routeStateLabel(state: Section['state']) { return state === 'completed' ? 'Осмотр завершён' : state === 'in_progress' ? 'Идёт осмотр' : 'Назначен'; }
function durationLabel(minutes: number) { return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60 ? `${minutes % 60} мин` : ''}`.trim() : `${minutes} мин`; }
function distance(lat1: number,lng1: number,lat2: number,lng2: number) { const rad = Math.PI / 180, dLat = (lat2-lat1)*rad, dLng=(lng2-lng1)*rad; const a=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLng/2)**2; return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
