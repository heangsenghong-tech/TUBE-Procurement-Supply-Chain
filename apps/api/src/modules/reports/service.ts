// Dashboards, spend, monthly summary and exports — all computed from the database.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import * as t from '../../db/schema';
import { type Actor, can, requirePermission } from '../../core/actor';
import { badRequest } from '../../core/errors';
import { round2 } from '../../core/money';
import { approvalInbox, listRequests } from '../requests/service';

// Dashboard counts scoped to what this person may see.
export async function dashboard(db: DbOrTx, actor: Actor) {
  const inbox = await approvalInbox(db, actor);
  const mine = await listRequests(db, actor, { scope: 'mine', limit: 200 });
  const out: Record<string, number> = {
    myOpenRequests: mine.filter((r) => !['completed', 'rejected', 'cancelled', 'petty_cash_reconciled', 'pass', 'fail', 'not_meet_requirement'].includes(r.status)).length,
    awaitingMyApproval: inbox.length
  };
  if (can(actor, 'procurement.operate') || can(actor, 'po.view')) {
    const [c] = await db.execute<Record<string, number>>(sql`
      select
        (select count(*)::int from items where active) as "activeSkus",
        (select count(*)::int from suppliers where active) as "activeSuppliers",
        (select count(*)::int from requests where status = 'pending_approval') as "prAwaitingApproval",
        (select count(distinct request_id)::int from request_lines where status = 'open') as "prWithProcurement",
        (select count(*)::int from quote_comparisons where status in ('open','reopened')) as "openComparisons",
        (select count(*)::int from purchase_orders where status = 'pending_approval') as "poAwaitingApproval",
        (select count(*)::int from purchase_orders where status = 'approved') as "awaitingDelivery",
        (select count(*)::int from purchase_orders where status = 'approved' and expected_delivery_date < current_date) as "overdueDeliveries",
        (select count(*)::int from requests where status = 'completed') as "completedRequests",
        (select count(distinct org_unit_id)::int from requests where submitted_at > now() - interval '30 days') as "activeUnits30d",
        (select count(*)::int from requests where kind = 'service' and status in ('approved', 'in_progress')) as "serviceQueue",
        -- Master spec "Emergency Purchase %": urgent share of purchase requests in the last 30 days.
        (select coalesce(round(100.0 * count(*) filter (where is_urgent) / nullif(count(*), 0)), 0)::int
           from requests where kind = 'purchase' and not is_petty_cash and submitted_at > now() - interval '30 days') as "urgentPct30d"`);
    Object.assign(out, c);
  }
  if (can(actor, 'pettycash.view')) {
    const [p] = await db.execute<{ n: number }>(sql`select count(*)::int as n from requests where status = 'petty_cash_approved'`);
    out.pettyCashToReconcile = p!.n;
  }
  if (can(actor, 'contract.view')) {
    const [c] = await db.execute<{ n: number }>(sql`select count(*)::int as n from contracts where stage <> 'cancelled' and expiry_date is not null and expiry_date < current_date + 60`);
    out.contractsExpiringSoon = c!.n;
  }
  return out;
}

function periodRange(period: string, anchor: Date) {
  const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  switch (period) {
    case 'day': return [d, new Date(d.getTime() + 864e5)];
    case 'week': { const s = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5); return [s, new Date(s.getTime() + 7 * 864e5)]; }
    case 'month': return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 1))];
    case 'quarter': { const q = Math.floor(m / 3) * 3; return [new Date(Date.UTC(y, q, 1)), new Date(Date.UTC(y, q + 3, 1))]; }
    case 'semester': { const s = m < 6 ? 0 : 6; return [new Date(Date.UTC(y, s, 1)), new Date(Date.UTC(y, s + 6, 1))]; }
    case 'year': return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1))];
    default: throw badRequest('Unknown period.');
  }
}

