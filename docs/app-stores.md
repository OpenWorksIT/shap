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
2. Users and Access → Integrations → App Store Connect API: make a team key with the *Admin*
   role (signing in the cloud makes the distribution certificate, which App Manager keys can't).
   Download the `.p8` (once only).
3. Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the file's contents), `APPLE_TEAM_ID`, and
   `IOS_CERT_KEY`: the RSA key of the App Store distribution certificate, the same one LineGuard and
   Steady use (signing as they do, with Codemagic's CLI tools: no registered iPhone, no cloud signing).
4. The workflow then archives, signs (automatic signing through the API key) and uploads each
   build to App Store Connect, where it appears under TestFlight. Submit it for review from there.

TestFlight needs an iPhone to install on; review and release don't.

## Store listing notes

- **Privacy policy URL**: https://www.openworks.co.za/shap/privacy/ (info page:
  https://www.openworks.co.za/shap/).
- **Privacy / data safety**: the books never leave the phone unless the person shares or backs
  them up. Two things can go to OpenWorks, both by the person's choice, encrypted in transit:
  - Feedback they send (message, the screens and taps leading up to it, device details,
    optionally a screenshot with names and amounts hidden): Play "App activity → Other
    user-generated content" and "App info and performance → Diagnostics"; Apple "User Content →
    Other User Content" and "Diagnostics". Optional, not linked to identity, not for tracking.
  - The anonymous usage note if they said yes at setup (kind of business, switched-on parts,
    a random install number): Play "App activity → Other actions"; Apple "Usage Data → Product
    Interaction". Optional, not linked to identity, not for tracking.
  - No ads, no advertising ID, no account.
- **Notifications**: none (from 1.1.0). The backup reminder is on Home, inside the app, and the
  manifest removes POST_NOTIFICATIONS and SCHEDULE_EXACT_ALARM.
- **Updates** (from 1.4.0): the app asks Google Play whether a newer version is out (the Play
  in-app updates API, through `@capawesome/capacitor-app-update`), shows Play's own update sheet
  at most every three days, and keeps a reminder on Home until it's installed. It works only for
  installs from Play (internal testing tracks included), adds no permission and sends nothing to
  OpenWorks. On iPhone, Update opens the App Store.
- **Donations**: the "Buy us a coffee" link is hidden in the store apps (Google Play allows
  donation links only for registered non-profits; Apple wants in-app purchase for tips). The
  apps still invite ideas through the feedback button.
- **Source**: link the repository (the AGPL app store exception asks the listing or app to say
  where the source is). Settings → About in the app links it too.
- **Category**: Business (Apple), Business (Google). Price: free.
