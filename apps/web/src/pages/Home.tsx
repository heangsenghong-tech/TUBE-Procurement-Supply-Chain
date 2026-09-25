import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, download, money, timeAgo } from '../lib/api';
import { Card, Empty, ErrorText, Loading, StatusTag, useCan, useMe } from '../lib/ui';
import type { InboxEntry, RequestSummary, Spend } from '../lib/types';

type Stats = Record<string, number>;

function Stat({ label, value, tone, to }: { label: string; value: number | string | undefined; tone: string; to?: string }) {
  const body = <><div className="sub">{label}</div><div className="num">{value ?? '—'}</div></>;
  return to ? <Link to={to} className={`statcard ${tone}`}>{body}</Link> : <div className={`statcard ${tone}`}>{body}</div>;
}

function Dashboard() {
  const can = useCan();
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Stats>('/api/dashboard') });
  const d = data ?? {};
  return (
    <Card title="Dashboard" note="Live, current-state numbers. For a given month, see Monthly Summary in the Procurement Workspace.">
      <div className="statgrid">
        <Stat label="MY OPEN REQUESTS" value={d.myOpenRequests} tone="c-blue" to="#my-requests" />
        <Stat label="WAITING FOR MY APPROVAL" value={d.awaitingMyApproval} tone="c-yellow" to="/approvals" />
        {can('procurement.operate') && <>
          <Stat label="WITH PROCUREMENT" value={d.prWithProcurement} tone="c-yellow" to="/workspace/review" />
          <Stat label="OPEN COMPARISONS" value={d.openComparisons} tone="c-blue" to="/workspace/qcs" />
        </>}
        {can('po.view') && <>
          <Stat label="PR AWAITING APPROVAL" value={d.prAwaitingApproval} tone="c-yellow" />
          <Stat label="PO AWAITING APPROVAL" value={d.poAwaitingApproval} tone="c-yellow" to="/workspace/pos" />
          <Stat label="AWAITING DELIVERY" value={d.awaitingDelivery} tone="c-blue" to="/workspace/pos" />
          <Stat label="OVERDUE DELIVERIES" value={d.overdueDeliveries} tone="c-rose" to="/workspace/pos" />
          <Stat label="COMPLETED REQUESTS" value={d.completedRequests} tone="c-green" />
          <Stat label="ACTIVE SKUs" value={d.activeSkus} tone="c-yellow" to={can('pricing.view') ? '/workspace/price-list' : undefined} />
          <Stat label="ACTIVE SUPPLIERS" value={d.activeSuppliers} tone="c-blue" />
          <Stat label="STORES/DEPTS ACTIVE (30 DAYS)" value={d.activeUnits30d} tone="c-green" />
        </>}
        {can('pettycash.view') && <Stat label="PETTY CASH TO RECONCILE" value={d.pettyCashToReconcile} tone="c-rose" to="/workspace/petty-cash" />}
        {can('contract.view') && <Stat label="CONTRACTS EXPIRING ≤ 60 DAYS" value={d.contractsExpiringSoon} tone="c-rose" to="/workspace/contracts" />}
      </div>
    </Card>
  );
}

const PERIODS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly'], ['semester', 'Semester'], ['year', 'Yearly']] as const;

function SpendSummary() {
  const [period, setPeriod] = useState('month');
  const [show, setShow] = useState<null | 'unit' | 'item' | 'supplier'>(null);
  const { data, error } = useQuery({ queryKey: ['spend', period], queryFn: () => api.get<Spend>(`/api/reports/spend?period=${period}`) });
  const rows = show === 'unit' ? data?.byUnit : show === 'item' ? data?.byItem : show === 'supplier' ? data?.bySupplier : null;
  return (
    <Card title="Spend Summary" note="Approved and delivered PO value, split between the stores/departments that requested it.">
      <div className="flex gap-2 flex-wrap" style={{ marginBottom: 14 }}>
        {PERIODS.map(([k, l]) => (
          <button key={k} type="button" className={k === period ? 'btn-primary' : 'btn-ghost'} style={k === period ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setPeriod(k)}>{l}</button>
        ))}
      </div>
      <ErrorText error={error} />
      <div className="two-col" style={{ marginBottom: 14 }}>
        <div className="statcard c-blue"><div className="sub">STORE SPEND</div><div className="num">{money(data?.storeSpend)}</div></div>
        <div className="statcard c-yellow"><div className="sub">HQ SPEND</div><div className="num">{money(data?.hqSpend)}</div></div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button type="button" className="btn-ghost" onClick={() => setShow(show === 'unit' ? null : 'unit')}>By store/department {show === 'unit' ? '▴' : '▾'}</button>
        <button type="button" className="btn-ghost" onClick={() => setShow(show === 'item' ? null : 'item')}>By item {show === 'item' ? '▴' : '▾'}</button>
        {data?.bySupplier && <button type="button" className="btn-ghost" onClick={() => setShow(show === 'supplier' ? null : 'supplier')}>By supplier {show === 'supplier' ? '▴' : '▾'}</button>}
      </div>
      {rows && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          {rows.length ? (
            <table className="report"><tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="r">{money(r.amount)}</td></tr>)}</tbody></table>
          ) : <Empty>No spend in this period.</Empty>}
        </div>
      )}
    </Card>
  );
}

