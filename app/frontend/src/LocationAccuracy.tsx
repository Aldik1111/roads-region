import './location-accuracy.css';
import { useDeviceLocation } from './geolocation';

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp)
    : 'время неизвестно';
}

/** Small map companion that reports the browser's measured accuracy without guessing the sensor. */
export function LocationAccuracy() {
  const location = useDeviceLocation();
  const fix = location.position;

  return (
    <section className={`location-accuracy location-accuracy--${location.precision}`} aria-live="polite" aria-label="Точность геопозиции">
      <div className="location-accuracy__copy">
        {fix ? (
          <>
            <strong>{location.precision === 'precise' ? 'Точность позиции' : 'Приблизительная позиция'}: ±{Math.round(fix.accuracy_m)} м</strong>
            <span>По данным браузера · измерено в {formatTime(fix.recorded_at)}</span>
          </>
        ) : (
          <>
            <strong>Точная позиция пока недоступна</strong>
            <span>{location.error || 'Ожидаем измерение геопозиции браузером.'}</span>
          </>
        )}
      </div>
      <button type="button" className="location-accuracy__refresh" onClick={location.retry} aria-label="Обновить геопозицию">Обновить</button>
    </section>
  );
}
