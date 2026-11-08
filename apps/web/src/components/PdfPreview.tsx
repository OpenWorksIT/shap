/**
 * The PDF on screen before it goes anywhere: every page drawn in the app (pdf.js), so it works
 * the same on a phone, where a browser often can't show a PDF in a page, as on a computer.
 * pdf.js is only loaded the first time a preview opens.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;
const loadPdfJs = () =>
  (pdfjs ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return lib;
  }));

export function PdfPreview({ title, load, onClose, actions }: { title: string; load: () => Promise<Blob>; onClose: () => void; actions?: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  // The width a page fits the screen at, and the app's own zoom (pinch-zoom is off in the app,
  // so it feels native).
  const [fit, setFit] = useState(800);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let gone = false;
    let task: { destroy(): Promise<void> } | null = null;
    (async () => {
      try {
        const [lib, blob] = await Promise.all([loadPdfJs(), load()]);
        if (gone) return;
        const t = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
        task = t;
        const doc = await t.promise;
        const box = pages.current;
        if (!box || gone) return;
        box.replaceChildren();
        const width = Math.min((body.current?.clientWidth ?? 832) - 32, 900);
        setFit(width);
        // Drawn sharp enough to zoom in, within what a phone's memory allows.
        const ratio = Math.min(Math.min(window.devicePixelRatio || 1, 2.5) * 2, 2400 / width);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const view = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(view.width);
          canvas.height = Math.floor(view.height);
          canvas.className = 'pdf-page';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `${title}, page ${n} of ${doc.numPages}`);
          box.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport: view }).promise;
          if (gone) return;
        }
        setState('ready');
      } catch (err) {
        if (gone) return;
        setError((err as Error).message || 'Couldn’t show the PDF');
        setState('error');
      }
    })();
    return () => {
      gone = true;
      void task?.destroy();
    };
  }, [load, title]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="pdf-preview" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pdf-preview-bar">
        <button type="button" className="btn quiet" onClick={onClose} aria-label="Close the preview">
          <Icon name="close" size={18} />
        </button>
        <strong className="grow pdf-preview-title">{title}</strong>
        <span className="row pdf-preview-zoom">
          <button type="button" className="btn quiet small" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={zoom <= 1} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="btn quiet small" onClick={() => setZoom((z) => Math.min(3, z + 0.5))} disabled={zoom >= 3} aria-label="Zoom in">
            +
          </button>
        </span>
        <span className="row wrap pdf-preview-actions">{actions}</span>
      </div>
      <div ref={body} className="pdf-preview-body" style={{ ['--pdf-w' as string]: `${Math.round(fit * zoom)}px` }}>
        {state === 'loading' && <p className="small muted pdf-preview-note">Drawing the PDF…</p>}
        {state === 'error' && <div className="banner alert small pdf-preview-note">{error}</div>}
        <div ref={pages} className="pdf-pages" />
      </div>
    </div>
  );
}
