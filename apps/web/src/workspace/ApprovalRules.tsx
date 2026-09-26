import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approvalRuleInput, type ApprovalConditions } from '@tube/shared';
import { api, money } from '../lib/api';
import { Card, ErrorText, Field, Loading, Modal } from '../lib/ui';
import type { ApprovalRule, OrgUnit, RequestType, Role } from '../lib/types';

// The approval matrix, editable. Seeded with the company's real Policy & Procedure; rules can be
// narrowed by request type, store/department, category, Direct/Indirect or urgency. The most
// specific matching rule wins.
export function ApprovalRulesPanel() {
  const { data, isLoading, error } = useQuery({ queryKey: ['approval-rules'], queryFn: () => api.get<ApprovalRule[]>('/api/approval-rules') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: Role[] }>('/api/roles') });
  const types = useQuery({ queryKey: ['request-types', 'all'], queryFn: () => api.get<RequestType[]>('/api/request-types?all=true') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const [editing, setEditing] = useState<ApprovalRule | { new: 'request' | 'po' } | null>(null);
  const roleName = (k: string | null) => roles.data?.roles.find((r) => r.key === k)?.name ?? k;
  const range = (r: ApprovalRule) => r.maxAmount == null ? `${money(r.minAmount)} and above` : `${money(r.minAmount)} – under ${money(r.maxAmount)}`;
  const describe = (c: ApprovalConditions) => {
    const parts: string[] = [];
    if (c.handling) parts.push(c.handling === 'service' ? 'service requests' : 'purchase requests');
    if (c.requestTypeKeys) parts.push(c.requestTypeKeys.map((k) => types.data?.find((t) => t.key === k)?.name ?? k).join(' / '));
    if (c.track) parts.push(c.track === 'store' ? 'stores' : 'HQ departments');
    if (c.orgUnitIds) parts.push(c.orgUnitIds.map((id) => units.data?.find((u) => u.id === id)?.name ?? '?').join(', '));
    if (c.categories) parts.push(`all ${c.categories.join(' / ')}`);
    if (c.procurementTypes) parts.push(`all ${c.procurementTypes.join(' / ')}`);
    if (c.urgent !== undefined) parts.push(c.urgent ? 'urgent' : 'not urgent');
    return parts.join(' · ');
  };
  const ready = roles.data && types.data && units.data;
  return (
    <>
      <Card title="Approval Rules" note="Who approves what, from how much. The most specific rule that matches wins. Changes apply to new requests and POs — approvals already under way keep their chain."
        actions={<>
          <button className="btn-primary" onClick={() => setEditing({ new: 'request' })}>+ Request rule</button>
          <button className="btn-ghost" onClick={() => setEditing({ new: 'po' })}>+ PO rule</button></>}>
        <ErrorText error={error} />
        {isLoading ? <Loading /> : (['request', 'po'] as const).map((kind) => (
          <div key={kind} style={{ marginBottom: 16 }}>
            <h3>{kind === 'request' ? 'Requests' : 'Purchase orders'}</h3>
            <div className="table-wrap">
              <table className="report">
                <thead><tr><th>Rule</th><th>Applies to</th><th>Steps (in order)</th><th></th></tr></thead>
                <tbody>{(data ?? []).filter((r) => r.documentKind === kind).map((r) => (
                  <tr key={r.id} style={r.active ? {} : { opacity: 0.5 }}>
                    <td>{r.name}{r.isPettyCash && <div><span className="tag tag-petty">petty cash</span></div>}{!r.active && <div><span className="tag tag-mute">off</span></div>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{(r.conditions as ApprovalConditions).handling === 'service' ? 'any' : range(r)}<div className="sub" style={{ whiteSpace: 'normal' }}>{describe(r.conditions) || 'everything else'}</div></td>
                    <td>{r.steps.length ? r.steps.map((s) => `${s.approverType === 'hod' ? 'HOD' : roleName(s.roleKey)} (${s.actionLabel})`).join(' → ') : <span className="sub">No approval needed</span>}</td>
                    <td><button className="btn-ghost" onClick={() => setEditing(r)}>Edit</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        ))}
        {editing && ready && (
          <RuleModal rule={'new' in editing ? null : editing} kind={'new' in editing ? editing.new : editing.documentKind}
            roles={roles.data.roles.filter((r) => r.approver)} types={types.data} units={units.data} onClose={() => setEditing(null)} />
        )}
      </Card>
      {ready && <Preview types={types.data} units={units.data} />}
    </>
  );
}

function toggle<T>(list: T[] | undefined, v: T): T[] | undefined {
  const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v];
  return next.length ? next : undefined;
}

function Checks<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T[] | undefined; onChange: (v: T[] | undefined) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map((o) => (
        <label key={o.value} className="flex gap-1 items-center" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={!!value?.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} /> {o.label}
        </label>
      ))}
    </div>
  );
}

function RuleModal({ rule, kind, roles, types, units, onClose }: {
  rule: ApprovalRule | null; kind: 'request' | 'po'; roles: Role[]; types: RequestType[]; units: OrgUnit[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule?.name ?? '');
  const [min, setMin] = useState(String(rule?.minAmount ?? 0));
  const [max, setMax] = useState(rule?.maxAmount == null ? '' : String(rule.maxAmount));
  const [active, setActive] = useState(rule?.active ?? true);
  const [c, setC] = useState<ApprovalConditions>(rule?.conditions ?? {});
  const [steps, setSteps] = useState((rule?.steps ?? []).map((s) => ({ approverType: s.approverType, roleKey: s.roleKey ?? '', actionLabel: s.actionLabel })));
  const [err, setErr] = useState<unknown>(null);
  const isPetty = rule?.isPettyCash ?? false;
  const service = c.handling === 'service';

  const save = async () => {
    const body = {
      documentKind: kind, name, minAmount: service ? 0 : Number(min), maxAmount: service || max === '' ? null : Number(max), isPettyCash: isPetty, active, conditions: c,
      steps: steps.map((s) => ({ approverType: s.approverType, roleKey: s.approverType === 'role' ? s.roleKey : undefined, actionLabel: s.actionLabel }))
    };
    const check = approvalRuleInput.safeParse(body);
    if (!check.success) { setErr(new Error(check.error.issues[0]?.message ?? 'Check the rule.')); return; }
    try {
      if (rule) await api.put(`/api/approval-rules/${rule.id}`, check.data); else await api.post('/api/approval-rules', check.data);
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  const set = (patch: Partial<ApprovalConditions>) => setC((x) => {
    const next = { ...x, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next as ApprovalConditions;
  });

  return (
    <Modal title={rule ? `Edit rule: ${rule.name}` : kind === 'request' ? 'New request rule' : 'New PO rule'} onClose={onClose}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT purchases $300+" /></Field>
      {!service && (
        <div className="two-col">
          <Field label="From (USD, inclusive)"><input type="number" min="0" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
          <Field label="Up to (USD, exclusive — empty for no limit)"><input type="number" min="0" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        </div>
      )}

      <label className="field">Applies only when… <span className="sub">(leave everything empty for a general rule)</span></label>
      <div className="card" style={{ padding: 12, background: 'var(--ground)' }}>
        {kind === 'request' && <>
          <Field label="Workflow">
            <select value={c.handling ?? ''} disabled={isPetty} onChange={(e) => set({ handling: (e.target.value || undefined) as ApprovalConditions['handling'] })}>
              <option value="">Any</option><option value="purchase">Purchase requests</option><option value="service">Service requests</option>
            </select>
          </Field>
          <Field label="Request types">
            <Checks options={types.filter((t) => t.handling !== 'sample').map((t) => ({ value: t.key, label: t.name }))} value={c.requestTypeKeys} onChange={(v) => set({ requestTypeKeys: v })} />
          </Field>
          <Field label="Store or HQ">
            <select value={c.track ?? ''} onChange={(e) => set({ track: (e.target.value || undefined) as ApprovalConditions['track'] })}>
              <option value="">Either</option><option value="store">Stores</option><option value="hq">HQ departments</option>
            </select>
          </Field>
          <Field label="Specific stores / departments">
            <Checks options={units.filter((u) => u.active).map((u) => ({ value: u.id, label: u.name }))} value={c.orgUnitIds} onChange={(v) => set({ orgUnitIds: v })} />
          </Field>
        </>}
        {!service && <>
          <Field label="Every item is in category"><Checks options={[{ value: 'Food' as const, label: 'Food' }, { value: 'Non-food' as const, label: 'Non-food' }]} value={c.categories} onChange={(v) => set({ categories: v })} /></Field>
          <Field label="Every item is"><Checks options={[{ value: 'Direct' as const, label: 'Direct' }, { value: 'Indirect' as const, label: 'Indirect' }]} value={c.procurementTypes} onChange={(v) => set({ procurementTypes: v })} /></Field>
        </>}
        <Field label="Urgency">
          <select value={c.urgent === undefined ? '' : c.urgent ? 'yes' : 'no'} onChange={(e) => set({ urgent: e.target.value === '' ? undefined : e.target.value === 'yes' })}>
            <option value="">Either</option><option value="yes">Only urgent</option><option value="no">Only not urgent</option>
          </select>
        </Field>
      </div>

      <label className="field" style={{ marginTop: 12 }}>Steps</label>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 36px', gap: 6, marginBottom: 6 }}>
          <select value={s.approverType} disabled={kind === 'po'} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, approverType: e.target.value as 'hod' | 'role' } : x)))}>
            {kind === 'request' && <option value="hod">Requester's HOD</option>}
            <option value="role">Role</option>
          </select>
          <select value={s.roleKey} disabled={s.approverType === 'hod'} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, roleKey: e.target.value } : x)))}>
            <option value="">—</option>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
          <input value={s.actionLabel} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, actionLabel: e.target.value } : x)))} placeholder="e.g. Approved" />
          <button className="btn-ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step">×</button>
        </div>
      ))}
      {!isPetty && <button className="btn-ghost" style={{ marginBottom: 12 }} onClick={() => setSteps([...steps, { approverType: kind === 'po' ? 'role' : 'hod', roleKey: '', actionLabel: 'Approved' }])}>+ Add step</button>}
      {isPetty && <div className="sub" style={{ marginBottom: 12 }}>Petty cash always has exactly one step: the requester's HOD.</div>}
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, marginBottom: 12 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
      <button className="btn-primary" onClick={save}>Save rule</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}

