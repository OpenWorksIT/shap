/**
 * The first time Shap Pocket opens: a few questions, then straight into the app. Everything
 * here can be changed later in Settings.
 */
import { useState } from 'react';
import { FEATURES, FEATURE_KEYS, featureOn, type Feature } from '@shap/shared';
import { BusinessFields, LogoField } from '../components/BusinessForm';
import { Logo } from '../components/Logo';
import { Icon } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { pickFile } from '../lib/native';
import { restoreFrom } from '../lib/backup';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';

type Step = 'hello' | 'business' | 'sections' | 'logo';

/** Starting points for common kinds of one-person business. */
const KINDS: { label: string; hint: string; features: Partial<Record<Feature, boolean>> }[] = [
  { label: 'A trade', hint: 'Electrician, plumber, builder, mechanic: jobs, quotes, parts', features: { jobs: true, quotes: true, workers: false } },
  { label: 'A service', hint: 'Designer, consultant, tutor, photographer: clients and invoices', features: { jobs: false, quotes: true, workers: false } },
  { label: 'A trade with helpers', hint: 'Jobs plus people you pay by the day', features: { jobs: true, quotes: true, workers: true } },
];

export default function WelcomePage() {
  const { settings, refreshReference } = useAuthed();
  const [step, setStep] = useState<Step>('hello');
  const [f, setF] = useState<Settings>({ ...settings, features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(settings.features, k)])) });
  const [logoId, setLogoId] = useState(settings.logoId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      const { logoId: _l, ...rest } = { ...f, setupDone: true, fyEndMonth: f.businessType === 'sole_prop' ? 2 : f.fyEndMonth } as Settings & { logoId: string | null };
      await api('/api/settings', { method: 'PUT', body: rest });
      await refreshReference();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
      setBusy(false);
    }
  };

  const restore = async () => {
    const file = await pickFile([]);
    if (!file) return;
    setBusy(true);
    try {
      await restoreFrom(file);
      window.location.reload();
    } catch (err) {
      setError(`That file couldn’t be restored: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-card stack-lg">
        {step === 'hello' && (
          <>
            <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
              <Logo size={72} />
              <h1>Shap Pocket</h1>
              <p className="muted">Quotes, invoices, costs and tax for a one-person business. Your books stay on this phone: no account, no subscription.</p>
            </div>
            <button className="btn primary big block" onClick={() => setStep('business')}>
              Set up my books
            </button>
            <button className="btn quiet block" onClick={() => void restore()} disabled={busy}>
              I have a backup to restore
            </button>
          </>
        )}

        {step === 'business' && (
          <form
            className="stack-lg"
            onSubmit={(e) => {
              e.preventDefault();
              if (!f.companyName.trim()) return setError('Give your business a name');
              setError('');
              setStep('sections');
            }}
          >
            <div>
              <h2>Your business</h2>
              <p className="small muted">As it goes on your quotes and invoices. Fill in what you have; the rest can wait.</p>
            </div>
            <BusinessFields f={f} set={set as never} compact />
            {error && <div className="banner alert small">{error}</div>}
            <button className="btn primary big block">Next</button>
          </form>
        )}

        {step === 'sections' && (
          <div className="stack-lg">
            <div>
              <h2>What do you do?</h2>
              <p className="small muted">Shap shows only what you need. Change it any time in Settings.</p>
            </div>
            <div className="stack">
              {KINDS.map((k) => {
                const on = Object.entries(k.features).every(([key, v]) => f.features[key] === v);
                return (
                  <button key={k.label} type="button" className={`choice ${on ? 'on' : ''}`} onClick={() => set('features', { ...f.features, ...k.features })}>
                    <strong>{k.label}</strong>
                    <span className="xs muted">{k.hint}</span>
                  </button>
                );
              })}
            </div>
            <details>
              <summary className="small">Pick exactly</summary>
              <ul className="list">
                {FEATURE_KEYS.map((k) => (
                  <li key={k} className="list-row">
                    <label className="check grow">
                      <input type="checkbox" checked={Boolean(f.features[k])} onChange={(e) => set('features', { ...f.features, [k]: e.target.checked })} />
                      <span>
                        {FEATURES[k].label}
                        <div className="xs muted">{FEATURES[k].hint}</div>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </details>
            <div className="row">
              <button className="btn quiet" onClick={() => setStep('business')}>
                Back
              </button>
              <button className="btn primary big grow" onClick={() => setStep('logo')}>
                Next
              </button>
            </div>
          </div>
        )}

        {step === 'logo' && (
          <div className="stack-lg">
            <div>
              <h2>Your logo</h2>
              <p className="small muted">Optional. Add it from your photos or files, then drag it into place.</p>
            </div>
            <LogoField logoId={logoId} layout={f.logoLayout} accent={f.accent} onLogo={setLogoId} onLayout={(l) => set('logoLayout', l)} />
            {error && <div className="banner alert small">{error}</div>}
            <div className="row">
              <button className="btn quiet" onClick={() => setStep('sections')}>
                Back
              </button>
              <button className="btn primary big grow" onClick={() => void finish()} disabled={busy}>
                <Icon name="check" size={18} />
                {busy ? 'Saving…' : 'Start'}
              </button>
            </div>
            <p className="xs muted">Tip: back up from Settings → Backup now and then, to iCloud Drive, Google Drive, OneDrive or Proton Drive.</p>
          </div>
        )}
      </div>
    </div>
  );
}
