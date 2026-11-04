import { inflateRawSync } from 'node:zlib';

/**
 * Checks that a zip (an .xlsx workbook) unpacks to no more than `maxBytes` in all, before a
 * library that unpacks everything into memory is given it. The sizes a zip declares can be
 * false, so each entry is actually inflated under a hard output limit (zlib stops at the limit
 * rather than finishing). A small "zip bomb" is refused without using up the server's memory.
 * Returns an error message, or null when the file is fine.
 */
export function zipTooBig(buf: Buffer, maxBytes: number, maxEntries = 2000): string | null {
  // End of central directory: in the last 64 KB + 22 bytes.
  const from = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 'That file isn’t a workbook (.xlsx)';
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) return 'That workbook is too big to read';
  if (entries > maxEntries) return 'That workbook has too many parts';
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return 'That workbook is damaged';
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const local = buf.readUInt32LE(p + 42);
    const nameLen = buf.readUInt16LE(p + 28);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return 'That workbook is damaged';
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    const room = maxBytes - total;
    if (method === 0) total += data.length;
    else if (method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: room + 1 }).length;
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) return 'That workbook is too big to read';
        return 'That workbook is damaged';
      }
    } else return 'That workbook uses a kind of compression Shap can’t read';
    if (total > maxBytes) return 'That workbook is too big to read';
  }
  return null;
}
