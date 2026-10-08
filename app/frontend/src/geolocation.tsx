import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setMutationGuard } from './api';

export type DevicePosition = { lat: number; lng: number; accuracy_m: number; recorded_at: string };
type LocationState = { position: DevicePosition | null; ready: boolean; error: string; status: 'requesting' | 'ready' | 'unavailable'; retry: () => void };
type PagePermission = PermissionState | 'unknown';
const MAX_FIX_AGE_MS = 30_000;
const LocationContext = createContext<LocationState | null>(null);

function hasFreshFix(fix: DevicePosition | null) {
  if (!fix) return false;
  const age = Date.now() - Date.parse(fix.recorded_at);
  return Number.isFinite(age) && age >= -5000 && age <= MAX_FIX_AGE_MS;
}

function windowsLocationHelp() {
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /windows/i.test(platform)
    ? ' Если вы на Windows, проверьте «Параметры → Конфиденциальность и безопасность → Местоположение» и доступ классических приложений.'
    : ' Проверьте системный доступ к геолокации или откройте страницу в отдельной вкладке браузера.';
}

function locationPolicyBlocked() {
  const doc = document as Document & {
    permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
    featurePolicy?: { allowsFeature?: (feature: string) => boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  try { return policy?.allowsFeature?.('geolocation') === false; } catch { return false; }
}

export function LocationProvider({ children, requireGps = false }: { children: ReactNode; requireGps?: boolean }) {
  const [position, setPosition] = useState<DevicePosition | null>(null);
  const [error, setError] = useState('');
  const [requesting, setRequesting] = useState(true);
  const [revision, setRevision] = useState(0);
  const latest = useRef<DevicePosition | null>(null);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let permission: PermissionStatus | null = null;
    let pagePermission: PagePermission = 'unknown';
    let lastFailure: GeolocationPositionError | null = null;
    let watchId: number | null = null;
    let denied = false;
    let generation = 0;
    let retryTimer: number | null = null;
    let refreshInFlight = false;
    let refreshForFix = '';
    let permissionGrantedRestarted = false;
    let providerIssue = '';

    const stopWatch = () => {
      generation += 1;
      refreshInFlight = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
      watchId = null;
    };
    const clearFix = (message: string) => {
      providerIssue = '';
      refreshForFix = '';
      latest.current = null;
      setPosition(null);
      setError(message);
      setRequesting(false);
    };
    const recordProviderIssue = (message: string) => {
      providerIssue = message;
      setError(message);
      if (!hasFreshFix(latest.current)) {
        latest.current = null;
        setPosition(null);
        setRequesting(false);
      }
    };

    const scheduleRecovery = () => {
      if (retryTimer !== null || disposed || denied || document.visibilityState !== 'visible') return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (disposed || denied || document.visibilityState !== 'visible') return;
        if (!hasFreshFix(latest.current)) setRequesting(true);
        startWatch();
      }, 8000);
    };

    const fresh = (fix: GeolocationPosition) => {
      if (disposed || denied || document.visibilityState !== 'visible') return;
      if (latest.current && fix.timestamp < Date.parse(latest.current.recorded_at)) return;
      const age = Date.now() - fix.timestamp;
      if (!Number.isFinite(fix.timestamp) || age > MAX_FIX_AGE_MS || age < -5000 || !Number.isFinite(fix.coords.latitude) || !Number.isFinite(fix.coords.longitude) || !Number.isFinite(fix.coords.accuracy)) {
        recordProviderIssue('Браузер не получил актуальную позицию. Повторяем поиск GPS.');
        scheduleRecovery();
        return;
      }
      const next = { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy_m: fix.coords.accuracy, recorded_at: new Date(fix.timestamp).toISOString() };
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      lastFailure = null;
      providerIssue = '';
      latest.current = next;
      setPosition(next);
      setError('');
      setRequesting(false);
    };

    const failed = (failure: GeolocationPositionError) => {
      if (disposed) return;
      lastFailure = failure;
      if (failure.code === 1 && (pagePermission === 'denied' || locationPolicyBlocked())) {
        denied = true;
        stopWatch();
        clearFix(locationPolicyBlocked()
          ? 'Доступ к геолокации запрещён политикой браузера для этой страницы. Откройте приложение в разрешённом контексте.'
          : 'Браузер запретил этой странице доступ к геолокации. Разрешите местоположение для сайта в настройках браузера.');
        return;
      }
      if (failure.code === 1) {
        stopWatch();
        clearFix(pagePermission === 'granted'
          ? `Разрешение сайта в браузере выдано, но позиция не получена. Возможна блокировка системным источником геолокации или средой встроенного браузера.${windowsLocationHelp()} Закройте диалог выбора файла, если он открыт, либо откройте страницу в отдельной вкладке и нажмите «Повторить определение».`
          : `Запрос геолокации отклонён, но разрешение страницы не подтверждено. Проверьте доступ для сайта в браузере и системную геолокацию.${windowsLocationHelp()} Затем нажмите «Повторить определение».`);
        return;
      }
      const message = failure.code === 3
        ? `Браузер не получил свежую позицию за 20 секунд. Повторим поиск автоматически.${windowsLocationHelp()}`
        : pagePermission === 'granted'
          ? `Браузер разрешил сайту геолокацию, но источник устройства пока не вернул позицию. Повторим поиск автоматически.${windowsLocationHelp()}`
          : `Источник геолокации пока не вернул позицию. Включите системную геолокацию и повторите попытку.${windowsLocationHelp()}`;
      recordProviderIssue(message);
      scheduleRecovery();
    };

    const options: PositionOptions = { enableHighAccuracy: false, maximumAge: 5000, timeout: 20000 };
    const refreshOptions: PositionOptions = { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 };
    const startWatch = () => {
      stopWatch();
      if (disposed || denied || document.visibilityState !== 'visible' || !navigator.geolocation) return;
      const watchGeneration = generation;
      watchId = navigator.geolocation.watchPosition(
        fix => { if (watchGeneration === generation) fresh(fix); },
        failure => { if (watchGeneration === generation) failed(failure); },
        options,
      );
    };

    const refreshFix = () => {
      const current = latest.current;
      if (disposed || denied || refreshInFlight || !current || document.visibilityState !== 'visible') return;
      if (refreshForFix === current.recorded_at) return;
      refreshForFix = current.recorded_at;
      stopWatch();
      if (!navigator.geolocation) return;
      refreshInFlight = true;
      const refreshGeneration = generation;
      navigator.geolocation.getCurrentPosition(fix => {
        if (disposed || refreshGeneration !== generation) return;
        refreshInFlight = false;
        fresh(fix);
        if (hasFreshFix(latest.current)) startWatch();
      }, failure => {
        if (disposed || refreshGeneration !== generation) return;
        refreshInFlight = false;
        failed(failure);
        if (failure.code !== 1) scheduleRecovery();
      }, refreshOptions);
    };

    latest.current = null;
    setPosition(null);
    setError('');
    setRequesting(true);
    if (!navigator.geolocation || !window.isSecureContext) {
      clearFix('Геолокация недоступна. Откройте приложение через HTTPS или localhost.');
      return () => { disposed = true; };
    }
    startWatch();
    void navigator.permissions?.query({ name: 'geolocation' }).then(value => {
      if (disposed) return;
      permission = value;
      pagePermission = value.state;
      value.onchange = () => {
        if (disposed) return;
        pagePermission = value.state;
        denied = pagePermission === 'denied';
        if (denied) {
          stopWatch();
          clearFix('Браузер запретил этой странице доступ к геолокации. Разрешите местоположение для сайта в настройках браузера.');
        } else {
          lastFailure = null;
          providerIssue = '';
          setError('');
          setRequesting(!hasFreshFix(latest.current));
          startWatch();
        }
      };
      if (value.state === 'denied') value.onchange?.(new Event('change'));
      else if (lastFailure?.code === 1 && value.state === 'granted' && !permissionGrantedRestarted) {
        permissionGrantedRestarted = true;
        denied = false;
        lastFailure = null;
        providerIssue = '';
        setError('');
        setRequesting(!hasFreshFix(latest.current));
        startWatch();
      } else if (lastFailure?.code === 1) failed(lastFailure);
    }).catch(() => { pagePermission = 'unknown'; /* Geolocation callbacks still identify provider errors. */ });

    const expiryTimer = window.setInterval(() => {
      const fix = latest.current;
      if (!fix) return;
      const age = Date.now() - Date.parse(fix.recorded_at);
      if (!hasFreshFix(fix)) {
        clearFix(providerIssue || 'GPS-сигнал потерян. Работа приостановлена до получения актуальной позиции.');
        scheduleRecovery();
      } else if (age >= 20_000 && refreshForFix !== fix.recorded_at) {
        refreshFix();
      }
    }, 1000);
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        setRequesting(!hasFreshFix(latest.current));
        startWatch();
      } else {
        stopWatch();
        if (!hasFreshFix(latest.current)) setRequesting(false);
        // A hidden window (for example, while a native file chooser is open) is not itself GPS loss.
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; stopWatch(); window.clearInterval(expiryTimer); document.removeEventListener('visibilitychange', visibility); if (permission) permission.onchange = null; };
  }, [revision]);

  useEffect(() => {
    if (!requireGps) return;
    setMutationGuard(() => {
      const fix = latest.current;
      return hasFreshFix(fix) && document.visibilityState === 'visible' ? null : 'Для работы инспектора требуется актуальная GPS-позиция. Включите геолокацию.';
    });
    return () => setMutationGuard(null);
  }, [requireGps]);

  const value = useMemo<LocationState>(() => {
    const ready = hasFreshFix(position);
    return { position: ready ? position : null, ready, error, status: ready ? 'ready' : requesting ? 'requesting' : 'unavailable', retry };
  }, [position, error, requesting, retry]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useDeviceLocation() {
  const state = useContext(LocationContext);
  if (!state) throw new Error('LocationProvider is required');
  return state;
}
