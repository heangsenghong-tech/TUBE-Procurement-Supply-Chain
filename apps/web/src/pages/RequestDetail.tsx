import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { SAMPLE_EVALUATION_STATUSES, REQUEST_STATUSES } from '@tube/shared';
import { api, date, dateTime, money, qty, unitPrice } from '../lib/api';
import { ApprovalActions, ApprovalSteps, Card, ErrorText, Field, Letterhead, Loading, Modal, StatusTag } from '../lib/ui';
import type { RequestDetail } from '../lib/types';

// "Where is my request?" — so nobody has to message Procurement to ask.
function Tracker({ r }: { r: RequestDetail }) {
  let steps: { label: string; state: 'done' | 'current' | 'future' | 'bad' }[];
  const s = r.status;
  if (r.kind === 'sample') {
    const done = ['pass', 'fail', 'not_meet_requirement'].includes(s);
    steps = [
      { label: 'Submitted', state: 'done' },
      { label: 'Sourcing sample', state: s === 'sourcing' ? 'current' : 'done' },
      { label: 'Evaluation', state: s === 'sourcing' ? 'future' : done ? 'done' : 'current' },
      { label: done ? REQUEST_STATUSES[s as 'pass'] : 'Result', state: s === 'pass' ? 'done' : done ? 'bad' : 'future' }
    ];
  } else if (r.isPettyCash) {
    steps = [
      { label: 'Submitted', state: 'done' },
      { label: 'HOD acknowledgement', state: s === 'pending_approval' || s === 'changes_requested' ? 'current' : s === 'rejected' ? 'bad' : 'done' },
      { label: 'Paid from petty cash', state: s === 'petty_cash_approved' || s === 'petty_cash_reconciled' ? 'done' : 'future' },
      { label: 'Reconciled by Finance', state: s === 'petty_cash_reconciled' ? 'done' : s === 'petty_cash_approved' ? 'current' : 'future' }
    ];
  } else {
    const lines = r.lines.filter((l) => l.status !== 'cancelled');
    const any = (st: string[]) => lines.some((l) => st.includes(l.status));
    const all = (st: string[]) => lines.length > 0 && lines.every((l) => st.includes(l.status));
    const approved = !['pending_approval', 'changes_requested', 'rejected', 'cancelled'].includes(s);
    steps = [
      { label: 'Submitted', state: 'done' },
      { label: 'Approval', state: s === 'rejected' ? 'bad' : approved ? 'done' : 'current' },
      { label: 'Procurement review', state: !approved ? 'future' : any(['in_qcs', 'ordered', 'delivered']) ? 'done' : 'current' },
      { label: 'Quote comparison', state: !approved ? 'future' : any(['in_qcs']) ? 'current' : lines.some((l) => l.qcs.length) || any(['ordered', 'delivered']) ? 'done' : 'future' },
      { label: 'PO', state: all(['ordered', 'delivered']) ? 'done' : any(['ordered', 'delivered']) ? 'current' : 'future' },
      { label: 'Delivery', state: all(['delivered']) ? 'done' : any(['ordered']) ? 'current' : 'future' },
      { label: 'Completed', state: s === 'completed' ? 'done' : 'future' }
    ];
    if (s === 'cancelled') steps = [{ label: 'Submitted', state: 'done' }, { label: 'Cancelled', state: 'bad' }];
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {steps.map((st, i) => (
        <div key={i} className={`step-row step-${st.state === 'done' ? 'done' : st.state === 'current' ? 'current' : st.state === 'bad' ? 'bad' : 'future'}`}>
          <div className="step-dot">{st.state === 'done' ? '✓' : st.state === 'bad' ? '✕' : i + 1}</div>
          <div>{st.label}</div>
        </div>
      ))}
    </div>
  );
}

