import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, date, download } from '../lib/api';
import { Card, Empty, ErrorText, Loading, StatusTag, useCan } from '../lib/ui';
import type { Qcs } from '../lib/types';

export function QcsListPanel() {
  const can = useCan();
  const { data, isLoading, error } = useQuery({ queryKey: ['qcs-list'], queryFn: () => api.get<Qcs[]>('/api/qcs') });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Quote Comparison" note="Started from Review & Consolidate. Add each supplier's quote, pick the winner, then generate the PO — the PR and comparison numbers carry through."
      actions={can('export.sensitive') && <button className="btn-ghost" onClick={() => download('/api/exports/quote-comparisons').catch(setErr)}>Export all (CSV)</button>}>
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No comparison sheets yet.</Empty> : data.map((q) => (
        <Link key={q.id} to={`/qcs/${q.id}`} className="list-row">
          <span><strong>{q.number}</strong> · {q.items.map((i) => i.itemDescription).join(', ')}<br />
            <span className="sub">From {q.prNumbers.join(', ')} · {q.createdBy} · {date(q.createdAt)}</span></span>
          <StatusTag status={q.status} kind="qcs" />
        </Link>
      ))}
    </Card>
  );
}
