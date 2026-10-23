import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate } from '@shap/shared';
import { ErrorBox, Icon, Loading, useToast } from '../components/ui';
import { usePasswordPrompt } from '../components/PasswordPrompt';
import { api, ApiError, apiUrl } from '../lib/api';

interface Check {
  at: string;
  error: string;
  current: { sha: string; version: string; date: string };
  latest: { sha: string; version: string; date: string };
  behind: number;
  changes: { sha: string; subject: string }[];
  changelog: string;
}
interface SystemInfo {
  version: string;
  gitSha: string | null;
  managed: boolean;
  pending: string | null;
  status: {
    check?: Check | null;
    checking?: { at: string } | null;
    updating?: { at: string; step: string } | null;
    lastUpdate?: { at: string; ok: boolean; from?: string; to?: string; version?: string; message?: string; log?: string } | null;
    backup?: { at: string; kind: string; ok: boolean } | null;
    backingUp?: { at: string } | null;
  } | null;
  backups: { name: string; sizeBytes: number; at: string }[];
  pulledByPc: string | null;
}

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${formatDate(d.toISOString().slice(0, 10))} ${d.toTimeString().slice(0, 5)}`;
};
const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

/** The newest changelog sections, down to the version that's running. */
function newSections(changelog: string, running: string): string {
  const parts = changelog.split(/\n(?=## )/).filter((p) => p.startsWith('## '));
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith(`## ${running}`) || p.startsWith(`## [${running}]`)) break;
    out.push(p.trim());
  }
  return out.join('\n\n');
}

/**
 * Settings → System: the version, updates and backups. The work happens on the server
 * (shap-ctl); this page asks for it and shows how it went.
 */