export function RequestDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const qc = useQueryClient();
  const { data: r, error, isLoading } = useQuery({ queryKey: ['request', id], queryFn: () => api.get<RequestDetail>(`/api/requests/${id}`) });
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | 'cancel' | 'evaluate' | 'reconcile'>(null);
  const [comment, setComment] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);

  const refresh = () => qc.invalidateQueries();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setActionError(null);
    try { await fn(); await refresh(); setModal(null); } catch (e) { setActionError(e); throw e; } finally { setBusy(false); }
  };

  if (isLoading) return <Loading />;
  if (error || !r) return <Card><ErrorText error={error} /><Link to="/" className="btn-ghost">Back</Link></Card>;
  const p = r.permissions;
  const current = r.approvals.at(-1);
  const d = r.details;

  return (
    <>
      {(location.state as { submitted?: boolean } | null)?.submitted && (
        <div className="banner no-print" style={{ background: 'var(--ok-bg)', color: 'var(--ok-ink)' }}>
          Request {r.number} submitted. {r.isPettyCash ? 'Under $100 — routed as petty cash to your HOD for acknowledgement.' : current?.steps[0] ? `Waiting for ${current.steps[0].approver}.` : ''}
        </div>
      )}
      <Card
        title={<span>{r.number} {r.isPettyCash && <span className="tag tag-petty">Petty cash</span>}</span>}
        note={`${r.kind === 'sample' ? 'Sample request' : r.track === 'store' ? 'Store purchase request' : 'HQ purchase request'} · ${r.orgUnit.name} · ${r.requester.name} · ${dateTime(r.submittedAt)}`}
        actions={<>
          <StatusTag status={r.status} />
          <button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button>
        </>}>
        <Letterhead title={`${r.kind === 'sample' ? 'SAMPLE REQUEST' : 'PURCHASE REQUISITION'}   ${r.number}`} />
        <div className="no-print" style={{ marginBottom: 14 }}><Tracker r={r} /></div>

        {r.kind === 'purchase' ? (
          <div className="table-wrap">
            <table className="report">
              <thead><tr><th>#</th><th>Item</th><th className="r">Qty</th>{r.estimatedTotal != null && <th className="r">Est. price</th>}<th>Status</th><th className="no-print">Sourcing</th></tr></thead>
              <tbody>
                {r.lines.filter((l) => l.cancelReason !== 'Replaced on resubmission').map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td>{l.itemDescription}<br /><span className="sub">{l.itemCode}</span>{l.cancelReason && <div className="sub">Cancelled: {l.cancelReason}</div>}</td>
                    <td className="r">{qty(l.qty)} {l.uom}</td>
                    {r.estimatedTotal != null && <td className="r">{unitPrice(l.estUnitPrice)}</td>}
                    <td><StatusTag status={l.status} kind="line" /></td>
                    <td className="no-print">
                      {l.qcs.map((q) => <div key={q.id} className="sub">{q.number}</div>)}
                      {l.pos.map((po) => <div key={po.id} className="sub">{po.number} <StatusTag status={po.status} kind="po" /></div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.estimatedTotal != null && <div style={{ textAlign: 'right', marginTop: 8 }}><span className="sub">Estimated value </span><strong className="num">{money(r.estimatedTotal)}</strong></div>}
          </div>
        ) : (
          <div className="two-col" style={{ fontSize: 13.5 }}>
            <div><div className="sub">Item / project</div>{String(d.itemName ?? '')}</div>
            <div><div className="sub">Quantity</div>{String(d.quantity ?? '')}</div>
            <div><div className="sub">Timeline</div>{String(d.timeline ?? '—')}</div>
            <div><div className="sub">Place of usage</div>{String(d.placeOfUsage ?? '—')}</div>
            <div><div className="sub">Size</div>{String(d.size ?? '—')}</div>
            <div><div className="sub">Material</div>{String(d.material ?? '—')}</div>
            <div><div className="sub">Color code</div>{String(d.colorCode ?? '—')}</div>
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 13.5 }}>
          {r.purpose && <div><span className="sub">Purpose: </span>{r.purpose}</div>}
          {r.requiredDate && <div><span className="sub">Needed by: </span>{date(r.requiredDate)}</div>}
          {r.referenceUrl && <div><span className="sub">Reference: </span><a href={r.referenceUrl} target="_blank" rel="noreferrer noopener">{r.referenceUrl}</a></div>}
          {r.cancelReason && <div><span className="sub">Cancelled: </span>{r.cancelReason}</div>}
          {r.reconciliation && (
            <div><span className="sub">Reconciled by {r.reconciliation.by} on {date(r.reconciliation.at)} against invoice </span>{r.reconciliation.receiptReference}
              {r.reconciliation.amount != null && <> · actual {money(r.reconciliation.amount)}</>}{r.reconciliation.note && <> · {r.reconciliation.note}</>}</div>
          )}
        </div>

        <div className="flex gap-2 flex-wrap no-print" style={{ marginTop: 14 }}>
          {p.canResubmit && <Link to={`/requests/${r.id}/edit`} className="btn-primary" style={{ textDecoration: 'none' }}>Edit &amp; resubmit</Link>}
          {p.canEvaluate && <button className="btn-primary" onClick={() => setModal('evaluate')}>Update evaluation</button>}
          {p.canReconcile && <button className="btn-primary" onClick={() => setModal('reconcile')}>Mark reconciled</button>}
          {p.canCancel && <button className="btn-danger" onClick={() => setModal('cancel')}>Cancel request</button>}
        </div>
      </Card>

      {r.approvals.length > 0 && (
        <Card title="Approval" note={r.approvals.length > 1 ? `${r.approvals.length} rounds — earlier rounds are kept for the record.` : undefined}>
          {r.approvals.map((c, i) => (
            <div key={c.id} style={{ marginBottom: 12, opacity: i < r.approvals.length - 1 ? 0.6 : 1 }}><ApprovalSteps chain={c} /></div>
          ))}
          {p.canAct && (
            <div style={{ marginTop: 10 }}>
              <ApprovalActions busy={busy} onAct={(action, c) => run(() => api.post(`/api/requests/${r.id}/approval`, { action, comment: c }))} />
            </div>
          )}
        </Card>
      )}

      <Card title="Comments" note="Keep the conversation on the request instead of Telegram.">
        {r.comments.map((c) => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
            <strong>{c.userName}</strong> <span className="sub">{dateTime(c.createdAt)}</span><div>{c.body}</div>
          </div>
        ))}
        <form className="flex gap-2 no-print" style={{ marginTop: 10 }} onSubmit={async (e) => {
          e.preventDefault();
          if (!comment.trim()) return;
          await run(() => api.post(`/api/requests/${r.id}/comments`, { body: comment })).catch(() => {});
          setComment('');
        }}>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" maxLength={2000} />
          <button className="btn-ghost" disabled={busy || !comment.trim()}>Send</button>
        </form>
        <ErrorText error={actionError} />
      </Card>

      {modal === 'cancel' && <ReasonModal title={`Cancel ${r.number}`} label="Reason" button="Cancel request" danger busy={busy} error={actionError}
        onClose={() => setModal(null)} onSubmit={(reason) => run(() => api.post(`/api/requests/${r.id}/cancel`, { reason }))} />}
      {modal === 'evaluate' && <EvaluateModal busy={busy} error={actionError} onClose={() => setModal(null)}
        onSubmit={(status, c) => run(() => api.post(`/api/requests/${r.id}/evaluation`, { status, comment: c }))} />}
      {modal === 'reconcile' && <ReconcileModal busy={busy} error={actionError} onClose={() => setModal(null)}
        onSubmit={(body) => run(() => api.post(`/api/requests/${r.id}/reconcile`, body))} />}
    </>
  );
}

