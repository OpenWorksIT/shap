/** Files Shap makes (PDFs, CSVs, payslips): open them, or share/download them. */
import { useState, type ReactNode } from 'react';
import { apiBlob } from '../lib/api';
import { useToast } from './ui';

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Opens (view) or shares / downloads (share) a file from the server. */
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
          if (mode === 'open') {
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            return;
          }
          const file = new File([blob], filename, { type: blob.type });
          const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
          if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try {
              await nav.share({ files: [file], title: title ?? filename });
              return;
            } catch (err) {
              if ((err as Error).name === 'AbortError') return;
            }
          }
          download(blob, filename);
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
