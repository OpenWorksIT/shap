import { useEffect, useState, type FormEvent } from 'react';
import { formatZar, todayIso } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';
import { useWorkers } from './Pickers';
import { Field, MoneyInput, useToast } from './ui';

/** Money handed to a worker. Shows what they're owed (or owe you) so you pay the right amount. */
export function PayForm({ workerId: fixed, onSaved }: { workerId?: string; onSaved?: () => void }) {
  const { ref, settings } = useAuthed();
  const toast = useToast();
  const workers = useWorkers();
  const [workerId, setWorkerId] = useState(fixed ?? '');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [sourceId, setSourceId] = useState(settings.defaultWageSourceId ?? ref.sources[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const worker = (workers.data ?? []).find((w) => w.id === workerId);

  useEffect(() => {
    if (fixed) setWorkerId(fixed);
  }, [fixed]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!workerId) return setError('Choose the worker');
    if (!amount) return setError('Enter the amount');
    setBusy(true);
    try {
      await api('/api/wage-payments', { body: { workerId, amountCents: amount, date, sourceId, note } });
      toast(`Paid ${worker?.name ?? ''} ${formatZar(amount)}`);
      setAmount(null);
      setNote('');
      void workers.reload();
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      {!fixed && (
        <Field label="Worker">
          {(p) => (
            <select {...p} className="select" value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">Choose…</option>
              {(workers.data ?? []).filter((w) => w.active).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {worker && (
        <div className={`banner small ${worker.balanceCents > 0 ? 'signal' : ''}`}>
          {worker.balanceCents > 0 ? (
            <>
              You owe {worker.name} <strong>{formatZar(worker.balanceCents)}</strong>.{' '}
              <button type="button" className="link" onClick={() => setAmount(worker.balanceCents)}>
                Pay that
              </button>
            </>
          ) : worker.balanceCents < 0 ? (
            <>
              {worker.name} has had <strong>{formatZar(-worker.balanceCents)}</strong> more than earned (an advance).
            </>
          ) : (
            <>{worker.name} is paid up to date.</>
          )}
        </div>
      )}
      <div className="form-grid">
        <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Paid from">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {ref.sources.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="Note (optional)">{(p) => <input {...p} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Friday pay, advance" />}</Field>
      {error && <div className="banner alert small">{error}</div>}
      <button className="btn primary big block" disabled={busy}>
        {busy ? 'Saving…' : 'Record payment'}
      </button>
    </form>
  );
}
