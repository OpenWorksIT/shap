import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FeedbackButton } from './components/Feedback';
import { Shell } from './components/Shell';
import { featureOn, TERMS_VERSION, type Task } from '@shap/shared';
import { screensFor } from './lib/screens';
import { TermsGate } from './components/Terms';
import type { Settings } from './lib/types';
import { Loading } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { LoginPage } from './pages/Login';
import { TestServerBanner } from './components/TestServer';

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
const PayrollPage = lazy(() => import('./pages/Payroll'));
const WelcomePage = lazy(() => import('./pages/Welcome'));
const BillsPage = lazy(() => import('./pages/Bills'));
const LogbookPage = lazy(() => import('./pages/Logbook'));
const GuidesPage = lazy(() => import('./pages/Guides'));
const MoveInPage = lazy(() => import('./pages/MoveIn'));
const SalesPage = lazy(() => import('./pages/Sales'));
const InventoryPage = lazy(() => import('./pages/Inventory'));

export function App() {
  return (
    <SessionProvider>
      <Suspense fallback={<Loading />}>
        <Authed />
      </Suspense>
    </SessionProvider>
  );
}

function Authed() {
  const { user, ref, ready } = useSession();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!user || !ref) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }
  const settings = ref.settings as Settings;
  const has = (f: Parameters<typeof featureOn>[1]) => featureOn(settings.features, f);
  const can = (t: Task) => user.role === 'owner' || (user.access ?? []).includes(t);
  const may = screensFor(user, can, has, settings.businessType);
  // New books: the owner answers the first-run questions; everyone else waits for that.
  if (!settings.setupDone && user.role === 'owner')
    return (
      <>
        <TestServerBanner />
        <WelcomePage canRestore={false} />
      </>
    );
  // The terms of use, accepted at the end of setup: again whenever the published terms change.
  if (user.role === 'owner' && settings.termsVersion !== TERMS_VERSION) return <TermsGate />;
  return (
    <Shell>
      <FeedbackButton />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {may['/log'] && <Route path="/log" element={<LogPage />} />}
          {may['/jobs'] && <Route path="/jobs" element={<ProjectsPage />} />}
          {may['/jobs'] && <Route path="/jobs/:id" element={<ProjectPage />} />}
          {may['/workers'] && <Route path="/workers" element={<WorkersPage />} />}
          {may['/workers'] && <Route path="/workers/:id" element={<WorkerPage />} />}
          {may['/payroll'] && <Route path="/payroll" element={<PayrollPage />} />}
          {may['/sales'] && <Route path="/sales" element={<SalesPage />} />}
          {may['/inventory'] && <Route path="/inventory" element={<InventoryPage />} />}
          {may['/costs'] && <Route path="/costs" element={<CostsPage />} />}
          {may['/documents'] && <Route path="/documents" element={<DocumentsPage />} />}
          {can('documents.edit') && <Route path="/documents/new" element={<DocumentPage />} />}
          {may['/documents'] && <Route path="/documents/:id" element={<DocumentPage />} />}
          {may['/clients'] && <Route path="/clients" element={<ClientsPage />} />}
          {may['/clients'] && <Route path="/clients/:id" element={<ClientPage />} />}
          {may['/accounts'] && <Route path="/accounts" element={<AccountsPage />} />}
          {may['/bills'] && <Route path="/bills" element={<BillsPage />} />}
          {may['/logbook'] && <Route path="/logbook" element={<LogbookPage />} />}
          {may['/guides'] && <Route path="/guides" element={<GuidesPage />} />}
          {may['/guides'] && <Route path="/guides/:topic" element={<GuidesPage />} />}
          {may['/settings'] && <Route path="/settings" element={<SettingsPage />} />}
          {may['/move-in'] && <Route path="/move-in" element={<MoveInPage />} />}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
