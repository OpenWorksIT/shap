import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Scanning is in the browser (the server never sees a picture), so the screens are read from source.
const web = (f: string) => readFileSync(join(__dirname, '..', '..', 'web', 'src', f), 'utf8');

describe('scanning barcodes with the camera', () => {
  const scanner = web('components/Barcode.tsx');
  const sales = web('pages/Sales.tsx');

  it('reads the code on the device, sends nothing anywhere, and stops the camera when done', () => {
    expect(scanner).toMatch(/BarcodeDetector/);
    expect(scanner).toMatch(/getUserMedia\(\{ video: \{ facingMode: 'environment' \}, audio: false \}\)/);
    expect(scanner).toMatch(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
    // Stopped when the drawer closes (the effect's clean-up) and once a code is read.
    expect(scanner).toMatch(/return stop;/);
    expect(scanner).toMatch(/stop\(\);\s+found\.current\(code\.slice\(0, 40\)\)/);
    expect(scanner).not.toMatch(/\bapi\(|fetch\(|XMLHttpRequest|sendBeacon/);
  });

  it('offers the camera only where the browser can read barcodes, and says what to do where it can’t', () => {
    expect(scanner).toMatch(/export const canScan = \(\): boolean => Boolean\(detectorClass\(\) && typeof navigator !== 'undefined' && navigator\.mediaDevices\?\.getUserMedia\)/);
    expect(scanner).toMatch(/This browser can’t read barcodes with the camera\. Type the code, or use a barcode scanner: it types the code for you\./);
    expect(sales.match(/\{canScan\(\) && \(/g)).toHaveLength(2);
  });

  it('puts the item with the scanned code on the slip, and a barcode scanner’s Enter does the same', () => {
    expect(sales).toMatch(/const it = \(items\.data \?\? \[\]\)\.find\(\(x\) => x\.active && x\.sku\.trim\(\)\.toLowerCase\(\) === code\);/);
    expect(sales).toMatch(/if \(e\.key !== 'Enter' \|\| !search\.trim\(\)\) return;\s+e\.preventDefault\(\);\s+byCode\(search\);/);
    expect(sales).toMatch(/onCode=\{\(code\) => \{\s+setScanning\(false\);\s+byCode\(code\);/);
    // On an item, the scanned code fills in its code (40 characters at most, as the server takes).
    expect(sales).toMatch(/onCode=\{\(code\) => \{\s+setScanning\(false\);\s+set\('sku', code\);/);
    expect(sales).toMatch(/maxLength=\{40\}/);
  });
});
