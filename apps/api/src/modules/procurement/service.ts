// Procurement workflow: Review & Consolidate → Quote Comparison → PO → approval → delivery.
//
// Two rules carried over deliberately from the prototype:
//  1. Nothing is automatic at a commitment point. A person picks the winning quote and a person
//     clicks Generate PO.
//  2. If a PO is cancelled or rejected (e.g. the supplier turns out to be out of stock), its
//     comparison sheet reopens with every quote still on file, and the PR lines go back to it —
//     so the second-place supplier is one click away, with no re-entry and no new PR.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ApprovalActionInput, DirectPoInput } from '@tube/shared';
import type { Db, DbOrTx, Tx } from '../../db/client';
import * as t from '../../db/schema';
import { type Actor, can, requirePermission } from '../../core/actor';
import { act, approvalHistory, cancelOpenApproval, eligibility, pickRule, startApproval } from '../../core/approvals';
import { audit } from '../../core/audit';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { lineAmount, sum } from '../../core/money';
import { nextNumber } from '../../core/numbering';
import { currentSupplierPrices, estimatedPrices, lastPaidPrice } from '../catalog';
import { recomputeRequestStatus } from '../requests/service';

const LIVE_PO: (typeof t.purchaseOrders.$inferSelect.status)[] = ['pending_approval', 'approved', 'delivered'];

// ---------------- review & consolidate ----------------
export async function reviewQueue(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'procurement.operate');
  const rows = await db.select({
    lineId: t.requestLines.id, qty: t.requestLines.qty, itemId: t.requestLines.itemId,
    requestId: t.requests.id, requestNumber: t.requests.number, requiredDate: t.requests.requiredDate, submittedAt: t.requests.submittedAt,
    unitName: t.orgUnits.name, track: t.requests.track, requesterName: t.users.name,
    itemCode: t.items.code, itemDescription: t.items.description, uom: t.items.uom, category: t.items.category
  }).from(t.requestLines)
    .innerJoin(t.requests, eq(t.requests.id, t.requestLines.requestId))
    .innerJoin(t.orgUnits, eq(t.orgUnits.id, t.requests.orgUnitId))
    .innerJoin(t.users, eq(t.users.id, t.requests.requesterId))
    .innerJoin(t.items, eq(t.items.id, t.requestLines.itemId))
    .where(and(eq(t.requestLines.status, 'open'), eq(t.requests.isPettyCash, false), eq(t.requests.kind, 'purchase')))
    .orderBy(asc(t.items.description), asc(t.requests.submittedAt));

  const itemIds = [...new Set(rows.map((r) => r.itemId))];
  const prices = await currentSupplierPrices(db, itemIds);
  const estimates = await estimatedPrices(db, itemIds);
  const groups = new Map<string, {
    itemId: string; itemCode: string; itemDescription: string; uom: string; category: string; totalQty: number; estimatedUnitPrice: number;
    supplierPrices: { supplierId: string; supplierName: string; unitPrice: number; rank: number }[];
    contributors: { lineId: string; requestId: string; requestNumber: string; unitName: string; track: string; requesterName: string; qty: number; requiredDate: string | null; submittedAt: Date }[];
  }>();
  for (const r of rows) {
    let g = groups.get(r.itemId);
    if (!g) {
      g = { itemId: r.itemId, itemCode: r.itemCode, itemDescription: r.itemDescription, uom: r.uom, category: r.category, totalQty: 0,
        estimatedUnitPrice: estimates.get(r.itemId) ?? 0,
        supplierPrices: prices.filter((p) => p.itemId === r.itemId).map((p) => ({ supplierId: p.supplierId, supplierName: p.supplierName, unitPrice: p.unitPrice, rank: p.rank })),
        contributors: [] };
      groups.set(r.itemId, g);
    }
    g.totalQty = Math.round((g.totalQty + r.qty) * 1000) / 1000;
    g.contributors.push({ lineId: r.lineId, requestId: r.requestId, requestNumber: r.requestNumber, unitName: r.unitName, track: r.track,
      requesterName: r.requesterName, qty: r.qty, requiredDate: r.requiredDate, submittedAt: r.submittedAt });
  }
  return [...groups.values()];
}

