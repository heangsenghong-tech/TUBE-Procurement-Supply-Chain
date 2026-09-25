// Item & Supplier Master, stores/departments, users & roles, contracts and approval rules.
import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, type ItemInput, type SupplierInput } from '@tube/shared';
import type { Db, DbOrTx } from '../../db/client';
import * as t from '../../db/schema';
import { type Actor, can, requirePermission } from '../../core/actor';
import { audit } from '../../core/audit';
import { badRequest, conflict, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { deleteUserSessions } from '../../core/sessions';
import { UOMS } from '../../db/seed/reference';

// ---------------- items ----------------
// The catalog everyone searches when raising a PR. Prices and suppliers only for pricing roles.
export async function listItems(db: DbOrTx, actor: Actor, opts: { q?: string; includeInactive?: boolean } = {}) {
  const where = and(
    opts.includeInactive && can(actor, 'master.manage') ? undefined : eq(t.items.active, true),
    opts.q ? or(ilike(t.items.code, `%${opts.q}%`), ilike(t.items.description, `%${opts.q}%`)) : undefined
  );
  const items = await db.select().from(t.items).where(where).orderBy(asc(t.items.description));
  const base = items.map((i) => ({
    id: i.id, code: i.code, description: i.description, category: i.category, procurementType: i.procurementType,
    uom: i.uom, active: i.active, isReference: i.isReference, specification: i.specification, brand: i.brand
  }));
  if (!can(actor, 'pricing.view')) return base;
  const prices = await db.select({ p: t.itemSupplierPrices, supplierName: t.suppliers.name, supplierCode: t.suppliers.code })
    .from(t.itemSupplierPrices).innerJoin(t.suppliers, eq(t.suppliers.id, t.itemSupplierPrices.supplierId))
    .where(isNull(t.itemSupplierPrices.validTo)).orderBy(asc(t.itemSupplierPrices.rank), asc(t.itemSupplierPrices.unitPrice));
  return base.map((b) => {
    const mine = prices.filter((p) => p.p.itemId === b.id);
    return {
      ...b,
      standardCost: items.find((i) => i.id === b.id)!.standardCost,
      prices: mine.map((p) => ({ id: p.p.id, supplierId: p.p.supplierId, supplierName: p.supplierName, supplierCode: p.supplierCode, unitPrice: p.p.unitPrice, rank: p.p.rank }))
    };
  });
}

export async function upsertItem(db: Db, actor: Actor, id: string | null, input: ItemInput) {
  requirePermission(actor, 'master.manage');
  if (!UOMS[input.uom]) throw badRequest(`Unknown unit "${input.uom}". Use one of: ${Object.keys(UOMS).join(', ')}.`);
  return db.transaction(async (tx) => {
    const dup = await tx.query.items.findFirst({ where: sql`lower(${t.items.code}) = lower(${input.code})` });
    if (dup && dup.id !== id) throw conflict(`Item code ${input.code} already exists.`);
    const values = {
      code: input.code, description: input.description, category: input.category, procurementType: input.procurementType,
      uom: input.uom, specification: input.specification ?? null, brand: input.brand ?? null,
      standardCost: input.standardCost ?? null, isReference: input.isReference ?? false, active: input.active ?? true, updatedAt: new Date()
    };
    if (id) {
      const before = await tx.query.items.findFirst({ where: eq(t.items.id, id) });
      if (!before) throw notFound('Item');
      await tx.update(t.items).set(values).where(eq(t.items.id, id));
      await audit(tx, { userId: actor.id, action: 'item.update', entityType: 'item', entityId: id, before, after: values });
      return { id };
    }
    const [row] = await tx.insert(t.items).values(values).returning();
    await audit(tx, { userId: actor.id, action: 'item.create', entityType: 'item', entityId: row!.id, after: values });
    return { id: row!.id };
  });
}

// Sets a supplier's price for an item. The old price is closed (valid_to), keeping price history.
export async function setItemPrice(db: Db, actor: Actor, itemId: string, input: { supplierId: string; unitPrice: number; rank: number }) {
  requirePermission(actor, 'master.manage');
  return db.transaction(async (tx) => {
    const item = await tx.query.items.findFirst({ where: eq(t.items.id, itemId) });
    const supplier = await tx.query.suppliers.findFirst({ where: eq(t.suppliers.id, input.supplierId) });
    if (!item || !supplier) throw notFound('Item or supplier');
    const current = await tx.query.itemSupplierPrices.findFirst({
      where: and(eq(t.itemSupplierPrices.itemId, itemId), eq(t.itemSupplierPrices.supplierId, input.supplierId), isNull(t.itemSupplierPrices.validTo))
    });
    if (current) await tx.update(t.itemSupplierPrices).set({ validTo: new Date() }).where(eq(t.itemSupplierPrices.id, current.id));
    await tx.insert(t.itemSupplierPrices).values({ itemId, supplierId: input.supplierId, unitPrice: input.unitPrice, rank: input.rank, createdBy: actor.id });
    await audit(tx, { userId: actor.id, action: 'item.price', entityType: 'item', entityId: itemId,
      before: current ? { supplier: supplier.name, unitPrice: current.unitPrice, rank: current.rank } : undefined,
      after: { supplier: supplier.name, unitPrice: input.unitPrice, rank: input.rank } });
  });
}

export async function removeItemPrice(db: Db, actor: Actor, priceId: string) {
  requirePermission(actor, 'master.manage');
  return db.transaction(async (tx) => {
    const p = await tx.query.itemSupplierPrices.findFirst({ where: and(eq(t.itemSupplierPrices.id, priceId), isNull(t.itemSupplierPrices.validTo)) });
    if (!p) throw notFound('Price');
    await tx.update(t.itemSupplierPrices).set({ validTo: new Date() }).where(eq(t.itemSupplierPrices.id, p.id));
    await audit(tx, { userId: actor.id, action: 'item.price.remove', entityType: 'item', entityId: p.itemId, before: p });
  });
}

// ---------------- suppliers ----------------
export async function listSuppliers(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'supplier.view');
  return db.select().from(t.suppliers).orderBy(asc(t.suppliers.name));
}

