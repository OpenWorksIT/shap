import { paysOutProfit, TERMS_VERSION } from '@shap/shared';
import { TermsGate } from './components/Terms';
import { lazy, Suspense, useEffect } from 'react';
import { reportUsage, shareMarket } from './lib/usage';
import { Navigate, Route, Routes } from 'react-router-dom';
import { FeedbackButton } from './components/Feedback';
import { Shell } from './components/Shell';
import { Loading } from './components/ui';
import { bootDone } from './lib/boot';
import { SessionProvider, useAuthed, useSession } from './lib/session';

const HomePage = lazy(() => import('./pages/Home'));
const LogPage = lazy(() => import('./pages/Log'));
const ProjectsPage = lazy(() => import('./pages/Projects'));
const ProjectPage = lazy(() => import('./pages/Project'));
const WorkersPage = lazy(() => import('./pages/Workers'));
const WorkerPage = lazy(() => import('./pages/Worker'));
const CostsPage = lazy(() => import('./pages/Costs'));
const DocumentsPage = lazy(() => import('./pages/Documents'));
const DocumentPage = lazy(() => import('./pages/Document'));
const ClientsPage = lazy(() => import('./pages/Clients'));
const ClientPage = lazy(() => import('./pages/Clients').then((m) => ({ default: m.ClientPage })));
const AccountsPage = lazy(() => import('./pages/Accounts'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const BackupPage = lazy(() => import('./pages/Backup'));
const PayrollPage = lazy(() => import('./pages/Payroll'));
const WelcomePage = lazy(() => import('./pages/Welcome'));
const BillsPage = lazy(() => import('./pages/Bills'));
const LogbookPage = lazy(() => import('./pages/Logbook'));
const GuidesPage = lazy(() => import('./pages/Guides'));
const MoveInPage = lazy(() => import('./pages/MoveIn'));

export function App() {
  return (
    <SessionProvider>
      <Suspense fallback={<Loading />}>
        <Opened />
      </Suspense>
    </SessionProvider>
  );
}

function Opened() {
  const { ready, error, ref } = useSession();
  // The loading screen (lib/boot.ts) stays up until there's something to show.
  useEffect(() => {
    if (ready) bootDone();
  }, [ready]);
  if (!ready) return null;
  if (error || !ref)
    return (
      <div className="stack narrow" style={{ padding: 24 }}>
        <h1>Shap couldn’t open your books</h1>
        <p className="small">{error}</p>
        <p className="small">Close the app completely and open it again. If it still won’t open, restore your latest backup from Settings → Backup once it does, or contact OpenWorks IT.</p>
      </div>
    );
  return <Books />;
}

function Books() {
  const { settings, has } = useAuthed();
  const pays = has('payroll') || (paysOutProfit(settings.businessType) && has('dividends'));
  // Last month's anonymous prices, once, a little after opening (never in the way of the first screens).
  useEffect(() => {
    if (!settings.setupDone || !settings.marketConsent || !settings.marketNoticeSeen) return;
    const t = setTimeout(() => void shareMarket(), 15_000);
    return () => clearTimeout(t);
  }, [settings.setupDone, settings.marketConsent, settings.marketNoticeSeen]);
  // The anonymous usage note (with consent): after an update, or once a month while it's used.
  useEffect(() => {
    if (!settings.setupDone || !settings.usageConsent) return;
    const t = setTimeout(() => void reportUsage(settings), 20_000);
    return () => clearTimeout(t);
    // Once per opening (and when consent changes), not on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.setupDone, settings.usageConsent]);
  if (!settings.setupDone) return <WelcomePage />;
  // The terms of use, accepted at the end of setup: again whenever the published terms change.
  if (settings.termsVersion !== TERMS_VERSION) return <TermsGate />;
  return (
    <Shell>
      <FeedbackButton />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/log" element={<LogPage />} />
          {has('jobs') && <Route path="/jobs" element={<ProjectsPage />} />}
          {has('jobs') && <Route path="/jobs/:id" element={<ProjectPage />} />}
          {has('workers') && <Route path="/workers" element={<WorkersPage />} />}
          {has('workers') && <Route path="/workers/:id" element={<WorkerPage />} />}
          {pays && <Route path="/payroll" element={<PayrollPage />} />}
          <Route path="/costs" element={<CostsPage />} />
          {has('bills') && <Route path="/bills" element={<BillsPage />} />}
          {has('logbook') && <Route path="/logbook" element={<LogbookPage />} />}
          {has('guides') && <Route path="/guides" element={<GuidesPage />} />}
          {has('guides') && <Route path="/guides/:topic" element={<GuidesPage />} />}
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/new" element={<DocumentPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="/move-in" element={<MoveInPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
