import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Loading } from './components/ui';
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
const WelcomePage = lazy(() => import('./pages/Welcome'));

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
  if (!ready) return <Loading />;
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
  if (!settings.setupDone) return <WelcomePage />;
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/log" element={<LogPage />} />
          {has('jobs') && <Route path="/jobs" element={<ProjectsPage />} />}
          {has('jobs') && <Route path="/jobs/:id" element={<ProjectPage />} />}
          {has('workers') && <Route path="/workers" element={<WorkersPage />} />}
          {has('workers') && <Route path="/workers/:id" element={<WorkerPage />} />}
          <Route path="/costs" element={<CostsPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/new" element={<DocumentPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/clients" element={<ClientsPage />} />
          <Route path="/clients/:id" element={<ClientPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
