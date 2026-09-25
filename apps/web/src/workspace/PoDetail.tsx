import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, date, money, qty, unitPrice } from '../lib/api';
import { ApprovalActions, ApprovalSteps, Card, ErrorText, Letterhead, Loading, StatusTag } from '../lib/ui';
import { ReasonModal } from '../pages/RequestDetail';
import type { PoDetail } from '../lib/types';

export function PoDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: po, error, isLoading } = useQuery({ queryKey: ['po', id], queryFn: () => api.get<PoDetail>(`/api/pos/${id}`) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await qc.invalidateQueries(); } catch (e) { setErr(e); throw e; } finally { setBusy(false); }
  };
  if (isLoading) return <Loading />;
  if (error || !po) return <Card><ErrorText error={error} /></Card>;
  const showPrice = po.total != null;

  return (
    <>
      <Card title={`Purchase Order ${po.number}`} note={`${po.supplier.name} · created by ${po.createdBy} · ${date(po.createdAt)}`}
        actions={<><StatusTag status={po.status} kind="po" /><button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button></>}>
        <Letterhead title={`PURCHASE ORDER   ${po.number}`} />
        <div className="two-col" style={{ fontSize: 13.5, marginBottom: 14 }}>
          <div><div className="sub">Supplier</div><strong>{po.supplier.name}</strong> <span className="sub">{po.supplier.code}</span>
            <div className="sub">{[po.supplier.contactName, po.supplier.phone].filter(Boolean).join(' · ')}</div>
            {po.supplier.paymentTerms && <div className="sub">Payment term: {po.supplier.paymentTerms}</div>}</div>
          <div><div className="sub">References</div>
            {po.qcs && <div>QCS: <Link to={`/qcs/${po.qcs.id}`}>{po.qcs.number}</Link></div>}
            <div>PR: {po.prNumbers.join(', ') || '—'}</div>
            {po.expectedDeliveryDate && <div>Expected delivery: {date(po.expectedDeliveryDate)}</div>}</div>
        </div>
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>#</th><th>Item</th><th className="r">Qty</th>{showPrice && <><th className="r">Unit price</th><th className="r">Amount</th></>}<th>Delivery allocation</th></tr></thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.lineNo}</td>
                  <td>{l.itemDescription}<br /><span className="sub">{l.itemCode}</span>
                    {showPrice && l.originalPrice != null && l.originalPrice > (l.unitPrice ?? 0) && <div className="sub">asking {unitPrice(l.originalPrice)}</div>}</td>
                  <td className="r">{qty(l.qty)} {l.uom}</td>
                  {showPrice && <><td className="r">{unitPrice(l.unitPrice)}</td><td className="r">{money(l.amount)}</td></>}
                  <td className="sub">{l.allocation.map((a) => <div key={a.number + a.unitName}>{a.unitName}: {qty(a.qty)} ({a.number})</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {showPrice && (
          <div style={{ textAlign: 'right', marginTop: 10 }}>
            <div><span className="sub">Total </span><strong className="num" style={{ fontSize: 18 }}>{money(po.total)}</strong></div>
            {po.totals && (po.totals.savings !== 0 || po.totals.avoidance > 0) && (
              <div className="sub" style={{ color: po.totals.savings < 0 ? '#B3491F' : '#3A7D44' }}>
                {po.totals.savings !== 0 && `${po.totals.savings > 0 ? 'Saving' : 'Increase'} ${money(Math.abs(po.totals.savings))} vs last purchase`}
                {po.totals.savings !== 0 && po.totals.avoidance > 0 && ' · '}
                {po.totals.avoidance > 0 && `Avoided ${money(po.totals.avoidance)} off asking price`}
              </div>
            )}
          </div>
        )}
        {po.notes && <div style={{ marginTop: 10, fontSize: 13.5 }}><span className="sub">Notes: </span>{po.notes}</div>}
        {po.deliveredAt && <div style={{ marginTop: 6 }} className="ok-text">Delivered {date(po.deliveredAt)}{po.deliveryNote ? ` — ${po.deliveryNote}` : ''}</div>}
        {po.cancelReason && <div style={{ marginTop: 6 }} className="error-text">{po.status === 'cancelled' ? 'Cancelled' : 'Returned'}: {po.cancelReason}</div>}

        <div className="flex gap-2 flex-wrap no-print" style={{ marginTop: 14 }}>
          {po.permissions.canDeliver && <button className="btn-ok" disabled={busy} onClick={() => {
            const note = window.prompt('Delivery note (optional) — e.g. received in full at KDT') ?? undefined;
            run(() => api.post(`/api/pos/${po.id}/deliver`, { note: note || undefined })).catch(() => {});
          }}>Mark delivered</button>}
          {po.permissions.canCancel && <button className="btn-danger" onClick={() => setCancelling(true)}>Cancel PO</button>}
        </div>
        <ErrorText error={err} />
      </Card>

      {po.approvals.length > 0 && (
        <Card title="PO approval">
          {po.approvals.map((c) => <div key={c.id} style={{ marginBottom: 10 }}><ApprovalSteps chain={c} /></div>)}
          {po.permissions.canAct && <ApprovalActions busy={busy} onAct={(action, c) => run(() => api.post(`/api/pos/${po.id}/approval`, { action, comment: c }))} />}
        </Card>
      )}

      {cancelling && <ReasonModal title={`Cancel ${po.number}`} button="Cancel PO" danger busy={busy} error={err}
        label={po.qcs ? 'Reason (e.g. out of stock) — the comparison sheet reopens so you can pick the next supplier' : 'Reason — the items go back to Review & Consolidate'}
        onClose={() => setCancelling(false)} onSubmit={async (reason) => { await run(() => api.post(`/api/pos/${po.id}/cancel`, { reason })); setCancelling(false); }} />}
    </>
  );
}
