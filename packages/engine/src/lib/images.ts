/** Image checks (Shap's server has more: it also cleans logos for its PDFs). */
export const MAX_IMAGE_SIDE = 4096;
export const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Does this look like a whole JPEG: its segments run in order from the start marker to a frame
 * header of a sensible size and then the image data, and the file ends with the end marker?
 * (No JPEG decoder on the server; this catches a truncated or made-up file.)
 */
export function wholeJpeg(b: Buffer): boolean {
  if (!isJpeg(b) || b.length < 32 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
  let i = 2;
  let frame = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return false;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return false;
    // SOF0–SOF15 (not DHT C4, JPG C8 or DAC CC): height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 8) return false;
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      if (!w || !h || w > MAX_IMAGE_SIDE * 2 || h > MAX_IMAGE_SIDE * 2) return false;
      frame = true;
    }
    if (marker === 0xda) return frame; // start of scan: the image data follows
    i += 2 + len;
  }
  return false;
}
