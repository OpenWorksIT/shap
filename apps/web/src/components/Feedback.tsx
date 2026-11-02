import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { APP_VERSION } from '../lib/api';
import { flushFeedback, sendFeedback } from '../lib/usage';
import { getTrail, record, scrubPath, startTrail } from '../lib/trail';
import { Icon } from './ui';

type Kind = 'love' | 'dislike' | 'bug';
const KINDS: { kind: Kind; label: string; emoji: string; prompt: string }[] = [
  { kind: 'love', label: 'Love this', emoji: '💚', prompt: 'What do you like about it?' },
  { kind: 'dislike', label: 'Don’t like this', emoji: '👎', prompt: 'What would make it better?' },
  { kind: 'bug', label: 'Bug found', emoji: '🐞', prompt: 'What went wrong? What did you expect to happen?' },
];

/**
 * UI words worth keeping in a privacy-masked screenshot: controls, labels and headings, not data.
 * Plain link-style buttons are left out on purpose (client names are often clickable), and digits
 * are masked everywhere, since IDs, phone and membership numbers are digits.
 */
const KEEP =
  '.btn, [role="tab"], [role="radio"], .chip-btn, .pay-option, .nav-link, label, th, legend, summary, h2, h3, .tabbar, .rail .brand, .nf-label, .tick, .chip, [data-feedback-keep]';

/** Replaces letters and digits in the clone, keeping layout, so the picture shows the screen but not who's on it. */
function maskClone(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const parent = t.parentElement;
    const keep = parent && parent.closest(KEEP) && !parent.closest('[data-private]');
    t.data = keep ? t.data.replace(/\p{N}/gu, '•') : t.data.replace(/[\p{L}\p{N}]/gu, '•');
  }
  if (root instanceof Element) {
    root.querySelectorAll('input, textarea').forEach((el) => {
      const field = el as HTMLInputElement;
      if (field.type === 'checkbox' || field.type === 'radio') return;
      const masked = (field.value || '').replace(/[\p{L}\p{N}]/gu, '•');
      field.value = masked;
      field.setAttribute('value', masked);
      if (el instanceof HTMLTextAreaElement) el.textContent = masked;
    });
  }
}

