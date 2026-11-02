/**
 * SARS travel logbook: business trips through the tax year (March to February), the odometer at
 * the start and end, and the business share. Download it for your accountant or SARS.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { financialYear, formatDate, todayIso, addMonths } from '@shap/shared';
import { ProjectSelect } from '../components/Pickers';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { FileButton } from '../components/Files';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface Trip {
  id: string;
  date: string;
  fromPlace: string;
  toPlace: string;
  reason: string;
  km: number;
  business: boolean;
  projectId: string | null;
  projectName: string | null;
}
interface Logbook {
  year: { start: string; end: string; label: string };
  vehicle: string;
  odometerStart: number | null;
  odometerEnd: number | null;
  totalKm: number | null;
  loggedKm: number;
  businessKm: number;
  businessShare: number | null;
  trips: Trip[];
}

const km = (n: number | null) => (n == null ? '–' : `${Math.round(n * 10) / 10} km`);

export default function LogbookPage() {
  const { has, isOwner } = useAuthed();
  const toast = useToast();
  const thisYear = financialYear(todayIso(), 2);
  const years = [0, 1, 2].map((n) => financialYear(addMonths(thisYear.start, -12 * n), 2));
  const [yearEnd, setYearEnd] = useState(thisYear.end);
  const { data, error, loading, reload } = useApi<Logbook>(`/api/logbook?yearEnd=${yearEnd}`);
  const [trip, setTrip] = useState<Trip | 'new' | null>(null);
  const [odo, setOdo] = useState({ vehicle: '', odometerStart: '', odometerEnd: '' });
  useEffect(() => {
    if (data) setOdo({ vehicle: data.vehicle, odometerStart: data.odometerStart == null ? '' : String(data.odometerStart), odometerEnd: data.odometerEnd == null ? '' : String(data.odometerEnd) });
  }, [data]);

  const saveOdo = async () => {
    try {
      await api(`/api/logbook/${yearEnd}`, {
        method: 'PUT',
        body: { vehicle: odo.vehicle, odometerStart: odo.odometerStart ? Number(odo.odometerStart) : null, odometerEnd: odo.odometerEnd ? Number(odo.odometerEnd) : null },
      });
      toast('Saved');
      await reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHead
        title="Travel logbook"
        sub="SARS wants every business trip (date, where, why, kilometres) and your odometer at the start and end of the tax year."
        actions={
          <>
            <FileButton path={`/api/logbook?yearEnd=${yearEnd}&format=csv`} title="Travel logbook">
              <Icon name="download" size={18} />
              Download
            </FileButton>
            {isOwner && (
              <button className="btn primary" onClick={() => setTrip('new')}>
                <Icon name="plus" size={18} />
                Add a trip
              </button>
            )}
          </>
        }
      />
      <div className="toolbar">
        <select className="select auto" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} aria-label="Tax year">
          {years.map((y) => (
            <option key={y.end} value={y.end}>
              Tax year {y.label} (1 Mar to {formatDate(y.end)})
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          <section className="panel panel-pad stack">
            <div className="kpis">
              <div>
                <div className="xs muted">Business</div>
                <strong>{km(data.businessKm)}</strong>
              </div>
              <div>
                <div className="xs muted">Total on the odometer</div>
                <strong>{km(data.totalKm)}</strong>
              </div>
              <div>
                <div className="xs muted">Business share</div>
                <strong>{data.businessShare == null ? '–' : `${Math.round(data.businessShare * 1000) / 10}%`}</strong>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Vehicle">{(p) => <input {...p} className="input" value={odo.vehicle} onChange={(e) => setOdo({ ...odo, vehicle: e.target.value })} placeholder="e.g. Toyota Hilux CA 123-456" />}</Field>
              <Field label="Odometer on 1 March">
                {(p) => <input {...p} className="input" inputMode="decimal" value={odo.odometerStart} onChange={(e) => setOdo({ ...odo, odometerStart: e.target.value.replace(/[^\d.]/g, '') })} />}
              </Field>
              <Field label={`Odometer at the end of February`}>
                {(p) => <input {...p} className="input" inputMode="decimal" value={odo.odometerEnd} onChange={(e) => setOdo({ ...odo, odometerEnd: e.target.value.replace(/[^\d.]/g, '') })} />}
              </Field>
            </div>
            {isOwner && (
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void saveOdo()}>
                Save odometer readings
              </button>
            )}
          </section>
          {data.trips.length ? (
            <ul className="panel list">
              {[...data.trips].reverse().map((t) => (
                <li key={t.id} className={`list-row ${isOwner ? 'clickable' : ''}`} onClick={() => isOwner && setTrip(t)}>
                  <div className="grow">
                    <strong>
                      {t.fromPlace || '…'} → {t.toPlace || '…'}
                    </strong>
                    <div className="xs muted">
                      {formatDate(t.date)} · {t.reason || 'No reason given'}
                      {t.projectName ? ` · ${t.projectName}` : ''}
                    </div>
                  </div>
                  <span className={t.business ? 'strong' : 'muted'}>
                    {km(t.km)}
                    {t.business ? '' : ' (private)'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="panel">
              <Empty title="No trips yet">Add each business trip: where from, where to, and why (who you saw, what for).</Empty>
            </div>
          )}
        </>
      ) : null}
      {trip && <TripDrawer trip={trip === 'new' ? null : trip} jobs={has('jobs')} onClose={() => setTrip(null)} onSaved={reload} />}
    </div>
  );
}

function TripDrawer({ trip, jobs, onClose, onSaved }: { trip: Trip | null; jobs: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const places = useApi<string[]>('/api/trips/places');
  const [f, setF] = useState({
    date: trip?.date ?? todayIso(),
    fromPlace: trip?.fromPlace ?? '',
    toPlace: trip?.toPlace ?? '',
    reason: trip?.reason ?? '',
    km: trip ? String(trip.km) : '',
    business: trip?.business ?? true,
    projectId: trip?.projectId ?? null,
  });
  const [error, setError] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, km: Number(f.km || 0) };
      if (trip) await api(`/api/trips/${trip.id}`, { method: 'PUT', body });
      else await api('/api/trips', { body });
      toast('Trip saved');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  const remove = async () => {
    if (!trip || !confirm('Delete this trip?')) return;
    await api(`/api/trips/${trip.id}`, { method: 'DELETE' });
    onSaved();
    onClose();
  };
  return (
    <Drawer title={trip ? 'Trip' : 'Add a trip'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <datalist id="trip-places">
          {(places.data ?? []).map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <div className="form-grid">
          <Field label="Date">{(p) => <input {...p} className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required />}</Field>
          <Field label="Kilometres">{(p) => <input {...p} className="input" inputMode="decimal" value={f.km} onChange={(e) => set('km', e.target.value.replace(/[^\d.]/g, ''))} required />}</Field>
        </div>
        <div className="form-grid">
          <Field label="From">{(p) => <input {...p} className="input" list="trip-places" value={f.fromPlace} onChange={(e) => set('fromPlace', e.target.value)} placeholder="e.g. Walmer" />}</Field>
          <Field label="To">{(p) => <input {...p} className="input" list="trip-places" value={f.toPlace} onChange={(e) => set('toPlace', e.target.value)} placeholder="e.g. Summerstrand" />}</Field>
        </div>
        <Field label="Why" hint="Who you saw and what for: SARS asks.">{(p) => <input {...p} className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Quote at Bayview Guesthouse" />}</Field>
        {jobs && <Field label="Job (optional)">{(p) => <ProjectSelect {...p} value={f.projectId} onChange={(v) => set('projectId', v)} emptyLabel="Not for a job" />}</Field>}
        <label className="check">
          <input type="checkbox" checked={!f.business} onChange={(e) => set('business', !e.target.checked)} />
          <span>A private trip (not business)</span>
        </label>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Save</button>
        {trip && (
          <button type="button" className="btn quiet block" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </form>
    </Drawer>
  );
}