// Locks the given PR lines and checks they're all in the expected state and match their items.
async function lockLines(tx: Tx, groups: { itemId: string; requestLineIds: string[] }[], expected: 'open' | 'in_qcs') {
  const ids = groups.flatMap((g) => g.requestLineIds);
  if (new Set(ids).size !== ids.length) throw badRequest('A request line was included twice.');
  if (new Set(groups.map((g) => g.itemId)).size !== groups.length) throw badRequest('Each item may appear only once.');
  await tx.execute(sql`select id from request_lines where id in ${ids} for update`);
  const lines = await tx.select({ l: t.requestLines, req: t.requests }).from(t.requestLines)
    .innerJoin(t.requests, eq(t.requests.id, t.requestLines.requestId))
    .where(inArray(t.requestLines.id, ids));
  if (lines.length !== ids.length) throw badRequest('Some request lines no longer exist.');
  for (const g of groups) {
    for (const id of g.requestLineIds) {
      const x = lines.find((l) => l.l.id === id)!;
      if (x.l.itemId !== g.itemId) throw badRequest('A request line doesn\'t match its item.');
      if (x.l.status !== expected || x.req.isPettyCash) throw conflict(`${x.req.number} line ${x.l.lineNo} is no longer waiting for Procurement — refresh and try again.`);
    }
  }
  return lines;
}

// ---------------- quote comparison ----------------
export async function createQcs(db: Db, actor: Actor, input: { groups: { itemId: string; qty: number; requestLineIds: string[] }[]; notes?: string }) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const lines = await lockLines(tx, input.groups, 'open');
    const number = await nextNumber(tx, 'QCS');
    const [qcs] = await tx.insert(t.quoteComparisons).values({ number, status: 'open', notes: input.notes ?? null, createdBy: actor.id }).returning();
    const items = await tx.select().from(t.items).where(inArray(t.items.id, input.groups.map((g) => g.itemId)));
    const prices = await currentSupplierPrices(tx, input.groups.map((g) => g.itemId));
    for (const g of input.groups) {
      const item = items.find((i) => i.id === g.itemId)!;
      const [qi] = await tx.insert(t.qcsItems).values({ qcsId: qcs!.id, itemId: g.itemId, qty: g.qty, uom: item.uom }).returning();
      await tx.insert(t.qcsItemLines).values(g.requestLineIds.map((id) => ({ qcsItemId: qi!.id, requestLineId: id })));
      // Start with the prices already on file for this item; Procurement adds or edits quotes.
      const known = prices.filter((p) => p.itemId === g.itemId);
      if (known.length) {
        await tx.insert(t.quotations).values(known.map((p) => ({
          qcsItemId: qi!.id, supplierId: p.supplierId, originalPrice: p.unitPrice, unitPrice: p.unitPrice, notes: 'Price on file', createdBy: actor.id
        })));
      }
    }
    const ids = input.groups.flatMap((g) => g.requestLineIds);
    await tx.update(t.requestLines).set({ status: 'in_qcs' }).where(inArray(t.requestLines.id, ids));
    for (const rid of new Set(lines.map((l) => l.req.id))) await recomputeRequestStatus(tx, rid);
    await audit(tx, { userId: actor.id, action: 'qcs.create', entityType: 'qcs', entityId: qcs!.id,
      after: { number, items: input.groups.map((g) => ({ itemId: g.itemId, qty: g.qty, lines: g.requestLineIds.length })) } });
    return { id: qcs!.id, number };
  });
}

async function lockQcs(tx: Tx, qcsId: string) {
  await tx.execute(sql`select id from quote_comparisons where id = ${qcsId} for update`);
  const qcs = await tx.query.quoteComparisons.findFirst({ where: eq(t.quoteComparisons.id, qcsId) });
  if (!qcs) throw notFound('Quote comparison');
  return qcs;
}

async function qcsItemWithLock(tx: Tx, qcsItemId: string) {
  const qi = await tx.query.qcsItems.findFirst({ where: eq(t.qcsItems.id, qcsItemId) });
  if (!qi) throw notFound('Comparison item');
  const qcs = await lockQcs(tx, qi.qcsId);
  if (qcs.status !== 'open' && qcs.status !== 'reopened') throw conflict('This comparison sheet is closed.');
  return { qi, qcs };
}

async function hasLivePo(tx: DbOrTx, qcsItemId: string) {
  const row = await tx.select({ id: t.poLines.id }).from(t.poLines).innerJoin(t.purchaseOrders, eq(t.purchaseOrders.id, t.poLines.poId))
    .where(and(eq(t.poLines.qcsItemId, qcsItemId), inArray(t.purchaseOrders.status, LIVE_PO))).limit(1);
  return !!row[0];
}