/** Takes a JPEG of the page as it is, leaving out the feedback widget. */
async function capture(mask: boolean): Promise<string | null> {
  try {
    const { domToJpeg } = await import('modern-screenshot');
    const el = document.body;
    const scale = Math.min(1, 1600 / Math.max(1, el.scrollWidth));
    return await domToJpeg(el, {
      quality: 0.75,
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      filter: (n) => !(n instanceof Element && n.closest('[data-feedback]')),
      onCloneNode: mask ? maskClone : null,
      maximumCanvasSize: 8000,
      timeout: 4000,
    });
  } catch (err) {
    record('error', `Screenshot failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The feedback button on every screen. "Bug found" attaches a screenshot of the page as it was
 * when the button was pressed (names and amounts hidden by default) and the recent trail of clicks,
 * pages and server calls, so we can see what led up to it.
 */
export function FeedbackButton() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [message, setMessage] = useState('');
  const [shot, setShot] = useState<{ url: string; masked: boolean } | null>(null);
  const [shooting, setShooting] = useState(false);
  const [includeShot, setIncludeShot] = useState(true);
  const [mask, setMask] = useState(true);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  const openedAt = useRef<{ at: string; path: string; title: string; scrollY: number } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startTrail();
    void flushFeedback();
  }, []);
  useEffect(() => {
    record('nav', scrubPath(location.pathname + location.search));
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const takeShot = async (masked: boolean) => {
    setShooting(true);
    const url = await capture(masked); // the widget itself is filtered out of the picture
    setShooting(false);
    setShot(url ? { url, masked } : null);
  };

  const start = async () => {
    // Remember the moment the button was pressed: that's the page the report is about.
    openedAt.current = { at: new Date().toISOString(), path: location.pathname + location.search, title: document.title, scrollY: Math.round(window.scrollY) };
    setKind(null);
    setMessage('');
    setShot(null);
    setIncludeShot(true);
    setMask(true);
    setState('idle');
    setError('');
    await takeShot(true);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setShot(null);
  };

  const send = async () => {
    if (!kind) return;
    setState('sending');
    setError('');
    const o = openedAt.current!;
    try {
      const how = await sendFeedback({
        kind,
        message,
        page: o.path,
        title: o.title,
        at: o.at,
        screenshot: kind === 'bug' && includeShot && shot ? shot.url : null,
        screenshotMasked: shot?.masked ?? true,
        trail: kind === 'bug' ? getTrail() : getTrail().slice(-10),
        client: {
          userAgent: navigator.userAgent.slice(0, 300),
          viewport: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
          scrollY: o.scrollY,
          standalone: true,
          online: navigator.onLine,
          build: APP_VERSION,
        },
      });
      setQueued(how === 'queued');
      setState('sent');
      setTimeout(close, 1800);
    } catch (err) {
      setState('error');
      setError((err as Error).message || 'Could not send. Please try again.');
    }
  };

  const current = KINDS.find((k) => k.kind === kind);
  return (
    <div data-feedback>
      {!open && (
        <button className="feedback-fab" onClick={() => void start()} disabled={shooting} aria-label="Send feedback or report a bug">
          <Icon name="chat" size={16} /> {shooting ? 'One moment…' : 'Feedback'}
        </button>
      )}
      {open && (
        <div className="feedback-layer">
          <div className="scrim" onClick={close} />
          <div className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="fb-title" tabIndex={-1} ref={dialog}>
            <div className="spread">
              <h2 id="fb-title">Feedback</h2>
              <button className="btn quiet small" onClick={close} aria-label="Close">
                <Icon name="close" />
              </button>
            </div>
            {state === 'sent' ? (
              <p className="feedback-thanks">
                <Icon name="check" /> {queued ? 'Thank you. You’re offline: it goes to the Shap team as soon as you’re connected.' : 'Thank you. It’s on its way to the Shap team.'}
              </p>
            ) : (
              <>
                <div className="feedback-kinds" role="radiogroup" aria-label="What kind of feedback">
                  {KINDS.map((k) => (
                    <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`feedback-kind ${k.kind}`} onClick={() => setKind(k.kind)}>
                      <span aria-hidden="true">{k.emoji}</span> {k.label}
                    </button>
                  ))}
                </div>
                {kind && (
                  <div className="stack">
                    <label htmlFor="fb-text" className="small strong">
                      {current!.prompt}
                    </label>
                    <textarea id="fb-text" className="textarea" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
                    {kind === 'bug' && (
                      <div className="feedback-shot stack">
                        {shot ? (
                          <>
                            <img src={shot.url} alt="Screenshot of the page you were on" />
                            <label className="check small">
                              <input type="checkbox" checked={includeShot} onChange={(e) => setIncludeShot(e.target.checked)} />
                              <span>Attach this screenshot</span>
                            </label>
                            {includeShot && (
                              <label className="check small">
                                <input
                                  type="checkbox"
                                  checked={mask}
                                  disabled={shooting}
                                  onChange={(e) => {
                                    setMask(e.target.checked);
                                    void takeShot(e.target.checked);
                                  }}
                                />
                                <span>Hide names and amounts in the screenshot (recommended)</span>
                              </label>
                            )}
                          </>
                        ) : (
                          <p className="xs muted">{shooting ? 'Taking a screenshot…' : 'No screenshot could be taken on this device.'}</p>
                        )}
                        <p className="xs faint">
                          We also send the page, the time ({new Date(openedAt.current!.at).toLocaleTimeString('en-ZA')}) and your last few clicks and screens, so we can retrace what happened. Nothing you typed into the app is included. It goes to OpenWorks, who make Shap.
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {error && <div className="banner alert small">{error}</div>}
                <div className="row">
                  <button className="btn primary" disabled={!kind || state === 'sending' || shooting || (kind !== 'love' && !message.trim())} onClick={() => void send()}>
                    {state === 'sending' ? 'Sending…' : 'Send'}
                  </button>
                  <button className="btn quiet" onClick={close}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
