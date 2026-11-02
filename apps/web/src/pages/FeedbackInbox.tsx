import { useState } from 'react';
import { Drawer, ErrorBox, Field, Loading, useToast } from '../components/ui';
import { api, apiUrl } from '../lib/api';
import { useApi } from '../lib/hooks';


type Kind = 'love' | 'dislike' | 'bug' | 'idea';
interface Item {
  id: string;
  kind: Kind;
  at: string;
  receivedAt: string;
  page: string;
  message: string;
  who: string;
  hasScreenshot: boolean;
  status: 'new' | 'seen' | 'done';
  note: string;
}
interface Report {
  id: string;
  kind: Kind;
  message: string;
  page: string;
  title: string;
  pressedAt: string;
  receivedAt: string;
  who: { name?: string; role?: string; anonymous?: boolean };
  client: Record<string, string | number | boolean>;
  screenshot: { file: string; detailsMasked: boolean } | null;
  trail: { at: string; kind: string; detail: string }[];
  status: Item['status'];
  note: string;
}

const KIND = { love: { label: 'Love this', emoji: '💚', chip: 'p-active' }, dislike: { label: 'Don’t like', emoji: '👎', chip: 'warn' }, bug: { label: 'Bug', emoji: '🐞', chip: 'd-overdue' }, idea: { label: 'Idea', emoji: '💡', chip: 'p-quoted' } } as const;
const dateTime = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Settings → Feedback: everything sent with the feedback button, newest first. */
export function FeedbackInbox() {
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const { data, error, loading, reload } = useApi<Item[]>(`/api/feedback?status=${filter}`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="panel">
      <div className="panel-head spread wrap">
        <div>
          <h2>Feedback</h2>
          <div className="xs muted">From the Feedback button on every screen. Also on the server in the feedback folder, one folder per report.</div>
        </div>
        <div className="seg" role="tablist">
          {(['open', 'done', 'all'] as const).map((f) => (
            <button key={f} role="tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {{ open: 'To look at', done: 'Done', all: 'All' }[f]}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length === 0 ? (
        <p className="empty">{filter === 'open' ? 'Nothing waiting. 🎉' : 'Nothing here yet.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>What</th>
                <th>When</th>
                <th>Who</th>
                <th>Page</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => setOpen(f.id)}>
                  <td className="nowrap">
                    <span className={`chip ${KIND[f.kind].chip}`}>
                      {KIND[f.kind].emoji} {KIND[f.kind].label}
                    </span>
                    {f.hasScreenshot && <span title="Has a screenshot"> 📷</span>}
                  </td>
                  <td className="nowrap small">{dateTime(f.receivedAt)}</td>
                  <td className="small">{f.who}</td>
                  <td className="small mono">{f.page}</td>
                  <td className="small" style={{ maxWidth: 360 }}>
                    <button className="link-button" onClick={() => setOpen(f.id)}>
                      {f.message || <span className="faint">(no message)</span>}
                    </button>
                  </td>
                  <td>
                    <span className={`chip ${f.status === 'done' ? 'd-issued' : f.status === 'seen' ? 'd-draft' : 'warn'}`}>{f.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <FeedbackDrawer
          id={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function FeedbackDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading } = useApi<Report>(`/api/feedback/${id}`);
  const [note, setNote] = useState<string | null>(null);
  const setStatus = async (status: Item['status']) => {
    await api(`/api/feedback/${id}`, { method: 'PATCH', body: { status, note: note ?? data?.note ?? '' } });
    toast(status === 'done' ? 'Marked as done' : 'Saved');
    onChanged();
  };
  return (
    <Drawer
      title={data ? `${KIND[data.kind].emoji} ${KIND[data.kind].label}` : 'Feedback'}
      sub={id}
      onClose={onClose}
      footer={
        data && (
          <>
            <button className="btn primary" onClick={() => void setStatus('done')}>
              Mark done
            </button>
            <button className="btn" onClick={() => void setStatus('seen')}>
              Seen, following up
            </button>
            <button className="btn quiet" onClick={onClose}>
              Close
            </button>
          </>
        )
      }
    >
      {loading && !data ? (
        <Loading />
      ) : error || !data ? (
        <ErrorBox error={error ?? { message: 'Not found' }} />
      ) : (
        <div className="stack-lg">
          <div className="stack">
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.message || <span className="faint">(no message)</span>}</p>
            <dl className="dl">
              <dt>From</dt>
              <dd>{data.who.anonymous ? `From outside: ${(data.who as { app?: string }).app === 'pocket' ? 'Shap Pocket' : 'another Shap'} ${(data.who as { version?: string }).version ?? ''}` : `${data.who.name} · ${data.who.role}`}</dd>
              <dt>Pressed</dt>
              <dd>{dateTime(data.pressedAt)}</dd>
              <dt>Page</dt>
              <dd className="mono">
                {data.page} <span className="muted">· {data.title}</span>
              </dd>
              <dt>Device</dt>
              <dd className="small">
                {String(data.client.viewport ?? '')} · {data.client.standalone ? 'installed app' : 'browser'} · {String(data.client.build ?? '')}
                <div className="xs faint">{String(data.client.userAgent ?? '')}</div>
              </dd>
            </dl>
          </div>
          {data.screenshot && (
            <figure className="feedback-full-shot">
              <a href={apiUrl(`/api/feedback/${id}/screenshot`)} target="_blank" rel="noreferrer">
                <img src={apiUrl(`/api/feedback/${id}/screenshot`)} alt="Screenshot from the report" />
              </a>
              <figcaption className="xs muted">{data.screenshot.detailsMasked ? 'Names and amounts were masked.' : 'Unmasked: may show a client’s details or figures. Handle under POPIA.'}</figcaption>
            </figure>
          )}
          {data.trail.length > 0 && (
            <div className="stack">
              <h3>What led up to it</h3>
              <ol className="trail">
                {data.trail.map((t, i) => (
                  <li key={i} className={`trail-${t.kind}`}>
                    <span className="xs faint mono">{new Date(t.at).toLocaleTimeString('en-ZA')}</span>
                    <span className="trail-kind xs">{t.kind}</span>
                    <span className="small">{t.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <Field label="Follow-up note" hint="Who's looking at it, what was fixed">
            {(p) => <textarea {...p} className="textarea" style={{ minHeight: 70 }} value={note ?? data.note ?? ''} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      )}
    </Drawer>
  );
}