export async function upsertQuotation(db: Db, actor: Actor, qcsItemId: string, input: { supplierId: string; unitPrice: number; originalPrice?: number; leadTimeDays?: number; notes?: string }) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const { qi } = await qcsItemWithLock(tx, qcsItemId);
    const supplier = await tx.query.suppliers.findFirst({ where: and(eq(t.suppliers.id, input.supplierId), eq(t.suppliers.active, true)) });
    if (!supplier) throw badRequest('Choose an active supplier.');
    const existing = await tx.query.quotations.findFirst({ where: and(eq(t.quotations.qcsItemId, qi.id), eq(t.quotations.supplierId, input.supplierId)) });
    const values = {
      unitPrice: input.unitPrice, originalPrice: input.originalPrice ?? input.unitPrice,
      leadTimeDays: input.leadTimeDays ?? null, notes: input.notes ?? null
    };
    if (existing) {
      const used = await tx.select({ id: t.poLines.id }).from(t.poLines).where(eq(t.poLines.quotationId, existing.id)).limit(1);
      if (used[0]) throw conflict('This quote is already on a PO and is kept as issued. Add a note instead, or cancel that PO first.');
      await tx.update(t.quotations).set(values).where(eq(t.quotations.id, existing.id));
      await audit(tx, { userId: actor.id, action: 'quotation.update', entityType: 'quotation', entityId: existing.id, before: existing, after: values });
      return { id: existing.id };
    }
    const [q] = await tx.insert(t.quotations).values({ qcsItemId: qi.id, supplierId: input.supplierId, createdBy: actor.id, ...values }).returning();
    await audit(tx, { userId: actor.id, action: 'quotation.add', entityType: 'quotation', entityId: q!.id, after: { supplier: supplier.name, ...values } });
    return { id: q!.id };
  });
}

export async function removeQuotation(db: Db, actor: Actor, quotationId: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const q = await tx.query.quotations.findFirst({ where: eq(t.quotations.id, quotationId) });
    if (!q) throw notFound('Quote');
    await qcsItemWithLock(tx, q.qcsItemId);
    const selected = await tx.query.qcsSelections.findFirst({ where: eq(t.qcsSelections.quotationId, q.id) });
    if (selected) throw conflict('This quote was selected before, so it stays on record.');
    await tx.delete(t.quotations).where(eq(t.quotations.id, q.id));
    await audit(tx, { userId: actor.id, action: 'quotation.remove', entityType: 'quotation', entityId: q.id, before: q });
  });
}

// A person picks the winner. Changing your mind supersedes the previous pick (kept in history).
export async function selectQuotation(db: Db, actor: Actor, qcsItemId: string, input: { quotationId: string; reason?: string }) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const { qi } = await qcsItemWithLock(tx, qcsItemId);
    const q = await tx.query.quotations.findFirst({ where: and(eq(t.quotations.id, input.quotationId), eq(t.quotations.qcsItemId, qi.id)) });
    if (!q) throw badRequest('That quote isn\'t on this comparison item.');
    if (await hasLivePo(tx, qi.id)) throw conflict('A PO is already out for this item. Cancel it first to pick another supplier.');
    const current = await tx.query.qcsSelections.findFirst({ where: and(eq(t.qcsSelections.qcsItemId, qi.id), eq(t.qcsSelections.status, 'active')) });
    if (current?.quotationId === q.id) return { id: current.id };
    if (current) {
      await tx.update(t.qcsSelections).set({ status: 'superseded', supersededAt: new Date(), supersededReason: 'Changed selection before PO' })
        .where(eq(t.qcsSelections.id, current.id));
    }
    const [sel] = await tx.insert(t.qcsSelections).values({ qcsItemId: qi.id, quotationId: q.id, status: 'active', reason: input.reason ?? null, selectedBy: actor.id }).returning();
    await audit(tx, { userId: actor.id, action: 'qcs.select', entityType: 'qcs_item', entityId: qi.id, before: current ? { quotationId: current.quotationId } : undefined, after: { quotationId: q.id }, comment: input.reason });
    return { id: sel!.id };
  });
}

