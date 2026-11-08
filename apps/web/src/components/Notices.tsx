/**
 * OpenWorks' notices to every copy (shared/notice.ts), across the top of the app. An ordinary
 * notice can be put away; a sunset notice (support ending) stays, so nobody misses it.
 */
import { useEffect, useState } from 'react';
import { formatDate, NOTICE_URL, noticesFor, todayIso, type Notice } from '@shap/shared';
import { APP_VERSION } from '../lib/api';
import { Icon } from './ui';

const SEEN = 'shap.noticesSeen';
const seen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? '[]') as string[];
  } catch {
    return [];
  }
};

const CACHE = 'shap.noticeFile';
/**
 * Shap Pocket has no server: it reads the notice file itself, from Shap's public repository, at
 * most twice a day while online, and remembers the last one it read (shown offline too).
 * Nothing is sent: it's a plain download of one small public file.
 */
async function loadNotices(): Promise<Notice[]> {
  let cached: { at: number; file: unknown } | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE) ?? 'null');
  } catch {
    /* none yet */
  }
  let file = cached?.file ?? null;
  if (!cached || Date.now() - cached.at > 12 * 3_600_000) {
    try {
      const r = await fetch(NOTICE_URL, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const text = await r.text();
        if (text.length < 64 * 1024) {
          file = JSON.parse(text);
          try {
            localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), file }));
          } catch {
            /* fine */
          }
        }
      }
    } catch {
      /* offline: the last one read stands */
    }
  }
  return noticesFor(file, 'pocket', APP_VERSION, todayIso());
}

export function Notices() {
  const [list, setList] = useState<Notice[]>([]);
  const [hidden, setHidden] = useState<string[]>(seen);
  useEffect(() => {
    loadNotices().then(setList, () => undefined);
  }, []);
  const hide = (id: string) => {
    const next = [...hidden, id].slice(-50);
    setHidden(next);
    try {
      localStorage.setItem(SEEN, JSON.stringify(next));
    } catch {
      /* private window: hidden until the page reloads */
    }
  };
  const shown = list.filter((n) => n.level === 'sunset' || !hidden.includes(n.id));
  if (!shown.length) return null;
  return (
    <div className="notices stack" style={{ gap: 8 }}>
      {shown.map((n) => (
        <div key={n.id} className={`banner small notice notice-${n.level}${n.level === 'sunset' || n.level === 'warning' ? ' alert' : ''}`} role={n.level === 'sunset' ? 'alert' : 'status'}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <Icon name={n.level === 'sunset' || n.level === 'warning' ? 'alert' : 'chat'} size={18} />
            <div className="grow stack" style={{ gap: 4 }}>
              <strong>{n.title}</strong>
              {n.supportEndsOn && <span>OpenWorks supports this app until {formatDate(n.supportEndsOn)}. Your books keep working after that, but there will be no more updates (tax tables included).</span>}
              {n.body && <span style={{ whiteSpace: 'pre-line' }}>{n.body}</span>}
              {n.link && (
                <a href={n.link} target="_blank" rel="noreferrer">
                  Read more
                </a>
              )}
            </div>
            {n.level !== 'sunset' && (
              <button type="button" className="btn quiet small" onClick={() => hide(n.id)} aria-label="Put this notice away">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
