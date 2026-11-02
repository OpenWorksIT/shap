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
 * How slips are kept: grey, about a megapixel, gently compressed. Plenty to read every line on
 * screen, at roughly a fifth of a colour photo's size (about 60–120 KB). An archived year squeezes
 * them again, smaller still.
 */
export const SLIP = { pixels: 1_000_000, quality: 0.6 } as const;
export const ARCHIVED_SLIP = { pixels: 450_000, quality: 0.5 } as const;

async function loadImage(src: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(src);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That image couldn’t be read'));
      i.src = url;
    });
  } finally {
    // The image keeps its pixels once loaded.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** A photo as a grey JPEG of at most `pixels`, with the contrast lifted a little for text. */
export async function squeezePhoto(src: Blob, opts: { pixels: number; quality: number }): Promise<Blob> {
  const img = await loadImage(src);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const scale = Math.min(1, Math.sqrt(opts.pixels / (w0 * h0)));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    // Luminance, then a gentle S-curve around the middle so print stands out from the paper.
    const y = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    const v = Math.max(0, Math.min(255, (y - 128) * 1.18 + 132));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the photo smaller'))), 'image/jpeg', opts.quality));
}

/** A slip photo ready to store (PDFs are kept as they are). */
export async function compressSlip(file: File): Promise<{ dataBase64: string; mime: 'image/jpeg' | 'application/pdf'; filename: string }> {
  if (file.type === 'application/pdf') return { dataBase64: await fileToBase64(file), mime: 'application/pdf', filename: file.name };
  const blob = await squeezePhoto(file, SLIP);
  return { dataBase64: await fileToBase64(blob), mime: 'image/jpeg', filename: file.name.replace(/\.\w+$/, '') + '.jpg' };
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
