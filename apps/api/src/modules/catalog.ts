// Price lookups shared by requests and procurement.
import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import * as t from '../db/schema';

// Estimated unit price per item: the primary supplier's current price, else the cheapest current
// supplier price, else the item's standard (estimated) cost.
export async function estimatedPrices(db: DbOrTx, itemIds: string[]) {
  const out = new Map<string, number>();
  if (!itemIds.length) return out;
  const items = await db.select({ id: t.items.id, standardCost: t.items.standardCost }).from(t.items).where(inArray(t.items.id, itemIds));
  const prices = await db.select().from(t.itemSupplierPrices)
    .where(and(inArray(t.itemSupplierPrices.itemId, itemIds), isNull(t.itemSupplierPrices.validTo)));
  for (const it of items) {
    const mine = prices.filter((p) => p.itemId === it.id).sort((a, b) => a.rank - b.rank || a.unitPrice - b.unitPrice);
    out.set(it.id, mine[0]?.unitPrice ?? it.standardCost ?? 0);
  }
  return out;
}

// Current supplier prices for items, primary first — used to pre-fill quote comparisons and POs.
export async function currentSupplierPrices(db: DbOrTx, itemIds: string[]) {
  if (!itemIds.length) return [];
  return db.select({
    itemId: t.itemSupplierPrices.itemId, supplierId: t.itemSupplierPrices.supplierId, unitPrice: t.itemSupplierPrices.unitPrice,
    rank: t.itemSupplierPrices.rank, supplierName: t.suppliers.name, supplierCode: t.suppliers.code
  }).from(t.itemSupplierPrices).innerJoin(t.suppliers, eq(t.suppliers.id, t.itemSupplierPrices.supplierId))
    .where(and(inArray(t.itemSupplierPrices.itemId, itemIds), isNull(t.itemSupplierPrices.validTo), eq(t.suppliers.active, true)))
    .orderBy(t.itemSupplierPrices.rank, t.itemSupplierPrices.unitPrice);
}

// Last price actually paid for an item on an earlier, non-cancelled PO — the base for cost savings.
export async function lastPaidPrice(db: DbOrTx, itemId: string, excludePoIds: string[] = []) {
  const rows = await db.select({ unitPrice: t.poLines.unitPrice }).from(t.poLines)
    .innerJoin(t.purchaseOrders, eq(t.purchaseOrders.id, t.poLines.poId))
    .where(and(
      eq(t.poLines.itemId, itemId),
      inArray(t.purchaseOrders.status, ['pending_approval', 'approved', 'delivered']),
      excludePoIds.length ? notInArray(t.purchaseOrders.id, excludePoIds) : undefined
    ))
    .orderBy(desc(t.purchaseOrders.createdAt)).limit(1);
  return rows[0]?.unitPrice ?? null;
}
