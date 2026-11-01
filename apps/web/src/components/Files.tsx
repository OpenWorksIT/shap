/** Files the books make (PDFs, CSVs, slip photos), shown or shared through the phone. */
import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { apiBlob } from '../lib/api';
import { openFile, shareFile } from '../lib/native';
import { useToast } from './ui';

/** A picture stored in the books (a logo, a slip), as an image. */
export function ApiImage({ path, ...img }: { path: string } & ImgHTMLAttributes<HTMLImageElement>) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    let made: string | null = null;
    apiBlob(path)
      .then(({ blob }) => {
        if (gone) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url ? <img {...img} src={url} /> : <span className={img.className} aria-hidden />;
}

/** A button that makes a file and opens it (view) or hands it to the share sheet (share). */
export function FileButton({ path, mode = 'share', title, className = 'btn', children, ...rest }: { path: string; mode?: 'open' | 'share'; title?: string; className?: string; children: ReactNode; 'aria-label'?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-label={rest['aria-label']}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          const { blob, filename } = await apiBlob(path);
          if (mode === 'open') await openFile(blob, filename);
          else if ((await shareFile(blob, filename, title ?? filename)) === 'downloaded') toast(`${filename} saved`);
        } catch (err) {
          toast((err as Error).message || 'Couldn’t make that file', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
