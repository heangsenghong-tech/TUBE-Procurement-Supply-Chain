import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { sampleRequestInput } from '@tube/shared';
import { api } from '../lib/api';
import { Card, ErrorText, Field, useCan, useMe } from '../lib/ui';
import type { OrgUnit } from '../lib/types';

// The validated field list from the prototype's Sample Request.
export function NewSampleRequestPage() {
  const { data: me } = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const [f, setF] = useState({ orgUnitId: '', itemName: '', purpose: '', timeline: '', quantity: '', placeOfUsage: '', size: '', material: '', colorCode: '', referenceUrl: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!f.orgUnitId && me?.orgUnit) setF((x) => ({ ...x, orgUnitId: me.orgUnit!.id })); }, [me, f.orgUnitId]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const unit = units.data?.find((u) => u.id === f.orgUnitId);
  const unitChoices = (units.data ?? []).filter((u) => u.active && (can('request.view_all') || u.id === me?.orgUnit?.id));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const check = sampleRequestInput.safeParse({ ...f, track: unit?.type === 'store' ? 'store' : 'hq', quantity: Number(f.quantity) });
    if (!check.success) { setError(new Error(check.error.issues[0]?.message ?? 'Check the form.')); return; }
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>('/api/requests/sample', check.data);
      await qc.invalidateQueries();
      navigate(`/requests/${res.id}`);
    } catch (err) { setError(err); setBusy(false); }
  };

  return (
    <Card title="New Sample Request" note="For items or projects you're not sure about yet — get a sample sourced first, try it, then report back Pass or Fail.">
      <form onSubmit={submit}>
        <div className="two-col">
          <Field label="Store / department">
            <select value={f.orgUnitId} onChange={set('orgUnitId')} disabled={unitChoices.length <= 1}>
              {unitChoices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="Item / project name"><input required value={f.itemName} onChange={set('itemName')} placeholder="e.g. New takeaway cup design" /></Field>
        </div>
        <Field label="Purpose of usage"><input required value={f.purpose} onChange={set('purpose')} placeholder="Why this is needed" /></Field>
        <div className="two-col">
          <Field label="Project / timeline"><input value={f.timeline} onChange={set('timeline')} placeholder="e.g. New Year promo, needed by Dec 15" /></Field>
          <Field label="Quantity needed (for the project)"><input required type="number" min="1" value={f.quantity} onChange={set('quantity')} /></Field>
        </div>
        <Field label="Place of usage (fixed-asset / inventory reference)"><input value={f.placeOfUsage} onChange={set('placeOfUsage')} placeholder="e.g. All stores, or HQ office only" /></Field>
        <div className="two-col">
          <Field label="Size"><input value={f.size} onChange={set('size')} placeholder="e.g. 12oz, 40x60cm" /></Field>
          <Field label="Material"><input value={f.material} onChange={set('material')} placeholder="e.g. PP plastic, cotton" /></Field>
          <Field label="Color code"><input value={f.colorCode} onChange={set('colorCode')} placeholder="e.g. Pantone 109C" /></Field>
          <Field label="Reference image (link)"><input value={f.referenceUrl} onChange={set('referenceUrl')} placeholder="Google Drive/Photos link" /></Field>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit Sample Request'}</button>
          <Link to="/" className="btn-ghost">Cancel</Link>
        </div>
        <div style={{ marginTop: 10 }}><ErrorText error={error} /></div>
      </form>
    </Card>
  );
}
