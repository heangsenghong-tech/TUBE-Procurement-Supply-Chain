// Reference data every installation starts with. Safe to run repeatedly: each part only
// fills what's missing and never overwrites what an administrator has changed.
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { DEFAULT_ROLES } from '@tube/shared';
import type { Db } from '../client';
import * as t from '../schema';
import { parseCsv } from '../../modules/master/import';

// Canonical units of measure. The prototype's data spells several of these differently
// (BOX/Box, BTL/Btl, KG/Kg, PCS/Pcs …); they are normalised on import.
export const UOMS: Record<string, string> = {
  Box: 'Box', Btl: 'Bottle', Can: 'Can', Ctn: 'Carton', Kg: 'Kilogram', Kit: 'Kit', L: 'Litre',
  License: 'License', Loaf: 'Loaf', Pack: 'Pack', Pair: 'Pair', Pcs: 'Pieces', Roll: 'Roll',
  Set: 'Set', Tin: 'Tin', Unit: 'Unit'
};

export function normaliseUom(raw: string): string {
  const key = Object.keys(UOMS).find((k) => k.toLowerCase() === String(raw).trim().toLowerCase());
  if (!key) throw new Error(`Unknown unit of measure "${raw}"`);
  return key;
}

// The company's approval structure (confirmed by Supply Chain & Procurement, Sep 2026). One pattern
// for both tracks, Track A — HQ and Track B — Stores; "HOD" is whoever heads the requesting unit:
//   < $100      requester → unit HOD acknowledges → petty cash, straight to Finance (no sourcing)
//   $100–$299   requester → HOD reviews → Head of Finance approves
//   $300+       requester → HOD reviews → Head of Finance reviews → CEO approves
// For stores, the HOD at $100+ is the Head of Operation; below $100 it's the store's own Store or
// Area Manager (org_units.hod_user_id). HQ departments use their own head at every tier.
// Editable afterwards in Approval Rules.
const hod = (actionLabel: string) => ({ approverType: 'hod' as const, actionLabel });
const role = (roleKey: string, actionLabel: string) => ({ approverType: 'role' as const, roleKey, actionLabel });
const APPROVAL_MATRIX = [
  { documentKind: 'request' as const, name: 'Below $100 — Petty Cash (HOD acknowledges)', min: 0, max: 100, pettyCash: true, conditions: {},
    steps: [hod('Acknowledged')] },
  { documentKind: 'request' as const, name: 'Track A — HQ: $100 – $299', min: 100, max: 300, pettyCash: false, conditions: { track: 'hq' },
    steps: [hod('Reviewed'), role('finance_head', 'Approved')] },
  { documentKind: 'request' as const, name: 'Track A — HQ: $300 and above', min: 300, max: null, pettyCash: false, conditions: { track: 'hq' },
    steps: [hod('Reviewed'), role('finance_head', 'Reviewed'), role('ceo', 'Approved')] },
  { documentKind: 'request' as const, name: 'Track B — Stores: $100 – $299', min: 100, max: 300, pettyCash: false, conditions: { track: 'store' },
    steps: [role('head_of_operation', 'Reviewed'), role('finance_head', 'Approved')] },
  { documentKind: 'request' as const, name: 'Track B — Stores: $300 and above', min: 300, max: null, pettyCash: false, conditions: { track: 'store' },
    steps: [role('head_of_operation', 'Reviewed'), role('finance_head', 'Reviewed'), role('ceo', 'Approved')] },
  { documentKind: 'po' as const, name: 'Below $100 — no approval needed', min: 0, max: 100, pettyCash: false, conditions: {}, steps: [] },
  { documentKind: 'po' as const, name: '$100 – $299', min: 100, max: 300, pettyCash: false, conditions: {},
    steps: [role('supply_chain_manager', 'Reviewed'), role('finance_head', 'Approved')] },
  { documentKind: 'po' as const, name: '$300 and above', min: 300, max: null, pettyCash: false, conditions: {},
    steps: [role('finance_head', 'Reviewed'), role('ceo', 'Approved')] }
];

