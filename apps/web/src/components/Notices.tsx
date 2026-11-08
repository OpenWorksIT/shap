/**
 * OpenWorks' notices to every copy (shared/notice.ts), across the top of the app. An ordinary
 * notice can be put away; a sunset notice (support ending) stays, so nobody misses it.
 */
import { useEffect, useState } from 'react';
import { formatDate, type Notice } from '@shap/shared';
import { api } from '../lib/api';
import { Icon } from './ui';

const SEEN = 'shap.noticesSeen';
const seen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? '[]') as string[];
  } catch {
    return [];
  }
};

/** Where the notices come from: the server (Shap) or the file itself (Shap Pocket). */
export let loadNotices = async (): Promise<Notice[]> => (await api<{ notices: Notice[] }>('/api/notice')).notices;
export const setNoticeLoader = (f: () => Promise<Notice[]>) => (loadNotices = f);

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
