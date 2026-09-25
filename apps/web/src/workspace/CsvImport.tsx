import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, download } from '../lib/api';
import { ErrorText } from '../lib/ui';

interface Result { created: number; updated: number; errors: { row: number; message: string }[] }

// Upload → check every row → import. Nothing is written if any row has a problem.
export function CsvImport({ kind, label }: { kind: 'items' | 'suppliers' | 'org-units' | 'users'; label: string }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const check = async (text: string) => {
    setErr(null); setDone(null); setBusy(true);
    try { setResult(await api.post<Result>(`/api/import/${kind}`, { csv: text, dryRun: true })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!csv) return;
    setBusy(true);
    try {
      const r = await api.post<Result>(`/api/import/${kind}`, { csv, dryRun: false });
      setDone(`Imported: ${r.created} added, ${r.updated} updated.`); setResult(null); setCsv(null);
      await qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="sub">{label}</div>
        <button type="button" className="btn-ghost" onClick={() => download(`/api/import/${kind}/template`).catch(setErr)}>Download template</button>
      </div>
      <input type="file" accept=".csv,text/csv" style={{ marginTop: 8 }} onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        setCsv(text); await check(text);
        e.target.value = '';
      }} />
      {busy && <div className="sub">Checking…</div>}
      {result && (
        <div style={{ marginTop: 8 }}>
          {result.errors.length ? (
            <div className="error-text">
              {result.errors.length} row{result.errors.length === 1 ? '' : 's'} need fixing — nothing was imported:
              <ul style={{ margin: '6px 0 0 18px' }}>{result.errors.slice(0, 30).map((x) => <li key={x.row}>Row {x.row}: {x.message}</li>)}</ul>
            </div>
          ) : (
            <div className="flex gap-2 items-center flex-wrap">
              <span className="ok-text">All rows look good: {result.created} new, {result.updated} updates.</span>
              <button className="btn-primary" disabled={busy} onClick={commit}>Import</button>
            </div>
          )}
        </div>
      )}
      {done && <div className="ok-text" style={{ marginTop: 6 }}>{done}</div>}
      <ErrorText error={err} />
    </div>
  );
}
