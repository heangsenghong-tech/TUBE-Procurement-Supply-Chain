import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, money, timeAgo } from '../lib/api';
import { Card, Empty, ErrorText, Loading, StatusTag } from '../lib/ui';
import type { RequestSummary } from '../lib/types';

// Finance's register of sub-$100 purchases: acknowledged by the HOD, paid directly, then matched
// here against the physical invoice. These never go through Procurement.
export function PettyCashPanel() {
  const [tab, setTab] = useState<'petty_cash_approved' | 'petty_cash_reconciled' | 'pending_approval'>('petty_cash_approved');
  const { data, isLoading, error } = useQuery({
    queryKey: ['petty-cash', tab],
    queryFn: () => api.get<RequestSummary[]>(`/api/requests?scope=all&pettyCash=true&status=${tab}&limit=200`)
  });
  const tabs = [['petty_cash_approved', 'To reconcile'], ['petty_cash_reconciled', 'Reconciled'], ['pending_approval', 'Waiting for HOD']] as const;
  const total = (data ?? []).reduce((s, r) => s + (r.estimatedTotal ?? 0), 0);
  return (
    <Card title="Petty Cash Register" note="Purchases under $100: raised as a PR, acknowledged by the requester's HOD, paid directly. Open one and mark it reconciled once it matches the physical invoice.">
      <div className="flex gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        {tabs.map(([k, l]) => <button key={k} className={k === tab ? 'btn-primary' : 'btn-ghost'} style={k === tab ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <ErrorText error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing here.</Empty> : (
        <>
          {data.map((r) => (
            <Link key={r.id} to={`/requests/${r.id}`} className="list-row">
              <span><strong>{r.number}</strong> · {r.orgUnitName}<br /><span className="sub">{r.requesterName} · {timeAgo(r.submittedAt)}</span></span>
              <span className="flex gap-2 items-center"><span>{money(r.estimatedTotal)}</span><StatusTag status={r.status} /></span>
            </Link>
          ))}
          <div style={{ textAlign: 'right', marginTop: 8 }} className="sub">Estimated total {money(total)}</div>
        </>
      )}
    </Card>
  );
}
