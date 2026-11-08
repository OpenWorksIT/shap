/**
 * The first time a screen opens: a few seconds of it being used (recorded from the app itself,
 * scripts/clips), so it's clear what the screen is for and how to work it. Put away, it stays
 * away; Settings can switch them all off, or show them all again. Remembered on this device.
 */
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './ui';

export type ClipKey = 'home' | 'clients' | 'quotes' | 'invoices' | 'costs' | 'jobs' | 'payroll' | 'accounts' | 'settings' | 'backup';

export const CLIPS: Record<ClipKey, { title: string; text: string }> = {
  home: { title: 'Home: what needs you today', text: 'What’s owed to you, what’s due to SARS, and what’s running. Tap anything to open it.' },
  clients: { title: 'Clients', text: 'Add a client once, with their address and VAT number if they have one: it fills in every quote and invoice for them.' },
  quotes: { title: 'Quotes', text: 'Add the items, check the VAT on each, preview the PDF, then send it. An accepted quote becomes the invoice in one tap.' },
  invoices: { title: 'Invoices', text: 'Issue the invoice to put it in the books, send the PDF, and record payments as they come in.' },
  costs: { title: 'Costs', text: 'Snap the slip, type the amount, pick what it was for. Choose the VAT on it, and Shap claims what you may.' },
  jobs: { title: 'Jobs', text: 'A job gathers its quote, costs, labour and invoices, so you see what it really made.' },
  payroll: { title: 'Payroll', text: 'Add your employees once. Each month, a pay run works out PAYE, UIF and SDL and makes the payslips.' },
  accounts: { title: 'Accounts and reports', text: 'Profit and loss, the balance sheet and your VAT201, worked out from what you’ve captured. Check them with your accountant.' },
  settings: { title: 'Settings', text: 'Your business details, what you use, and the audit log: everything that changed, and who changed it.' },
  backup: { title: 'Back up your books', text: 'Your books live only on this device. One tap saves a copy to your own cloud drive: do it every week.' },
};

const SEEN = 'shap.clipsSeen';
const OFF = 'shap.clipsOff';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private window: shown again next time */
  }
};
const seen = (): ClipKey[] => {
  try {
    return JSON.parse(read(SEEN) ?? '[]') as ClipKey[];
  } catch {
    return [];
  }
};

/** Settings: are the clips on, and show them all again. */
export const clipsOn = () => read(OFF) !== '1';
export const setClipsOn = (on: boolean) => write(OFF, on ? null : '1');
export const showClipsAgain = () => write(SEEN, null);

export const clipUrl = (k: ClipKey, ext: 'webm' | 'mp4') => `${import.meta.env.BASE_URL}clips/${k}.${ext}`;

export function HowItWorks({ clip }: { clip: ClipKey }) {
  const [hidden, setHidden] = useState(() => !clipsOn() || seen().includes(clip));
  const [failed, setFailed] = useState(false);
  if (hidden || failed) return null;
  const done = () => {
    write(SEEN, JSON.stringify([...new Set([...seen(), clip])]));
    setHidden(true);
  };
  const c = CLIPS[clip];
  return (
    <section className="panel how-it-works" aria-label={`How it works: ${c.title}`}>
      {/* MP4 (H.264, the smaller file) where it plays: Chrome, Safari, iPhones, Android. WebM
          (VP9) for browsers without H.264, such as Chromium and some Linux browsers. Neither: no card. */}
      <video className="how-video" autoPlay muted loop playsInline preload="metadata" aria-label={`A short clip of ${c.title.toLowerCase()} being used`}>
        <source src={clipUrl(clip, 'mp4')} type='video/mp4; codecs="avc1.64001E"' />
        <source src={clipUrl(clip, 'webm')} type='video/webm; codecs="vp9"' onError={() => setFailed(true)} />
      </video>
      <div className="how-text stack" style={{ gap: 6 }}>
        <span className="xs muted">How it works</span>
        <strong>{c.title}</strong>
        <p className="small" style={{ margin: 0 }}>
          {c.text}
        </p>
        <div className="row wrap" style={{ marginTop: 4 }}>
          <button type="button" className="btn primary small" onClick={done}>
            <Icon name="check" size={16} />
            Got it
          </button>
          <button
            type="button"
            className="btn quiet small"
            onClick={() => {
              setClipsOn(false);
              setHidden(true);
            }}
          >
            Don’t show these
          </button>
        </div>
        <span className="xs muted">Switch them back on in Settings → What you use.</span>
      </div>
    </section>
  );
}

/** For Settings: switch the clips on or off, and see them all again. */
export function ClipsSetting() {
  const [on, setOn] = useState(clipsOn());
  const [again, setAgain] = useState(false);
  return (
    <section className="panel panel-pad stack">
      <h3>How-it-works clips</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setClipsOn(e.target.checked);
            setOn(e.target.checked);
          }}
        />
        <span>
          Show a short clip the first time each screen opens
          <div className="xs muted">A few seconds of the screen being used, with what it’s for. Remembered on this device.</div>
        </span>
      </label>
      <div>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            showClipsAgain();
            setClipsOn(true);
            setOn(true);
            setAgain(true);
          }}
        >
          Show them all again
        </button>
        {again && <span className="xs muted"> Done: each screen shows its clip the next time it opens.</span>}
      </div>
    </section>
  );
}

/** Which clip a screen has (the list pages only, not each record). */
export function clipFor(pathname: string, search: string): ClipKey | null {
  const kind = new URLSearchParams(search).get('kind');
  const map: Record<string, ClipKey> = { '/': 'home', '/clients': 'clients', '/costs': 'costs', '/jobs': 'jobs', '/payroll': 'payroll', '/accounts': 'accounts', '/settings': 'settings', '/backup': 'backup' };
  if (pathname === '/documents') return kind === 'quote' ? 'quotes' : 'invoices';
  return map[pathname] ?? null;
}

/** In the shell, above each list screen. */
export function ScreenClip() {
  const { pathname, search } = useLocation();
  const clip = clipFor(pathname, search);
  return clip ? <HowItWorks key={clip} clip={clip} /> : null;
}
