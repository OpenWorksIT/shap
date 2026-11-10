/** Supplier bills: what you owe and when it's due, and paying them. */
import { useState, type FormEvent } from 'react';
import { formatDate, todayIso } from '@shap/shared';
import { PageHead } from '../components/Shell';
import { Drawer, Empty, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Segmented, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';

interface Bill {
  id: string;
  date: string;
  dueDate: string | null;
  billNumber: string;
  supplier: string;
  description: string;
  amountCents: number;
  paidCents: number;
  owingCents: number;
  projectName: string | null;
  categoryName: string;
  payments: { id: string; date: string; amountCents: number; sourceName: string }[];
}

export default function BillsPage() {
  const { isOwner } = useAuthed();
  const [state, setState] = useState<'open' | 'paid'>('open');
  const { data, error, loading, reload } = useApi<Bill[]>(`/api/bills?state=${state}`);
  const [paying, setPaying] = useState<Bill | null>(null);
  const today = todayIso();
  const owing = (data ?? []).reduce((s, b) => s + Number(b.owingCents), 0);

  return (
    <div className="stack-lg">
      <PageHead
        title="Bills to pay"
        sub={state === 'open' && data ? <>Owed to suppliers: <Money cents={owing} /></> : undefined}
      />
      <p className="small muted">
        A bill is a cost you’ll pay later: add it under Costs and choose <strong>Not paid yet (a bill)</strong> as how it was paid, with the bill’s number and due date.
        It counts as a cost (and VAT) from the bill’s date, and as owed until you pay it here.
      </p>
      <Segmented
        label="Which bills"
        value={state}
        onChange={(v) => setState(v as 'open' | 'paid')}
        options={[
          { value: 'open', label: 'To pay' },
          { value: 'paid', label: 'Paid' },
        ]}
      />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length ? (
        <ul className="panel list">
          {data.map((b) => {
            const due = b.dueDate ?? b.date;
            const late = state === 'open' && due < today;
            return (
              <li key={b.id} className="list-row">
                <div className="grow">
                  <strong>{b.supplier || b.description}</strong>
                  <div className="xs muted">
                    {b.billNumber ? `Bill ${b.billNumber} · ` : ''}
                    {b.description}
                    {b.projectName ? ` · ${b.projectName}` : ''} · {formatDate(b.date)}
                  </div>
                  {state === 'open' ? (
                    <div className={`xs ${late ? 'warn-text' : 'muted'}`}>
                      {b.dueDate ? `${late ? 'Was due' : 'Due'} ${formatDate(b.dueDate)}` : 'No due date'}
                      {Number(b.paidCents) > 0 && <> · <Money cents={b.paidCents} /> paid so far</>}
                    </div>
                  ) : (
                    <div className="xs muted">Paid {b.payments.map((p) => `${formatDate(p.date)} from ${p.sourceName}`).join(', ')}</div>
                  )}
                </div>
                <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
                  <strong>
                    <Money cents={state === 'open' ? b.owingCents : b.amountCents} />
                  </strong>
                  {state === 'open' && isOwner && (
                    <button className="btn small primary" onClick={() => setPaying(b)}>
                      Pay
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="panel">
          <Empty title={state === 'open' ? 'No bills to pay' : 'No paid bills yet'} />
        </div>
      )}
      {state === 'open' && <Credits bills={data ?? []} onDone={reload} />}
      {paying && <PayBill bill={paying} onClose={() => setPaying(null)} onDone={reload} />}
    </div>
  );
}

function PayBill({ bill, onClose, onDone }: { bill: Bill; onClose: () => void; onDone: () => void }) {
  const { ref, settings } = useAuthed();
  const toast = useToast();
  const sources = ref.sources.filter((s) => s.active && !s.role);
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(Number(bill.owingCents));
  const [sourceId, setSourceId] = useState(settings.defaultCostSourceId && sources.some((s) => s.id === settings.defaultCostSourceId) ? settings.defaultCostSourceId : (sources[0]?.id ?? ''));
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/costs/${bill.id}/bill-payments`, { body: { date, amountCents: amount ?? 0, sourceId } });
      toast('Bill paid');
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={`Pay ${bill.supplier || bill.description}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Paid on">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
          <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        </div>
        <Field label="Paid from">
          {(p) => (
            <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">
          <Icon name="check" size={18} />
          Pay <Money cents={amount} />
        </button>
      </form>
    </Drawer>
  );
}

/** Suppliers' credit notes on account not yet taken off a bill: each one taken off one of their bills. */
function Credits({ bills, onDone }: { bills: Bill[]; onDone: () => void }) {
  const { isOwner } = useAuthed();
  const { data, reload } = useApi<Bill[]>('/api/bills?state=credits');
  const [using, setUsing] = useState<Bill | null>(null);
  if (!data?.length) return null;
  return (
    <section className="stack-sm">
      <h2 className="small strong">Credits from suppliers, to take off a bill</h2>
      <ul className="panel list">
        {data.map((c) => (
          <li key={c.id} className="list-row">
            <div className="grow">
              <strong>{c.supplier || c.description}</strong>
              <div className="xs muted">
                {c.billNumber ? `Credit ${c.billNumber} · ` : ''}
                {c.description} · {formatDate(c.date)}
              </div>
            </div>
            <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
              <strong>
                <Money cents={-Number(c.owingCents)} />
              </strong>
              {isOwner && (
                <button className="btn small" onClick={() => setUsing(c)}>
                  Take off a bill
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {using && (
        <UseCredit
          credit={using}
          bills={bills.filter((b) => b.supplier.trim().toLowerCase() === using.supplier.trim().toLowerCase())}
          onClose={() => setUsing(null)}
          onDone={() => (void reload(), onDone())}
        />
      )}
    </section>
  );
}

function UseCredit({ credit, bills, onClose, onDone }: { credit: Bill; bills: Bill[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const left = -Number(credit.owingCents);
  const [billId, setBillId] = useState(bills[0]?.id ?? '');
  const bill = bills.find((b) => b.id === billId);
  const [amount, setAmount] = useState<number | null>(bill ? Math.min(left, Number(bill.owingCents)) : left);
  const [date, setDate] = useState(todayIso());
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/costs/${billId}/bill-credits`, { body: { date, creditId: credit.id, amountCents: amount ?? 0 } });
      toast('Taken off the bill');
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title={`Credit from ${credit.supplier || credit.description}`} sub={<>Left to use: <Money cents={left} /></>} onClose={onClose}>
      {bills.length ? (
        <form className="stack" onSubmit={submit}>
          <Field label="Off the bill">
            {(p) => (
              <select
                {...p}
                className="select"
                value={billId}
                onChange={(e) => {
                  setBillId(e.target.value);
                  const b = bills.find((x) => x.id === e.target.value);
                  if (b) setAmount(Math.min(left, Number(b.owingCents)));
                }}
              >
                {bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.billNumber || b.description} · {formatDate(b.date)} · owing {(Number(b.owingCents) / 100).toFixed(2)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="form-grid">
            <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
            <Field label="On">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
          </div>
          <p className="xs muted">No money moves: the bill is that much less owed, and the credit that much used.</p>
          {error && <div className="banner alert small">{error}</div>}
          <button className="btn primary big block">Take it off</button>
        </form>
      ) : (
        <p className="small muted">There’s no unpaid bill from {credit.supplier || 'this supplier'} to take it off. It stays here until there is one.</p>
      )}
    </Drawer>
  );
}
