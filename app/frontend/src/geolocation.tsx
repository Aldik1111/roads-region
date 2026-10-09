import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setMutationGuard } from './api';

export type DevicePosition = { lat: number; lng: number; accuracy_m: number; recorded_at: string };
type LocationState = {
  position: DevicePosition | null;
  ready: boolean;
  hasFreshPosition: boolean;
  precision: 'precise' | 'approximate' | 'unknown';
  error: string;
  status: 'requesting' | 'ready' | 'reconnecting' | 'unavailable';
  recoveryRemainingSeconds: number;
  showRecoveryNotice: boolean;
  retry: () => void;
};
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
  const [recoveryDeadline, setRecoveryDeadline] = useState<number | null>(null);
  const [recoveryStartedAt, setRecoveryStartedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [revision, setRevision] = useState(0);
  const latest = useRef<DevicePosition | null>(null);
  const recoveryDeadlineRef = useRef<number | null>(null);
  const recoveryStartedAtRef = useRef<number | null>(null);
  const recoveryForFixRef = useRef('');
  const providerIssueRef = useRef('');
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
    let deferredCoarseFix: DevicePosition | null = null;
    let fallbackInFlight = false;
    let permissionGrantedRestarted = false;
    const inRecovery = (at = Date.now()) => recoveryDeadlineRef.current !== null && recoveryDeadlineRef.current > at;
    const beginRecovery = (fix: DevicePosition) => {
      if (recoveryForFixRef.current === fix.recorded_at) return;
      const fixTime = Date.parse(fix.recorded_at);
      const age = Date.now() - fixTime;
      const startedAt = age >= MAX_FIX_AGE_MS ? fixTime + MAX_FIX_AGE_MS : Date.now();
      const deadline = age >= MAX_FIX_AGE_MS ? fixTime + MAX_FIX_AGE_MS + 60_000 : startedAt + 60_000;
      recoveryForFixRef.current = fix.recorded_at;
      recoveryStartedAtRef.current = startedAt;
      recoveryDeadlineRef.current = deadline;
      setRecoveryStartedAt(startedAt);
      setRecoveryDeadline(deadline);
    };
    const clearRecovery = () => {
      recoveryForFixRef.current = '';
      recoveryStartedAtRef.current = null;
      recoveryDeadlineRef.current = null;
      setRecoveryStartedAt(null);
      setRecoveryDeadline(null);
    };

    const stopWatch = () => {
      generation += 1;
      refreshInFlight = false;
      fallbackInFlight = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
      watchId = null;
    };
    const clearFix = (message: string) => {
      providerIssueRef.current = '';
      refreshForFix = '';
      clearRecovery();
      latest.current = null;
      deferredCoarseFix = null;
      fallbackInFlight = false;
      setPosition(null);
      setError(message);
      setRequesting(false);
    };
    const recordProviderIssue = (message: string) => {
      providerIssueRef.current = message;
      // A coarse sample gathered before the loss report cannot repair that loss.
      deferredCoarseFix = null;
      setError(message);
      if (latest.current) {
        beginRecovery(latest.current);
        setPosition(null);
      } else {
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
      if (latest.current && fix.timestamp <= Date.parse(latest.current.recorded_at)) return;
      const age = Date.now() - fix.timestamp;
      if (!Number.isFinite(fix.timestamp) || age > MAX_FIX_AGE_MS || age < -5000 || !Number.isFinite(fix.coords.latitude) || fix.coords.latitude < -90 || fix.coords.latitude > 90 || !Number.isFinite(fix.coords.longitude) || fix.coords.longitude < -180 || fix.coords.longitude > 180 || !Number.isFinite(fix.coords.accuracy) || fix.coords.accuracy < 0) {
        recordProviderIssue('Браузер не получил актуальную позицию. Повторяем поиск GPS.');
        scheduleRecovery();
        return;
      }
      const next = { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy_m: fix.coords.accuracy, recorded_at: new Date(fix.timestamp).toISOString() };
      const previous = latest.current;
      if (!providerIssueRef.current && previous && hasFreshFix(previous) && previous.accuracy_m <= 100 && next.accuracy_m > Math.max(100, previous.accuracy_m * 3)) {
        if (!deferredCoarseFix || next.accuracy_m < deferredCoarseFix.accuracy_m) deferredCoarseFix = next;
        return;
      }
      deferredCoarseFix = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      lastFailure = null;
      providerIssueRef.current = '';
      latest.current = next;
      setPosition(next);
      setError('');
      setRequesting(false);
      clearRecovery();
      setClock(Date.now());
    };

    const failed = (failure: GeolocationPositionError, allowFallback = true) => {
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
        const message = pagePermission === 'granted'
          ? `Разрешение сайта в браузере выдано, но позиция не получена. Возможна блокировка системным источником геолокации или средой встроенного браузера.${windowsLocationHelp()} Закройте диалог выбора файла, если он открыт, либо откройте страницу в отдельной вкладке и нажмите «Повторить определение».`
          : `Запрос геолокации отклонён, но разрешение страницы не подтверждено. Проверьте доступ для сайта в браузере и системную геолокацию.${windowsLocationHelp()} Затем нажмите «Повторить определение».`;
        if (latest.current) {
          recordProviderIssue(message);
          scheduleRecovery();
        } else clearFix(message);
        return;
      }
      const message = failure.code === 3
        ? `Браузер не получил свежую позицию за 20 секунд. Повторим поиск автоматически.${windowsLocationHelp()}`
        : pagePermission === 'granted'
          ? `Браузер разрешил сайту геолокацию, но источник устройства пока не вернул позицию. Повторим поиск автоматически.${windowsLocationHelp()}`
          : `Источник геолокации пока не вернул позицию. Включите системную геолокацию и повторите попытку.${windowsLocationHelp()}`;
      // Revoke live-fix access as soon as the provider reports loss. The fallback is
      // only a way to acquire a replacement; it must not keep the previous fix live.
      recordProviderIssue(message);
      if (allowFallback && (failure.code === 2 || failure.code === 3) && !fallbackInFlight && navigator.geolocation) {
        if (!latest.current) setRequesting(true);
        stopWatch();
        fallbackInFlight = true;
        const fallbackGeneration = generation;
        const fallbackStartedAt = Date.now();
        navigator.geolocation.getCurrentPosition(fix => {
          if (disposed || fallbackGeneration !== generation) return;
          fallbackInFlight = false;
          if (fix.timestamp < fallbackStartedAt) {
            scheduleRecovery();
            return;
          }
          fresh(fix);
          if (hasFreshFix(latest.current)) startWatch();
        }, fallbackFailure => {
          if (disposed || fallbackGeneration !== generation) return;
          fallbackInFlight = false;
          failed(fallbackFailure, false);
        }, { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 });
        return;
      }
      scheduleRecovery();
    };

    const options: PositionOptions = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };
    const refreshOptions: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 };
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

    const preservedFix = latest.current;
    const preservedPosition = preservedFix && hasFreshFix(preservedFix) && !providerIssueRef.current ? preservedFix : null;
    setPosition(preservedPosition);
    setError(providerIssueRef.current);
    setRequesting(!preservedPosition && !inRecovery());
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
          if (!latest.current) {
            providerIssueRef.current = '';
            setError('');
          }
          setRequesting(!hasFreshFix(latest.current) && !inRecovery());
          startWatch();
        }
      };
      if (value.state === 'denied') value.onchange?.(new Event('change'));
      else if (lastFailure?.code === 1 && value.state === 'granted' && !permissionGrantedRestarted) {
        permissionGrantedRestarted = true;
        denied = false;
        lastFailure = null;
        if (!latest.current) {
          providerIssueRef.current = '';
          setError('');
        }
        setRequesting(!hasFreshFix(latest.current) && !inRecovery());
        startWatch();
      } else if (lastFailure?.code === 1) failed(lastFailure);
    }).catch(() => { pagePermission = 'unknown'; /* Geolocation callbacks still identify provider errors. */ });

    const expiryTimer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      const fix = latest.current;
      if (!fix) return;
      if (document.visibilityState === 'visible' && !hasFreshFix(fix) && deferredCoarseFix && hasFreshFix(deferredCoarseFix)) {
        const coarse = deferredCoarseFix;
        deferredCoarseFix = null;
        latest.current = coarse;
        providerIssueRef.current = '';
        setPosition(coarse);
        setError('');
        setRequesting(false);
        clearRecovery();
        setClock(now);
        return;
      }
      const age = Date.now() - Date.parse(fix.recorded_at);
      if (!hasFreshFix(fix)) {
        if (recoveryForFixRef.current !== fix.recorded_at) {
          if (!providerIssueRef.current) {
            providerIssueRef.current = 'GPS-сигнал потерян. Работа приостановлена до получения актуальной позиции.';
            setError(providerIssueRef.current);
          }
          beginRecovery(fix);
          setPosition(null);
        }
        if (!inRecovery(now)) setRequesting(true);
        scheduleRecovery();
      } else if (age >= 20_000 && refreshForFix !== fix.recorded_at) {
        refreshFix();
      }
    }, 1000);
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        let fix = latest.current;
        if (fix && !hasFreshFix(fix) && deferredCoarseFix && hasFreshFix(deferredCoarseFix)) {
          latest.current = deferredCoarseFix;
          setPosition(deferredCoarseFix);
          deferredCoarseFix = null;
          providerIssueRef.current = '';
          setError('');
          clearRecovery();
          fix = latest.current;
        }
        if (fix && !hasFreshFix(fix) && recoveryForFixRef.current !== fix.recorded_at) {
          if (!providerIssueRef.current) {
            providerIssueRef.current = 'GPS-сигнал потерян. Работа приостановлена до получения актуальной позиции.';
            setError(providerIssueRef.current);
          }
          beginRecovery(fix);
          setPosition(null);
        }
        setClock(Date.now());
        setRequesting(!hasFreshFix(latest.current) && !inRecovery());
        startWatch();
      } else {
        stopWatch();
        setClock(Date.now());
        if (!hasFreshFix(latest.current) && !inRecovery()) setRequesting(false);
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
      const liveFix = hasFreshFix(fix) && !providerIssueRef.current;
      const recoveryAccess = recoveryDeadlineRef.current !== null && recoveryDeadlineRef.current > Date.now();
      return (liveFix || recoveryAccess) && document.visibilityState === 'visible' ? null : 'Для работы инспектора требуется актуальная GPS-позиция. Включите геолокацию.';
    });
    return () => setMutationGuard(null);
  }, [requireGps]);

  const value = useMemo<LocationState>(() => {
    const hasFreshPosition = hasFreshFix(position) && !error;
    const precision = hasFreshPosition && position ? (position.accuracy_m <= 100 ? 'precise' : 'approximate') : 'unknown';
    const recoveryRemainingSeconds = recoveryDeadline === null ? 0 : Math.max(0, Math.ceil((recoveryDeadline - clock) / 1000));
    const recovering = recoveryRemainingSeconds > 0;
    const ready = hasFreshPosition || recovering;
    const showRecoveryNotice = recovering && recoveryStartedAt !== null && clock - recoveryStartedAt >= 15_000;
    return {
      position: hasFreshPosition ? position : null,
      ready,
      hasFreshPosition,
      precision,
      error,
      status: hasFreshPosition ? 'ready' : recovering ? 'reconnecting' : recoveryDeadline !== null ? 'unavailable' : requesting ? 'requesting' : 'unavailable',
      recoveryRemainingSeconds,
      showRecoveryNotice,
      retry,
    };
  }, [position, error, requesting, recoveryDeadline, recoveryStartedAt, clock, retry]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useDeviceLocation() {
  const state = useContext(LocationContext);
  if (!state) throw new Error('LocationProvider is required');
  return state;
}
