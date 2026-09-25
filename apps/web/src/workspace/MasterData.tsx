import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unitPrice } from '../lib/api';
import { Card, ErrorText, Field, Loading, Modal } from '../lib/ui';
import { CsvImport } from './CsvImport';
import type { Item, Supplier } from '../lib/types';

const UOMS = ['Box', 'Btl', 'Can', 'Ctn', 'Kg', 'Kit', 'L', 'License', 'Loaf', 'Pack', 'Pair', 'Pcs', 'Roll', 'Set', 'Tin', 'Unit'];

export function MasterDataPanel() {
  const [tab, setTab] = useState<'items' | 'suppliers'>('items');
  return (
    <Card title="Item & Supplier Master" note="Add, edit or bulk upload. Every change is recorded in the activity log, and old prices are kept as history."
      actions={<>
        <button className={tab === 'items' ? 'btn-primary' : 'btn-ghost'} style={tab === 'items' ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setTab('items')}>Items</button>
        <button className={tab === 'suppliers' ? 'btn-primary' : 'btn-ghost'} style={tab === 'suppliers' ? { padding: '7px 12px', fontSize: 12.5 } : {}} onClick={() => setTab('suppliers')}>Suppliers</button>
      </>}>
      {tab === 'items' ? <Items /> : <Suppliers />}
    </Card>
  );
}

