import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/shap'),
  /** The demo company's database (Settings → Show the demo company). Default: the real one's name + "_demo". */
  DEMO_DATABASE_URL: z.string().default(''),
  /** Set to false to turn the demo company off. */
  DEMO_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Address people use to reach Shap (used in emailed links). */
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  /** Extra origins allowed to call the API with credentials (e.g. a future Capacitor app). */
  CORS_ORIGINS: z.string().default(''),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Sliding session length. A month by default, so a phone on the home screen stays signed in. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(24 * 30),
  WEB_DIST: z.string().default(''),
  /** Settings → System: where the app READS shap-ctl's status (root writes it; mounted read-only
   *  so a compromised app can't plant symlinks for root to follow), and where backups land. */
  CTL_DIR: z.string().default('/ctl'),
  BACKUP_DIR: z.string().default('/backups'),
  /** Where the app WRITES its one request file for shap-ctl (a small, app-writable drop-box, kept
   *  separate from the root-written state dir above). */
  REQUEST_DIR: z.string().default('/ctl-in'),
  GIT_SHA: z.string().default(''),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** 32 random bytes, base64. Encrypts two-factor secrets and signs short-lived tokens. */
  SECRETS_KEY: z.string().default(''),
  /** Everyone must set up an authenticator app. Defaults to on in production. */
  MFA_REQUIRED: z.enum(['true', 'false']).optional(),
  /** Email (sending quotes and invoices). Without SMTP_URL, emails are only logged. */
  // In-app feedback and bug reports are written here as folders (see modules/feedback.ts).
  FEEDBACK_DIR: z.string().default('./feedback'),
  /** This server collects feedback and anonymous usage notes from Shap Pocket and other Shaps (OpenWorks' own). */
  COLLECT: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Where feedback and usage notes go to reach OpenWorks (blank: nowhere). */
  COLLECTOR_URL: z.string().default('https://shap.openworks.co.za/collect'),
  /** OpenWorks' notices to every copy (shared/notice.ts); blank to never look. */
  NOTICE_URL: z.string().default('https://raw.githubusercontent.com/OpenWorksIT/shap/main/notice.json'),
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Shap <no-reply@example.com>'),
  /** Largest upload (tracker import, receipt photo), in megabytes. */
  UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
});

export type Config = Omit<z.infer<typeof envSchema>, 'MFA_REQUIRED'> & {
  mfaRequired: boolean;
  secretsKey: Buffer;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const { MFA_REQUIRED, ...parsed } = envSchema.parse(cleaned);
  let secretsKey: Buffer;
  if (parsed.SECRETS_KEY) {
    secretsKey = Buffer.from(parsed.SECRETS_KEY, 'base64');
    if (secretsKey.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  } else if (parsed.NODE_ENV === 'production') {
    throw new Error('SECRETS_KEY is required in production (generate one with: openssl rand -base64 32)');
  } else {
    secretsKey = Buffer.alloc(32, 7); // development and tests only: a fixed, publicly known key
  }
  return {
    ...parsed,
    mfaRequired: MFA_REQUIRED ? MFA_REQUIRED === 'true' : parsed.NODE_ENV === 'production',
    secretsKey,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
