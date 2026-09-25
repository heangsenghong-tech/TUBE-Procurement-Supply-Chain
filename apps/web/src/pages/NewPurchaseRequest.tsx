import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { purchaseRequestInput } from '@tube/shared';
import { api, money } from '../lib/api';
import { Card, ErrorText, Field, useCan, useMe } from '../lib/ui';
import type { Item, OrgUnit, RequestDetail } from '../lib/types';

interface Line { key: number; itemId: string; search: string; qty: string }
let nextKey = 1;

// Raise a PR — or, at /requests/:id/edit, resubmit one that was sent back for changes.
export function NewPurchaseRequestPage() {
  const { id: editId } = useParams();
  const { data: me } = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ['items'], queryFn: () => api.get<Item[]>('/api/items') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnit[]>('/api/org-units') });
  const existing = useQuery({ queryKey: ['request', editId], enabled: !!editId, queryFn: () => api.get<RequestDetail>(`/api/requests/${editId}`) });

  const [unitId, setUnitId] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: nextKey++, itemId: '', search: '', qty: '' }]);
  const [purpose, setPurpose] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!unitId && me?.orgUnit) setUnitId(me.orgUnit.id); }, [me, unitId]);
  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    setUnitId(r.orgUnit.id);
    setPurpose(r.purpose ?? ''); setRequiredDate(r.requiredDate ?? ''); setReferenceUrl(r.referenceUrl ?? '');
    setLines(r.lines.filter((l) => l.status === 'pending_approval').map((l) => ({ key: nextKey++, itemId: l.itemId, search: `${l.itemCode} — ${l.itemDescription}`, qty: String(l.qty) })));
  }, [existing.data]);

  const unit = units.data?.find((u) => u.id === unitId);
  const unitChoices = (units.data ?? []).filter((u) => u.active && (can('request.view_all') || u.id === me?.orgUnit?.id));
  const byLabel = useMemo(() => new Map((items.data ?? []).map((i) => [`${i.code} — ${i.description}`, i])), [items.data]);

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Match typed text again here: it may have been entered before the catalog finished loading.
    const resolved = lines.map((l) => ({ ...l, itemId: l.itemId || byLabel.get(l.search.trim())?.id || '' }));
    const payload = {
      track: unit?.type === 'store' ? 'store' : 'hq', orgUnitId: unitId, purpose, referenceUrl, requiredDate: requiredDate || undefined,
      lines: resolved.filter((l) => l.itemId || l.qty).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) }))
    };
    if (resolved.some((l) => l.search && !l.itemId)) { setError(new Error('Pick each item from the list (type to search).')); return; }
    const check = purchaseRequestInput.safeParse(payload);
    if (!check.success) { setError(new Error(check.error.issues[0]?.message ?? 'Check the form.')); return; }
    setBusy(true);
    try {
      const res = editId
        ? await api.put<{ id: string }>(`/api/requests/${editId}/purchase`, check.data)
        : await api.post<{ id: string }>('/api/requests/purchase', check.data);
      await qc.invalidateQueries();
      navigate(`/requests/${res.id}`, { state: { submitted: true } });
    } catch (err) { setError(err); setBusy(false); }
  };

  if (!me) return null;
  if (!me.orgUnit && !can('request.view_all')) {
    return <Card title="New Purchase Request"><div className="banner">You aren't assigned to a store or department yet. Ask the administrator to set it, then you can raise requests.</div></Card>;
  }

  return (
    <Card title={editId ? `Resubmit ${existing.data?.number ?? ''}` : 'New Purchase Request'}
      note="One request can list several items. You don't need to know the supplier or price — Procurement handles that after approval.">
      <form onSubmit={submit}>
        <Field label={unit?.type === 'department' ? 'Department' : 'Store'} hint={unit ? (unit.type === 'store' ? 'Store request' : 'HQ department request') : undefined}>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!!editId || unitChoices.length <= 1}>
            {!unitId && <option value="">Choose…</option>}
            {unitChoices.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.type === 'store' ? 'Store' : 'HQ department'})</option>)}
          </select>
        </Field>

        <label className="field">Items</label>
        <datalist id="items-list">
          {(items.data ?? []).map((i) => <option key={i.id} value={`${i.code} — ${i.description}`} />)}
        </datalist>
        {lines.map((l) => {
          const item = items.data?.find((i) => i.id === l.itemId);
          return (
            <div key={l.key} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 40px', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input list="items-list" placeholder="Search item…" value={l.search} aria-label="Item"
                onChange={(e) => { const found = byLabel.get(e.target.value); setLine(l.key, { search: e.target.value, itemId: found?.id ?? '' }); }} />
              <div style={{ position: 'relative' }}>
                <input type="number" min="0" step="any" placeholder="Qty" value={l.qty} aria-label="Quantity" onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                {item && <span className="sub" style={{ position: 'absolute', right: 8, top: 10 }}>{item.uom}</span>}
              </div>
              <button type="button" className="btn-ghost" aria-label="Remove item" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}>×</button>
            </div>
          );
        })}
        <button type="button" className="btn-ghost" style={{ marginBottom: 14 }} onClick={() => setLines((ls) => [...ls, { key: nextKey++, itemId: '', search: '', qty: '' }])}>+ Add item</button>

        <div className="two-col">
          <Field label="Needed by (optional)"><input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></Field>
          <Field label="Reference image link (optional)"><input value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} placeholder="Google Drive/Photos link" /></Field>
        </div>
        <Field label="Purpose / comment (optional)">
          <input value={purpose} maxLength={500} onChange={(e) => setPurpose(e.target.value)} placeholder="Why this is needed, project name, or a note for Procurement" />
        </Field>
        {editId && existing.data?.estimatedTotal != null && <div className="sub" style={{ marginBottom: 10 }}>Previous estimated value: {money(existing.data.estimatedTotal)}</div>}
        <div className="flex gap-2 items-center flex-wrap">
          <button className="btn-primary" type="submit" disabled={busy || !items.data}>{busy ? 'Submitting…' : !items.data ? 'Loading catalog…' : editId ? 'Resubmit' : 'Submit request'}</button>
          <Link to={editId ? `/requests/${editId}` : '/'} className="btn-ghost">Cancel</Link>
        </div>
        <div style={{ marginTop: 10 }}><ErrorText error={error} /></div>
      </form>
    </Card>
  );
}
