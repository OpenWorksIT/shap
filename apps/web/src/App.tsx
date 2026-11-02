import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FeedbackButton } from './components/Feedback';
import { Shell } from './components/Shell';
import { featureOn } from '@shap/shared';
import type { Settings } from './lib/types';
import { Loading } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { LoginPage } from './pages/Login';

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
  const money = user.role !== 'capture';
  const settings = ref.settings as Settings;
  const has = (f: Parameters<typeof featureOn>[1]) => featureOn(settings.features, f);
  // New books: the owner answers the first-run questions; everyone else waits for that.
  if (!settings.setupDone && user.role === 'owner') return <WelcomePage canRestore={false} />;
  const pays = has('payroll') || (settings.businessType === 'company' && has('dividends'));
  return (
    <Shell>
      <FeedbackButton />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {user.role !== 'accountant' && <Route path="/log" element={<LogPage />} />}
          {has('jobs') && <Route path="/jobs" element={<ProjectsPage />} />}
          {has('jobs') && <Route path="/jobs/:id" element={<ProjectPage />} />}
          {money && (
            <>
              {has('workers') && <Route path="/workers" element={<WorkersPage />} />}
              {has('workers') && <Route path="/workers/:id" element={<WorkerPage />} />}
              {pays && <Route path="/payroll" element={<PayrollPage />} />}
              <Route path="/costs" element={<CostsPage />} />
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/documents/new" element={<DocumentPage />} />
              <Route path="/documents/:id" element={<DocumentPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:id" element={<ClientPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              {has('bills') && <Route path="/bills" element={<BillsPage />} />}
              {has('logbook') && <Route path="/logbook" element={<LogbookPage />} />}
              {has('guides') && <Route path="/guides" element={<GuidesPage />} />}
              {has('guides') && <Route path="/guides/:topic" element={<GuidesPage />} />}
            </>
          )}
          {user.role === 'owner' && <Route path="/settings" element={<SettingsPage />} />}
          {user.role === 'owner' && <Route path="/move-in" element={<MoveInPage />} />}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
