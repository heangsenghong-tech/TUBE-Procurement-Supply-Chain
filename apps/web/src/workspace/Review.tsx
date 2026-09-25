import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api, date, money, qty, unitPrice } from '../lib/api';
import { Card, Empty, ErrorText, Field, Loading, Modal } from '../lib/ui';
import type { ReviewGroup, Supplier } from '../lib/types';

// Pending PR lines grouped by item across every store, with each contributor. Procurement adjusts
// the quantity, then either raises a PO directly (routine, priced items) or opens a comparison.
export function ReviewPanel() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['review'], queryFn: () => api.get<ReviewGroup[]>('/api/procurement/review') });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<null | 'po'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const chosen = (data ?? []).filter((g) => selected[g.itemId]);
  const qtyOf = (g: ReviewGroup) => Number(qtys[g.itemId] ?? g.totalQty);
  const groupsPayload = () => chosen.map((g) => ({ itemId: g.itemId, qty: qtyOf(g), requestLineIds: g.contributors.map((c) => c.lineId) }));

  const startQcs = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ id: string }>('/api/qcs', { groups: groupsPayload() });
      await qc.invalidateQueries();
      navigate(`/qcs/${res.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const cancelLine = async (lineId: string) => {
    const reason = window.prompt('Why is this line being cancelled? The requester will see this.');
    if (!reason) return;
    try { await api.post(`/api/request-lines/${lineId}/cancel`, { reason }); await qc.invalidateQueries(); } catch (e) { setErr(e); }
  };

  return (
    <Card title="Review & Consolidate" note="Approved requests grouped by item across every store. Tick items, adjust the quantity to order, then raise a PO directly or start a quote comparison.">
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing waiting for Procurement.</Empty> : (
        <>
          {data.map((g) => (
            <div key={g.itemId} className="card" style={{ marginBottom: 12, padding: 14, borderColor: selected[g.itemId] ? 'var(--accent)' : undefined }}>
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <label className="flex gap-2 items-start" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!selected[g.itemId]} onChange={(e) => setSelected((s) => ({ ...s, [g.itemId]: e.target.checked }))} style={{ marginTop: 4 }} />
                  <span><strong>{g.itemDescription}</strong> <span className="sub">{g.itemCode}</span><br />
                    <span className="sub">Requested {qty(g.totalQty)} {g.uom} · est. {unitPrice(g.estimatedUnitPrice)}/{g.uom} ·{' '}
                      {g.supplierPrices.length ? g.supplierPrices.map((p) => `${p.supplierName} ${unitPrice(p.unitPrice)}`).join(' · ') : 'no supplier on file yet'}</span></span>
                </label>
                <div style={{ width: 150 }}>
                  <label className="field">Qty to order ({g.uom})</label>
                  <input type="number" min="0" step="any" value={qtys[g.itemId] ?? String(g.totalQty)} onChange={(e) => setQtys((q) => ({ ...q, [g.itemId]: e.target.value }))} />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                {g.contributors.map((c) => (
                  <div key={c.lineId} className="flex justify-between items-center gap-2" style={{ fontSize: 12.5, padding: '3px 0' }}>
                    <span className="sub"><Link to={`/requests/${c.requestId}`}>{c.requestNumber}</Link> · {c.unitName} · {c.requesterName}{c.requiredDate ? ` · needed ${date(c.requiredDate)}` : ''}</span>
                    <span className="flex gap-2 items-center"><span>{qty(c.qty)} {g.uom}</span>
                      <button type="button" className="btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => cancelLine(c.lineId)}>Cancel line</button></span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex gap-2 flex-wrap items-center" style={{ position: 'sticky', bottom: 0, background: 'var(--card)', padding: '10px 0' }}>
            <span className="sub">{chosen.length} item{chosen.length === 1 ? '' : 's'} selected</span>
            <button className="btn-primary" disabled={!chosen.length || busy} onClick={startQcs}>Start quote comparison</button>
            <button className="btn-ghost" disabled={!chosen.length || busy} onClick={() => setModal('po')}>Generate PO directly</button>
          </div>
        </>
      )}
      {modal === 'po' && <DirectPoModal groups={chosen} qtyOf={qtyOf} onClose={() => setModal(null)}
        onDone={async (id) => { await qc.invalidateQueries(); navigate(`/pos/${id}`); }} />}
    </Card>
  );
}

// Direct PO: one supplier, all ticked items as lines, prices pre-filled from the price list.
function DirectPoModal({ groups, qtyOf, onClose, onDone }: { groups: ReviewGroup[]; qtyOf: (g: ReviewGroup) => number; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const defaultSupplier = groups[0]?.supplierPrices[0]?.supplierId ?? '';
  const [supplierId, setSupplierId] = useState(defaultSupplier);
  const priceFor = (g: ReviewGroup, sid: string) => g.supplierPrices.find((p) => p.supplierId === sid)?.unitPrice;
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const price = (g: ReviewGroup) => prices[g.itemId] ?? String(priceFor(g, supplierId) ?? '');
  const total = groups.reduce((s, g) => s + qtyOf(g) * Number(price(g) || 0), 0);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ id: string }>('/api/pos', {
        supplierId, expectedDeliveryDate: expected || undefined,
        lines: groups.map((g) => ({ itemId: g.itemId, qty: qtyOf(g), unitPrice: Number(price(g)), requestLineIds: g.contributors.map((c) => c.lineId) }))
      });
      await onDone(res.id);
    } catch (e) { setErr(e); setBusy(false); }
  };

  return (
    <Modal title="Generate PO" onClose={onClose}>
      <Field label="Supplier" hint="Items not normally bought from this supplier need a price entered.">
        <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPrices({}); }}>
          <option value="">Choose…</option>
          {(suppliers.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <table className="report" style={{ marginBottom: 12 }}>
        <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Unit price</th></tr></thead>
        <tbody>{groups.map((g) => (
          <tr key={g.itemId}><td>{g.itemDescription}</td><td className="r">{qty(qtyOf(g))} {g.uom}</td>
            <td className="r" style={{ width: 130 }}><input type="number" min="0" step="any" value={price(g)} onChange={(e) => setPrices((p) => ({ ...p, [g.itemId]: e.target.value }))} /></td></tr>
        ))}</tbody>
      </table>
      <Field label="Expected delivery (optional)"><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      <div className="flex justify-between items-center flex-wrap gap-2">
        <span>Total <strong className="num">{money(total)}</strong> <span className="sub">— approval follows the PO matrix</span></span>
        <button className="btn-primary" disabled={busy || !supplierId || groups.some((g) => price(g) === '')} onClick={submit}>Generate PO</button>
      </div>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
