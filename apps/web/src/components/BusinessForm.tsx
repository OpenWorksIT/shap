/** The business's logo: upload it, then place it (drag, size, centre) in its box on the PDF. */
import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { fileToBase64, shrinkImage } from '../lib/files';
import { LogoPlacer, type LogoLayout } from './LogoPlacer';
import { Icon, useToast } from './ui';

/** Upload goes to `uploadPath` (the business's or a trading name's logo). The placing is saved with the form. */
export function LogoField({ logoId, layout, accent, onLogo, onLayout, uploadPath = '/api/settings/logo' }: { logoId: string | null; layout: LogoLayout; accent: string; onLogo: (id: string | null) => void; onLayout: (l: LogoLayout) => void; uploadPath?: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const img = file.type === 'image/png' ? { dataBase64: await fileToBase64(file), mime: 'image/png' as const, filename: file.name } : await shrinkImage(file, 1200, 0.9);
      const r = await api<{ logoId: string }>(uploadPath, { body: img });
      onLogo(r.logoId);
      onLayout({ zoom: 1, x: 0, y: 0 });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t add the logo', 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="stack">
      {logoId ? <LogoPlacer path={`/api/attachments/${logoId}`} layout={layout} onChange={onLayout} accent={accent} /> : <p className="xs muted">No logo yet: the business name is printed in its place. A PNG with a see-through background looks best.</p>}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
          <Icon name="upload" size={18} />
          {logoId ? 'Change logo' : 'Add your logo'}
        </button>
        <input ref={input} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void add(e.target.files?.[0])} />
        {logoId && (
          <button type="button" className="btn quiet" onClick={() => void api(uploadPath, { method: 'DELETE' }).then(() => onLogo(null))}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
