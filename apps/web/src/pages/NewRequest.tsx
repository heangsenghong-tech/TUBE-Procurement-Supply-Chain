import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { REQUEST_GROUPS } from '@tube/shared';
import { api } from '../lib/api';
import { Card, ErrorText, Loading } from '../lib/ui';
import type { RequestType } from '../lib/types';

const ICON: Record<string, string> = { purchase: '🛒', sample: '🧪', service: '🛠️' };
const TONE: Record<string, string> = { purchase: 'c-yellow', sample: 'c-blue', service: 'c-green' };

// The Request Center: one place to ask for anything, without knowing procurement procedure.
export function NewRequestPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['request-types'], queryFn: () => api.get<RequestType[]>('/api/request-types') });
  const groups = (Object.keys(REQUEST_GROUPS) as (keyof typeof REQUEST_GROUPS)[])
    .map((g) => ({ g, types: (data ?? []).filter((t) => t.group === g) })).filter((x) => x.types.length);
  const target = (t: RequestType) => t.handling === 'sample' ? `/requests/new/sample?type=${t.id}`
    : t.handling === 'service' ? `/requests/new/service?type=${t.id}` : `/requests/new/purchase?type=${t.id}`;
  return (
    <Card title="New Request" note="Pick what you need. You don't need to know the supplier, price or procedure — the system routes it to the right approvers and to Procurement.">
      <ErrorText error={error} />
      {isLoading ? <Loading /> : groups.map(({ g, types }) => (
        <div key={g} style={{ marginBottom: 16 }}>
          <h3>{REQUEST_GROUPS[g]}</h3>
          <div className="ws-tiles" style={{ marginBottom: 0 }}>
            {types.map((t) => (
              <Link key={t.id} to={target(t)} className={`ws-tile statcard ${TONE[t.handling]}`}>
                <span className="ws-icon">{ICON[t.handling]}</span>
                <span className="ws-label">{t.name}</span>
                <span className="ws-desc">{t.description}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}
