import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { serviceRequestInput } from '@tube/shared';
import { api } from '../lib/api';
import { Card, ErrorText, Field, UrgentField, useCan, useMe } from '../lib/ui';
import type { OrgUnit, RequestDetail, RequestType } from '../lib/types';

// Ask Procurement to do something that isn't buying catalog items. At /requests/:id/edit it
// resubmits a service request that was sent back for changes.
export function NewServiceRequestPage() {
  const { id: editId } = useParams();
  const [params] = useSearchParams();
  const { data: me } = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['request-types'], queryFn: () => api.get<RequestType[]>('/api/request-types') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const existing = useQuery({ queryKey: ['request', editId], enabled: !!editId, queryFn: () => api.get<RequestDetail>(`/api/requests/${editId}`) });
  const [f, setF] = useState({ orgUnitId: '', requestTypeId: params.get('type') ?? '', subject: '', description: '', estimatedCost: '', requiredDate: '', referenceUrl: '' });
  const [urgent, setUrgent] = useState({ on: false, reason: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const serviceTypes = (types.data ?? []).filter((t) => t.handling === 'service');
  useEffect(() => { if (!f.orgUnitId && me?.orgUnit) setF((x) => ({ ...x, orgUnitId: me.orgUnit!.id })); }, [me, f.orgUnitId]);
  useEffect(() => { if (!f.requestTypeId && serviceTypes[0]) setF((x) => ({ ...x, requestTypeId: serviceTypes[0]!.id })); }, [serviceTypes, f.requestTypeId]);
  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setF({ orgUnitId: r.orgUnit.id, requestTypeId: r.requestType.id, subject: r.subject ?? '', description: r.purpose ?? '', estimatedCost: r.estimatedTotal != null ? String(r.estimatedTotal) : '', requiredDate: r.requiredDate ?? '', referenceUrl: r.referenceUrl ?? '' });
    setUrgent({ on: r.isUrgent, reason: r.urgentReason ?? '' });
  }, [existing.data]);

  const unit = units.data?.find((u) => u.id === f.orgUnitId);
  const unitChoices = (units.data ?? []).filter((u) => u.active && (can('request.view_all') || u.id === me?.orgUnit?.id));
  const type = serviceTypes.find((t) => t.id === f.requestTypeId);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const check = serviceRequestInput.safeParse({
      ...f, track: unit?.type === 'store' ? 'store' : 'hq', requiredDate: f.requiredDate || undefined,
      estimatedCost: f.estimatedCost.trim() === '' ? undefined : Number(f.estimatedCost),
      isUrgent: urgent.on, urgentReason: urgent.on ? urgent.reason : undefined
    });
    if (!check.success) { setError(new Error(check.error.issues[0]?.message ?? 'Check the form.')); return; }
    setBusy(true);
    try {
      const res = editId ? await api.put<{ id: string }>(`/api/requests/${editId}/service`, check.data) : await api.post<{ id: string }>('/api/requests/service', check.data);
      await qc.invalidateQueries();
      navigate(`/requests/${res.id}`, { state: { submitted: true } });
    } catch (err) { setError(err); setBusy(false); }
  };

  return (
    <Card title={editId ? `Resubmit ${existing.data?.number ?? ''}` : type?.name ?? 'Service request'}
      note={type?.description || 'Tell Procurement what you need. It\'s approved like a purchase of the same value, then someone in Procurement takes it on and reports back here.'}>
      <form onSubmit={submit}>
        <div className="two-col">
          <Field label="Request type">
            <select value={f.requestTypeId} onChange={set('requestTypeId')}>
              {serviceTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label={unit?.type === 'department' ? 'Department' : 'Store'}>
            <select value={f.orgUnitId} onChange={set('orgUnitId')} disabled={!!editId || unitChoices.length <= 1}>
              {unitChoices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Subject"><input value={f.subject} maxLength={200} onChange={set('subject')} placeholder="e.g. Air-con leaking above the bar" /></Field>
        <Field label="What do you need?"><textarea rows={5} value={f.description} maxLength={3000} onChange={set('description')} placeholder="Details that help Procurement act without coming back to you" /></Field>
        <Field label="Estimated cost (USD) — 0 if there is none">
          <input type="number" inputMode="decimal" min={0} step="0.01" value={f.estimatedCost} onChange={set('estimatedCost')} placeholder="e.g. 150" />
          <div className="sub" style={{ marginTop: 4 }}>Sets who approves it: under $100 your HOD; $100 or more also the Head of Finance, and the CEO from $300.</div>
        </Field>
        <div className="two-col">
          <Field label="Needed by (optional)"><input type="date" value={f.requiredDate} onChange={set('requiredDate')} /></Field>
          <Field label="Photo / document link (optional)"><input value={f.referenceUrl} onChange={set('referenceUrl')} placeholder="Google Drive/Photos link" /></Field>
        </div>
        <UrgentField urgent={urgent.on} reason={urgent.reason} onChange={(on, reason) => setUrgent({ on, reason })} />
        <div className="flex gap-2 flex-wrap">
          <button className="btn-primary" disabled={busy || !types.data}>{busy ? 'Submitting…' : editId ? 'Resubmit' : 'Submit request'}</button>
          <Link to={editId ? `/requests/${editId}` : '/requests/new'} className="btn-ghost">Cancel</Link>
        </div>
        <div style={{ marginTop: 10 }}><ErrorText error={error} /></div>
      </form>
    </Card>
  );
}