// "Who would approve this?" — check the rules before anyone submits.
function Preview({ types, units }: { types: RequestType[]; units: OrgUnit[] }) {
  const [q, setQ] = useState({ documentKind: 'request' as 'request' | 'po', amount: '150', requestTypeKey: 'purchase_request', orgUnitId: '', category: '', urgent: false });
  const [res, setRes] = useState<{ rule: { name: string; isPettyCash: boolean }; steps: { seq: number; actionLabel: string; approver: string }[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const type = types.find((t) => t.key === q.requestTypeKey);
  const run = async () => {
    setErr(null); setRes(null);
    try {
      setRes(await api.post('/api/approval-rules/preview', {
        documentKind: q.documentKind, amount: Number(q.amount) || 0,
        ...(q.documentKind === 'request' ? { handling: type?.handling === 'service' ? 'service' : 'purchase', requestTypeKey: q.requestTypeKey || undefined, orgUnitId: q.orgUnitId || undefined } : {}),
        categories: q.category ? [q.category] : undefined, urgent: q.urgent
      }));
    } catch (e) { setErr(e); }
  };
  return (
    <Card title="Who would approve this?" note="Try a request or PO against the current rules.">
      <div className="two-col">
        <Field label="Document"><select value={q.documentKind} onChange={(e) => setQ({ ...q, documentKind: e.target.value as 'request' | 'po' })}><option value="request">Request</option><option value="po">Purchase order</option></select></Field>
        <Field label="Value (USD)"><input type="number" min="0" value={q.amount} onChange={(e) => setQ({ ...q, amount: e.target.value })} /></Field>
        {q.documentKind === 'request' && <>
          <Field label="Request type"><select value={q.requestTypeKey} onChange={(e) => setQ({ ...q, requestTypeKey: e.target.value })}>{types.filter((t) => t.handling !== 'sample').map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
          <Field label="Store / department"><select value={q.orgUnitId} onChange={(e) => setQ({ ...q, orgUnitId: e.target.value })}><option value="">—</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        </>}
        <Field label="Items are all"><select value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })}><option value="">Mixed / any</option><option>Food</option><option>Non-food</option></select></Field>
        <Field label=" "><label className="flex gap-2 items-center" style={{ fontSize: 13.5, paddingTop: 8 }}><input type="checkbox" checked={q.urgent} onChange={(e) => setQ({ ...q, urgent: e.target.checked })} /> Urgent</label></Field>
      </div>
      <button className="btn-primary" onClick={run}>Show approvers</button>
      <ErrorText error={err} />
      {res && (
        <div style={{ marginTop: 12 }}>
          <div className="sub">Rule: <strong>{res.rule.name}</strong>{res.rule.isPettyCash && ' · petty cash'}</div>
          {res.steps.length ? res.steps.map((s) => <div key={s.seq} className="step-row step-future"><div className="step-dot">{s.seq}</div><div>{s.actionLabel} by {s.approver}</div></div>)
            : <div className="sub">No approval needed.</div>}
        </div>
      )}
    </Card>
  );
}