// Human click: turns the selected quotes into POs — one per supplier, each with all its items.
export async function generatePosFromQcs(db: Db, actor: Actor, qcsId: string, input: { expectedDeliveryDate?: string; notes?: string }) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const qcs = await lockQcs(tx, qcsId);
    if (qcs.status !== 'open' && qcs.status !== 'reopened') throw conflict('This comparison sheet is closed.');
    const qItems = await tx.query.qcsItems.findMany({ where: eq(t.qcsItems.qcsId, qcs.id) });
    const ready: { qi: typeof qItems[number]; quote: typeof t.quotations.$inferSelect; lineIds: string[] }[] = [];
    for (const qi of qItems) {
      if (await hasLivePo(tx, qi.id)) continue;
      const sel = await tx.query.qcsSelections.findFirst({ where: and(eq(t.qcsSelections.qcsItemId, qi.id), eq(t.qcsSelections.status, 'active')) });
      if (!sel) continue;
      const quote = await tx.query.quotations.findFirst({ where: eq(t.quotations.id, sel.quotationId) });
      const links = await tx.select({ id: t.qcsItemLines.requestLineId }).from(t.qcsItemLines)
        .innerJoin(t.requestLines, eq(t.requestLines.id, t.qcsItemLines.requestLineId))
        .where(and(eq(t.qcsItemLines.qcsItemId, qi.id), eq(t.requestLines.status, 'in_qcs')));
      if (!links.length) continue;
      ready.push({ qi, quote: quote!, lineIds: links.map((l) => l.id) });
    }
    if (!ready.length) throw badRequest('Select a winning quote for at least one item that doesn\'t have a PO yet.');

    const bySupplier = new Map<string, typeof ready>();
    for (const r of ready) bySupplier.set(r.quote.supplierId, [...(bySupplier.get(r.quote.supplierId) ?? []), r]);
    const created = [];
    for (const [supplierId, group] of bySupplier) {
      created.push(await insertPo(tx, actor, {
        supplierId, qcsId: qcs.id, expectedDeliveryDate: input.expectedDeliveryDate, notes: input.notes,
        lines: group.map((g) => ({
          itemId: g.qi.itemId, qty: g.qi.qty, uom: g.qi.uom, unitPrice: g.quote.unitPrice, originalPrice: g.quote.originalPrice,
          qcsItemId: g.qi.id, quotationId: g.quote.id, requestLineIds: g.lineIds
        }))
      }));
    }
    const allCovered = await Promise.all(qItems.map((qi) => hasLivePo(tx, qi.id)));
    if (allCovered.every(Boolean)) await tx.update(t.quoteComparisons).set({ status: 'converted', updatedAt: new Date() }).where(eq(t.quoteComparisons.id, qcs.id));
    return created;
  });
}

export async function cancelQcs(db: Db, actor: Actor, qcsId: string, reason: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const qcs = await lockQcs(tx, qcsId);
    if (qcs.status === 'cancelled' || qcs.status === 'converted') throw conflict('This comparison sheet is already closed.');
    const qItems = await tx.query.qcsItems.findMany({ where: eq(t.qcsItems.qcsId, qcs.id) });
    for (const qi of qItems) if (await hasLivePo(tx, qi.id)) throw conflict('Some items already have a PO. Cancel those POs first.');
    const lineIds = qItems.length ? (await tx.select({ id: t.qcsItemLines.requestLineId }).from(t.qcsItemLines)
      .where(inArray(t.qcsItemLines.qcsItemId, qItems.map((q) => q.id)))).map((l) => l.id) : [];
    const affected = lineIds.length ? await tx.query.requestLines.findMany({ where: and(inArray(t.requestLines.id, lineIds), eq(t.requestLines.status, 'in_qcs')) }) : [];
    if (affected.length) await tx.update(t.requestLines).set({ status: 'open' }).where(inArray(t.requestLines.id, affected.map((l) => l.id)));
    await tx.update(t.quoteComparisons).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(t.quoteComparisons.id, qcs.id));
    for (const rid of new Set(affected.map((l) => l.requestId))) await recomputeRequestStatus(tx, rid);
    await audit(tx, { userId: actor.id, action: 'qcs.cancel', entityType: 'qcs', entityId: qcs.id, comment: reason });
  });
}

// ---------------- purchase orders ----------------
interface PoLineDraft {
  itemId: string; qty: number; uom: string; unitPrice: number; originalPrice: number;
  qcsItemId?: string; quotationId?: string; requestLineIds: string[];
}

