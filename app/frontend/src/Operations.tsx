import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { History, MapView, PhotoGallery, StatusBadge, formatDate, UploadField } from './components';
import type { Bootstrap, Contractor, Defect, DefectDetail, Section, User } from './types';
import './operations.css';

type Props = { user: User };
type Notice = { kind: 'error' | 'success' | 'warning'; text: string } | null;
type Panel = 'list' | 'map' | 'detail';
type DispatcherDialogKind = 'request' | 'cancel' | 'reassign' | 'deadline' | 'duplicates';
type DispatcherDialogState = { kind: DispatcherDialogKind; contractorId?: string; dueAt?: string };

const ACTIVE: string[] = ['new', 'needs_info', 'assigned', 'accepted', 'in_progress', 'review', 'rework'];
const CANCELABLE = ['new', 'needs_info', 'assigned'];
const byFreshness = (a: Defect, b: Defect) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
const localInput = (value?: string | null) => {
  if (!value) return '';
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const utcValue = (value: string) => new Date(value).toISOString();
const dateInThreeDays = () => localInput(new Date(Date.now() + 3 * 86400000).toISOString());
const errorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
const statusCaption: Record<string, string> = { new: 'Новые', needs_info: 'Нужны сведения', assigned: 'Назначены', accepted: 'Приняты', in_progress: 'В работе', review: 'На проверке', rework: 'На доработке', closed: 'Закрыты', cancelled: 'Отменены' };
const routeLabel = (section?: Section | null) => section ? `${section.code} · ${section.name}` : 'Маршрут не найден';

export default function Operations({ user }: Props) {
  return user.role === 'contractor' ? <ContractorWorkspace user={user} /> : <DispatcherWorkspace user={user} />;
}

function DispatcherWorkspace({ user }: Props) {
  const [defects, setDefects] = useState<Defect[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [routeFilter, setRouteFilter] = useState('all');
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DefectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('active');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [panel, setPanel] = useState<Panel>('list');
  const [actionBusy, setActionBusy] = useState(false);
  const [dialog, setDialog] = useState<DispatcherDialogState | null>(null);
  const detailRequest = useRef(0);

  const refresh = useCallback(async (keepNotice = false) => {
    setLoading(true);
    if (!keepNotice) setNotice(null);
    try {
      const [rows, boot] = await Promise.all([api.get<Defect[]>('/defects'), api.get<Bootstrap>('/bootstrap')]);
      setDefects(rows.sort(byFreshness));
      setSections(boot.sections);
      setContractors(boot.contractors);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    } catch (error) { setNotice({ kind: 'error', text: errorText(error) }); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    const requestId = ++detailRequest.current;
    if (!silent) setDetailLoading(true);
    try {
      const value = await api.get<DefectDetail>(`/defects/${id}`);
      if (requestId !== detailRequest.current) return;
      setDetail(value);
      setDefects((rows) => rows.map((row) => row.id === id ? { ...row, ...value } : row));
    } catch (error) { if (requestId === detailRequest.current) setNotice({ kind: 'error', text: errorText(error) }); }
    finally { if (!silent && requestId === detailRequest.current) setDetailLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setDetail(null); if (selectedId) void loadDetail(selectedId); else { detailRequest.current += 1; setDetailLoading(false); } }, [selectedId, loadDetail]);

  const visible = useMemo(() => defects.filter((d) => {
    const needle = search.trim().toLocaleLowerCase('ru');
    const section = sections.find((item) => item.id === d.section_id);
    const matchesText = !needle || `${d.number} ${d.type} ${d.description} ${d.contractor_name ?? ''} ${section?.name ?? ''} ${section?.code ?? ''}`.toLocaleLowerCase('ru').includes(needle);
    return matchesText && (routeFilter === 'all' || d.section_id === routeFilter) && (filter === 'all' || (filter === 'active' ? ACTIVE.includes(d.status) : d.status === filter)) && (!overdueOnly || d.overdue);
  }), [defects, sections, search, filter, overdueOnly, routeFilter]);
  useEffect(() => { if (selectedId && !visible.some((item) => item.id === selectedId)) setSelectedId(visible[0]?.id ?? null); }, [selectedId, visible]);
  const summary = useMemo(() => ({ active: defects.filter((d) => ACTIVE.includes(d.status)).length, overdue: defects.filter((d) => d.overdue).length, review: defects.filter((d) => d.status === 'review').length, closed: defects.filter((d) => d.status === 'closed').length }), [defects]);
  const selectedSection = routeFilter === 'all' ? undefined : sections.find((section) => section.id === routeFilter);

  async function mutate(action: string, payload: Record<string, unknown>) {
    if (!detail) return;
    setActionBusy(true); setNotice(null);
    try {
      const next = await api.post<DefectDetail>(`/defects/${detail.id}/actions`, { action, version: detail.version, payload });
      setDetail(next); setDefects((rows) => rows.map((row) => row.id === next.id ? { ...row, ...next } : row));
      setDialog(null); setNotice({ kind: 'success', text: 'Изменения сохранены.' });
      await refresh(true); await loadDetail(next.id, true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        await refresh(true); await loadDetail(detail.id, true);
        setNotice({ kind: 'warning', text: 'Карточка изменилась. Данные обновлены; проверьте их и повторите действие.' });
      } else setNotice({ kind: 'error', text: errorText(error) });
    } finally { setActionBusy(false); }
  }

  const selectTicket = (id: string) => { setSelectedId(id); setPanel('detail'); };
  return <main className="ops-shell">
    <header className="ops-heading">
      <div><div className="eyebrow">ДИСПЕТЧЕРСКАЯ · РЕЕСТР</div><h1>Дефекты участков</h1><p>Здравствуйте, {user.name}. Управляйте назначениями и сроками.</p></div>
      <button className="button secondary ops-refresh" onClick={() => void refresh()} disabled={loading}>↻ <span>Обновить</span></button>
    </header>
    {notice && <div className={`alert ${notice.kind}`} role="status">{notice.text}<button className="ops-notice-close" aria-label="Скрыть сообщение" onClick={() => setNotice(null)}>×</button></div>}
    <div className="ops-stats">
      <Summary label="Активные" value={summary.active} tint="green" onClick={() => { setFilter('active'); setOverdueOnly(false); }} />
      <Summary label="На проверке" value={summary.review} tint="blue" onClick={() => { setFilter('review'); setOverdueOnly(false); }} />
      <Summary label="Просрочены" value={summary.overdue} tint="rose" onClick={() => { setFilter('all'); setOverdueOnly(true); }} />
      <Summary label="Закрыты" value={summary.closed} tint="sand" onClick={() => { setFilter('closed'); setOverdueOnly(false); }} />
    </div>
    <div className="ops-tabs" aria-label="Режим просмотра">
      {(['list', 'map', 'detail'] as Panel[]).map((p) => <button key={p} className={`tab ${panel === p ? 'active' : ''}`} onClick={() => setPanel(p)}>{p === 'list' ? 'Список' : p === 'map' ? 'Карта' : 'Карточка'}</button>)}
    </div>
    <section className={`ops-workspace ops-panel-${panel}`}>
      <aside className="ops-list card">
        <div className="ops-list-head"><div><div className="section-label">ЖУРНАЛ</div><strong>{visible.length} обращений</strong></div><span className="ops-live-dot">Актуально</span></div>
        <label className="ops-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Номер, дефект, исполнитель" aria-label="Поиск по обращениям" /></label>
        <div className="ops-list-filters"><select className="select" aria-label="Фильтр по статусу" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="active">Активные статусы</option><option value="all">Все статусы</option>{Object.entries(statusCaption).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className={`ops-overdue-toggle ${overdueOnly ? 'active' : ''}`} onClick={() => setOverdueOnly((v) => !v)} aria-pressed={overdueOnly}>Срок истёк</button></div>
        <label className="ops-route-filter"><span>Участок</span><select className="select" aria-label="Фильтр по маршруту" value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}><option value="all">Все маршруты</option>{sections.map((section) => <option key={section.id} value={section.id}>{routeLabel(section)}</option>)}</select></label>
        <div className="ops-ticket-list" aria-live="polite">
          {loading ? <div className="empty"><span className="ops-spinner" />Загружаем обращения…</div> : visible.length === 0 ? <div className="empty"><span className="ops-empty-mark">⌕</span><strong>Ничего не найдено</strong><span>Измените фильтр или поисковый запрос.</span></div> : visible.map((ticket) => <button key={ticket.id} className={`ops-ticket ${ticket.id === selectedId ? 'selected' : ''}`} onClick={() => selectTicket(ticket.id)}>
            <div className="ops-ticket-top"><span className="ops-number">№ {ticket.number}</span><StatusBadge status={ticket.status} overdue={ticket.overdue} /></div><strong className="ops-ticket-title">{ticket.type}</strong><span className="ops-ticket-description">{ticket.description}</span><div className="ops-ticket-meta"><span>{formatDate(ticket.received_at)}</span><span>{routeLabel(sections.find((section) => section.id === ticket.section_id))}</span></div>
          </button>)}
        </div>
      </aside>
      <section className="ops-map card"><div className="ops-map-head"><div><div className="section-label">ПЛАН И МЕСТА ДЕФЕКТОВ</div><strong>{selectedSection ? routeLabel(selectedSection) : routeFilter === 'all' ? 'Все назначенные маршруты' : 'Маршрут'}</strong></div><span className="ops-map-key"><i /> Дефекты</span></div><MapView section={selectedSection} defects={visible} selectedId={selectedId ?? undefined} onSelect={selectTicket} height={452} /><div className="ops-map-foot"><span>Плановая линия маршрута и зарегистрированные дефекты</span><span>{visible.length} на карте</span></div></section>
      <section className="ops-detail card">{detailLoading && !detail ? <div className="empty"><span className="ops-spinner" />Открываем карточку…</div> : detail ? <DispatcherDetail detail={detail} section={sections.find((item) => item.id === detail.section_id)} contractors={contractors} onAction={mutate} onOpenDialog={(kind, contractorId, dueAt) => setDialog({ kind, contractorId, dueAt })} busy={actionBusy} /> : <div className="empty"><span className="ops-empty-mark">◫</span><strong>Выберите обращение</strong><span>Карточка покажет фотографии, место и историю проверки.</span></div>}</section>
    </section>
    {dialog && detail && <DispatcherDialog kind={dialog.kind} detail={detail} contractors={contractors} initialContractorId={dialog.contractorId} initialDueAt={dialog.dueAt} busy={actionBusy} onClose={() => setDialog(null)} onSubmit={mutate} />}
  </main>;
}

function Summary({ label, value, tint, onClick }: { label: string; value: number; tint: string; onClick: () => void }) { return <button className={`ops-summary ${tint}`} onClick={onClick}><span>{label}</span><strong>{value}</strong><i>↗</i></button>; }

function DispatcherDetail({ detail, section, contractors, onAction, onOpenDialog, busy }: { detail: DefectDetail; section?: Section; contractors: Contractor[]; onAction: (action: string, payload: Record<string, unknown>) => Promise<void>; onOpenDialog: (kind: DispatcherDialogKind, contractorId?: string, dueAt?: string) => void; busy: boolean }) {
  const [contractorId, setContractorId] = useState(detail.contractor_id ?? '');
  const [dueAt, setDueAt] = useState(localInput(detail.due_at) || dateInThreeDays());
  useEffect(() => { setContractorId(detail.contractor_id ?? ''); setDueAt(localInput(detail.due_at) || dateInThreeDays()); }, [detail.id, detail.contractor_id, detail.due_at]);
  return <>
    <div className="ops-detail-header"><div><div className="section-label">КАРТОЧКА ОБРАЩЕНИЯ</div><div className="ops-detail-number">№ {detail.number}</div></div><StatusBadge status={detail.status} overdue={detail.overdue} /></div>
    <h2 className="ops-defect-title">{detail.type}</h2><p className="ops-defect-description">{detail.description}</p>
    <div className="ops-facts"><Fact label="Маршрут" value={routeLabel(section)} /><Fact label="Обнаружено" value={formatDate(detail.observed_at)} /><Fact label="Получено" value={formatDate(detail.received_at)} /><Fact label="Исполнитель" value={detail.contractor_name ?? 'Не назначен'} /><Fact label="Срок" value={detail.due_at ? formatDate(detail.due_at) : 'Не установлен'} /></div>
    <div className="ops-coordinate"><div><span className="section-label">КООРДИНАТЫ</span><strong>{detail.lat.toFixed(6)}°, {detail.lng.toFixed(6)}°</strong><span>{detail.location_source === 'gps' ? 'GPS' : 'Указано вручную'}{detail.accuracy_m != null ? ` · точность ±${Math.round(detail.accuracy_m)} м` : ''}</span></div><span className="ops-pin">⌖</span></div>
    <div className="ops-detail-section"><div className="section-label">ИСХОДНЫЕ ФОТОГРАФИИ <span>{detail.photos.length}</span></div><PhotoGallery photos={detail.photos} /></div>
    {detail.repairs.length > 0 && <div className="ops-detail-section"><div className="section-label">ПОПЫТКИ РЕМОНТА <span>{detail.repairs.length}</span></div><div className="ops-repairs">{detail.repairs.map((repair, i) => <article key={repair.id} className="ops-repair"><div className="ops-repair-title"><strong>Попытка {i + 1}</strong><span>{formatDate(repair.created_at)}</span></div><p>{repair.comment}</p><PhotoGallery photos={repair.photos} />{repair.decision && <div className={`ops-decision ${repair.decision}`}>{repair.decision === 'accepted' ? 'Работа принята' : `Возвращено на доработку${repair.decision_comment ? `: ${repair.decision_comment}` : ''}`}</div>}</article>)}</div></div>}
    {detail.linked_observations?.length ? <div className="ops-detail-section"><div className="section-label">СВЯЗАННЫЕ НАБЛЮДЕНИЯ</div>{detail.linked_observations.map((o) => <div className="ops-linked" key={o.id}>№ {o.number} · {formatDate(o.observed_at)} · {o.type}</div>)}</div> : null}
    {detail.status === 'new' && <div className="ops-detail-section"><div className="section-label">РАСПРЕДЕЛЕНИЕ</div><label className="field">Исполнитель<select className="select" value={contractorId} onChange={(e) => setContractorId(e.target.value)}><option value="">Выберите организацию</option>{contractors.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label className="field">Срок выполнения<input className="input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label><button className="button primary" disabled={busy || !contractorId || !dueAt} onClick={() => void onAction('assign', { contractor_id: contractorId, due_at: utcValue(dueAt) })}>Назначить исполнителя</button><button className="button secondary" disabled={busy} onClick={() => onOpenDialog('request')}>Запросить сведения</button><button className="button secondary" disabled={busy} onClick={() => onOpenDialog('duplicates')}>Сравнить дубликаты</button></div>}
    {['assigned', 'accepted', 'in_progress', 'review', 'rework'].includes(detail.status) && <div className="ops-detail-section"><div className="section-label">КОНТРОЛЬ НАЗНАЧЕНИЯ</div>{detail.status !== 'review' && <label className="field">Исполнитель<select className="select" value={contractorId} onChange={(e) => setContractorId(e.target.value)}><option value="">Выберите организацию</option>{contractors.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>}<label className="field">Срок выполнения<input className="input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label><div className="row ops-actions-wrap">{detail.status !== 'review' && <button className="button secondary" disabled={busy || !contractorId || contractorId === detail.contractor_id || !dueAt} onClick={() => onOpenDialog('reassign', contractorId, dueAt)}>Переназначить</button>}<button className="button secondary" disabled={busy || !dueAt} onClick={() => onOpenDialog('deadline', contractorId, dueAt)}>Изменить срок</button></div></div>}
    {detail.status === 'needs_info' && <div className="ops-detail-section"><div className="ops-callout"><strong>Ожидаются сведения</strong><span>Исходный инспектор может дополнить описание обращения.</span></div><button className="button secondary" disabled={busy} onClick={() => onOpenDialog('duplicates')}>Сравнить дубликаты</button></div>}
    {CANCELABLE.includes(detail.status) && <div className="ops-detail-section"><button className="button danger" disabled={busy} onClick={() => onOpenDialog('cancel')}>Отменить обращение</button></div>}
    <div className="ops-detail-section"><div className="section-label">ИСТОРИЯ ДЕЙСТВИЙ</div><History events={detail.history} /></div>
  </>;
}
function Fact({ label, value }: { label: string; value: string }) { return <div className="ops-fact"><span>{label}</span><strong>{value}</strong></div>; }

function DispatcherDialog({ kind, detail, contractors, initialContractorId, initialDueAt, busy, onClose, onSubmit }: { kind: DispatcherDialogKind; detail: DefectDetail; contractors: Contractor[]; initialContractorId?: string; initialDueAt?: string; busy: boolean; onClose: () => void; onSubmit: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [comment, setComment] = useState('');
  const [targetId, setTargetId] = useState(initialContractorId ?? '');
  const [dueAt, setDueAt] = useState(initialDueAt || localInput(detail.due_at) || dateInThreeDays());
  const [rows, setRows] = useState<Defect[]>([]);
  const [loading, setLoading] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState('');
  useEffect(() => { if (kind === 'duplicates') { setLoading(true); setDuplicatesError(''); api.get<Defect[]>(`/defects/${detail.id}/duplicates`).then(setRows).catch((error) => { setRows([]); setDuplicatesError(errorText(error)); }).finally(() => setLoading(false)); } }, [kind, detail.id]);
  const config = { request: ['Запросить сведения', 'request_info', 'Комментарий для инспектора'], cancel: ['Отменить обращение', 'cancel', 'Причина отмены'], reassign: ['Переназначить обращение', 'reassign', 'Причина переназначения'], deadline: ['Изменить срок', 'change_deadline', 'Причина изменения срока'] } as const;
  async function submit(e: FormEvent) { e.preventDefault(); if (kind === 'duplicates') { if (targetId) await onSubmit('link_duplicate', { target_id: targetId }); else onClose(); return; } const pair = config[kind as keyof typeof config]; if (!pair) return; const payload: Record<string, unknown> = kind === 'request' ? { comment: comment.trim() } : { reason: comment.trim() }; if (kind === 'reassign') payload.contractor_id = targetId; if (kind === 'reassign' || kind === 'deadline') payload.due_at = utcValue(dueAt); await onSubmit(pair[1], payload); }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal ops-modal" role="dialog" aria-modal="true" aria-labelledby="ops-dialog-title"><button className="ops-modal-close" aria-label="Закрыть" onClick={onClose}>×</button>
    {kind === 'duplicates' ? <><div className="section-label">СРАВНЕНИЕ ОБРАЩЕНИЙ</div><h2 id="ops-dialog-title">Похожие дефекты</h2><p className="muted">Совпадения в пределах 30 м для этого участка и типа дефекта.</p>{loading ? <div className="empty">Ищем совпадения…</div> : duplicatesError ? <div className="alert error" role="alert">{duplicatesError}</div> : rows.length === 0 ? <div className="empty">Открытых совпадений не найдено. Можно продолжить как с отдельным дефектом.</div> : <div className="ops-duplicate-list">{rows.map((row) => <label className={`ops-duplicate ${targetId === row.id ? 'active' : ''}`} key={row.id}><input type="radio" name="duplicate" value={row.id} checked={targetId === row.id} onChange={() => setTargetId(row.id)} /><div><strong>№ {row.number} · {row.type}</strong><span>{row.description}</span><span>{row.lat.toFixed(6)}°, {row.lng.toFixed(6)}° · {formatDate(row.observed_at)}</span></div><StatusBadge status={row.status} /></label>)}</div>}<div className="ops-modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>Оставить отдельным дефектом</button><button className="button primary" disabled={busy || !targetId || loading || !!duplicatesError} onClick={() => void onSubmit('link_duplicate', { target_id: targetId })}>Связать как дубликат</button></div></> : <form onSubmit={submit}><div className="section-label">ИЗМЕНЕНИЕ КАРТОЧКИ</div><h2 id="ops-dialog-title">{config[kind as keyof typeof config]?.[0]}</h2>{kind === 'reassign' && <label className="field">Новая организация<select required className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">Выберите организацию</option>{contractors.filter((c) => c.id !== detail.contractor_id).map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>}{kind === 'deadline' && <label className="field">Новый срок<input required className="input" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label>}<label className="field">{config[kind as keyof typeof config]?.[2]}<textarea required minLength={2} className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Укажите причину" /></label><div className="ops-modal-actions"><button type="button" className="button secondary" onClick={onClose}>Назад</button><button className="button primary" disabled={busy || comment.trim().length < 2 || (kind === 'reassign' && !targetId) || (kind === 'deadline' && !dueAt)}>{busy ? 'Сохраняем…' : 'Подтвердить'}</button></div></form>}
  </section></div>;
}

function ContractorWorkspace({ user }: Props) {
  const [defects, setDefects] = useState<Defect[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [detail, setDetail] = useState<DefectDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState('all');
  const [photos, setPhotos] = useState<DefectDetail['photos']>([]);
  const [comment, setComment] = useState('');
  const [reportReason, setReportReason] = useState('');
  const [reporting, setReporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<Panel>('list');
  const [search, setSearch] = useState('');
  const refresh = useCallback(async (keepNotice = false) => { setLoading(true); if (!keepNotice) setNotice(null); try { const [rows, boot] = await Promise.all([api.get<Defect[]>('/defects'), api.get<Bootstrap>('/bootstrap')]); setDefects(rows.sort(byFreshness)); setSections(boot.sections); setSelectedId((cur) => cur && rows.some((d) => d.id === cur) ? cur : rows[0]?.id ?? null); } catch (e) { setNotice({ kind: 'error', text: errorText(e) }); } finally { setLoading(false); } }, []);
  const loadDetail = useCallback(async (id: string) => { setDetailLoading(true); try { const value = await api.get<DefectDetail>(`/defects/${id}`); setDetail(value); setPhotos([]); setComment(''); } catch (e) { setNotice({ kind: 'error', text: errorText(e) }); } finally { setDetailLoading(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setDetail(null); if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);
  const visible = useMemo(() => defects.filter((d) => {
    const section = sections.find((item) => item.id === d.section_id);
    return (routeFilter === 'all' || d.section_id === routeFilter) && `${d.number} ${d.type} ${d.description} ${section?.name ?? ''} ${section?.code ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'));
  }), [defects, sections, search, routeFilter]);
  useEffect(() => { if (selectedId && !visible.some((item) => item.id === selectedId)) setSelectedId(visible[0]?.id ?? null); }, [selectedId, visible]);
  async function action(name: string, payload: Record<string, unknown> = {}) {
    if (!detail) return; setBusy(true); setNotice(null);
    try { const updated = await api.post<DefectDetail>(`/defects/${detail.id}/actions`, { action: name, version: detail.version, payload }); setDetail(updated); setDefects((list) => list.map((row) => row.id === updated.id ? { ...row, ...updated } : row)); setPhotos([]); setComment(''); setNotice({ kind: 'success', text: 'Статус обращения обновлён.' }); await refresh(true); await loadDetail(updated.id); }
    catch (e) { if (e instanceof ApiError && e.code === 'CONFLICT') { await refresh(true); await loadDetail(detail.id); setNotice({ kind: 'warning', text: 'Карточка обновлена: проверьте текущий статус и повторите действие.' }); } else setNotice({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); }
  }
  async function report() { if (!detail || reportReason.trim().length < 2) return; setBusy(true); setNotice(null); try { await api.post<DefectDetail>(`/defects/${detail.id}/actions`, { action: 'report_assignment', version: detail.version, payload: { reason: reportReason.trim() } }); setReportReason(''); setReporting(false); setNotice({ kind: 'success', text: 'Сообщение диспетчеру отправлено. Статус не изменён.' }); await loadDetail(detail.id); } catch (e) { if (e instanceof ApiError && e.code === 'CONFLICT') { await refresh(true); await loadDetail(detail.id); setNotice({ kind: 'warning', text: 'Карточка обновлена. Проверьте назначение и повторите сообщение.' }); } else setNotice({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); } }
  return <main className="ops-shell ops-contractor-shell">
    <header className="ops-heading"><div><div className="eyebrow">КАБИНЕТ ИСПОЛНИТЕЛЯ</div><h1>Мои обращения</h1><p>{user.name} · {defects.length} назначенных обращений</p></div><button className="button secondary ops-refresh" onClick={() => void refresh()} disabled={loading}>↻ <span>Обновить</span></button></header>
    {notice && <div className={`alert ${notice.kind}`} role="status">{notice.text}<button className="ops-notice-close" aria-label="Скрыть сообщение" onClick={() => setNotice(null)}>×</button></div>}
    <div className="ops-tabs"><button className={`tab ${panel === 'list' ? 'active' : ''}`} onClick={() => setPanel('list')}>Обращения</button><button className={`tab ${panel === 'detail' ? 'active' : ''}`} onClick={() => setPanel('detail')}>Карточка</button></div>
    <section className={`ops-contractor-layout ops-panel-${panel}`}>
      <aside className="ops-list card"><div className="ops-list-head"><div><div className="section-label">НАЗНАЧЕНИЯ</div><strong>{visible.length} обращений</strong></div></div><label className="ops-search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Номер или вид дефекта" aria-label="Поиск по обращениям" /></label><label className="ops-route-filter"><span>Маршрут</span><select className="select" aria-label="Фильтр по маршруту" value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}><option value="all">Все маршруты</option>{sections.map((section) => <option key={section.id} value={section.id}>{routeLabel(section)}</option>)}</select></label><div className="ops-ticket-list">{loading ? <div className="empty"><span className="ops-spinner" />Загружаем назначения…</div> : visible.length === 0 ? <div className="empty"><span className="ops-empty-mark">✓</span><strong>Обращений пока нет</strong><span>Новые назначения появятся здесь.</span></div> : visible.map((ticket) => <button key={ticket.id} className={`ops-ticket ${ticket.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(ticket.id); setPanel('detail'); }}><div className="ops-ticket-top"><span className="ops-number">№ {ticket.number}</span><StatusBadge status={ticket.status} overdue={ticket.overdue} /></div><strong className="ops-ticket-title">{ticket.type}</strong><span className="ops-ticket-description">{ticket.description}</span><div className="ops-ticket-meta"><span>{routeLabel(sections.find((section) => section.id === ticket.section_id))}</span><span>{ticket.due_at ? `Срок ${formatDate(ticket.due_at)}` : 'Срок не установлен'}</span></div></button>)}</div></aside>
      <section className="ops-contractor-detail card">{detailLoading ? <div className="empty"><span className="ops-spinner" />Открываем карточку…</div> : detail ? <>
        <div className="ops-detail-header"><div><div className="section-label">НАЗНАЧЕНО ВАМ</div><div className="ops-detail-number">№ {detail.number}</div></div><StatusBadge status={detail.status} overdue={detail.overdue} /></div><h2 className="ops-defect-title">{detail.type}</h2><p className="ops-defect-description">{detail.description}</p>
        <div className="ops-facts ops-facts-two"><Fact label="Маршрут" value={routeLabel(sections.find((section) => section.id === detail.section_id))} /><Fact label="Срок выполнения" value={detail.due_at ? formatDate(detail.due_at) : 'Не установлен'} /><Fact label="Обнаружено" value={formatDate(detail.observed_at)} /></div>
        <div className="ops-coordinate"><div><span className="section-label">МЕСТО РЕМОНТА</span><strong>{detail.lat.toFixed(6)}°, {detail.lng.toFixed(6)}°</strong><span>{detail.location_source === 'gps' ? 'Координаты GPS' : 'Координаты указаны вручную'}{detail.accuracy_m != null ? ` · точность ±${Math.round(detail.accuracy_m)} м` : ''}</span></div><span className="ops-pin">⌖</span></div>
        <div className="ops-detail-section"><div className="section-label">ИСХОДНЫЕ ФОТОГРАФИИ</div><PhotoGallery photos={detail.photos} /></div>
        {detail.status === 'rework' && <div className="ops-rework-reason"><span className="section-label">ЗАМЕЧАНИЕ ИНСПЕКТОРА</span><strong>Требуется доработка</strong><p>{[...detail.repairs].reverse().find((r) => r.decision === 'rejected')?.decision_comment || [...detail.history].reverse().find((e) => e.action === 'reject')?.comment || 'Инспектор вернул работу на повторную проверку.'}</p></div>}
        {detail.repairs.length > 0 && <div className="ops-detail-section"><div className="section-label">ИСТОРИЯ РЕМОНТА <span>{detail.repairs.length} {detail.repairs.length === 1 ? 'попытка' : 'попытки'}</span></div><div className="ops-repairs">{detail.repairs.map((repair, i) => <article key={repair.id} className="ops-repair"><div className="ops-repair-title"><strong>Попытка {i + 1}</strong><span>{formatDate(repair.created_at)}</span></div><p>{repair.comment}</p><PhotoGallery photos={repair.photos} />{repair.decision && <div className={`ops-decision ${repair.decision}`}>{repair.decision === 'accepted' ? 'Принята инспектором' : `Возвращена · ${repair.decision_comment ?? ''}`}</div>}</article>)}</div></div>}
        {detail.status === 'assigned' && <div className="ops-action-panel"><div><span className="section-label">СЛЕДУЮЩИЙ ШАГ</span><strong>Подтвердите, что принимаете назначение</strong></div><button className="button primary" disabled={busy} onClick={() => void action('accept')}>{busy ? 'Обновляем…' : 'Принять назначение'}</button><button className="button secondary" onClick={() => setReporting((v) => !v)}>Сообщить об ошибке назначения</button>{reporting && <div className="ops-report-box"><label className="field">Почему назначение неверное?<textarea className="textarea" required minLength={2} value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="Опишите причину для диспетчера" /></label><button className="button secondary" disabled={busy || reportReason.trim().length < 2} onClick={() => void report()}>Отправить сообщение</button></div>}</div>}
        {detail.status === 'accepted' && <div className="ops-action-panel"><div><span className="section-label">СЛЕДУЮЩИЙ ШАГ</span><strong>Начните ремонт, когда будете на месте</strong></div><button className="button primary" disabled={busy} onClick={() => void action('start')}>{busy ? 'Обновляем…' : 'Начать ремонт'}</button></div>}
        {detail.status === 'rework' && <div className="ops-action-panel"><div><span className="section-label">ПОВТОРНЫЙ РЕМОНТ</span><strong>Создайте новую попытку по замечанию инспектора</strong></div><button className="button primary" disabled={busy} onClick={() => void action('start')}>{busy ? 'Обновляем…' : 'Начать доработку'}</button></div>}
        {detail.status === 'in_progress' && <div className="ops-action-panel ops-submit-panel"><div><span className="section-label">ОТЧЁТ О РЕМОНТЕ</span><strong>Загрузите новые фотографии после ремонта</strong><span>Фотографии и комментарий обязательны. Исходные фото обращения сохраняются отдельно.</span></div><UploadField photos={photos} onChange={setPhotos} label="Фотографии ремонта" /><label className="field">Комментарий о выполненных работах<textarea className="textarea" required minLength={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Что было сделано?" /></label><button className="button primary" disabled={busy || photos.length === 0 || comment.trim().length < 2} onClick={() => void action('submit', { photo_ids: photos.map((p) => p.id), comment: comment.trim() })}>{busy ? 'Отправляем…' : 'Передать инспектору'}</button></div>}
        {detail.status === 'review' && <div className="ops-readonly"><span>◷</span><div><strong>Отчёт отправлен инспектору</strong><p>Карточка доступна для просмотра, новые действия появятся после решения инспектора.</p></div></div>}
        {['closed', 'cancelled', 'needs_info', 'new'].includes(detail.status) && <div className="ops-readonly"><span>i</span><div><strong>{detail.status === 'closed' ? 'Работа завершена' : detail.status === 'cancelled' ? 'Обращение отменено' : 'Ожидает решения диспетчера'}</strong><p>Действия в этой карточке сейчас недоступны.</p></div></div>}
        <div className="ops-detail-section"><div className="section-label">ИСТОРИЯ ДЕЙСТВИЙ</div><History events={detail.history} /></div>
      </> : <div className="empty"><span className="ops-empty-mark">◫</span><strong>Выберите назначение</strong><span>Здесь будут детали дефекта и доступные действия.</span></div>}</section>
    </section>
  </main>;
}
