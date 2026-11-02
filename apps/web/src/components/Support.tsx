/**
 * Shap is OpenWorks' gift to South African small business: free, open, never ads. This is where
 * people can chip in, and tell us what to build next.

 */
import { askFeedback } from './Feedback';
import { Icon } from './ui';

export const SUPPORT_URL = (import.meta.env.VITE_SUPPORT_URL as string | undefined) || 'https://www.openworks.co.za/shap/#support';

export function SupportShap() {
  const coffee = true;
  return (
    <section className="panel panel-pad stack support-shap">
      <h3>Support Shap</h3>
      <p className="small">
        Shap is made by OpenWorks IT in Gqeberha and given away so South Africans can spend their time building, not doing admin. It’s free, it’s open, and it will never have ads.
      </p>
      <p className="small">
        <strong>What should Shap do next?</strong> Is your kind of business not covered? Tell us how we can help and what you need.
      </p>
      <div className="row wrap">
        <button type="button" className="btn primary" onClick={() => askFeedback('idea')}>
          <Icon name="chat" size={18} />
          Tell us what you need
        </button>
        {coffee && (
          <a className="btn" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
            <span aria-hidden="true">☕</span> Buy us a coffee
          </a>
        )}
      </div>
      {coffee && <p className="xs muted">Shap runs on donations. Every coffee keeps it free for the next business.</p>}
    </section>
  );
}
