/**
 * The accountant export: pick what (journal, sales, purchases…), a layout for the accountant's
 * package (Pastel, Xero, QuickBooks, Sage Accounting, or plain CSV), adjust the format, preview,
 * download. The preview is the file's first rows exactly as they'll be written.
 */
import { useEffect, useMemo, useState } from 'react';
import { BUILTIN_PRESETS, DATE_FORMATS, EXPORT_DATASET_KEYS, EXPORT_DATASETS, formatZar, type ExportDataset, type ExportOptions } from '@shap/shared';
import { useApi } from '../lib/hooks';
import { FileButton } from './Files';
import { Field, Icon, Loading } from './ui';

const KEY = 'shap.exportStudio';
type Format = Pick<ExportOptions, 'delimiter' | 'decimal' | 'dateFormat' | 'negatives' | 'thousands' | 'header' | 'groupBy'>;
const DEFAULT_FORMAT: Format = { delimiter: ',', decimal: '.', dateFormat: 'YYYY-MM-DD', negatives: 'minus', thousands: false, header: true, groupBy: 'item' };

function remembered(): { dataset: ExportDataset; preset: string } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { dataset: ExportDataset; preset: string } | null;
    if (v && EXPORT_DATASET_KEYS.includes(v.dataset) && BUILTIN_PRESETS.some((p) => p.id === v.preset)) return v;
  } catch {
    /* fine */
  }
  return { dataset: 'journal', preset: 'generic-journal' };
}

export function ExportStudio({ from, to }: { from: string; to: string }) {
  const [choice, setChoice] = useState(remembered);
  const preset = BUILTIN_PRESETS.find((p) => p.id === choice.preset)!;
  const [format, setFormat] = useState<Format>({ ...DEFAULT_FORMAT, ...preset.options });
  // A new preset brings its own layout.
  useEffect(() => {
    setFormat({ ...DEFAULT_FORMAT, ...preset.options });
    try {
      localStorage.setItem(KEY, JSON.stringify(choice));
    } catch {
      /* fine */
    }
  }, [choice.preset]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: ExportOptions = { ...format, columns: preset.options.columns };
  const qs = useMemo(() => new URLSearchParams({ dataset: choice.dataset, from, to, options: JSON.stringify(options) }).toString(), [choice.dataset, from, to, JSON.stringify(options)]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useApi<{ headers: string[]; cells: string[][]; rowCount: number; total: { label: string; cents: number } | null; notes: string[] }>(`/api/accountant-export?${qs}&preview=1`);
  const presets = BUILTIN_PRESETS.filter((p) => p.dataset === choice.dataset);
  const set = <K extends keyof Format>(k: K, v: Format[K]) => setFormat((f) => ({ ...f, [k]: v }));

  return (
    <section className="panel panel-pad stack">
      <div>
        <h3>For your accountant</h3>
        <p className="xs muted">The books laid out the way their package imports them. Check a new layout against the package’s own import template the first time.</p>
      </div>
      <div className="form-grid">
        <Field label="What">
          {(p) => (
            <select {...p} className="select" value={choice.dataset} onChange={(e) => {
              const dataset = e.target.value as ExportDataset;
              setChoice({ dataset, preset: `generic-${dataset}` });
            }}>
              {EXPORT_DATASET_KEYS.map((d) => (
                <option key={d} value={d}>
                  {EXPORT_DATASETS[d].label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Layout">
          {(p) => (
            <select {...p} className="select" value={choice.preset} onChange={(e) => setChoice({ ...choice, preset: e.target.value })}>
              {presets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <p className="xs muted">
        {EXPORT_DATASETS[choice.dataset].description} {preset.note}
      </p>
      <details className="small">
        <summary>Format: dates {format.dateFormat}, {format.delimiter === '\t' ? 'tabs' : format.delimiter === ';' ? 'semicolons' : 'commas'}, decimal “{format.decimal}”</summary>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="Dates">
            {(p) => (
              <select {...p} className="select" value={format.dateFormat} onChange={(e) => set('dateFormat', e.target.value as Format['dateFormat'])}>
                {DATE_FORMATS.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Separator">
            {(p) => (
              <select {...p} className="select" value={format.delimiter} onChange={(e) => set('delimiter', e.target.value as Format['delimiter'])}>
                <option value=",">Comma</option>
                <option value=";">Semicolon</option>
                <option value={'\t'}>Tab</option>
              </select>
            )}
          </Field>
          <Field label="Decimal point">
            {(p) => (
              <select {...p} className="select" value={format.decimal} onChange={(e) => set('decimal', e.target.value as Format['decimal'])}>
                <option value=".">1250.50</option>
                <option value=",">1250,50</option>
              </select>
            )}
          </Field>
          <Field label="Negative amounts">
            {(p) => (
              <select {...p} className="select" value={format.negatives} onChange={(e) => set('negatives', e.target.value as Format['negatives'])}>
                <option value="minus">-12.50</option>
                <option value="brackets">(12.50)</option>
              </select>
            )}
          </Field>
          {choice.dataset === 'journal' && (
            <Field label="Entries">
              {(p) => (
                <select {...p} className="select" value={format.groupBy} onChange={(e) => set('groupBy', e.target.value as Format['groupBy'])}>
                  <option value="item">Every posting</option>
                  <option value="day">Summed per day</option>
                  <option value="month">Summed per month</option>
                </select>
              )}
            </Field>
          )}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <label className="check">
            <input type="checkbox" checked={format.header} onChange={(e) => set('header', e.target.checked)} />
            Headings in the first row
          </label>
          <label className="check">
            <input type="checkbox" checked={format.thousands} onChange={(e) => set('thousands', e.target.checked)} />
            Thousands separated (1 250.00)
          </label>
        </div>
      </details>
      {preview.loading && !preview.data ? (
        <Loading label="Making the preview…" />
      ) : preview.data ? (
        <>
          <p className="small">
            <strong>{preview.data.rowCount}</strong> row{preview.data.rowCount === 1 ? '' : 's'}
            {preview.data.total && (
              <>
                {' '}
                · {preview.data.total.label}: <strong>{formatZar(preview.data.total.cents)}</strong> <span className="muted">(check this in the package after importing)</span>
              </>
            )}
          </p>
          {preview.data.notes.map((n) => (
            <p key={n} className="xs muted">
              {n}
            </p>
          ))}
          {preview.data.cells.length > 0 && (
            <div className="table-wrap export-preview">
              <table className="table compact">
                {format.header && (
                  <thead>
                    <tr>
                      {preview.data.headers.map((h, i) => (
                        <th key={i}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {preview.data.cells.slice(0, 8).map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j} className="nowrap">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      {preview.error && <div className="banner alert small">{preview.error.message}</div>}
      <FileButton className="btn primary" path={`/api/accountant-export?${qs}`} title={EXPORT_DATASETS[choice.dataset].label}>
        <Icon name="download" size={18} />
        Download
      </FileButton>
    </section>
  );
}
