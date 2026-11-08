import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { DeleteRecord } from '../components/DeleteRecord';
import { PdfPreview } from '../components/PdfPreview';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  addDays,
  formatDate,
  formatZar,
  industryProfile,
  LINE_CATEGORIES,
  LINE_CATEGORIES_OFFERED,
  lineLabel,
  lineTotal,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  todayIso,
  vatOn,
  type LineCategory,
  type PaymentMethod,
} from '@shap/shared';
import { BrandSelect, ProjectSelect, useHasBrands } from '../components/Pickers';
import { ClientDrawer } from './Clients';
import { PageHead } from '../components/Shell';
import { DocChip, Drawer, ErrorBox, Field, Icon, Loading, Money, MoneyInput, Segmented, useToast } from '../components/ui';
import { api, ApiError, apiBlob } from '../lib/api';
import { openFile, shareFile } from '../lib/native';
import { sendReminder } from '../lib/reminders';
import { hoursLabel } from '../lib/time';
import { useApi } from '../lib/hooks';
import { useAuthed } from '../lib/session';
import type { ClientRow, DocDetail, DocLine, ProjectRow } from '../lib/types';

interface Draft {
  projectId: string | null;
  clientId: string | null;
  brandId: string | null;
  issueDate: string;
  dueDate: string | null;
  title: string;
  notes: string;
  terms: string;
  number: string;
  lines: DraftLine[];
  depositMode: 'none' | 'percent' | 'amount';
  depositPercent: string;
  depositCents: number | null;
  depositShowBalance: boolean;
  payLink: string;
  creditReason: string;
}

type Kind = 'quote' | 'invoice' | 'credit_note';

/** A line being edited: quantity as typed, and no price until one is entered (no 0 to delete first). */
type DraftLine = Omit<DocLine, 'qty' | 'unitPriceCents'> & { key: string; qty: string; unitPriceCents: number | null };
const toQty = (q: string) => Number(String(q).replace(',', '.')) || 0;
const draftLine = (l: DocLine): DraftLine => ({ ...l, qty: String(l.qty), key: key() });

let keySeq = 0;
const key = () => `l${++keySeq}`;

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const [params] = useSearchParams();
  const kind = (params.get('kind') as 'quote' | 'invoice') || 'invoice';
  const existing = useApi<DocDetail>(isNew ? null : `/api/documents/${id}`, { fresh: true });
  if (!isNew && !existing.data) return existing.error ? <ErrorBox error={existing.error} onRetry={existing.reload} /> : <Loading />;
  const proforma = existing.data ? Boolean(existing.data.doc.proforma) : kind === 'quote' && params.get('proforma') === '1';
  return <Editor key={id ?? 'new'} detail={existing.data} kind={existing.data?.doc.kind ?? kind} proforma={proforma} projectFromUrl={params.get('project')} reload={existing.reload} />;
}

