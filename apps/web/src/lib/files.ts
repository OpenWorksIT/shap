/** Reads a file as base64 (without the data: prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Shrinks a phone photo before upload: longest side `max` px, JPEG. A 4 MB camera
 * shot becomes ~200 KB, which matters on site with patchy data.
 */
export async function shrinkImage(file: File, max = 1600, quality = 0.8): Promise<{ dataBase64: string; mime: 'image/jpeg' | 'application/pdf' | 'image/png'; filename: string }> {
  if (file.type === 'application/pdf') return { dataBase64: await fileToBase64(file), mime: 'application/pdf', filename: file.name };
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That image couldn’t be read'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', quality));
    return { dataBase64: await fileToBase64(blob), mime: 'image/jpeg', filename: file.name.replace(/\.\w+$/, '') + '.jpg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downloads (or on phones, shares) a file fetched from the API. */
export async function shareOrDownload(url: string, filename: string, title: string): Promise<'shared' | 'downloaded'> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Couldn’t fetch the file');
  const blob = await res.blob();
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await nav.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'shared';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return 'downloaded';
}
