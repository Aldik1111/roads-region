package kz.roadsregion.companion;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Device-owned queue; points are removed only after a successful server response. */
final class TrackStore extends SQLiteOpenHelper {
    TrackStore(Context context) { super(context, "gps-queue.db", null, 1); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE points(client_id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL, recorded_at TEXT NOT NULL)");
        db.execSQL("CREATE INDEX points_inspection ON points(inspection_id, recorded_at)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}
    synchronized void add(String inspectionId, Location location) {
        ContentValues values = new ContentValues();
        values.put("client_id", UUID.randomUUID().toString());
        values.put("inspection_id", inspectionId);
        values.put("lat", location.getLatitude());
        values.put("lng", location.getLongitude());
        if (location.hasAccuracy()) values.put("accuracy", location.getAccuracy());
        values.put("recorded_at", Instant.ofEpochMilli(location.getTime()).toString());
        getWritableDatabase().insertOrThrow("points", null, values);
    }
    synchronized Batch pending(String inspectionId) throws Exception {
        List<String> ids = new ArrayList<>();
        JSONArray points = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT client_id,lat,lng,accuracy,recorded_at FROM points WHERE inspection_id=? ORDER BY recorded_at LIMIT 100",
                new String[]{inspectionId})) {
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                ids.add(id);
                JSONObject point = new JSONObject();
                point.put("client_id", id);
                point.put("lat", cursor.getDouble(1));
                point.put("lng", cursor.getDouble(2));
                point.put("accuracy_m", cursor.isNull(3) ? JSONObject.NULL : cursor.getDouble(3));
                point.put("recorded_at", cursor.getString(4));
                points.put(point);
            }
        }
        return new Batch(ids, new JSONObject().put("points", points).toString());
    }
    synchronized void confirm(List<String> ids) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (String id : ids) db.delete("points", "client_id=?", new String[]{id});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized void exportJson(OutputStream output) throws Exception {
        JSONArray points = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT client_id,inspection_id,lat,lng,accuracy,recorded_at FROM points ORDER BY recorded_at", null)) {
            while (cursor.moveToNext()) {
                JSONObject point = new JSONObject();
                point.put("client_id", cursor.getString(0));
                point.put("inspection_id", cursor.getString(1));
                point.put("lat", cursor.getDouble(2));
                point.put("lng", cursor.getDouble(3));
                point.put("accuracy_m", cursor.isNull(4) ? JSONObject.NULL : cursor.getDouble(4));
                point.put("recorded_at", cursor.getString(5));
                points.put(point);
            }
        }
        output.write(new JSONObject().put("format", "roads-region-gps-v1")
                .put("points", points).toString(2).getBytes(StandardCharsets.UTF_8));
    }
    static final class Batch {
        final List<String> ids;
        final String body;
        Batch(List<String> ids, String body) { this.ids = ids; this.body = body; }
    }
}
