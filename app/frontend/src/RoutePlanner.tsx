import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { Circle, MapContainer, Marker, Polyline, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { AlertTriangle, ArrowDown, ArrowDownRight, ArrowRight, ArrowUp, Check, Clock3, LocateFixed, MapPin, Plus, RefreshCw, Route as RouteIcon, Ruler, UserRound, X } from 'lucide-react';
import { ApiError, api } from './api';
import { formatDate, MapView, MapTileLayer, MapViewportMemory, StatusBadge } from './components';
import { useDeviceLocation } from './geolocation';
import type { Bootstrap, Inspection, RouteOption, RoutePoint, RoutePreview, RouteResults, Section, User } from './types';
import './route-planner.css';
import RouteEdit from './RouteEdit';
import RouteProgress from './RouteProgress';
import TrackHistory from './TrackHistory';
import {LocationAccuracy} from './LocationAccuracy';
import type {WorkTarget} from './types';

type Props = { user: User;target?:WorkTarget };
type Notice = { kind: 'error' | 'success' | 'warning'; text: string } | null;
type PublishInput = { name: string; notes: string; inspector_id: string; preview_id: string; option_id: string };
type PointName = 'start' | 'end' | 'via';
const MAX_VIA_POINTS = 8;
const ROUTE_COLORS = ['#267c70', '#d18b28', '#566ca5', '#b65c52', '#7d68a5', '#4d8760'];
const DEFAULT_CENTER: [number, number] = [48, 67];
const pointLabel = (point?: RoutePoint | null) => point ? `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}` : 'Нажмите на карту';
const accuracyZoom = (accuracyM:number) => accuracyM<=20?15:accuracyM<=100?14:accuracyM<=500?12:accuracyM<=1500?11:10;
const toLatLng = (point: RoutePoint): [number, number] => [point.lat, point.lng];
const fromCoordinates = (coordinates: number[][]) => coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
const routeState: Record<Section['state'], string> = { assigned: 'Назначен', in_progress: 'Осматривается', completed: 'Завершён' };
const routeDate = (value?: string | null) => value ? formatDate(value) : '—';
const errorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Не удалось выполнить запрос. Повторите попытку.';
const meters = (value: number) => value >= 1000 ? `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км` : `${Math.round(value)} м`;
const minutes = (seconds: number) => {
  const total = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} ч ${m ? `${m} мин` : ''}`.trim() : `${m} мин`;
};
const distanceBetween = (a: RoutePoint, b: RoutePoint) => {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
};
const keyOf = (point?: RoutePoint | null) => point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : '';

export default function RoutePlanner({ user,target }: Props) {
  const deviceLocation = useDeviceLocation();
  const [inspectors, setInspectors] = useState<User[]>([]);
  const [routes, setRoutes] = useState<Section[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [routesError, setRoutesError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [start, setStart] = useState<RoutePoint | null>(null);
  const [end, setEnd] = useState<RoutePoint | null>(null);
  const [via, setVia] = useState<RoutePoint[]>([]);
  const [editingViaIndex, setEditingViaIndex] = useState<number | null>(null);
  const [startLatInput, setStartLatInput] = useState('');
  const [startLngInput, setStartLngInput] = useState('');
  const [endLatInput, setEndLatInput] = useState('');
  const [endLngInput, setEndLngInput] = useState('');
  const [pointError, setPointError] = useState('');
  const [pointMode, setPointMode] = useState<PointName>('start');
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [inspectorId, setInspectorId] = useState('');
  const [publishError, setPublishError] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [pendingPublish, setPendingPublish] = useState<PublishInput | null>(null);
  const [publishSuccess, setPublishSuccess] = useState('');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(target?.routeId??null);
  useEffect(()=>{if(target?.routeId){setSelectedRouteId(target.routeId);setLayout('results')}},[target?.nonce]);
  const [results, setResults] = useState<RouteResults | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState('');
  const [resultsRevision, setResultsRevision] = useState(0);
  const [selectedInspectionId, setSelectedInspectionId] = useState<string | null>(null);
  const [routeSearch, setRouteSearch] = useState('');
  const [routeStateFilter, setRouteStateFilter] = useState('all');
  const [layout, setLayout] = useState<'plan' | 'routes' | 'results'>('plan');
  const previewSequence = useRef(0);
  const resultSequence = useRef(0);
  const mapInteracted = useRef(false);

  const loadPage = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setInitialLoading(true);
    setRoutesError('');
    try {
      const [boot, rows] = await Promise.all([api.get<Bootstrap>('/bootstrap'), api.get<Section[]>('/routes')]);
      setInspectors(boot.inspectors ?? []);
      setRoutes(rows);
      setSelectedRouteId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
      setInspectorId((current) => current && boot.inspectors.some((inspector) => inspector.id === current) ? current : boot.inspectors[0]?.id ?? '');
      if (quiet) setResultsRevision((revision) => revision + 1);
    } catch (error) { setRoutesError(errorText(error)); }
    finally { setInitialLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { void loadPage(); }, [loadPage]);

  const previewStartKey = keyOf(start), previewEndKey = keyOf(end);
  const previewViaKey = via.map(keyOf).join('|');
  useEffect(() => {
    if (!start || !end) {
      previewSequence.current += 1;
      setPreview(null); setSelectedOptionId(null); setPreviewLoading(false); setPreviewError('');
      return;
    }
    if (distanceBetween(start, end) < 5) {
      previewSequence.current += 1;
      setPreview(null); setSelectedOptionId(null); setPreviewLoading(false);
      setPreviewError('Укажите две разные точки дороги.');
      return;
    }
    const orderedPoints=[start,...via,end];
    if(orderedPoints.slice(1).some((point,index)=>distanceBetween(orderedPoints[index],point)<5)){
      previewSequence.current += 1;setPreview(null);setSelectedOptionId(null);setPreviewLoading(false);setPreviewError('Уберите совпадающие точки маршрута.');return;
    }
    const sequence = ++previewSequence.current;
    setPreview(null); setSelectedOptionId(null); setPreviewError(''); setPreviewLoading(true); setPublishSuccess('');
    const from = { ...start }, to = { ...end };
    void api.post<RoutePreview>('/routes/preview', { start: from, via: via.map(point=>({...point})), end: to }).then((value) => {
      if (sequence !== previewSequence.current) return;
      if (!Array.isArray(value.options) || value.options.length === 0) {
        setPreviewError('Сервис маршрутизации не вернул варианты. Попробуйте выбрать другие точки.');
        return;
      }
      setPreview(value);
      if (value.options.length === 1) setSelectedOptionId(value.options[0].id);
    }).catch((error: unknown) => {
      if (sequence === previewSequence.current) setPreviewError(errorText(error));
    }).finally(() => {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    });
    return () => { if (sequence === previewSequence.current) previewSequence.current += 1; };
    // Use rounded coordinates so map pointer jitter doesn't trigger duplicate previews.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewStartKey, previewEndKey, previewViaKey, previewRevision]);

  useEffect(() => {
    if (!selectedRouteId) { resultSequence.current += 1; setResults(null); setResultsError(''); return; }
    const sequence = ++resultSequence.current;
    setResultsLoading(true); setResultsError('');
    if(results?.route.id!==selectedRouteId){setResults(null);setSelectedInspectionId(null);}
    void api.get<RouteResults>(`/routes/${selectedRouteId}/results`).then((data) => {
      if (sequence !== resultSequence.current) return;
      setResults(data);
      setSelectedInspectionId(current=>current&&data.inspections.some(inspection=>inspection.id===current)?current:data.inspections[0]?.id??null);
    }).catch((error: unknown) => {
      if (sequence === resultSequence.current) setResultsError(errorText(error));
    }).finally(() => { if (sequence === resultSequence.current) setResultsLoading(false); });
    return () => { if (sequence === resultSequence.current) resultSequence.current += 1; };
  }, [selectedRouteId, resultsRevision]);

  const hasActiveInspection=!!results?.inspections.some(inspection=>inspection.status==='active');
  useEffect(()=>{
    if(!selectedRouteId||!hasActiveInspection)return;
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine&&layout==='results')setResultsRevision(revision=>revision+1)},15000);
    return()=>window.clearInterval(timer);
  },[selectedRouteId,hasActiveInspection,layout]);

  const filteredRoutes = useMemo(() => routes.filter((route) => {
    const needle = routeSearch.trim().toLocaleLowerCase('ru');
    return (!needle || `${route.name} ${route.code} ${route.inspector_name}`.toLocaleLowerCase('ru').includes(needle)) && (routeStateFilter === 'all' || route.state === routeStateFilter);
  }), [routes, routeSearch, routeStateFilter]);
  const displayedOptions = useMemo(() => preview?.options ?? [], [preview]);
  const selectedInspection = results?.inspections.find((inspection) => inspection.id === selectedInspectionId) ?? null;
  const snappedDistance = preview && start && end ? Math.max(distanceBetween(start, preview.start), distanceBetween(end, preview.end),...via.map((point,index)=>distanceBetween(point,preview.via?.[index]??point))) : 0;

  const resetPreview = () => {
    previewSequence.current += 1;
    setPreview(null); setPreviewError(''); setSelectedOptionId(null); setPreviewLoading(false); setPendingPublish(null); setPublishError(''); setPublishSuccess(''); setPreviewRevision((revision) => revision + 1);
  };
  const changeEndpoint = (which: PointName, value: RoutePoint) => {
    mapInteracted.current = true;
    const current = which === 'start' ? start : end;
    const roundedPointChanged = keyOf(current) !== keyOf(value);
    setPublishError(''); setPendingPublish(null); setPublishSuccess('');
    if (roundedPointChanged) { setPreview(null); setSelectedOptionId(null); }
    else if (!preview && !previewLoading && start && end) setPreviewRevision((revision) => revision + 1);
    if (which === 'start') { setStart(value); setStartLatInput(value.lat.toFixed(6)); setStartLngInput(value.lng.toFixed(6)); }
    else if(which === 'end') { setEnd(value); setEndLatInput(value.lat.toFixed(6)); setEndLngInput(value.lng.toFixed(6)); }
    setPointError('');
  };
  const changeViaPoints=(next:RoutePoint[])=>{
    if(next.length>MAX_VIA_POINTS)return;
    previewSequence.current+=1;setVia(next);setPreview(null);setSelectedOptionId(null);setPreviewLoading(false);setPreviewError('');setPendingPublish(null);setPublishError('');setPublishSuccess('');setPointError('');
  };
  const moveViaPoint=(index:number,offset:-1|1)=>{
    const target=index+offset;if(target<0||target>=via.length)return;
    const next=[...via];[next[index],next[target]]=[next[target],next[index]];changeViaPoints(next);
  };
  const removeViaPoint=(index:number)=>changeViaPoints(via.filter((_,i)=>i!==index));
  const applyManualPoint = (which: PointName) => {
    const latRaw = which === 'start' ? startLatInput : endLatInput;
    const lngRaw = which === 'start' ? startLngInput : endLngInput;
    const lat = Number(latRaw), lng = Number(lngRaw);
    if (!latRaw.trim() || !lngRaw.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setPointError('Введите широту от −90 до 90 и долготу от −180 до 180.');
      return;
    }
    changeEndpoint(which, { lat, lng });
  };
  const handleMapClick = (lat: number, lng: number) => {
    if (publishBusy || pendingPublish) return;
    const value = { lat, lng };
    if(pointMode==='via'){
      const next=[...via];
      if(editingViaIndex===null){if(next.length>=MAX_VIA_POINTS)return;next.push(value);}else next[editingViaIndex]=value;
      setEditingViaIndex(null);changeViaPoints(next);return;
    }
    changeEndpoint(pointMode, value);
    if (pointMode === 'start' && !end) setPointMode('end');
  };

  async function publish() {
    if (publishBusy || previewLoading || !preview || !selectedOptionId || !inspectorId || !name.trim()) return;
    const body = pendingPublish ?? { name: name.trim(), notes: notes.trim(), inspector_id: inspectorId, preview_id: preview.id, option_id: selectedOptionId };
    setPendingPublish(body); setPublishBusy(true); setPublishError(''); setPublishSuccess('');
    try {
      const route = await api.post<Section>('/routes', body);
      setPendingPublish(null); setPublishSuccess(`Маршрут «${route.name}» назначен ${route.inspector_name}.`);
      setRoutes((rows) => [route, ...rows.filter((item) => item.id !== route.id)]);
      setStart(null); setEnd(null); setVia([]); setEditingViaIndex(null); setStartLatInput(''); setStartLngInput(''); setEndLatInput(''); setEndLngInput(''); setPointMode('start'); setPreview(null); setSelectedOptionId(null);
      setSelectedRouteId(route.id); setLayout('results');
      await loadPage(true);
    } catch (error) {
      const refreshPreview = error instanceof ApiError && (error.code === 'PREVIEW_ALREADY_USED' || error.code === 'PREVIEW_EXPIRED');
      if (refreshPreview) {
        setPendingPublish(null); setPreview(null); setSelectedOptionId(null); setPreviewRevision((revision) => revision + 1);
      }
      setPublishError(`${errorText(error)} ${refreshPreview ? 'Обновляем варианты маршрута. Выберите вариант и отправьте назначение заново.' : 'Повтор сохранит тот же выбор и данные.'}`);
    } finally { setPublishBusy(false); }
  }

  const selectSavedRoute = (route: Section) => { setSelectedRouteId(route.id); setLayout('results'); };
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? results?.route ?? null;

  return <main className="route-planner">
    <header className="rp-heading"><div><span className="eyebrow">ПЛАНИРОВАНИЕ · НАЗНАЧЕНИЕ · КОНТРОЛЬ</span><h1>Маршруты обследования</h1><p>Постройте дорожный маршрут и назначьте его инспектору.</p></div><button className="button secondary rp-refresh" aria-label="Обновить маршруты" onClick={() => void loadPage(true)} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'rp-spin' : ''}/><span>Обновить</span></button></header>
    {routesError && <div className="alert error" role="alert">{routesError}<button className="rp-alert-close" aria-label="Скрыть сообщение" onClick={() => setRoutesError('')}><X size={15}/></button></div>}
    {publishSuccess && <div className="alert success" role="status"><Check size={16}/>{publishSuccess}<button className="rp-alert-close" aria-label="Скрыть сообщение" onClick={() => setPublishSuccess('')}><X size={15}/></button></div>}
    <div className="rp-summary-row"><SummaryCard label="Всего маршрутов" value={routes.length} tone="green"/><SummaryCard label="Назначены" value={routes.filter((route) => route.state === 'assigned').length} tone="blue"/><SummaryCard label="Осматриваются" value={routes.filter((route) => route.state === 'in_progress').length} tone="amber"/><SummaryCard label="Завершены" value={routes.filter((route) => route.state === 'completed').length} tone="slate"/></div>
    <nav className="rp-mobile-tabs" aria-label="Раздел маршрутов"><button className={layout === 'plan' ? 'active' : ''} onClick={() => setLayout('plan')}>Новый маршрут</button><button className={layout === 'routes' ? 'active' : ''} onClick={() => setLayout('routes')}>Список <span>{routes.length}</span></button><button className={layout === 'results' ? 'active' : ''} onClick={() => setLayout('results')}>Результаты</button></nav>
    <div className={`rp-layout rp-layout-${layout}`}>
      <section className="rp-plan-column">
        <div className="rp-map-card">
          <div className="rp-map-head"><div><span className="section-label">ТОЧКИ МАРШРУТА</span><strong>Задайте начало, конец и дороги через точки</strong><small>Укажите A и B, затем добавьте точки на нужных дорогах и развилках.</small></div><span className="rp-map-icon"><RouteIcon size={19}/></span></div>
          <div className="rp-point-pickers"><button className={`rp-point-picker ${pointMode === 'start' ? 'active' : ''} ${start ? 'complete' : ''}`} onClick={() => {setPointMode('start');setEditingViaIndex(null)}} disabled={publishBusy || !!pendingPublish}><i className="rp-start-dot">A</i><span><small>НАЧАЛО</small><strong>{pointLabel(start)}</strong></span></button><ArrowDownRight className="rp-point-arrow" size={17}/><button className={`rp-point-picker ${pointMode === 'end' ? 'active' : ''} ${end ? 'complete' : ''}`} onClick={() => {setPointMode('end');setEditingViaIndex(null)}} disabled={publishBusy || !!pendingPublish}><i className="rp-end-dot">B</i><span><small>КОНЕЦ</small><strong>{pointLabel(end)}</strong></span></button><button className="rp-clear-points" onClick={() => { setStart(null); setEnd(null); setVia([]); setEditingViaIndex(null); setStartLatInput(''); setStartLngInput(''); setEndLatInput(''); setEndLngInput(''); setPointMode('start'); setPointError(''); resetPreview(); }} disabled={(!start && !end && !via.length) || publishBusy || !!pendingPublish} aria-label="Очистить точки"><X size={16}/></button></div>
          <div className="rp-via-editor" role="group" aria-label="Промежуточные точки">
            <div className="rp-via-title"><span>Промежуточные точки <small>{via.length}/{MAX_VIA_POINTS}</small></span><button type="button" className={`rp-via-add ${pointMode==='via'&&editingViaIndex===null?'active':''}`} title={pointMode==='via'&&editingViaIndex===null?'Кликните на нужную дорогу':'Добавить обязательную точку на карте'} onClick={()=>{setPointMode('via');setEditingViaIndex(null)}} disabled={via.length>=MAX_VIA_POINTS||publishBusy||!!pendingPublish}><Plus size={14}/>Добавить промежуточную точку</button></div>
            {via.length>0&&<ol>{via.map((point,index)=><li className={`rp-via-row ${pointMode==='via'&&editingViaIndex===index?'editing':''}`} key={`${index}-${keyOf(point)}`}><span className="rp-via-marker">{index+1}</span><span className="rp-via-coordinate">{pointLabel(point)}</span><div className="rp-via-actions"><button type="button" aria-label={`Изменить точку ${index+1}`} title="Изменить на карте" onClick={()=>{setPointMode('via');setEditingViaIndex(index)}} disabled={publishBusy||!!pendingPublish}><MapPin size={14}/></button><button type="button" aria-label={`Переместить точку ${index+1} вверх`} title="Переместить вверх" onClick={()=>moveViaPoint(index,-1)} disabled={index===0||publishBusy||!!pendingPublish}><ArrowUp size={14}/></button><button type="button" aria-label={`Переместить точку ${index+1} вниз`} title="Переместить вниз" onClick={()=>moveViaPoint(index,1)} disabled={index===via.length-1||publishBusy||!!pendingPublish}><ArrowDown size={14}/></button><button type="button" aria-label={`Удалить точку ${index+1}`} title="Удалить" onClick={()=>removeViaPoint(index)} disabled={publishBusy||!!pendingPublish}><X size={14}/></button></div></li>)}</ol>}
          </div>
          <p className="rp-routing-note">Маршрутизатор показывает найденные автомобильные варианты, а не все дороги. Промежуточная точка обязательна и направляет маршрут через выбранную дорогу.</p>
          <details className="rp-coordinate-entry"><summary>Ввести координаты вручную</summary><div className="rp-coordinate-fields"><CoordinateForm name="Начало" lat={startLatInput} lng={startLngInput} setLat={setStartLatInput} setLng={setStartLngInput} onApply={() => applyManualPoint('start')} disabled={publishBusy || !!pendingPublish}/><CoordinateForm name="Конец" lat={endLatInput} lng={endLngInput} setLat={setEndLatInput} setLng={setEndLngInput} onApply={() => applyManualPoint('end')} disabled={publishBusy || !!pendingPublish}/></div>{pointError && <div className="rp-coordinate-error" role="alert">{pointError}</div>}</details>
          <LocationAccuracy/>
          {!deviceLocation.position ? <div className={`rp-location-status ${deviceLocation.error ? 'failed' : ''}`} role="status" aria-live="polite"><MapPin size={15}/><span>{deviceLocation.error ? `Местоположение не получено. ${deviceLocation.error}` : 'Определяем ваше местоположение…'} Пока показан обзор области.</span>{deviceLocation.error && <button type="button" onClick={deviceLocation.retry}>Повторить</button>}</div> : <div className="rp-location-status ready" role="status"><MapPin size={15}/><span>Моё местоположение · точность около {Math.round(deviceLocation.position.accuracy_m)} м</span></div>}
          <div className="rp-map-frame"><PlannerMap start={preview?.start ?? start} end={preview?.end ?? end} via={preview?.via??via} viaPickMode={pointMode==='via'} options={displayedOptions} previewId={preview?.id ?? null} selectedOptionId={selectedOptionId} decisionPoints={preview?.decision_points ?? []} location={deviceLocation.position} locationReady={deviceLocation.ready} hasEndpoints={!!start || !!end} mapInteracted={mapInteracted} onMapClick={handleMapClick} onSelectOption={setSelectedOptionId} loading={previewLoading} locked={publishBusy || !!pendingPublish}/></div>
          <div className="rp-map-legend"><span><i className="rp-legend-point"/>Точка A</span><span><i className="rp-legend-point end"/>Точка B</span>{via.map((_,index)=><span key={`via-legend-${index}`}><i className="rp-legend-via">{index+1}</i>Через {index+1}</span>)}{preview?.decision_points.length ? <span><i className="rp-legend-junction"/>Развилка вариантов</span> : null}<span className="rp-map-help">{pointMode === 'start' ? 'Выбрано начало' : pointMode==='end'?'Выбран конец':editingViaIndex===null?'Добавление точки через':'Изменение точки через'}</span></div>
          {snappedDistance > 5 && <div className="rp-snap-note"><MapPin size={14}/>Точки привязаны к ближайшей дороге. В полях выше остаются указанные координаты.</div>}
        </div>
        <section className="rp-options-card">
          <div className="rp-section-heading"><div><span className="section-label">ВАРИАНТЫ ДОРОГИ</span><h2>{previewLoading ? 'Строим маршруты…' : preview?.options.length === 1 ? 'Найден один вариант' : preview?.options.length ? 'Выберите вариант маршрута' : 'Предпросмотр маршрута'}</h2></div>{previewLoading && <span className="rp-loader" aria-label="Загрузка"/>}</div>
          {previewError && <div className="alert error rp-inline-alert" role="alert"><AlertTriangle size={15}/><span>{previewError}</span><button className="button secondary small" onClick={() => setPreviewRevision((revision) => revision + 1)} disabled={!start || !end || previewLoading}>Повторить</button></div>}
          {!start || !end ? <div className="rp-options-empty"><MapPin size={20}/><div><strong>Укажите две точки</strong><span>Поставьте A и B на карте, чтобы найти проезды по дороге.</span></div></div> : previewLoading ? <div className="rp-options-empty"><span className="rp-loader"/><div><strong>Запрашиваем дорожные варианты</strong><span>Сверяем точки с дорожной сетью.</span></div></div> : preview?.options.length ? <div className="rp-option-list">{preview.options.map((option, index) => <RouteOptionCard key={option.id} option={option} index={index} selected={selectedOptionId === option.id} multi={preview.options.length > 1} onSelect={() => setSelectedOptionId(option.id)} disabled={publishBusy || !!pendingPublish}/>)}</div> : !previewError && <div className="rp-options-empty"><RouteIcon size={20}/><div><strong>Варианты появятся здесь</strong><span>Выберите начало и конец поездки — сервис покажет проезды по дорожной сети.</span></div></div>}
          {preview && <div className="rp-provider"><span>Провайдер: {preview.provider}</span><span>Предпросмотр до {formatDate(preview.expires_at)}</span></div>}
        </section>
        <section className="rp-assignment-card">
          <div className="rp-section-heading"><div><span className="section-label">НАЗНАЧЕНИЕ</span><h2>Назначить инспектору</h2></div><span className="rp-step-number">03</span></div>
          <label className="field">Название маршрута<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={90} placeholder="Например, Северный выезд — мост" disabled={!!pendingPublish || publishBusy}/></label>
          <label className="field">Инспектор<select className="select" value={inspectorId} onChange={(e) => setInspectorId(e.target.value)} disabled={!!pendingPublish || publishBusy}><option value="">Выберите инспектора</option>{inspectors.map((inspector) => <option value={inspector.id} key={inspector.id}>{inspector.name}</option>)}</select></label>
          <label className="field">Примечание <span className="rp-optional">необязательно</span><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Особенности участка, точка встречи, ограничения…" disabled={!!pendingPublish || publishBusy}/></label>
          {preview && preview.options.length > 1 && !selectedOptionId && <div className="rp-pick-warning"><AlertTriangle size={16}/>Сначала выберите один из {preview.options.length} вариантов маршрута.</div>}
          {pendingPublish && <div className="rp-retry-note">Сервер не подтвердил результат. Повтор отправит те же данные и выбранный вариант, чтобы не создать дубликат.</div>}
          {publishError && <div className="alert error rp-inline-alert" role="alert">{publishError}</div>}
          <button className="button primary rp-publish" disabled={publishBusy || previewLoading || !preview || !selectedOptionId || !inspectorId || !name.trim()} onClick={() => void publish()}>{publishBusy ? 'Сохраняем маршрут…' : pendingPublish ? 'Повторить сохранение' : 'Сохранить маршрут и назначить'}<ArrowRight size={17}/></button>
          {pendingPublish && <button className="rp-reset-attempt" disabled={publishBusy} onClick={resetPreview}>Сбросить попытку и построить новые варианты</button>}
        </section>
      </section>
      <section className="rp-routes-column">
        <div className="rp-route-list-card"><div className="rp-section-heading"><div><span className="section-label">НАЗНАЧЕННЫЕ МАРШРУТЫ</span><h2>Рабочий список</h2></div><button className="rp-icon-action" aria-label="Обновить список маршрутов" onClick={() => void loadPage(true)} disabled={refreshing}><RefreshCw size={15}/></button></div>
          <div className="rp-route-filters"><label className="rp-search"><span>⌕</span><input value={routeSearch} onChange={(e) => setRouteSearch(e.target.value)} placeholder="Название, код, инспектор" aria-label="Поиск маршрутов"/></label><select className="select" value={routeStateFilter} onChange={(e) => setRouteStateFilter(e.target.value)} aria-label="Фильтр состояния"><option value="all">Все состояния</option><option value="assigned">Назначен</option><option value="in_progress">Осматривается</option><option value="completed">Завершён</option></select></div>
          {initialLoading ? <div className="rp-list-empty"><span className="rp-loader"/>Загружаем маршруты…</div> : filteredRoutes.length === 0 ? <div className="rp-list-empty"><RouteIcon size={24}/><strong>{routes.length ? 'По фильтру ничего нет' : 'Маршруты ещё не назначены'}</strong><span>{routes.length ? 'Измените запрос или состояние.' : 'Постройте первый маршрут и выберите инспектора.'}</span></div> : <div className="rp-route-list">{filteredRoutes.map((route) => <button key={route.id} className={`rp-route-row ${selectedRouteId === route.id ? 'selected' : ''}`} onClick={() => selectSavedRoute(route)}><span className="rp-route-glyph"><RouteIcon size={17}/></span><span className="rp-route-row-main"><span className="rp-route-row-top"><strong>{route.name}</strong><span>{route.code}</span></span><span className="rp-route-row-meta"><span><UserRound size={12}/>{route.inspector_name}</span><span><Ruler size={12}/>{route.length_km.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км</span></span></span><span className={`rp-route-state ${route.state}`}>{routeState[route.state]}</span></button>)}</div>}
        </div>
        <div className="rp-results-card">{selectedRoute&&<RouteEdit route={selectedRoute} inspectors={inspectors} onSaved={()=>void loadPage(true)}/>}
          <div className="rp-section-heading"><div><span className="section-label">ПЛАН И ФАКТИЧЕСКИЙ ПУТЬ</span><h2>{selectedRoute?.name ?? 'Результаты маршрута'}</h2>{selectedRoute && <small>{selectedRoute.code} · {selectedRoute.inspector_name}</small>}</div>{selectedRoute&&<div className="rp-results-actions"><button type="button" className="rp-icon-action" aria-label="Обновить GPS-путь и результаты" title="Обновить результаты" onClick={()=>setResultsRevision(revision=>revision+1)} disabled={resultsLoading}><RefreshCw size={14}/></button><span className={`rp-route-state ${selectedRoute.state}`}>{routeState[selectedRoute.state]}</span></div>}</div>
          {!selectedRoute ? <div className="rp-list-empty"><MapPin size={23}/><strong>Выберите маршрут</strong><span>Здесь появится запланированная линия и GPS-путь инспектора.</span></div> : resultsLoading&&!results ? <div className="rp-list-empty"><span className="rp-loader"/>Загружаем результаты…</div> : resultsError&&!results ? <div className="alert error" role="alert">{resultsError}<button className="button secondary small" onClick={() => setResultsRevision((revision) => revision + 1)}>Повторить</button></div> : results ? <>
            {resultsError&&<div className="alert error" role="alert">{resultsError}<button className="button secondary small" onClick={() => setResultsRevision((revision) => revision + 1)}>Повторить</button></div>}
            {results.inspections.length > 0 && <div className="rp-inspections"><span className="section-label">ОСМОТРЫ</span><div className="rp-inspection-picks">{results.inspections.map((inspection, index) => <button key={inspection.id} onClick={() => setSelectedInspectionId(inspection.id)} className={selectedInspectionId === inspection.id ? 'active' : ''}><span>{inspection.status === 'active' ? 'Идёт сейчас' : `Осмотр ${results.inspections.length - index}`}</span><small>{routeDate(inspection.started_at)}{inspection.finished_at ? ` — ${routeDate(inspection.finished_at)}` : ''}</small></button>)}</div></div>}
            <RouteProgress section={results.route} inspection={selectedInspection} defects={results.defects}/>
            <div className="rp-results-map">{selectedInspection?<TrackHistory section={results.route} inspection={selectedInspection} defects={results.defects} height={380}/>:<MapView section={results.route} defects={results.defects} height={380} locateOnOpen={false}/>}</div>
            <div className="rp-results-legend"><span><i className="planned"/>Запланированный маршрут</span><span><i className="defect"/>Дефекты ({results.defects.length})</span></div>
            {results.inspections.length === 0 && <div className="rp-no-inspections"><Clock3 size={17}/><span>Инспектор ещё не начал осмотр. На карте показан только плановый маршрут.</span></div>}
          </> : null}
        </div>
      </section>
    </div>
    {user.role !== 'dispatcher' && <div className="rp-role-note">Планирование маршрутов доступно диспетчеру.</div>}
  </main>;
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`rp-summary ${tone}`}><span>{label}</span><strong>{value}</strong><i/></div>; }

function CoordinateForm({ name, lat, lng, setLat, setLng, onApply, disabled = false }: { name: string; lat: string; lng: string; setLat: (value: string) => void; setLng: (value: string) => void; onApply: () => void; disabled?: boolean }) {
  return <div className="rp-coordinate-group"><span className="section-label">{name.toLocaleUpperCase('ru')}</span><label>Широта<input className="input" type="number" inputMode="decimal" step="any" min="-90" max="90" value={lat} onChange={(event) => setLat(event.target.value)} placeholder="44.850000" aria-label={`Широта: ${name.toLowerCase()}`} disabled={disabled}/></label><label>Долгота<input className="input" type="number" inputMode="decimal" step="any" min="-180" max="180" value={lng} onChange={(event) => setLng(event.target.value)} placeholder="65.520000" aria-label={`Долгота: ${name.toLowerCase()}`} disabled={disabled}/></label><button className="button secondary small" onClick={onApply} disabled={disabled || !lat.trim() || !lng.trim()}>Задать точку</button></div>;
}

function RouteOptionCard({ option, index, selected, multi, onSelect, disabled = false }: { option: RouteOption; index: number; selected: boolean; multi: boolean; onSelect: () => void; disabled?: boolean }) {
  const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
  return <button className={`rp-option ${selected ? 'selected' : ''}`} style={{ '--route-color': color } as CSSProperties} onClick={onSelect} aria-pressed={selected} disabled={disabled}>
    <span className="rp-option-index">{selected ? <Check size={16}/> : index + 1}</span><span className="rp-option-copy"><strong>{option.summary || `Вариант ${index + 1}`}</strong><span className="rp-option-metrics"><span><Ruler size={13}/>{meters(option.distance_m)}</span><span><Clock3 size={13}/>{minutes(option.duration_s)}</span></span>{multi && <small>{selected ? 'Вы выбрали этот маршрут' : 'Нажмите, чтобы сравнить на карте'}</small>}</span><span className="rp-option-line"/></button>;
}

type DevicePosition = { lat: number; lng: number; accuracy_m: number; recorded_at: string };
function PlannerMap({ start, end, via, viaPickMode, options, previewId, selectedOptionId, decisionPoints, location, locationReady, hasEndpoints, mapInteracted, onMapClick, onSelectOption, loading, locked }: { start: RoutePoint | null; end: RoutePoint | null; via:RoutePoint[]; viaPickMode:boolean; options: RouteOption[]; previewId: string | null; selectedOptionId: string | null; decisionPoints: RoutePreview['decision_points']; location: DevicePosition | null; locationReady: boolean; hasEndpoints: boolean; mapInteracted: MutableRefObject<boolean>; onMapClick: (lat: number, lng: number) => void; onSelectOption: (id: string) => void; loading: boolean; locked: boolean }) {

  const mapRef = useRef<L.Map | null>(null);
  const restored=useRef(MapViewportMemory.load('dispatcher-planner'));
  if(restored.current)mapInteracted.current=true;
  return <div className={`rp-leaflet ${loading ? 'loading' : ''}`}><MapContainer center={restored.current?.center??DEFAULT_CENTER} zoom={restored.current?.zoom??5} scrollWheelZoom touchZoom zoomSnap={0.25} zoomDelta={0.5} wheelPxPerZoomLevel={180} inertia={false} zoomAnimation={false} fadeAnimation={false} markerZoomAnimation={false} style={{ height: '100%', width: '100%' }}><PlannerMapBehavior mapRef={mapRef} start={start} end={end} options={options} previewId={previewId} location={location} locationReady={locationReady} hasEndpoints={hasEndpoints} mapInteracted={mapInteracted} onMapClick={onMapClick}/><MapTileLayer className="rp-map-tile-feedback"/>
    {options.map((option, index) => (
      <Polyline key={option.id} positions={fromCoordinates(option.geometry.coordinates)} bubblingMouseEvents={viaPickMode} pathOptions={{ color: ROUTE_COLORS[index % ROUTE_COLORS.length], weight: option.id === selectedOptionId ? 8 : selectedOptionId ? 4 : 5, opacity: selectedOptionId && option.id !== selectedOptionId ? .36 : .9 }} eventHandlers={{ click: () => { if (!locked&&!viaPickMode) onSelectOption(option.id); } }} />
    ))}
    {decisionPoints.map((point, index) => <Marker key={`${point.lat}-${point.lng}-${index}`} position={toLatLng(point)} icon={L.divIcon({ className: 'rp-map-div-icon', html: `<span class="rp-divergence-marker">${index + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] })}><Popup><strong>Развилка {index + 1}</strong><br/>{point.label}</Popup></Marker>)}
    {location && <><Circle center={[location.lat,location.lng]} radius={Math.max(1,location.accuracy_m)} pathOptions={{color:location.accuracy_m<=100?'#388575':'#c28b35',weight:1,fillOpacity:.12,fillColor:location.accuracy_m<=100?'#388575':'#d6a447'}} interactive={false}/><Marker position={[location.lat, location.lng]} icon={L.divIcon({ className: 'rp-map-div-icon', html: '<span class="rp-device-location"><i></i></span>', iconSize: [30, 30], iconAnchor: [15, 15] })} zIndexOffset={1000}><Popup><strong>Моё местоположение</strong><br/>Точность около {Math.round(location.accuracy_m)} м<br/>{formatDate(location.recorded_at)}</Popup></Marker></>}
    {via.map((point,index)=><Marker key={`via-${index}-${keyOf(point)}`} position={toLatLng(point)} icon={L.divIcon({className:'rp-map-div-icon',html:`<span class="rp-via-map-marker">${index+1}</span>`,iconSize:[32,32],iconAnchor:[16,16]})}><Popup><strong>Обязательная промежуточная точка {index+1}</strong><br/>{pointLabel(point)}</Popup></Marker>)}
    {start && <Marker position={toLatLng(start)} icon={L.divIcon({ className: 'rp-map-div-icon', html: '<span class="rp-endpoint start">A</span>', iconSize: [34, 34], iconAnchor: [17, 17] })}><Popup>Начало · {pointLabel(start)}</Popup></Marker>}{end && <Marker position={toLatLng(end)} icon={L.divIcon({ className: 'rp-map-div-icon', html: '<span class="rp-endpoint end">B</span>', iconSize: [34, 34], iconAnchor: [17, 17] })}><Popup>Конец · {pointLabel(end)}</Popup></Marker>}
  </MapContainer>{locationReady && location && <button type="button" className="rp-locate-button" ref={(node) => { if (node) L.DomEvent.disableClickPropagation(node); }} onClick={() => mapRef.current?.setView([location.lat, location.lng], accuracyZoom(location.accuracy_m), { animate: false })}><LocateFixed size={15}/>Моё местоположение</button>}</div>;
}

