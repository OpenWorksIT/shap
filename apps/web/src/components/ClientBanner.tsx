import { useEffect, useState } from 'react';
import { api, ApiError, setBooksHere } from '../lib/api';
import { UNEXPECTED, setClientWords } from '../lib/words';

interface Here {
  client: { id: string; name: string } | null;
}

let cached: Promise<Here> | null = null;
/** Which practice client's books this browser has open (Shap Accountant), if any. */
export function useClientHere(): Here['client'] | undefined {
  const [h, setH] = useState<Here['client'] | undefined>(undefined);
  useEffect(() => {
    cached ??= api<Here>('/api/practice/here')
      .catch(() => ({ client: null }))
      .then((x) => (setBooksHere(x.client?.id ?? null), setClientWords(Boolean(x.client)), x));
    void cached.then((x) => setH(x.client));
  }, []);
  return h;
}

/**
 * Across the top while a client's books are open from the practice (Shap Accountant), so they're
 * never taken for the practice's own, with the way back.
 */
export function ClientBanner() {
  const client = useClientHere();
  const [busy, setBusy] = useState(false);
  if (!client) return null;
  const back = async () => {
    setBusy(true);
    try {
      await api('/api/practice/leave', { body: {} });
      window.location.assign('/practice');
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      alert(err instanceof ApiError ? err.message : UNEXPECTED);
      setBusy(false);
    }
  };
  return (
    <div className="demo-banner client-banner" role="status">
      <span className="grow">
        <strong>{client.name}</strong>: a client’s books, kept by your practice.
      </span>
      <button className="btn small" disabled={busy} onClick={() => void back()}>
        {busy ? '…' : 'Back to the practice'}
      </button>
    </div>
  );
}
