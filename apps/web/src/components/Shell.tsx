import { Notices } from './Notices';
import { ScreenClip } from './HowItWorks';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ROLE_LABELS } from '@shap/shared';
import { screensFor } from '../lib/screens';
import { entityWords, useAuthed } from '../lib/session';
import { AccountDrawer } from './AccountDrawer';
import { Logo } from './Logo';
import { Avatar, Icon } from './ui';

interface Item {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, settings, can, has } = useAuthed();
  const may = screensFor(user, can, has, settings.businessType);
  const [account, setAccount] = useState(false);
  const [more, setMore] = useState(false);
  const location = useLocation();
  useEffect(() => setMore(false), [location.pathname]);

  const all: (Item & { show: boolean })[] = [
    { to: '/', label: 'Home', icon: 'home', end: true, show: true },
    { to: '/log', label: 'Log', icon: 'log', show: may['/log'] },
    { to: '/jobs', label: 'Jobs', icon: 'jobs', show: may['/jobs'] },
    { to: '/workers', label: 'Workers', icon: 'workers', show: may['/workers'] },
    { to: '/payroll', label: has('payroll') && can('payroll.view') ? 'Payroll' : entityWords(settings.businessType).Payouts, icon: 'money', show: may['/payroll'] },
    { to: '/sales', label: 'Sales', icon: 'till', show: may['/sales'] },
    { to: '/inventory', label: 'Inventory', icon: 'box', show: may['/inventory'] },
    { to: '/costs', label: 'Costs', icon: 'costs', show: may['/costs'] },
    { to: '/bills', label: 'Bills to pay', icon: 'bill', show: may['/bills'] },
    { to: '/logbook', label: 'Logbook', icon: 'car', show: may['/logbook'] },
    { to: '/documents', label: has('quotes') ? 'Quotes & invoices' : 'Invoices', icon: 'docs', show: may['/documents'] },
    { to: '/clients', label: 'Clients', icon: 'clients', show: may['/clients'] },
    { to: '/accounts', label: 'Accounts', icon: 'accounts', show: may['/accounts'] },
    { to: '/guides', label: 'SARS guides', icon: 'book', show: may['/guides'] },
    { to: '/settings', label: 'Settings', icon: 'settings', show: may['/settings'] },
  ];
  const items = all.filter((i) => i.show);
  // Phones: four tabs plus "More". Log sits in the middle, where a thumb finds it.
  // A shop's second tab is the till.
  // A shop's second tab is the till; then the jobs, or the costs. Then Log, then the invoices.
  const shown = (k: string) => items.some((i) => i.to === k);
  const second = ['/sales', '/jobs', '/costs', '/inventory'].find(shown);
  const tabKeys = ['/', ...(second ? [second] : []), ...(shown('/log') ? ['/log'] : []), ...['/documents', '/jobs', '/accounts'].filter((k) => shown(k) && k !== second)].slice(0, 4);
  const tabs = tabKeys.map((k) => items.find((i) => i.to === k)).filter(Boolean) as Item[];
  const overflow = items.filter((i) => !tabKeys.includes(i.to));

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <Logo size={30} />
          <strong>{settings.tradingName || settings.companyName}</strong>
        </div>
        <nav aria-label="Main" className="stack" style={{ gap: 2 }}>
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}${i.to === '/log' ? ' log' : ''}`}>
              <Icon name={i.icon} />
              {i.label}
            </NavLink>
          ))}
        </nav>
        <button className="me" onClick={() => setAccount(true)} aria-label="Your account">
          <Avatar name={user.name} size={34} />
          <span className="grow">
            <span className="strong small" style={{ display: 'block' }}>
              {user.name}
            </span>
            <span className="faint xs">{user.role === 'staff' && user.profile ? user.profile : ROLE_LABELS[user.role]}</span>
          </span>
        </button>
      </aside>

      <header className="mobile-top">
        <Logo size={26} />
        <span className="grow ellipsis small muted">{settings.tradingName || settings.companyName}</span>
        <button className="btn quiet small" onClick={() => setAccount(true)} aria-label="Your account">
          <Avatar name={user.name} size={30} />
        </button>
      </header>

      <main className="main" id="main">
        <Notices />
        <ScreenClip />
        {children}
      </main>

      <nav className="tabbar" aria-label="Main">
        {tabs.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `${isActive ? 'active' : ''}${i.to === '/log' ? ' log' : ''}`}>
            <span className="tab-icon">
              <Icon name={i.icon} size={i.to === '/log' ? 26 : 22} />
            </span>
            {i.to === '/documents' ? 'Invoices' : i.label}
          </NavLink>
        ))}
        {overflow.length > 0 && (
          <button className={more ? 'active' : ''} onClick={() => setMore(!more)} aria-expanded={more}>
            <span className="tab-icon">
              <Icon name="more" size={22} />
            </span>
            More
          </button>
        )}
      </nav>
      {more && (
        <>
          <div className="scrim" onClick={() => setMore(false)} />
          <div className="more-sheet" role="menu">
            {overflow.map((i) => (
              <NavLink key={i.to} to={i.to} className="more-link" role="menuitem">
                <Icon name={i.icon} />
                {i.label}
              </NavLink>
            ))}
          </div>
        </>
      )}
      {account && <AccountDrawer onClose={() => setAccount(false)} />}
    </div>
  );
}

export function PageHead({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="page-head">
      <div className="grow" style={{ minWidth: 0 }}>
        {back && (
          <NavLink to={back.to} className="back-link">
            <Icon name="chevronLeft" size={16} />
            {back.label}
          </NavLink>
        )}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="row wrap page-actions">{actions}</div>}
    </div>
  );
}
