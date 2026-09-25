import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money } from '../lib/api';
import { Card, ErrorText, Field, Loading, Modal } from '../lib/ui';
import type { ApprovalRule, Role } from '../lib/types';

// The approval matrix, editable. Seeded with the company's real Policy & Procedure.
export function ApprovalRulesPanel() {
  const { data, isLoading, error } = useQuery({ queryKey: ['approval-rules'], queryFn: () => api.get<ApprovalRule[]>('/api/approval-rules') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: Role[] }>('/api/roles') });
  const [editing, setEditing] = useState<ApprovalRule | null>(null);
  const roleName = (k: string | null) => roles.data?.roles.find((r) => r.key === k)?.name ?? k;
  const range = (r: ApprovalRule) => r.maxAmount == null ? `${money(r.minAmount)} and above` : `${money(r.minAmount)} – under ${money(r.maxAmount)}`;
  return (
    <Card title="Approval Rules" note="Who approves what, from how much. Changes apply to new requests and POs — approvals already under way keep the chain they started with.">
      <ErrorText error={error} />
      {isLoading ? <Loading /> : (['request', 'po'] as const).map((kind) => (
        <div key={kind} style={{ marginBottom: 16 }}>
          <h3>{kind === 'request' ? 'Purchase requests' : 'Purchase orders'}</h3>
          <table className="report">
            <thead><tr><th>Value</th><th>Steps (in order)</th><th></th></tr></thead>
            <tbody>{(data ?? []).filter((r) => r.documentKind === kind).map((r) => (
              <tr key={r.id} style={r.active ? {} : { opacity: 0.5 }}>
                <td style={{ whiteSpace: 'nowrap' }}>{range(r)}{r.isPettyCash && <div><span className="tag tag-petty">petty cash</span></div>}</td>
                <td>{r.steps.length ? r.steps.map((s) => `${s.approverType === 'hod' ? 'HOD' : roleName(s.roleKey)} (${s.actionLabel})`).join(' → ') : <span className="sub">No approval needed</span>}</td>
                <td><button className="btn-ghost" onClick={() => setEditing(r)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {editing && roles.data && <RuleModal rule={editing} roles={roles.data.roles.filter((r) => r.approver)} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RuleModal({ rule, roles, onClose }: { rule: ApprovalRule; roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule.name);
  const [min, setMin] = useState(String(rule.minAmount));
  const [max, setMax] = useState(rule.maxAmount == null ? '' : String(rule.maxAmount));
  const [active, setActive] = useState(rule.active);
  const [steps, setSteps] = useState(rule.steps.map((s) => ({ approverType: s.approverType, roleKey: s.roleKey ?? '', actionLabel: s.actionLabel })));
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    try {
      await api.put(`/api/approval-rules/${rule.id}`, {
        name, minAmount: Number(min), maxAmount: max === '' ? null : Number(max), isPettyCash: rule.isPettyCash, active,
        steps: steps.map((s) => ({ approverType: s.approverType, roleKey: s.approverType === 'role' ? s.roleKey : undefined, actionLabel: s.actionLabel }))
      });
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={`Edit rule: ${rule.name}`} onClose={onClose}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="two-col">
        <Field label="From (USD, inclusive)"><input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Up to (USD, exclusive — empty for no limit)"><input type="number" min="0" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
      </div>
      <label className="field">Steps</label>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 36px', gap: 6, marginBottom: 6 }}>
          <select value={s.approverType} disabled={rule.documentKind === 'po'} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, approverType: e.target.value as 'hod' | 'role' } : x)))}>
            {rule.documentKind === 'request' && <option value="hod">Requester's HOD</option>}
            <option value="role">Role</option>
          </select>
          <select value={s.roleKey} disabled={s.approverType === 'hod'} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, roleKey: e.target.value } : x)))}>
            <option value="">—</option>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
          <input value={s.actionLabel} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, actionLabel: e.target.value } : x)))} placeholder="e.g. Approved" />
          <button className="btn-ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step">×</button>
        </div>
      ))}
      {!rule.isPettyCash && <button className="btn-ghost" style={{ marginBottom: 12 }} onClick={() => setSteps([...steps, { approverType: 'role', roleKey: '', actionLabel: 'Approved' }])}>+ Add step</button>}
      {rule.isPettyCash && <div className="sub" style={{ marginBottom: 12 }}>Petty cash always has exactly one step: the requester's HOD.</div>}
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, marginBottom: 12 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      <button className="btn-primary" onClick={save}>Save rule</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