export async function upsertSupplier(db: Db, actor: Actor, id: string | null, input: SupplierInput) {
  requirePermission(actor, 'master.manage');
  return db.transaction(async (tx) => {
    const values = {
      name: input.name, category: input.category, contactName: input.contactName ?? null, phone: input.phone ?? null,
      email: input.email ?? null, address: input.address ?? null, paymentTerms: input.paymentTerms ?? null,
      deliveryTerms: input.deliveryTerms ?? null, leadTimeDays: input.leadTimeDays ?? null, active: input.active ?? true, updatedAt: new Date()
    };
    if (id) {
      const before = await tx.query.suppliers.findFirst({ where: eq(t.suppliers.id, id) });
      if (!before) throw notFound('Supplier');
      await tx.update(t.suppliers).set(values).where(eq(t.suppliers.id, id));
      await audit(tx, { userId: actor.id, action: 'supplier.update', entityType: 'supplier', entityId: id, before, after: values });
      return { id, code: before.code };
    }
    const rows = await tx.execute<{ n: number }>(sql`select coalesce(max(substring(code from 5)::int), 0) + 1 as n from suppliers where code ~ '^SUP-[0-9]+$'`);
    const code = 'SUP-' + String(rows[0]!.n).padStart(4, '0');
    const [row] = await tx.insert(t.suppliers).values({ code, ...values }).returning();
    await audit(tx, { userId: actor.id, action: 'supplier.create', entityType: 'supplier', entityId: row!.id, after: { code, ...values } });
    return { id: row!.id, code };
  });
}

// ---------------- stores & departments ----------------
export async function listOrgUnits(db: DbOrTx) {
  const rows = await db.select({ u: t.orgUnits, hodName: t.users.name }).from(t.orgUnits)
    .leftJoin(t.users, eq(t.users.id, t.orgUnits.hodUserId)).orderBy(asc(t.orgUnits.type), asc(t.orgUnits.name));
  return rows.map(({ u, hodName }) => ({ id: u.id, code: u.code, name: u.name, type: u.type, ownership: u.ownership, active: u.active, hodUserId: u.hodUserId, hodName }));
}

