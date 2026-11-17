/**
 * Settings → People → Your accountant: link your accountant's practice to these books, from its own
 * Shap Accountant (packages/shared link.ts, docs/ACCOUNTANT.md "A client on its own Shap"). The
 * owner chooses what the practice may do here and makes a link that works once, for a week; the
 * practice pastes it in. Who from the practice opened the books, and when, is shown here (and in
 * the audit log); unlink whenever you like.
 */
import { useState } from 'react';
import { formatDate, LINK_DAYS, LINK_LEVEL_WORDS, LINK_WHAT_GOES, type Level } from '@shap/shared';
import { ErrorBox, Icon, Loading, useToast } from './ui';
import { usePasswordPrompt } from './PasswordPrompt';
import { useClientHere } from './ClientBanner';
import { useDemoStatus } from './Demo';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';

interface Link {
  id: string;
  level: Level;
  status: 'waiting' | 'linked' | 'expired' | 'unlinked';
  practiceName: string | null;
  createdAt: string;
  codeExpiresAt: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  people: { name: string; lastLoginAt: string | null; active: boolean }[];
}

const day = (at: string | null) => (at ? formatDate(at.slice(0, 10)) : '');

export function YourAccountant() {
  const client = useClientHere();
  const demo = useDemoStatus();
  const toast = useToast();
  const links = useApi<Link[]>(client || demo?.active ? null : '/api/accountant-links');
  const [level, setLevel] = useState<Level>('compile');
  const [made, setMade] = useState<{ link: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, askPassword] = usePasswordPrompt();
  // In a practice's copy of a client's books, or the demo company: nothing to link.
  if (client || demo?.active) return null;

  const make = async () => {
    const password = await askPassword('Your password, to link your accountant', 'Linking lets someone else into your books, so it takes your password.');
    if (password === null) return;
    setBusy('make');
    try {
      setMade(await api<{ link: string; expiresAt: string }>('/api/accountant-links', { body: { level, password } }));
      await links.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t make the link', 'error');
    } finally {
      setBusy(null);
    }
  };
  const unlink = async (l: Link) => {
    if (!confirm(`Unlink ${l.practiceName ?? 'this link'}? Nobody from the practice opens your books after this, and anyone from it in them now is taken out. To link again, make a new link.`)) return;
    setBusy(l.id);
    try {
      await api(`/api/accountant-links/${l.id}/unlink`, { body: {} });
      await links.reload();
      toast('Unlinked');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t unlink', 'error');
    } finally {
      setBusy(null);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Couldn’t copy: select the link and copy it', 'error');
    }
  };

  const shown = links.data?.filter((l) => l.status !== 'expired' || l.linkedAt) ?? [];
  return (
    <section className="stack">
      {prompt}
      <div>
        <h2 className="strong" style={{ fontSize: 'var(--fs-md)', margin: 0 }}>
          Your accountant
        </h2>
        <p className="small muted">If your accountant’s practice uses Shap Accountant, link it here: they open your books from their Shap, as you choose, without a password of their own here.</p>
      </div>
      <div className="panel panel-pad stack">
        <div className="stack-sm">
          {(['compile', 'books'] as const).map((k) => (
            <label key={k} className="check">
              <input type="radio" name="link-level" checked={level === k} onChange={() => setLevel(k)} />
              <span>
                <strong className="small">{LINK_LEVEL_WORDS[k].title}</strong>
                <div className="xs muted">{LINK_LEVEL_WORDS[k].hint}</div>
              </span>
            </label>
          ))}
        </div>
        <p className="xs muted">{LINK_WHAT_GOES}</p>
        <div>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void make()}>
            <Icon name="plus" size={18} />
            {busy === 'make' ? 'Making it…' : 'Make a link for your accountant'}
          </button>
        </div>
        {made && (
          <div className="banner stack-sm" role="status">
            <span className="small">
              Give this link to your accountant: they paste it into their Shap Accountant (Practice, then add a client on their own Shap). It works once, for {LINK_DAYS} days (until {day(made.expiresAt)}), and is shown only now.
            </span>
            <code className="small" style={{ wordBreak: 'break-all' }} data-private>
              {made.link}
            </code>
            <div>
              <button type="button" className="btn small" onClick={() => void copy(made.link)}>
                Copy the link
              </button>
            </div>
          </div>
        )}
      </div>
      <ErrorBox error={links.error} />
      {!links.data ? (
        <Loading />
      ) : (
        shown.length > 0 && (
          <ul className="panel list">
            {shown.map((l) => (
              <li key={l.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="grow">
                  <strong className="small">{l.practiceName ?? 'Waiting for your accountant'}</strong>
                  <div className="xs muted">
                    {LINK_LEVEL_WORDS[l.level].title}.{' '}
                    {l.status === 'waiting'
                      ? `Not used yet: it works until ${day(l.codeExpiresAt)}.`
                      : l.status === 'unlinked'
                        ? `Unlinked ${day(l.revokedAt)}.`
                        : l.status === 'expired'
                          ? 'Never used, and no longer works.'
                          : `Linked since ${day(l.linkedAt)}.`}
                  </div>
                  {l.people.length > 0 && (
                    <div className="xs muted" data-private>
                      From the practice: {l.people.map((p) => `${p.name}${p.lastLoginAt ? `, last in your books ${day(p.lastLoginAt)}` : ''}`).join('; ')}
                    </div>
                  )}
                </span>
                {(l.status === 'linked' || l.status === 'waiting') && (
                  <button type="button" className="btn small quiet" disabled={busy !== null} onClick={() => void unlink(l)}>
                    {busy === l.id ? '…' : 'Unlink'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