export function ReasonModal({ title, label, button, danger, busy, error, onClose, onSubmit }: {
  title: string; label: string; button: string; danger?: boolean; busy: boolean; error: unknown; onClose: () => void; onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <Field label={label}><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || !reason.trim()} onClick={() => onSubmit(reason).catch(() => {})}>{button}</button>
      <div style={{ marginTop: 8 }}><ErrorText error={error} /></div>
    </Modal>
  );
}

function EvaluateModal({ busy, error, onClose, onSubmit }: { busy: boolean; error: unknown; onClose: () => void; onSubmit: (s: string, c?: string) => Promise<unknown> }) {
  const [status, setStatus] = useState<string>('under_review');
  const [c, setC] = useState('');
  return (
    <Modal title="Sample evaluation" onClose={onClose}>
      <Field label="Status">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {SAMPLE_EVALUATION_STATUSES.map((s) => <option key={s} value={s}>{REQUEST_STATUSES[s]}</option>)}
        </select>
      </Field>
      <Field label="Comment for Procurement (optional)"><textarea rows={3} value={c} onChange={(e) => setC(e.target.value)} /></Field>
      <button className="btn-primary" disabled={busy} onClick={() => onSubmit(status, c || undefined).catch(() => {})}>Save</button>
      <div style={{ marginTop: 8 }}><ErrorText error={error} /></div>
    </Modal>
  );
}

function ReconcileModal({ busy, error, onClose, onSubmit }: { busy: boolean; error: unknown; onClose: () => void; onSubmit: (b: object) => Promise<unknown> }) {
  const [ref, setRef] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  return (
    <Modal title="Reconcile against the physical invoice" onClose={onClose}>
      <Field label="Invoice / receipt number"><input value={ref} onChange={(e) => setRef(e.target.value)} autoFocus /></Field>
      <Field label="Actual amount paid (optional)"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <button className="btn-primary" disabled={busy || !ref.trim()} onClick={() => onSubmit({ receiptReference: ref, actualAmount: amount ? Number(amount) : undefined, note: note || undefined }).catch(() => {})}>Mark reconciled</button>
      <div style={{ marginTop: 8 }}><ErrorText error={error} /></div>
    </Modal>
  );
}