export async function upsertOrgUnit(db: Db, actor: Actor, id: string | null, input: { code: string; name: string; type: 'store' | 'department'; ownership?: 'franchiser' | 'franchisee'; hodUserId?: string | null; active?: boolean }) {
  requirePermission(actor, 'master.manage');
  return db.transaction(async (tx) => {
    const dup = await tx.query.orgUnits.findFirst({ where: sql`lower(${t.orgUnits.code}) = lower(${input.code})` });
    if (dup && dup.id !== id) throw conflict(`Code ${input.code} is already used by ${dup.name}.`);
    if (input.hodUserId) {
      const hod = await tx.query.users.findFirst({ where: and(eq(t.users.id, input.hodUserId), eq(t.users.active, true)) });
      if (!hod) throw badRequest('The HOD must be an active user.');
    }
    const values = {
      code: input.code, name: input.name, type: input.type, ownership: input.type === 'store' ? (input.ownership ?? 'franchisee') : null,
      hodUserId: input.hodUserId ?? null, active: input.active ?? true, updatedAt: new Date()
    };
    if (id) {
      const before = await tx.query.orgUnits.findFirst({ where: eq(t.orgUnits.id, id) });
      if (!before) throw notFound('Store/department');
      await tx.update(t.orgUnits).set(values).where(eq(t.orgUnits.id, id));
      await audit(tx, { userId: actor.id, action: 'org_unit.update', entityType: 'org_unit', entityId: id, before, after: values });
      return { id };
    }
    const [row] = await tx.insert(t.orgUnits).values(values).returning();
    await audit(tx, { userId: actor.id, action: 'org_unit.create', entityType: 'org_unit', entityId: row!.id, after: values });
    return { id: row!.id };
  });
}

// ---------------- users & roles ----------------
export async function listUsers(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'users.manage');
  const users = await db.select({ u: t.users, unitName: t.orgUnits.name }).from(t.users)
    .leftJoin(t.orgUnits, eq(t.orgUnits.id, t.users.orgUnitId)).orderBy(asc(t.users.name));
  const roleRows = await db.select({ userId: t.userRoles.userId, key: t.roles.key }).from(t.userRoles).innerJoin(t.roles, eq(t.roles.id, t.userRoles.roleId));
  return users.map(({ u, unitName }) => ({
    id: u.id, email: u.email, name: u.name, orgUnitId: u.orgUnitId, orgUnitName: unitName, active: u.active,
    lastLoginAt: u.lastLoginAt, roleKeys: roleRows.filter((r) => r.userId === u.id).map((r) => r.key)
  }));
}

export async function listRoles(db: DbOrTx) {
  const roles = await db.select().from(t.roles).orderBy(asc(t.roles.name));
  const perms = await db.select().from(t.rolePermissions);
  return roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission) }));
}

