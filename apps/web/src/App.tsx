import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { listenForReminder } from './lib/backup';
import { FeedbackButton } from './components/Feedback';
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
  const pays = has('payroll') || (settings.businessType === 'company' && has('dividends'));
  const navigate = useNavigate();
  useEffect(() => void listenForReminder(navigate), [navigate]);
  if (!settings.setupDone) return <WelcomePage />;
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
