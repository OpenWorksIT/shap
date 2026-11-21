import { useEffect, useRef, useState } from 'react';
import { Drawer } from './ui';

interface Detector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}
interface DetectorClass {
  new (options?: { formats?: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}
const detectorClass = (): DetectorClass | null => (typeof window !== 'undefined' ? ((window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector ?? null) : null);

/** The barcodes on what a shop sells: EAN and UPC on packaging, Code 128 and 39 on labels, QR. */
const WANTED = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

/**
 * Whether this browser can read a barcode with the camera. Chrome on Android can; Safari and
 * Firefox can't yet, and there a barcode scanner (which types the code) or typing it works.
 */
export const canScan = (): boolean => Boolean(detectorClass() && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia);

/**
 * Reads one barcode with the device's camera. It's read on the device: nothing is sent anywhere,
 * and the camera stops as soon as a code is read or the drawer closes.
 */
export function BarcodeScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const found = useRef(onCode);
  found.current = onCode;
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    void (async () => {
      const Det = detectorClass();
      if (!Det) return setError('This browser can’t read barcodes with the camera. Type the code, or use a barcode scanner: it types the code for you.');
      try {
        const supported = (await Det.getSupportedFormats?.()) ?? [];
        const formats = WANTED.filter((f) => supported.includes(f));
        const det = new Det(formats.length ? { formats } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped || !video.current) return stop();
        video.current.srcObject = stream;
        await video.current.play();
        const look = async () => {
          if (stopped || !video.current) return;
          try {
            const code = (await det.detect(video.current)).map((b) => b.rawValue.trim()).find(Boolean);
            if (code) {
              stop();
              found.current(code.slice(0, 40));
              return;
            }
          } catch {
            // A frame that couldn't be read: try the next one.
          }
          timer = window.setTimeout(() => void look(), 200);
        };
        void look();
      } catch (err) {
        stop();
        setError(
          (err as Error)?.name === 'NotAllowedError'
            ? 'Shap isn’t allowed to use the camera. Allow it in the browser’s settings for this site, or type the code.'
            : 'The camera couldn’t start. Type the code instead.',
        );
      }
    })();
    return stop;
  }, []);

  return (
    <Drawer title="Scan a barcode" sub="Hold the barcode in the middle of the picture. It’s read on this device: nothing is sent anywhere." onClose={onClose}>
      {error ? <div className="banner alert small">{error}</div> : <video ref={video} className="scan-video" playsInline muted aria-label="The camera’s picture" />}
    </Drawer>
  );
}
