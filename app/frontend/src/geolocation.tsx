import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setMutationGuard } from './api';

export type DevicePosition = { lat: number; lng: number; accuracy_m: number; recorded_at: string };
type LocationState = { position: DevicePosition | null; ready: boolean; error: string; status: 'requesting' | 'ready' | 'unavailable'; retry: () => void };
const MAX_FIX_AGE_MS = 30_000;
const LocationContext = createContext<LocationState | null>(null);

export function LocationProvider({ children, requireGps = false }: { children: ReactNode; requireGps?: boolean }) {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(true);
  const [revision, setRevision] = useState(0);
  const latest = useRef<DevicePosition | null>(null);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let disposed = false, permission: PermissionStatus | null = null, watchId: number | null = null, denied = false, polling = false, generation = 0, fixVersion = 0;
    const clearFix = (message: string) => {
      latest.current = null; setPosition(null); setError(message); setRequesting(false);
    };
    const fresh = (fix: GeolocationPosition) => {
      if (disposed || denied || document.visibilityState !== 'visible') return;
      if (latest.current && fix.timestamp < Date.parse(latest.current.recorded_at)) return;
      const age = Date.now() - fix.timestamp;
      if (!Number.isFinite(fix.timestamp) || age > MAX_FIX_AGE_MS || age < -5000 || !Number.isFinite(fix.coords.latitude) || !Number.isFinite(fix.coords.longitude) || !Number.isFinite(fix.coords.accuracy)) {
        clearFix('Нет актуальной GPS-позиции. Повторите определение местоположения.'); return;
      }
      const next = { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy_m: fix.coords.accuracy, recorded_at: new Date(fix.timestamp).toISOString() };
      fixVersion += 1; latest.current = next; setPosition(next); setError(''); setRequesting(false);
    };
    const failed = (failure: GeolocationPositionError) => {
      if (disposed) return;
      if (failure.code === 1) denied = true;
      clearFix(failure.code === 1 ? 'Разрешите доступ к местоположению в настройках браузера и включите геолокацию устройства.' : failure.code === 3 ? 'GPS не ответил вовремя. Проверьте геолокацию устройства и повторите попытку.' : 'GPS-позиция недоступна. Включите геолокацию устройства и повторите попытку.');
    };
    const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
    const poll = () => {
      if (disposed || denied || polling || document.visibilityState !== 'visible' || !navigator.geolocation) return;
      polling = true;
      const requestGeneration = generation, requestVersion = fixVersion;
      navigator.geolocation.getCurrentPosition(fix => {
        if (disposed || requestGeneration !== generation) return;
        polling = false; fresh(fix);
      }, failure => {
        if (disposed || requestGeneration !== generation) return;
        polling = false;
        if (failure.code === 1 || requestVersion === fixVersion) failed(failure);
      }, options);
    };
    const stopWatch = () => { generation += 1; polling = false; if (watchId !== null) navigator.geolocation?.clearWatch(watchId); watchId = null; };
    const startWatch = () => {
      stopWatch();
      if (disposed || denied || document.visibilityState !== 'visible' || !navigator.geolocation) return;
      const watchGeneration = generation;
      watchId = navigator.geolocation.watchPosition(fix => { if (watchGeneration === generation) fresh(fix); }, failure => { if (watchGeneration === generation) failed(failure); }, options);
      poll();
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') { setRequesting(true); startWatch(); }
      else { stopWatch(); clearFix('Вернитесь во вкладку, чтобы восстановить GPS-позицию.'); }
    };
    latest.current = null; setPosition(null); setError(''); setRequesting(true);
    if (!navigator.geolocation || !window.isSecureContext) {
      clearFix('Геолокация недоступна. Откройте приложение через HTTPS или localhost.');
      return () => { disposed = true; };
    }
    startWatch();
    void navigator.permissions?.query({ name: 'geolocation' }).then(value => {
      if (disposed) return;
      permission = value;
      value.onchange = () => {
        if (disposed) return;
        denied = value.state === 'denied';
        if (denied) { stopWatch(); clearFix('Доступ к GPS отключён. Разрешите геолокацию, чтобы продолжить.'); }
        else { setRequesting(true); startWatch(); }
      };
      if (value.state === 'denied') value.onchange(new Event('change'));
    }).catch(() => { /* Geolocation callbacks also report permission failures. */ });
    const pollTimer = window.setInterval(poll, 15000);
    const expiryTimer = window.setInterval(() => {
      if (latest.current && Date.now() - Date.parse(latest.current.recorded_at) > MAX_FIX_AGE_MS) clearFix('GPS-сигнал потерян. Работа приостановлена до получения актуальной позиции.');
    }, 1000);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; stopWatch(); clearInterval(pollTimer); clearInterval(expiryTimer); document.removeEventListener('visibilitychange', visibility); if (permission) permission.onchange = null; };
  }, [revision]);

  useEffect(() => {
    if (!requireGps) return;
    setMutationGuard(() => {
      const fix = latest.current;
      return fix && document.visibilityState === 'visible' && Date.now() - Date.parse(fix.recorded_at) <= MAX_FIX_AGE_MS ? null : 'Для работы инспектора требуется актуальная GPS-позиция. Включите геолокацию.';
    });
    return () => setMutationGuard(null);
  }, [requireGps]);

  const value = useMemo<LocationState>(() => ({ position, ready: position !== null && !error, error, status: position && !error ? 'ready' : requesting ? 'requesting' : 'unavailable', retry }), [position, error, requesting, retry]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useDeviceLocation() {
  const state = useContext(LocationContext);
  if (!state) throw new Error('LocationProvider is required');
  return state;
}
