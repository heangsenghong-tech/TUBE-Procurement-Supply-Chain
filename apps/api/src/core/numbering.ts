// Sequential, gap-free document numbers per prefix and year: PR-2026-000125.
// The row lock in the upsert makes concurrent requests queue instead of colliding.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';

export function companyYear(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Phnom_Penh' }).format(date));
}

export async function nextNumber(db: DbOrTx, prefix: 'PR' | 'SR' | 'QCS' | 'PO' | 'CT', date = new Date()) {
  const year = companyYear(date);
  const rows = await db.execute<{ last_value: number }>(sql`
    insert into document_sequences (prefix, year, last_value) values (${prefix}, ${year}, 1)
    on conflict (prefix, year) do update set last_value = document_sequences.last_value + 1
    returning last_value`);
  const n = rows[0]!.last_value;
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}