function Items() {
  const { data, isLoading, error } = useQuery({ queryKey: ['items', 'all'], queryFn: () => api.get<Item[]>('/api/items?includeInactive=true') });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const rows = (data ?? []).filter((i) => !q || `${i.code} ${i.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="flex gap-2" style={{ marginBottom: 10 }}>
        <input placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => setEditing('new')}>+ New item</button>
      </div>
      <ErrorText error={error} />
      {isLoading ? <Loading /> : (
        <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table className="report">
            <thead><tr><th>Code</th><th>Item</th><th>UOM</th><th>Suppliers</th><th></th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} style={i.active ? {} : { opacity: 0.5 }}>
                <td>{i.code}</td>
                <td>{i.description}{i.isReference && <span className="tag tag-mute" style={{ marginLeft: 6 }}>reference</span>}{!i.active && <span className="tag tag-mute" style={{ marginLeft: 6 }}>inactive</span>}
                  <div className="sub">{i.category} · {i.procurementType}</div></td>
                <td>{i.uom}</td>
                <td className="sub">{i.prices?.length ? i.prices.map((p) => `${p.supplierName} ${unitPrice(p.unitPrice)}${p.rank > 1 ? ' (backup)' : ''}`).join(' · ') : `est. ${unitPrice(i.standardCost)}`}</td>
                <td><button className="btn-ghost" onClick={() => setEditing(i)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CsvImport kind="items" label="Bulk upload items — columns: Item Code, Description, Category, Type, UOM, Unit Price, Supplier (the Price List CSV is in this format). Existing codes are updated." />
      {editing && <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ItemModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const [f, setF] = useState({
    code: item?.code ?? '', description: item?.description ?? '', category: item?.category ?? 'Food', procurementType: item?.procurementType ?? 'Direct',
    uom: item?.uom ?? 'Pcs', standardCost: item?.standardCost != null ? String(item.standardCost) : '', isReference: item?.isReference ?? false, active: item?.active ?? true
  });
  const [price, setPrice] = useState({ supplierId: '', unitPrice: '', rank: '1' });
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setErr(null);
    try {
      const body = { ...f, standardCost: f.standardCost === '' ? undefined : Number(f.standardCost) };
      if (item) await api.put(`/api/items/${item.id}`, body); else await api.post('/api/items', body);
      await qc.invalidateQueries(); setSaved(true);
      if (!item) onClose();
    } catch (e) { setErr(e); }
  };
  const addPrice = async () => {
    if (!item) return;
    try { await api.post(`/api/items/${item.id}/prices`, { supplierId: price.supplierId, unitPrice: Number(price.unitPrice), rank: Number(price.rank) }); await qc.invalidateQueries(); setPrice({ supplierId: '', unitPrice: '', rank: '1' }); }
    catch (e) { setErr(e); }
  };
  const current = (qc.getQueryData<Item[]>(['items', 'all']) ?? []).find((i) => i.id === item?.id) ?? item;
  return (
    <Modal title={item ? `Edit ${item.code}` : 'New item'} onClose={onClose}>
      <div className="two-col">
        <Field label="Item code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option>Food</option><option>Non-food</option></select></Field>
        <Field label="Procurement type"><select value={f.procurementType} onChange={(e) => setF({ ...f, procurementType: e.target.value })}><option>Direct</option><option>Indirect</option></select></Field>
        <Field label="Unit of measure"><select value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })}>{UOMS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        <Field label="Estimated price (used when no supplier price)"><input type="number" min="0" step="any" value={f.standardCost} onChange={(e) => setF({ ...f, standardCost: e.target.value })} /></Field>
      </div>
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '4px 0' }}><input type="checkbox" checked={f.isReference} onChange={(e) => setF({ ...f, isReference: e.target.checked })} /> Reference item (not sourced yet)</label>
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '4px 0 12px' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (appears in the request catalog)</label>
      <button className="btn-primary" onClick={save}>Save item</button> {saved && <span className="ok-text">Saved.</span>}

      {item && (
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 12 }}>
          <h3>Supplier prices</h3>
          {current?.prices?.map((p) => (
            <div key={p.id} className="flex justify-between items-center" style={{ fontSize: 13, padding: '4px 0' }}>
              <span>{p.supplierName} — {unitPrice(p.unitPrice)} / {item.uom} {p.rank === 1 ? <span className="tag tag-ok">primary</span> : <span className="tag tag-mute">backup {p.rank}</span>}</span>
              <button className="btn-ghost" onClick={async () => { try { await api.del(`/api/item-prices/${p.id}`); await qc.invalidateQueries(); } catch (e) { setErr(e); } }}>Remove</button>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px auto', gap: 8, marginTop: 8, alignItems: 'end' }}>
            <select value={price.supplierId} onChange={(e) => setPrice({ ...price, supplierId: e.target.value })}>
              <option value="">Supplier…</option>
              {(suppliers.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="number" min="0" step="any" placeholder="Price" value={price.unitPrice} onChange={(e) => setPrice({ ...price, unitPrice: e.target.value })} />
            <select value={price.rank} onChange={(e) => setPrice({ ...price, rank: e.target.value })}><option value="1">Primary</option><option value="2">Backup</option><option value="3">Backup 2</option></select>
            <button className="btn-ghost" disabled={!price.supplierId || price.unitPrice === ''} onClick={addPrice}>Set price</button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}

function Suppliers() {
  const { data, isLoading, error } = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  return (
    <>
      <div className="flex justify-end" style={{ marginBottom: 10 }}><button className="btn-primary" onClick={() => setEditing('new')}>+ New supplier</button></div>
      <ErrorText error={error} />
      {isLoading ? <Loading /> : (
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Contact</th><th>Payment term</th><th></th></tr></thead>
            <tbody>{(data ?? []).map((s) => (
              <tr key={s.id} style={s.active ? {} : { opacity: 0.5 }}>
                <td>{s.code}</td><td>{s.name}</td><td>{s.category}</td>
                <td className="sub">{[s.contactName, s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                <td>{s.paymentTerms ?? '—'}</td>
                <td><button className="btn-ghost" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CsvImport kind="suppliers" label="Bulk upload suppliers — columns: Code, Name, Category, Contact Name, Phone, Email, Address, Payment Terms, Delivery Terms, Lead Time Days. Leave Code empty for new suppliers." />
      {editing && <SupplierModal supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function SupplierModal({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const qc = useQueryClient();
  const s = supplier;
  const [f, setF] = useState({
    name: s?.name ?? '', category: s?.category ?? 'Food', contactName: s?.contactName ?? '', phone: s?.phone ?? '', email: s?.email ?? '',
    address: s?.address ?? '', paymentTerms: s?.paymentTerms ?? '', deliveryTerms: s?.deliveryTerms ?? '', leadTimeDays: s?.leadTimeDays != null ? String(s.leadTimeDays) : '', active: s?.active ?? true
  });
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const body = { ...f, leadTimeDays: f.leadTimeDays === '' ? undefined : Number(f.leadTimeDays) };
      if (s) await api.put(`/api/suppliers/${s.id}`, body); else await api.post('/api/suppliers', body);
      await qc.invalidateQueries(); onClose();
    } catch (e) { setErr(e); }
  };
  return (
    <Modal title={s ? `Edit ${s.code}` : 'New supplier'} onClose={onClose}>
      <div className="two-col">
        <Field label="Name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Category"><select value={f.category} onChange={set('category')}><option>Food</option><option>Non-food</option><option>Both</option></select></Field>
        <Field label="Contact person"><input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input value={f.email} onChange={set('email')} /></Field>
        <Field label="Address"><input value={f.address} onChange={set('address')} /></Field>
        <Field label="Payment terms"><input value={f.paymentTerms} onChange={set('paymentTerms')} placeholder="e.g. 1 MONTH" /></Field>
        <Field label="Delivery terms"><input value={f.deliveryTerms} onChange={set('deliveryTerms')} /></Field>
        <Field label="Lead time (days)"><input type="number" min="0" value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>
      </div>
      <label className="flex gap-2 items-center" style={{ fontSize: 13.5, margin: '4px 0 12px' }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      <button className="btn-primary" onClick={save}>Save supplier</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
