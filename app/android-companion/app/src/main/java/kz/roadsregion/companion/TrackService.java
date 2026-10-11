package kz.roadsregion.companion;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;


/** User-started GPS recorder. All data remains on the device until the user exports it. */
public final class TrackService extends Service implements LocationListener {
    static final String START = "kz.roadsregion.companion.START";
    static final String STOP = "kz.roadsregion.companion.STOP";
    private static final String CHANNEL = "road_inspection";
    private LocationManager manager;
    private TrackStore store;
    private String inspectionId;

    @Override public void onCreate() {
        super.onCreate();
        store = new TrackStore(this);
        manager = (LocationManager) getSystemService(LOCATION_SERVICE);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            getSharedPreferences("tracking", MODE_PRIVATE).edit().clear().apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && START.equals(intent.getAction())) {
            inspectionId = intent.getStringExtra("inspectionId");
            if (inspectionId != null)
                getSharedPreferences("tracking", MODE_PRIVATE).edit().putString("inspectionId", inspectionId).apply();
        } else {
            inspectionId = getSharedPreferences("tracking", MODE_PRIVATE).getString("inspectionId", null);
        }
        if (inspectionId == null || inspectionId.isEmpty()
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Запись пути инспектора", NotificationManager.IMPORTANCE_LOW));
        Intent stop = new Intent(this, TrackService.class).setAction(STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Дороги области: осмотр идёт")
                .setContentText("GPS сохраняется на устройстве при заблокированном экране")
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Остановить", stopAction).build())
                .build();
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(41, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(41, notification);
        manager.removeUpdates(this);
        boolean subscribed = false;
        try {
            if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 10, this, Looper.getMainLooper());
                subscribed = true;
            }
            if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 20, this, Looper.getMainLooper());
                subscribed = true;
            }
        } catch (SecurityException error) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!subscribed) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }
    @Override public void onLocationChanged(Location location) {
        if (inspectionId == null || location == null) return;
        if (!Double.isFinite(location.getLatitude()) || !Double.isFinite(location.getLongitude())) return;
        store.add(inspectionId, location);
    }
    @Override public void onDestroy() {
        manager.removeUpdates(this);
        store.close();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