async function insertPo(tx: Tx, actor: Actor, args: { supplierId: string; qcsId: string | null; expectedDeliveryDate?: string; notes?: string; lines: PoLineDraft[] }) {
  const supplier = await tx.query.suppliers.findFirst({ where: and(eq(t.suppliers.id, args.supplierId), eq(t.suppliers.active, true)) });
  if (!supplier) throw badRequest('Choose an active supplier.');
  const total = sum(args.lines.map((l) => lineAmount(l.qty, l.unitPrice)));
  const { rule, steps } = await pickRule(tx, 'po', total);
  const number = await nextNumber(tx, 'PO');
  const [po] = await tx.insert(t.purchaseOrders).values({
    number, supplierId: supplier.id, qcsId: args.qcsId, status: 'pending_approval', total,
    expectedDeliveryDate: args.expectedDeliveryDate ?? null, notes: args.notes ?? null, createdBy: actor.id
  }).returning();
  let lineNo = 0;
  for (const l of args.lines) {
    const prior = await lastPaidPrice(tx, l.itemId, [po!.id]);
    const [pl] = await tx.insert(t.poLines).values({
      poId: po!.id, lineNo: ++lineNo, itemId: l.itemId, qty: l.qty, uom: l.uom, unitPrice: l.unitPrice,
      originalPrice: Math.max(l.originalPrice, l.unitPrice), priorUnitPrice: prior, qcsItemId: l.qcsItemId ?? null, quotationId: l.quotationId ?? null
    }).returning();
    await tx.insert(t.poLineAllocations).values(l.requestLineIds.map((rid) => ({ poLineId: pl!.id, requestLineId: rid })));
  }
  const allLineIds = args.lines.flatMap((l) => l.requestLineIds);
  await tx.update(t.requestLines).set({ status: 'ordered' }).where(inArray(t.requestLines.id, allLineIds));
  const reqIds = await tx.selectDistinct({ id: t.requestLines.requestId }).from(t.requestLines).where(inArray(t.requestLines.id, allLineIds));
  for (const r of reqIds) await recomputeRequestStatus(tx, r.id);

  const { autoApproved } = await startApproval(tx, { kind: 'po', documentId: po!.id, amount: total, orgUnitId: null, rule, steps });
  if (autoApproved) await tx.update(t.purchaseOrders).set({ status: 'approved', approvedAt: new Date() }).where(eq(t.purchaseOrders.id, po!.id));
  await audit(tx, { userId: actor.id, action: 'po.create', entityType: 'po', entityId: po!.id,
    after: { number, supplier: supplier.name, total, qcsId: args.qcsId, rule: rule.name, lines: args.lines.length } });
  return { id: po!.id, number, total, supplierName: supplier.name, status: autoApproved ? 'approved' : 'pending_approval' };
}

// Routine, already-priced items: a PO straight from Review & Consolidate, no comparison needed.
export async function createDirectPo(db: Db, actor: Actor, input: DirectPoInput) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    await lockLines(tx, input.lines, 'open');
    const items = await tx.select().from(t.items).where(inArray(t.items.id, input.lines.map((l) => l.itemId)));
    return insertPo(tx, actor, {
      supplierId: input.supplierId, qcsId: null, expectedDeliveryDate: input.expectedDeliveryDate, notes: input.notes,
      lines: input.lines.map((l) => ({
        itemId: l.itemId, qty: l.qty, uom: items.find((i) => i.id === l.itemId)!.uom,
        unitPrice: l.unitPrice, originalPrice: l.unitPrice, requestLineIds: l.requestLineIds
      }))
    });
  });
}

async function lockPo(tx: Tx, poId: string) {
  await tx.execute(sql`select id from purchase_orders where id = ${poId} for update`);
  const po = await tx.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId) });
  if (!po) throw notFound('Purchase order');
  return po;
}

// Sends a PO's PR lines back: to their comparison sheet (reopened, with the failed pick
// superseded) or, for direct POs, back to Review & Consolidate.
async function releasePo(tx: Tx, po: typeof t.purchaseOrders.$inferSelect, reason: string) {
  const lines = await tx.query.poLines.findMany({ where: eq(t.poLines.poId, po.id) });
  const touchedRequests = new Set<string>();
  for (const pl of lines) {
    const allocs = await tx.query.poLineAllocations.findMany({ where: eq(t.poLineAllocations.poLineId, pl.id) });
    const reqLineIds = allocs.map((a) => a.requestLineId);
    if (pl.qcsItemId) {
      await tx.update(t.qcsSelections).set({ status: 'superseded', supersededAt: new Date(), supersededReason: `PO ${po.number} ${reason}` })
        .where(and(eq(t.qcsSelections.qcsItemId, pl.qcsItemId), eq(t.qcsSelections.status, 'active'), eq(t.qcsSelections.quotationId, pl.quotationId!)));
      const qi = await tx.query.qcsItems.findFirst({ where: eq(t.qcsItems.id, pl.qcsItemId) });
      await tx.update(t.quoteComparisons).set({ status: 'reopened', updatedAt: new Date() }).where(eq(t.quoteComparisons.id, qi!.qcsId));
    }
    if (reqLineIds.length) {
      const affected = await tx.query.requestLines.findMany({ where: and(inArray(t.requestLines.id, reqLineIds), eq(t.requestLines.status, 'ordered')) });
      if (affected.length) {
        await tx.update(t.requestLines).set({ status: pl.qcsItemId ? 'in_qcs' : 'open' }).where(inArray(t.requestLines.id, affected.map((l) => l.id)));
        affected.forEach((l) => touchedRequests.add(l.requestId));
      }
    }
  }
  for (const rid of touchedRequests) await recomputeRequestStatus(tx, rid);
}

