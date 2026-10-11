package kz.roadsregion.companion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.content.res.ColorStateList;
import android.text.InputType;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/** A small native host. The web app remains the UI; Android records GPS after the screen locks. */
public final class MainActivity extends Activity {
    private static final int FILE_PICKER = 21;
    private static final int MAP_PICKER = 22;
    private static final int LOCATION_PERMISSION = 23;
    private static final int NOTIFICATION_PERMISSION = 24;
    private static final int EXPORT_PICKER = 25;
    private WebView web;
    private EditText address;
    private TextView status;
    private ValueCallback<Uri[]> fileResult;
    private OfflineTiles offlineTiles;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        offlineTiles = new OfflineTiles(new File(getFilesDir(), "offline-map.mbtiles"));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Color.rgb(243, 246, 245));
        LinearLayout header = new LinearLayout(this);
        header.setPadding(dp(16), dp(8), dp(16), dp(8));
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("Дороги области");
        title.setTextSize(18);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(Color.rgb(23, 47, 41));
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setPadding(dp(16), 0, dp(16), dp(8));
        Button settings = button("Инструменты", () -> {
            controls.setVisibility(controls.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        });
        header.addView(settings);
        page.addView(header);
        TextView addressLabel = new TextView(this);
        addressLabel.setText("Адрес рабочего пространства");
        addressLabel.setTextSize(14);
        addressLabel.setTextColor(Color.rgb(82, 102, 94));
        controls.addView(addressLabel);
        address = new EditText(this);
        address.setSingleLine(true);
        address.setTextSize(16);
        address.setMinHeight(dp(48));
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setContentDescription("HTTPS-адрес приложения");
        address.setHint("HTTPS-адрес приложения");
        address.setText(getPreferences(0).getString("url", ""));
        controls.addView(address);
        Button open = button("Открыть", () -> openApp());
        Button start = button("Начать GPS", () -> startTracking());
        Button stop = button("Стоп GPS", () -> {
            Intent intent = new Intent(this, TrackService.class);
            intent.setAction(TrackService.STOP);
            startService(intent);
            status.setText("Запись пути остановлена");
        });
        Button map = button("Карта без сети", () -> pickMap());
        Button export = button("Экспорт GPS", () -> exportTrack());
        open.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(18, 110, 96)));
        open.setTextColor(Color.WHITE);
        controls.addView(open, new LinearLayout.LayoutParams(-1, dp(52)));
        controls.addView(actionRow(start, stop));
        controls.addView(actionRow(map, export));
        page.addView(controls);
        if (!address.getText().toString().isEmpty()) controls.setVisibility(View.GONE);
        status = new TextView(this);
        status.setPadding(dp(16), dp(10), dp(16), dp(10));
        status.setTextSize(14);
        status.setTextColor(Color.rgb(49, 78, 63));
        status.setBackgroundColor(Color.rgb(233, 242, 236));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setText(offlineTiles.available() ? "Офлайн-карта подключена" : "Офлайн-карта не загружена");
        page.addView(status);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setGeolocationEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return offlineTiles.intercept(request.getUrl());
            }
            @Override public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript("window.__roadsOfflineMapReady=" + offlineTiles.available() + ";window.dispatchEvent(new Event('roads-offline-map-change'))", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean trusted = sameOrigin(origin, address.getText().toString()) && hasLocationPermission();
                callback.invoke(origin, trusted, false);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams params) {
                if (fileResult != null) fileResult.onReceiveValue(null);
                fileResult = result;
                try { startActivityForResult(params.createIntent(), FILE_PICKER); return true; }
                catch (Exception error) { fileResult = null; return false; }
            }
        });
        page.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(page);
        if (!address.getText().toString().isEmpty()) openApp();
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setMinHeight(dp(48));
        button.setTextColor(Color.rgb(23, 67, 52));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(10));
        background.setStroke(dp(1), Color.rgb(183, 202, 192));
        button.setBackground(background);
        button.setPadding(dp(12), dp(8), dp(12), dp(8));
        button.setOnClickListener(view -> action.run());
        return button;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout actionRow(Button first, Button second) {
        LinearLayout row = new LinearLayout(this);
        row.setPadding(0, dp(8), 0, 0);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, -2, 1);
        a.setMarginEnd(dp(8));
        row.addView(first, a);
        row.addView(second, new LinearLayout.LayoutParams(0, -2, 1));
        return row;
    }
    private boolean sameOrigin(String one, String two) {
        if (one == null || two == null || one.isEmpty() || two.isEmpty()) return false;
        Uri a = Uri.parse(one), b = Uri.parse(two);
        return "https".equalsIgnoreCase(a.getScheme()) && "https".equalsIgnoreCase(b.getScheme())
                && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
                && a.getPort() == b.getPort();
    }
    private void openApp() {
        String url = address.getText().toString().trim();
        Uri uri = Uri.parse(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            status.setText("Нужен действующий HTTPS-адрес приложения");
            return;
        }
        getPreferences(0).edit().putString("url", url).apply();
        if (!hasLocationPermission())
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
        web.loadUrl(url);
    }
    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private void startTracking() {
        if (!hasLocationPermission()) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
        }
        String configured = address.getText().toString().trim();
        if (!sameOrigin(web.getUrl(), configured)) {
            status.setText("Сначала откройте приложение по указанному HTTPS-адресу");
            return;
        }
        // The host reads context from the trusted top-level page; no JavaScript bridge is exposed to third-party frames.
        web.evaluateJavascript("(function(){var x=window.__roadsNativeContext;return x?JSON.stringify(x):''})()", encoded -> {
            try {
                String raw = new JSONArray("[" + encoded + "]").getString(0);
                JSONObject context = new JSONObject(raw);
                String inspectionId = context.optString("inspectionId");
                if (inspectionId.isEmpty()) {
                    status.setText("Сначала начните осмотр маршрута в приложении");
                    return;
                }
                Intent intent = new Intent(this, TrackService.class);
                intent.setAction(TrackService.START);
                intent.putExtra("inspectionId", inspectionId);
                startForegroundService(intent);
                status.setText("GPS сохраняется на устройстве. Можно заблокировать экран.");
            } catch (Exception error) {
                status.setText("Не удалось определить активный осмотр");
            }
        });
    }
    private void pickMap() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, MAP_PICKER);
    }
    private void exportTrack() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.setType("application/json");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_TITLE, "roads-region-gps.json");
        startActivityForResult(intent, EXPORT_PICKER);
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER) {
            if (fileResult != null) {
                fileResult.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileResult = null;
            }
            return;
        }
        if (requestCode == EXPORT_PICKER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                TrackStore tracks = new TrackStore(this);
                try (java.io.OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                    if (output == null) throw new IllegalStateException("Файл не открыт");
                    tracks.exportJson(output);
                    status.setText("GPS-трек сохранён в выбранный файл");
                } catch (Exception error) { status.setText("Ошибка экспорта GPS: " + error.getMessage()); }
                finally { tracks.close(); }
            }
            return;
        }
        if (requestCode != MAP_PICKER || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        File destination = new File(getFilesDir(), "offline-map.mbtiles");
        File temporary = new File(getFilesDir(), "offline-map.tmp");
        try (InputStream input = getContentResolver().openInputStream(data.getData());
             FileOutputStream output = new FileOutputStream(temporary)) {
            if (input == null) throw new IllegalStateException("Файл не открыт");
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            offlineTiles.replace(temporary, destination);
            status.setText("Офлайн-карта подключена");
            web.evaluateJavascript("window.__roadsOfflineMapReady=true;window.dispatchEvent(new Event('roads-offline-map-change'))", null);
            web.reload();
        } catch (Exception error) {
            temporary.delete();
            status.setText("Не удалось открыть MBTiles: " + error.getMessage());
        }
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == LOCATION_PERMISSION) {
            if (hasLocationPermission()) web.reload();
            else Toast.makeText(this, "Для записи пути нужен точный GPS", Toast.LENGTH_LONG).show();
        }
    }
    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        offlineTiles.close();
        web.destroy();
        super.onDestroy();
    }
}
