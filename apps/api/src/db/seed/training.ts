// Demo data for the Training environment only (APP_ENV=training): stores, one person per role,
// and transactions in every state. Created through the real services, so it follows the same
// rules as real data. Production never runs this.
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client';
import * as t from '../schema';
import { loadActor } from '../../core/actor';
import * as req from '../../modules/requests/service';
import * as proc from '../../modules/procurement/service';
import * as master from '../../modules/master/service';

const DOMAIN = 'training.tubecafe.demo';

const STORES = [
  ['TK', 'Toul Kork'], ['BKK', 'BKK1'], ['CDP', 'CDP'], ['AEON1', 'AEON Mall 1'], ['AEON2', 'AEON Mall 2'],
  ['RSY', 'Russey Keo'], ['SEN', 'Sen Sok'], ['CHM', 'Chamkar Mon'], ['DK', 'Daun Penh']
] as const;

const PEOPLE = [
  { key: 'admin', name: 'Demo Admin', unit: 'SCP', roles: ['super_admin', 'export_authorized'] },
  { key: 'ceo', name: 'Demo CEO', unit: 'MGT', roles: ['ceo'] },
  { key: 'scm', name: 'Demo Supply Chain Manager', unit: 'SCP', roles: ['supply_chain_manager', 'export_authorized'] },
  { key: 'buyer', name: 'Demo Purchasing Officer', unit: 'SCP', roles: ['procurement_officer'] },
  { key: 'finhead', name: 'Demo Head of Finance', unit: 'FIN', roles: ['finance_head'] },
  { key: 'acct.manager', name: 'Demo Accounting Manager (Head of Finance)', unit: 'FIN', roles: ['finance_head'] },
  { key: 'finance', name: 'Demo Finance Officer', unit: 'FIN', roles: ['finance'] },
  { key: 'warehouse', name: 'Demo Warehouse Officer', unit: 'SCP', roles: ['warehouse'] },
  { key: 'kdt.manager', name: 'Demo KDT Store Manager (HOD)', unit: 'KDT', roles: ['requester'], hodOf: 'KDT' },
  { key: 'kdt.staff', name: 'Demo KDT Barista', unit: 'KDT', roles: ['requester'] },
  { key: 'tk.manager', name: 'Demo Toul Kork Manager (HOD)', unit: 'TK', roles: ['requester'], hodOf: 'TK' },
  { key: 'tk.staff', name: 'Demo Toul Kork Barista', unit: 'TK', roles: ['requester'] },
  { key: 'ops.head', name: 'Demo Head of Operation (HOD)', unit: 'OPS', roles: ['requester', 'head_of_operation'], hodOf: 'OPS' },
  { key: 'mkt.staff', name: 'Demo Marketing Executive', unit: 'MKT', roles: ['requester'] },
  { key: 'mkt.head', name: 'Demo Head of Marketing (HOD)', unit: 'MKT', roles: ['requester'], hodOf: 'MKT' }
];