// The request types offered in "+ New Request" (master spec §7). Supply chain and project types
// arrive with their modules; administrators can add more at any time.
const REQUEST_TYPES = [
  { key: 'purchase_request', name: 'Purchase Request', group: 'procurement', handling: 'purchase', sortOrder: 10,
    description: 'Buy items from the catalog. Under $100 becomes a petty cash record your HOD acknowledges.' },
  { key: 'new_item_sample', name: 'New Item / Sample Request', group: 'procurement', handling: 'sample', sortOrder: 20,
    description: 'Not sure yet? Get a sample sourced and tried before buying.' },
  { key: 'it_procurement', name: 'IT Procurement', group: 'procurement', handling: 'purchase', sortOrder: 30,
    description: 'Computers, POS hardware, network and software licences from the catalog.' },
  { key: 'equipment', name: 'Equipment', group: 'procurement', handling: 'purchase', sortOrder: 40,
    description: 'Coffee machines, grinders, fridges and other equipment.' },
  { key: 'furniture', name: 'Furniture', group: 'procurement', handling: 'purchase', sortOrder: 50, description: 'Tables, chairs, shelving.' },
  { key: 'uniform', name: 'Uniform', group: 'procurement', handling: 'purchase', sortOrder: 60, description: 'Aprons, shirts, pants, name badges.' },
  { key: 'office_supplies', name: 'Office Supplies', group: 'procurement', handling: 'purchase', sortOrder: 70, description: 'Stationery and office consumables.' },
  { key: 'supplier_request', name: 'Supplier Request', group: 'procurement', handling: 'service', sortOrder: 110,
    description: 'Ask Procurement to find or onboard a supplier.' },
  { key: 'price_inquiry', name: 'Price Inquiry', group: 'procurement', handling: 'service', sortOrder: 120,
    description: 'Ask what something would cost before requesting it.' },
  { key: 'contract_request', name: 'Contract Request', group: 'procurement', handling: 'service', sortOrder: 130,
    description: 'Start, renew or change a supplier contract.' },
  { key: 'maintenance', name: 'Maintenance', group: 'other', handling: 'service', sortOrder: 140,
    description: 'Arrange a repair or service visit (air-con, machines, facilities).' }
] as const;

// Used only when data/seed/departments.csv is missing.
const DEPARTMENTS = [
  ['SCP', 'Supply Chain'], ['OPS', 'Operation'], ['MKT', 'Marketing'],
  ['IT', 'IT'], ['HR', 'Human Resource'], ['FIN', 'Finance'], ['MGT', 'CEO Office']
] as const;

// Code, Name, Type, Ownership columns of a Users & Stores import file (other columns ignored).
function readUnits(file: string) {
  if (!fs.existsSync(file)) return null;
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  const col = (name: string) => header!.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const [code, name, type, ownership] = ['Code', 'Name', 'Type', 'Ownership'].map(col) as [number, number, number, number];
  return rows.map((r) => ({
    code: r[code]!.trim(), name: r[name]!.trim(),
    type: r[type]!.trim().toLowerCase() === 'store' ? 'store' as const : 'department' as const,
    ownership: r[type]!.trim().toLowerCase() === 'store' ? (r[ownership]?.trim().toLowerCase() === 'franchiser' ? 'franchiser' as const : 'franchisee' as const) : null
  }));
}

interface SeedOptions {
  seedDir: string;
  adminEmail?: string;
  adminName?: string;
}