// Spend = approved/delivered PO value. A PO line serving several stores is split between them
// in proportion to each store's requested quantity (the store allocation).
export async function spend(db: DbOrTx, actor: Actor, period: string, anchor = new Date()) {
  requirePermission(actor, 'spend.view');
  const [from, to] = periodRange(period, anchor) as [Date, Date];
  const rows = await db.execute<{ unit_name: string; track: string; item_code: string; item_description: string; supplier_name: string; amount: string }>(sql`
    with line as (
      select pl.id, pl.item_id, po.supplier_id, (pl.qty * pl.unit_price) as amount
      from po_lines pl join purchase_orders po on po.id = pl.po_id
      where po.status in ('approved', 'delivered') and po.created_at >= ${from.toISOString()} and po.created_at < ${to.toISOString()}
    ), share as (
      select l.id, rl.qty / sum(rl.qty) over (partition by l.id) as fraction, r.org_unit_id, r.track
      from line l join po_line_allocations a on a.po_line_id = l.id
      join request_lines rl on rl.id = a.request_line_id join requests r on r.id = rl.request_id
    )
    select u.name as unit_name, s.track, i.code as item_code, i.description as item_description, sp.name as supplier_name,
           sum(l.amount * s.fraction)::text as amount
    from line l join share s on s.id = l.id join org_units u on u.id = s.org_unit_id
    join items i on i.id = l.item_id join suppliers sp on sp.id = l.supplier_id
    group by u.name, s.track, i.code, i.description, sp.name`);

  const agg = (key: (r: typeof rows[number]) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + Number(r.amount));
    return [...m.entries()].map(([name, amount]) => ({ name, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
  };
  const total = (track: string) => round2(rows.filter((r) => r.track === track).reduce((s, r) => s + Number(r.amount), 0));
  return {
    period, from, to,
    storeSpend: total('store'), hqSpend: total('hq'),
    byUnit: agg((r) => r.unit_name),
    byItem: agg((r) => `${r.item_code} — ${r.item_description}`),
    // Supplier breakdown only for Procurement, Finance and leadership.
    bySupplier: can(actor, 'spend.supplier.view') ? agg((r) => r.supplier_name) : null
  };
}

export async function monthlySummary(db: DbOrTx, actor: Actor, month: string) {
  requirePermission(actor, 'spend.view');
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Use YYYY-MM.');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1)), to = new Date(Date.UTC(y, m, 1)), yearFrom = new Date(Date.UTC(y, 0, 1));
  const q = async (startDate: Date) => {
    const start = startDate.toISOString(), end = to.toISOString();
    const [r] = await db.execute<Record<string, string>>(sql`
      select
        (select count(*) from requests where kind = 'purchase' and not is_petty_cash and submitted_at >= ${start} and submitted_at < ${end})::int as "prs",
        (select count(*) from requests where is_petty_cash and submitted_at >= ${start} and submitted_at < ${end})::int as "pettyCashPrs",
        (select coalesce(sum(estimated_total), 0) from requests where is_petty_cash and status in ('petty_cash_approved','petty_cash_reconciled') and submitted_at >= ${start} and submitted_at < ${end})::text as "pettyCashValue",
        (select count(*) from purchase_orders where status in ('approved','delivered') and created_at >= ${start} and created_at < ${end})::int as "pos",
        (select coalesce(sum(total), 0) from purchase_orders where status in ('approved','delivered') and created_at >= ${start} and created_at < ${end})::text as "spend",
        (select coalesce(sum(case when pl.prior_unit_price is not null then (pl.prior_unit_price - pl.unit_price) * pl.qty else 0 end), 0)
           from po_lines pl join purchase_orders po on po.id = pl.po_id
           where po.status in ('approved','delivered') and po.created_at >= ${start} and po.created_at < ${end})::text as "savings",
        (select coalesce(sum((pl.original_price - pl.unit_price) * pl.qty), 0)
           from po_lines pl join purchase_orders po on po.id = pl.po_id
           where po.status in ('approved','delivered') and po.created_at >= ${start} and po.created_at < ${end})::text as "avoidance",
        (select count(*) from purchase_orders where status = 'cancelled' and cancelled_at >= ${start} and cancelled_at < ${end})::int as "cancelledPos"`);
    return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, typeof v === 'string' ? round2(Number(v)) : v]));
  };
  return { month, thisMonth: await q(from), yearToDate: await q(yearFrom) };
}

// ---------------- exports (CSV, enforced server-side) ----------------
function csv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function exportPriceList(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'export.sensitive', 'Downloading the Price List needs Export Authorization.');
  requirePermission(actor, 'pricing.view');
  const rows = await db.select({ i: t.items, p: t.itemSupplierPrices, s: t.suppliers }).from(t.items)
    .leftJoin(t.itemSupplierPrices, and(eq(t.itemSupplierPrices.itemId, t.items.id), sql`${t.itemSupplierPrices.validTo} is null`))
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.itemSupplierPrices.supplierId))
    .where(eq(t.items.active, true)).orderBy(asc(t.items.description), asc(t.itemSupplierPrices.rank));
  return csv([
    ['Item Code', 'Description', 'Category', 'Type', 'UOM', 'Unit Price', 'Supplier', 'Supplier Rank'],
    ...rows.map((r) => [r.i.code, r.i.description, r.i.category, r.i.procurementType, r.i.uom, r.p?.unitPrice ?? r.i.standardCost, r.s?.name ?? '', r.p?.rank ?? ''])
  ]);
}

