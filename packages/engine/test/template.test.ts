/**
 * The database worker loads the empty books only from the file next to the app
 * (apps/web/src/pocket/template.ts): on Android (https://localhost), on iOS
 * (capacitor://localhost) and on the web, and never from anywhere else.
 */
import { describe, expect, it } from 'vitest';
import { ownTemplate } from '../../../apps/web/src/pocket/template';

describe('the empty books’ address', () => {
  it('is the app’s own file, on each platform', () => {
    expect(ownTemplate('/assets/fresh-books.tar.gz', 'https://localhost/assets/engine.worker.js')).toBe('https://localhost/assets/fresh-books.tar.gz');
    expect(ownTemplate('capacitor://localhost/assets/fresh-books.tar.gz', 'capacitor://localhost/assets/engine.worker.js')).toBe('capacitor://localhost/assets/fresh-books.tar.gz');
    expect(ownTemplate('./fresh-books.tar.gz', 'capacitor://localhost/assets/engine.worker.js')).toBe('capacitor://localhost/assets/fresh-books.tar.gz');
    expect(ownTemplate('https://pocket.example.co.za/app/fresh-books.tar.gz', 'https://pocket.example.co.za/app/assets/w.js')).toBe('https://pocket.example.co.za/app/fresh-books.tar.gz');
  });

  it('is never anywhere else', () => {
    const here = 'capacitor://localhost/assets/engine.worker.js';
    expect(ownTemplate('capacitor://elsewhere/fresh-books.tar.gz', here)).toBeNull();
    expect(ownTemplate('https://localhost/fresh-books.tar.gz', here)).toBeNull();
    expect(ownTemplate('https://evil.example/fresh-books.tar.gz', 'https://localhost/w.js')).toBeNull();
    expect(ownTemplate('/assets/other.tar.gz', 'https://localhost/w.js')).toBeNull();
    expect(ownTemplate('/fresh-books.tar.gz?x=1#y', 'https://localhost/w.js')).toBe('https://localhost/fresh-books.tar.gz?x=1#y');
    expect(ownTemplate('http://[bad', 'https://localhost/w.js')).toBeNull();
  });
});