export function SystemSettings() {
  const toast = useToast();
  const [passwordPrompt, askPassword] = usePasswordPrompt();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const [asked, setAsked] = useState<null | { action: string; at: number; lastUpdateAt: string | null }>(null);
  const timer = useRef<number | null>(null);

  const load = async () => {
    try {
      const r = await api<SystemInfo>('/api/system');
      setInfo(r);
      setError(null);
      setOffline(false);
      return r;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'network') setOffline(true);
      else setError(err as ApiError);
      return null;
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const busy = Boolean(info && (info.pending || info.status?.checking || info.status?.updating || info.status?.backingUp));
  // Keep looking while the server works (and while Shap restarts during an update).
  useEffect(() => {
    if (!busy && !asked && !offline) return;
    timer.current = window.setInterval(async () => {
      const r = await load();
      if (!r || !asked) return;
      const lu = r.status?.lastUpdate;
      if (asked.action === 'update' && lu && lu.at !== asked.lastUpdateAt && !r.status?.updating) {
        setAsked(null);
        if (lu.ok) {
          toast(`Updated to ${lu.version ?? 'the latest version'}`);
          // The page itself changed: load the new one.
          window.setTimeout(() => window.location.reload(), 800);
        } else toast('The update didn’t finish. Details are below.', 'error');
      } else if (asked.action !== 'update' && !r.pending && !r.status?.checking && !r.status?.backingUp && Date.now() - asked.at > 2500) {
        setAsked(null);
        if (asked.action === 'backup') toast(r.status?.backup?.ok ? 'Backup made' : 'The backup failed', r.status?.backup?.ok ? undefined : 'error');
      }
    }, 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [busy, asked, offline]);

  const ask = async (action: 'check' | 'update' | 'backup') => {
    if (action === 'update' && !confirm('Shap backs up, fetches the new version and restarts. It’s unavailable for a few minutes. Update now?')) return;
    try {
      await api('/api/system/request', { body: { action } });
      setAsked({ action, at: Date.now(), lastUpdateAt: info?.status?.lastUpdate?.at ?? null });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t ask the server', 'error');
    }
  };

  if (!info) return error ? <ErrorBox error={error} onRetry={load} /> : <Loading />;
  const s = info.status ?? {};
  const check = s.check ?? null;
  const updating = s.updating || (asked?.action === 'update' && (offline || info.pending === 'update'));
  const news = check && check.behind > 0 ? newSections(check.changelog, info.version) : '';

  return (
    <div className="stack-lg narrow-wide">
      {passwordPrompt}
      <section className="panel panel-pad stack">
        <h3>Version</h3>
        <p className="row wrap" style={{ gap: 8 }}>
          <span className="big-number">Shap {info.version}</span>
          {info.gitSha && <span className="chip">{info.gitSha}</span>}
        </p>

        {!info.managed ? (
          <div className="banner small">
            Updating and backing up from here isn’t set up on this server yet. Once, on the server, run:
            <pre className="code-block">sudo /opt/shap/deploy/vps/ctl/install.sh</pre>
          </div>
        ) : updating ? (
          <div className="banner signal">
            <strong>Updating…</strong> {offline ? 'Shap is restarting; this page carries on when it’s back.' : (s.updating?.step ?? 'Starting')}
          </div>
        ) : check && check.behind > 0 ? (
          <div className="stack">
            <div className="banner signal">
              <strong>Version {check.latest.version || check.latest.sha.slice(0, 7)} is available</strong> ({check.behind} change{check.behind === 1 ? '' : 's'} since
              yours).
            </div>
            {news ? (
              <Changelog text={news} />
            ) : (
              <ul className="small">
                {check.changes.slice(0, 12).map((c) => (
                  <li key={c.sha}>{c.subject}</li>
                ))}
              </ul>
            )}
            <button className="btn primary big" onClick={() => void ask('update')} disabled={busy}>
              <Icon name="download" size={18} />
              Update now
            </button>
            <p className="xs muted">A backup is made first. If anything goes wrong, Shap stays on the version it’s on.</p>
          </div>
        ) : (
          <p className="small">
            <span className="ok-text">Up to date.</span> {check ? `Checked ${when(check.at)}.` : ''} Shap checks every night.
          </p>
        )}
        {check?.error && <div className="banner alert small">Couldn’t reach GitHub at the last check: {check.error}</div>}
        {info.managed && !updating && (
          <div className="row wrap">
            <button className="btn" onClick={() => void ask('check')} disabled={busy}>
              {s.checking || (asked?.action === 'check' && info.pending) ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        )}
        {s.lastUpdate && (
          <details>
            <summary className="small">
              Last update {when(s.lastUpdate.at)}: {s.lastUpdate.ok ? `to ${s.lastUpdate.version ?? s.lastUpdate.to}` : 'didn’t finish'}
            </summary>
            {s.lastUpdate.message && <p className="small">{s.lastUpdate.message}</p>}
            {s.lastUpdate.log && <pre className="code-block">{s.lastUpdate.log}</pre>}
          </details>
        )}
      </section>

      <section className="panel panel-pad stack">
        <div className="spread">
          <h3>Backups</h3>
          {info.managed && (
            <button className="btn small" onClick={() => void ask('backup')} disabled={busy}>
              {s.backingUp || (asked?.action === 'backup' && info.pending) ? 'Backing up…' : 'Back up now'}
            </button>
          )}
        </div>
        <p className="small">
          A full copy of everything (jobs, invoices, the books, slips and logos) every night at 02:30, and before every update. The server keeps the last two
          weeks.{' '}
          {info.pulledByPc ? (
            <>
              <strong>Last copied to your PC {when(info.pulledByPc)}.</strong>
            </>
          ) : (
            <strong>Not copied to your PC yet</strong>
          )}
          {!info.pulledByPc && ': set up the copy once on the PC (docs/backups.md).'}
        </p>
        {s.backup && !s.backup.ok && <div className="banner alert small">The last backup ({when(s.backup.at)}) failed. Try “Back up now”; if it fails again, check the server.</div>}
        {info.backups.length ? (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {info.backups.slice(0, 20).map((b) => (
                  <tr key={b.name}>
                    <td className="small">
                      {when(b.at)}
                      <div className="xs muted">{b.name}</div>
                    </td>
                    <td className="num small">{size(b.sizeBytes)}</td>
                    <td className="num">
                      <button
                        className="btn quiet small"
                        onClick={async () => {
                          const password = await askPassword('Download a backup', 'A backup is everything in your books. Enter your password to download it.');
                          if (!password) return;
                          try {
                            const r = await api<{ url: string }>(`/api/system/backups/${encodeURIComponent(b.name)}/link`, { body: { password } });
                            window.location.assign(apiUrl(r.url));
                          } catch (err) {
                            toast(err instanceof ApiError ? err.message : 'Couldn’t download it', 'error');
                          }
                        }}
                      >
                        <Icon name="download" size={14} />
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">No backups on the server yet.</p>
        )}
      </section>
    </div>
  );
}

/** The changelog's few markdown habits (## headings, - bullets, **bold**) as plain HTML. */
function Changelog({ text }: { text: string }) {
  const bold = (line: string) => line.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length) blocks.push(<ul key={blocks.length}>{items.map((t, i) => <li key={i}>{bold(t)}</li>)}</ul>);
    items = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (items.length && line && !line.startsWith('#')) items[items.length - 1] += ` ${line}`;
    else {
      flush();
      if (line.startsWith('## ')) blocks.push(<strong key={blocks.length}>{line.slice(3)}</strong>);
      else if (line && !line.startsWith('#')) blocks.push(<p key={blocks.length}>{bold(line)}</p>);
    }
  }
  flush();
  return <div className="changelog">{blocks}</div>;
}
