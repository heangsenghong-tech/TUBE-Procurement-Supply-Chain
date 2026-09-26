import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { REQUEST_GROUPS, REQUEST_HANDLING, requestTypeInput } from '@tube/shared';
import { api } from '../lib/api';
import { Card, ErrorText, Field, Loading, Modal } from '../lib/ui';
import type { RequestType } from '../lib/types';

// What people can choose in "+ New Request". Retire a type instead of deleting it.
export function RequestTypesPanel() {
  const { data, isLoading, error } = useQuery({ queryKey: ['request-types', 'all'], queryFn: () => api.get<RequestType[]>('/api/request-types?all=true') });
  const [editing, setEditing] = useState<RequestType | 'new' | null>(null);
  return (
    <Card title="Request Types" note="The choices in + New Request. Each follows one workflow: purchase (catalog items, approval by value, then sourcing), sample, or service (HOD acknowledges, then Procurement handles it). Approval rules can target specific types."
      actions={<button className="btn-primary" onClick={() => setEditing('new')}>+ Add type</button>}>
      <ErrorText error={error} />
      {isLoading ? <Loading /> : (
        <table className="report">
          <thead><tr><th>Type</th><th>Group</th><th>Workflow</th><th></th></tr></thead>
          <tbody>{(data ?? []).map((t) => (
            <tr key={t.id} style={t.active ? {} : { opacity: 0.5 }}>
              <td>{t.name}{!t.active && <span className="tag tag-mute" style={{ marginLeft: 6 }}>retired</span>}<div className="sub">{t.key} · {t.description}</div></td>
              <td>{REQUEST_GROUPS[t.group]}</td>
              <td className="sub">{t.handling}</td>
              <td><button className="btn-ghost" onClick={() => setEditing(t)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {editing && <TypeModal type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TypeModal({ type, onClose }: { type: RequestType | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    key: type?.key ?? '', name: type?.name ?? '', group: type?.group ?? 'procurement', handling: type?.handling ?? 'purchase',
    description: type?.description ?? '', sortOrder: String(type?.sortOrder ?? 100), active: type?.active ?? true
  });
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const check = requestTypeInput.safeParse({ ...f, sortOrder: Number(f.sortOrder) });
    if (!check.success) { setErr(new Error(check.error.issues[0]?.message ?? 'Check the form.')); return; }
    try {
      if (type) await api.put(`/api/request-types/${type.id}`, check.data); else await api.post('/api/request-types', check.data);
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={type ? `Edit ${type.name}` : 'Add request type'} onClose={onClose}>
      <div className="two-col">
        <Field label="Name"><input value={f.name} onChange={set('name')} placeholder="e.g. Packaging" /></Field>
        <Field label="Key (used in approval rules)" hint="Lowercase, e.g. packaging. Can't change once used."><input value={f.key} onChange={set('key')} /></Field>
        <Field label="Group"><select value={f.group} onChange={set('group')}>{Object.entries(REQUEST_GROUPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Order in the list"><input type="number" min="0" value={f.sortOrder} onChange={set('sortOrder')} /></Field>
      </div>
      <Field label="Workflow" hint="Can't change once the type has requests.">
        <select value={f.handling} onChange={set('handling')}>{Object.entries(REQUEST_HANDLING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </Field>
      <Field label="Description shown to requesters"><input value={f.description} maxLength={300} onChange={set('description')} /></Field>
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '4px 0 12px' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Offered in + New Request</label>
      <button className="btn-primary" onClick={save}>Save</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