export async function seedTraining(db: Db) {
  const already = await db.query.users.findFirst({ where: eq(t.users.email, `ceo@${DOMAIN}`) });
  if (already) return [];

  // The seeding "system" acts as a temporary super admin.
  const [system] = await db.insert(t.users).values({ email: `system@${DOMAIN}`, name: 'Training Setup', active: true }).returning();
  const superRole = await db.query.roles.findFirst({ where: eq(t.roles.key, 'super_admin') });
  await db.insert(t.userRoles).values({ userId: system!.id, roleId: superRole!.id });
  const sys = (await loadActor(db, system!.id))!;

  for (const [code, name] of STORES) await master.upsertOrgUnit(db, sys, null, { code, name, type: 'store', ownership: 'franchisee' });
  const units = await master.listOrgUnits(db);
  const unit = (code: string) => units.find((u) => u.code === code)!;

  const ids: Record<string, string> = {};
  for (const p of PEOPLE) {
    const { id } = await master.upsertUser(db, sys, null, { email: `${p.key}@${DOMAIN}`, name: p.name, orgUnitId: unit(p.unit).id, roleKeys: p.roles });
    ids[p.key] = id;
  }
  for (const p of PEOPLE.filter((x) => x.hodOf)) {
    const u = unit(p.hodOf!);
    await master.upsertOrgUnit(db, sys, u.id, { code: u.code, name: u.name, type: u.type, ownership: u.ownership ?? undefined, hodUserId: ids[p.key] });
  }
  const as = async (key: string) => (await loadActor(db, ids[key]!))!;
  // Walks a request through whatever approval chain the engine assigned to it.
  const approveFully = async (requestId: string, hodKey: string) => {
    const viewer = await as('scm');
    for (let step = 0; step < 6 && (await req.getRequest(db, viewer, requestId)).status === 'pending_approval'; step++) {
      for (const key of [hodKey, 'ops.head', 'finhead', 'ceo']) {
        try { await req.actOnRequest(db, await as(key), requestId, { action: 'approve' }); break; } catch { /* not this person's step */ }
      }
    }
  };
  const item = async (code: string) => (await db.query.items.findFirst({ where: eq(t.items.code, code) }))!.id;

  // 1) A $300+ store PR, fully approved → with Procurement.
  const kdtStaff = await as('kdt.staff');
  const pr1 = await req.createPurchaseRequest(db, kdtStaff, { track: 'store', orgUnitId: unit('KDT').id, purpose: 'Monthly store requirement',
    lines: [{ itemId: await item('I00043'), qty: 20 }, { itemId: await item('I00031'), qty: 12 }] });
  await approveFully(pr1.id, 'kdt.manager');

  // 2) Another store needs the same bean — shows consolidation across stores.
  const tkStaff = await as('tk.staff');
  const pr2 = await req.createPurchaseRequest(db, tkStaff, { track: 'store', orgUnitId: unit('TK').id, purpose: 'Weekly top-up',
    lines: [{ itemId: await item('I00043'), qty: 15 }, { itemId: await item('NEW-022'), qty: 1000 }] });
  await approveFully(pr2.id, 'tk.manager');

  // 3) A store request of $100+ waiting for the Head of Operation.
  await req.createPurchaseRequest(db, kdtStaff, { track: 'store', orgUnitId: unit('KDT').id, purpose: 'Cleaning supplies',
    lines: [{ itemId: await item('O000011'), qty: 6 }] });

  // 4) Petty cash: HOD acknowledges, goes to Finance's register, never to Procurement.
  const pc = await req.createPurchaseRequest(db, tkStaff, { track: 'store', orgUnitId: unit('TK').id, purpose: 'Limes for tonight',
    lines: [{ itemId: await item('I00017'), qty: 10 }] });
  await req.actOnRequest(db, await as('tk.manager'), pc.id, { action: 'approve' });

  // 5) HQ request sent back for changes.
  const mkt = await as('mkt.staff');
  const pr5 = await req.createPurchaseRequest(db, mkt, { track: 'hq', orgUnitId: unit('MKT').id, purpose: 'Grand opening display',
    lines: [{ itemId: await item('GEN-038'), qty: 30 }] });
  await req.actOnRequest(db, await as('mkt.head'), pr5.id, { action: 'request_changes', comment: 'Please confirm the quantity with Operation first.' });

  // 6) Sample request under evaluation.
  const sr = await req.createSampleRequest(db, mkt, { track: 'hq', orgUnitId: unit('MKT').id, itemName: 'New takeaway cup design',
    purpose: 'Summer promotion packaging', timeline: 'Needed by next month', quantity: 5000, placeOfUsage: 'All stores',
    size: '12oz', material: 'Paper, PE lining', colorCode: 'Pantone 109C' });
  await req.evaluateSample(db, mkt, sr.id, 'under_evaluation', 'Two supplier samples received; testing with baristas this week.');

  // 7) Procurement: consolidate the bean from both stores into a comparison sheet with a second quote.
  const buyer = await as('buyer');
  const queue = await proc.reviewQueue(db, buyer);
  const bean = queue.find((g) => g.itemCode === 'I00043')!;
  const qcs = await proc.createQcs(db, buyer, { groups: [{ itemId: bean.itemId, qty: bean.totalQty, requestLineIds: bean.contributors.map((c) => c.lineId) }] });
  const sheet = await proc.getQcs(db, buyer, qcs.id);
  const other = await db.query.suppliers.findFirst({ where: eq(t.suppliers.code, 'SUP-0001') });
  await proc.upsertQuotation(db, buyer, sheet.items[0]!.id, { supplierId: other!.id, unitPrice: 10.9, originalPrice: 11.5, leadTimeDays: 3, notes: 'Demo quote' });
  const fresh = await proc.getQcs(db, buyer, qcs.id);
  const cheapest = [...fresh.items[0]!.quotes].sort((a, b) => a.unitPrice - b.unitPrice)[0]!;
  await proc.selectQuotation(db, buyer, fresh.items[0]!.id, { quotationId: cheapest.id, reason: 'Lowest price, 3-day lead time' });
  const [po] = await proc.generatePosFromQcs(db, buyer, qcs.id, {});
  // Approve the PO through whichever chain its value needs (SCM/Finance/CEO).
  for (const key of ['scm', 'finhead', 'ceo']) {
    const p = await proc.getPo(db, await as('finhead'), po!.id);
    if (p.status !== 'pending_approval') break;
    if (p.permissions && (await proc.getPo(db, await as(key), po!.id)).permissions.canAct) {
      await proc.actOnPo(db, await as(key), po!.id, { action: 'approve' });
    }
  }

  // 8) A direct PO for the cups (routine, priced item) — left awaiting approval.
  const cups = (await proc.reviewQueue(db, buyer)).find((g) => g.itemCode === 'NEW-022');
  if (cups?.supplierPrices[0]) {
    await proc.createDirectPo(db, buyer, { supplierId: cups.supplierPrices[0].supplierId, lines: [{
      itemId: cups.itemId, qty: cups.totalQty, unitPrice: cups.supplierPrices[0].unitPrice, requestLineIds: cups.contributors.map((c) => c.lineId)
    }] });
  }

  // 9) Service requests: one waiting for Procurement, one being handled.
  const typeOf = async (key: string) => (await db.query.requestTypes.findFirst({ where: eq(t.requestTypes.key, key) }))!.id;
  const sv1 = await req.createServiceRequest(db, kdtStaff, { track: 'store', orgUnitId: unit('KDT').id, requestTypeId: await typeOf('maintenance'),
    subject: 'Air-con leaking above the bar', description: 'Water drips onto the counter near the espresso machine every afternoon.',
    estimatedCost: 180, isUrgent: true, urgentReason: 'Water near electrical equipment' });
  await approveFully(sv1.id, 'kdt.manager'); // $180: Head of Operation → Head of Finance, like a purchase
  const sv2 = await req.createServiceRequest(db, await as('ops.head'), { track: 'hq', orgUnitId: unit('OPS').id, requestTypeId: await typeOf('supplier_request'),
    subject: 'Second supplier for fresh milk', description: 'We rely on one milk supplier. Please find a backup that can deliver to all stores by 7am.', estimatedCost: 0 });
  // Operation's HOD raised it, so the Supply Chain Manager acknowledges it as a recorded override.
  await req.actOnRequest(db, await as('scm'), sv2.id, { action: 'approve' });
  await req.assignServiceRequest(db, buyer, sv2.id);

  // 10) An urgent purchase waiting for approval.
  await req.createPurchaseRequest(db, tkStaff, { track: 'store', orgUnitId: unit('TK').id, purpose: 'Grinder burrs worn out',
    requestTypeId: await typeOf('equipment'), isUrgent: true, urgentReason: 'Grinder failing — can\'t serve espresso',
    lines: [{ itemId: await item('GEN-001'), qty: 1 }] });

  // 11) A contract in the register.
  await master.upsertContract(db, await as('scm'), null, { name: 'Coffee bean supply agreement', supplierId: other!.id, stage: 'signed',
    startDate: '2026-01-01', expiryDate: '2026-12-31', keyTerms: '1 month payment term; price fixed for 6 months', documentPointer: 'Google Drive > Contracts > Demo' });

  // The setup account is only for seeding.
  await db.update(t.users).set({ active: false }).where(eq(t.users.id, system!.id));
  await db.delete(t.userRoles).where(inArray(t.userRoles.userId, [system!.id]));
  return ['training demo data'];
}
