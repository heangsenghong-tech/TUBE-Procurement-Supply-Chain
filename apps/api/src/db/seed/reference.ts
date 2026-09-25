// Reference data every installation starts with. Safe to run repeatedly: each part only
// fills what's missing and never overwrites what an administrator has changed.
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { DEFAULT_ROLES } from '@tube/shared';
import type { Db } from '../client';
import * as t from '../schema';

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

// The company's real approval matrix (Policy & Procedure). Editable afterwards in Settings.
const APPROVAL_MATRIX = [
  { documentKind: 'request' as const, name: 'Below $100 — Petty Cash (HOD acknowledges)', min: 0, max: 100, pettyCash: true,
    steps: [{ approverType: 'hod' as const, actionLabel: 'Acknowledged' }] },
  { documentKind: 'request' as const, name: '$100 – $299', min: 100, max: 300, pettyCash: false,
    steps: [{ approverType: 'hod' as const, actionLabel: 'Reviewed/Acknowledged' },
      { approverType: 'role' as const, roleKey: 'finance_head', actionLabel: 'Approved' }] },
  { documentKind: 'request' as const, name: '$300 and above', min: 300, max: null, pettyCash: false,
    steps: [{ approverType: 'hod' as const, actionLabel: 'Reviewed/Acknowledged' },
      { approverType: 'role' as const, roleKey: 'finance_head', actionLabel: 'Reviewed' },
      { approverType: 'role' as const, roleKey: 'ceo', actionLabel: 'Approved' }] },
  { documentKind: 'po' as const, name: 'Below $100 — no approval needed', min: 0, max: 100, pettyCash: false, steps: [] },
  { documentKind: 'po' as const, name: '$100 – $299', min: 100, max: 300, pettyCash: false,
    steps: [{ approverType: 'role' as const, roleKey: 'supply_chain_manager', actionLabel: 'Reviewed' },
      { approverType: 'role' as const, roleKey: 'finance_head', actionLabel: 'Approved' }] },
  { documentKind: 'po' as const, name: '$300 and above', min: 300, max: null, pettyCash: false,
    steps: [{ approverType: 'role' as const, roleKey: 'finance_head', actionLabel: 'Reviewed' },
      { approverType: 'role' as const, roleKey: 'ceo', actionLabel: 'Approved' }] }
];

const DEPARTMENTS = [
  ['SCP', 'Supply Chain & Procurement'], ['OPS', 'Operation'], ['MKT', 'Marketing'],
  ['IT', 'IT'], ['HR', 'HR'], ['FIN', 'Finance'], ['MGT', 'Management']
] as const;

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

  const [{ n: ruleCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.approvalRules) as [{ n: number }];
  if (ruleCount === 0) {
    let priority = 100;
    for (const r of APPROVAL_MATRIX) {
      const [rule] = await db.insert(t.approvalRules).values({
        documentKind: r.documentKind, name: r.name, minAmount: r.min, maxAmount: r.max, isPettyCash: r.pettyCash, priority: priority++
      }).returning();
      if (r.steps.length) {
        await db.insert(t.approvalRuleSteps).values(r.steps.map((s, i) => ({
          ruleId: rule!.id, seq: i + 1, approverType: s.approverType, roleKey: 'roleKey' in s ? s.roleKey : null, actionLabel: s.actionLabel
        })));
      }
    }
    log.push('approval matrix');
  }

  const [{ n: unitCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.orgUnits) as [{ n: number }];
  if (unitCount === 0) {
    await db.insert(t.orgUnits).values([
      ...DEPARTMENTS.map(([code, name]) => ({ code, name, type: 'department' as const })),
      { code: 'KDT', name: 'KDT', type: 'store' as const, ownership: 'franchiser' as const }
    ]);
    log.push('departments + KDT store');
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