function Editor({ detail, kind, proforma, projectFromUrl, reload }: { detail: DocDetail | null; kind: Kind; proforma: boolean; projectFromUrl: string | null; reload: () => Promise<void> }) {
  const { settings, isOwner, has } = useAuthed();
  const toast = useToast();
  const navigate = useNavigate();
  const clients = useApi<ClientRow[]>(isOwner ? '/api/clients' : null);
  const hasBrands = useHasBrands();
  const doc = detail?.doc;
  const credit = kind === 'credit_note';
  // Issued credit notes are fixed (void and make a new one); everything else stays editable.
  const editable = isOwner && doc?.status !== 'void' && !(credit && doc?.status === 'issued');
  const billLike = kind === 'invoice' || proforma;
  const label = kind === 'invoice' ? 'Invoice' : credit ? 'Credit note' : proforma ? 'Pro-forma' : 'Quote';
  const listKind = credit ? 'credit_note' : kind;
  const today = todayIso();

  const initial = (): Draft => ({
    projectId: doc?.projectId ?? projectFromUrl ?? null,
    clientId: doc?.clientId ?? null,
    brandId: doc?.brandId ?? null,
    issueDate: doc?.issueDate ?? today,
    dueDate: doc ? doc.dueDate : credit ? null : addDays(today, billLike ? settings.paymentDays : settings.quoteValidDays),
    title: doc?.title ?? '',
    notes: doc?.notes ?? '',
    terms: doc?.terms ?? (credit ? '' : billLike ? settings.invoiceTerms : settings.quoteTerms),
    number: doc?.number ?? '',
    lines: (detail?.lines ?? []).map(draftLine),
    depositMode: doc?.depositBp ? 'percent' : doc?.depositCents ? 'amount' : 'none',
    depositPercent: doc?.depositBp ? String(doc.depositBp / 100) : '50',
    depositCents: doc?.depositCents ?? null,
    depositShowBalance: doc?.depositShowBalance ?? true,
    payLink: doc?.payLink ?? '',
    creditReason: doc?.creditReason ?? '',
  });
  const [d, setD] = useState<Draft>(initial);
  const [dirty, setDirty] = useState(!detail);
  // When this screen last loaded the document. A save is refused if someone else changed it since.
  const [seen, setSeen] = useState(doc?.updatedAt);
  // Fresh from the server (after a save, or someone else's change): show it, unless there are
  // unsaved edits here, which are kept (the save then explains what happened).
  useEffect(() => {
    if (!detail || dirty) return;
    setD(initial());
    setSeen(detail.doc.updatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<null | 'pay' | 'charge' | 'writeoff' | 'client' | 'time'>(null);
  const [preview, setPreview] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const profile = useMemo(() => industryProfile(settings.industry), [settings.industry]);
  const L = (c: LineCategory) => lineLabel(settings.industry, c);
  const usual = useApi<UsualLine[]>(isOwner && editable ? '/api/documents/usual-lines' : null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => (setD((x) => ({ ...x, [k]: v })), setDirty(true));

  // A new document for a job: take the job's client and name.
  const project = useApi<{ project: ProjectRow; summary: ProjectRow }>(d.projectId && isOwner ? `/api/projects/${d.projectId}` : null);
  useEffect(() => {
    const p = project.data?.project;
    if (!p) return;
    setD((x) => ({ ...x, clientId: x.clientId ?? p.clientId, brandId: x.brandId ?? p.brandId, title: x.title || p.name }));
  }, [project.data]);

  const vatRate = doc ? doc.vatRateBp : settings.vatRegistered ? settings.vatRateBp : 0;
  const subtotal = d.lines.reduce((s, l) => s + lineTotal(toQty(l.qty), l.unitPriceCents ?? 0), 0);
  const vat = vatOn(subtotal, vatRate);
  const total = subtotal + vat;
  const paid = doc?.paidCents ?? 0;
  const writtenOff = doc?.writtenOffOn ? doc.writtenOffCents : 0;
  const deposit = Math.min(
    total,
    d.depositMode === 'percent' ? Math.round((total * Math.min(100, toQty(d.depositPercent))) / 100) : d.depositMode === 'amount' ? (d.depositCents ?? 0) : 0,
  );
  const depositOutstanding = kind === 'invoice' && deposit > 0 && paid < deposit;
  const byCat = useMemo(() => LINE_CATEGORIES.map((c) => [c, d.lines.filter((l) => l.category === c).reduce((s, l) => s + lineTotal(toQty(l.qty), l.unitPriceCents ?? 0), 0)] as const).filter(([, v]) => v), [d.lines]);

  const addLine = (category: LineCategory) =>
    set('lines', [...d.lines, { key: key(), category, description: '', qty: '1', unit: '', unitPriceCents: null }]);
  /** One tap: a usual item, with last time's price when there is one. */
  const addItem = (it: { description: string; category: LineCategory; unit?: string; unitPriceCents?: number | null }) => {
    // An empty line waiting at the end is filled rather than left behind.
    const blank = d.lines.find((l) => !l.description.trim() && !l.unitPriceCents);
    const line = { category: it.category, description: it.description, qty: '1', unit: it.unit ?? '', unitPriceCents: it.unitPriceCents ?? null };
    set('lines', blank ? d.lines.map((l) => (l.key === blank.key ? { ...l, ...line } : l)) : [...d.lines, { key: key(), ...line }]);
  };
  const updLine = (k: string, patch: Partial<DraftLine>) => set('lines', d.lines.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const moveLine = (k: string, dir: -1 | 1) => {
    const i = d.lines.findIndex((l) => l.key === k);
    const j = i + dir;
    if (j < 0 || j >= d.lines.length) return;
    const lines = [...d.lines];
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
    set('lines', lines);
  };

  const body = () => ({
    expectUpdatedAt: seen ? new Date(seen).toISOString() : undefined,
    projectId: d.projectId,
    clientId: d.clientId,
    brandId: d.brandId,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    title: d.title,
    notes: d.notes,
    terms: d.terms,
    number: d.number || undefined,
    lines: d.lines.filter((l) => l.description.trim() || l.unitPriceCents).map((l) => ({ category: l.category, description: l.description.trim() || L(l.category), qty: toQty(l.qty), unit: l.unit, unitPriceCents: l.unitPriceCents ?? 0 })),
    depositBp: d.depositMode === 'percent' && toQty(d.depositPercent) > 0 ? Math.min(10000, Math.round(toQty(d.depositPercent) * 100)) : null,
    depositCents: d.depositMode === 'amount' && d.depositCents ? d.depositCents : null,
    depositShowBalance: d.depositShowBalance,
    payLink: d.payLink,
    proforma,
    creditReason: d.creditReason,
  });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      if (!doc) {
        const r = await api<{ id: string; number: string }>('/api/documents', { body: { kind, ...body() } });
        toast(`${label} ${r.number} saved as a draft`);
        navigate(`/documents/${r.id}`, { replace: true });
      } else {
        await api(`/api/documents/${doc.id}`, { method: 'PUT', body: body() });
        setDirty(false);
        toast('Saved');
        await reload();
      }
    });
  };
  const action = (path: string, payload: unknown, msg: string, method: 'POST' | 'DELETE' = 'POST') =>
    run(async () => {
      if (dirty && doc) await api(`/api/documents/${doc.id}`, { method: 'PUT', body: body() });
      await api(`/api/documents/${doc!.id}/${path}`, method === 'DELETE' ? { method } : { body: payload });
      setDirty(false);
      toast(msg);
      await reload();
    });

  /** A new job built from this quote or invoice: its heading (or client) as the name, its lines as the estimate. */
  const createJob = () =>
    run(async () => {
      const clientName = (clients.data ?? []).find((c) => c.id === d.clientId)?.name ?? '';
      const name = prompt('Name for the new job', d.title || clientName)?.trim();
      if (!name) return;
      const est = (cat: LineCategory) => Math.max(0, d.lines.filter((l) => l.category === cat).reduce((s, l) => s + lineTotal(toQty(l.qty), l.unitPriceCents ?? 0), 0));
      const p = await api<{ id: string; number: number }>('/api/projects', {
        body: {
          name,
          clientId: d.clientId,
          brandId: d.brandId,
          status: kind === 'quote' ? 'quoted' : 'active',
          startDate: kind === 'invoice' ? d.issueDate : null,
          estLabourCents: est('labour'),
          estMaterialsCents: est('materials'),
          estDemoCents: est('demo'),
        },
      });
      setD((x) => ({ ...x, projectId: p.id, title: x.title || name }));
      if (doc) {
        await api(`/api/documents/${doc.id}`, { method: 'PUT', body: { ...body(), projectId: p.id, title: d.title || name } });
        setDirty(false);
        await reload();
      } else setDirty(true);
      toast(`Job #${p.number} ${name} created${doc ? ' and linked' : ''}`);
    });

  const from = settings.tradingName || settings.companyName;
  const loadPdf = useCallback(async () => (await apiBlob(`/api/documents/${doc!.id}/pdf`)).blob, [doc?.id, doc?.updatedAt]);
  /** The PDF to the share sheet (WhatsApp, Gmail, Outlook…), with a short note for the message. */
  const share = () =>
    run(async () => {
  const loadPdf = useCallback(async () => (await apiBlob(`/api/documents/${doc!.id}/pdf`)).blob, [doc?.id, doc?.updatedAt]);
      if (dirty) await save();
      const { blob, filename } = await apiBlob(`/api/documents/${doc!.id}/pdf`);
      const what = `${kind === 'invoice' ? (settings.vatRegistered ? 'tax invoice' : 'invoice') : credit ? 'credit note' : proforma ? 'pro-forma invoice' : 'quote'} ${doc!.number}`;
      const link = billLike ? d.payLink || settings.payLink : '';
      const shap = billLike && has('payshap') && settings.payshapId ? settings.payshapId : '';
      const extra = credit && doc!.creditedInvoiceNumber ? ` It credits invoice ${doc!.creditedInvoiceNumber}${d.creditReason ? ` (${d.creditReason})` : ''}.` : '';
      const text = `Good day${doc!.clientName ? ` ${doc!.clientName}` : ''},\n\nPlease find ${what} attached.${extra}${shap ? `\n\nPay instantly with PayShap to ${shap} (reference ${doc!.number}).` : ''}${link ? `\n\nPay by card: ${link}` : ''}\n\nKind regards,\n${from}`;
      const how = await shareFile(blob, filename, `${label} ${doc!.number}`, text);
      if (how === 'downloaded') toast('PDF saved');
      if (how !== 'cancelled') await api(`/api/documents/${doc!.id}/shared`, { body: {} }).then(() => reload());
    });
  const view = () =>
    run(async () => {
      if (dirty) await save();
      const { blob, filename } = await apiBlob(`/api/documents/${doc!.id}/pdf`);
      await openFile(blob, filename);
    });

  return (
    <div className="stack-lg">
      <PageHead
        back={{ to: `/documents?kind=${listKind}`, label: kind === 'invoice' ? 'Invoices' : credit ? 'Credit notes' : proforma && !has('quotes') ? 'Pro-formas' : 'Quotes' }}
        title={doc ? `${label} ${doc.number}` : `New ${label.toLowerCase()}`}
        sub={
          doc && (
            <span className="row wrap" style={{ gap: 8 }}>
              <DocChip status={doc.status} paymentState={doc.paymentState} />
              {hasBrands && doc.brandName && <span className="chip">{doc.brandName}</span>}
              {doc.clientName && <span>{doc.clientName}</span>}
              {doc.projectId && (
                <Link to={`/jobs/${doc.projectId}`}>
                  Job #{doc.projectNumber} {doc.projectName}
                </Link>
              )}
              {doc.sourceQuoteNumber && <span className="muted">from quote {doc.sourceQuoteNumber}</span>}
              {credit && doc.creditedInvoiceId && (
                <Link to={`/documents/${doc.creditedInvoiceId}`}>For invoice {doc.creditedInvoiceNumber}</Link>
              )}
            </span>
          )
        }
        actions={
          doc && (
            <>
              <button className="btn primary" onClick={() => void share()} disabled={busy}>
                <Icon name="share" size={18} />
                Send
              </button>
              <button
                className="btn quiet"
                onClick={() =>
                  void run(async () => {
                    if (dirty) await save();
                    setPreview(true);
                  })
                }
                disabled={busy}
              >
                <Icon name="print" size={18} />
                Preview
              </button>
            </>
          )
        }
      />

      {doc?.status === 'void' && <div className="banner alert">Voided: {doc.voidReason}</div>}
      {doc?.kind === 'invoice' && doc.status === 'issued' && editable && (
        <div className="banner small">
          Issued invoices can still be changed. The books update for the invoice date; send the client the new PDF.
          {has('creditNotes') ? ' Once the client has it, a credit note is the tidy way to take something off.' : ''}
        </div>
      )}
      {credit && doc?.status === 'draft' && (
        <div className="banner small">
          Change the lines to what’s being taken back (a line, part of one, or a discount). When you issue it, it comes off invoice {doc.creditedInvoiceNumber}’s balance
          {vatRate > 0 ? ' and the VAT on it comes off your next VAT return' : ''}. If the invoice was already paid, refund the client and record the refund as a cost.
        </div>
      )}
      {credit && doc?.status === 'issued' && <div className="banner ok small">Issued: {formatZar(total)} taken off invoice {doc.creditedInvoiceNumber}. To change it, void it and make a new one.</div>}
      {proforma && !doc && <div className="banner small">A pro-forma asks to be paid before the work starts. It isn’t a tax invoice and isn’t in the books: once paid, turn it into an invoice and record the payment there.</div>}

      <form className="doc-layout" onSubmit={save}>
        <div className="stack-lg">
          <section className="panel panel-pad stack">
            <div className="form-grid">
              {has('jobs') && !credit && <Field label="Job">
                {(p) => (
                  <ProjectSelect
                    {...p}
                    value={d.projectId}
                    onChange={(v) => (set('projectId', v), v && (set('clientId', null), set('brandId', null)))}
                    emptyLabel="Not for a job"
                    createLabel={editable ? `New job from this ${kind}` : undefined}
                    onCreate={editable ? () => void createJob() : undefined}
                  />
                )}
              </Field>}
              <Field label="Client">
                {(p) => (
                  <select
                    {...p}
                    className="select"
                    value={d.clientId ?? ''}
                    onChange={(e) => (e.target.value === '+new' ? setDrawer('client') : set('clientId', e.target.value || null))}
                    disabled={!editable || credit}
                  >
                    <option value="">{project.data?.project.clientName ? `From the job (${project.data.project.clientName})` : 'No name yet (add it later)'}</option>
                    {editable && <option value="+new">+ New client…</option>}
                    {(clients.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {hasBrands && (
                <Field label="Trading as">{(p) => <BrandSelect {...p} value={d.brandId} onChange={(v) => set('brandId', v)} emptyLabel="The usual for this job or client" disabled={!editable} />}</Field>
              )}
            </div>
            <div className="form-grid">
              <Field label={`${label} date`}>{(p) => <input {...p} className="input" type="date" value={d.issueDate} onChange={(e) => set('issueDate', e.target.value)} disabled={!editable} />}</Field>
              {!credit && <Field label={billLike ? 'Due' : 'Valid until'}>{(p) => <input {...p} className="input" type="date" value={d.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value || null)} disabled={!editable} />}</Field>}
              <Field label="Number" hint={doc ? undefined : 'Leave blank for the next number'}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    value={d.number}
                    onChange={(e) => set('number', e.target.value)}
                    placeholder={
                      kind === 'invoice'
                        ? `${settings.invoicePrefix}${String(settings.invoiceNext).padStart(settings.invoicePad, '0')}`
                        : credit
                          ? `${settings.creditPrefix}${String(settings.creditNext).padStart(settings.creditPad, '0')}`
                          : proforma
                            ? `${settings.proformaPrefix}${String(settings.proformaNext).padStart(settings.quotePad, '0')}`
                            : `${settings.quotePrefix}${String(settings.quoteNext).padStart(settings.quotePad, '0')}`
                    }
                    disabled={!editable}
                  />
                )}
              </Field>
            </div>
            {credit && (
              <Field label="Why" hint="Printed on the credit note">
                {(p) => <input {...p} className="input" value={d.creditReason} onChange={(e) => set('creditReason', e.target.value)} placeholder="e.g. Returned part, discount agreed, charged twice" disabled={!editable} />}
              </Field>
            )}
            <Field label="Heading" hint="Shown as “For” on the PDF">
              {(p) => <input {...p} className="input" value={d.title} onChange={(e) => set('title', e.target.value)} placeholder={profile.heading} disabled={!editable} />}
            </Field>
          </section>

          <section className="panel">
            <div className="panel-head spread">
              <strong>Items and services</strong>
              <span className="row wrap" style={{ gap: 6 }}>
                {editable && !credit && has('timeTracker') && (
                  <button type="button" className="btn small" onClick={() => setDrawer('time')}>
                    <Icon name="clock" size={14} />
                    Add time…
                  </button>
                )}
                {editable && !credit && d.projectId && (
                  <button type="button" className="btn small" onClick={() => setDrawer('charge')}>
                    Charge job costs…
                  </button>
                )}
              </span>
            </div>
            <div className="lines">
              {d.lines.map((l, i) => (
                <div key={l.key} className="line">
                  <select className="select line-cat" value={l.category} onChange={(e) => updLine(l.key, { category: e.target.value as LineCategory })} aria-label="Kind of item" disabled={!editable}>
                    {LINE_CATEGORIES.filter((c) => LINE_CATEGORIES_OFFERED.includes(c) || c === l.category).map((c) => (
                      <option key={c} value={c}>
                        {L(c)}
                      </option>
                    ))}
                  </select>
                  <textarea className="textarea line-desc" rows={1} value={l.description} onChange={(e) => updLine(l.key, { description: e.target.value })} placeholder={i === 0 ? `e.g. ${profile.items[0]?.d ?? 'What you did'}` : 'Description'} aria-label="Description" disabled={!editable} />
                  <div className="line-nums">
                    <input className="input line-qty" inputMode="decimal" value={l.qty} onChange={(e) => updLine(l.key, { qty: e.target.value.replace(/[^\d.,]/g, '') })} placeholder="1" aria-label="Quantity" disabled={!editable} />
                    <input className="input line-unit" value={l.unit} onChange={(e) => updLine(l.key, { unit: e.target.value })} list="unit-list" placeholder="unit" aria-label="Unit" disabled={!editable} />
                    <div className="line-price">
                      <MoneyInput value={l.unitPriceCents} onChange={(c) => updLine(l.key, { unitPriceCents: c })} placeholder="Price" allowNegative aria-label="Unit price" />
                    </div>
                    <span className="line-total">
                      <Money cents={lineTotal(toQty(l.qty), l.unitPriceCents ?? 0)} />
                    </span>
                    {editable && (
                      <span className="line-tools">
                        <button type="button" className="btn quiet small" onClick={() => moveLine(l.key, -1)} disabled={i === 0} aria-label="Move up">
                          ↑
                        </button>
                        <button type="button" className="btn quiet small" onClick={() => set('lines', d.lines.filter((x) => x.key !== l.key))} aria-label="Remove item">
                          <Icon name="trash" size={16} />
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {!d.lines.length && <p className="small muted panel-pad">Nothing on it yet: add what you’re charging for below.</p>}
            </div>
            <datalist id="unit-list">
              {profile.units.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            {editable && (
              <div className="panel-pad stack">
                <div className="row wrap">
                  {LINE_CATEGORIES_OFFERED.map((c) => (
                    <button key={c} type="button" className="btn small" onClick={() => addLine(c)}>
                      <Icon name="plus" size={14} />
                      {L(c)}
                    </button>
                  ))}
                </div>
                <QuickAdd usual={usual.data ?? []} profile={profile} onAdd={addItem} lines={d.lines} />
              </div>
            )}
          </section>

          <section className="panel panel-pad stack">
            <Field label="Notes (on the PDF)">{(p) => <textarea {...p} className="textarea" rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} disabled={!editable} />}</Field>
            {billLike && (
              <Field label="Card payment link (optional)" hint={settings.payLink ? 'Blank uses your usual link from Settings. Make one for this amount in the Yoco app and paste it here.' : 'Paste a Yoco (or SnapScan) payment link: it’s printed on the invoice and added to your message.'}>
                {(p) => <input {...p} className="input" type="url" inputMode="url" value={d.payLink} onChange={(e) => set('payLink', e.target.value)} placeholder={settings.payLink || 'https://pay.yoco.com/…'} disabled={!editable} />}
              </Field>
            )}
            <Field label="Terms">{(p) => <textarea {...p} className="textarea" rows={3} value={d.terms} onChange={(e) => set('terms', e.target.value)} disabled={!editable} />}</Field>
          </section>
        </div>

        <aside className="stack doc-side">
          <section className="panel panel-pad stack">
            <dl className="totals">
              {byCat.length > 1 &&
                byCat.map(([c, v]) => (
                  <div key={c} className="sub">
                    <dt>{L(c)}</dt>
                    <dd>
                      <Money cents={v} />
                    </dd>
                  </div>
                ))}
              <div>
                <dt>Subtotal</dt>
                <dd>
                  <Money cents={subtotal} />
                </dd>
              </div>
              {vatRate > 0 && (
                <div>
                  <dt>VAT {vatRate / 100}%</dt>
                  <dd>
                    <Money cents={vat} />
                  </dd>
                </div>
              )}
              <div className="grand">
                <dt>Total</dt>
                <dd>
                  <Money cents={total} />
                </dd>
              </div>
              {!credit && deposit > 0 && (kind === 'quote' || depositOutstanding) && (
                <>
                  <div>
                    <dt>
                      Deposit{d.depositMode === 'percent' ? ` (${toQty(d.depositPercent)}%)` : ''} {kind === 'quote' ? 'to confirm' : 'due now'}
                    </dt>
                    <dd>
                      <Money cents={deposit} />
                    </dd>
                  </div>
                  {(kind === 'quote' || d.depositShowBalance) && (
                    <div className="sub">
                      <dt>{kind === 'quote' ? 'Balance on completion' : 'Balance after the deposit'}</dt>
                      <dd>
                        <Money cents={total - deposit} />
                      </dd>
                    </div>
                  )}
                </>
              )}
              {kind === 'invoice' && (paid !== 0 || writtenOff !== 0) && (
                <>
                  {paid !== 0 && (
                    <div>
                      <dt>{(detail?.receipts ?? []).some((r) => r.method === 'credit') ? 'Paid and credited' : 'Paid'}</dt>
                      <dd>
                        <Money cents={-paid} />
                      </dd>
                    </div>
                  )}
                  {writtenOff !== 0 && (
                    <div>
                      <dt>Written off</dt>
                      <dd>
                        <Money cents={-writtenOff} />
                      </dd>
                    </div>
                  )}
                  <div className="grand">
                    <dt>Balance</dt>
                    <dd>
                      <Money cents={total - paid - writtenOff} />
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {editable && !writtenOff && !credit && (
              <div className="fieldset stack" style={{ gap: 8 }}>
                <span className="label">Deposit</span>
                <Segmented
                  label="Deposit"
                  value={d.depositMode}
                  onChange={(v) => set('depositMode', v)}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'percent', label: '%' },
                    { value: 'amount', label: 'Amount' },
                  ]}
                />
                {d.depositMode === 'percent' && (
                  <div className="row">
                    <input className="input" inputMode="decimal" value={d.depositPercent} onChange={(e) => set('depositPercent', e.target.value.replace(/[^\d.,]/g, ''))} aria-label="Deposit percentage" style={{ maxWidth: 90 }} />
                    <span className="small muted">% of the total</span>
                  </div>
                )}
                {d.depositMode === 'amount' && <MoneyInput value={d.depositCents} onChange={(c) => set('depositCents', c)} placeholder="Amount" aria-label="Deposit amount" />}
                {kind === 'invoice' && d.depositMode !== 'none' && (
                  <label className="check small">
                    <input type="checkbox" checked={d.depositShowBalance} onChange={(e) => set('depositShowBalance', e.target.checked)} />
                    Show the balance after the deposit
                  </label>
                )}
                {kind === 'invoice' && d.depositMode !== 'none' && (
                  <span className="xs muted">The PDF asks for the deposit until payments reach it, then for the balance.</span>
                )}
              </div>
            )}
            {doc?.writtenOffOn && (
              <div className="banner alert small">
                <strong>Delinquent.</strong> {formatZar(doc.writtenOffCents)} written off on {formatDate(doc.writtenOffOn)}
                {doc.writtenOffReason ? ` (${doc.writtenOffReason})` : ''}: no longer expected, and booked as a bad debt.
                {isOwner && (
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="btn small" onClick={() => void action('write-off', null, 'Write-off undone', 'DELETE')}>
                      Undo (they’re paying after all)
                    </button>
                  </div>
                )}
              </div>
            )}
            {error && <div className="banner alert small">{error}</div>}
            {editable && (
              <button className="btn primary big block" disabled={busy || (!dirty && Boolean(doc))}>
                {busy ? 'Saving…' : doc ? (dirty ? 'Save changes' : 'Saved') : 'Save draft'}
              </button>
            )}
            {doc && isOwner && (
              <div className="stack" style={{ gap: 8 }}>
                {doc.kind === 'invoice' && doc.status === 'draft' && (
                  <button type="button" className="btn block" disabled={busy} onClick={() => void action('issue', {}, `Invoice ${doc.number} issued`)}>
                    Issue invoice (counts in the books)
                  </button>
                )}
                {credit && doc.status === 'draft' && (
                  <button type="button" className="btn primary block" disabled={busy || total <= 0} onClick={() => void action('issue', {}, `Credit note ${doc.number} issued`)}>
                    Issue credit note (takes it off the invoice)
                  </button>
                )}
                {doc.kind === 'invoice' && doc.status === 'issued' && !doc.writtenOffOn && (
                  <button type="button" className="btn block" onClick={() => setDrawer('pay')}>
                    <Icon name="money" size={18} />
                    Record a payment
                  </button>
                )}
                {doc.kind === 'invoice' && doc.status === 'issued' && !doc.writtenOffOn && has('reminders') && total - paid > 0 && (
                  <button type="button" className="btn block" disabled={busy} onClick={() => void run(async () => {
                    if (await sendReminder({ ...doc, totalCents: total, paidCents: paid, payLink: d.payLink }, settings, has('payshap'))) {
                      toast('Reminder sent');
                      await reload();
                    }
                  })}>
                    <Icon name="chat" size={18} />
                    Send a reminder
                    {doc.reminders ? <span className="xs muted"> (last {formatDate(String(doc.remindedAt).slice(0, 10))})</span> : null}
                  </button>
                )}
                {doc.kind === 'invoice' && doc.status === 'issued' && has('creditNotes') && (
                  <button type="button" className="btn block" disabled={busy} onClick={() => void run(async () => {
                    const r = await api<{ id: string }>(`/api/documents/${doc.id}/credit-note`, { body: {} });
                    toast('Draft credit note made: change it to what’s being taken back');
                    navigate(`/documents/${r.id}`);
                  })}>
                    Credit note…
                  </button>
                )}
                {doc.kind === 'quote' && (
                  <>
                    <button type="button" className="btn primary block" disabled={busy} onClick={() => void run(async () => {
                      if (dirty) await api(`/api/documents/${doc.id}`, { method: 'PUT', body: body() });
                      const r = await api<{ id: string }>(`/api/documents/${doc.id}/convert`, { body: {} });
                      toast('Draft invoice made from the quote');
                      navigate(`/documents/${r.id}`);
                    })}>
                      Turn into an invoice
                    </button>
                    <div className="row wrap">
                      {doc.status !== 'sent' && <button type="button" className="btn small" onClick={() => void action('status', { status: 'sent' }, 'Marked as sent')}>Mark sent</button>}
                      {doc.status !== 'accepted' && <button type="button" className="btn small" onClick={() => void action('status', { status: 'accepted' }, 'Marked as accepted')}>Accepted</button>}
                      {doc.status !== 'declined' && <button type="button" className="btn small" onClick={() => void action('status', { status: 'declined' }, 'Marked as declined')}>Declined</button>}
                    </div>
                  </>
                )}
                <div className="row wrap">
                  {!credit && (
                    <button type="button" className="btn quiet small" onClick={() => void run(async () => {
                      const r = await api<{ id: string }>(`/api/documents/${doc.id}/duplicate`, { body: {} });
                      toast('Copy made');
                      navigate(`/documents/${r.id}`);
                    })}>
                      <Icon name="copy" size={16} />
                      Duplicate
                    </button>
                  )}
                  {credit && doc.status === 'issued' && (
                    <button type="button" className="btn quiet small danger" onClick={() => {
                      const reason = prompt('Why is this credit note being voided?');
                      if (reason) void action('void', { reason }, `Credit note ${doc.number} voided`);
                    }}>
                      Void
                    </button>
                  )}
                  {doc.kind === 'invoice' && doc.status === 'issued' && !doc.writtenOffOn && total - paid > 0 && (
                    <button type="button" className="btn quiet small" onClick={() => setDrawer('writeoff')}>
                      Mark delinquent…
                    </button>
                  )}
                  {doc.kind === 'invoice' && doc.status === 'issued' && !paid && !doc.writtenOffOn && !(detail?.creditNotes ?? []).some((c) => c.status === 'issued') && (
                    <button type="button" className="btn quiet small danger" onClick={() => {
                      const reason = prompt('Why is this invoice being voided?');
                      if (reason) void action('void', { reason }, `Invoice ${doc.number} voided`);
                    }}>
                      Void
                    </button>
                  )}
                  {(doc.kind === 'quote' || doc.status === 'draft') && (
                    <button type="button" className="btn quiet small danger" onClick={() => setDeleting(true)}>
                      <Icon name="trash" size={16} />
                      Delete
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
          {detail && detail.receipts.length > 0 && (
            <section className="panel">
              <div className="panel-head strong">Payments received</div>
              <ul className="list">
                {detail.receipts.map((r) => (
                  <li key={r.id} className="list-row">
                    <span className="grow small">
                      {formatDate(r.date)} · {r.method === 'credit' ? 'Credit note' : r.sourceName}
                      {r.reference && <div className="xs muted">{r.reference}</div>}
                    </span>
                    <Money cents={r.amountCents} />
                    {isOwner && r.method !== 'credit' && (
                      <button type="button" className="btn quiet small" aria-label="Remove payment" onClick={() => {
                        if (confirm('Remove this payment?')) void run(async () => {
                          await api(`/api/receipts/${r.id}`, { method: 'DELETE' });
                          await reload();
                        });
                      }}>
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail && detail.creditNotes.length > 0 && (
            <section className="panel">
              <div className="panel-head strong">Credit notes</div>
              <ul className="list">
                {detail.creditNotes.map((c) => (
                  <li key={c.id} className="list-row">
                    <Link to={`/documents/${c.id}`} className="grow small">
                      {c.number} · {formatDate(c.issueDate)}
                      {c.creditReason && <div className="xs muted">{c.creditReason}</div>}
                    </Link>
                    <DocChip status={c.status} />
                    <Money cents={c.totalCents} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </form>

      {drawer === 'writeoff' && doc && (
        <WriteOffDrawer
          balance={total - paid}
          paid={paid}
          issueDate={doc.issueDate}
          onClose={() => setDrawer(null)}
          onSave={(payload) => {
            setDrawer(null);
            void action('write-off', payload, `Invoice ${doc.number} marked delinquent`);
          }}
        />
      )}
      {drawer === 'client' && (
        <ClientDrawer
          onClose={() => setDrawer(null)}
          onSaved={(c) => {
            void clients.reload();
            if (c) set('clientId', c.id);
          }}
        />
      )}
      {drawer === 'time' && (
        <TimeDrawer
          projectId={d.projectId}
          onClose={() => setDrawer(null)}
          onAdd={(ids) =>
            void run(async () => {
              // Time goes on as lines on the saved document: save first if needed.
              let docId = doc?.id;
              if (!docId) {
                const r = await api<{ id: string }>('/api/documents', { body: { kind, ...body() } });
                docId = r.id;
              } else if (dirty) await api(`/api/documents/${docId}`, { method: 'PUT', body: body() });
              await api('/api/time/bill', { body: { documentId: docId, ids } });
              setDrawer(null);
              setDirty(false);
              toast('Time added');
              if (!doc) navigate(`/documents/${docId}`, { replace: true });
              else await reload();
            })
          }
        />
      )}
      {drawer === 'pay' && doc && <PaymentDrawer invoiceId={doc.id} balance={total - paid} onClose={() => setDrawer(null)} onSaved={() => (setDrawer(null), void reload())} />}
      {drawer === 'charge' && project.data && (
        <ChargeDrawer
          summary={project.data.summary}
          markupBp={settings.markupBp}
          onClose={() => setDrawer(null)}
          onAdd={(lines) => {
            set('lines', [...d.lines, ...lines.map(draftLine)]);
            setDrawer(null);
          }}
        />
      )}
      {preview && doc && (
        <PdfPreview
          title={`${label} ${doc.number}`}
          load={loadPdf}
          onClose={() => setPreview(false)}
          actions={
            <>
              <button className="btn primary small" onClick={() => (setPreview(false), void share())} disabled={busy}>
                <Icon name="share" size={16} />
                Send
              </button>
              <button className="btn quiet small" onClick={() => void view()} disabled={busy}>
                Open in another app
              </button>
            </>
          }
        />
      )}
      {deleting && doc && (
        <DeleteRecord
          what={`${label.toLowerCase()} ${doc.number}`}
          sent={doc.status !== 'draft' || Boolean((doc as { sharedAt?: string | null }).sharedAt)}
          creditInstead={doc.kind === 'invoice' && has('creditNotes')}
          onClose={() => setDeleting(false)}
          onDelete={() =>
            void run(async () => {
              await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
              toast('Deleted');
              navigate(`/documents?kind=${listKind}`);
            })
          }
        />
      )}
    </div>
  );
}

interface TimeEntry {
  id: string;
  projectId: string | null;
  projectName: string | null;
  hourlyRateCents: number | null;
  startedAt: string;
  minutes: number;
  note: string;
}

/** Unbilled time (this job's first), ticked onto the invoice as one line per job at its hourly rate. */
function TimeDrawer({ projectId, onClose, onAdd }: { projectId: string | null; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const { data, loading } = useApi<{ entries: TimeEntry[] }>('/api/time?unbilled=1');
  const entries = useMemo(() => [...(data?.entries ?? [])].sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId)), [data, projectId]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const sel = picked ?? new Set(entries.filter((e) => !projectId || e.projectId === projectId).map((e) => e.id));
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  };
  const chosen = entries.filter((e) => sel.has(e.id));
  const mins = chosen.reduce((s, e) => s + e.minutes, 0);
  const value = chosen.reduce((s, e) => s + Math.round((e.minutes / 60) * Number(e.hourlyRateCents ?? 0)), 0);
  const noRate = chosen.some((e) => !e.hourlyRateCents);
  return (
    <Drawer title="Add time" sub="Time logged and not on an invoice yet" onClose={onClose}>
      <div className="stack">
        {loading && !data ? (
          <Loading />
        ) : entries.length ? (
          <ul className="list panel">
            {entries.map((e) => (
              <li key={e.id} className="list-row">
                <label className="check grow">
                  <input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} />
                  <span className="small">
                    {e.projectName ?? 'No job'} · {formatDate(e.startedAt.slice(0, 10))}
                    {e.note && <div className="xs muted">{e.note}</div>}
                  </span>
                </label>
                <span className="small nowrap">{hoursLabel(e.minutes)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No unbilled time. Start the clock on a job (Jobs → the job → Time), or add time there by hand.</p>
        )}
        {chosen.length > 0 && (
          <p className="small">
            {hoursLabel(mins)} · <Money cents={value} />
            {noRate && <span className="warn-text"> · some jobs have no hourly rate yet (set it on the job), so their time goes on at R0</span>}
          </p>
        )}
        <button type="button" className="btn primary big block" disabled={!chosen.length} onClick={() => onAdd(chosen.map((e) => e.id))}>
          Add {chosen.length ? hoursLabel(mins) : 'time'}
        </button>
      </div>
    </Drawer>
  );
}

/** Adds lines for what the job has cost and not yet been invoiced, with your mark-up (the tracker's "To Charge"). */
function ChargeDrawer({ summary: s, markupBp, onClose, onAdd }: { summary: ProjectRow; markupBp: number; onClose: () => void; onAdd: (lines: DocLine[]) => void }) {
  const [markup, setMarkup] = useState(markupBp / 100);
  const parts = [
    { category: 'labour' as const, label: 'Labour', cost: Math.max(0, s.actualLabourCents - s.invoicedLabourCents) },
    { category: 'materials' as const, label: 'Materials', cost: Math.max(0, s.actualMaterialsCents - s.invoicedMaterialsCents) },
    { category: 'demo' as const, label: 'Demo & removal', cost: Math.max(0, s.actualDemoCents - s.invoicedDemoCents) },
  ];
  const [on, setOn] = useState<Record<string, boolean>>({ labour: true, materials: true, demo: true });
  const charge = (c: number) => Math.round(c * (1 + markup / 100));
  return (
    <Drawer title="Charge job costs" sub="What the job has cost and hasn’t been invoiced yet" onClose={onClose}>
      <div className="stack">
        <Field label="Mark-up %">{(p) => <input {...p} className="input" type="number" min={0} step={1} value={markup} onChange={(e) => setMarkup(Number(e.target.value))} />}</Field>
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Cost</th>
              <th className="num">Not invoiced</th>
              <th className="num">Charge</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.category}>
                <td>
                  <input type="checkbox" checked={on[p.category] && p.cost > 0} disabled={!p.cost} onChange={(e) => setOn({ ...on, [p.category]: e.target.checked })} aria-label={p.label} />
                </td>
                <td>{p.label}</td>
                <td className="num">
                  <Money cents={p.cost} />
                </td>
                <td className="num">
                  <Money cents={charge(p.cost)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="btn primary big block"
          onClick={() => onAdd(parts.filter((p) => on[p.category] && p.cost > 0).map((p) => ({ category: p.category, description: p.label, qty: 1, unit: '', unitPriceCents: charge(p.cost) })))}
        >
          Add lines
        </button>
      </div>
    </Drawer>
  );
}

function PaymentDrawer({ invoiceId, balance, onClose, onSaved }: { invoiceId: string; balance: number; onClose: () => void; onSaved: () => void }) {
  const { ref, settings, has } = useAuthed();
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(balance > 0 ? balance : null);
  const [date, setDate] = useState(todayIso());
  const [sourceId, setSourceId] = useState(settings.defaultReceiptSourceId ?? ref.sources[0]?.id ?? '');
  const [method, setMethod] = useState<PaymentMethod>('eft');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount) return setError('Enter the amount');
    try {
      await api(`/api/documents/${invoiceId}/receipts`, { body: { amountCents: amount, date, sourceId, method, reference } });
      toast(`Payment of ${formatZar(amount)} recorded`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    }
  };
  return (
    <Drawer title="Record a payment" sub={`Balance ${formatZar(balance)}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Amount">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} autoFocus />}</Field>
          <Field label="Date received">{(p) => <input {...p} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <div className="form-grid">
          <Field label="Received into">
            {(p) => (
              <select {...p} className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                {ref.sources.filter((s) => s.active && !s.role).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="How">
            {(p) => (
              <select {...p} className="select" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label="Reference (optional)">{(p) => <input {...p} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        {error && <div className="banner alert small">{error}</div>}
        <button className="btn primary big block">Record payment</button>
      </form>
    </Drawer>
  );
}

/** Delinquent: the client isn't going to pay the rest. It comes off what's owed and is booked as a bad debt. */
function WriteOffDrawer({ balance, paid, issueDate, onClose, onSave }: { balance: number; paid: number; issueDate: string; onClose: () => void; onSave: (p: { date: string; reason: string }) => void }) {
  const [date, setDate] = useState(todayIso() < issueDate ? issueDate : todayIso());
  const [reason, setReason] = useState('');
  return (
    <Drawer title="Mark delinquent" onClose={onClose}>
      <div className="stack">
        <p className="small">
          {paid ? `${formatZar(paid)} was paid. ` : ''}The remaining <strong>{formatZar(balance)}</strong> is no longer expected. It comes off what clients owe you and is
          booked as a bad debt (an expense) on the date below, so your profit and debtors are right. The invoice and its PDF stay as they are: the client
          still legally owes it.
        </p>
        <Field label="Date">{(p) => <input {...p} className="input" type="date" value={date} min={issueDate} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Why (for your records)">{(p) => <input {...p} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client stopped responding" />}</Field>
        <p className="xs muted">If they pay after all, undo this on the invoice and record the payment.</p>
        <button type="button" className="btn primary big block" onClick={() => onSave({ date, reason })} disabled={!date}>
          Write off {formatZar(balance)}
        </button>
      </div>
    </Drawer>
  );
}

interface UsualLine {
  description: string;
  category: LineCategory;
  unit: string;
  unitPriceCents: number;
  uses: number;
}

/**
 * The usual items, one tap each: what this business charged before (with last time's price),
 * then the common ones for its kind of work. Filtered as you type in the search box.
 */
function QuickAdd({ usual, profile, onAdd, lines }: { usual: UsualLine[]; profile: ReturnType<typeof industryProfile>; onAdd: (it: { description: string; category: LineCategory; unit?: string; unitPriceCents?: number | null }) => void; lines: { description: string }[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(lines.length === 0);
  const seen = new Set(usual.map((u) => u.description.toLowerCase()));
  const onDoc = new Set(lines.map((l) => l.description.trim().toLowerCase()));
  const all = [
    ...usual.map((u) => ({ description: u.description, category: u.category, unit: u.unit, unitPriceCents: u.unitPriceCents as number | null, mine: true })),
    ...profile.items.filter((i) => !seen.has(i.d.toLowerCase())).map((i) => ({ description: i.d, category: i.cat as LineCategory, unit: i.unit ?? '', unitPriceCents: null, mine: false })),
  ].filter((i) => !onDoc.has(i.description.toLowerCase()));
  const term = q.trim().toLowerCase();
  const shown = (term ? all.filter((i) => i.description.toLowerCase().includes(term)) : all).slice(0, term ? 24 : 12);
  if (!all.length) return null;
  if (!open)
    return (
      <button type="button" className="btn quiet small" onClick={() => setOpen(true)} style={{ alignSelf: 'flex-start' }}>
        <Icon name="plus" size={14} />
        Usual items…
      </button>
    );
  return (
    <div className="quick-add stack-sm">
      <div className="row spread">
        <span className="xs muted">Tap to add{usual.length ? ' (with last price)' : ''}</span>
        {all.length > 12 && <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find…" aria-label="Find an item" style={{ maxWidth: 160 }} />}
      </div>
      <div className="chips">
        {shown.map((i) => (
          <button key={i.description} type="button" className={`chip-btn ${i.mine ? 'mine' : ''}`} onClick={() => onAdd(i)}>
            {i.description}
            {i.unitPriceCents ? <span className="muted"> · {formatZar(i.unitPriceCents)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
