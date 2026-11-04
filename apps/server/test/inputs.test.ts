/**
 * Files and text from outside, kept as tests so they're tried again on every change: logos that
 * must decode before a PDF is drawn, imports that can't hold the server up for everyone else,
 * and exports a spreadsheet can't run as formulas, whichever list separator it's set to.
 */
import { deflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeText, toDelimited } from '@shap/shared';
import { toCsv } from '../src/lib/books.js';
import { cleanImage } from '../src/lib/images.js';
import { zipTooBig } from '../src/lib/zip.js';
import { parseStatementAmount, parseStatementDate } from '../src/modules/bank/parse.js';
import { MAX_CSV_CELL, parseCsv, readClientCsv } from '../src/modules/clients.js';
import { readTracker } from '../src/modules/import/tracker.js';
import { suggestAccount } from '../src/modules/movein.js';
import { login, setup, type TestEnv } from './helpers.js';

// ---- small PNGs with a real signature, chunk layout and checksums
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer, length = data.length) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number, colour = 6) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8;
  d[9] = colour;
  return chunk('IHDR', d);
};
const END = chunk('IEND', Buffer.alloc(0));
const goodPng = () => Buffer.concat([SIG, ihdr(2, 2), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]))), END]);
/** A damaged file: the picture data isn't a zlib stream. */
const corruptPng = () => Buffer.concat([SIG, ihdr(64, 64), chunk('IDAT', Buffer.from('this is not a zlib stream at all')), END]);
/** Valid zlib data with a scanline filter that doesn't exist. */
const badFilterPng = () => Buffer.concat([SIG, ihdr(1, 1), chunk('IDAT', deflateSync(Buffer.from([7, 1, 2, 3, 4]))), END]);
/** 40-odd bytes whose picture data claims to be 2 GB. */
const hugeLengthPng = () => Buffer.concat([SIG, ihdr(1, 1, 2), chunk('IDAT', Buffer.from([0, 0, 0, 0]), 0x7fffffff)]);
/** Says it's 30 000 pixels square: decoding it would need gigabytes. */
const giantPng = () => Buffer.concat([SIG, ihdr(30000, 30000), chunk('IDAT', deflateSync(Buffer.alloc(1000))), END]);

const quick = <T>(fn: () => T): { value: T; ms: number } => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

describe('logos', () => {
  it('only lets a PNG through once it decodes, as a clean copy', () => {
    const clean = cleanImage(goodPng());
    expect(clean).not.toBeNull();
    expect(PNG.sync.read(clean!).width).toBe(2);
    for (const bad of [corruptPng(), badFilterPng(), hugeLengthPng(), giantPng(), Buffer.from('GIF89a not a logo')]) {
      const { value, ms } = quick(() => cleanImage(bad));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(500);
    }
    // A JPEG is embedded as it is (the PDF library reads its headers where errors can be caught).
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect(cleanImage(jpeg)).toBe(jpeg);
  });
});

