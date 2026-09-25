import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, download, unitPrice } from '../lib/api';
import { Card, ErrorText, Letterhead, Loading, useCan } from '../lib/ui';
import type { Item } from '../lib/types';

// Item Master price list grouped by supplier. Viewing needs pricing access; downloading or
// printing the full list needs Export Authorization, checked by the server.
export function PriceListPanel() {
  const can = useCan();
  const { data, isLoading, error } = useQuery({ queryKey: ['items'], queryFn: () => api.get<Item[]>('/api/items') });
  const [q, setQ] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const groups = useMemo(() => {
    const m = new Map<string, { item: Item; price: number | null | undefined; rank?: number }[]>();
    for (const it of data ?? []) {
      const text = `${it.code} ${it.description} ${(it.prices ?? []).map((p) => p.supplierName).join(' ')}`.toLowerCase();
      if (q && !text.includes(q.toLowerCase())) continue;
      if (!it.prices?.length) m.set('No supplier yet (estimated price)', [...(m.get('No supplier yet (estimated price)') ?? []), { item: it, price: it.standardCost }]);
      for (const p of it.prices ?? []) m.set(p.supplierName, [...(m.get(p.supplierName) ?? []), { item: it, price: p.unitPrice, rank: p.rank }]);
    }
    return [...m.entries()].sort(([a], [b]) => (a.startsWith('No supplier') ? 1 : b.startsWith('No supplier') ? -1 : a.localeCompare(b)));
  }, [data, q]);
  const exportable = can('export.sensitive');
  return (
    <Card title="Price List" note="Every item, grouped by supplier. Downloading or printing the full list needs Export Authorization — a saved file leaves this system's access control."
      actions={exportable && <>
        <button className="btn-ghost" onClick={() => download('/api/exports/price-list').catch(setErr)}>Save as CSV</button>
        <button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button></>}>
      {exportable && <Letterhead title="PRICE LIST" />}
      <input className="no-print" placeholder="Search item, code or supplier…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : (
        <div className="table-wrap" style={exportable ? {} : { userSelect: 'none' }}>
          <table className="report">
            <thead><tr><th>Code</th><th>Item</th><th>Category</th><th>UOM</th><th className="r">Unit price</th></tr></thead>
            <tbody>
              {groups.map(([supplier, rows]) => (
                <Fragment key={supplier}>
                  <tr><td colSpan={5} style={{ fontWeight: 600, paddingTop: 14, borderBottom: 'none' }}>{supplier}</td></tr>
                  {rows.map(({ item, price, rank }) => (
                    <tr key={supplier + item.id}><td>{item.code}</td><td>{item.description}{rank && rank > 1 ? <span className="tag tag-mute" style={{ marginLeft: 6 }}>backup</span> : null}</td>
                      <td className="sub">{item.category} · {item.procurementType}</td><td>{item.uom}</td><td className="r">{unitPrice(price)}</td></tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!exportable && <style>{'@media print { .card { display: none !important; } }'}</style>}
    </Card>
  );
}
