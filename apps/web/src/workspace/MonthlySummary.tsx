import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, money } from '../lib/api';
import { Card, ErrorText, Letterhead, Loading } from '../lib/ui';

type Block = Record<'prs' | 'pettyCashPrs' | 'pettyCashValue' | 'pos' | 'spend' | 'savings' | 'avoidance' | 'cancelledPos', number>;

export function MonthlySummaryPanel() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const { data, error, isLoading } = useQuery({ queryKey: ['monthly', month], queryFn: () => api.get<{ thisMonth: Block; yearToDate: Block }>(`/api/reports/monthly?month=${month}`) });
  const row = (label: string, k: keyof Block, isMoney = false, green = false) => (
    <tr><td>{label}</td>
      {data && [data.thisMonth, data.yearToDate].map((b, i) => <td key={i} className="r" style={green ? { color: '#3A7D44', fontWeight: 600 } : {}}>{isMoney ? money(b[k]) : b[k]}</td>)}</tr>
  );
  return (
    <Card title="Monthly Summary for Leadership" note="PRs, POs, spend, savings and cost avoidance — straight from the database, no manual consolidation."
      actions={<><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }} /><button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button></>}>
      <Letterhead title={`MONTHLY PROCUREMENT SUMMARY   ${month}`} />
      <ErrorText error={error} />
      {isLoading ? <Loading /> : data && (
        <table className="report">
          <thead><tr><th></th><th className="r">This month</th><th className="r">Year to date</th></tr></thead>
          <tbody>
            {row('Purchase requests (through Procurement)', 'prs')}
            {row('Purchase orders issued', 'pos')}
            {row('Spend (approved & delivered POs)', 'spend', true)}
            {row('Cost savings vs last purchase price', 'savings', true, true)}
            {row('Cost avoidance vs supplier asking price', 'avoidance', true, true)}
            {row('POs cancelled', 'cancelledPos')}
            {row('Petty cash PRs', 'pettyCashPrs')}
            {row('Petty cash value (acknowledged)', 'pettyCashValue', true)}
          </tbody>
        </table>
      )}
    </Card>
  );
}
