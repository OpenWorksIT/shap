import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
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
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          {user.role !== 'accountant' && <Route path="/log" element={<LogPage />} />}
          <Route path="/jobs" element={<ProjectsPage />} />
          <Route path="/jobs/:id" element={<ProjectPage />} />
          {money && (
            <>
              <Route path="/workers" element={<WorkersPage />} />
              <Route path="/workers/:id" element={<WorkerPage />} />
              <Route path="/costs" element={<CostsPage />} />
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/documents/new" element={<DocumentPage />} />
              <Route path="/documents/:id" element={<DocumentPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:id" element={<ClientPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
            </>
          )}
          {user.role === 'owner' && <Route path="/settings" element={<SettingsPage />} />}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
