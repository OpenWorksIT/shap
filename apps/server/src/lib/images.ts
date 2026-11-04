import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

/**
 * Logos: a stored image is only handed to the PDF library once it's known to decode.
 *
 * pdfkit decodes a PNG's pixels inside an asynchronous zlib callback, so a damaged or crafted
 * PNG (bad zlib data, a bad filter byte) throws where no try/catch can reach it and takes the
 * whole server down on the next quote or invoice PDF, including the unattended monthly run.
 * pngjs decodes synchronously and its errors can be caught, so a PNG is decoded here first
 * and re-encoded as a plain PNG pdfkit can always read. The size in the header is checked
 * before anything is decoded, so a small file that claims to be huge can't eat the memory.
 * JPEGs are embedded as they are (pdfkit reads their headers synchronously, so a bad one
 * fails where the caller's try/catch sees it).
 */
export const MAX_IMAGE_SIDE = 4096;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG);
export const isJpeg = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** A clean copy of a PNG or JPEG that pdfkit can safely read, or null when it can't be read. */
export function cleanImage(bytes: Buffer): Buffer | null {
  if (isJpeg(bytes)) return bytes;
  if (!isPng(bytes)) return null;
  // IHDR is always the first chunk: length(4) "IHDR"(4) width(4) height(4).
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  if (!w || !h || w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) return null;
  try {
    const png = PNG.sync.read(bytes);
    if (png.width !== w || png.height !== h) return null;
    return PNG.sync.write(png);
  } catch {
    return null;
  }
}

// The same few logos go on every PDF: keep their clean copies rather than re-decoding each time.
const cache = new Map<string, Buffer | null>();
export function cleanImageCached(bytes: Buffer): Buffer | null {
  const key = createHash('sha256').update(bytes).digest('hex');
  if (cache.has(key)) return cache.get(key)!;
  const clean = cleanImage(bytes);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, clean);
  return clean;
}
