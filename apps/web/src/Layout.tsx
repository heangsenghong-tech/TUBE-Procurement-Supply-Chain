import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { DEFAULT_ROLES } from '@tube/shared';
import { api } from './lib/api';
import { useMe } from './lib/ui';
import type { InboxEntry } from './lib/types';

export const WORKSPACE_PERMISSIONS = ['procurement.operate', 'po.view', 'contract.view', 'pettycash.view', 'master.manage', 'users.manage', 'settings.manage', 'spend.view', 'audit.view'] as const;

function Cup() {
  return (
    <svg className="hero-cup" viewBox="0 0 150 150" aria-hidden="true">
      <ellipse cx="75" cy="122" rx="46" ry="9" fill="#1C1E22" opacity="0.10" />
      <path d="M40 60 h58 l-7 46 a10 10 0 0 1 -10 8 h-24 a10 10 0 0 1 -10 -8 z" fill="#1C1E22" opacity="0.85" />
      <path d="M40 60 h58 l-2 14 h-54 z" fill="#FFCD00" />
      <path d="M98 68 q18 -2 16 14 q-2 14 -19 12" fill="none" stroke="#1C1E22" strokeWidth="5" strokeLinecap="round" opacity="0.85" />
      <path d="M56 46 q-6 -9 0 -16" fill="none" stroke="#1C1E22" strokeWidth="4" strokeLinecap="round" opacity="0.35" />
      <path d="M70 42 q-6 -9 0 -16" fill="none" stroke="#1C1E22" strokeWidth="4" strokeLinecap="round" opacity="0.45" />
      <path d="M84 46 q-6 -9 0 -16" fill="none" stroke="#1C1E22" strokeWidth="4" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function Layout() {
  const { data: me, error } = useMe();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<InboxEntry[]>('/api/approvals/inbox'), enabled: !!me, refetchInterval: 60_000 });

  useEffect(() => {
    const close = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (error) return null; // api.ts redirects to /login on 401
  if (!me) return <div className="wrap"><div className="sub">Loading…</div></div>;

  const roleNames = me.roles.map((k) => DEFAULT_ROLES.find((r) => r.key === k)?.name ?? k);
  const showWorkspace = WORKSPACE_PERMISSIONS.some((p) => me.permissions.includes(p));
  const badge = me.roles.includes('super_admin') ? 'Admin' : me.permissions.includes('procurement.operate') ? 'Procurement'
    : me.roles.includes('ceo') ? 'CEO' : me.permissions.includes('pettycash.reconcile') ? 'Finance' : me.hodUnitIds.length ? 'HOD' : null;
  const pending = inbox.data?.length ?? 0;

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => {});
    navigate('/login');
    location.reload();
  };

  return (
    <div className="wrap">
      <header className="hero no-print">
        <Cup />
        <div className="relative z-10 flex justify-between items-center gap-3 flex-wrap">
          <NavLink to="/" className="flex items-center gap-3" style={{ textDecoration: 'none' }}>
            <img src="/tube-logo.png" alt="Tube Coffee" style={{ width: 52, height: 52 }} />
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Tube Procurement &amp; Supply Chain</h1>
              <div className="sub">Tube Cafe Co., Ltd. · Request → approval → PO → delivery</div>
            </div>
          </NavLink>
          <div className="relative" ref={popRef}>
            <button type="button" className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <span className="avatar">{initials(me.name)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{me.name}</span>
              {badge && <span className="role-badge">{badge}</span>}
            </button>
            {open && (
              <div className="popover">
                <div style={{ fontWeight: 600 }}>{me.name}</div>
                <div className="sub" style={{ marginBottom: 8 }}>{me.email}</div>
                <div className="sub">{me.orgUnit ? me.orgUnit.name : 'No store/department assigned'}</div>
                <div className="sub" style={{ marginBottom: 12 }}>{roleNames.join(' · ') || 'No roles yet'}</div>
                <button type="button" className="btn-ghost w-full" onClick={signOut}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {me.environment === 'training' && (
        <div className="banner banner-training no-print">
          <strong>TRAINING environment.</strong> Nothing here is real — practise freely. The live system is at its own address with its own data.
        </div>
      )}

      <nav className="navbar no-print">
        <NavLink to="/" end className={({ isActive }) => 'navbtn' + (isActive ? ' active' : '')}>Submit &amp; Track</NavLink>
        <NavLink to="/approvals" className={({ isActive }) => 'navbtn' + (isActive ? ' active' : '')}>
          Approvals{pending > 0 && <span className="count-dot">{pending}</span>}
        </NavLink>
        {showWorkspace && (
          <NavLink to="/workspace" className={({ isActive }) => 'navbtn' + (isActive ? ' active' : '')}>Procurement Workspace</NavLink>
        )}
      </nav>

      <Outlet />
    </div>
  );
}
