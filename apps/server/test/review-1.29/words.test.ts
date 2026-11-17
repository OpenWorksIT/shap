/**
 * The words on screen and liability of 1.29.0 (CPDAUDIT.md), with the check of their fixes: a
 * Shap Pocket client's copy, its shares, and what the practice does there. Shap reads a share as it
 * finds it; the practice compiles and records the directors' approval (approving is theirs); what
 * Shap only infers from a share's stamp is said as an inference. Each test fails on the wording the
 * review was of.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayOf, POCKET_SHARE_NOTE, SHARE_WHAT_GOES } from '@shap/shared';
import { POCKET_COPY } from '../../src/modules/practice.js';

const ROOT = join(import.meta.dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the words of a Shap Pocket client’s copy (words 4, 7, 10; check 5, 7)', () => {
  const page = read('apps/web/src/pages/Practice.tsx');
  const docs = read('docs/ACCOUNTANT.md');
  const drawer = page.slice(page.indexOf('function ShareDrawer('));

  it('the copy says the practice compiles and records the approval of whoever signs, not that it approves', () => {
    expect(POCKET_COPY).not.toMatch(/compiles and approves/);
    // Many Pocket clients are sole proprietors or partnerships, not companies.
    expect(POCKET_COPY).toMatch(/Here the practice compiles their statements and records the approval of whoever signs them for the business \(its directors, members, partners or owner\)\./);
    expect(docs).not.toMatch(/compiles and approves the statements there/);
    expect(docs).toMatch(/compiles the statements there and\s+records the approval of whoever signs them for the business \(its directors, members, partners or\s+owner/);
  });

  it('who opens it: a Pocket client’s copy isn’t written in, so it doesn’t say they can do all the owner could', () => {
    expect(page).toMatch(/\{client\.kind === 'pocket' \? WHO_OPENS_POCKET : client\.kind === 'linked' \? WHO_OPENS_LINKED : WHO_OPENS_KEPT\}/);
    const pocket = page.slice(page.indexOf('const WHO_OPENS_POCKET'), page.indexOf('const POCKET_RESTORED'));
    expect(pocket).toMatch(/Their books change only in Shap Pocket \(on their phone or computer\)/);
    expect(pocket).toMatch(/records the approval of whoever signs them for the business/);
    expect(pocket).not.toMatch(/directors’ approval/);
    expect(pocket).not.toMatch(/reopening closed periods|everything the client’s owner could/);
    expect(docs).toMatch(/In a Shap Pocket client's copy, they\s+bring in the shares, compile, and record the approval/);
  });

  it('the drawer: as the share has them, as at the day it was made, and Shap doesn’t check them (words 4)', () => {
    expect(drawer).toMatch(/Their books are here as the share has them, as at \{formatDate\(result\.through\)\}/);
    expect(drawer).toMatch(/\{POCKET_SHARE_NOTE\}/);
    expect(POCKET_SHARE_NOTE).toMatch(/It doesn’t check it against the client’s records, and the figures stay theirs/);
  });

  it('a restored phone is what the stamp suggests, not what Shap knows (check 7)', () => {
    expect(page).not.toMatch(/The share is from books restored or begun again on their phone/);
    expect(page).not.toMatch(/'\s*\(from books restored on their phone\)'/);
    expect(page).toMatch(/which usually means their books were restored from a backup or begun again in Shap Pocket: check with them/);
    expect(page).toMatch(/their books restored in Shap Pocket, it seems/);
    expect(docs).toMatch(/a lower number made later is taken to mean the books were restored\s+or begun again on the phone/);
  });

  it('a new Pocket client’s card says to bring in its first share, and where they make it (words 7)', () => {
    expect(page).toMatch(/No share brought in yet: bring in their first share from Shap Pocket \(they make it under Accounts → Export\)\./);
  });

  it('dates a share in South Africa, not by the server’s clock (words 10)', () => {
    expect(page).toMatch(/brought in \{formatDate\(dayOf\(h\.pocket\.importedAt\)\)\}/);
    // Brought in at 00:30 on 17 November in Johannesburg: 22:30 the day before in UTC.
    expect(dayOf('2026-11-16T22:30:00.000Z')).toBe('2026-11-17');
    expect(dayOf(new Date('2026-11-17T21:59:00.000Z'))).toBe('2026-11-17');
  });

  it('the docs say what a share carries as the panel does (check 5)', () => {
    for (const goes of ['whatever their dates', 'income tax numbers (a', "sole proprietor's income tax number is their own", 'where trips went from and to', "the logbook's vehicle", 'the tax estimates saved in Pocket', 'on its trading names'])
      expect(docs.replace(/\s+/g, ' ')).toContain(goes);
    expect(docs).not.toMatch(/Left out: who signs in, photos of slips, people's ID, tax and bank numbers, and contact details/);
    expect(SHARE_WHAT_GOES).toMatch(/whatever its date/);
    expect(SHARE_WHAT_GOES).toMatch(/where your trips went from and to, and your vehicle’s name; and the tax estimates you’ve saved/);
    // On a computer there's no share sheet: a download.
    expect(SHARE_WHAT_GOES).toMatch(/Nothing goes until you choose where to send or save it/);
  });
});