describe('files from outside', () => {
  let env: TestEnv;
  let owner: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    owner = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('refuses a logo that can’t be read, and stores a clean copy of one that can', async () => {
    const up = (b: Buffer) => owner.call({ method: 'POST', url: '/api/settings/logo', payload: { filename: 'logo.png', mime: 'image/png', dataBase64: b.toString('base64') } });
    for (const bad of [corruptPng(), badFilterPng(), hugeLengthPng(), giantPng()]) expect((await up(bad)).statusCode).toBe(400);
    const ok = await up(goodPng());
    expect(ok.statusCode).toBe(200);
    const [a] = await env.sql<{ bytes: Buffer; mime: string }[]>`select bytes, mime from attachments where id = ${ok.json().logoId}`;
    expect(a!.mime).toBe('image/png');
    expect(PNG.sync.read(a!.bytes).width).toBe(2);
  });

  it('draws the PDF without the logo, and keeps running, when a stored logo is damaged', async () => {
    // A logo saved before this check, or put in some other way: it must not take the server down.
    const [a] = await env.sql<{ id: string }[]>`insert into attachments (filename, mime, size, bytes) values ('old.png', 'image/png', 50, ${corruptPng()}) returning id`;
    await env.sql`update settings set logo_id = ${a!.id} where id`;
    const doc = await owner.post('/api/documents', { kind: 'quote', issueDate: '2026-11-01', lines: [{ description: 'Roof repair', unitPriceCents: 100000 }] });
    const pdf = await owner.call({ method: 'GET', url: `/api/documents/${doc.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // The PDF library's own callbacks have had time to run: an error there would fail this file.
    await new Promise((r) => setTimeout(r, 300));
    expect((await owner.call({ method: 'GET', url: '/api/reference' })).statusCode).toBe(200);
    await env.sql`update settings set logo_id = null where id`;
  });

  it('checks a company file as if it were typed into Settings, and leaves out a logo it can’t read', async () => {
    const restore = (file: unknown) => owner.call({ method: 'POST', url: '/api/company-file', payload: { file, password: 'test-password-1' } });
    const f = (over: Record<string, unknown>) => ({ format: 'shap-company/1', ...over });
    // An accent that isn't a colour (it's used as a style in the app), and settings that aren't valid.
    expect((await restore(f({ brands: [{ name: 'Kestrel Roofing', accent: 'red;background:url(https://example.com/x)' }] }))).statusCode).toBe(400);
    expect((await restore(f({ settings: { vatRateBp: 'lots' } }))).statusCode).toBe(400);
    expect((await restore(f({ settings: { companyName: 'x'.repeat(5000) } }))).statusCode).toBe(400);
    expect((await restore(f({ clients: [{ name: 'Y'.repeat(5000) }] }))).statusCode).toBe(400);
    const r = await restore(f({ brands: [{ name: 'Kestrel Roofing', accent: '#2f6f4f', logo: { mime: 'image/png', dataBase64: corruptPng().toString('base64') } }] }));
    expect(r.statusCode).toBe(200);
    expect(r.json().restored).toMatchObject({ brands: 1, logosSkipped: 1 });
    const [b] = await env.sql<{ logoId: string | null }[]>`select logo_id from brands where name = 'Kestrel Roofing'`;
    expect(b!.logoId).toBeNull();
  });
});

describe('imports can’t hold the server up', () => {
  it('reads statement dates and amounts as before, and gives up on a crafted cell at once', () => {
    expect(parseStatementAmount('120.00 Dr')).toBe(-12000);
    expect(parseStatementAmount("'1 234,56")).toBe(123456);
    expect(parseStatementDate('03/11/2026')).toBe('2026-11-03');
    for (const cell of ["'".repeat(100_000) + 'x', ' '.repeat(100_000) + 'x', '1' + ' '.repeat(100_000) + 'x']) {
      const a = quick(() => parseStatementAmount(cell));
      const d = quick(() => parseStatementDate(cell));
      expect(a.value).toBeNull();
      expect(d.value).toBeNull();
      expect(a.ms + d.ms).toBeLessThan(50);
    }
  });

  it('caps a CSV’s cells and rows, and a client file’s size', () => {
    const [[cell]] = parseCsv(`${'z'.repeat(10_000)}\n`) as [[string]];
    expect(cell.length).toBe(MAX_CSV_CELL);
    expect(() => readClientCsv(['Name', ...Array.from({ length: 6000 }, (_, i) => `Client ${i}`)].join('\n'))).toThrow(/too many clients/);
  });

  it('matches a long trial-balance name to an account quickly', () => {
    const { ms } = quick(() => suggestAccount({ code: '', name: `accum${' '.repeat(200_000)}x`, cents: 0 } as never, []));
    expect(ms).toBeLessThan(100);
  });

  it('refuses a workbook that unpacks to far more than it says, before reading it', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Projects').getCell('A1').value = 'Job';
    const real = Buffer.from(await wb.xlsx.writeBuffer());
    expect(zipTooBig(real, 64 * 1024 * 1024)).toBeNull();
    // A stored-then-deflated part of 8 MB of zeros (a few KB packed), with its declared size
    // rewritten to say 10 bytes: the check inflates it under a limit rather than trusting the header.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(real);
    zip.file('xl/media/padding.bin', Buffer.alloc(8 * 1024 * 1024));
    const bomb = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    for (let i = 0; i + 46 < bomb.length; i++) if (bomb.readUInt32LE(i) === 0x02014b50) bomb.writeUInt32LE(10, i + 24);
    expect(zipTooBig(bomb, 1024 * 1024)).toMatch(/too big/);
    await expect(readTracker(Buffer.from('not a zip at all, just text'))).rejects.toThrow(/isn’t a workbook/);
  });

  it('refuses a sheet with a cell typed a million rows down, instead of walking every row', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Projects');
    ws.getCell('A1').value = 'Job';
    ws.getCell('A1000000').value = 'far down';
    const t = performance.now();
    await expect(readTracker(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/too big to read/);
    expect(performance.now() - t).toBeLessThan(5000);
  });
});

describe('exports a spreadsheet can’t run', () => {
  const splitOn = (line: string, d: string) => line.split(d).map((c) => c.replace(/^"/, ''));
  const runs = (c: string) => /^[=+\-@]/.test(c);

  it('neutralises a formula at the start and straight after any separator', () => {
    expect(safeText('=HYPERLINK("https://example.com")')).toBe(`'=HYPERLINK("https://example.com")`);
    expect(safeText('Tiles;=cmd|"/c calc"!A0')).toBe(`Tiles;'=cmd|"/c calc"!A0`);
    expect(safeText('a,+1+1')).toBe(`a,'+1+1`);
    // Ordinary text and numbers are left as they were.
    expect(safeText('Tiles, -5% for cash')).toBe('Tiles, -5% for cash');
    expect(safeText('-12.50')).toBe('-12.50');
    expect(safeText('-1234,56')).toBe('-1234,56');
  });

  it('writes no cell that starts a formula, whether Excel splits on , or ;', () => {
    const payload = ['Roof repair', 'x;=HYPERLINK("https://example.com")', 'y,@SUM(1)', 'z\t-2+3'];
    const server = toCsv(['Description'], payload.map((p) => [p])).replace(/^﻿/, '');
    const shared = toDelimited(['Description'], payload.map((p) => [safeText(p)]), { delimiter: ';', header: true }).replace(/^﻿/, '');
    for (const file of [server, shared]) {
      for (const line of file.split('\r\n').filter(Boolean)) {
        for (const d of [',', ';', '\t']) for (const c of splitOn(line, d)) expect(runs(c), `${JSON.stringify(c)} in ${JSON.stringify(line)}`).toBe(false);
      }
    }
  });
});
