import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDate, formatPercent, formatZar } from '@shap/shared';
import { ProjectDrawer } from '../components/ProjectForm';
import { PageHead } from '../components/Shell';
import { Empty, ErrorBox, Icon, Loading, Money, ProjectChip, Segmented } from '../components/ui';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { ProjectRow } from '../lib/types';
import { SpendBar } from './Home';

type Filter = 'open' | 'all' | 'done';

export default function ProjectsPage() {
  const { isOwner, seesMoney } = useAuthed();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('show') as Filter) || 'open';
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useApi<ProjectRow[]>(filter === 'open' ? '/api/projects?status=open' : filter === 'done' ? '/api/projects?status=done' : '/api/projects');
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || (p.clientName ?? '').toLowerCase().includes(s) || String(p.number) === s);
  }, [data, search]);
  const totals = useMemo(
    () => rows.reduce((t, p) => ({ invoiced: t.invoiced + (p.invoicedCents ?? 0), actual: t.actual + (p.actualCents ?? 0), gp: t.gp + (p.invoicedCents ? p.grossProfitCents : 0) }), { invoiced: 0, actual: 0, gp: 0 }),
    [rows],
  );

  return (
    <div className="stack-lg">
      <PageHead
        title="Jobs"
        sub={seesMoney && data ? `${rows.length} jobs · invoiced ${formatZar(totals.invoiced, { cents: false })} · gross profit ${formatZar(totals.gp, { cents: false })}` : undefined}
        actions={
          isOwner && (
            <button className="btn primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} />
              New job
            </button>
          )
        }
      />
      <div className="toolbar">
        <Segmented<Filter>
          label="Which jobs"
          value={filter}
          onChange={(v) => setParams({ show: v }, { replace: true })}
          options={[
            { value: 'open', label: 'On the go' },
            { value: 'done', label: 'Paid & done' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="search">
          <Icon name="search" size={18} />
          <input className="input" placeholder="Search jobs or clients" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : !rows.length ? (
        <div className="panel">
          <Empty title="No jobs here">{filter === 'open' ? 'Jobs that are quoted, on the go or waiting for payment show here.' : 'Try another filter.'}</Empty>
        </div>
      ) : !seesMoney ? (
        <ul className="panel list">
          {rows.map((p) => (
            <li key={p.id}>
              <Link to={`/jobs/${p.id}`} className="list-row">
                <span className="job-no">#{p.number}</span>
                <span className="grow">
                  <strong>{p.name}</strong>
                  {p.clientName && <div className="xs muted">{p.clientName}</div>}
                </span>
                <ProjectChip status={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="panel table-wrap">
          <table className="table jobs-table">
            <thead>
              <tr>
                <th>Job</th>
                <th className="hide-sm">Status</th>
                <th className="num hide-sm">Quoted</th>
                <th className="num">Spent</th>
                <th className="num">Invoiced</th>
                <th className="num hide-md">Received</th>
                <th className="num">Profit</th>
                <th className="num hide-md">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/jobs/${p.id}`} className="strong">
                      <span className="job-no">#{p.number}</span> {p.name}
                    </Link>
                    <div className="xs muted">
                      {p.clientName ?? 'No client'}
                      {p.lastActivity ? ` · ${formatDate(p.lastActivity)}` : ''}
                    </div>
                  </td>
                  <td className="hide-sm">
                    <ProjectChip status={p.status} />
                  </td>
                  <td className="num hide-sm">
                    <Money cents={p.quotedCents || null} whole />
                  </td>
                  <td className="num">
                    <Money cents={p.actualCents} whole />
                    {p.quotedCents > 0 && <SpendBar spent={p.actualCents} budget={p.quotedCents} />}
                  </td>
                  <td className="num">
                    <Money cents={p.invoicedCents || null} whole />
                  </td>
                  <td className="num hide-md">
                    <Money cents={p.receivedCents || null} whole />
                  </td>
                  <td className="num">
                    <Money cents={p.invoicedCents ? p.grossProfitCents : null} whole />
                  </td>
                  <td className={`num hide-md ${p.margin != null && p.margin < 0.15 ? 'warn-text' : ''}`}>{formatPercent(p.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <ProjectDrawer onClose={() => setAdding(false)} />}
    </div>
  );
}
