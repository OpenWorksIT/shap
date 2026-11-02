/**
 * Put the logo where it looks right: drag it, pinch or slide to size it, or tap Centre. The box
 * is the same shape as the logo's place at the top of a quote or invoice, so what you see here
 * is what the client gets.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { apiBlob } from '../lib/api';

export interface LogoLayout {
  zoom?: number;
  x?: number;
  y?: number;
}
/** Same as the PDF's LOGO_BOX (points). */
const BOX = { w: 210, h: 78 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function LogoPlacer({ path, layout, onChange, accent, heading = 'INVOICE' }: { path: string; layout: LogoLayout; onChange: (l: LogoLayout) => void; accent: string; heading?: string }) {
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1.4); // screen pixels per PDF point
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ layout: Required<LogoLayout>; dist: number | null; at: { x: number; y: number } } | null>(null);
  const lay = { zoom: layout.zoom ?? 1, x: layout.x ?? 0, y: layout.y ?? 0 };

  useEffect(() => {
    let url = '';
    let gone = false;
    void apiBlob(path).then(({ blob }) => {
      url = URL.createObjectURL(blob);
      const i = new Image();
      i.onload = () => !gone && setImg({ url, w: i.naturalWidth, h: i.naturalHeight });
      i.src = url;
    });
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setK(el.clientWidth / BOX.w));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = img ? Math.min(BOX.w / img.w, BOX.h / img.h) : 1;
  const size = img ? { w: img.w * fit * lay.zoom, h: img.h * fit * lay.zoom } : { w: 0, h: 0 };
  const set = (l: Required<LogoLayout>) => onChange({ zoom: clamp(l.zoom, 0.2, 5), x: clamp(l.x, -1, 1), y: clamp(l.y, -1, 1) });
  const centre = () => set({ ...lay, x: (BOX.w - size.w) / 2 / BOX.w, y: (BOX.h - size.h) / 2 / BOX.h });

  const spread = () => {
    const ps = [...pointers.current.values()];
    return ps.length >= 2 ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : null;
  };
  const down = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start.current = { layout: lay, dist: spread(), at: { x: e.clientX, y: e.clientY } };
  };
  const move = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !start.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = start.current;
    const d = spread();
    if (d && s.dist) set({ ...s.layout, zoom: (s.layout.zoom * d) / s.dist });
    else if (pointers.current.size === 1) set({ ...s.layout, x: s.layout.x + (e.clientX - s.at.x) / (BOX.w * k), y: s.layout.y + (e.clientY - s.at.y) / (BOX.h * k) });
  };
  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    start.current = pointers.current.size ? { layout: lay, dist: spread(), at: [...pointers.current.values()][0]! } : null;
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="logo-sheet">
        <div ref={boxRef} className="logo-box" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ touchAction: 'none' }}>
          {img && <img src={img.url} alt="Your logo" draggable={false} style={{ left: lay.x * BOX.w * k, top: lay.y * BOX.h * k, width: size.w * k, height: size.h * k }} />}
        </div>
        <div className="logo-sheet-heading" style={{ color: accent }}>
          {heading}
        </div>
      </div>
      <label className="row small" style={{ gap: 10 }}>
        Size
        <input type="range" min={0.2} max={3} step={0.01} value={lay.zoom} onChange={(e) => set({ ...lay, zoom: Number(e.target.value) })} className="grow" aria-label="Logo size" />
      </label>
      <div className="row wrap">
        <button type="button" className="btn small" onClick={centre}>
          Centre it
        </button>
        <button type="button" className="btn small quiet" onClick={() => onChange({ zoom: 1, x: 0, y: 0 })}>
          Reset
        </button>
        <span className="xs muted">Drag the logo to move it; pinch or slide to size it. The dotted box is its space on the PDF.</span>
      </div>
    </div>
  );
}
