import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ROLE_LABELS } from '@shap/shared';
import { useAuthed } from '../lib/session';
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
  const { user, settings, isOwner, seesMoney } = useAuthed();
  const [account, setAccount] = useState(false);
  const [more, setMore] = useState(false);
  const location = useLocation();
  useEffect(() => setMore(false), [location.pathname]);

  const all: (Item & { show: boolean })[] = [
    { to: '/', label: 'Home', icon: 'home', end: true, show: true },
    { to: '/log', label: 'Log', icon: 'log', show: user.role !== 'accountant' },
    { to: '/jobs', label: 'Jobs', icon: 'jobs', show: true },
    { to: '/workers', label: 'Workers', icon: 'workers', show: seesMoney },
    { to: '/costs', label: 'Costs', icon: 'costs', show: seesMoney },
    { to: '/documents', label: 'Quotes & invoices', icon: 'docs', show: seesMoney },
    { to: '/clients', label: 'Clients', icon: 'clients', show: seesMoney },
    { to: '/accounts', label: 'Accounts', icon: 'accounts', show: seesMoney },
    { to: '/settings', label: 'Settings', icon: 'settings', show: isOwner },
  ];
  const items = all.filter((i) => i.show);
  // Phones: four tabs plus "More". Log sits in the middle, where a thumb finds it.
  const tabKeys = seesMoney ? ['/', '/jobs', '/log', '/documents'] : ['/', '/log', '/jobs'];
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
            <span className="faint xs">{ROLE_LABELS[user.role]}</span>
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
