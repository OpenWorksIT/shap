/**
 * On a phone, Shap Pocket should feel like an app, not a web page in a frame: no pinch or
 * double-tap zoom (zooming in left the page bigger than the screen, with scroll bars), no page
 * sliding sideways, no rubber-band glow at the ends. Only in the app itself and the installed
 * web app on a touch screen; in an ordinary browser tab, zooming stays (people may need it).
 */
import { isNative } from './native';

export function holdStill() {
  const installed = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches && matchMedia('(pointer: coarse)').matches;
  if (!isNative() && !installed) return;
  document.documentElement.classList.add('app-feel');
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
}
