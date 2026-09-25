import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONTRACT_STAGES } from '@tube/shared';
import { api, date, download } from '../lib/api';
import { Card, Empty, ErrorText, Field, Letterhead, Loading, Modal, useCan } from '../lib/ui';
import type { Contract, Supplier } from '../lib/types';

// Tracks that a contract exists, its stage and expiry — with a pointer to where the signed
// document lives. The document itself is deliberately never stored here.
export function ContractsPanel() {
  const can = useCan();
  const { data, isLoading, error } = useQuery({ queryKey: ['contracts'], queryFn: () => api.get<Contract[]>('/api/contracts') });
  const [editing, setEditing] = useState<Contract | 'new' | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const soon = (d: string | null) => d && (new Date(d).getTime() - Date.now()) / 864e5 <= 60;
  return (
    <Card title="Contract Register" note="Stage and expiry tracking — not the document. Keep the signed contract in your legal files and note where it lives."
      actions={<>
        {can('export.sensitive') && <><button className="btn-ghost" onClick={() => download('/api/exports/contracts').catch(setErr)}>Export CSV</button>
          <button className="btn-ghost" onClick={() => window.print()}>Print / PDF</button></>}
        {can('contract.manage') && <button className="btn-primary" onClick={() => setEditing('new')}>+ Add contract</button>}</>}>
      {can('export.sensitive') && <Letterhead title="CONTRACT REGISTER" />}
      <ErrorText error={error ?? err} />
      {isLoading ? <Loading /> : !data?.length ? <Empty>No contracts logged yet.</Empty> : (
        <div className="table-wrap">
          <table className="report">
            <thead><tr><th>No.</th><th>Contract</th><th>Supplier</th><th>Stage</th><th>Expiry</th><th>Document</th><th className="no-print"></th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id}>
                <td>{c.number}</td><td>{c.name}{c.keyTerms && <div className="sub">{c.keyTerms}</div>}</td><td>{c.supplierName ?? '—'}</td>
                <td><span className={`tag tag-${c.stage === 'signed' ? 'ok' : c.stage === 'cancelled' ? 'mute' : 'warn'}`}>{CONTRACT_STAGES[c.stage as keyof typeof CONTRACT_STAGES]}</span></td>
                <td>{date(c.expiryDate)}{c.stage !== 'cancelled' && soon(c.expiryDate) && <span className="tag tag-bad" style={{ marginLeft: 6 }}>renew soon</span>}</td>
                <td className="sub">{c.documentPointer ?? '—'}</td>
                <td className="no-print">{can('contract.manage') && <button className="btn-ghost" onClick={() => setEditing(c)}>Edit</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <ContractModal contract={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {!can('export.sensitive') && <style>{'@media print { .card { display: none !important; } }'}</style>}
    </Card>
  );
}

function ContractModal({ contract, onClose }: { contract: Contract | null; onClose: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<Supplier[]>('/api/suppliers') });
  const c = contract;
  const [f, setF] = useState({ name: c?.name ?? '', supplierId: c?.supplierId ?? '', stage: c?.stage ?? 'draft', startDate: c?.startDate ?? '', expiryDate: c?.expiryDate ?? '', keyTerms: c?.keyTerms ?? '', documentPointer: c?.documentPointer ?? '' });
  const [err, setErr] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, supplierId: f.supplierId || undefined, startDate: f.startDate || undefined, expiryDate: f.expiryDate || undefined };
    try { if (c) await api.put(`/api/contracts/${c.id}`, body); else await api.post('/api/contracts', body); await qc.invalidateQueries(); onClose(); } catch (e) { setErr(e); }
  };
  return (
    <Modal title={c ? `Edit ${c.number}` : 'Add contract'} onClose={onClose}>
      <div className="two-col">
        <Field label="Contract name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Stage"><select value={f.stage} onChange={set('stage')}>{Object.entries(CONTRACT_STAGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Supplier"><select value={f.supplierId} onChange={set('supplierId')}><option value="">—</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <div />
        <Field label="Start date"><input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
        <Field label="Expiry date"><input type="date" value={f.expiryDate} onChange={set('expiryDate')} /></Field>
      </div>
      <Field label="Key terms summary (not full pricing)"><input value={f.keyTerms} onChange={set('keyTerms')} placeholder="e.g. 1 month payment term, MOQ 500kg/month" /></Field>
      <Field label="Where the signed document lives"><input value={f.documentPointer} onChange={set('documentPointer')} placeholder="e.g. Google Drive > Contracts > Supplier_2026.pdf" /></Field>
      <button className="btn-primary" onClick={save}>Save</button>
      <div style={{ marginTop: 8 }}><ErrorText error={err} /></div>
    </Modal>
  );
}
