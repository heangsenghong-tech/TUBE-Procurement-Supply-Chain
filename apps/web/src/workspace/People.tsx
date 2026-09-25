import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../lib/api';
import { Card, ErrorText, Field, Loading, Modal, useCan } from '../lib/ui';
import { CsvImport } from './CsvImport';
import type { OrgUnit, Role, UserRow } from '../lib/types';

export function PeoplePanel() {
  const can = useCan();
  const [tab, setTab] = useState<'users' | 'units'>(can('users.manage') ? 'users' : 'units');
  return (
    <Card title="Users & Stores" note="People sign in with their Tube Cafe Google account — add them here first with their store or department and role. Each store/department's HOD approves its requests."
      actions={<>
        {can('users.manage') && <button className={tab === 'users' ? 'btn-primary' : 'btn-ghost'} style={tab === 'users' ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setTab('users')}>Users</button>}
        {can('master.manage') && <button className={tab === 'units' ? 'btn-primary' : 'btn-ghost'} style={tab === 'units' ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setTab('units')}>Stores &amp; departments</button>}
      </>}>
      {tab === 'users' ? <Users /> : <Units />}
    </Card>
  );
}

function Users() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: Role[] }>('/api/roles') });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const roleName = (k: string) => roles.data?.roles.find((r) => r.key === k)?.name ?? k;
  const rows = (users.data ?? []).filter((u) => !q || `${u.name} ${u.email} ${u.orgUnitName}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="flex gap-2" style={{ marginBottom: 10 }}>
        <input placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => setEditing('new')}>+ Add person</button>
      </div>
      <ErrorText error={users.error} />
      {users.isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>Name</th><th>Store / department</th><th>Roles</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.id} style={u.active ? {} : { opacity: 0.5 }}>
                <td>{u.name}<div className="sub">{u.email}</div>{!u.active && <span className="tag tag-mute">disabled</span>}</td>
                <td>{u.orgUnitName ?? '—'}</td>
                <td className="sub">{u.roleKeys.map(roleName).join(', ') || '—'}</td>
                <td className="sub">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'never'}</td>
                <td><button className="btn-ghost" onClick={() => setEditing(u)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CsvImport kind="users" label="Bulk add people — columns: Email, Name, Store/Department Code, Roles (e.g. requester; separate several with ;). Existing emails are updated." />
      {editing && roles.data && <UserModal user={editing === 'new' ? null : editing} roles={roles.data.roles} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserModal({ user, roles, onClose }: { user: UserRow | null; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const [f, setF] = useState({ email: user?.email ?? '', name: user?.name ?? '', orgUnitId: user?.orgUnitId ?? '', roleKeys: user?.roleKeys ?? ['requester'], active: user?.active ?? true });
  const [err, setErr] = useState<unknown>(null);
  const toggle = (k: string) => setF({ ...f, roleKeys: f.roleKeys.includes(k) ? f.roleKeys.filter((x) => x !== k) : [...f.roleKeys, k] });
  const save = async () => {
    try {
      const body = { ...f, orgUnitId: f.orgUnitId || null };
      if (user) await api.put(`/api/users/${user.id}`, body); else await api.post('/api/users', body);
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add person'} onClose={onClose}>
      <div className="two-col">
        <Field label="Google Workspace email"><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@tubecafecambodia.com" /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      </div>
      <Field label="Store / department">
        <select value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}>
          <option value="">—</option>
          {(units.data ?? []).filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.type})</option>)}
        </select>
      </Field>
      <label className="field">Roles</label>
      {roles.map((r) => (
        <label key={r.key} className="flex gap-2 items-start" style={{ fontSize: 13.5, margin: '5px 0' }}>
          <input type="checkbox" checked={f.roleKeys.includes(r.key)} onChange={() => toggle(r.key)} style={{ marginTop: 3 }} />
          <span>{r.name}<br /><span className="sub">{r.description}</span></span>
        </label>
      ))}
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '10px 0 12px' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (can sign in)</label>
      <button className="btn-primary" onClick={save}>Save</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}

function Units() {
  const can = useCan();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const [editing, setEditing] = useState<OrgUnit | 'new' | null>(null);
  return (
    <>
      <div className="flex justify-end" style={{ marginBottom: 10 }}><button className="btn-primary" onClick={() => setEditing('new')}>+ Add store/department</button></div>
      {units.isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>HOD (approver)</th><th></th></tr></thead>
            <tbody>{(units.data ?? []).map((u) => (
              <tr key={u.id} style={u.active ? {} : { opacity: 0.5 }}>
                <td>{u.code}</td><td>{u.name}</td>
                <td>{u.type === 'store' ? `Store · ${u.ownership ?? ''}` : 'HQ department'}</td>
                <td>{u.hodName ?? <span className="tag tag-warn">no HOD — SCM override</span>}</td>
                <td><button className="btn-ghost" onClick={() => setEditing(u)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CsvImport kind="org-units" label="Bulk add stores/departments — columns: Code, Name, Type (store/department), Ownership (franchiser/franchisee), HOD Email." />
      {editing && <UnitModal unit={editing === 'new' ? null : editing} canPickHod={can('users.manage')} onClose={() => setEditing(null)} />}
    </>
  );
}

function UnitModal({ unit, canPickHod, onClose }: { unit: OrgUnit | null; canPickHod: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], enabled: canPickHod, queryFn: () => api.get<UserRow[]>('/api/users') });
  const [f, setF] = useState({ code: unit?.code ?? '', name: unit?.name ?? '', type: unit?.type ?? 'store', ownership: unit?.ownership ?? 'franchisee', hodUserId: unit?.hodUserId ?? '', active: unit?.active ?? true });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      const body = { ...f, ownership: f.type === 'store' ? f.ownership : undefined, hodUserId: f.hodUserId || null };
      if (unit) await api.put(`/api/org-units/${unit.id}`, body); else await api.post('/api/org-units', body);
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={unit ? `Edit ${unit.name}` : 'Add store / department'} onClose={onClose}>
      <div className="two-col">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'store' | 'department' })}><option value="store">Store</option><option value="department">HQ department</option></select></Field>
        {f.type === 'store' && <Field label="Ownership"><select value={f.ownership} onChange={(e) => setF({ ...f, ownership: e.target.value })}><option value="franchiser">Franchiser (company)</option><option value="franchisee">Franchisee</option></select></Field>}
      </div>
      {canPickHod && (
        <Field label="Head of Department (approves this unit's requests)">
          <select value={f.hodUserId} onChange={(e) => setF({ ...f, hodUserId: e.target.value })}>
            <option value="">— none —</option>
            {(users.data ?? []).filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
        </Field>
      )}
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '4px 0 12px' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      <button className="btn-primary" onClick={save}>Save</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