function PlannerMapBehavior({ mapRef, start, end, options, previewId, location, locationReady, hasEndpoints, mapInteracted, onMapClick }: { mapRef: MutableRefObject<L.Map | null>; start: RoutePoint | null; end: RoutePoint | null; options: RouteOption[]; previewId: string | null; location: DevicePosition | null; locationReady: boolean; hasEndpoints: boolean; mapInteracted: MutableRefObject<boolean>; onMapClick: (lat: number, lng: number) => void }) {
  const map = useMap();
  mapRef.current = map;
  const autoCenteredAccuracy = useRef<number | null>(null);
  const fittedPreviewId = useRef<string | null>(null);
  useMapEvents({ moveend:()=>{const c=map.getCenter();MapViewportMemory.save('dispatcher-planner',[c.lat,c.lng],map.getZoom())}, click: (event) => onMapClick(event.latlng.lat, event.latlng.lng), dragstart: () => { mapInteracted.current = true; }, zoomstart: () => { mapInteracted.current = true; } });
  useEffect(() => {
    if (!previewId || previewId === fittedPreviewId.current || options.length === 0) return;
    fittedPreviewId.current = previewId;
    const coordinates = options.flatMap((option) => option.geometry.coordinates);
    const latlngs: L.LatLngExpression[] = coordinates.map(([lng, lat]) => [lat, lng]);
    if (start) latlngs.push(toLatLng(start));
    if (end) latlngs.push(toLatLng(end));
    if (latlngs.length > 1) map.fitBounds(L.latLngBounds(latlngs), { padding: [32, 32], maxZoom: 14, animate: false });
  }, [map, previewId, options, start?.lat, start?.lng, end?.lat, end?.lng]);
  useEffect(() => {
    if (!locationReady || !location || hasEndpoints || mapInteracted.current) return;
    const previous=autoCenteredAccuracy.current;
    if(previous===null||location.accuracy_m<previous*.65){
      autoCenteredAccuracy.current=location.accuracy_m;
      map.setView([location.lat, location.lng], accuracyZoom(location.accuracy_m), { animate: false });
    }
  }, [map, locationReady, location?.lat, location?.lng, location?.accuracy_m, hasEndpoints, mapInteracted]);
  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver.observe(map.getContainer());
    return () => resizeObserver.disconnect();
  }, [map]);
  return null;
}
