/**
 * Before a quote, invoice, credit note, bill or cost is deleted: SARS expects business records
 * to be kept for five years (Tax Administration Act s29; VAT Act s55 for VAT records), so this
 * says so, and offers the tidy alternative where there is one. Deleting still works: what was
 * deleted (its number, date and amount) stays in the audit log.
 */
import { Drawer, Icon } from './ui';

type Props = {
  what: string;
  sent?: boolean;
  creditInstead?: boolean;
  onClose: () => void;
  onDelete: () => void;
};

export function DeleteRecord(p: Props) {
  return (
    <Drawer title={`Delete ${p.what}?`} onClose={p.onClose}>
      <DeleteWarning {...p} />
    </Drawer>
  );
}

/** The same, in place (inside a form that is already in a drawer). */
export function DeleteWarning({ sent, creditInstead, onClose, onDelete }: Props) {
  return (
    <div className="stack">
      <div className="banner alert small stack" style={{ gap: 6 }}>
        <strong>Keep your records: SARS requires it</strong>
        <span>
          Quotes, invoices, credit notes, bills and slips are business records. The law (Tax Administration Act section 29, and VAT Act section 55 for a VAT vendor) expects you to keep them for at
          least five years, and to be able to show them if SARS asks.
        </span>
        {sent && <span>This one has gone out to someone. Deleting it here doesn’t take back the copy they have.</span>}
        {creditInstead && <span>For an invoice that was sent, a credit note (or voiding it) is the right way to cancel it: the number stays accounted for.</span>}
      </div>
      <p className="xs muted">
        Delete only what was made by mistake and never used. A note of what was deleted (its number, date and amount, and who deleted it) stays in the audit log under Settings → Audit log.
      </p>
      <div className="row">
        <button type="button" className="btn quiet grow" onClick={onClose}>
          Keep it
        </button>
        <button type="button" className="btn danger grow" onClick={onDelete}>
          <Icon name="trash" size={16} />
          Delete anyway
        </button>
      </div>
    </div>
  );
}
