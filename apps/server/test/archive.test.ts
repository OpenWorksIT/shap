/** Archiving a closed year: its slip photos squeezed, nothing else changed. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, ref, setup, type TestEnv } from './helpers.js';

// A tiny but real JPEG (1×1 px) and a "bigger" one: the same with padding in a comment segment.
const tiny = Buffer.concat([Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), Buffer.from([0xff, 0xd9])]);
const big = Buffer.concat([tiny.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x40, 0x02]), Buffer.alloc(0x4000, 0x20), tiny.subarray(2)]);

describe('archiving a year', () => {
  let env: TestEnv;
  let me: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    env = await setup();
    me = await login(env.app, 'owner@example.co.za');
  });
  afterAll(() => env.close());

  it('needs the year locked, squeezes its photos and records the space saved', async () => {
    const r = await ref(env.sql);
    const att = await me.post('/api/attachments', { filename: 'slip.jpg', mime: 'image/jpeg', dataBase64: big.toString('base64') });
    await me.post('/api/costs', { date: '2025-06-10', description: 'Cable', amountCents: 38990, categoryId: await r.cat('Parts'), sourceId: await r.src('Business bank'), receiptId: att.id });
    const info = await me.get('/api/archive');
    const year = info.years.find((y: { fyEnd: string }) => y.fyEnd === '2026-02-28');
    expect(year).toMatchObject({ slips: 1, locked: false, archived: null });
    expect((await me.call({ method: 'POST', url: '/api/archive/2026-02-28', payload: { photos: 0, bytesBefore: 0, bytesAfter: 0 } })).statusCode).toBe(400);

    const photos = await me.get('/api/archive/2026-02-28/photos');
    expect(photos.map((p: { id: string }) => p.id)).toEqual([att.id]);
    // Only once the year is closed.
    expect((await me.call({ method: 'PUT', url: `/api/attachments/${att.id}`, payload: { mime: 'image/jpeg', dataBase64: tiny.toString('base64') } })).statusCode).toBe(400);
    await me.post('/api/periods/lock', { through: '2026-02-28' });
    // A smaller version replaces it; a bigger one is ignored; a broken one is refused.
    expect(await me.post(`/api/attachments/${att.id}`, { mime: 'image/jpeg', dataBase64: big.toString('base64') }, 'PUT')).toMatchObject({ kept: false });
    expect((await me.call({ method: 'PUT', url: `/api/attachments/${att.id}`, payload: { mime: 'image/jpeg', dataBase64: tiny.subarray(0, tiny.length - 2).toString('base64') } })).statusCode).toBe(400);
    expect(await me.post(`/api/attachments/${att.id}`, { mime: 'image/jpeg', dataBase64: tiny.toString('base64') }, 'PUT')).toMatchObject({ kept: true, size: tiny.length });
    const [logged] = await env.sql<{ details: { before: string; after: string } }[]>`select details from audit_log where action = 'shrink' and entity_id = ${att.id}`;
    expect(logged!.details.before).toMatch(/^[0-9a-f]{64}$/);
    expect(logged!.details.after).not.toBe(logged!.details.before);
    // A logo (or anything that isn't a slip) can't be swapped this way.
    const logo = await me.post('/api/attachments', { filename: 'logo.jpg', mime: 'image/jpeg', dataBase64: big.toString('base64') });
    expect((await me.call({ method: 'PUT', url: `/api/attachments/${logo.id}`, payload: { mime: 'image/jpeg', dataBase64: tiny.toString('base64') } })).statusCode).toBe(400);

    await me.post('/api/archive/2026-02-28', { photos: 1, bytesBefore: big.length, bytesAfter: tiny.length });
    const after = (await me.get('/api/archive')).years.find((y: { fyEnd: string }) => y.fyEnd === '2026-02-28');
    expect(after).toMatchObject({ locked: true, bytes: tiny.length, archived: { photos: 1, bytesBefore: big.length, bytesAfter: tiny.length } });
  });
});
