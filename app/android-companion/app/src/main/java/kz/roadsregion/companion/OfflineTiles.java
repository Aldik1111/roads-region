package kz.roadsregion.companion;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Reads a user-supplied, licensed raster MBTiles archive. Never prefetches OSM's public tiles. */
final class OfflineTiles {
    private File file;
    private SQLiteDatabase database;
    private String mime = "image/png";
    OfflineTiles(File file) { this.file = file; open(); }
    synchronized boolean available() { return database != null; }
    private void open() {
        if (!file.exists()) return;
        try {
            database = SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            try (Cursor check = database.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'", null)) {
                if (!check.moveToFirst()) throw new IllegalArgumentException("Нет таблицы tiles");
            }
            mime = rasterMime(database);
        } catch (Exception error) {
            if (database != null) database.close();
            database = null;
        }
    }
    synchronized void replace(File source, File destination) throws IOException {
        SQLiteDatabase candidate = SQLiteDatabase.openDatabase(source.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
        try (Cursor check = candidate.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles'", null)) {
            if (!check.moveToFirst()) throw new IOException("Это не MBTiles с растровыми тайлами");
            rasterMime(candidate);
        } finally { candidate.close(); }
        close();
        Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        file = destination;
        open();
        if (database == null) throw new IOException("Не удалось подключить архив");
    }
    synchronized WebResourceResponse intercept(Uri uri) {
        if (database == null || uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return null;
        String host = uri.getHost();
        if (host == null || !(host.equals("tile.openstreetmap.org") || host.endsWith(".tile.openstreetmap.org"))) return null;
        String[] parts = uri.getPath().split("/");
        if (parts.length != 4 || !parts[3].endsWith(".png")) return null;
        try {
            int z = Integer.parseInt(parts[1]);
            int x = Integer.parseInt(parts[2]);
            int y = Integer.parseInt(parts[3].substring(0, parts[3].length() - 4));
            if (z < 0 || z > 22 || x < 0 || y < 0) return null;
            long tmsY = (1L << z) - 1 - y;
            if (tmsY < 0 || tmsY > Integer.MAX_VALUE) return null;
            try (Cursor result = database.rawQuery(
                    "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1",
                    new String[]{String.valueOf(z), String.valueOf(x), String.valueOf(tmsY)})) {
                if (!result.moveToFirst()) return null;
                return new WebResourceResponse(mime, null, new ByteArrayInputStream(result.getBlob(0)));
            }
        } catch (Exception ignored) { return null; }
    }
    synchronized void close() {
        if (database != null) database.close();
        database = null;
    }
    private static String rasterMime(SQLiteDatabase db) {
        try (Cursor metadata = db.rawQuery("SELECT value FROM metadata WHERE name='format' LIMIT 1", null)) {
            if (!metadata.moveToFirst()) throw new IllegalArgumentException("В MBTiles не указан формат");
            String format = metadata.getString(0);
            if ("png".equalsIgnoreCase(format)) return "image/png";
            if ("jpg".equalsIgnoreCase(format) || "jpeg".equalsIgnoreCase(format)) return "image/jpeg";
            if ("webp".equalsIgnoreCase(format)) return "image/webp";
            throw new IllegalArgumentException("Требуется растровый MBTiles (PNG, JPEG или WebP)");
        }
    }
}