export async function actOnPo(db: Db, actor: Actor, poId: string, input: ApprovalActionInput) {
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== 'pending_approval') throw conflict('This PO is not waiting for approval.');
    const { outcome } = await act(tx, actor, { kind: 'po', documentId: po.id, ownerId: po.createdBy, action: input.action, comment: input.comment });
    if (outcome === 'approved') await tx.update(t.purchaseOrders).set({ status: 'approved', approvedAt: new Date(), updatedAt: new Date() }).where(eq(t.purchaseOrders.id, po.id));
    if (outcome === 'rejected' || outcome === 'changes_requested') {
      // Either way the PO can't go out as is; the lines return so Procurement can fix and regenerate.
      await tx.update(t.purchaseOrders).set({ status: 'rejected', cancelReason: input.comment ?? null, updatedAt: new Date() }).where(eq(t.purchaseOrders.id, po.id));
      await releasePo(tx, po, outcome === 'rejected' ? `rejected: ${input.comment}` : `returned for changes: ${input.comment}`);
    }
    return { outcome };
  });
}

export async function cancelPo(db: Db, actor: Actor, poId: string, reason: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== 'pending_approval' && po.status !== 'approved') throw conflict('Only POs that haven\'t been delivered can be cancelled.');
    await cancelOpenApproval(tx, 'po', po.id);
    await tx.update(t.purchaseOrders).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() }).where(eq(t.purchaseOrders.id, po.id));
    await releasePo(tx, po, `cancelled: ${reason}`);
    await audit(tx, { userId: actor.id, action: 'po.cancel', entityType: 'po', entityId: po.id, before: { status: po.status }, comment: reason });
  });
}

export async function deliverPo(db: Db, actor: Actor, poId: string, note?: string) {
  requirePermission(actor, 'procurement.operate');
  return db.transaction(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status !== 'approved') throw conflict(po.status === 'pending_approval' ? 'This PO still needs approval.' : 'This PO can\'t be marked delivered.');
    await tx.update(t.purchaseOrders).set({ status: 'delivered', deliveredAt: new Date(), deliveredBy: actor.id, deliveryNote: note ?? null, updatedAt: new Date() })
      .where(eq(t.purchaseOrders.id, po.id));
    const reqLines = await tx.select({ id: t.poLineAllocations.requestLineId }).from(t.poLineAllocations)
      .innerJoin(t.poLines, eq(t.poLines.id, t.poLineAllocations.poLineId)).where(eq(t.poLines.poId, po.id));
    const ids = reqLines.map((r) => r.id);
    if (ids.length) {
      await tx.update(t.requestLines).set({ status: 'delivered' }).where(and(inArray(t.requestLines.id, ids), eq(t.requestLines.status, 'ordered')));
      const reqIds = await tx.selectDistinct({ id: t.requestLines.requestId }).from(t.requestLines).where(inArray(t.requestLines.id, ids));
      for (const r of reqIds) await recomputeRequestStatus(tx, r.id);
    }
    await audit(tx, { userId: actor.id, action: 'po.deliver', entityType: 'po', entityId: po.id, comment: note });
  });
}

// ---------------- reading ----------------
export async function listQcs(db: DbOrTx, actor: Actor, status?: string) {
  requirePermission(actor, 'procurement.operate');
  const rows = await db.select({ q: t.quoteComparisons, createdByName: t.users.name }).from(t.quoteComparisons)
    .innerJoin(t.users, eq(t.users.id, t.quoteComparisons.createdBy))
    .where(status ? eq(t.quoteComparisons.status, status as 'open') : undefined)
    .orderBy(desc(t.quoteComparisons.createdAt)).limit(200);
  const out = [];
  for (const r of rows) out.push(await getQcs(db, actor, r.q.id));
  return out;
}