export async function exportContracts(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'export.sensitive', 'Downloading contracts needs Export Authorization.');
  requirePermission(actor, 'contract.view');
  const rows = await db.select({ c: t.contracts, s: t.suppliers.name }).from(t.contracts).leftJoin(t.suppliers, eq(t.suppliers.id, t.contracts.supplierId)).orderBy(asc(t.contracts.number));
  return csv([
    ['Number', 'Contract', 'Supplier', 'Stage', 'Start', 'Expiry', 'Key terms', 'Document location'],
    ...rows.map(({ c, s }) => [c.number, c.name, s ?? '', c.stage, c.startDate, c.expiryDate, c.keyTerms, c.documentPointer])
  ]);
}

export async function exportQcs(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'export.sensitive', 'Downloading quote comparisons needs Export Authorization.');
  requirePermission(actor, 'procurement.operate');
  const rows = await db.execute<Record<string, string>>(sql`
    select q.number, q.status, i.code, i.description, qi.qty, qi.uom, s.name as supplier, qu.original_price, qu.unit_price,
      case when sel.id is not null then 'yes' else '' end as selected,
      (select string_agg(distinct r.number, '; ') from qcs_item_lines l join request_lines rl on rl.id = l.request_line_id
         join requests r on r.id = rl.request_id where l.qcs_item_id = qi.id) as prs
    from quote_comparisons q join qcs_items qi on qi.qcs_id = q.id join items i on i.id = qi.item_id
    join quotations qu on qu.qcs_item_id = qi.id join suppliers s on s.id = qu.supplier_id
    left join qcs_selections sel on sel.quotation_id = qu.id and sel.status = 'active'
    order by q.number, i.description, qu.unit_price`);
  return csv([
    ['QCS', 'Status', 'Item Code', 'Item', 'Qty', 'UOM', 'Supplier', 'Original Price', 'Negotiated Price', 'Selected', 'PRs'],
    ...rows.map((r) => [r.number, r.status, r.code, r.description, r.qty, r.uom, r.supplier, r.original_price, r.unit_price, r.selected, r.prs])
  ]);
}

export async function exportPos(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'po.view');
  requirePermission(actor, 'pricing.view');
  const rows = await db.execute<Record<string, string>>(sql`
    select po.number, po.status, po.created_at::date as created, s.name as supplier, q.number as qcs, i.code, i.description,
      pl.qty, pl.uom, pl.unit_price, (pl.qty * pl.unit_price) as amount,
      (select string_agg(distinct r.number, '; ') from po_line_allocations a join request_lines rl on rl.id = a.request_line_id
         join requests r on r.id = rl.request_id where a.po_line_id = pl.id) as prs
    from purchase_orders po join po_lines pl on pl.po_id = po.id join suppliers s on s.id = po.supplier_id
    join items i on i.id = pl.item_id left join quote_comparisons q on q.id = po.qcs_id
    order by po.number, pl.line_no`);
  return csv([
    ['PO', 'Status', 'Date', 'Supplier', 'QCS', 'Item Code', 'Item', 'Qty', 'UOM', 'Unit Price', 'Amount', 'PRs'],
    ...rows.map((r) => [r.number, r.status, r.created, r.supplier, r.qcs, r.code, r.description, r.qty, r.uom, r.unit_price, r.amount, r.prs])
  ]);
}

export async function exportRequests(db: DbOrTx, actor: Actor) {
  const list = await listRequests(db, actor, { limit: 200 });
  const showValue = can(actor, 'pricing.view');
  return csv([
    ['Number', 'Type', 'Petty cash', 'Store/Department', 'Requester', 'Submitted', 'Status', ...(showValue ? ['Estimated value'] : [])],
    ...list.map((r) => [r.number, r.kind, r.isPettyCash ? 'yes' : '', r.orgUnitName, r.requesterName, r.submittedAt.toISOString().slice(0, 10), r.status,
      ...(showValue ? [r.estimatedTotal] : [])])
  ]);
}

export async function auditEntries(db: DbOrTx, actor: Actor, opts: { entityType?: string; entityId?: string; limit?: number }) {
  requirePermission(actor, 'audit.view');
  return db.select({ a: t.auditLog, userName: t.users.name }).from(t.auditLog).leftJoin(t.users, eq(t.users.id, t.auditLog.userId))
    .where(and(opts.entityType ? eq(t.auditLog.entityType, opts.entityType) : undefined, opts.entityId ? eq(t.auditLog.entityId, opts.entityId) : undefined))
    .orderBy(sql`${t.auditLog.id} desc`).limit(Math.min(opts.limit ?? 200, 1000));
}

