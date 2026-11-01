# Third-party components

Shap Pocket includes these components, each under its own licence. All are compatible with
distribution under the AGPL-3.0 with the app store exception in NOTICE.

| Component | Licence | Used for |
|---|---|---|
| [PGlite](https://github.com/electric-sql/pglite) (includes [PostgreSQL](https://www.postgresql.org/about/licence/)) | Apache-2.0 (PostgreSQL Licence for PostgreSQL) | The database on the phone |
| [React](https://react.dev), React DOM | MIT | Screens |
| [React Router](https://reactrouter.com) | MIT | Navigation |
| [Capacitor](https://capacitorjs.com) and its App, Filesystem, Preferences, Share, Splash Screen and Status Bar plugins | MIT | The Android and iPhone app |
| [capacitor-biometric-auth](https://github.com/aparajita/capacitor-biometric-auth) | MIT | Face ID / fingerprint / phone PIN lock |
| [Capawesome File Picker](https://github.com/capawesome-team/capacitor-plugins) | MIT | Choosing a backup or a logo |
| [PDFKit](https://pdfkit.org) | MIT | Quote and invoice PDFs |
| [Zod](https://zod.dev) | MIT | Checking what's entered |
| [buffer](https://github.com/feross/buffer) | MIT | Binary data in the app |
| [Atkinson Hyperlegible Next](https://www.brailleinstitute.org/freefont/) (via Fontsource) | SIL Open Font Licence 1.1 | The typeface, in the app and on PDFs |

The full licence texts are in each package under `node_modules/` when you build from source.
