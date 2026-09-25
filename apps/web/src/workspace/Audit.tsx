import { useQuery } from '@tanstack/react-query';
import { api, dateTime } from '../lib/api';
import { Card, ErrorText, Loading } from '../lib/ui';

interface Entry { a: { id: number; at: string; action: string; entityType: string | null; entityId: string | null; comment: string | null; before: unknown; after: unknown }; userName: string | null }

export function AuditPanel() {
  const { data, isLoading, error } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<Entry[]>('/api/audit?limit=300') });
  return (
    <Card title="Activity Log" note="Every important action with who did it and when. The database refuses edits or deletions to this log.">
      <ErrorText error={error} />
      {isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>{(data ?? []).map(({ a, userName }) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(a.at)}</td>
                <td>{userName ?? 'System'}</td>
                <td>{a.action}{a.entityType && <div className="sub">{a.entityType}</div>}</td>
                <td className="sub">
                  {a.comment && <div>“{a.comment}”</div>}
                  {a.after != null && <details><summary style={{ cursor: 'pointer' }}>details</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify({ before: a.before ?? undefined, after: a.after }, null, 1)}</pre></details>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
