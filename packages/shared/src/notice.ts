/**
 * Notices from OpenWorks to every copy of Shap and Shap Pocket: a short message in the app, for
 * the rare things everyone must hear (an important update, a change in support, or, one day,
 * that support is ending and from when). It's a small file in Shap's public repository
 * (NOTICE_URL), so it stays reachable even if OpenWorks' own servers don't, and any copy can
 * read it without an account. See SUNSET.md.
 *
 * The file is treated as untrusted text: plain words only, links only to OpenWorks or GitHub.
 */
export const NOTICE_URL = 'https://raw.githubusercontent.com/OpenWorksIT/shap/main/notice.json';

export type NoticeLevel = 'info' | 'update' | 'warning' | 'sunset';
export interface Notice {
  id: string;
  level: NoticeLevel;
  title: string;
  body: string;
  link?: string;
  /** The last day OpenWorks supports the app (a sunset notice). */
  supportEndsOn?: string;
}

const LINK_HOSTS = ['openworks.co.za', 'www.openworks.co.za', 'github.com', 'shap.openworks.co.za'];
const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const words = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const newer = (a: string, b: string) => {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/**
 * The notices in the file that apply to this app, at this version, today. Each may say which
 * apps it's for, from and until when, and (for "please update") only below which version.
 */
export function noticesFor(file: unknown, app: 'shap' | 'pocket', version: string, today: string): Notice[] {
  const list = (file as { notices?: unknown })?.notices;
  if (!Array.isArray(list)) return [];
  const out: Notice[] = [];
  for (const raw of list.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const id = words(n.id, 60);
    const title = words(n.title, 120);
    const body = words(n.body, 1200);
    if (!id || !title) continue;
    const apps = Array.isArray(n.apps) ? n.apps.filter((a) => typeof a === 'string') : ['shap', 'pocket'];
    if (!apps.includes(app)) continue;
    const from = iso(n.from);
    const until = iso(n.until);
    if ((from && today < from) || (until && today > until)) continue;
    const below = typeof n.belowVersion === 'string' ? n.belowVersion : '';
    if (below && !newer(below, version)) continue;
    const level: NoticeLevel = n.level === 'sunset' || n.level === 'warning' || n.level === 'update' ? n.level : 'info';
    let link: string | undefined;
    try {
      const u = new URL(String(n.link ?? ''));
      if (u.protocol === 'https:' && LINK_HOSTS.includes(u.hostname)) link = u.toString();
    } catch {
      /* no link */
    }
    out.push({ id, level, title, body, link, supportEndsOn: iso(n.supportEndsOn) });
  }
  // A sunset notice first.
  return out.sort((a, b) => Number(b.level === 'sunset') - Number(a.level === 'sunset'));
}
