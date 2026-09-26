import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, money, timeAgo } from '../lib/api';
import { Card, Empty, ErrorText, Loading, UrgentTag } from '../lib/ui';
import type { InboxEntry } from '../lib/types';

// Everything waiting for the signed-in person — built by the server from the approval rules,
// so it only ever lists steps this person is actually allowed to act on.
export function ApprovalsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<InboxEntry[]>('/api/approvals/inbox') });
  return (
    <Card title="Approvals" note="Below $100: petty cash — your HOD acknowledges only · $100–$299: HOD, then Head of Finance · $300+: HOD, Head of Finance, then CEO. POs: $100–$299 Supply Chain Manager then Finance · $300+ Finance then CEO. Service requests: the HOD acknowledges. Administrators can add rules by request type, store, category or urgency. Urgent items are listed first.">
      <ErrorText error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>Nothing is waiting for you.</Empty> : data.map((e) => (
        <Link key={`${e.kind}-${e.documentId}`} to={e.kind === 'po' ? `/pos/${e.documentId}` : `/requests/${e.documentId}`} className="list-row">
          <span>
            <strong>{e.number}</strong> · {e.typeName} · {e.title}{e.urgent && <UrgentTag />}
            {e.override && <span className="tag tag-warn" style={{ marginLeft: 6 }}>no approver assigned — override</span>}
            <br /><span className="sub">Your step: {e.stepLabel} · from {e.by} · {timeAgo(e.submittedAt)}</span>
          </span>
          {e.amount != null && <span className="num" style={{ fontSize: 16 }}>{money(e.amount)}</span>}
        </Link>
      ))}
    </Card>
  );
}
