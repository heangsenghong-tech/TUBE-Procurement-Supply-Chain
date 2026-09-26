import { type ReactNode, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LINE_STATUSES, PO_STATUSES, QCS_STATUSES, REQUEST_STATUSES, type Permission } from '@tube/shared';
import { api, dateTime } from './api';
import type { ApprovalChain, Me } from './types';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me'), staleTime: 60_000 });
}

export function useCan() {
  const { data } = useMe();
  return (p: Permission) => !!data?.permissions.includes(p);
}

const TONE: Record<string, string> = {
  pending_approval: 'warn', changes_requested: 'warn', approved: 'info', in_progress: 'info', ordered: 'info', completed: 'ok',
  rejected: 'bad', cancelled: 'mute', petty_cash_approved: 'petty', petty_cash_reconciled: 'ok',
  sourcing: 'info', under_review: 'warn', under_evaluation: 'warn', under_consideration: 'warn', pass: 'ok', fail: 'bad', not_meet_requirement: 'bad',
  open: 'info', in_qcs: 'info', delivered: 'ok', petty_cash: 'petty', reopened: 'warn', converted: 'ok'
};

export function StatusTag({ status, kind = 'request' }: { status: string; kind?: 'request' | 'line' | 'po' | 'qcs' }) {
  const labels: Record<string, string> = kind === 'po' ? PO_STATUSES : kind === 'qcs' ? QCS_STATUSES : kind === 'line' ? LINE_STATUSES : REQUEST_STATUSES;
  return <span className={`tag tag-${TONE[status] ?? 'mute'}`}>{labels[status] ?? status}</span>;
}

export function Card({ title, note, actions, children, id }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>{title && <h2>{title}</h2>}{note && <div className="section-note" style={{ marginBottom: 0 }}>{note}</div>}</div>
          {actions && <div className="flex gap-2 flex-wrap items-center no-print">{actions}</div>}
        </div>
      )}
      <div style={{ marginTop: title || actions ? 14 : 0 }}>{children}</div>
    </section>
  );
}

export function Loading() { return <div className="sub">Loading…</div>; }
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error-text">{error instanceof Error ? error.message : String(error)}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="sub">{children}</div>; }

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label className="field">{label}</label>
      {children}
      {hint && <div className="sub" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="flex justify-between items-center" style={{ marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Approval chain with the prototype's step dots: done / current / future.
export function ApprovalSteps({ chain }: { chain: ApprovalChain }) {
  if (!chain.steps.length) return <div className="sub">{chain.ruleName} — no approval needed.</div>;
  return (
    <div>
      <div className="sub" style={{ marginBottom: 4 }}>{chain.ruleName}</div>
      {chain.steps.map((s) => {
        const cls = s.status === 'approved' ? 'step-done' : s.status === 'pending' ? 'step-current'
          : s.status === 'rejected' || s.status === 'changes_requested' ? 'step-bad' : s.status === 'cancelled' ? 'step-cancelled' : 'step-future';
        const icon = s.status === 'approved' ? '✓' : s.status === 'rejected' ? '✕' : s.status === 'changes_requested' ? '↺' : String(s.seq);
        return (
          <div key={s.seq} className={`step-row ${cls}`}>
            <div className="step-dot">{icon}</div>
            <div>
              <div>
                {s.status === 'pending' ? s.actionLabel : `${s.actionLabel} by ${s.actedBy ?? s.approver}`}
                {s.override && <span className="tag tag-warn" style={{ marginLeft: 6 }}>override</span>}
              </div>
              {s.actedAt && <div className="sub">{dateTime(s.actedAt)}{s.status === 'changes_requested' ? ' · changes requested' : s.status === 'rejected' ? ' · rejected' : ''}</div>}
              {s.status === 'pending' && <div className="sub">Waiting for {s.approver}</div>}
              {s.comment && <div className="sub">“{s.comment}”</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Approve / Request changes / Reject — big, touch-friendly buttons; reasons required for the last two.
export function ApprovalActions({ onAct, busy }: { onAct: (action: 'approve' | 'reject' | 'request_changes', comment?: string) => Promise<void>; busy?: boolean }) {
  const [mode, setMode] = useState<null | 'reject' | 'request_changes'>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  const run = async (a: 'approve' | 'reject' | 'request_changes') => {
    setError(null);
    try { await onAct(a, comment || undefined); setMode(null); setComment(''); } catch (e) { setError(e); }
  };
  return (
    <div className="no-print">
      {mode ? (
        <div>
          <Field label={mode === 'reject' ? 'Reason for rejecting' : 'What needs to change?'}>
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
          </Field>
          <div className="flex gap-2 flex-wrap">
            <button className={mode === 'reject' ? 'btn-danger' : 'btn-primary'} disabled={busy || !comment.trim()} onClick={() => run(mode)}>
              {mode === 'reject' ? 'Reject' : 'Send back for changes'}
            </button>
            <button className="btn-ghost" onClick={() => setMode(null)}>Back</button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <button className="btn-ok" disabled={busy} onClick={() => run('approve')}>✓ Approve</button>
          <button className="btn-ghost" disabled={busy} onClick={() => setMode('request_changes')}>Request changes</button>
          <button className="btn-danger" disabled={busy} onClick={() => setMode('reject')}>Reject</button>
        </div>
      )}
      <div style={{ marginTop: 8 }}><ErrorText error={error} /></div>
    </div>
  );
}

// Company letterhead shown only on paper (Print / PDF).
export function Letterhead({ title }: { title: string }) {
  return (
    <div className="print-only" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/tube-logo.png" alt="" style={{ width: 44, height: 44 }} />
        <div>
          <div style={{ fontFamily: 'Space Grotesk', fontSize: 20, fontWeight: 700 }}>TUBE CAFE CO., LTD.</div>
          <div style={{ fontSize: 12, color: '#6B6558' }}>Supply Chain &amp; Procurement Department</div>
        </div>
      </div>
      <div style={{ fontFamily: 'Space Grotesk', fontSize: 17, fontWeight: 600, borderTop: '2px solid #1C1E22', borderBottom: '2px solid #1C1E22', padding: '8px 0', marginTop: 14 }}>{title}</div>
    </div>
  );
}

export function UrgentTag({ reason }: { reason?: string | null }) {
  return <span className="tag tag-bad" title={reason ?? undefined} style={{ marginLeft: 6 }}>URGENT</span>;
}

// "This is urgent" + the reason, which approvers and Procurement see first.
export function UrgentField({ urgent, reason, onChange, note }: {
  urgent: boolean; reason: string; onChange: (urgent: boolean, reason: string) => void; note?: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={urgent} onChange={(e) => onChange(e.target.checked, reason)} />
        This is urgent
      </label>
      {urgent && (
        <div style={{ marginTop: 6 }}>
          <input value={reason} maxLength={300} onChange={(e) => onChange(true, e.target.value)} placeholder="Why is it urgent? e.g. machine down, store can't serve" aria-label="Urgent reason" />
          <div className="sub" style={{ marginTop: 4 }}>{note ?? 'Urgent requests go to the top of every approver\'s list and Procurement\'s queue. Please use it only when it really is.'}</div>
        </div>
      )}
    </div>
  );
}