export async function upsertUser(db: Db, actor: Actor, id: string | null, input: { email: string; name: string; orgUnitId?: string | null; roleKeys: string[]; active?: boolean }) {
  requirePermission(actor, 'users.manage');
  return db.transaction(async (tx) => {
    const roles = input.roleKeys.length ? await tx.query.roles.findMany({ where: inArray(t.roles.key, input.roleKeys) }) : [];
    if (roles.length !== new Set(input.roleKeys).size) throw badRequest('Unknown role.');
    if (roles.some((r) => r.key === 'super_admin') && !actor.roles.has('super_admin')) throw badRequest('Only a Super Admin can grant Super Admin.');
    if (id === actor.id && (input.active === false || (actor.roles.has('super_admin') && !input.roleKeys.includes('super_admin')))) {
      throw badRequest('You can\'t disable yourself or remove your own Super Admin role.');
    }
    const dup = await tx.query.users.findFirst({ where: eq(t.users.email, input.email) });
    if (dup && dup.id !== id) throw conflict(`${input.email} already has an account.`);
    const values = { email: input.email, name: input.name, orgUnitId: input.orgUnitId ?? null, active: input.active ?? true, updatedAt: new Date() };
    let userId = id;
    let before: unknown;
    if (id) {
      const existing = await tx.query.users.findFirst({ where: eq(t.users.id, id) });
      if (!existing) throw notFound('User');
      const oldRoles = await tx.select({ key: t.roles.key }).from(t.userRoles).innerJoin(t.roles, eq(t.roles.id, t.userRoles.roleId)).where(eq(t.userRoles.userId, id));
      if (oldRoles.some((r) => r.key === 'super_admin') && !actor.roles.has('super_admin')) throw badRequest('Only a Super Admin can change a Super Admin.');
      before = { ...existing, roleKeys: oldRoles.map((r) => r.key) };
      // Changing the email breaks the link to their Google account until they sign in again.
      await tx.update(t.users).set({ ...values, googleSub: existing.email === input.email ? existing.googleSub : null }).where(eq(t.users.id, id));
      await tx.delete(t.userRoles).where(eq(t.userRoles.userId, id));
    } else {
      const [row] = await tx.insert(t.users).values(values).returning();
      userId = row!.id;
    }
    if (roles.length) await tx.insert(t.userRoles).values(roles.map((r) => ({ userId: userId!, roleId: r.id })));
    if (input.active === false) await deleteUserSessions(tx, userId!);
    await audit(tx, { userId: actor.id, action: id ? 'user.update' : 'user.create', entityType: 'user', entityId: userId!, before, after: { ...values, roleKeys: input.roleKeys } });
    return { id: userId! };
  });
}

export async function setRolePermissions(db: Db, actor: Actor, roleKey: string, permissions: string[]) {
  requirePermission(actor, 'users.manage');
  if (roleKey === 'super_admin') throw badRequest('Super Admin always has every permission.');
  const unknown = permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
  if (unknown.length) throw badRequest(`Unknown permission: ${unknown.join(', ')}`);
  return db.transaction(async (tx) => {
    const role = await tx.query.roles.findFirst({ where: eq(t.roles.key, roleKey) });
    if (!role) throw notFound('Role');
    const before = (await tx.select().from(t.rolePermissions).where(eq(t.rolePermissions.roleId, role.id))).map((p) => p.permission);
    await tx.delete(t.rolePermissions).where(eq(t.rolePermissions.roleId, role.id));
    if (permissions.length) await tx.insert(t.rolePermissions).values(permissions.map((p) => ({ roleId: role.id, permission: p })));
    await audit(tx, { userId: actor.id, action: 'role.permissions', entityType: 'role', entityId: role.id, before, after: permissions });
  });
}

// ---------------- contracts ----------------
export async function listContracts(db: DbOrTx, actor: Actor) {
  requirePermission(actor, 'contract.view');
  const rows = await db.select({ c: t.contracts, supplierName: t.suppliers.name }).from(t.contracts)
    .leftJoin(t.suppliers, eq(t.suppliers.id, t.contracts.supplierId)).orderBy(asc(t.contracts.expiryDate));
  return rows.map(({ c, supplierName }) => ({ ...c, supplierName }));
}

export async function upsertContract(db: Db, actor: Actor, id: string | null, input: {
  name: string; supplierId?: string; stage: typeof t.contracts.$inferSelect.stage; startDate?: string; expiryDate?: string; keyTerms?: string; documentPointer?: string;
}) {
  requirePermission(actor, 'contract.manage');
  if (input.startDate && input.expiryDate && input.expiryDate < input.startDate) throw badRequest('Expiry date is before the start date.');
  return db.transaction(async (tx) => {
    const values = {
      name: input.name, supplierId: input.supplierId ?? null, stage: input.stage, startDate: input.startDate ?? null,
      expiryDate: input.expiryDate ?? null, keyTerms: input.keyTerms ?? null, documentPointer: input.documentPointer ?? null, updatedAt: new Date()
    };
    if (id) {
      const before = await tx.query.contracts.findFirst({ where: eq(t.contracts.id, id) });
      if (!before) throw notFound('Contract');
      await tx.update(t.contracts).set(values).where(eq(t.contracts.id, id));
      await audit(tx, { userId: actor.id, action: 'contract.update', entityType: 'contract', entityId: id, before, after: values });
      return { id };
    }
    const number = await nextNumber(tx, 'CT');
    const [row] = await tx.insert(t.contracts).values({ ...values, number, createdBy: actor.id }).returning();
    await audit(tx, { userId: actor.id, action: 'contract.create', entityType: 'contract', entityId: row!.id, after: { number, ...values } });
    return { id: row!.id, number };
  });
}

