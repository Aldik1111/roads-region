# Android companion for field inspection

This optional Android host opens the existing HTTPS web app, records GPS to a device-local SQLite queue through a location foreground service, and can show a user-supplied raster MBTiles map when mobile data is unavailable. The recorder starts only when the inspector taps **«Начать GPS»** while an inspection is active and Android has granted precise location. An ongoing notification offers **«Остановить»**. The web app exposes the current inspection ID to the host; the native host does not receive a login cookie.

## Build and test

The `Android APK` GitHub Actions workflow builds this project in the cloud. No Android SDK or Android Studio is required on your computer.

1. Open the repository's **Actions → Android APK** and select a successful run for the desired commit.
2. Download the **roads-region-debug-…** artifact, unzip it and copy `roads-region-debug.apk` to the Android phone (Android 8.0 or later).
3. Open the APK on the phone and allow installation from the file manager when prompted. This is a debug build for testing, not a Play Store release. Each clean cloud runner creates its own debug signing key; if Android rejects an update because the signatures differ, export any saved GPS first, then uninstall the old test build before installing the new one. Uninstalling deletes the app's local data.
4. Start the app and enter a trusted HTTPS address reachable from the phone. `localhost` on the phone is not the computer's server. Building the APK does not deploy the web app or configure its address.

The workflow runs on Android changes in pull requests and on `main`, and can be started manually after the workflow reaches the default branch. It installs SDK 35 and Build Tools 35.0.0, uses JDK 17, Gradle 8.11.1 and Android Gradle Plugin 8.9.2, then runs `gradle --no-daemon :app:assembleDebug :app:lintDebug`. It verifies the APK signature, saves a SHA-256 checksum and uploads the APK plus lint reports for 14 days. Actions are pinned by commit and receive read-only repository permissions; no signing or server secrets are needed.

For an optional local build, install these same tools and run the Gradle command from this directory. There is no Gradle wrapper binary in this source tree; Actions installs the pinned Gradle distribution.

## Phone verification

1. Enter the application's HTTPS address, open it and sign in as an inspector. A trusted certificate is required for a local network server. SSL errors are not overridden.
2. Start a route inspection in the web app, tap **«Начать GPS»**, lock the screen, move, then stop from the notification. The native queue persists across process restarts.
3. Tap **«Экспорт GPS»** and choose a destination. The JSON contains inspection ID, coordinates, accuracy and timestamps. This export is a user action; the companion does not automatically send location or credentials to a server.
4. To prepare an offline map, obtain a *licensed raster* MBTiles archive (PNG, JPEG or WebP) from a source that permits offline use. Tap **«Карта без сети»** and select the file. The archive is copied into private app storage. Only tiles in the archive are available without connectivity. Confirm its coverage, zoom levels and required attribution before field use.
5. Test on a physical Android device: screen locked for at least 15 minutes, network lost and restored, battery saver enabled, app process restarted, permissions revoked, photo upload, and map tiles at route intersections. These behaviors have not been device-verified.

The current public OpenStreetMap raster tile endpoint cannot be bulk downloaded or repackaged for offline use. The MBTiles importer deliberately uses a file the operator supplies rather than fetching tiles. See the [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/), [Android location foreground service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types), and [Android background start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

## Remaining integration

The native GPS file is deliberately local. Server synchronization needs a fixed, verified application origin and explicit approval for transferring inspection ID, coordinates, timestamps, accuracy and session credentials. The native WebView also keeps content-URI access disabled; verify photo selection in this host before relying on it for repair evidence. The existing browser app remains the supported photo workflow.
