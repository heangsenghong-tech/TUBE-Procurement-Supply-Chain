import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { api, date, dateTime, qty, unitPrice } from '../lib/api';
import { Card, ErrorText, Field, Letterhead, Loading, Modal, StatusTag } from '../lib/ui';
import { ReasonModal } from '../pages/RequestDetail';
import type { Qcs, Supplier } from '../lib/types';

type QcsItem = Qcs['items'][number];

export function QcsDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: q, error, isLoading } = useQuery({ queryKey: ['qcs', id], queryFn: () => api.get<Qcs>(`/api/qcs/${id}`) });
  const [addFor, setAddFor] = useState<QcsItem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [expected, setExpected] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); await qc.invalidateQueries(); return r; } catch (e) { setErr(e); throw e; } finally { setBusy(false); }
  };
  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const pos = await api.post<{ id: string }[]>(`/api/qcs/${id}/generate-po`, { expectedDeliveryDate: expected || undefined });
      await qc.invalidateQueries();
      if (pos.length === 1) navigate(`/pos/${pos[0]!.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (isLoading) return <Loading />;
  if (error || !q) return <Card><ErrorText error={error} /></Card>;
  const editable = q.status === 'open' || q.status === 'reopened';
  const ready = q.items.filter((i) => !i.hasLivePo && i.quotes.some((x) => x.selected));

  return (
    <>
      {q.status === 'reopened' && (
        <div className="banner no-print">
          This comparison was <strong>reopened</strong> because its PO was cancelled or rejected. The quotes are all still here — pick the next supplier and generate a new PO. No new PR needed.
        </div>
      )}
      <Card title={`Quote Comparison ${q.number}`} note={`From ${q.prNumbers.join(', ')} · started by ${q.createdBy} · ${date(q.createdAt)}`}
        actions={<><StatusTag status={q.status} kind="qcs" /><button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button>
          {editable && <button className="btn-danger" onClick={() => setCancelling(true)}>Cancel sheet</button>}</>}>
        <Letterhead title={`QUOTE COMPARISON SHEET   ${q.number}`} />
        <div className="print-only sub" style={{ marginBottom: 10 }}>PR: {q.prNumbers.join(', ')}</div>
        {q.items.map((it) => (
          <div key={it.id} style={{ marginBottom: 22 }}>
            <div className="flex justify-between items-start flex-wrap gap-2" style={{ marginBottom: 6 }}>
              <div><strong>{it.itemDescription}</strong> <span className="sub">{it.itemCode}</span><br />
                <span className="sub">Qty {qty(it.qty)} {it.uom} · for {it.contributors.map((c) => `${c.unitName} (${c.number})`).join(', ')}</span></div>
              <div className="flex gap-2 items-center">
                {it.pos.map((p) => <Link key={p.id} to={`/pos/${p.id}`} className="sub">{p.number} <StatusTag status={p.status} kind="po" /></Link>)}
                {editable && !it.hasLivePo && <button className="btn-ghost no-print" onClick={() => setAddFor(it)}>+ Add quote</button>}
              </div>
            </div>
            <div className="table-wrap">
              <table className="report">
                <thead><tr><th>Supplier</th><th className="r">Asking</th><th className="r">Negotiated</th><th className="r">Lead time</th><th>Notes</th><th className="no-print"></th></tr></thead>
                <tbody>
                  {[...it.quotes].sort((a, b) => a.unitPrice - b.unitPrice).map((x, rank) => (
                    <tr key={x.id} style={x.selected ? { fontWeight: 600, background: '#FFF6D6' } : x.failedBefore ? { color: 'var(--sub)' } : {}}>
                      <td>{x.supplierName}{x.selected && ' ✓ selected'}{rank === 0 && !x.selected && <span className="tag tag-info" style={{ marginLeft: 6 }}>lowest</span>}
                        {x.failedBefore && <span className="tag tag-bad" style={{ marginLeft: 6 }}>PO failed before</span>}</td>
                      <td className="r">{x.originalPrice > x.unitPrice ? <s className="sub">{unitPrice(x.originalPrice)}</s> : unitPrice(x.originalPrice)}</td>
                      <td className="r">{unitPrice(x.unitPrice)}</td>
                      <td className="r">{x.leadTimeDays != null ? `${x.leadTimeDays}d` : '—'}</td>
                      <td className="sub">{x.notes}</td>
                      <td className="no-print r" style={{ whiteSpace: 'nowrap' }}>
                        {editable && !it.hasLivePo && !x.selected && (
                          <button className="btn-ghost" disabled={busy} onClick={() => {
                            const reason = window.prompt('Why this supplier? (optional)') ?? undefined;
                            run(() => api.post(`/api/qcs-items/${it.id}/select`, { quotationId: x.id, reason: reason || undefined })).catch(() => {});
                          }}>Select</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!it.quotes.length && <tr><td colSpan={6} className="sub">No quotes yet — add one.</td></tr>}
                </tbody>
              </table>
            </div>
            {it.selectionHistory.length > 0 && (
              <details className="no-print" style={{ marginTop: 6 }}>
                <summary className="sub" style={{ cursor: 'pointer' }}>Selection history ({it.selectionHistory.length})</summary>
                {it.selectionHistory.map((h, i) => {
                  const quote = it.quotes.find((x) => x.id === h.quotationId);
                  return <div key={i} className="sub">{dateTime(h.at)} · {h.by} picked {quote?.supplierName}{h.reason ? ` — “${h.reason}”` : ''}{h.status === 'superseded' ? ` · superseded: ${h.supersededReason}` : ' · current'}</div>;
                })}
              </details>
            )}
          </div>
        ))}
        {editable && (
          <div className="no-print" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <div className="section-note">Nothing is ordered automatically. When you're happy with the selected quotes, generate the PO — one per supplier, each with all of its items.</div>
            <div className="flex gap-2 items-end flex-wrap">
              <div style={{ width: 200 }}><label className="field">Expected delivery (optional)</label><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
              <button className="btn-primary" disabled={busy || !ready.length} onClick={generate}>Generate PO{ready.length ? ` (${ready.length} item${ready.length === 1 ? '' : 's'})` : ''}</button>
            </div>
          </div>
        )}
        <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
      </Card>
      {addFor && <QuoteModal item={addFor} onClose={() => setAddFor(null)} onSave={async (body) => { await run(() => api.post(`/api/qcs-items/${addFor.id}/quotations`, body)); setAddFor(null); }} />}
      {cancelling && <ReasonModal title={`Cancel ${q.number}`} label="Reason — the PR lines go back to Review & Consolidate" button="Cancel sheet" danger busy={busy} error={err}
        onClose={() => setCancelling(false)} onSubmit={async (reason) => { await run(() => api.post(`/api/qcs/${q.id}/cancel`, { reason })); setCancelling(false); }} />}
    </>
  );
}

function QuoteModal({ item, onClose, onSave }: { item: QcsItem; onClose: () => void; onSave: (b: object) => Promise<void> }) {
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const [f, setF] = useState({ supplierId: '', unitPrice: '', originalPrice: '', leadTimeDays: '', notes: '' });
  const [err, setErr] = useState<unknown>(null);
  const existing = item.quotes.find((x) => x.supplierId === f.supplierId);
  return (
    <Modal title={`Quote for ${item.itemDescription}`} onClose={onClose}>
      <Field label="Supplier" hint={existing ? 'This supplier already quoted — saving updates their quote.' : undefined}>
        <select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          <option value="">Choose…</option>
          {(suppliers.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <div className="two-col">
        <Field label={`Negotiated price per ${item.uom}`}><input type="number" min="0" step="any" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></Field>
        <Field label="Original asking price (optional)" hint="The difference is recorded as cost avoidance."><input type="number" min="0" step="any" value={f.originalPrice} onChange={(e) => setF({ ...f, originalPrice: e.target.value })} /></Field>
        <Field label="Lead time (days, optional)"><input type="number" min="0" value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value })} /></Field>
        <Field label="Notes (optional)"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <button className="btn-primary" disabled={!f.supplierId || f.unitPrice === ''} onClick={() => onSave({
        supplierId: f.supplierId, unitPrice: Number(f.unitPrice), originalPrice: f.originalPrice ? Number(f.originalPrice) : undefined,
        leadTimeDays: f.leadTimeDays ? Number(f.leadTimeDays) : undefined, notes: f.notes || undefined
      }).catch(setErr)}>Save quote</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
