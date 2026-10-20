import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './components/ui';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';

// After an update the server has a new version: pick it up without needing a hard refresh.
// The new service worker takes over and the page reloads itself; checked on opening and whenever
// you come back to the tab.
if (!import.meta.env.VITE_API_URL && 'serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => document.visibilityState === 'visible' && void reg.update().catch(() => undefined);
      document.addEventListener('visibilitychange', check);
      setInterval(check, 15 * 60_000);
    },
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