export async function getQcs(db: DbOrTx, actor: Actor, qcsId: string) {
  requirePermission(actor, 'procurement.operate');
  const q = await db.query.quoteComparisons.findFirst({ where: eq(t.quoteComparisons.id, qcsId) });
  if (!q) throw notFound('Quote comparison');
  const createdBy = await db.query.users.findFirst({ where: eq(t.users.id, q.createdBy) });
  const qItems = await db.select({ qi: t.qcsItems, code: t.items.code, description: t.items.description })
    .from(t.qcsItems).innerJoin(t.items, eq(t.items.id, t.qcsItems.itemId)).where(eq(t.qcsItems.qcsId, q.id)).orderBy(asc(t.items.description));
  const items = [];
  const prNumbers = new Set<string>();
  for (const { qi, code, description } of qItems) {
    const quotes = await db.select({ q: t.quotations, supplierName: t.suppliers.name }).from(t.quotations)
      .innerJoin(t.suppliers, eq(t.suppliers.id, t.quotations.supplierId)).where(eq(t.quotations.qcsItemId, qi.id)).orderBy(asc(t.quotations.unitPrice));
    const selections = await db.select({ s: t.qcsSelections, byName: t.users.name }).from(t.qcsSelections)
      .innerJoin(t.users, eq(t.users.id, t.qcsSelections.selectedBy)).where(eq(t.qcsSelections.qcsItemId, qi.id)).orderBy(asc(t.qcsSelections.selectedAt));
    const contributors = await db.select({ lineId: t.requestLines.id, qty: t.requestLines.qty, status: t.requestLines.status,
      number: t.requests.number, unitName: t.orgUnits.name })
      .from(t.qcsItemLines).innerJoin(t.requestLines, eq(t.requestLines.id, t.qcsItemLines.requestLineId))
      .innerJoin(t.requests, eq(t.requests.id, t.requestLines.requestId)).innerJoin(t.orgUnits, eq(t.orgUnits.id, t.requests.orgUnitId))
      .where(eq(t.qcsItemLines.qcsItemId, qi.id));
    contributors.forEach((c) => prNumbers.add(c.number));
    const poRows = await db.select({ id: t.purchaseOrders.id, number: t.purchaseOrders.number, status: t.purchaseOrders.status, quotationId: t.poLines.quotationId })
      .from(t.poLines).innerJoin(t.purchaseOrders, eq(t.purchaseOrders.id, t.poLines.poId)).where(eq(t.poLines.qcsItemId, qi.id)).orderBy(asc(t.purchaseOrders.createdAt));
    const active = selections.find((s) => s.s.status === 'active');
    items.push({
      id: qi.id, itemId: qi.itemId, itemCode: code, itemDescription: description, qty: qi.qty, uom: qi.uom,
      quotes: quotes.map(({ q: qu, supplierName }) => ({
        id: qu.id, supplierId: qu.supplierId, supplierName, unitPrice: qu.unitPrice, originalPrice: qu.originalPrice,
        leadTimeDays: qu.leadTimeDays, notes: qu.notes, selected: active?.s.quotationId === qu.id,
        failedBefore: selections.some((s) => s.s.quotationId === qu.id && s.s.status === 'superseded' && (s.s.supersededReason ?? '').startsWith('PO '))
      })),
      selectionHistory: selections.map(({ s, byName }) => ({ quotationId: s.quotationId, status: s.status, by: byName, at: s.selectedAt, reason: s.reason, supersededReason: s.supersededReason })),
      contributors, pos: poRows, hasLivePo: poRows.some((p) => LIVE_PO.includes(p.status))
    });
  }
  return { id: q.id, number: q.number, status: q.status, notes: q.notes, createdAt: q.createdAt, createdBy: createdBy?.name ?? '', prNumbers: [...prNumbers].sort(), items };
}

export async function listPos(db: DbOrTx, actor: Actor, filters: { status?: string } = {}) {
  requirePermission(actor, 'po.view');
  const showPrice = can(actor, 'pricing.view');
  const rows = await db.select({ po: t.purchaseOrders, supplierName: t.suppliers.name, qcsNumber: t.quoteComparisons.number })
    .from(t.purchaseOrders).innerJoin(t.suppliers, eq(t.suppliers.id, t.purchaseOrders.supplierId))
    .leftJoin(t.quoteComparisons, eq(t.quoteComparisons.id, t.purchaseOrders.qcsId))
    .where(filters.status ? eq(t.purchaseOrders.status, filters.status as 'approved') : undefined)
    .orderBy(desc(t.purchaseOrders.createdAt)).limit(300);
  return rows.map(({ po, supplierName, qcsNumber }) => ({
    id: po.id, number: po.number, status: po.status, supplierName, qcsNumber, total: showPrice ? po.total : null,
    createdAt: po.createdAt, expectedDeliveryDate: po.expectedDeliveryDate, deliveredAt: po.deliveredAt
  }));
}

