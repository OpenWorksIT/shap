import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { AppLock } from './components/AppLock';
import { ToastProvider } from './components/ui';
import './styles.css';
import { startWebApp } from './lib/pwa';
import { openEarly } from './pocket/engine';

startWebApp();
// The books take a few seconds to open: start before React has drawn anything.
openEarly();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ToastProvider>
        <AppLock>
          <App />
        </AppLock>
      </ToastProvider>
    </HashRouter>
  </StrictMode>,
);
