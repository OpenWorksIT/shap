/** One tap for the usual payment terms, or how long a quote is valid (shared/paymentTerms.ts). */
export function TermPicks<T extends string | number>({ label, options, value, onPick, disabled }: { label: string; options: { value: T; label: string }[]; value: T | null; onPick: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="term-picks" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className="btn small" aria-pressed={value === o.value} disabled={disabled} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