export async function getPo(db: DbOrTx, actor: Actor, poId: string) {
  requirePermission(actor, 'po.view');
  const showPrice = can(actor, 'pricing.view');
  const po = await db.query.purchaseOrders.findFirst({ where: eq(t.purchaseOrders.id, poId) });
  if (!po) throw notFound('Purchase order');
  const supplier = await db.query.suppliers.findFirst({ where: eq(t.suppliers.id, po.supplierId) });
  const qcs = po.qcsId ? await db.query.quoteComparisons.findFirst({ where: eq(t.quoteComparisons.id, po.qcsId) }) : null;
  const creator = await db.query.users.findFirst({ where: eq(t.users.id, po.createdBy) });
  const lines = await db.select({ l: t.poLines, code: t.items.code, description: t.items.description })
    .from(t.poLines).innerJoin(t.items, eq(t.items.id, t.poLines.itemId)).where(eq(t.poLines.poId, po.id)).orderBy(asc(t.poLines.lineNo));
  const outLines = [];
  const prNumbers = new Set<string>();
  for (const { l, code, description } of lines) {
    const alloc = await db.select({ qty: t.requestLines.qty, number: t.requests.number, requestId: t.requests.id, unitName: t.orgUnits.name })
      .from(t.poLineAllocations).innerJoin(t.requestLines, eq(t.requestLines.id, t.poLineAllocations.requestLineId))
      .innerJoin(t.requests, eq(t.requests.id, t.requestLines.requestId)).innerJoin(t.orgUnits, eq(t.orgUnits.id, t.requests.orgUnitId))
      .where(eq(t.poLineAllocations.poLineId, l.id));
    alloc.forEach((a) => prNumbers.add(a.number));
    const amount = lineAmount(l.qty, l.unitPrice);
    outLines.push({
      id: l.id, lineNo: l.lineNo, itemCode: code, itemDescription: description, qty: l.qty, uom: l.uom,
      unitPrice: showPrice ? l.unitPrice : null, amount: showPrice ? amount : null,
      originalPrice: showPrice ? l.originalPrice : null, priorUnitPrice: showPrice ? l.priorUnitPrice : null,
      savings: showPrice && l.priorUnitPrice != null ? lineAmount(l.qty, l.priorUnitPrice) - amount : null,
      avoidance: showPrice ? lineAmount(l.qty, l.originalPrice) - amount : null,
      // Store allocation: each requesting store's share of this line.
      allocation: alloc
    });
  }
  const approvals = await approvalHistory(db, 'po', po.id);
  const pendingStep = approvals.at(-1)?.status === 'pending'
    ? await db.select({ s: t.approvalSteps }).from(t.approvalSteps).innerJoin(t.approvalInstances, eq(t.approvalInstances.id, t.approvalSteps.instanceId))
      .where(and(eq(t.approvalInstances.documentKind, 'po'), eq(t.approvalInstances.documentId, po.id), eq(t.approvalInstances.status, 'pending'), eq(t.approvalSteps.status, 'pending')))
    : [];
  const canAct = pendingStep[0] ? !!(await eligibility(db, actor, pendingStep[0].s, po.createdBy)) : false;
  const operate = can(actor, 'procurement.operate');
  return {
    id: po.id, number: po.number, status: po.status, total: showPrice ? po.total : null, currency: po.currency,
    supplier: { id: supplier!.id, name: supplier!.name, code: supplier!.code, phone: supplier!.phone, contactName: supplier!.contactName, paymentTerms: supplier!.paymentTerms },
    qcs: qcs ? { id: qcs.id, number: qcs.number } : null, prNumbers: [...prNumbers].sort(),
    createdAt: po.createdAt, createdBy: creator?.name ?? '', expectedDeliveryDate: po.expectedDeliveryDate, notes: po.notes,
    approvedAt: po.approvedAt, deliveredAt: po.deliveredAt, deliveryNote: po.deliveryNote, cancelledAt: po.cancelledAt, cancelReason: po.cancelReason,
    lines: outLines, approvals,
    totals: showPrice ? {
      savings: sum(outLines.map((l) => l.savings ?? 0)), avoidance: sum(outLines.map((l) => l.avoidance ?? 0))
    } : null,
    permissions: {
      canAct, canCancel: operate && (po.status === 'pending_approval' || po.status === 'approved'),
      canDeliver: operate && po.status === 'approved'
    }
  };
}

export function assertOperate(actor: Actor) {
  if (!can(actor, 'procurement.operate')) throw forbidden();
}
