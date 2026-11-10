import { Notices } from './Notices';
import { ScreenClip } from './HowItWorks';
import { paysOutProfit } from '@shap/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { entityWords, useAuthed } from '../lib/session';
import { Logo } from './Logo';
import { Icon } from './ui';

interface Item {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

export function Shell({ children }: { children: ReactNode }) {
  const { settings, has } = useAuthed();
  const [more, setMore] = useState(false);
  const location = useLocation();
  useEffect(() => setMore(false), [location.pathname]);

  const all: (Item & { show: boolean })[] = [
    { to: '/', label: 'Home', icon: 'home', end: true, show: true },
    { to: '/log', label: 'Add', icon: 'log', show: true },
    { to: '/jobs', label: 'Jobs', icon: 'jobs', show: has('jobs') },
    { to: '/workers', label: 'Workers', icon: 'workers', show: has('workers') },
    { to: '/payroll', label: has('payroll') ? 'Payroll' : entityWords(settings.businessType).Payouts, icon: 'money', show: has('payroll') || (paysOutProfit(settings.businessType) && has('dividends')) },
    { to: '/sales', label: 'Sales', icon: 'till', show: has('sales') },
    { to: '/costs', label: 'Costs', icon: 'costs', show: true },
    { to: '/bills', label: 'Bills to pay', icon: 'bill', show: has('bills') },
    { to: '/logbook', label: 'Logbook', icon: 'car', show: has('logbook') },
    { to: '/documents', label: has('quotes') ? 'Quotes & invoices' : 'Invoices', icon: 'docs', show: true },
    { to: '/clients', label: 'Clients', icon: 'clients', show: true },
    { to: '/accounts', label: 'Accounts', icon: 'accounts', show: true },
    { to: '/guides', label: 'SARS guides', icon: 'book', show: has('guides') },
    { to: '/backup', label: 'Backup', icon: 'upload', show: true },
    { to: '/settings', label: 'Settings', icon: 'settings', show: true },
  ];
  const items = all.filter((i) => i.show);
  // Phones: four tabs plus "More". Log sits in the middle, where a thumb finds it.
  // A stall's second tab is the till.
  const tabKeys = ['/', has('sales') ? '/sales' : has('jobs') ? '/jobs' : '/costs', '/log', '/documents'];
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

      </aside>

      <header className="mobile-top">
        <Logo size={26} />
        <span className="grow ellipsis small muted">{settings.tradingName || settings.companyName}</span>
        <NavLink to="/settings" className="btn quiet small" aria-label="Settings">
          <Icon name="settings" size={22} />
        </NavLink>
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
