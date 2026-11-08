import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { AppLock } from './components/AppLock';
import { ToastProvider } from './components/ui';
import './styles.css';
import { startBoot } from './lib/boot';
import { holdStill } from './lib/native-feel';
import { startUpdateChecks } from './lib/appUpdate';
import { startWebApp } from './lib/pwa';
import { openEarly } from './pocket/engine';

startBoot();
holdStill();
startWebApp();
startUpdateChecks();
// The books take a few seconds to open: start before React has drawn anything, and fetch the
// first screens' code meanwhile so they're there when the books are.
openEarly();
void import('./pages/Home');
void import('./pages/Welcome');

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
