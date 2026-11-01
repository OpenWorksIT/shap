# Publishing Shap Pocket

The GitHub Actions workflow (`.github/workflows/apps.yml`) builds on every push to `main`:

- **Android test build**: an `.apk` you can install on an Android phone (artifact
  `shap-pocket-android-test-apk`). Enable *Install unknown apps* for your browser or file manager.
- **iPhone simulator build**: proves the iPhone app builds (artifact `shap-pocket-ios-simulator`).

Store builds run too once these repository secrets are set
(Settings → Secrets and variables → Actions):

## Google Play

1. Make an upload key once, on your PC (keep the file and passwords safe; never commit them):
   ```bash
   keytool -genkeypair -v -keystore shap-pocket-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 shap-pocket-upload.jks   # paste the output into ANDROID_KEYSTORE_BASE64
   ```
2. Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`upload`),
   `ANDROID_KEY_PASSWORD`.
3. The workflow then also produces `shap-pocket-android-store-aab`. In the Play Console:
   create the app (package `za.co.openworks.shappocket`), opt in to Play App Signing, and upload
   the `.aab` to Internal testing first, then Production.

## Apple App Store

1. In App Store Connect: create the app with bundle ID `za.co.openworks.shappocket`
   (register it under Certificates, Identifiers & Profiles first).
2. Users and Access → Integrations → App Store Connect API: make a key with the *App Manager*
   role. Download the `.p8` (once only).
3. Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the file's contents), `APPLE_TEAM_ID`.
4. The workflow then archives, signs (automatic signing through the API key) and uploads each
   build to App Store Connect, where it appears under TestFlight. Submit it for review from there.

TestFlight needs an iPhone to install on; review and release don't.

## Store listing notes

- **Privacy**: "Data not collected". The app has no server; nothing leaves the phone unless the
  person shares it.
- **Source**: link the repository (the AGPL app store exception asks the listing or app to say
  where the source is). Settings → About in the app links it too.
- **Category**: Business (Apple), Business (Google). Price: free.