function WaitingForMe() {
  const { data } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<InboxEntry[]>('/api/approvals/inbox') });
  if (!data?.length) return null;
  return (
    <Card title={`Waiting for your approval (${data.length})`} actions={<Link to="/approvals" className="btn-ghost">Open Approvals</Link>}>
      {data.slice(0, 4).map((e) => (
        <Link key={e.documentId} to={e.kind === 'po' ? `/pos/${e.documentId}` : `/requests/${e.documentId}`} className="list-row">
          <span><strong>{e.number}</strong> · {e.title}<br /><span className="sub">{e.stepLabel} · from {e.by} · {timeAgo(e.submittedAt)}</span></span>
          <span className="num" style={{ fontSize: 15 }}>{money(e.amount)}</span>
        </Link>
      ))}
    </Card>
  );
}

function RequestList() {
  const { data: me } = useMe();
  const can = useCan();
  const scopes: [string, string][] = [['mine', 'Mine']];
  if (me?.hodUnitIds.length) scopes.push(['unit', 'My unit']);
  if (can('request.view_all')) scopes.push(['all', 'All']);
  const [scope, setScope] = useState('mine');
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['requests', scope, q],
    queryFn: () => api.get<RequestSummary[]>(`/api/requests?scope=${scope}${q ? '&q=' + encodeURIComponent(q) : ''}&limit=100`)
  });
  const [dlErr, setDlErr] = useState<unknown>(null);
  return (
    <Card id="my-requests" title="Requests" note="Every request with its status. Open one to see its approval chain, comments and where it is in Procurement."
      actions={<button className="btn-ghost" onClick={() => download('/api/exports/requests').catch(setDlErr)}>Export CSV</button>}>
      <div className="flex gap-2 flex-wrap items-center" style={{ marginBottom: 10 }}>
        {scopes.length > 1 && scopes.map(([k, l]) => (
          <button key={k} type="button" className={k === scope ? 'btn-primary' : 'btn-ghost'} style={k === scope ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setScope(k)}>{l}</button>
        ))}
        <input placeholder="Search number or purpose…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>
      <ErrorText error={error ?? dlErr} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No requests yet.</Empty> : data.map((r) => (
        <Link key={r.id} to={`/requests/${r.id}`} className="list-row">
          <span>
            <strong>{r.number}</strong> · {r.kind === 'sample' ? `Sample: ${r.itemName}` : `${r.lineCount} item${r.lineCount === 1 ? '' : 's'}`}
            {r.isPettyCash && <span className="tag tag-petty" style={{ marginLeft: 6 }}>Petty cash</span>}
            <br /><span className="sub">{r.orgUnitName} · {r.requesterName} · {timeAgo(r.submittedAt)}</span>
          </span>
          <span className="flex items-center gap-2">
            {r.estimatedTotal != null && <span className="sub">{money(r.estimatedTotal)}</span>}
            <StatusTag status={r.status} />
          </span>
        </Link>
      ))}
    </Card>
  );
}

export function HomePage() {
  const can = useCan();
  return (
    <>
      <Dashboard />
      <Card title="New request" note="Buying something: Purchase Request (under $100 becomes a petty cash record your HOD acknowledges). Not sure yet: Sample Request, to get a sample sourced and tried first.">
        <div className="flex gap-2 flex-wrap">
          <Link to="/requests/new/purchase" className="btn-primary" style={{ textDecoration: 'none', padding: '12px 22px' }}>+ Purchase Request</Link>
          <Link to="/requests/new/sample" className="btn-ghost" style={{ padding: '11px 18px', fontSize: 14 }}>+ Sample Request</Link>
        </div>
      </Card>
      <WaitingForMe />
      <RequestList />
      {can('spend.view') && <SpendSummary />}
    </>
  );
}