export async function seedReference(db: Db, opts: SeedOptions) {
  const log: string[] = [];

  // Roles & their default permissions (only roles that don't exist yet).
  for (const r of DEFAULT_ROLES) {
    const [row] = await db.insert(t.roles).values({ key: r.key, name: r.name, description: r.description, approver: !!r.approver })
      .onConflictDoNothing().returning();
    if (row) {
      await db.insert(t.rolePermissions).values(r.permissions.map((p) => ({ roleId: row.id, permission: p })));
      log.push(`role ${r.key}`);
    }
  }

  await db.insert(t.uoms).values(Object.entries(UOMS).map(([code, name]) => ({ code, name }))).onConflictDoNothing();

  const addedTypes = await db.insert(t.requestTypes).values(REQUEST_TYPES.map((r) => ({ ...r }))).onConflictDoNothing().returning();
  if (addedTypes.length) log.push(`${addedTypes.length} request types`);

  const [{ n: ruleCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.approvalRules) as [{ n: number }];
  if (ruleCount === 0) {
    let priority = 100;
    for (const r of APPROVAL_MATRIX) {
      const [rule] = await db.insert(t.approvalRules).values({
        documentKind: r.documentKind, name: r.name, minAmount: r.min, maxAmount: r.max, isPettyCash: r.pettyCash, conditions: r.conditions, priority: priority++
      }).returning();
      if (r.steps.length) {
        await db.insert(t.approvalRuleSteps).values(r.steps.map((s, i) => ({
          ruleId: rule!.id, seq: i + 1, approverType: s.approverType, roleKey: 'roleKey' in s ? (s.roleKey as string) : null, actionLabel: s.actionLabel
        })));
      }
    }
    log.push('approval matrix');
  }

  // Service requests follow the purchase value tiers above; below $100 they aren't petty cash,
  // so the HOD acknowledges and Procurement handles them. Added to existing installations too,
  // unless an administrator already has a service rule.
  const serviceRule = await db.select({ id: t.approvalRules.id }).from(t.approvalRules)
    .where(sql`${t.approvalRules.documentKind} = 'request' and ${t.approvalRules.conditions} ->> 'handling' = 'service'`).limit(1);
  if (!serviceRule[0]) {
    const [rule] = await db.insert(t.approvalRules).values({
      documentKind: 'request', name: 'Service requests below $100 — HOD acknowledges', minAmount: 0, maxAmount: 100,
      conditions: { handling: 'service' }, priority: 90
    }).returning();
    await db.insert(t.approvalRuleSteps).values({ ruleId: rule!.id, seq: 1, approverType: 'hod', actionLabel: 'Acknowledged' });
    log.push('service request rule');
  }

  const [{ n: unitCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.orgUnits) as [{ n: number }];
  if (unitCount === 0) {
    // The company's HQ departments and stores. KDT runs the Track B store process but is
    // company-owned (Tube Cafe Co., Ltd. pays directly); the other stores are franchisees.
    // HODs are set afterwards by importing the same files once the people exist.
    const departments = readUnits(path.join(opts.seedDir, 'departments.csv'))
      ?? DEPARTMENTS.map(([code, name]) => ({ code, name, type: 'department' as const, ownership: null }));
    const stores = readUnits(path.join(opts.seedDir, 'stores.csv'))
      ?? [{ code: 'KDT', name: 'KDT', type: 'store' as const, ownership: 'franchiser' as const }];
    await db.insert(t.orgUnits).values([...departments, ...stores]);
    log.push(`${departments.length} departments, ${stores.length} stores`);
  }

  // Real Item & Supplier Master, exported from the live prototype.
  const [{ n: itemCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.items) as [{ n: number }];
  const itemsFile = path.join(opts.seedDir, 'items.json');
  const suppliersFile = path.join(opts.seedDir, 'suppliers.json');
  if (itemCount === 0 && fs.existsSync(itemsFile) && fs.existsSync(suppliersFile)) {
    const rawSuppliers = JSON.parse(fs.readFileSync(suppliersFile, 'utf8')) as Record<string, { name: string; category: string; contact?: string; paymentTerm?: string }>;
    const rawItems = JSON.parse(fs.readFileSync(itemsFile, 'utf8')) as Record<string, {
      description: string; category: string; procurementType: string; uom: string; unitPrice: number; supplierCode?: string
    }>;
    await db.transaction(async (tx) => {
      const supplierIds: Record<string, string> = {};
      for (const [code, s] of Object.entries(rawSuppliers)) {
        const contact = (s.contact ?? '').trim();
        const looksLikePhone = /^[+\d][\d\s\-()/]{5,}$/.test(contact);
        const [row] = await tx.insert(t.suppliers).values({
          code, name: s.name.trim(),
          category: (['Food', 'Non-food', 'Both'].includes(s.category) ? s.category : 'Both') as 'Food' | 'Non-food' | 'Both',
          phone: looksLikePhone ? contact : null,
          contactName: looksLikePhone || !contact ? null : contact,
          paymentTerms: s.paymentTerm?.trim() || null
        }).returning();
        supplierIds[code] = row!.id;
      }
      for (const [code, it] of Object.entries(rawItems)) {
        const [row] = await tx.insert(t.items).values({
          code, description: it.description.trim(),
          category: it.category === 'Food' ? 'Food' : 'Non-food',
          procurementType: it.procurementType === 'Direct' ? 'Direct' : 'Indirect',
          uom: normaliseUom(it.uom),
          standardCost: Number(it.unitPrice) || 0,
          isReference: code.startsWith('GEN-')
        }).returning();
        const supplierId = it.supplierCode ? supplierIds[it.supplierCode] : undefined;
        if (supplierId) {
          await tx.insert(t.itemSupplierPrices).values({ itemId: row!.id, supplierId, unitPrice: Number(it.unitPrice) || 0, rank: 1 });
        }
      }
    });
    log.push(`${Object.keys(rawSuppliers).length} suppliers, ${Object.keys(rawItems).length} items`);
  }

  // First administrator (Google sign-in matches on this email).
  if (opts.adminEmail) {
    const email = opts.adminEmail.trim().toLowerCase();
    const existing = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) });
    if (!existing) {
      const scp = await db.query.orgUnits.findFirst({ where: (u, { eq }) => eq(u.code, 'SCP') });
      const [user] = await db.insert(t.users).values({ email, name: opts.adminName?.trim() || email, orgUnitId: scp?.id ?? null }).returning();
      const adminRoles = await db.query.roles.findMany({ where: (r, { inArray }) => inArray(r.key, ['super_admin', 'export_authorized']) });
      await db.insert(t.userRoles).values(adminRoles.map((r) => ({ userId: user!.id, roleId: r.id })));
      log.push(`administrator ${email}`);
    }
  }

  return log;
}
