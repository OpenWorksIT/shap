/**
 * The two things Pocket ever sends to OpenWorks, and only when the person chooses:
 * - feedback and bug reports (from the Feedback button), and
 * - if they said yes at setup, an anonymous note of what kind of business uses Shap and which
 *   parts are switched on. Never names, clients or figures.
 * Both go to the collector on OpenWorks' Shap server. Offline? Feedback waits and goes later.
 */
import { FEATURE_KEYS, featureOn } from '@shap/shared';
import { APP_VERSION } from './api';
import { platform } from './native';
import type { Settings } from './types';

export const COLLECTOR = ((import.meta.env.VITE_COLLECTOR_URL as string | undefined) ?? 'https://shap.openworks.co.za/collect').replace(/\/$/, '');
const SENT = 'shap.usageSent';
const QUEUE = 'shap.feedbackQueue';

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};

async function post(path: string, body: unknown): Promise<void> {
  const r = await fetch(`${COLLECTOR}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(d.error ?? `Not sent (${r.status})`);
  }
}

/** The anonymous usage note, sent when the answers change (and only with consent). */
export async function reportUsage(s: Pick<Settings, 'businessType' | 'industry' | 'features' | 'vatRegistered' | 'tone' | 'usageConsent' | 'installId'>) {
  if (!s.usageConsent) return;
  const body = {
    app: 'pocket',
    version: APP_VERSION,
    installId: s.installId ?? null,
    platform: platform(),
    businessType: s.businessType,
    industry: s.industry,
    features: FEATURE_KEYS.filter((k) => featureOn(s.features, k)),
    vatRegistered: s.vatRegistered,
    tone: s.tone,
  };
  const key = JSON.stringify(body);
  if (store.get(SENT) === key) return;
  try {
    await post('usage', body);
    store.set(SENT, key);
  } catch {
    /* next time */
  }
}

export interface FeedbackReport {
  kind: 'love' | 'dislike' | 'bug';
  message: string;
  page: string;
  title: string;
  at: string;
  screenshot: string | null;
  screenshotMasked: boolean;
  trail: unknown[];
  client: Record<string, unknown>;
}

/** Sends feedback to OpenWorks. If the phone is offline it's kept and sent next time. */
export async function sendFeedback(r: FeedbackReport): Promise<'sent' | 'queued'> {
  const body = { ...r, app: 'pocket', version: APP_VERSION, platform: platform() };
  try {
    await post('feedback', body);
    return 'sent';
  } catch (err) {
    if (navigator.onLine && !/fetch|network|load failed/i.test(String((err as Error).message))) throw err;
    const q = JSON.parse(store.get(QUEUE) ?? '[]') as unknown[];
    // Words travel; pictures are dropped from the queue to keep it small.
    q.push({ ...body, screenshot: null });
    store.set(QUEUE, JSON.stringify(q.slice(-20)));
    return 'queued';
  }
}

/** Sends any feedback written while offline. */
export async function flushFeedback() {
  const q = JSON.parse(store.get(QUEUE) ?? '[]') as unknown[];
  if (!q.length) return;
  const left: unknown[] = [];
  for (const item of q) {
    try {
      await post('feedback', item);
    } catch {
      left.push(item);
    }
  }
  store.set(QUEUE, left.length ? JSON.stringify(left) : null);
}
