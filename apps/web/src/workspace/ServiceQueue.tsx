import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, date, money, timeAgo } from '../lib/api';
import { Card, Empty, ErrorText, Loading, StatusTag, UrgentTag, useMe } from '../lib/ui';
import type { ServiceQueueEntry } from '../lib/types';

// Acknowledged service requests waiting for Procurement: take one, then resolve it on its page.
export function ServiceQueuePanel() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isLoading, error } = useQuery({ queryKey: ['service-queue'], queryFn: () => api.get<ServiceQueueEntry[]>('/api/procurement/service-queue') });
  const [filter, setFilter] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [err, setErr] = useState<unknown>(null);
  const rows = (data ?? []).filter((r) => filter === 'all' || (filter === 'mine' ? r.assigneeId === me?.id : !r.assigneeId));
  const take = async (id: string) => {
    setErr(null);
    try { await api.post(`/api/requests/${id}/assign`, {}); await qc.invalidateQueries(); } catch (e) { setErr(e); }
  };
  return (
    <Card title="Service Requests" note="Supplier requests, price inquiries, contract requests and maintenance, after the HOD has acknowledged them. Urgent ones are listed first.">
      <div className="flex gap-2 flex-wrap" style={{ marginBottom: 10 }}>
        {(['all', 'unassigned', 'mine'] as const).map((k) => (
          <button key={k} className={k === filter ? 'btn-primary' : 'btn-ghost'} style={k === filter ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setFilter(k)}>
            {k === 'all' ? 'All open' : k === 'unassigned' ? 'Not taken yet' : 'Mine'}
          </button>
        ))}
      </div>
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : !rows.length ? <Empty>Nothing waiting.</Empty> : rows.map((r) => (
        <div key={r.id} className="list-row">
          <Link to={`/requests/${r.id}`} style={{ textDecoration: 'none', flex: 1 }}>
            <strong>{r.number}</strong> · {r.subject}{r.isUrgent && <UrgentTag reason={r.urgentReason} />}<br />
            <span className="sub">{r.typeName} · {r.orgUnitName} · {r.requesterName} · {timeAgo(r.submittedAt)}{r.requiredDate ? ` · needed ${date(r.requiredDate)}` : ''}{r.estimatedCost > 0 ? ` · est. ${money(r.estimatedCost)}` : ''}</span>
          </Link>
          <span className="flex gap-2 items-center">
            {r.assigneeName ? <span className="sub">{r.assigneeName}</span> : <button className="btn-ghost" onClick={() => take(r.id)}>Take</button>}
            <StatusTag status={r.status} />
          </span>
        </div>
      ))}
    </Card>
  );
}