// ---------------- approval rules ----------------
export async function listApprovalRules(db: DbOrTx) {
  const rules = await db.select().from(t.approvalRules).orderBy(asc(t.approvalRules.documentKind), asc(t.approvalRules.minAmount));
  const steps = await db.select().from(t.approvalRuleSteps).orderBy(asc(t.approvalRuleSteps.seq));
  return rules.map((r) => ({ ...r, steps: steps.filter((s) => s.ruleId === r.id) }));
}

export async function updateApprovalRule(db: Db, actor: Actor, ruleId: string, input: {
  name: string; minAmount: number; maxAmount: number | null; isPettyCash: boolean; active: boolean;
  steps: { approverType: 'hod' | 'role'; roleKey?: string; actionLabel: string }[];
}) {
  requirePermission(actor, 'settings.manage');
  return db.transaction(async (tx) => {
    const before = await tx.query.approvalRules.findFirst({ where: eq(t.approvalRules.id, ruleId) });
    if (!before) throw notFound('Approval rule');
    if (input.isPettyCash && before.documentKind !== 'request') throw badRequest('Only request rules can be petty cash.');
    if (input.isPettyCash && (input.steps.length !== 1 || input.steps[0]!.approverType !== 'hod')) {
      throw badRequest('Petty cash needs exactly one step: the requester\'s HOD.');
    }
    for (const s of input.steps) {
      if (s.approverType === 'role') {
        const role = await tx.query.roles.findFirst({ where: eq(t.roles.key, s.roleKey!) });
        if (!role) throw badRequest(`Unknown role ${s.roleKey}.`);
      }
      if (s.approverType === 'hod' && before.documentKind === 'po') throw badRequest('POs have no HOD — pick a role.');
    }
    const beforeSteps = await tx.select().from(t.approvalRuleSteps).where(eq(t.approvalRuleSteps.ruleId, ruleId));
    await tx.update(t.approvalRules).set({
      name: input.name, minAmount: input.minAmount, maxAmount: input.maxAmount, isPettyCash: input.isPettyCash, active: input.active, updatedAt: new Date()
    }).where(eq(t.approvalRules.id, ruleId));
    await tx.delete(t.approvalRuleSteps).where(eq(t.approvalRuleSteps.ruleId, ruleId));
    if (input.steps.length) {
      await tx.insert(t.approvalRuleSteps).values(input.steps.map((s, i) => ({
        ruleId, seq: i + 1, approverType: s.approverType, roleKey: s.approverType === 'role' ? s.roleKey! : null, actionLabel: s.actionLabel
      })));
    }
    // Overlapping active ranges would make routing ambiguous.
    const overlaps = await tx.execute<{ name: string }>(sql`
      select b.name from approval_rules a join approval_rules b
        on a.id <> b.id and a.document_kind = b.document_kind and a.active and b.active and a.conditions = b.conditions
        and a.min_amount < coalesce(b.max_amount, 'Infinity'::numeric) and b.min_amount < coalesce(a.max_amount, 'Infinity'::numeric)
      where a.id = ${ruleId}`);
    if (overlaps[0]) throw badRequest(`This range overlaps "${overlaps[0].name}". Adjust one of them.`);
    await audit(tx, { userId: actor.id, action: 'approval_rule.update', entityType: 'approval_rule', entityId: ruleId,
      before: { ...before, steps: beforeSteps }, after: input });
  });
}
