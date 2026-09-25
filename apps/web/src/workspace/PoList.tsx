import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PO_STATUSES } from '@tube/shared';
import { api, date, download, money } from '../lib/api';
import { Card, Empty, ErrorText, Loading, StatusTag, useCan } from '../lib/ui';
import type { PoSummary } from '../lib/types';

export function PoListPanel() {
  const can = useCan();
  const [status, setStatus] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['pos', status], queryFn: () => api.get<PoSummary[]>(`/api/pos${status ? '?status=' + status : ''}`) });
  const [err, setErr] = useState<unknown>(null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title="Purchase Orders" note="Each PO shows its comparison sheet and every PR it fulfils."
      actions={can('pricing.view') && <button className="btn-ghost" onClick={() => download('/api/exports/purchase-orders').catch(setErr)}>Export all (CSV)</button>}>
      <div style={{ maxWidth: 240, marginBottom: 10 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(PO_STATUSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No purchase orders.</Empty> : data.map((p) => (
        <Link key={p.id} to={`/pos/${p.id}`} className="list-row">
          <span><strong>{p.number}</strong> · {p.supplierName}{p.qcsNumber && <span className="sub"> · {p.qcsNumber}</span>}<br />
            <span className="sub">{date(p.createdAt)}{p.expectedDeliveryDate && ` · expected ${date(p.expectedDeliveryDate)}`}
              {p.status === 'approved' && p.expectedDeliveryDate && p.expectedDeliveryDate < today && <span className="tag tag-bad" style={{ marginLeft: 6 }}>overdue</span>}</span></span>
          <span className="flex gap-2 items-center">{p.total != null && <span className="num" style={{ fontSize: 14 }}>{money(p.total)}</span>}<StatusTag status={p.status} kind="po" /></span>
        </Link>
      ))}
    </Card>
  );
}
