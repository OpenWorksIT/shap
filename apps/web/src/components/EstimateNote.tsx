/**
 * Under every figure Shap works out for tax or company law: an estimate, from OpenWorks, who are
 * not accountants (packages/shared/src/terms.ts, the same words in Shap and Shap Pocket).
 */
import { DISCLAIMER_URL, ESTIMATE_NOTE } from '@shap/shared';

export function EstimateNote({ className = 'xs muted' }: { className?: string }) {
  return (
    <p className={className}>
      {ESTIMATE_NOTE}{' '}
      <a href={DISCLAIMER_URL} target="_blank" rel="noreferrer">
        More
      </a>
    </p>
  );
}
